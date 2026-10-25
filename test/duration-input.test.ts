import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { calibrateObservedDurations, completionIntervals, resourceScenarios, proposeDeadlineRepairs, type CompletionIntervalOptions, type DurationCalibrationOptions, type PmItem, type ResourceScenarioOptions } from "../index.ts";
import { runValidatedIntervals, simulateCompletionIntervals } from "../uncertainty.ts";
import { runValidatedResources, computeResourceScenarios } from "../resources.ts";
import * as validation from "../duration-input.ts";
import { validateDurationInput } from "../duration-input.ts";
import { assertTypedRefusal, packedTracker, snapshot } from "./tracker-fixture.ts";
import { calibrationTracker, seedHistory } from "./calibration-fixture.ts";
import { validDurationCases } from "./duration-input-corpus.ts";

const SEED = 179202610;
const count = 2000;
const options = { from: "2026-10-25", seed: 42, samples: 100 };
const item: PmItem = { id: "future", title: "Future", status: "open", estimated_minutes: 60, assignee: "worker" };
const calendar = { weekdays: [1, 2, 3, 4, 5], holidays: [], minutesPerDay: 480, minutesPerWeek: 2400, totalMinutes: 2400 };
const resources: ResourceScenarioOptions = { from: options.from, through: "2026-10-26", timeZone: "UTC", scenarios: [{ id: "base", owners: { worker: calendar } }] };

/** Deliberately malformed scalar values, each outside the shared minute schema. */
function badNumbers() { return [NaN, Infinity, -Infinity, -0, -1, 175201, Number.MAX_VALUE, "60", null, {}, [], { nested: [1] }]; }

/** Fresh malformed populations prevent accidental normalization or shared mutable fixtures. */
function badEstimates(index: number): unknown {
  const numeric = badNumbers()[index % badNumbers().length];
  const hole = new Array<unknown>(1 + index % 4);
  const inherited = new Array<unknown>(1); Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype) as object, { 0: 60 }));
  const accessor = [1]; Object.defineProperty(accessor, "0", { get() { assert.fail("untrusted array getter must not run"); } });
  const extra = [1]; Object.defineProperty(extra, "junk", { value: 1 });
  const cases: unknown[] = [
    { kind: "empirical", values: hole }, { kind: "empirical", values: [1, numeric] }, { kind: "empirical", values: inherited },
    { kind: "empirical", values: accessor }, { kind: "empirical", values: extra }, { kind: "empirical", values: [] },
    { kind: "empirical", values: new Array(2001).fill(1) }, { kind: "point", minutes: numeric },
    { kind: "uniform", min: 2, max: 1 }, { kind: "triangular", min: 1, mode: 3, max: 2 },
    { kind: "point", minutes: 1, junk: { nested: true } }, { kind: "empirical", values: [[1]] },
    new Array(2), null, "60", { kind: "unknown", values: [1] },
  ];
  return cases[index % cases.length];
}

/** Both public numerical entry points must fail closed, without getter calls or exceptions. */
function invalid(result: { ok: true } | { ok: false; code: string; remedy: string }) { assertTypedRefusal(result, "invalid_estimate"); }

test("review 179: sparse empirical arrays are refused at the boundary instead of throwing", () => {
  for (const values of [new Array<number>(1), Object.assign(new Array<number>(3), { 0: 1, 2: 2 }), Object.assign(new Array<number>(1), { extra: 1 })]) {
    const input = { ...options, estimates: { future: { kind: "empirical" as const, values: values as number[] } } };
    assert.doesNotThrow(() => invalid(completionIntervals([item], input)));
    assert.doesNotThrow(() => invalid(simulateCompletionIntervals([item], input)));
  }
});

test("valid generated scenarios preserve the frozen pre-refactor result digest", () => {
  const results = validDurationCases().map(({ items, options }) => completionIntervals(items, options));
  assert.ok(results.every((result) => result.ok));
  assert.equal(createHash("sha256").update(JSON.stringify(results)).digest("hex"), "2e450ce71178de3816724bc7bbd1013843d3413d5e06b133b55e206bf3d8b346");
});

