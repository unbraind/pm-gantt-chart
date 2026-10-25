import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { resourceScenarios, applyResourceSelection, buildPrerequisiteGraph, type PmItem, type ResourceCalendar, type ResourceScenarioOptions, type ResourceScenarioSuccess, type ResourceScenarioResult, type ResourceSelection } from "../index.ts";
import { assertTypedRefusal as refused, orderingRegistry, packedTracker, snapshot } from "./tracker-fixture.ts";

const calendar: ResourceCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: [], minutesPerDay: 480, minutesPerWeek: 2400, totalMinutes: 4800 };
const controls: ResourceScenarioOptions = { from: "2026-10-23", through: "2026-10-27", timeZone: "Europe/Vienna", scenarios: [{ id: "base", owners: { worker: calendar } }] };

/** Named active work with a real assignee and optional prerequisites. */
function task(id: string, minutes = 480, deps: string[] = []): PmItem {
  return { id, title: id, status: "open", assignee: "worker", estimated_minutes: minutes, dependencies: deps.map((id) => ({ id, kind: "blocked_by" })) };
}

/** Require a computation, leaving infeasible alternatives as successful measured results. */
function compute(items: PmItem[], options: ResourceScenarioOptions = controls) {
  const before = JSON.stringify([items, options]);
  const result = resourceScenarios(items, options);
  assert.equal(JSON.stringify([items, options]), before);
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

/** Generate alternative owner limits without mutating the common fixture. */
function limited(changes: Partial<ResourceCalendar>): ResourceScenarioOptions {
  return { ...controls, scenarios: [{ id: "limited", owners: { worker: { ...calendar, ...changes } } }] };
}

test("resource contention delays independent work, pooled minutes preempt and alternatives stay isolated", () => {
  const items = [task("a", 720), task("b", 720)];
  const result = compute(items, { ...controls, limit: 1, scenarios: [controls.scenarios[0], { id: "double", owners: { worker: { ...calendar, minutesPerDay: 960 } } }] });
  assert.deepEqual(result.scenarios[0].items[0], { id: "a", owner: "worker", minutes: 720, allocatedMinutes: 720, start: "2026-10-23", finish: "2026-10-26" });
  assert.equal(result.scenarios[0].feasible, true);
  assert.equal(result.scenarios[0].truncated, true);
  assert.equal(result.scenarios[0].itemCount, 2);
  assert.equal(result.scenarios[1].items[0].finish, "2026-10-23");
  assert.notEqual(result.scenarios[0].selection, result.scenarios[1].selection);
  assert.deepEqual(compute(items).scenarios[0].items.map((row) => row.finish), ["2026-10-26", "2026-10-27"]);
  assert.deepEqual(compute(items), compute([...items].reverse()));
  assert.equal(compute([]).activeCount, 0);
  assert.equal(compute([task("zero", 0)]).scenarios[0].items[0].finish, controls.from);
});

test("overloads have independent numerical bounds and zero capacity cannot fabricate completion", () => {
  for (const limits of [{ minutesPerDay: 240 }, { minutesPerWeek: 240 }, { totalMinutes: 240 }, { weekdays: [] }, { holidays: [controls.from, "2026-10-26", "2026-10-27"] }]) {
    const result = compute([task("a", 960)], limited(limits));
    const scenario = result.scenarios[0];
    assert.equal(scenario.outcome, "capacity_infeasible");
    const witness = scenario.witnesses[0];
    assert.equal(witness.requiredMinutes, 960);
    assert.equal(witness.deficitMinutes, witness.requiredMinutes - witness.availableMinutes);
    assert.ok(witness.deficitMinutes > 0);
    assert.equal(scenario.items[0].finish, null);
  }
  const zero = compute([task("a")], limited({ totalMinutes: 0 })).scenarios[0];
  assert.equal(zero.items[0].start, null);
  assert.equal(zero.remainingMinutes, 480);
});

test("weekly budgets reset on Monday; holidays, unused capacity and next-day dependencies are respected", () => {
  const items = [task("a"), task("b", 480, ["a"])];
  const result = compute(items, limited({ minutesPerWeek: 480 }));
  assert.deepEqual(result.scenarios[0].items.map((row) => row.finish), ["2026-10-23", "2026-10-26"]);
  assert.equal(compute([task("a", 960)], limited({ holidays: ["2026-10-26"] })).scenarios[0].items[0].finish, "2026-10-27");
  const assigned = [task("a"), { ...task("b", 480, ["a"]), assignee: "second" }];
  const unused = compute(assigned, { ...controls, scenarios: [{ id: "unused", owners: { worker: calendar, second: { ...calendar, totalMinutes: 480, minutesPerWeek: 480 } } }] });
  assert.equal(unused.scenarios[0].items[1].finish, "2026-10-26", "idle Friday must not consume Monday or lifetime capacity");
  const exhausted = compute(items, { ...controls, through: controls.from, scenarios: [{ id: "wide", owners: { worker: { ...calendar, minutesPerDay: 1440 } } }] });
  assert.equal(exhausted.scenarios[0].outcome, "allocation_exhausted");
  assert.deepEqual(exhausted.scenarios[0].witnesses, []);
  const closed = { ...task("done"), status: "closed" as const };
  assert.equal(compute([closed, { ...task("cancel"), status: "canceled" }, task("a", 480, ["done"])]).activeCount, 1);
});

test("custom registry ordering and inverse dedup reuse the SDK execution semantics", () => {
  const items = [{ ...task("b"), dependencies: [{ id: "a", kind: "related" }] }, { ...task("a"), dependencies: [{ id: "b", kind: "ships_before" }, { id: "b", kind: "ships_before" }] }];
  const graph = buildPrerequisiteGraph(items, orderingRegistry());
  const result = resourceScenarios(items, controls, graph);
  assert.ok(result.ok);
  assert.equal(result.scenarios[0].items.find((row) => row.id === "b")!.start, "2026-10-26");
});

test("civil dates reproduce across host zones through the Vienna DST weekend", () => {
  const script = `import {resourceScenarios} from './index.ts'; console.log(JSON.stringify(resourceScenarios(${JSON.stringify([task("a", 960)])},${JSON.stringify(controls)})));`;
  const runs = ["UTC", "America/Los_Angeles", "Pacific/Auckland"].map((TZ) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, TZ }, encoding: "utf8" }));
  assert.equal(runs[0], runs[1]); assert.equal(runs[0], runs[2]);
});

