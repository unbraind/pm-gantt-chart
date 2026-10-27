import assert from "node:assert/strict";
import fs, { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon, encodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { captureScheduleScenario, explainScheduleDrift, resourceScenarios, completionIntervals, type ResourceScenarioOptions, type ScheduleDriftResult } from "../index.ts";
import { ownDurationValue, SCHEDULE_FILE_MAX_BYTES, SCHEDULE_SNAPSHOT_MAX_BYTES, validateDurationInput, validateDurationOutput } from "../duration-input.ts";
import { readScheduleFile } from "../schedule-files.ts";
import { assertTypedRefusal, packedTracker, snapshot } from "./tracker-fixture.ts";
import { wideScheduleCorpus, wideScheduleSnapshot } from "./schedule-adversaries.ts";

const baseSchema = (await readSettings(join(import.meta.dirname, "..", ".agents", "pm"))).schema;
const registry = resolveRuntimeStatusRegistry(baseSchema);
const calendar = wideScheduleSnapshot().owners.worker;
const options: ResourceScenarioOptions = { from: "2026-10-19", through: "2026-10-30", timeZone: "UTC", scenarios: [{ id: "saved", owners: { worker: calendar } }] };
const names = Object.getOwnPropertyNames(Object.prototype);

/** Require an intact producer artifact and return only its typed snapshot. */
function capture() {
  const result = captureScheduleScenario(wideScheduleCorpus(), options, registry);
  assert.ok(result.ok, JSON.stringify(result)); return result.snapshot;
}

test("producer closure: 500 adversarial JSON and TOON transports preserve complete SDK snapshots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-wire-properties-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const large = capture(), corpus = wideScheduleCorpus();
  assert.equal(large.tasks.length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 262144);
  let state = 190202610;
  for (let sequence = 0; sequence < 500; sequence++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const inputs = sequence === 0 ? corpus : corpus.slice(0, 1 + state % 25);
    const controls = { ...options, scenarios: [{ ...options.scenarios[0], owners: Object.fromEntries([[names[state % names.length], calendar], ["worker", calendar]]) }] };
    const produced = captureScheduleScenario(inputs, controls, registry); assert.ok(produced.ok);
    assert.ok(validateDurationOutput("snapshot", produced).ok);
    const source = produced.snapshot;
    const variants = [JSON.stringify(source), JSON.stringify({ ok: true, snapshot: source }, null, 2), JSON.stringify({ ok: true, snapshot: source }, null, 4).replaceAll("\n", "\r\n")];
    for (const serialized of variants) {
      assert.ok(Buffer.byteLength(serialized) <= SCHEDULE_FILE_MAX_BYTES);
      const file = join(root, "snapshot.json"); writeFileSync(file, ` \r\n${serialized}\r\n`);
      const loaded = readScheduleFile(file, "snapshot"); assert.ok(loaded.ok);
      const value = loaded.value as { snapshot?: unknown };
      const decoded = validateDurationInput("snapshot", Object.hasOwn(value, "snapshot") ? value.snapshot : value); assert.ok(decoded.ok);
      assert.deepEqual(decoded.value, source);
    }
    const decoded = validateDurationInput("snapshot", decodeToon(encodeToon(source))); assert.ok(decoded.ok);
    assert.deepEqual(decoded.value, source);
  }
  const oversized = { ...large, tasks: large.tasks.map((task) => ({ ...task, id: `${task.id.slice(0, 10)}${"\u0001".repeat(118)}`,
    status: `x${"\u0001".repeat(127)}`, owner: `x${"\u0001".repeat(127)}` })) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized, null, 2)) > SCHEDULE_SNAPSHOT_MAX_BYTES);
  assertTypedRefusal(validateDurationInput("snapshot", oversized), "invalid_estimate");
  assertTypedRefusal(validateDurationOutput("snapshot", { ok: true as const, snapshot: oversized }), "invalid_estimate");
});

test("all file readers enforce bounds on open descriptors even when input grows after stat", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-bounded-files-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "input.json");
  for (const [kind, limit] of [["controls", 262144], ["estimates", 65536], ["snapshot", SCHEDULE_FILE_MAX_BYTES]] as const) {
    for (const raw of [undefined, "", root, join(root, "absent")]) assertTypedRefusal(readScheduleFile(raw, kind), "invalid_estimate");
    writeFileSync(file, Buffer.from([0xc0, 0xaf])); assertTypedRefusal(readScheduleFile(file, kind), "invalid_estimate");
    writeFileSync(file, "{broken"); assertTypedRefusal(readScheduleFile(file, kind), "invalid_estimate");
    writeFileSync(file, `${" ".repeat(limit - 2)}{}`); assert.ok(readScheduleFile(file, kind).ok);
    appendFileSync(file, " "); assertTypedRefusal(readScheduleFile(file, kind), "invalid_estimate");
    writeFileSync(file, "{}");
    const original = Object.getOwnPropertyDescriptor(fs, "fstatSync")!, stat = fs.fstatSync;
    Object.defineProperty(fs, "fstatSync", { ...original, value(fd: number) {
      const before = stat(fd); appendFileSync(file, " ".repeat(limit)); return before;
    } }); syncBuiltinESMExports();
    try { assertTypedRefusal(readScheduleFile(file, kind), "invalid_estimate"); }
    finally { Object.defineProperty(fs, "fstatSync", original); syncBuiltinESMExports(); }
  }
});

