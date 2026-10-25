import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import * as sdkConcurrency from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { getHistoryPath, getItemPath, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { calibrateObservedDurations, completionIntervals, type DurationCalibrationOptions, type DurationCalibrationResult, type DurationExclusion, type UncertainEstimate } from "../index.ts";
import { assertTypedRefusal, packedTracker, snapshot } from "./tracker-fixture.ts";
import { calibrationTracker, seedHistory } from "./calibration-fixture.ts";

const controls: DurationCalibrationOptions = { type: "Task", minimumSamples: 1 };

/** Require success without hiding a typed refusal in assertion diagnostics. */
function success(result: DurationCalibrationResult) {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test("calibration compares start estimates with verified elapsed episodes and refuses below the floor", async (t) => {
  const { pmRoot, sdk } = await calibrationTracker(t);
  seedHistory(pmRoot, "calibration-b", [{}, { status: "in_progress", estimated_minutes: 120 }, { status: "closed", estimated_minutes: 999 }]);
  seedHistory(pmRoot, "calibration-a", [{}, { status: "in_progress", estimated_minutes: 60 }, { status: "blocked" }, { status: "closed" }]);
  seedHistory(pmRoot, "calibration-other", [{ type: "Issue" }]);
  const baseline = await sdk.get("calibration-a", { full: true });
  const before = snapshot(pmRoot);
  const result = success(await calibrateObservedDurations(pmRoot, { ...controls, minimumSamples: 2, quantiles: [0, 0.5, 1], limit: 1 }));
  assert.equal(result.evidence.selectedCount, 2);
  assert.equal(result.evidence.sampleCount, 2);
  assert.equal(result.evidence.rows.length, 1);
  assert.equal(result.evidence.truncated, true);
  assert.deepEqual(result.distribution, { kind: "empirical", values: [1440, 2880] });
  assert.deepEqual(result.quantiles, [
    { probability: 0, elapsedMinutes: 1440, plannedMinutes: 60, elapsedToPlannedRatio: 12 },
    { probability: 0.5, elapsedMinutes: 1440, plannedMinutes: 60, elapsedToPlannedRatio: 12 },
    { probability: 1, elapsedMinutes: 2880, plannedMinutes: 120, elapsedToPlannedRatio: 48 },
  ]);
  assert.deepEqual(await calibrateObservedDurations(pmRoot, { ...controls, minimumSamples: 2, quantiles: [0, 0.5, 1], limit: 1 }), result);
  const refused = await calibrateObservedDurations(pmRoot, { ...controls, minimumSamples: 3 });
  assertTypedRefusal(refused, "insufficient_samples");
  assert.ok(!refused.ok && refused.evidence?.sampleCount === 2);
  assert.equal(snapshot(pmRoot), before);
  assert.deepEqual(await sdk.get("calibration-a", { full: true }), baseline);
});

test("calibration discloses conservative exclusions, imports and corrupt foreign history", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  const fixtures: [string, Partial<ItemMetadata>[], DurationExclusion][] = [
    ["canceled", [{}, { status: "in_progress" }, { status: "canceled" }], "canceled"],
    ["reopened", [{}, { status: "in_progress" }, { status: "closed" }, { status: "open" }, { status: "closed" }], "reopened"],
    ["incomplete", [{}, { status: "in_progress" }], "incomplete"],
    ["missing", [{}, { status: "closed" }], "missing_start"],
    ["estimate", [{}, { status: "in_progress", estimated_minutes: 0 }, { status: "closed" }], "missing_estimate"],
    ["changed", [{}, { status: "in_progress", type: "Issue" }, { status: "closed", type: "Task" }], "class_changed"],
    ["negative", [{}, { status: "in_progress" }, { status: "closed", completed_at: "2026-01-01T00:00:00.000Z" }], "invalid_duration"],
    ["imported", [{}, { status: "in_progress" }, { status: "closed" }], "missing_start"],
  ];
  for (const [id, changes] of fixtures) seedHistory(pmRoot, `calibration-${id}`, changes, id === "imported" ? { ops: ["import", "import", "import"] } : {});
  seedHistory(pmRoot, "calibration-good", [{}, { status: "in_progress" }, { status: "closed", closed_at: "2026-01-02T12:00:00.000Z" }]);
  const bad = seedHistory(pmRoot, "calibration-bad", [{}, { status: "in_progress" }, { status: "closed" }]);
  bad.entries[1].after_hash = "0".repeat(64);
  writeFileSync(getHistoryPath(pmRoot, "calibration-bad"), bad.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  seedHistory(pmRoot, "calibration-absent", [{}]);
  unlinkSync(getHistoryPath(pmRoot, "calibration-absent"));
  const result = success(await calibrateObservedDurations(pmRoot, controls));
  assert.equal(result.evidence.sampleCount, 1);
  for (const [id, , reason] of fixtures) assert.equal(result.evidence.rows.find((row) => row.id === `calibration-${id}`)?.reason, reason);
  assert.equal(result.evidence.excluded.unverified_history, 2);
  assert.equal(result.evidence.excluded.missing_start, 2);
  assert.deepEqual(result.distribution.values, [720]);
});

test("calibration validates runtime controls and unreadable trackers with typed remedies", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  for (const patch of [
    { type: "" }, { type: " " }, { type: "x".repeat(129) }, { tag: "" }, { tag: "x".repeat(129) },
    { minimumSamples: 0 }, { minimumSamples: 2001 }, { minimumSamples: 1.5 }, { minimumSamples: NaN },
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { quantiles: [] }, { quantiles: Array(10).fill(0.5) as number[] },
    { quantiles: [-1] }, { quantiles: [2] }, { quantiles: [NaN] }, { quantiles: [0.5, 0.5] },
  ]) assertTypedRefusal(await calibrateObservedDurations(pmRoot, { ...controls, ...patch }), "invalid_estimate");
  assertTypedRefusal(await calibrateObservedDurations(join(pmRoot, "absent"), controls), "corpus_unavailable");
  const result = await calibrateObservedDurations(pmRoot, { ...controls, tag: "selected" });
  assertTypedRefusal(result, "insufficient_samples");
  assert.ok(!result.ok && result.evidence?.selectedCount === 0);
});

test("empirical scenario adoption samples the population reproducibly and validates its bounds", () => {
  const item = { id: "future", title: "future", status: "open" as const };
  const options = { from: "2026-10-25", seed: 42, samples: 10000, minutesPerDay: 1440 };
  const estimate: UncertainEstimate = { kind: "empirical", values: [2880, 1440, 4320] };
  const result = completionIntervals([item], { ...options, estimates: { future: estimate } });
  assert.ok(result.ok);
  assert.deepEqual(result.project!.map((q) => q.days), [1, 2, 3]);
  assert.deepEqual(completionIntervals([item], { ...options, estimates: { future: { kind: "empirical", values: [4320, 2880, 1440] } } }), result);
  const fixed = completionIntervals([item], { ...options, estimates: { future: { kind: "empirical", values: [0] } } });
  assert.ok(fixed.ok);
  assert.equal(fixed.project![1].days, 0);
  assert.deepEqual(fixed.sensitivity, []);
  for (const values of [[], [-1], [NaN], [Infinity], [175201], Array(2001).fill(1) as number[]]) {
    assertTypedRefusal(completionIntervals([item], { ...options, estimates: { future: { kind: "empirical", values } } }), "invalid_estimate");
  }
});

test("calibration packed command emits compact TOON/JSON and typed refusals without git", async (t) => {
  const { pmRoot, invoke } = await packedTracker(t, "calibration");
  seedHistory(pmRoot, "calibration-packed", [{}, { status: "in_progress", tags: ["selected"] }, { status: "closed", tags: ["selected"] }]);
  const before = snapshot(pmRoot);
  const args = ["gantt", "calibrate", "--type", "Task", "--minimum-samples", "1", "--tag", "selected"];
  const json = invoke([...args, "--json"]);
  assert.equal(json.status, 0, json.stderr + json.stdout);
  const result = JSON.parse(json.stdout) as DurationCalibrationResult;
  assert.equal(success(result).evidence.sampleCount, 1);
  assert.ok(Buffer.byteLength(json.stdout) < 5000);
  const toon = invoke(args);
  assert.equal(toon.status, 0, toon.stderr);
  assert.match(toon.stdout, /sampleCount: 1/);
  const refused = invoke(["gantt", "calibrate", "--json"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stdout + refused.stderr, /invalid_calibration/);
  assert.equal(snapshot(pmRoot), before);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  const bounded = await harness.runCommand({ command: "gantt calibrate", pmRoot, options: { type: "Task", minimumSamples: "1", limit: "1" } });
  assert.equal(success(bounded.result as DurationCalibrationResult).evidence.sampleCount, 1);
  const defaults = await harness.runCommand({ command: "gantt calibrate", pmRoot, options: { type: "Task", "minimum-samples": "1" } });
  assert.equal(success(defaults.result as DurationCalibrationResult).evidence.sampleCount, 1);
  const invalid = await harness.runCommand({ command: "gantt calibrate", pmRoot });
  assert.equal(invalid.exitCode, 2);
  assertTypedRefusal(invalid.result as DurationCalibrationResult, "invalid_estimate");
});

test("500 seeded model operation sequences preserve SDK state, old-input replays, CRLF and relationships", async (t) => {
  const { pmRoot, sdk, root } = await calibrationTracker(t);
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; });
  let random = 20261025;
  /** Deterministic integer stream for independent operation and value choices. */
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  seedHistory(pmRoot, "calibration-anchor", [{ type: "Issue" }]);
  const expected: number[] = [];
  const counts = { reopened: 0, canceled: 0, incomplete: 0, missing_start: 0, missing_estimate: 0, class_changed: 0, invalid_duration: 0 };
  const baselines = new Map<string, unknown>();
  let operations = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const choice = (next() >>> 16) % 8;
    const estimate = 1 + next() % 600;
    const waits = next() % 4;
    const start: Partial<ItemMetadata> = { status: "in_progress", estimated_minutes: choice === 5 ? 0 : estimate, type: choice === 6 ? "Issue" : "Task" };
    const initial: Partial<ItemMetadata> = { status: "open", tags: ["model"], dependencies: [{ id: "calibration-anchor", kind: "related" }], deadline: "2026-12-31", sprint: "S1", release: "R1" };
    const changes: Partial<ItemMetadata>[] = [initial];
    if (choice !== 4) changes.push(start);
    for (let wait = 0; wait < waits; wait++) changes.push({ status: "blocked", estimated_minutes: next() % 900 });
    if (choice === 1) { changes.push({ status: "canceled", type: "Task" }); counts.canceled++; }
    else if (choice === 2) { changes.push({ status: "blocked", type: "Task" }); counts.incomplete++; }
    else {
      changes.push({ status: "closed", type: "Task", ...(choice === 7 ? { completed_at: "2026-01-01T00:00:00.000Z" } : {}) });
      if (choice === 3) {
        // Replay an older open input and complete again; prior completion is excluded too.
        changes.push(initial, start, { status: "closed", type: "Task" }); counts.reopened++;
      } else if (choice === 4) counts.missing_start++;
      else if (choice === 5) counts.missing_estimate++;
      else if (choice === 6) counts.class_changed++;
      else if (choice === 7) counts.invalid_duration++;
      else expected.push((1 + waits) * 1440);
    }
    operations += changes.length;
    const id = `calibration-model-${sequence}`;
    const fixture = seedHistory(pmRoot, id, changes, { body: sequence % 2 === 0 ? "  spaced input\r\nsecond line\r\n" : "plain\n" });
    const current = await sdk.get(id, { full: true });
    // Read state through the SDK, comparing core fields with the independent operation model.
    assert.equal(current.item.status, changes.at(-1)!.status);
    assert.equal(current.item.type, "Task");
    assert.deepEqual(current.item.dependencies, fixture.document.metadata.dependencies);
    assert.equal(current.item.estimated_minutes, fixture.document.metadata.estimated_minutes);
    baselines.set(id, current.item);
  }
  const before = snapshot(pmRoot);
  const result = success(await calibrateObservedDurations(pmRoot, { type: "Task", tag: "model", minimumSamples: 10 }));
  assert.equal(result.evidence.selectedCount, 500);
  assert.equal(result.evidence.sampleCount, expected.length);
  assert.deepEqual(result.distribution.values, expected.sort((a, b) => a - b));
  for (const [key, count] of Object.entries(counts)) assert.equal(result.evidence.excluded[key as keyof typeof counts], count);
  for (const [id, baseline] of baselines) assert.deepEqual((await sdk.get(id, { full: true })).item, baseline, id);
  assert.equal(snapshot(pmRoot), before);
  assert.deepEqual(await calibrateObservedDurations(pmRoot, { type: "Task", tag: "model", minimumSamples: 10 }), result);
  t.diagnostic(`seed=20261025; sequences=500; operations=${operations}; samples=${expected.length}`);
});

