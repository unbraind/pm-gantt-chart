import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { certifyCompleteListResult, PmClient, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildPrerequisiteGraph, effortWaitingPreview, previewEffortWaiting, type EffortWaitingItem, type EffortWaitingOptions } from "../index.ts";
import { DURATION_MINUTES, validateDurationOutput } from "../duration-input.ts";
import { assertTypedRefusal, orderingRegistry, packedTracker, snapshot } from "./tracker-fixture.ts";

const baseSchema = (await readSettings(join(import.meta.dirname, "..", ".agents", "pm"))).schema;
const registry = resolveRuntimeStatusRegistry(baseSchema);
const unset = ["parent", "goal", "objective", "sprint", "release"];

/** Native fixture deliberately retains body, ownership and contextual relationships. */
function task(id = "a", effort: number | undefined = 120, dependencies: string[] = []): EffortWaitingItem {
  return { id, title: `Task ${id}`, status: "open", estimated_minutes: effort, assignee: "owner", body: "Native body\r\n retained ",
    dependencies: dependencies.map((id) => ({ id, kind: "blocked_by" })) };
}

/** Successful result narrowing keeps every test assertion on the public receipt. */
function compute(items: readonly EffortWaitingItem[] = [task()], options: EffortWaitingOptions = { waits: { a: { minMinutes: 2880, maxMinutes: 2880 } } }) {
  const result = effortWaitingPreview(items, options, registry);
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test("two hours plus two days consumes only two hours of capacity and 3000 elapsed minutes", () => {
  const items = [task()], before = structuredClone(items);
  const result = compute(items);
  assert.equal(result.totalEffortMinutes, 120);
  assert.equal(result.finishMinMinutes, 3000); assert.equal(result.finishMaxMinutes, 3000);
  assert.equal(result.items[0].elapsedMinMinutes, 3000);
  assert.equal(result.waitingCount, 1); assert.equal(result.unknownCount, 0);
  assert.deepEqual(items, before);
  assert.equal(compute([], { waits: {} }).finishMinMinutes, 0);
  assert.equal(compute([task("zero", 0)], { waits: {} }).totalEffortMinutes, 0);
  assert.equal(compute([{ ...task(), dependencies: undefined }], { waits: { a: { minMinutes: 0, maxMinutes: 0 } } }).finishMinMinutes, 120);
  assert.deepEqual(compute([task("b"), task()], { waits: {} }), compute([task(), task("b")], { waits: {} }));
});

test("missing bounds and effort remain unknown, independently and through every successor", () => {
  for (const wait of [{}, { minMinutes: 2880 }, { maxMinutes: 2880 }]) {
    const result = compute([task(), task("b", 60, ["a"])], { waits: { a: wait }, limit: 1 });
    assert.equal(result.unknownCount, 2); assert.equal(result.activeCount, 2);
    assert.equal(result.totalEffortMinutes, 180); assert.equal(result.truncated, true);
    assert.equal(result.items[0].waitMinMinutes, "minMinutes" in wait ? 2880 : null);
    assert.equal(result.items[0].waitMaxMinutes, "maxMinutes" in wait ? 2880 : null);
  }
  const unknown = compute([{ ...task(), estimated_minutes: undefined }], { waits: {} });
  assert.equal(unknown.totalEffortMinutes, null); assert.equal(unknown.knownEffortMinutes, 0);
  assert.equal(unknown.finishMaxMinutes, null);
  const fork = compute([task(), task("b", 60, ["a"]), task("c", 200)], { waits: { a: { minMinutes: 2880, maxMinutes: 3000 } } });
  assert.equal(fork.finishMinMinutes, 3060); assert.equal(fork.finishMaxMinutes, 3180);
  assert.equal(fork.totalEffortMinutes, 380);
});

test("SDK registry roles and custom ordering control arbitrary native status names", () => {
  let seed = 55;
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const active = sequence % 2 === 0 ? "closed" : `working_${seed}`, done = `finished_${seed}`, blocked = `external_${seed}`;
    const custom = resolveRuntimeStatusRegistry({ ...baseSchema, statuses: [
      { id: active, aliases: [`alias_${seed}`], roles: ["active"] }, { id: done, roles: ["terminal", "terminal_done"] },
      { id: blocked, roles: ["blocked"] }, { id: "foreign", roles: ["draft"] },
    ] });
    const items = [{ ...task(), status: `alias_${seed}` }, { ...task("b"), status: blocked }, { ...task("c"), status: done }];
    const result = effortWaitingPreview(items, { waits: {} }, custom);
    assert.ok(result.ok); assert.equal(result.activeCount, 2);
    assert.deepEqual(result.items.map((row) => row.role), ["active", "blocked"]);
    assertTypedRefusal(effortWaitingPreview(items, { waits: { c: {} } }, custom), "invalid_wait_target");
  }
  const unknown = compute([{ ...task(), status: "foreign" }], { waits: {} });
  assert.equal(unknown.items[0].role, "unknown"); assert.equal(unknown.finishMinMinutes, null);
  const contextual = [{ ...task(), dependencies: [{ id: "b", kind: "ships_before" }, { id: "b", kind: "related" }] }, task("b", 60)];
  const result = effortWaitingPreview(contextual, { waits: { a: { minMinutes: 10, maxMinutes: 10 } } }, registry, buildPrerequisiteGraph(contextual as Parameters<typeof buildPrerequisiteGraph>[0], orderingRegistry()));
  assert.ok(result.ok); assert.equal(result.items[1].finishMinMinutes, 190);
});

