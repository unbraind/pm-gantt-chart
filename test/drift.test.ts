import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PmClient, certifyCompleteListResult, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { captureScheduleScenario, explainScheduleDrift, validateScheduleSnapshot, type ScheduleSnapshot, type ScheduleTask, type ResourceScenarioOptions, type ScheduleDriftResult } from "../index.ts";
import { validateDurationOutput } from "../duration-input.ts";
import { snapshot as durableSnapshot, packedTracker, assertTypedRefusal } from "./tracker-fixture.ts";

const baseSchema = (await readSettings(join(import.meta.dirname, "..", ".agents", "pm"))).schema;
const calendar = { weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [], minutesPerDay: 480, minutesPerWeek: 3360, totalMinutes: 50000 };
const controls: ResourceScenarioOptions = { from: "2026-10-19", through: "2026-11-19", timeZone: "Europe/Vienna", scenarios: [{ id: "saved", owners: { worker: calendar } }] };
/** Minimal saved evidence leaves unrelated native text out of scheduling. */
function task(id: string, prerequisites: string[] = [], minutes = 480): ScheduleTask {
  return { id, status: "open", role: "active", owner: "worker", minutes, prerequisites };
}
/** Build one replayable scheduling snapshot with an explicit shared calendar. */
function saved(tasks: ScheduleTask[] = [task("a"), task("b", ["a"]), task("c", ["b"])]): ScheduleSnapshot {
  return { version: 1, from: controls.from, through: controls.through, timeZone: controls.timeZone, owners: { worker: calendar }, tasks };
}
/** Require a successful comparison without weakening assertion narrowing. */
function compare(before: ScheduleSnapshot, after: ScheduleSnapshot, limit?: number) {
  const result = explainScheduleDrift(before, after, { limit });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test("one estimate change gives exact downstream date delta and causal chain", () => {
  const before = saved(), after = saved([task("a", [], 960), task("b", ["a"]), task("c", ["b"])]);
  const original = JSON.stringify([before, after]);
  const result = compare(before, after);
  assert.equal(result.evaluations, 3);
  assert.deepEqual(result.changes, [{ id: "c1", kind: "estimate", target: "a", before: 480, after: 960 }]);
  assert.deepEqual(result.moved[2], { id: "c", before: "2026-10-21", after: "2026-10-22", deltaDays: 1,
    causes: [{ change: "c1", restoredFinish: "2026-10-21", effectDays: 1, chain: ["a", "b", "c"] }], gaps: [] });
  // Separate owners eliminate a resource shortcut: every prerequisite appears in the chain.
  const independent = { ...before, owners: { worker: calendar, second: calendar, third: calendar }, tasks: before.tasks.map((row, i) => ({ ...row, owner: ["worker", "second", "third"][i] })) };
  const changed = { ...independent, tasks: independent.tasks.map((row) => ({ ...row, minutes: row.id === "a" ? 960 : 480 })) };
  assert.deepEqual(compare(independent, changed).moved[2].causes[0].chain, ["a", "b", "c"]);
  assert.equal(JSON.stringify([before, after]), original);
  const limited = compare(before, after, 1);
  assert.equal(limited.counts.moved, 3); assert.equal(limited.counts.returned, 1); assert.equal(limited.truncated, true);
  const earlier = compare(after, before);
  assert.equal(earlier.moved[2].deltaDays, -1);
});

test("unchanged finishes collapse to stable references; reordered semantic inputs do not drift", () => {
  const before = saved();
  const after = { ...before, tasks: [...before.tasks].reverse(), owners: { worker: { ...calendar, weekdays: [...calendar.weekdays].reverse() } } };
  const result = compare(before, after);
  assert.equal(result.before, result.after);
  assert.deepEqual(result.unchanged, { snapshot: result.before, ids: ["a", "b", "c"] });
  assert.equal(result.counts.moved, 0); assert.equal(result.changes.length, 0);
  assert.deepEqual(compare(saved([]), saved([])).counts, { tasks: 0, moved: 0, unchanged: 0, gaps: 0, returned: 0 });
});

test("calendar holidays, capacity, reassignment and prerequisites have counterfactual witnesses", () => {
  const before = saved();
  for (const ownerCalendar of [{ ...calendar, holidays: ["2026-10-19"] }, { ...calendar, minutesPerDay: 240 }]) {
    const result = compare(before, { ...before, owners: { worker: ownerCalendar } });
    assert.equal(result.changes[0].kind, "calendar");
    assert.ok(result.moved.every((row) => row.causes[0].change === "c1"));
  }
  const both = { ...before, owners: { worker: calendar, slow: { ...calendar, minutesPerDay: 240 } } };
  const reassigned = { ...both, tasks: both.tasks.map((row) => row.id === "a" ? { ...row, owner: "slow" } : row) };
  assert.equal(compare(both, reassigned).changes[0].kind, "owner");
  const parallel = { ...both, tasks: [task("a"), { ...task("b"), owner: "slow" }] };
  const dependent = { ...parallel, tasks: [parallel.tasks[0], { ...parallel.tasks[1], prerequisites: ["a"] }] };
  const result = compare(parallel, dependent);
  assert.deepEqual(result.changes[0], { id: "c1", kind: "prerequisites", target: "b", before: [], after: ["a"] });
  assert.equal(result.moved[0].deltaDays, 1);
  assert.deepEqual(result.moved[0].causes[0].chain, ["b"]);
});

test("unsupported fields, scope, missing work, unknown status and incomplete computations remain gaps", () => {
  const before = saved();
  assert.equal(compare(before, { ...before, tasks: before.tasks.map((row) => ({ ...row, deadline: "2026-11-01" })) }).gaps[0].code, "observational_deadline");
  const shifted = compare(before, { ...before, from: "2026-10-20" });
  assert.equal(shifted.gaps[0].code, "different_horizon"); assert.ok(shifted.moved.every((row) => row.causes.length === 0));
  const absent = compare(before, saved([task("b"), task("c", ["b"])]));
  assert.equal(absent.gaps[0].code, "scope_or_role_changed");
  const unknownRoles = compare(saved([{ ...task("a"), role: "unknown" }]), saved([{ ...task("a", [], 960), role: "unknown" }]));
  assert.equal(unknownRoles.gaps[0].code, "unknown_status_role"); assert.equal(unknownRoles.moved.length, 0);
  assert.deepEqual(unknownRoles.gaps[0].ids, ["a"]);
  for (const tasks of [[{ ...task("a"), minutes: undefined }], [{ ...task("a"), owner: undefined }], [task("a", ["absent"])], [task("a", ["a"])], [task("a"), task("a")]]) {
    assert.ok(compare(saved(tasks), before).gaps.length > 0);
    assert.ok(compare(before, saved(tasks)).gaps.length > 0);
  }
  const exhausted = compare(before, { ...before, through: "2026-10-19" });
  assert.ok(exhausted.moved.some((row) => row.deltaDays === null && row.gaps.includes("unfinished_or_absent")));
  const newOwner = { ...before, owners: { worker: calendar, extra: calendar } };
  assert.equal(compare(before, newOwner).changes.length, 1);
  assert.equal(compare(saved([task("a")]), saved([task("a"), task("b")])).gaps[0].code, "scope_or_role_changed");
  const noOwner = { ...before, owners: { worker: calendar, unused: calendar } };
  assert.equal(compare(noOwner, before).changes[0].kind, "calendar");
  const oldPool = saved([task("a"), task("b")]);
  const separate = { ...oldPool, owners: { worker: calendar, other: calendar }, tasks: [{ ...task("a"), owner: "other" }, task("b")] };
  assert.deepEqual(compare(oldPool, separate).moved.find((row) => row.id === "b")!.causes[0].chain, ["a", "b"]);
  const emptyTerminal = saved([{ id: "done", status: "closed", role: "terminal", prerequisites: [] }, task("a")]);
  const estimatedTerminal = saved([{ ...emptyTerminal.tasks[0], owner: "worker", minutes: 480 }, task("a")]);
  assert.equal(compare(emptyTerminal, estimatedTerminal).changes[0].before, null);
  assert.equal(compare(estimatedTerminal, emptyTerminal).changes[0].after, null);
  const terminal = saved([{ ...task("done"), role: "terminal" }, task("a", ["done"])]);
  assert.equal(compare(terminal, terminal).counts.unchanged, 1);
});

test("counterfactual cycles and joint interactions do not produce invented causes", () => {
  // Both snapshots are acyclic; restoring only b's old prerequisite introduces a cycle.
  const before = saved([task("a"), task("b", ["a"])]), after = saved([task("a", ["b"]), task("b")]);
  assert.equal(compare(before, after).gaps[0].code, "counterfactual_unavailable");
  const slow = { ...calendar, minutesPerDay: 240 };
  const changed = { ...saved([task("a", [], 240)]), owners: { worker: slow } };
  assert.equal(compare(saved([task("a")]), changed).counts.moved, 0);
  const joint = { ...saved([task("a"), { ...task("b"), owner: "second" }, { ...task("c", ["a", "b"]), owner: "third" }]), owners: { worker: calendar, second: calendar, third: calendar } };
  const movedJoint = compare(joint, { ...joint, tasks: joint.tasks.map((row) => ({ ...row, minutes: row.id === "c" ? 480 : 960 })) });
  assert.deepEqual(movedJoint.moved.find((row) => row.id === "c")!.causes, []);
  assert.ok(movedJoint.moved.find((row) => row.id === "c")!.gaps.includes("unattributed_or_joint_effect"));
  const shiftedYears = compare(saved([task("a")]), { ...saved([task("a")]), from: "2030-10-19", through: "2030-11-19" });
  assert.ok(shiftedYears.moved[0].deltaDays! > 366); assert.equal(shiftedYears.moved[0].causes.length, 0);
  const tooMany = Array.from({ length: 33 }, (_, i) => task(`t${i}`, [], 1));
  assertTypedRefusal(explainScheduleDrift(saved(tooMany), saved(tooMany.map((row) => ({ ...row, minutes: 2 })))), "comparison_too_large");
});

test("maximum active scope shares route computation and still reports exact calendar consequences", () => {
  const tasks = Array.from({ length: 200 }, (_, i) => task(`t${i}`, [], 1));
  const before = { ...saved(tasks), through: "2027-10-19" };
  const after = { ...before, owners: { worker: { ...calendar, minutesPerDay: 1 } } };
  const result = compare(before, after, 1);
  assert.equal(result.evaluations, 3); assert.equal(result.counts.moved, 199);
  assert.equal(result.counts.returned, 1); assert.equal(result.moved[0].causes[0].chain.length, 1);
});

test("one strict schema rejects sparse arrays and extreme input/output numbers", () => {
  const before = saved();
  for (const value of [NaN, Infinity, -Infinity, -0, -1, Number.MAX_VALUE, Number.MIN_VALUE, 175201, 0.5]) {
    const malformed = saved([{ ...task("a"), minutes: value }]);
    assertTypedRefusal(explainScheduleDrift(before, malformed), "invalid_estimate");
  }
  for (const raw of [null, [], { ...before, tasks: new Array(1) }, { ...before, from: "2026-02-30" }, { ...before, extra: true }, { ...before, owners: { worker: { ...calendar, weekdays: [1, 1] } } }]) {
    const validated = validateScheduleSnapshot(raw); assert.equal(validated.ok, false);
    assertTypedRefusal(explainScheduleDrift(raw as ScheduleSnapshot, before), "invalid_estimate");
  }
  const output = compare(before, saved([task("a", [], 960), task("b", ["a"]), task("c", ["b"])]));
  for (const value of [Infinity, -Infinity, NaN, 367, -367, 0.5]) {
    assert.equal(validateDurationOutput("drift", { ...output, moved: [{ ...output.moved[0], deltaDays: value === 367 ? 3652425 : value === -367 ? -3652425 : value }] }).ok, false);
    assert.equal(validateDurationOutput("drift", { ...output, moved: [{ ...output.moved[0], causes: [{ ...output.moved[0].causes[0], effectDays: value }] }] }).ok, false);
  }
  for (const value of [0, 175200]) {
    const edge = saved([task("a", [], value)]); assert.equal(validateScheduleSnapshot(edge).ok, true);
    assert.equal(validateDurationOutput("drift", compare(edge, edge)).ok, true);
  }
});

test("capture producer uses SDK registry roles and its output always validates", () => {
  const registry = resolveRuntimeStatusRegistry(baseSchema);
  const items = [{ id: "a", title: "omitted", status: "open", assignee: "worker", estimated_minutes: 480, dependencies: [] }];
  const result = captureScheduleScenario(items, controls, registry);
  assert.ok(result.ok); assert.equal(validateScheduleSnapshot(result.snapshot).ok, true);
  assert.equal(JSON.stringify(result).includes("omitted"), false);
  assertTypedRefusal(captureScheduleScenario(items, { ...controls, scenarios: [] }, registry), "invalid_estimate");
  assertTypedRefusal(captureScheduleScenario(items, { ...controls, scenarios: [...controls.scenarios, { ...controls.scenarios[0], id: "second" }] }, registry), "invalid_scenario");
  const overrides = { ...controls, scenarios: [{ ...controls.scenarios[0], work: { a: { owner: "worker", minutes: 0 } } }] };
  assert.ok(captureScheduleScenario([{ ...items[0], due_date: "2026-10-20" }], overrides, registry, new Map([["a", []]])).ok);
  assertTypedRefusal(captureScheduleScenario(items, controls, registry, new Map()), "invalid_scenario");
  assertTypedRefusal(captureScheduleScenario(items, { ...controls, scenarios: [{ ...controls.scenarios[0], work: { absent: { owner: "worker", minutes: 1 } } }] }, registry), "invalid_scenario");
  assertTypedRefusal(captureScheduleScenario([{ ...items[0], dependencies: [{ id: "absent", kind: "relates_to" }] }], controls, registry), "invalid_scenario");
  assertTypedRefusal(captureScheduleScenario([items[0], items[0]], controls, registry, new Map([["a", []], ["other", []]])), "invalid_scenario");
  assertTypedRefusal(captureScheduleScenario(items, controls, registry, new Map([["other", []]])), "invalid_scenario");
  const renamed = resolveRuntimeStatusRegistry({ ...baseSchema, statuses: [{ id: "closed", roles: ["active"] }, { id: "working", roles: ["terminal"] }] });
  const custom = captureScheduleScenario([{ ...items[0], status: "closed" }, { ...items[0], id: "b", status: "working" }], controls, renamed);
  assert.ok(custom.ok); assert.deepEqual(custom.snapshot.tasks.map((row) => row.role), ["active", "terminal"]);
  const missing = captureScheduleScenario([{ id: "a", title: "a", status: "foreign" }], controls, registry);
  assert.ok(missing.ok); assert.equal(missing.snapshot.tasks[0].role, "unknown");
});

test("500 seeded operation sequences read SDK state, replay older snapshots and preserve every scheduling field", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-drift-model-"));
  const pmRoot = join(root, ".agents", "pm");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = new PmClient({ cwd: root, pmRoot, author: "model" });
  await sdk.init("model", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  const registry = resolveRuntimeStatusRegistry((await readSettings(join(root, ".agents", "pm"))).schema);
  const unset = ["parent", "goal", "objective", "sprint", "release"];
  await sdk.create({ id: "model-a", title: " A \r\n source ", type: "Task", assignee: "worker", estimatedMinutes: "480", unset });
  await sdk.create({ id: "model-b", title: " B \r\n goal ", type: "Task", assignee: "worker", estimatedMinutes: "480", dep: ["id=model-a,kind=blocked_by"], unset });
  let seed = 0x5ca1ab1e;
  /** Reproducible unsigned generator gives the test a stable failure receipt. */
  function next() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  const history: ScheduleSnapshot[] = [], model = new Map<string, ScheduleTask>([
    ["model-a", task("model-a")], ["model-b", task("model-b", ["model-a"])],
  ]);
  const modelControls = { ...controls, scenarios: [{ ...controls.scenarios[0], owners: { worker: calendar, other: calendar } }] };
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 50 === 0) await sdk.focus((next() >>> 16) % 2 === 0 ? "model-a" : "model-b");
    const operation = (next() >>> 16) % 5;
    const id = operation === 2 ? "model-b" : (next() >>> 16) % 2 === 0 ? "model-a" : "model-b";
    const previous = model.get(id)!;
    if (operation === 0) {
      const minutes = next() % 1441;
      await sdk.update(id, { estimatedMinutes: String(minutes), unset }); model.set(id, { ...previous, minutes });
    } else if (operation === 1) {
      const owner = next() % 2 === 0 ? "worker" : "other";
      await sdk.update(id, { assignee: owner, unset }); model.set(id, { ...previous, owner });
    } else if (operation === 2) {
      const prerequisites = next() % 2 === 0 ? [] : ["model-a"];
      await sdk.update(id, { clearDeps: true, unset });
      if (prerequisites.length > 0) await sdk.update(id, { dep: prerequisites.map((id) => `id=${id},kind=blocked_by`), unset });
      model.set(id, { ...previous, prerequisites });
    } else if (operation === 3) {
      const deadline = next() % 2 === 0 ? "2026-10-25T00:00:00.000Z" : "2026-11-01T00:00:00.000Z";
      await sdk.update(id, { deadline, unset }); model.set(id, { ...previous, deadline });
    } else {
      const status = next() % 2 === 0 ? "open" : "in_progress";
      await sdk.update(id, { status, unset }); model.set(id, { ...previous, status });
    }
    const read = certifyCompleteListResult(await sdk.listAllComplete()).items;
    const result = captureScheduleScenario(read, modelControls, registry); assert.ok(result.ok);
    assert.equal(validateScheduleSnapshot(result.snapshot).ok, true);
    assert.deepEqual([...result.snapshot.tasks].sort((a, b) => a.id.localeCompare(b.id)), [...model.values()].sort((a, b) => a.id.localeCompare(b.id)));
    // All saved transports run through the package validator, never handwritten normalization.
    const serialized = JSON.stringify(result.snapshot, null, next() % 3).replaceAll("\n", "\r\n");
    const imported = validateScheduleSnapshot(JSON.parse(` \r\n${serialized} \r\n`)); assert.ok(imported.ok);
    assert.deepEqual(imported.value, result.snapshot);
    history.push(result.snapshot);
    const old = history[next() % history.length], durableBefore = JSON.stringify((await sdk.listAllComplete()).items);
    assert.deepEqual(compare(old, imported.value), compare(old, imported.value));
    assert.equal(JSON.stringify((await sdk.listAllComplete()).items), durableBefore);
    // Random custom registry names have no bearing on their configured roles.
    const active = `working_${next()}`, done = `done_${next()}`;
    const custom = resolveRuntimeStatusRegistry({ ...baseSchema, statuses: [{ id: active, roles: ["active"] }, { id: done, roles: ["terminal", "terminal_done"] }] });
    const projected = captureScheduleScenario(read.map((row, i) => ({ ...row, status: i === 0 ? active : done })), controls, custom);
    assert.ok(projected.ok); assert.deepEqual(projected.snapshot.tasks.map((row) => row.role), ["active", "terminal"]);
  }
});