test("calibration bounds cohorts and replay work before producing numerical claims", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  for (let index = 0; index < 2001; index++) seedHistory(pmRoot, `calibration-bound-${index}`, [{}]);
  assertTypedRefusal(await calibrateObservedDurations(pmRoot, controls), "calibration_too_large");
  for (let index = 1; index < 2001; index++) {
    unlinkSync(getItemPath(pmRoot, "Task", `calibration-bound-${index}`, "toon"));
    unlinkSync(getHistoryPath(pmRoot, `calibration-bound-${index}`));
  }
  const fixture = seedHistory(pmRoot, "calibration-bound-0", [{}]);
  const line = JSON.stringify(fixture.entries[0]) + "\n";
  writeFileSync(getHistoryPath(pmRoot, "calibration-bound-0"), line.repeat(10001));
  assertTypedRefusal(await calibrateObservedDurations(pmRoot, controls), "calibration_too_large");
  for (let index = 0; index < 11; index++) {
    seedHistory(pmRoot, `calibration-bound-${index}`, [{}]);
    writeFileSync(getHistoryPath(pmRoot, `calibration-bound-${index}`), line.repeat(10000));
  }
  assertTypedRefusal(await calibrateObservedDurations(pmRoot, controls), "calibration_too_large");
});

test("foreign malformed, drifting, nonmonotonic and checkpoint histories stay excluded", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  seedHistory(pmRoot, "calibration-good", [{}, { status: "in_progress" }, { status: "closed" }]);
  seedHistory(pmRoot, "calibration-malformed", [{}]);
  writeFileSync(getHistoryPath(pmRoot, "calibration-malformed"), "foreign non-JSON record\n");
  const drift = seedHistory(pmRoot, "calibration-drift", [{}]);
  writeFileSync(getItemPath(pmRoot, "Task", "calibration-drift", "toon"), readFileSync(getItemPath(pmRoot, "Task", "calibration-drift", "toon"), "utf8").replace('Seeded lifecycle', 'Unrecorded edit'));
  assert.equal(drift.document.metadata.description, "Seeded lifecycle");
  seedHistory(pmRoot, "calibration-time", [{}, { status: "in_progress" }, { status: "closed" }], { times: ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"] });
  seedHistory(pmRoot, "calibration-checkpoint", [{ status: "in_progress" }, { status: "closed" }], { ops: ["checkpoint", "update"] });
  const result = success(await calibrateObservedDurations(pmRoot, controls));
  assert.equal(result.evidence.sampleCount, 1);
  assert.equal(result.evidence.excluded.unverified_history, 3);
  assert.equal(result.evidence.excluded.missing_start, 1);
});

test("every SDK read boundary preserves a competing writer and rejects mixed revisions", async (t) => {
  const { appendHistoryEntry, createHistoryEntry, setActiveExtensionHooks, resetActiveExtensionRuntimeState } = sdkConcurrency;
  const { pmRoot, sdk } = await calibrationTracker(t);
  let target = -1, step = 0, fired = false;
  const busy = new Set<string>();
  let mode: "item" | "history" | "corpus" = "item";
  seedHistory(pmRoot, "calibration-other-peer", [{ type: "Issue" }]);
  const paths: string[] = [];
  let current = seedHistory(pmRoot, "calibration-peer", [{}, { status: "in_progress" }, { status: "closed" }]);
  const hook = await createExtensionTestHarness({ name: "calibration-peer-observer", activate(api: ExtensionApi) {
    api.hooks.onRead(async (context) => {
      if (busy.has("peer")) return;
      step++;
      if (target === -1) paths.push(context.path);
      if (step !== target) return;
      fired = true; busy.add("peer");
      try {
        if (mode === "item" || mode === "corpus") await sdk.update(mode === "item" ? "calibration-peer" : "calibration-other-peer", { estimatedMinutes: "777" });
        else await appendHistoryEntry(getHistoryPath(pmRoot, "calibration-peer"), createHistoryEntry({ nowIso: "2026-01-04T00:00:00.000Z", author: "peer", op: "update", before: current.document, after: current.document }));
      } finally { busy.delete("peer"); }
    });
  } }, { capabilities: ["hooks"] });
  setActiveExtensionHooks(hook.activation.hooks);
  t.after(() => resetActiveExtensionRuntimeState());
  success(await calibrateObservedDurations(pmRoot, controls));
  const boundaries = step;
  assert.ok(boundaries >= 4, `observe actual SDK reads: ${boundaries}`);
  let refused = 0, historyRefusals = 0;
  for (mode of ["item", "history"] as const) {
    for (target = 1; target <= boundaries; target++) {
      resetActiveExtensionRuntimeState();
      current = seedHistory(pmRoot, "calibration-peer", [{}, { status: "in_progress" }, { status: "closed" }]);
      step = 0; fired = false;
      setActiveExtensionHooks(hook.activation.hooks);
      const result = await calibrateObservedDurations(pmRoot, controls);
      resetActiveExtensionRuntimeState();
      assert.equal(fired, true, `${mode} boundary ${target}`);
      if (result.ok) assert.deepEqual(result.distribution.values, [1440]);
      else { assertTypedRefusal(result, "tracker_changed"); refused++; if (mode === "history") historyRefusals++; }
      if (mode === "item") assert.equal((await sdk.get("calibration-peer")).item.estimated_minutes, 777);
      else assert.match(readFileSync(getHistoryPath(pmRoot, "calibration-peer"), "utf8"), /"author":"peer"/);
    }
  }
  assert.ok(refused > 0 && historyRefusals > 0);
  target = paths.indexOf(getHistoryPath(pmRoot, "calibration-peer")) + 1;
  assert.ok(target > 0);
  step = 0; fired = false; mode = "corpus";
  setActiveExtensionHooks(hook.activation.hooks);
  const foreignChange = await calibrateObservedDurations(pmRoot, controls);
  resetActiveExtensionRuntimeState();
  assert.equal(fired, true);
  assertTypedRefusal(foreignChange, "tracker_changed");
  assert.equal((await sdk.get("calibration-other-peer")).item.estimated_minutes, 777);
  t.diagnostic(`interleavings=${boundaries * 2}; boundaries=${boundaries}; mixed-revision refusals=${refused}; history-only refusals=${historyRefusals}`);
});

test("unreplayable SDK legacy history is excluded without repairing the foreign record", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  seedHistory(pmRoot, "calibration-good", [{}, { status: "in_progress" }, { status: "closed" }]);
  const fixture = seedHistory(pmRoot, "calibration-patch", [{}, { status: "in_progress" }, { status: "closed" }]);
  const entry = fixture.entries[1];
  entry.patch = [{ op: "replace", path: "/metadata/absent/child", value: "invalid" }];
  delete entry.record_hash;
  delete entry.record_hash_version;
  writeFileSync(getHistoryPath(pmRoot, "calibration-patch"), fixture.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const before = snapshot(pmRoot);
  const result = success(await calibrateObservedDurations(pmRoot, controls));
  assert.equal(result.evidence.excluded.unverified_history, 1);
  assert.equal(result.evidence.sampleCount, 1);
  assert.equal(snapshot(pmRoot), before);
});

test("native SDK startTask and closeTask produce calibratable evidence without git", async (t) => {
  const { sdk, pmRoot } = await calibrationTracker(t);
  await sdk.create({ id: "calibration-native", title: "Native lifecycle", description: "Public synthetic fixture", type: "Task", estimatedMinutes: "60", createMode: "progressive" });
  await sdk.startTask("calibration-native");
  await sdk.closeTask("calibration-native", "Synthetic fixture completed");
  const result = success(await calibrateObservedDurations(pmRoot, controls));
  assert.equal(result.evidence.sampleCount, 1);
  assert.equal(result.evidence.rows[0].plannedMinutes, 60);
  assert.ok(result.distribution.values[0] >= 0 && result.distribution.values[0] < 60);
});


test("a foreign writer corrupting the item after history capture is refused without repair", async (t) => {
  const { pmRoot } = await calibrationTracker(t);
  seedHistory(pmRoot, "calibration-foreign", [{}, { status: "in_progress" }, { status: "closed" }]);
  const itemPath = getItemPath(pmRoot, "Task", "calibration-foreign", "toon");
  let fired = false;
  const hook = await createExtensionTestHarness({ name: "foreign-writer", activate(api: ExtensionApi) {
    api.hooks.onRead((context) => {
      if (!fired && context.path === getHistoryPath(pmRoot, "calibration-foreign")) {
        fired = true;
        writeFileSync(itemPath, "foreign unsupported content");
      }
    });
  } }, { capabilities: ["hooks"] });
  sdkConcurrency.setActiveExtensionHooks(hook.activation.hooks);
  t.after(() => sdkConcurrency.resetActiveExtensionRuntimeState());
  const result = await calibrateObservedDurations(pmRoot, controls);
  assert.equal(fired, true);
  assertTypedRefusal(result, "invalid_estimate");
  assert.equal(readFileSync(itemPath, "utf8"), "foreign unsupported content");
});