test("2000 seeded malformed cases cover every forecast SDK boundary without writes or throws", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  const before = snapshot(pmRoot);
  let state = SEED;
  for (let index = 0; index < count; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const bad = badEstimates(state);
    const sample = { ...options, estimates: { future: bad } } as CompletionIntervalOptions;
    assert.doesNotThrow(() => invalid(completionIntervals([item], sample)));
    assert.doesNotThrow(() => invalid(simulateCompletionIntervals([item], sample)));
    invalid(runValidatedIntervals(sample));
    invalid(runValidatedResources(sample));
    const badItem = { ...item, estimated_minutes: badNumbers()[state % badNumbers().length] } as PmItem;
    assert.doesNotThrow(() => invalid(resourceScenarios([badItem], resources)));
    assert.doesNotThrow(() => invalid(computeResourceScenarios([badItem], resources)));
    assert.doesNotThrow(() => invalid(proposeDeadlineRepairs([badItem], { from: options.from, deadline: resources.through })));
    const invalidCalibration = [null, {}, { type: "Task", minimumSamples: -0 }, { type: "Task", minimumSamples: 1, quantiles: new Array(1) },
      { type: "Task", minimumSamples: 1, quantiles: [0.5, NaN] }, { type: "Task", minimumSamples: 1, tag: [] }, { type: "Task", minimumSamples: 1, extra: 1 }][state % 7];
    invalid(await calibrateObservedDurations(pmRoot, invalidCalibration as DurationCalibrationOptions));
    const controls: unknown[] = [{ ...options, from: "2026-02-30" }, { ...options, from: {} }, { ...options, samples: 10001 }, { ...options, seed: -0 },
      { ...options, quantiles: new Array(1) }, { ...options, quantiles: [0.5, 0.5] }, { ...options, estimates: [] }, { ...options, estimates: null },
      { ...options, extra: 1 }, { ...options, minutesPerDay: Infinity }];
    invalid(completionIntervals([item], controls[state % controls.length] as CompletionIntervalOptions));
  }
  assert.equal(snapshot(pmRoot), before);
  t.diagnostic(`seed=${SEED}; malformed cases=${count}; SDK routes=6; guarded internal adapters=2; no durable writes`);
});

test("2000 seeded CLI flags/files and stored native fields return typed refusals in a non-git tracker", async (t) => {
  const { root, pmRoot, sdk, bin, invoke } = await packedTracker(t, "duration-fuzz");
  const fixture = seedHistory(pmRoot, "future", [{}, { status: "in_progress" }, { status: "closed" }]);
  const toonPath = join(pmRoot, "tasks", "future.toon"), jsonPath = join(pmRoot, "tasks", "future.md");
  const original = readFileSync(toonPath);
  const native = serializeItemDocument(fixture.document, { format: "json_markdown" });
  const file = join(root, "inputs.json");
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  const path = process.env.PATH; process.env.PATH = bin;
  t.after(() => { process.env.PATH = path; });
  let state = SEED;
  const routes = new Array<number>(6).fill(0);
  const trackerBefore = snapshot(pmRoot);
  /** Hash just authoritative tracker documents at each operation, not installed package copies. */
  const stateHash = () => snapshot(join(pmRoot, "tasks")) + snapshot(join(pmRoot, "history")) + readFileSync(join(pmRoot, "settings.json"), "utf8");
  for (let index = 0; index < count; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const route = index % 6;
    const pick = state >>> 10;
    let command = "gantt uncertainty";
    let flags: Record<string, unknown> = { from: options.from, seed: "42", samples: "100" };
    if (route === 0) {
      // JSON transport turns holes/nonfinite numbers into null; all remain invalid.
      const safeBad = [{ kind: "empirical", values: [null] }, { kind: "point", minutes: "60" }, { kind: "point", minutes: 60, extra: 1 },
        { kind: "empirical", values: new Array(2001).fill(1) }, { kind: "uniform", min: 2, max: 1 }][pick % 5];
      writeFileSync(file, pick % 2 ? JSON.stringify({ future: safeBad }) : '{"future":{"kind":"point","minutes":-0}}');
      flags.estimates = file;
    } else if (route === 1) {
      Object.assign(flags, [{ samples: "-0" }, { seed: "Infinity" }, { from: "2026-02-30" }, { quantiles: "0.1,,0.9" }, { "minutes-per-day": "1e300" }][pick % 5]);
    } else if (route === 2) {
      command = "gantt calibrate";
      flags = [{ type: "Task", "minimum-samples": "-0" }, { type: "Task", "minimum-samples": "Infinity" }, { type: "Task", "minimum-samples": "1", tag: "" }][pick % 3];
    } else if (route === 3) {
      command = "gantt resources";
      const bad = { ...resources, scenarios: [{ id: "base", owners: { worker: { ...calendar, holidays: ["2026-02-30"] } } }] };
      writeFileSync(file, JSON.stringify(bad)); flags = { scenarios: file };
    } else if (route === 4) {
      unlinkSync(toonPath);
      const wire = ['"NaN"', '"Infinity"', '"-Infinity"', '-0', '-1', '175201', '1e300', 'null', '[]', '{"nested":1}'][pick % 10];
      writeFileSync(jsonPath, native.replace('"estimated_minutes": 60', '"estimated_minutes": ' + wire));
      // Inspect precisely the actual SDK result; no hand-written field normalization.
      const corpus = (await sdk.listAllComplete()).items as PmItem[];
      invalid(completionIntervals(corpus, options));
      invalid(await calibrateObservedDurations(pmRoot, { type: "Task", minimumSamples: 1 }));
    } else {
      command = "gantt repair"; flags = { from: options.from, deadline: resources.through, "max-changes": ["NaN", "-0", "Infinity", "10000000"][pick % 4] };
    }
    const before = stateHash();
    const result = await harness.runCommand({ command, pmRoot, options: flags });
    invalid(result.result as { ok: false; code: string; remedy: string });
    assert.equal(result.exitCode, 2);
    assert.equal(stateHash(), before, `${route}/${index}: command changed durable state`);
    if (route === 4) { unlinkSync(jsonPath); writeFileSync(toonPath, original); }
    routes[route]++;
  }
  assert.equal(snapshot(pmRoot), trackerBefore);
  const packed = invoke(["gantt", "uncertainty", "--from", options.from, "--seed", "-0", "--json"]);
  assert.equal(packed.status, 2); assert.match(packed.stdout + packed.stderr, /invalid_estimate/);
  t.diagnostic(`seed=${SEED}; transport/native cases=${count}; routes=${routes.join(",")}`);
});