test("strict boundary refuses extreme controls, sparse arrays and unsafe graphs; old native estimates stay readable", () => {
  for (const value of [NaN, Infinity, -Infinity, -0, -1, 0.5, 525601, Number.MAX_VALUE, Number.MIN_VALUE]) {
    assertTypedRefusal(effortWaitingPreview([task()], { waits: { a: { minMinutes: value } } }, registry), "invalid_estimate");
    assertTypedRefusal(effortWaitingPreview([task()], { waits: {}, limit: value }, registry), "invalid_estimate");
  }
  for (const options of [null, {}, { waits: [] }, { waits: { a: null } }, { waits: { a: { minMinutes: 2, maxMinutes: 1 } } }, { waits: { a: { minutes: 5 } } }, { waits: {}, limit: 201 }]) {
    assertTypedRefusal(effortWaitingPreview([task()], options as EffortWaitingOptions, registry), "invalid_estimate");
  }
  for (const items of [Array(1), [{ ...task(), dependencies: Array(1) }], [{ ...task(), estimated_minutes: Infinity }], Array.from({ length: 2001 }, (_, i) => task(String(i)))]) {
    assertTypedRefusal(effortWaitingPreview(items, { waits: {} }, registry), "invalid_estimate");
  }
  for (const items of [[task(), task()], [task("a", 1, ["missing"])], [task("a", 1, ["b"]), task("b", 1, ["a"])], [task("a", 1, ["a"])]]) {
    assertTypedRefusal(effortWaitingPreview(items, { waits: {} }, registry), "invalid_graph");
  }
  for (const graph of [new Map(), new Map([["absent", []]]), new Map([["a", ["absent"]]])]) {
    assertTypedRefusal(effortWaitingPreview([task()], { waits: {} }, registry, graph), "invalid_graph");
  }
  assertTypedRefusal(effortWaitingPreview([task()], { waits: { missing: {} } }, registry), "invalid_wait_target");
  assertTypedRefusal(effortWaitingPreview(Array.from({ length: 201 }, (_, i) => task(String(i))), { waits: {} }, registry), "preview_too_large");
  assertTypedRefusal(effortWaitingPreview([task(), task("b")], { waits: {} }, registry, new Map([["a", Array(5001).fill("b")], ["b", []]])), "preview_too_large");
  assertTypedRefusal(effortWaitingPreview([task()], { waits: {} }, registry, new Map([["a", Array(5001).fill("a")]])), "invalid_graph");
  for (const minutes of [0, 1 / 60, 175200, DURATION_MINUTES.legacyMaximum]) {
    const result = compute([task("a", minutes)], { waits: { a: { minMinutes: 525600, maxMinutes: 525600 } } });
    assert.equal(result.items[0].effortMinutes, minutes);
    assert.ok(validateDurationOutput("waiting", JSON.parse(JSON.stringify(result))).ok);
  }
  for (const id of ["constructor", "__proto__"]) assert.equal(compute([task(id)], { waits: {} }).waitingCount, 0);
  const declared = JSON.parse('{"waits":{"__proto__":{"minMinutes":2,"maxMinutes":2}}}') as EffortWaitingOptions;
  assert.equal(compute([task("__proto__")], declared).finishMinMinutes, 122);
  assert.equal(compute([task("legacy-" + "x".repeat(200))], { waits: {} }).activeCount, 1);
  assertTypedRefusal(effortWaitingPreview([task(" ")], { waits: {} }, registry), "invalid_graph");
  const normalized = effortWaitingPreview([task(" A "), task("B", 60, ["#a"])], { waits: { "#A\r\n": { minMinutes: 2, maxMinutes: 2 } } }, registry, new Map([["#a", []], [" B ", ["a"]]]));
  assert.ok(normalized.ok); assert.equal(normalized.items[1].finishMinMinutes, 182);
  assertTypedRefusal(effortWaitingPreview([task()], { waits: { a: {}, "#A": {} } }, registry), "invalid_wait_target");
  assertTypedRefusal(effortWaitingPreview([task()], { waits: {} }, registry, new Map([["a", []], ["#A", []]])), "invalid_graph");
});