test("own-entry semantics cover all prototype names, calendar reversals, work and schema dispatch", () => {
  const descriptors = ["owner", "minutes"].map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const);
  try {
    Object.defineProperties(Object.prototype, { owner: { value: "phantom", writable: true, configurable: true }, minutes: { value: 777, writable: true, configurable: true } });
    for (let sequence = 0; sequence < 500; sequence++) {
      const name = names[sequence % names.length], base = wideScheduleSnapshot();
      const before = { ...base, tasks: base.tasks.slice(0, 1) };
      const after = { ...before, owners: Object.fromEntries([["worker", calendar], [name, calendar]]) };
      for (const [left, right] of [[before, after], [after, before]]) {
        const result = explainScheduleDrift(left, right); assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.gaps.length, 0);
        assert.equal(result.changes.length, 1); assert.equal(result.changes[0].target, name);
        assert.equal(result.changes[0].before === null || result.changes[0].after === null, true);
      }
      const item = { id: name, title: name, status: "open" as const, assignee: name, estimated_minutes: 480 };
      const control = { ...options, scenarios: [{ id: "saved", owners: Object.fromEntries([[name, calendar]]), work: {} }] };
      const producer = captureScheduleScenario([item], control, registry); assert.ok(producer.ok); assert.equal(producer.snapshot.tasks[0].owner, name);
      const computed = resourceScenarios([item], control); assert.ok(computed.ok); assert.equal(computed.scenarios[0].items[0].minutes, 480);
      const sampled = completionIntervals([item], { from: options.from, seed: 42, samples: 100, estimates: {} }); assert.ok(sampled.ok);
      if (sequence < names.length) {
        const owned = { ...before, tasks: [{ ...before.tasks[0], owner: name }], owners: Object.fromEntries([[name, calendar]]) };
        const reduced = { ...owned, owners: Object.fromEntries([[name, { ...calendar, minutesPerDay: 240 }]]) };
        const changed = explainScheduleDrift(owned, reduced); assert.ok(changed.ok); assert.equal(changed.gaps.length, 0);
        assert.equal(changed.moved[0].deltaDays, 1); assert.equal(changed.moved[0].causes[0].effectDays, 1);
        const override = { ...control, scenarios: [{ ...control.scenarios[0], work: Object.fromEntries([[name, { owner: name, minutes: 960 }]]) }] };
        const produced = captureScheduleScenario([item], override, registry); assert.ok(produced.ok); assert.equal(produced.snapshot.tasks[0].minutes, 960);
      }
      assert.equal(ownDurationValue({}, name), undefined);
      assert.equal(validateDurationInput(name as "snapshot", before).ok, false);
      assert.equal(validateDurationOutput(name as "snapshot", { ok: true as const, snapshot: before }).ok, false);
    }
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, key); else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
});

test("non-git CLI replays complete producer envelopes and applies all shared reader bounds", async (t) => {
  const { root, pmRoot } = await packedTracker(t, "replay-boundaries");
  const before = capture(), after = { ...before, owners: Object.fromEntries(Object.entries(before.owners).concat([["constructor", calendar]])) };
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  const beforeFile = join(root, "before.json"), afterFile = join(root, "after.json"), controls = join(root, "controls.json");
  writeFileSync(beforeFile, JSON.stringify({ ok: true, snapshot: before }, null, 2)); writeFileSync(afterFile, JSON.stringify(after, null, 4));
  const durable = snapshot(pmRoot);
  const result = (await harness.runCommand({ command: "gantt drift", pmRoot, options: { before: beforeFile, after: afterFile } })).result as ScheduleDriftResult;
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.counts.tasks, 2000); assert.equal(result.changes[0].before, null);
  for (const [command, flag, kind] of [["gantt snapshot", "scenarios", "controls"], ["gantt resources", "scenarios", "controls"], ["gantt uncertainty", "estimates", "estimates"]] as const) {
    const limit = kind === "controls" ? 262144 : 65536;
    writeFileSync(controls, " ".repeat(limit + 1));
    assertTypedRefusal((await harness.runCommand({ command, pmRoot, options: { [flag]: controls, from: options.from, seed: "42" } })).result as ScheduleDriftResult, "invalid_estimate");
  }
  assert.equal(snapshot(pmRoot), durable);
});
