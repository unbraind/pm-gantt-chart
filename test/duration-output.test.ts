import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { calibrateObservedDurations, applyResourceSelection, completionIntervals, resourceScenarios, proposeDeadlineRepairs, type PmItem } from "../index.ts";
import { simulateCompletionIntervals } from "../uncertainty.ts";
import { computeResourceScenarios } from "../resources.ts";
import { validateDurationOutput } from "../duration-input.ts";
import { seedHistory } from "./calibration-fixture.ts";
import { assertTypedRefusal, packedTracker, snapshot } from "./tracker-fixture.ts";

const SEED = 1792202610;
const sampling = { from: "2026-01-02", seed: 42, samples: 100, quantiles: [0, 0.5, 1] };
const calendar = { weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [], minutesPerDay: 1440, minutesPerWeek: 10080, totalMinutes: 527040 };
const resources = { from: sampling.from, through: "2026-01-03", timeZone: "UTC", scenarios: [{ id: "base", owners: { worker: calendar } }] };

/** Independent field-domain oracle: never asks the production validator whether output is valid. */
function contract(value: unknown, field = "root"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${field} must be finite`);
    const bounds: Record<string, readonly [number, number]> = {
      elapsedToPlannedRatio: [0, 10512000], probability: [0, 1], correlation: [-1, 1], days: [0, 35040000],
      elapsedMinutes: [0, 175200], plannedMinutes: [1 / 60, 175200], minutes: [0, 175200], allocatedMinutes: [0, 175200],
      remainingMinutes: [0, 35040000], requiredMinutes: [0, 35040000], deficitMinutes: [0, 35040000], availableMinutes: [0, 527040],
    };
    const range = bounds[field] ?? [0, 4294967295];
    assert.ok(value >= range[0] && value <= range[1], `${field}=${value} outside ${range}`);
  } else if (Array.isArray(value)) {
    for (const entry of value) contract(entry, field);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (["elapsedToPlannedRatio", "probability", "days", "elapsedMinutes", "plannedMinutes", "minutes", "allocatedMinutes"].includes(key)) assert.equal(typeof entry, "number", key);
      if (["finish", "start", "from", "through"].includes(key) && entry !== null) {
        assert.equal(typeof entry, "string");
        assert.match(entry as string, /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/);
        assert.ok(Number.isFinite(Date.parse(entry as string)));
      }
      contract(entry, key);
    }
  }
}

/** Success must survive JSON transport with the same finite fields; failure must be actionable. */
function checked(result: { ok: true } | { ok: false; code: string; remedy: string }): void {
  if (result.ok) {
    contract(result);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } else assert.ok(result.remedy.length > 15);
}

test("round 2: exact tiny start estimate refuses without a null ratio or writes", async (t) => {
  const { pmRoot, sdk, invoke } = await packedTracker(t, "ratio-overflow");
  seedHistory(pmRoot, "extreme", [{ estimated_minutes: 1e-308 }, { status: "in_progress", estimated_minutes: 1e-308 }, { status: "closed", estimated_minutes: 1e-308 }]);
  const before = await sdk.get("extreme", { full: true }), hash = snapshot(pmRoot);
  const result = await calibrateObservedDurations(pmRoot, { type: "Task", minimumSamples: 1 });
  assertTypedRefusal(result, "invalid_estimate");
  assert.equal(snapshot(pmRoot), hash);
  assert.deepEqual(await sdk.get("extreme", { full: true }), before);
  const wire = invoke(["gantt", "calibrate", "--type", "Task", "--minimum-samples", "1", "--json"]);
  assert.equal(wire.status, 2, wire.stderr);
  assertTypedRefusal(JSON.parse(wire.stdout), "invalid_estimate");
});

test("output guard refuses an out-of-contract computed date from accepted input", () => {
  const result = completionIntervals([{ id: "future", title: "Future", status: "open", estimated_minutes: 480 }], { ...sampling, from: "9999-12-31" });
  assertTypedRefusal(result, "invalid_estimate");
  if (result.ok) assert.fail("output contract must guard successful numerical returns");
  assert.match(result.message, /sampling\.project\[0\]\.finish/);
});

test("output contract names every corrupted numeric/date field, including null numbers", async (t) => {
  const { pmRoot, sdk } = await packedTracker(t, "output-fields");
  seedHistory(pmRoot, "extreme", [{}, { status: "in_progress" }, { status: "closed" }]);
  seedHistory(pmRoot, "identical", [{}, { status: "in_progress" }, { status: "closed" }]);
  const item: PmItem = { id: "future", title: "Future", status: "open", estimated_minutes: 60, assignee: "worker" };
  const examples = {
    calibration: await calibrateObservedDurations(pmRoot, { type: "Task", minimumSamples: 1 }),
    sampling: completionIntervals([item], sampling), resources: resourceScenarios([item], resources),
    repair: proposeDeadlineRepairs([item], { from: sampling.from, deadline: "2026-01-03" }),
  };
  assert.ok(examples.calibration.ok);
  assert.deepEqual(examples.calibration.distribution.values, [1440, 1440]);
  let probes = 0;
  /** Replace one leaf at a time using its actual object path, preserving all surrounding fields. */
  function visit(kind: keyof typeof examples, original: unknown, value: unknown, path: (string | number)[]): void {
    const isDate = typeof value === "string" && ["finish", "start", "from"].includes(String(path.at(-1)));
    if (typeof value === "number" || isDate) {
      for (const bad of isDate ? ["invalid", "+010000-01-01T00:00:00.000Z"] : [NaN, Infinity, -Infinity, null, 1e308, -0]) {
        const copy = structuredClone(original) as Record<string, unknown>;
        let parent: Record<string | number, unknown> = copy;
        for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
        parent[path.at(-1)!] = bad;
        const result = validateDurationOutput(kind, copy);
        assertTypedRefusal(result as { ok: false; code: string; remedy: string }, "invalid_estimate");
        if (result.ok) assert.fail("bad output escaped");
        assert.ok(String(result.message).includes(kind));
        probes++;
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(kind, original, child, [...path, key]);
    }
  }
  for (const [kind, result] of Object.entries(examples)) {
    assert.ok(result.ok, JSON.stringify(result)); checked(result);
    visit(kind as keyof typeof examples, result, result, []);
  }
  assert.ok(examples.resources.ok);
  const resource = examples.resources;
  const stored = await sdk.get("extreme", { full: true }), hash = snapshot(pmRoot);
  const applied = await applyResourceSelection(pmRoot, "fixture", { ...resource, activeCount: Infinity }, {
    scenarioId: "base", selection: resource.scenarios[0].selection, expectedRevision: resource.revision,
    targetId: "extreme", targetRevision: String(stored.item.updated_at),
  });
  assertTypedRefusal(applied, "invalid_estimate");
  assert.deepEqual(await sdk.get("extreme", { full: true }), stored);
  assert.equal(snapshot(pmRoot), hash);
  assertTypedRefusal(validateDurationOutput("sampling", new Proxy({}, { ownKeys() { throw new Error("unreadable"); } })) as { ok: false; code: string; remedy: string }, "invalid_estimate");
  t.diagnostic(`corrupted output leaf probes=${probes}`);
});

test("2000 seeded extreme histories and forecasts produce bounded outputs or read-only refusals", async (t) => {
  const { root, pmRoot, sdk, bin } = await packedTracker(t, "output-extremes");
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  const estimateFile = join(root, "estimate.json"), scenarioFile = join(root, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify(resources));
  process.env.PATH = bin;
  const planned = [Number.MIN_VALUE, 1e-308, 1e308, Number.MAX_SAFE_INTEGER, 1 / 6000, 1 / 60, 175200, 175201, 0, 60, 1440, 300 * 365 * 1440];
  const elapsed = [0, 1, 999, 1000, 60000, 86400000, 175200 * 60000, 175201 * 60000, 300 * 365 * 86400000];
  let state = SEED, accepted = 0, refused = 0;
  for (let index = 0; index < 2000; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const minutes = planned[state % planned.length], milliseconds = elapsed[(state >>> 8) % elapsed.length];
    const start = Date.UTC(2026, 0, 2);
    seedHistory(pmRoot, "extreme", [{ estimated_minutes: minutes }, { status: "in_progress", estimated_minutes: minutes }, { status: "closed", estimated_minutes: minutes }],
      { times: [new Date(start - 86400000).toISOString(), new Date(start).toISOString(), new Date(start + milliseconds).toISOString()] });
    const before = await sdk.get("extreme", { full: true });
    const hash = snapshot(join(pmRoot, "tasks")) + snapshot(join(pmRoot, "history"));
    const result = await calibrateObservedDurations(pmRoot, { type: "Task", minimumSamples: 1, quantiles: [0, 0.5, 1] });
    checked(result); result.ok ? accepted++ : refused++;
    if (result.ok) {
      assert.deepEqual(result.distribution.values, [milliseconds / 60000]);
      assert.equal(result.quantiles[0].elapsedToPlannedRatio, (milliseconds / 60000) / minutes);
    }
    const item: PmItem = { id: "future", title: "Future", status: "open", estimated_minutes: minutes, assignee: "worker" };
    const controls = { ...sampling, from: index % 5 ? sampling.from : "9999-12-31", estimates: { future: { kind: "empirical" as const, values: [minutes, minutes] } } };
    for (const numerical of [completionIntervals([item], controls), simulateCompletionIntervals([item], controls), resourceScenarios([item], resources), computeResourceScenarios([item], resources), proposeDeadlineRepairs([item], { from: controls.from, deadline: index % 5 ? "2026-01-03" : "9999-12-31" })]) checked(numerical);
    if (index % 10 === 0) {
      writeFileSync(estimateFile, JSON.stringify({ extreme: { kind: "point", minutes } }));
      for (const [command, options] of [
        ["gantt calibrate", { type: "Task", "minimum-samples": "1" }],
        ["gantt uncertainty", { ...sampling, seed: "42", estimates: estimateFile }],
        ["gantt resources", { scenarios: scenarioFile }],
        ["gantt repair", { from: sampling.from, deadline: "2026-01-03" }],
      ] as const) checked((await harness.runCommand({ command, pmRoot, options })).result as { ok: false; code: string; remedy: string });
    }
    assert.deepEqual(await sdk.get("extreme", { full: true }), before);
    assert.equal(snapshot(join(pmRoot, "tasks")) + snapshot(join(pmRoot, "history")), hash);
  }
  assert.ok(accepted > 0 && refused > 0);
  t.diagnostic(`seed=${SEED}; cases=2000; calibration accepted=${accepted}; refused=${refused}; SDK routes=6; CLI routes=4; no durable writes`);
});