test("source revisions bind effort, assignees, deadlines, statuses and resolved edges", () => {
  const items = [task("a"), task("b")], original = compute(items);
  for (const change of [{ estimated_minutes: 481 }, { assignee: "other" }, { deadline: "2026-10-26" }, { due_date: "2026-10-25" }, { status: "draft" as const }, { dependencies: [{ id: "b", kind: "blocked_by" }] }]) {
    const changed = [{ ...items[0], ...change }, items[1]];
    const result = compute(changed, { ...controls, scenarios: [{ id: "base", owners: { worker: calendar, other: calendar } }] });
    assert.notEqual(result.revision, original.revision);
  }
  const overrides = compute([{ ...task("a"), assignee: undefined, estimated_minutes: undefined }], { ...controls, scenarios: [{ id: "offer", owners: { worker: calendar }, work: { a: { owner: "worker", minutes: 60 } } }] });
  assert.equal(overrides.scenarios[0].items[0].minutes, 60);
});

test("SDK runtime refuses malformed controls, work declarations and bounded-input violations", () => {
  const invalid = [null, {}, { ...controls, from: "2026-02-30" }, { ...controls, through: "2026-01-01" }, { ...controls, timeZone: "" }, { ...controls, timeZone: 1 }, { ...controls, timeZone: "Mars/Olympus" }, { ...controls, scenarios: [] }, { ...controls, scenarios: null }, { ...controls, limit: 0 }, { ...controls, limit: 201 }, { ...controls, limit: 1.5 }];
  for (const value of invalid) refused(resourceScenarios([task("a")], value as ResourceScenarioOptions), "invalid_estimate");
  const alternatives = [null, { ...controls.scenarios[0], id: "" }, { id: "base", owners: null }, { id: "base", owners: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [i, calendar])) }, { id: "base", owners: { "": calendar } }, { id: "base", owners: { ["x".repeat(129)]: calendar } },
    ...[null, { ...calendar, weekdays: null }, { ...calendar, weekdays: [0] }, { ...calendar, weekdays: [8] }, { ...calendar, weekdays: [1.5] }, { ...calendar, weekdays: [1, 1] }, { ...calendar, weekdays: Array(8).fill(1) }, { ...calendar, holidays: null }, { ...calendar, holidays: Array(367).fill(controls.from) }, { ...calendar, holidays: [1] }, { ...calendar, holidays: ["bad"] }, { ...calendar, minutesPerDay: -1 }, { ...calendar, minutesPerDay: 1441 }, { ...calendar, minutesPerWeek: NaN }, { ...calendar, minutesPerWeek: 10081 }, { ...calendar, totalMinutes: 527041 }].map((value) => ({ id: "base", owners: { worker: value } })),
    ...[null, { absent: { owner: "worker", minutes: 1 } }, { a: null }, { a: { owner: 1, minutes: 1 } }, { a: { owner: "worker", minutes: -1 } }].map((work) => ({ ...controls.scenarios[0], work }))];
  for (const alternative of alternatives) refused(resourceScenarios([task("a")], { ...controls, scenarios: [alternative] } as ResourceScenarioOptions), alternative !== null && "work" in alternative && alternative.work !== undefined && alternative.work !== null && "absent" in alternative.work ? "invalid_scenario" : "invalid_estimate");
  refused(resourceScenarios([], { ...controls, scenarios: [controls.scenarios[0], controls.scenarios[0]] }), "invalid_scenario");
  for (const item of [{ ...task("a"), assignee: undefined }, { ...task("a"), assignee: "absent" }, { ...task("a"), estimated_minutes: undefined }]) refused(resourceScenarios([item], controls), "missing_work");
  for (const minutes of [Infinity, -1]) refused(resourceScenarios([task("a", minutes)], controls), "invalid_estimate");
  for (const options of [{ ...controls, through: "2028-01-01" }, { ...controls, scenarios: Array.from({ length: 6 }, (_, i) => ({ ...controls.scenarios[0], id: String(i) })) }]) refused(resourceScenarios([], options), "scenario_too_large");
  refused(resourceScenarios(Array.from({ length: 201 }, (_, i) => task(String(i))), controls), "scenario_too_large");
  refused(resourceScenarios(Array.from({ length: 2001 }, (_, i) => ({ ...task(String(i)), status: "closed" })), controls), "scenario_too_large");
  refused(resourceScenarios([task("a")], controls, new Map([["a", Array(5001).fill("a")]])), "scenario_too_large");
});