test("producer outputs validate and round-trip; every emitted numeric field rejects extremes", () => {
  const output = compute();
  for (const key of ["activeCount", "waitingCount", "unknownCount", "knownEffortMinutes", "totalEffortMinutes", "finishMinMinutes", "finishMaxMinutes"]) {
    for (const value of [Infinity, NaN, -1, Number.MAX_VALUE]) assert.equal(validateDurationOutput("waiting", { ...output, [key]: value }).ok, false);
  }
  for (const key of ["effortMinutes", "waitMinMinutes", "waitMaxMinutes", "elapsedMinMinutes", "elapsedMaxMinutes", "finishMinMinutes", "finishMaxMinutes"]) {
    for (const value of [Infinity, NaN, -1, Number.MAX_VALUE]) assert.equal(validateDurationOutput("waiting", { ...output, items: [{ ...output.items[0], [key]: value }] }).ok, false);
  }
  assert.deepEqual(validateDurationOutput("waiting", JSON.parse(JSON.stringify(output))), output);
});

test("500 seeded state sequences replay old CRLF inputs against SDK reads and an independent elapsed model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-wait-model-")), pmRoot = join(root, ".agents", "pm");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = new PmClient({ cwd: root, pmRoot, author: "fixture" });
  await sdk.init("wait-model", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  for (const id of ["wait-model-a", "wait-model-b"]) await sdk.create({ id, title: `  ${id} \r\n native  `, type: "Task", estimatedMinutes: "120", assignee: "fixture", description: " body \r\n whitespace ", unset });
  const nativeModel = new Map<string, EffortWaitingItem>((await sdk.listAllComplete()).items.map((item) => [item.id, item]));
  const past: EffortWaitingOptions[] = [];
  let seed = 0xeff047;
  /** Stable replay seed makes failed random sequences reproducible. */
  function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  for (let sequence = 0; sequence < 500; sequence++) {
    const id = (random() >>> 16) % 2 === 0 ? "wait-model-a" : "wait-model-b";
    if (sequence % 25 === 0) await sdk.focus(id);
    const operation = (random() >>> 16) % 5;
    const link = operation === 4 && id === "wait-model-b" && (random() >>> 16) % 2 === 0;
    if (link) await sdk.update(id, { clearDeps: true, unset });
    const options = operation === 0 ? { estimatedMinutes: String(random() % 1441), unset }
      : operation === 1 ? { title: ` \t Native ${random()} \r\n title `, description: `body ${random()}\r\n line `, unset }
      : operation === 2 ? { assignee: `worker-${random() % 5}`, unset }
      : operation === 3 ? { status: random() % 2 === 0 ? "open" : "in_progress", unset }
      : link ? { dep: ["id=wait-model-a,kind=blocked_by", "id=wait-model-a,kind=related"], unset } : { clearDeps: true, unset };
    const updated = await sdk.update(id, options);
    // Native write results are normalized by the SDK, never by a test-side normalizer.
    nativeModel.set(id, updated.item as unknown as EffortWaitingItem);
    const read = certifyCompleteListResult(await sdk.listAllComplete()).items;
    assert.deepEqual(new Map(read.map((item) => [item.id, item])), nativeModel);
    const min = random() % 525601, max = min + random() % (525601 - min);
    const declaration = sequence % 3 === 0 ? { minMinutes: min } : { minMinutes: min, maxMinutes: max };
    past.push({ waits: { "wait-model-a": declaration } });
    const selected = past[random() % past.length];
    const decoded: EffortWaitingOptions = JSON.parse(` \r\n${JSON.stringify(selected, null, random() % 3).replaceAll("\n", "\r\n")} \r\n`);
    const result = effortWaitingPreview(read, decoded, registry); assert.ok(result.ok);
    const a = nativeModel.get("wait-model-a")!, b = nativeModel.get("wait-model-b")!, wait = selected.waits["wait-model-a"];
    const effortA = a.estimated_minutes!, effortB = b.estimated_minutes!;
    const minA = effortA + wait.minMinutes!, maxA = wait.maxMinutes === undefined ? null : effortA + wait.maxMinutes;
    const dependent = b.dependencies?.some((dep) => dep.kind === "blocked_by");
    const expectedMin = dependent ? minA + effortB : Math.max(minA, effortB);
    const expectedMax = maxA === null ? null : dependent ? maxA + effortB : Math.max(maxA, effortB);
    assert.equal(result.totalEffortMinutes, effortA + effortB);
    assert.equal(result.finishMinMinutes, expectedMin); assert.equal(result.finishMaxMinutes, expectedMax);
    assert.ok(validateDurationOutput("waiting", JSON.parse(JSON.stringify(result))).ok);
    assert.deepEqual(effortWaitingPreview(read, decoded, registry), result, "repeated preview uses current native state");
    const after = certifyCompleteListResult(await sdk.listAllComplete()).items;
    assert.deepEqual(new Map(after.map((item) => [item.id, item])), nativeModel, "all native fields and relationships survive old-input replays");
  }
});

