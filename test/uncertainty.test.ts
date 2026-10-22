import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildPrerequisiteGraph, completionIntervals, type CompletionIntervalOptions, type CompletionIntervalResult, type PmItem, type UncertainEstimate } from "../index.ts";

import { assertTypedRefusal as refused, orderingRegistry, packedTracker, snapshot } from "./tracker-fixture.ts";

const options: CompletionIntervalOptions = { from: "2026-10-22", seed: 42 };

/** A minute-based active task, optionally unknown or dependent on prerequisites. */
function task(id: string, minutes?: number, deps: string[] = []): PmItem {
  return { id, title: id, status: "open", estimated_minutes: minutes, dependencies: deps.map((id) => ({ id, kind: "blocked_by" })) };
}

/** Narrow success and prove caller inputs were not changed. */
function simulate(items: PmItem[], controls: CompletionIntervalOptions = options) {
  const before = JSON.stringify({ items, controls });
  const result = completionIntervals(items, controls);
  assert.equal(JSON.stringify({ items, controls }), before);
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test("uniform quantiles match an analytic chain and reproduce from the retained receipt", () => {
  const items = [task("a"), task("b", 480, ["a"])];
  const result = simulate(items, { ...options, samples: 10000, estimates: { a: [480, 4800] } });
  assert.equal(result.complete, true);
  for (const row of result.project!) assert.ok(Math.abs(row.days - (2 + row.probability * 9)) < 0.12, JSON.stringify(row));
  assert.equal(result.dominantEstimate, "a");
  assert.ok(result.sensitivity[0].correlation > 0.999999);
  const { receipt } = result;
  const replay = completionIntervals(receipt.tasks.map((entry) => task(entry.id)), {
    from: receipt.from, seed: receipt.seed, samples: receipt.samples, quantiles: receipt.quantiles, minutesPerDay: receipt.minutesPerDay,
    estimates: Object.fromEntries(receipt.tasks.filter((entry) => entry.estimate !== null).map((entry) => [entry.id, entry.estimate!])),
  }, new Map(receipt.tasks.map((entry) => [entry.id, entry.prerequisites])));
  assert.deepEqual(replay, result);
  assert.deepEqual(simulate([...items].reverse(), { ...options, samples: 10000, estimates: { a: { kind: "uniform", min: 480, max: 4800 } } }), result);
  assert.notDeepEqual(simulate(items, { ...options, seed: 0, estimates: { a: [480, 4800] } }).project, result.project);
  assert.equal(receipt.algorithm, "mulberry32-nearest-rank-v1");
  assert.match(receipt.inputHash, /^[a-f0-9]{64}$/);
});

test("triangular distributions reproduce analytic quantiles including endpoint modes", () => {
  for (const mode of [0, 2400, 4800]) {
    const result = simulate([task("a")], { ...options, samples: 10000, estimates: { a: { kind: "triangular", min: 0, mode, max: 4800 } } });
    for (const row of result.project!) {
      const split = mode / 4800;
      const expected = row.probability < split ? Math.sqrt(row.probability * 4800 * mode) / 480
        : (4800 - Math.sqrt((1 - row.probability) * 4800 * (4800 - mode))) / 480;
      assert.ok(Math.abs(row.days - expected) < 0.12, `${mode}: ${JSON.stringify(row)}`);
    }
  }
});

test("parallel joins take the maximum and diamond branches share one prerequisite draw", () => {
  const parallel = simulate([task("a"), task("b"), task("join", 480, ["a", "b"])], {
    ...options, samples: 10000, estimates: { a: [0, 4800], b: [0, 4800] },
  });
  for (const q of parallel.project!) assert.ok(Math.abs(q.days - (1 + 10 * Math.sqrt(q.probability))) < 0.12);
  const diamond = [task("root"), task("a", 480, ["root"]), task("b", 960, ["root"]), task("join", 480, ["b", "a"])];
  const result = simulate(diamond, { ...options, samples: 10000, estimates: { root: [480, 4800] } });
  for (const q of result.project!) assert.ok(Math.abs(q.days - (4 + 9 * q.probability)) < 0.12);
  const missing = simulate(diamond);
  assert.equal(missing.unknownCount, 4);
  assert.equal(missing.items.find((item) => item.id === "join")!.completion, null);
});

test("point estimates, explicit zero, fixed ranges, empty scope and calendar assumptions", () => {
  const result = simulate([task("a", 0), task("b", 960, ["a"])], { ...options, quantiles: [0, 0.5, 1] });
  assert.deepEqual(result.project!.map((row) => row.days), [2, 2, 2]);
  assert.equal(result.project![0].finish, "2026-10-24T00:00:00.000Z");
  assert.equal(result.dominantEstimate, null);
  assert.deepEqual(result.sensitivity, []);
  for (const estimate of [[480, 480], { kind: "triangular", min: 480, mode: 480, max: 480 }, { kind: "point", minutes: 480 }] satisfies UncertainEstimate[]) {
    assert.equal(simulate([task("a")], { ...options, estimates: { a: estimate }, minutesPerDay: 960 }).project![0].days, 0.5);
  }
  assert.equal(simulate([]).project![0].days, 0);
  assert.equal(simulate([{ ...task("a", 480), deadline: "2028-01-01", created_at: "2027-01-01" }]).project![0].days, 1);
  const next = simulate([task("a", 480)], { ...options, from: "9999-12-31" });
  assert.equal(next.project![0].finish, "+010000-01-01T00:00:00.000Z");
});

test("unknown estimates and their downstream completion stay unknown without hiding known work", () => {
  const result = simulate([task("a"), task("b", 480, ["a"]), task("known", 960)]);
  assert.equal(result.complete, false);
  assert.equal(result.unknownCount, 2);
  assert.equal(result.unknownEstimateCount, 1);
  assert.equal(result.project, null);
  assert.deepEqual(result.items.map((row) => row.reason), ["unknown_estimate", "unknown_prerequisite", null]);
  assert.equal(result.items[1].completion, null);
  assert.equal(result.items[2].completion![0].days, 2);
  assert.equal(result.dominantEstimate, null);
  assert.deepEqual(result.sensitivity, []);
  assert.equal(result.receipt.tasks[0].estimate, null);
});

test("sensitivity ranks the dominating estimate and describes constant-output cases", () => {
  const result = simulate([task("wide"), task("narrow", undefined, ["wide"]), task("side")], {
    ...options, samples: 10000, estimates: { wide: [480, 48000], narrow: [480, 960], side: [0, 240] }, limit: 1,
  });
  assert.equal(result.dominantEstimate, "wide");
  assert.ok(result.sensitivity[0].correlation > 0.99);
  assert.equal(result.sensitivityCount, 3);
  assert.equal(result.sensitivity.length, 1);
  assert.equal(result.itemCount, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.receipt.tasks.length, 3, "output limit cannot truncate replay inputs");
  for (const range of [[0, 1], [0, Number.MIN_VALUE]] satisfies [number, number][]) {
    const fixed = simulate([task("a", 48000), task("b")], { ...options, estimates: { b: range } });
    assert.equal(fixed.sensitivity[0].correlation, 0);
    assert.equal(fixed.dominantEstimate, null);
  }
  // Equal distributions can yield a stable tie at zero association.
  const tied = simulate([task("fixed", 48000), task("z"), task("a")], { ...options, estimates: { a: [0, 1], z: [0, 1] } });
  assert.deepEqual(tied.sensitivity.map((row) => row.id), ["a", "z"]);
  const tiny = simulate([task("a"), task("b")], { ...options, estimates: { a: [0, Number.MIN_VALUE], b: [480, 960] } });
  assert.equal(tiny.sensitivity.find((row) => row.id === "a")!.correlation, 0);
  // Nonconstant subnormal finishes may have unmeasurably small squared deviations.
  const subnormal = simulate([task("a")], { ...options, minutesPerDay: 1440, estimates: { a: [0, 1e-160] } });
  assert.equal(subnormal.sensitivity[0].correlation, 0);
});

test("completed prerequisites are satisfied, contextual edges ignored and custom ordering honored", () => {
  const registry = orderingRegistry();
  const items = [{ ...task("done"), status: "closed" as const }, { ...task("dropped"), status: "canceled" as const },
    { ...task("a", 480, ["done", "dropped"]), dependencies: [{ id: "done", kind: "blocked_by" }, { id: "dropped", kind: "blocked_by" }, { id: "b", kind: "ships_before" }] },
    { ...task("b", 480), dependencies: [{ id: "a", kind: "related" }] }];
  const result = completionIntervals(items, options, buildPrerequisiteGraph(items, registry));
  assert.ok(result.ok);
  assert.equal(result.activeCount, 2);
  assert.equal(result.project![0].days, 2);
  assert.deepEqual(result.receipt.tasks[1].prerequisites, ["a"]);
});

for (const invalid of [
  { from: "bad" }, { from: "2026-02-30" }, { from: "9999-99-99" }, { seed: -1 }, { seed: 4294967296 }, { seed: NaN },
  { samples: 0 }, { samples: 10001 }, { samples: 100.5 }, { minutesPerDay: 0 }, { minutesPerDay: 1441 }, { minutesPerDay: Infinity },
  { limit: 0 }, { limit: 201 }, { quantiles: [] }, { quantiles: Array(10).fill(0) as number[] }, { quantiles: [-0.1] }, { quantiles: [1.1] },
  { quantiles: [NaN] }, { quantiles: [0.5, 0.5] }, { quantiles: [0.9, 0.1] },
] satisfies Partial<CompletionIntervalOptions>[]) {
  test(`invalid uncertainty controls ${JSON.stringify(invalid)}`, () => refused(completionIntervals([task("a", 480)], { ...options, ...invalid }), "invalid_scenario"));
}

test("invalid estimates, incomplete graphs and bounded work are refused", () => {
  for (const estimate of ["480", [], [1], [1, 2, 3], [2, 1], [0, Infinity], [-1, 1], null, undefined,
    { kind: "normal", min: 0, max: 1 }, { kind: "triangular", min: 0, max: 1, mode: 2 }, { kind: "triangular", min: 1, max: 2, mode: 0 },
    { kind: "point", minutes: NaN }, { kind: "point", minutes: 175201 }, { kind: "point", minutes: "480" },
  ]) refused(completionIntervals([task("a")], { ...options, estimates: { a: estimate as UncertainEstimate } }), "invalid_estimate");
  for (const minutes of [-1, Infinity, 175201]) refused(completionIntervals([task("a", minutes)], options), "invalid_estimate");
  refused(completionIntervals([task("a", 480)], { ...options, estimates: { absent: [0, 1] } }), "invalid_estimate");
  for (const items of [[task("a"), task("a")], [task("")], [task("a".repeat(129))], [task("a", 480, ["absent"])], [task("a", 480, ["b"]), task("b", 480, ["a"])]] ) {
    refused(completionIntervals(items, options), "invalid_graph");
  }
  refused(completionIntervals([task("a")], options, new Map()), "invalid_graph");
  refused(completionIntervals([], options, new Map([["extra", []]])), "invalid_graph");
  refused(completionIntervals(Array.from({ length: 201 }, (_, i) => task(String(i))), options), "scenario_too_large");
  refused(completionIntervals([task("a")], options, new Map([["a", Array(2001).fill("a") as string[]]])), "scenario_too_large");
  refused(completionIntervals([task("a")], { ...options, samples: 10000 }, new Map([["a", Array(501).fill("a") as string[]]])), "scenario_too_large");
});

test("real non-git tracker: packed JSON/TOON CLI, typed remedies, SDK harness and durable read-only proof", async (t) => {
  const { root, sdk, pmRoot, bin, invoke } = await packedTracker(t, "uncertainty");
  await sdk.create({ id: "uncertainty-a", title: "Uncertain prerequisite", type: "Task", createMode: "progressive" });
  await sdk.create({ id: "uncertainty-b", title: "Delivery", type: "Task", estimatedMinutes: "480", blockedBy: "uncertainty-a", createMode: "progressive" });
  const file = join(root, "estimates.json");
  writeFileSync(file, JSON.stringify({ "uncertainty-a": [480, 4800] }));
  const before = snapshot(pmRoot);
  const args = ["gantt", "uncertainty", "--from", options.from, "--seed", "42", "--estimates", file];
  for (const format of ["json", "toon"]) {
    const run = invoke(format === "json" ? [...args, "--json"] : args);
    assert.equal(run.status, 0, run.stderr);
    if (format === "json") {
      const data = JSON.parse(run.stdout) as CompletionIntervalResult;
      assert.ok(data.ok && data.dominantEstimate === "uncertainty-a");
    } else assert.match(run.stdout, /dominantEstimate: "uncertainty-a"/);
  }
  const denied = invoke([...args, "--samples", "0", "--json"]);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stdout + denied.stderr, /invalid_scenario/);
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
    const base = { from: options.from, seed: "0" };
    for (const controls of [{ ...base }, { ...base, estimates: file, samples: "100", quantiles: "0,0.5,1", minutesPerDay: "240", limit: "1" },
      { ...base, "minutes-per-day": "960" },
    ]) {
      const receipt = await harness.runCommand({ command: "gantt uncertainty", pmRoot, options: controls });
      assert.equal((receipt.result as CompletionIntervalResult).ok, true);
    }
    for (const controls of [{}, { ...base, seed: "" }, { ...base, quantiles: "" }, { ...base, samples: "0" }, { ...base, estimates: join(root, "absent") }, { ...base, estimates: root }]) {
      const receipt = await harness.runCommand({ command: "gantt uncertainty", pmRoot, options: controls });
      assert.equal((receipt.result as CompletionIntervalResult).ok, false);
      assert.equal(receipt.exitCode, 2);
    }
    for (const contents of ["{", "[]", "null", "0", " ".repeat(65537)]) {
      writeFileSync(file, contents);
      const receipt = await harness.runCommand({ command: "gantt uncertainty", pmRoot, options: { ...base, estimates: file } });
      const data = receipt.result as CompletionIntervalResult;
      refused(data, "invalid_estimate");
      assert.equal(receipt.exitCode, 2);
    }
  } finally { process.env.PATH = originalPath; }
  assert.equal(snapshot(pmRoot), before, "durable items, settings, dependencies and append-only history remain byte-identical");
});