test("SDK rejects identity corruption, missing prerequisite rows and active cycles", () => {
  for (const [items, graph] of [
    [[task("a"), task("a")], undefined], [[task("")], undefined], [[task("x".repeat(129))], undefined],
    [[task("a", 1, ["absent"])], undefined], [[task("a")], new Map()], [[task("a")], new Map([["a", []], ["absent", []]])],
    [[task("a", 1, ["b"]), task("b", 1, ["a"])], undefined],
  ] as const) refused(resourceScenarios([...items], controls, graph), "invalid_graph");
});

test("review: dangling forward relationships refuse before adaptation can erase missing targets", async () => {
  for (const kind of ["blocks", "blocked_by", "ships_before", "related", "unknown_context"]) {
    const items = [{ ...task("a"), dependencies: [{ id: "missing", kind }] }];
    const before = JSON.stringify(items);
    const result = resourceScenarios(items, controls, buildPrerequisiteGraph(items, orderingRegistry()));
    refused(result, "invalid_graph");
    refused(resourceScenarios(items, controls, new Map([["a", []]])), "invalid_graph");
    assert.deepEqual(await applyResourceSelection("unused", "fixture", result, {
      scenarioId: "base", selection: "unavailable", expectedRevision: "unavailable", targetId: "a", targetRevision: "unavailable",
    }), result, "an unresolved graph cannot become a selectable scenario");
    assert.equal(JSON.stringify(items), before);
  }
  const resolved = [{ ...task("a"), dependencies: [{ id: "b", kind: "blocks" }] }, task("b")];
  assert.equal(compute(resolved).scenarios[0].feasible, true);
});