test("packed CLI snapshot/drift work without git and leave the SDK tracker unchanged", async (t) => {
  const { root, pmRoot, sdk, invoke, bin } = await packedTracker(t, "drift");
  await sdk.create({ id: "drift-a", title: "Source", type: "Task", assignee: "worker", estimatedMinutes: "480", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const file = join(root, "controls.json"), beforeFile = join(root, "before.json"), afterFile = join(root, "after.json");
  writeFileSync(file, JSON.stringify(controls));
  const capture = invoke(["gantt", "snapshot", "--scenarios", file, "--json"]); assert.equal(capture.status, 0, capture.stderr); writeFileSync(beforeFile, capture.stdout);
  await sdk.update("drift-a", { estimatedMinutes: "960" });
  const second = invoke(["gantt", "snapshot", "--scenarios", file, "--json"]); assert.equal(second.status, 0, second.stderr); writeFileSync(afterFile, second.stdout);
  const durable = durableSnapshot(pmRoot);
  const args = ["gantt", "drift", "--before", beforeFile, "--after", afterFile];
  const result = invoke([...args, "--json"]); assert.equal(result.status, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as ScheduleDriftResult).ok, true); assert.match(invoke(args).stdout, /deltaDays/);
  writeFileSync(afterFile, JSON.stringify(JSON.parse(second.stdout).snapshot)); assert.equal(invoke(args).status, 0);
  assert.equal(durableSnapshot(pmRoot), durable);
  const oldPath = process.env.PATH, oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  Object.assign(process.env, { PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) });
  try {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
    const captured = (await harness.runCommand({ command: "gantt snapshot", pmRoot, options: { scenarios: file } })).result as { ok: boolean };
    assert.equal(captured.ok, true);
    const compared = (await harness.runCommand({ command: "gantt drift", pmRoot, options: { before: beforeFile, after: afterFile, limit: "1" } })).result as ScheduleDriftResult;
    assert.ok(compared.ok); assert.equal(compared.moved[0].deltaDays, 1);
    for (const options of [{ before: "", after: afterFile }, {}, { before: beforeFile }, { before: root, after: afterFile }, { before: beforeFile, after: afterFile, limit: "Infinity" }]) {
      const value = (await harness.runCommand({ command: "gantt drift", pmRoot, options })).result as ScheduleDriftResult;
      assertTypedRefusal(value, "invalid_estimate");
    }
    for (const contents of ["x".repeat(262145), "null", "{broken"]) {
      writeFileSync(afterFile, contents); assert.equal(invoke(args).status, 2);
      assertTypedRefusal((await harness.runCommand({ command: "gantt drift", pmRoot, options: { before: beforeFile, after: afterFile } })).result as ScheduleDriftResult, "invalid_estimate");
    }
    assert.equal(((await harness.runCommand({ command: "gantt snapshot", pmRoot, options: {} })).result as ScheduleDriftResult).ok, false);
    writeFileSync(file, JSON.stringify(controls));
    assertTypedRefusal((await harness.runCommand({ command: "gantt snapshot", pmRoot: join(root, "absent"), options: { scenarios: file } })).result as ScheduleDriftResult, "invalid_estimate");
    writeFileSync(file, "{}"); assert.equal(((await harness.runCommand({ command: "gantt snapshot", pmRoot, options: { scenarios: file } })).result as ScheduleDriftResult).ok, false);
  } finally {
    process.env.PATH = oldPath;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
  }
});