test("strict schema rejects hostile objects, inherited fields, extra keys and invalid nested controls", () => {
  for (const input of [null, [], Object.create({ type: "Task", minimumSamples: 1 }), { type: "Task", minimumSamples: 1, [Symbol("extra")]: true },
    Object.defineProperty({}, "type", { get() { assert.fail("getter ran"); } }), new Proxy({}, { ownKeys() { throw new Error("hostile"); } })]) {
    invalid(validateDurationInput("calibration", input));
  }
  for (const raw of [{ ...resources, scenarios: new Array(1) }, { ...resources, scenarios: [{ id: "base", owners: { worker: { ...calendar, weekdays: Object.assign(new Array<number>(3), { 0: 1, 2: 3 }) } } }] },
    { ...resources, scenarios: [{ id: "base", owners: { worker: { ...calendar, extra: true } } }] }]) invalid(resourceScenarios([item], raw as ResourceScenarioOptions));
  const data = validateDurationInput("sampling", { corpus: [item], options: { ...options, estimates: { future: { kind: "empirical", values: [3, 1, 3] } } } });
  assert.ok(data.ok);
  assert.deepEqual(data.value.options.estimates!.future, { kind: "empirical", values: [1, 3, 3] });
});


test("historical native fields use the same strict schema and typed refusal", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  for (const closed_at of ["bad", "2026-02-30T00:00:00.000Z", "2026-01-01T25:00:00.000Z", "2026-01-01T00:00:00.000+24:00"]) {
    seedHistory(pmRoot, "future", [{}, { status: "in_progress" }, { status: "closed", closed_at }]);
    invalid(await calibrateObservedDurations(pmRoot, { type: "Task", minimumSamples: 1 }));
  }
});

test("validation receipts are immutable and unforgeable, and missing SDK sources refuse cleanly", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  const receipt = validateDurationInput("sampling", { corpus: [item], options: { ...options, estimates: { future: { kind: "empirical", values: [1, 2] } } } });
  assert.ok(receipt.ok);
  assert.throws(() => { receipt.value.options.seed = -1; }, TypeError);
  const { durationValidatedValue, durationFlagNumber, durationFlagQuantiles } = validation;
  invalid(durationValidatedValue("repair", receipt));
  assert.equal(durationFlagNumber("2"), 2);
  assert.ok(Number.isNaN(durationFlagNumber("1".repeat(129))));
  assert.deepEqual(durationFlagQuantiles([0, 1]), [0, 1]);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const command of ["gantt uncertainty", "gantt resources", "gantt repair"]) {
    const run = await harness.runCommand({ command, pmRoot: join(pmRoot, "absent"), options: { from: options.from, seed: "42", scenarios: join(pmRoot, "absent.json") } });
    invalid(run.result as { ok: false; code: string; remedy: string });
  }
  const result = await calibrateObservedDurations(123 as unknown as string, { type: "Task", minimumSamples: 1 });
  assert.equal(result.ok, false);
});

test("malformed supplied graph arrays cannot bypass the shared sampling boundary", () => {
  for (const graph of [null, {}, new Map([["future", new Array(1)]]), new Map([["future", [NaN]]]), new Map([["future", null]]), new Map([["future", new Array(10001).fill("future")]]), new Map([[42, []]])]) {
    invalid(completionIntervals([item], options, graph as Map<string, string[]>));
    invalid(resourceScenarios([item], resources, graph as Map<string, string[]>));
    invalid(proposeDeadlineRepairs([item], { from: options.from, deadline: resources.through }, graph as Map<string, string[]>));
  }
  invalid(runValidatedIntervals(validateDurationInput("sampling", { corpus: [item], options }), new Map([["future", new Array(1)]])));
  invalid(runValidatedResources(validateDurationInput("resources", { corpus: [item], options: resources }), new Map([["future", new Array(1)]])));
});

test("graph boundary rejects extra properties and excessive maps before traversing entries", () => {
  invalid(validateDurationInput("graph", Object.assign(new Map(), { extra: 1 })));
  invalid(validateDurationInput("graph", new Map(Array.from({ length: 100001 }, (_, index) => [String(index), []]))));
});
