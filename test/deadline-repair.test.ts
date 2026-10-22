import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PmClient, createRelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildPrerequisiteGraph, computeSchedule, computeSlack, proposeDeadlineRepairs,
  type PmItem, type DeadlineRepairOptions, type DeadlineRepairResult } from "../index.ts";

const scenario: DeadlineRepairOptions = { from: "2026-10-21", deadline: "2026-10-22" };

/** Construct an estimated active task with explicit ordering prerequisites. */
function task(id: string, days = 2, deps: string[] = []): PmItem {
  return { id, title: id, status: "open", estimated_minutes: days * 480, dependencies: deps.map((id) => ({ id, kind: "blocked_by" })) };
}

/**
 * True when an inclusive local finish is on or before the horizon day.
 *
 * Compare Date values with the next local midnight. UTC ISO day text is not
 * chronological here: a positive offset formats that midnight as the horizon
 * day, and year 10000 also sorts before 9999 as text.
 */
function finishesByHorizon(end: Date, deadline: string): boolean {
  const horizonEnd = new Date(`${deadline}T00:00:00`);
  horizonEnd.setDate(horizonEnd.getDate() + 1);
  return end < horizonEnd;
}

/** Narrow successful results and independently check every retained schedule. */
function verify(items: PmItem[], options: DeadlineRepairOptions) {
  const before = JSON.stringify(items);
  const result = proposeDeadlineRepairs(items, options);
  assert.equal(JSON.stringify(items), before);
  assert.ok(result.ok, JSON.stringify(result));
  for (const proposal of result.proposals) {
    const deferred = proposal.moves.filter((move) => move.kind === "scope_deferral").map((move) => move.itemId);
    const retained = items.filter((item) => !deferred.includes(item.id) && item.status !== "closed" && item.status !== "canceled").map((item) => {
      const move = proposal.moves.find((move) => move.itemId === item.id);
      return move?.kind === "capacity_shift" ? { ...item, estimated_minutes: move.afterDays * 480 } : item;
    });
    const graph = buildPrerequisiteGraph(retained);
    assert.ok(retained.every((item) => graph.get(item.id)!.every((id) => !deferred.includes(id))));
    const computed = computeSchedule(retained.map((item) => ({ ...item, deadline: undefined, due_date: undefined })), new Date(`${options.from}T00:00:00`), options.defaultDuration ?? 5, graph);
    assert.ok([...computed.values()].every((entry) => finishesByHorizon(entry.end, options.deadline)));
    assert.ok([...computeSlack(retained, computed, graph).values()].every((entry) => !entry.infeasible));
    assert.ok(proposal.moves.every((move) => !options.forbiddenIds?.includes(move.itemId)));
    assert.ok(proposal.moves.every((move) => proposal.affectedIds.includes(move.itemId)));
  }
  return result;
}

/** Assert a typed refusal includes an actionable remedy. */
function refusal(result: DeadlineRepairResult, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected refusal");
  assert.equal(result.code, code);
  assert.ok(result.remedy.length > 15);
}

test("minimal repairs: capacity on a prerequisite fixes the chain with exact downstream impact", () => {
  const items = [task("a"), task("b", 1, ["a"]), task("unaffected", 1)];
  const result = verify(items, { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] });
  assert.equal(result.minimalChanges, 1);
  assert.deepEqual(result.baseline.infeasibleIds, ["b"]);
  assert.deepEqual(result.proposals[0], { moves: [{ kind: "capacity_shift", itemId: "a", beforeDays: 2, afterDays: 1, minutesPerDay: 960, addedMinutesPerDay: 480 }], affectedIds: ["a", "b"], finish: "2026-10-22", retainedCount: 3, deferredMinutes: 0, addedMinutesPerDay: 480 });
});