test("review: non-string horizon values return invalid_estimate without coercion", () => {
  for (const field of ["from", "through"]) {
    for (const value of [null, undefined, 20261023, false, [], [controls.from], {}, { toString: null }, Symbol("day")]) {
      assert.doesNotThrow(() => refused(resourceScenarios([task("a")], { ...controls, [field]: value } as ResourceScenarioOptions), "invalid_estimate"));
    }
    /** A runtime caller's conversion hook must never execute during validation. */
    const hostile = { toString() { assert.fail("horizon values must not be coerced"); } };
    refused(resourceScenarios([task("a")], { ...controls, [field]: hostile } as ResourceScenarioOptions), "invalid_estimate");
  }
});

test("explicit application requires reviewed tokens and source revision before touching storage", async () => {
  const result = compute([task("a")]);
  const choice: ResourceSelection = { scenarioId: "base", selection: result.scenarios[0].selection, expectedRevision: result.revision, targetId: "target", targetRevision: "revision" };
  for (const key of Object.keys(choice)) refused(await applyResourceSelection("unused", "fixture", result, { ...choice, [key]: "" }), "selection_required");
  refused(await applyResourceSelection("unused", "fixture", result, { ...choice, expectedRevision: "stale" }), "revision_conflict");
  for (const change of [{ scenarioId: "absent" }, { selection: "tampered" }]) refused(await applyResourceSelection("unused", "fixture", result, { ...choice, ...change }), "selection_required");
  const overloaded = compute([task("a", 960)], limited({ totalMinutes: 0 }));
  refused(await applyResourceSelection("unused", "fixture", overloaded, { ...choice, scenarioId: "limited", expectedRevision: overloaded.revision, selection: overloaded.scenarios[0].selection }), "infeasible_selection");
  const denial = resourceScenarios([task("a")], { ...controls, from: "bad" });
  assert.deepEqual(await applyResourceSelection("unused", "fixture", denial, choice), denial);
  /** Unexpected serialization failures must propagate without an SDK write. */
  const unserializable = { ...choice, toJSON() { throw new Error("serialization failure"); } };
  await assert.rejects(applyResourceSelection("unused", "fixture", result, unserializable), /serialization failure/);
});