test("packed command and SDK preview preserve ownership without git or a git executable", async (t) => {
  const { root, pmRoot, sdk, invoke, bin } = await packedTracker(t, "waiting");
  await sdk.create({ id: "waiting-a", type: "Task", title: "Wait source", assignee: "fixture", estimatedMinutes: "120", unset });
  await sdk.claim("waiting-a");
  const input = join(root, "waits.json"); writeFileSync(input, JSON.stringify({ waits: { "waiting-a": { minMinutes: 2880, maxMinutes: 2880 } } }));
  const before = snapshot(pmRoot), state = (await sdk.get("waiting-a", { full: true })).item;
  const args = ["gantt", "waiting", "--waits", input];
  const json = invoke([...args, "--json"]); assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout); assert.equal(result.totalEffortMinutes, 120); assert.equal(result.finishMinMinutes, 3000);
  assert.match(invoke(args).stdout, /effortMinutes/);
  const oldPath = process.env.PATH, oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  Object.assign(process.env, { PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) });
  try {
    assert.deepEqual(await previewEffortWaiting(pmRoot, { waits: { "waiting-a": { minMinutes: 2880, maxMinutes: 2880 } } }), result);
    assertTypedRefusal(await previewEffortWaiting(join(root, "missing"), { waits: {} }), "corpus_unavailable");
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
    for (const options of [{}, { waits: root }, { waits: join(root, "missing.json") }]) {
      const receipt = await harness.runCommand({ command: "gantt waiting", pmRoot, options }); assert.equal(receipt.exitCode, 2);
    }
    writeFileSync(input, JSON.stringify({ waits: { "waiting-a": { minMinutes: -1 } } }));
    const denied = invoke([...args, "--json"]); assert.equal(denied.status, 2); assert.match(denied.stdout + denied.stderr, /invalid_estimate/);
  } finally {
    process.env.PATH = oldPath;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
  }
  assert.deepEqual((await sdk.get("waiting-a", { full: true })).item, state); assert.equal(snapshot(pmRoot), before);
});