test("minimal repairs: two moves, deduplication, one move per item, deterministic ranking and truncation", () => {
  const items = [task("a", 3), task("b", 3)];
  const options = { ...scenario, maxProposals: 1, capacityShifts: [{ itemId: "a", minutesPerDay: 720 }, { itemId: "a", minutesPerDay: 960 }, { itemId: "a", minutesPerDay: 720 }, { itemId: "b", minutesPerDay: 720 }] };
  const result = verify(items, options);
  assert.equal(result.minimalChanges, 2);
  assert.equal(result.totalProposals, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.proposals[0].addedMinutesPerDay, 480);
  assert.deepEqual(proposeDeadlineRepairs([...items].reverse(), options), result);
  refusal(proposeDeadlineRepairs(items, { ...options, maxChanges: 1 }), "no_allowed_repair");
});

test("minimal repairs: deferrals preserve prerequisites and require a nonempty retained scenario", () => {
  const items = [task("a", 3), task("b", 1, ["a"]), task("keep", 1)];
  const result = verify(items, { ...scenario, deferrableIds: ["a", "a", "b"] });
  assert.equal(result.minimalChanges, 2);
  assert.deepEqual(result.proposals[0].moves.map((move) => move.itemId), ["a", "b"]);
  assert.equal(result.proposals[0].deferredMinutes, 1920);
  refusal(proposeDeadlineRepairs(items, { ...scenario, deferrableIds: ["a"] }), "no_allowed_repair");
  refusal(proposeDeadlineRepairs([task("a", 3)], { ...scenario, deferrableIds: ["a"] }), "no_allowed_repair");
});

test("minimal repairs: forbidden moves override both capacity and scope offers", () => {
  const items = [task("a", 3), task("keep", 1)];
  refusal(proposeDeadlineRepairs(items, { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }], deferrableIds: ["a"], forbiddenIds: ["a"] }), "no_allowed_repair");
  const result = verify(items, { ...scenario, deferrableIds: ["a"], forbiddenIds: ["keep"] });
  assert.equal(result.proposals[0].moves[0].kind, "scope_deferral");
});

test("minimal repairs: own deadline violations, full ISO deadlines, missing estimates and fixed horizons", () => {
  const overdue = { ...task("late", 1), deadline: "2026-10-20T12:00:00.000Z" };
  const items = [overdue, { ...task("keep", 0), estimated_minutes: undefined }];
  const result = verify(items, { ...scenario, defaultDuration: 1, deferrableIds: ["late"] });
  assert.deepEqual(result.baseline.infeasibleIds, ["late"]);
  const fallback = [{ ...task("a"), estimated_minutes: undefined }, task("keep", 1)];
  assert.equal(verify(fallback, { ...scenario, deferrableIds: ["a"] }).proposals[0].deferredMinutes, 2400);
  assert.equal(verify([{ ...task("a"), estimated_minutes: 0 }, task("keep", 1)], { ...scenario, deferrableIds: ["a"] }).proposals[0].deferredMinutes, 2400);
  const dateOnly = [{ ...task("a", 3), due_date: "2026-10-22" }];
  assert.equal(verify(dateOnly, { ...scenario, deadline: "2026-10-30", capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] }).minimalChanges, 1);
});

test("minimal repairs: a feasible or empty baseline needs no changes; completed work is satisfied", () => {
  assert.equal(verify([], scenario).baseline.finish, null);
  assert.equal(verify([task("a", 1)], scenario).minimalChanges, 0);
  const items = [{ ...task("done", 50), status: "closed" as const }, { ...task("canceled", 50), status: "canceled" as const }, task("a", 1, ["done", "canceled"])];
  assert.equal(verify(items, scenario).proposals.length, 0);
});

test("minimal repairs: inclusive horizon respects timestamp days and year overflow", () => {
  const timestamp = { ...task("a", 1), deadline: "2026-10-22T23:00:00" };
  assert.equal(verify([timestamp], scenario).minimalChanges, 0);
  const items = [task("a", 3)];
  const options = { from: "9999-12-30", deadline: "9999-12-31", capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] };
  const result = verify(items, options);
  assert.equal(result.baseline.finish, "10000-01-01");
  assert.equal(result.minimalChanges, 1);
  assert.equal(result.proposals[0].finish, "9999-12-31");
});