test("packed CLI runs TOON/JSON and revision-checked selection in a real tracker without git", async (t) => {
  const { root, pmRoot, sdk, invoke, bin } = await packedTracker(t, "resource");
  await sdk.create({ id: "resource-a", type: "Task", title: "Source", assignee: "fixture", estimatedMinutes: "480", deadline: "2026-10-27" });
  await sdk.create({ id: "resource-target", type: "Plan", title: "Selection" });
  const target = (await sdk.get("resource-target", { full: true })).item;
  const options: ResourceScenarioOptions = { ...controls, scenarios: [{ id: "base", owners: { fixture: calendar }, work: { "resource-target": { owner: "fixture", minutes: 0 } } }] };
  const file = join(root, "resources.json"); writeFileSync(file, JSON.stringify(options));
  const before = snapshot(pmRoot), args = ["gantt", "resources", "--scenarios", file];
  const run = invoke([...args, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as ResourceScenarioSuccess;
  assert.ok(result.ok); assert.equal(result.activeCount, 2);
  assert.match(invoke(args).stdout, /revision:/);
  assert.equal(snapshot(pmRoot), before);
  const choice = { scenarioId: "base", selection: result.scenarios[0].selection, expectedRevision: result.revision, targetId: "resource-target", targetRevision: target.updated_at! };
  const applied = await applyResourceSelection(pmRoot, "fixture", result, choice);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(await applyResourceSelection(pmRoot, "fixture", result, choice), applied, "same selection is idempotent");
  const refreshed = (await sdk.get("resource-target", { full: true })).item;
  assert.equal(refreshed.deadline, target.deadline);
  assert.equal((await sdk.get("resource-a", { full: true })).item.deadline, "2026-10-27T00:00:00.000Z");
  const changedControls = { ...options, scenarios: [{ ...options.scenarios[0], id: "changed" }] };
  const recomputed = compute([task("a")]);
  assert.ok(recomputed.ok);
  const stale = await applyResourceSelection(pmRoot, "fixture", { ...result, scenarios: [{ ...result.scenarios[0], id: "changed" }] }, { ...choice, scenarioId: "changed" });
  refused(stale, "application_refused");
  writeFileSync(file, JSON.stringify(changedControls));
  const denied = invoke([...args, "--select", "changed", "--selection", "stale", "--json"]);
  assert.equal(denied.status, 2, denied.stderr);
  const oldPath = process.env.PATH; process.env.PATH = bin;
  try {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
    for (const contents of ["{", " ".repeat(262145)]) {
      writeFileSync(file, contents);
      const receipt = await harness.runCommand({ command: "gantt resources", pmRoot, options: { scenarios: file } });
      assert.equal(receipt.exitCode, 2);
    }
    for (const options of [{}, { scenarios: root }, { scenarios: join(root, "missing") }]) {
      const receipt = await harness.runCommand({ command: "gantt resources", pmRoot, options }); assert.equal(receipt.exitCode, 2);
    }
    writeFileSync(file, JSON.stringify(changedControls));
    for (const extra of [{}, { select: "changed" }, { selection: "token" }, { expectRevision: "stale" }]) {
      const receipt = await harness.runCommand({ command: "gantt resources", pmRoot, options: { scenarios: file, ...extra } });
      assert.equal((receipt.result as { ok: boolean }).ok, Object.keys(extra).length === 0);
    }
    for (const camel of [false, true]) {
      const computed = (await harness.runCommand({ command: "gantt resources", pmRoot, options: { scenarios: file } })).result as ResourceScenarioSuccess;
      const current = (await sdk.get("resource-target", { full: true })).item;
      const selection = computed.scenarios[0];
      const receipt = await harness.runCommand({ command: "gantt resources", pmRoot, global: { author: "fixture" }, options: {
        scenarios: file, select: selection.id, selection: selection.selection, target: "resource-target",
        [camel ? "expectRevision" : "expect-revision"]: computed.revision,
        [camel ? "targetRevision" : "target-revision"]: current.updated_at,
      } });
      assert.equal((receipt.result as { ok: boolean }).ok, true, JSON.stringify(receipt.result));
    }
    const sourceChanged = await sdk.update("resource-a", { estimatedMinutes: "481" });
    assert.equal(sourceChanged.item.estimated_minutes, 481);
    const conflict = await harness.runCommand({ command: "gantt resources", pmRoot, options: {
      scenarios: file, select: "changed", selection: result.scenarios[0].selection,
      "expect-revision": result.revision, target: "resource-target", "target-revision": target.updated_at,
    } });
    refused(conflict.result as ResourceScenarioResult, "revision_conflict");
  } finally { process.env.PATH = oldPath; }
});


test("review: no-git CLI refuses dangling forward edges and malformed horizon objects without writes", async (t) => {
  const { root, pmRoot, sdk, invoke } = await packedTracker(t, "resource-review");
  const file = join(root, "review-scenarios.json");
  const options = { ...controls, scenarios: [{ id: "base", owners: { fixture: calendar } }] };
  await sdk.create({ id: "resource-review-a", title: "Forward reference", type: "Task", assignee: "fixture", estimatedMinutes: "480",
    dep: ["id=resource-review-missing,kind=blocks"], allowUnresolvedDeps: true });
  const before = snapshot(pmRoot);
  for (const field of ["from", "through"]) {
    writeFileSync(file, JSON.stringify({ ...options, [field]: { toString: null } }));
    const run = invoke(["gantt", "resources", "--scenarios", file, "--json"]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stdout + run.stderr, /invalid_estimate/);
    assert.doesNotMatch(run.stdout + run.stderr, /TypeError/);
  }
  writeFileSync(file, JSON.stringify(options));
  for (const extra of [[], ["--select", "base", "--selection", "unavailable", "--expect-revision", "unavailable", "--target", "resource-review-a", "--target-revision", "unavailable"]]) {
    const run = invoke(["gantt", "resources", "--scenarios", file, ...extra, "--json"]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stdout + run.stderr, /invalid_graph/);
  }
  assert.equal(snapshot(pmRoot), before, "refused evaluation and application leave durable tracker data unchanged");
});