test("horizon comparison rejects the next local midnight when UTC day text still matches", () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ["UTC", "Europe/Vienna"]) {
      process.env.TZ = timezone;
      for (const deadline of ["2026-10-22", "9999-12-31"]) {
        const onDeadline = new Date(`${deadline}T00:00:00`);
        const nextLocalMidnight = new Date(onDeadline);
        nextLocalMidnight.setDate(nextLocalMidnight.getDate() + 1);
        assert.equal(finishesByHorizon(onDeadline, deadline), true, `${timezone}: ${deadline}`);
        assert.equal(finishesByHorizon(nextLocalMidnight, deadline), false, `${timezone}: ${deadline}`);
        if (timezone === "Europe/Vienna" || deadline === "9999-12-31") {
          assert.equal(nextLocalMidnight.toISOString().slice(0, 10) <= deadline, true);
        }
      }
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("minimal repairs: post-horizon canonical, legacy and timestamp deadlines need no changes", () => {
  for (const due of [{ deadline: "2026-12-01" }, { due_date: "2026-12-01" }, { deadline: "2026-12-01T23:00:00" }]) {
    const result = verify([{ ...task("a", 1), ...due }], scenario);
    assert.equal(result.minimalChanges, 0);
    assert.deepEqual(result.baseline, { finish: "2026-10-21", infeasibleIds: [] });
  }
});

test("minimal repairs: deadline placement cannot delay feasible prerequisites or dependents", () => {
  for (const deadline of ["2026-12-01", scenario.deadline]) {
    for (const id of ["a", "b"]) {
      const items = [task("a", 1), task("b", 1, ["a"])].map((item) => item.id === id ? { ...item, deadline } : item);
      const result = verify(items, scenario);
      assert.equal(result.minimalChanges, 0);
      assert.deepEqual(result.baseline, { finish: scenario.deadline, infeasibleIds: [] });
    }
  }
  const earlier = [{ ...task("a", 1), deadline: "2026-10-21" }, { ...task("b", 1, ["a"]), deadline: "2026-12-01" }];
  assert.equal(verify(earlier, scenario).minimalChanges, 0);
  refusal(proposeDeadlineRepairs(earlier.map((item) => item.id === "b" ? { ...item, deadline: "2026-10-21" } : item), scenario), "no_allowed_repair");
});

test("minimal repairs: late deadlines still allow capacity repairs and preserve earlier limits", () => {
  const items = [{ ...task("a", 2), deadline: "2026-12-01" }, { ...task("b", 1, ["a"]), due_date: "2026-12-01" }];
  const options = { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] };
  const result = verify(items, options);
  assert.equal(result.minimalChanges, 1);
  assert.deepEqual(result.baseline.infeasibleIds, ["b"]);
  assert.deepEqual(result.proposals[0].affectedIds, ["a", "b"]);
  assert.equal(result.proposals[0].finish, scenario.deadline);
  refusal(proposeDeadlineRepairs(items.map((item) => item.id === "a" ? { ...item, deadline: "2026-10-20" } : item), options), "no_allowed_repair");
});

test("minimal repairs: no-op offers and exhausted budgets never certify partial search", () => {
  refusal(proposeDeadlineRepairs([task("a", 3), task("b", 3)], { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 481 }] }), "no_allowed_repair");
  refusal(proposeDeadlineRepairs([task("a", 1), task("b", 3)], { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] }), "no_allowed_repair");
  refusal(proposeDeadlineRepairs([task("a", 3), task("b", 3)], { ...scenario, maxEvaluations: 1, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }, { itemId: "b", minutesPerDay: 960 }] }), "search_budget_exceeded");
  const options = { ...scenario, maxEvaluations: 1, capacityShifts: [{ itemId: "a", minutesPerDay: 720 }, { itemId: "a", minutesPerDay: 960 }] };
  refusal(proposeDeadlineRepairs([task("a", 3)], options), "search_budget_exceeded");
  assert.equal(verify([task("a", 3)], { ...scenario, maxEvaluations: 1, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] }).examined, 1);
  refusal(proposeDeadlineRepairs([task("a", 3), task("b", 3), task("c", 3)], { ...scenario, maxEvaluations: 1, deferrableIds: ["a", "b", "c"] }), "search_budget_exceeded");
});

test("minimal repairs: capacity/scope alternatives use stable tie ordering and explicit tradeoffs", () => {
  const items = [task("a", 2), task("b", 2, ["a"]), task("keep", 1)];
  const result = verify(items, { ...scenario, deadline: "2026-10-23", capacityShifts: [{ itemId: "a", minutesPerDay: 960 }, { itemId: "b", minutesPerDay: 960 }], deferrableIds: ["b"] });
  assert.equal(result.totalProposals, 3);
  assert.deepEqual(result.proposals.map((proposal) => proposal.moves[0].itemId), ["a", "b", "b"]);
  assert.equal(result.proposals[2].deferredMinutes, 960);
});

for (const invalid of [
  { from: "bad" }, { from: "2026-02-30" }, { deadline: "bad" }, { from: "2026-10-23" },
  { maxChanges: 0 }, { maxChanges: 4 }, { maxProposals: 11 }, { maxEvaluations: Infinity }, { defaultDuration: 1.5 },
  { capacityShifts: [{ itemId: "missing", minutesPerDay: 960 }] }, { deferrableIds: ["missing"] }, { forbiddenIds: ["missing"] },
  { capacityShifts: [{ itemId: "a", minutesPerDay: 480 }] }, { capacityShifts: [{ itemId: "a", minutesPerDay: 4801 }] }, { capacityShifts: [{ itemId: "a", minutesPerDay: 960.5 }] },
] satisfies Partial<DeadlineRepairOptions>[]) {
  test(`minimal repairs: invalid scenario ${JSON.stringify(invalid)}`, () => refusal(proposeDeadlineRepairs([task("a")], { ...scenario, ...invalid }), "invalid_scenario"));
}

test("minimal repairs: incomplete, cyclic and malformed source data is refused", () => {
  for (const items of [
    [task("a"), task("a")], [task("")], [task("a".repeat(129))], [task("a", 1, ["missing"])],
    [{ ...task("a"), deadline: "bad" }], [{ ...task("a"), deadline: "2026-02-30" }], [{ ...task("a"), deadline: "2026-10-21Tinvalid" }],
    [task("a", -1)], [task("a", Infinity)], [task("a", 366)], [task("a", 1, ["b"]), task("b", 1, ["a"])],
  ]) refusal(proposeDeadlineRepairs(items, scenario), "invalid_graph");
  refusal(proposeDeadlineRepairs([task("a")], scenario, new Map()), "invalid_graph");
  refusal(proposeDeadlineRepairs([{ ...task("a"), estimated_minutes: undefined }], { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] }), "invalid_scenario");
  refusal(proposeDeadlineRepairs(Array.from({ length: 201 }, (_, i) => task(String(i))), scenario), "scenario_too_large");
  refusal(proposeDeadlineRepairs([task("a")], scenario, new Map([["a", Array.from({ length: 2001 }, () => "a")]])), "scenario_too_large");
  const items = Array.from({ length: 25 }, (_, i) => task(String(i), 3));
  refusal(proposeDeadlineRepairs(items, { ...scenario, deferrableIds: items.map((item) => item.id) }), "scenario_too_large");
});

test("minimal repairs: custom ordering and contextual relationships share registry semantics", () => {
  const registry = createRelationshipKindRegistry();
  registry.register({ kind: "ships_before", direction: "directed", ordering: true, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false });
  const items = [{ ...task("a"), dependencies: [{ id: "b", kind: "ships_before" }] }, { ...task("b", 1), dependencies: [{ id: "a", kind: "related" }] }];
  const result = proposeDeadlineRepairs(items, { ...scenario, capacityShifts: [{ itemId: "a", minutesPerDay: 960 }] }, buildPrerequisiteGraph(items, registry));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.proposals[0].affectedIds, ["a", "b"]);
});

/** Hash durable tracker bytes, excluding host read caches and lock state. */
function snapshot(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["runtime", "locks", "search", "node_modules"].includes(entry.name)) continue;
    hash.update(entry.name);
    const path = join(root, entry.name);
    if (entry.isDirectory()) hash.update(snapshot(path));
    else if (entry.isFile()) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

test("minimal repairs: real no-git tracker, installed JSON/TOON CLI, typed refusal and byte preservation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(import.meta.dirname, "..");
  const cli = join(repo, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const pmRoot = join(root, ".agents", "pm");
  const sdk = new PmClient({ cwd: root, pmRoot, author: "fixture" });
  await sdk.init("repair", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  const env = { ...process.env, PM_PATH: pmRoot, GIT_CEILING_DIRECTORIES: dirname(root) };
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, encoding: "utf8" })) as { filename: string }[];
  execFileSync(process.execPath, [cli, "package", "install", join(root, packed[0].filename), "--project"], { cwd: root, env, encoding: "utf8" });
  await sdk.create({ id: "repair-a", title: "Prerequisite", type: "Task", estimatedMinutes: "960", createMode: "progressive" });
  await sdk.create({ id: "repair-b", title: "Delivery", type: "Task", estimatedMinutes: "480", blockedBy: "repair-a", createMode: "progressive" });
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(cli, join(bin, "pm"));
  const noGit = { ...env, PATH: bin };
  const before = snapshot(pmRoot);
  const args = [cli, "gantt", "repair", "--from", scenario.from, "--deadline", scenario.deadline, "--capacity", "repair-a=960"];
  const run = spawnSync(process.execPath, [...args, "--json"], { cwd: root, env: noGit, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as DeadlineRepairResult;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.minimalChanges, 1);
  const toon = spawnSync(process.execPath, args, { cwd: root, env: noGit, encoding: "utf8" });
  assert.equal(toon.status, 0, toon.stderr);
  assert.match(toon.stdout, /minimalChanges: 1/);
  const denied = spawnSync(process.execPath, [...args, "--forbid", "repair-a", "--json"], { cwd: root, env: noGit, encoding: "utf8" });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stdout + denied.stderr, /no_allowed_repair/);
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
    const limitKeys = ["max-changes", "maxChanges", "max-proposals", "maxProposals", "max-evaluations", "maxEvaluations", "default-duration", "defaultDuration"];
    const cases: Array<[Record<string, string>, "ok" | "invalid_scenario" | "no_allowed_repair"]> = [
      [{ from: scenario.from, deadline: scenario.deadline, capacity: "repair-a=960", maxChanges: "2", maxProposals: "1", maxEvaluations: "20", defaultDuration: "1" }, "ok"],
      [{ from: scenario.from, deadline: scenario.deadline, defer: "repair-b", forbid: "repair-a", "max-changes": "2" }, "ok"],
      [{ from: scenario.from, deadline: scenario.deadline, capacity: "repair-a=960=extra" }, "invalid_scenario"],
      [{ from: scenario.from, deadline: scenario.deadline, capacity: "repair-a=960", forbid: "repair-a" }, "no_allowed_repair"],
      [{}, "invalid_scenario"],
      ...limitKeys.map((key): [Record<string, string>, "invalid_scenario"] => [{ from: scenario.from, deadline: scenario.deadline, capacity: "repair-a=960", [key]: "0" }, "invalid_scenario"]),
    ];
    for (const [options, expected] of cases) {
      const receipt = await harness.runCommand({ command: "gantt repair", pmRoot, options });
      assert.equal(receipt.handled, true);
      const data = receipt.result as DeadlineRepairResult;
      if (expected === "ok") {
        assert.equal(data.ok, true, JSON.stringify(data));
        if (data.ok) assert.equal(data.minimalChanges, 1);
        assert.equal(receipt.exitCode, undefined);
      } else {
        assert.equal(data.ok, false, JSON.stringify(data));
        if (!data.ok) assert.equal(data.code, expected);
        assert.equal(receipt.exitCode, 2);
      }
    }
  } finally { process.env.PATH = originalPath; }
  assert.equal(snapshot(pmRoot), before, "items, settings, dependencies and append-only history stay byte-identical");
});
