import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRelationshipKindRegistry, createExtensionCommandSdk, PmClient, type RelationshipKindDefinition } from "@unbrained/pm-cli/sdk";
import type { ContractsResult } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, {
  buildPrerequisiteGraph, buildRows, computeCriticalPath, computeSchedule, customOrderingContracts, commandPrerequisiteGraph,
  computeSlack, detectCycles, renderCsv, renderJson, resolveGanttOptions,
  type PmItem,
} from "../index.ts";

/** Write one reusable schema extension for real host-discovery fixtures. */
function writeOrderingFixture(parent: string): string {
  const customRoot = join(parent, "ordering-fixture");
  mkdirSync(customRoot, { recursive: true });
  writeFileSync(join(customRoot, "manifest.json"), JSON.stringify({ name: "ordering-fixture", version: "1.0.0", entry: "./index.ts", capabilities: ["schema"] }));
  writeFileSync(join(customRoot, "index.ts"), `import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";\n/** Register fixture semantics through the real extension host. */\nexport default { name: "ordering-fixture", version: "1.0.0", activate(api: ExtensionApi) { api.registerRelationshipKinds(${JSON.stringify(customKinds)}); } };\n`);
  return customRoot;
}

const anchor = new Date("2026-10-12T00:00:00");
const options = resolveGanttOptions({ from: "2026-10-12", schedule: true, "critical-path": true });

/** Construct synthetic rows without conflating relationship context with dates. */
function item(id: string, dependencies: PmItem["dependencies"] = [], minutes = 480): PmItem {
  return { id, title: id, type: "Task", status: "open", estimated_minutes: minutes, dependencies };
}

/** Custom kinds exercise explicit inverse, default precedence, and contextual semantics. */
const customKinds: RelationshipKindDefinition[] = [
  { kind: "ships_before", direction: "directed", ordering: true, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: true, aliases: ["ships_first"] },
  { kind: "waits_for", direction: "directed", ordering: true, precedence: "target_before_source", hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
  { kind: "documents", direction: "directed", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false },
];

for (const kind of ["related", "implements", "recurs_from", "incident_from", "unknown_kind"]) {
  test(`registry semantics: ${kind} stays contextual across the public API`, () => {
    const items = [item("a", [{ id: "b", kind }]), item("b", [{ id: "a", kind }], 1440)];
    const before = JSON.stringify(items);
    const schedule = computeSchedule(items, anchor, 1);
    assert.equal(schedule.get("a")!.start.getTime(), anchor.getTime());
    assert.equal(schedule.get("b")!.start.getTime(), anchor.getTime());
    assert.deepEqual(detectCycles(items), []);
    assert.equal(computeCriticalPath(items).size, 0);
    assert.equal(computeSlack(items, schedule).get("a")!.slackDays, 2);
    const rows = buildRows(items, options, anchor);
    const exported = JSON.parse(renderJson(rows, options, anchor)) as { items: { deps: string[] }[] };
    assert.ok(exported.items.every((row) => row.deps.length === 0));
    assert.equal(JSON.stringify(items), before, "original context is retained without mutation");
  });
}

test("registry semantics: blocks reverses direction and equivalent inverse rows deduplicate", () => {
  const items = [item("a", [{ id: "b", kind: "blocks" }, { id: "b", kind: "blocks", created_at: "2026-10-12" }]), item("b", [{ id: "a", kind: "blocked_by" }])];
  assert.deepEqual([...buildPrerequisiteGraph(items)], [["a", []], ["b", ["a"]]]);
  assert.deepEqual(detectCycles(items), []);
  const schedule = computeSchedule(items, anchor, 1);
  assert.deepEqual(["a", "b"].map((id) => schedule.get(id)!.start.getDate()), [12, 13]);
  assert.deepEqual([...computeCriticalPath(items)], ["a", "b"]);
  assert.ok([...computeSlack(items, schedule).values()].every((row) => row.slackDays === 0));
  const rows = buildRows(items, options, anchor);
  const exported = JSON.parse(renderJson(rows, options, anchor)) as { items: { id: string; deps: string[] }[] };
  assert.deepEqual(exported.items.map(({ id, deps }) => ({ id, deps })), [{ id: "a", deps: [] }, { id: "b", deps: ["a"] }]);
  assert.equal(renderCsv(rows).split("\n")[2]!.split(",")[6], "a");
  // Callers may construct rows themselves; both exporters still normalize the corpus.
  const supplied = rows.map(({ prerequisites: _prerequisites, ...row }) => row);
  assert.equal(renderJson(supplied, options, anchor), renderJson(rows, options, anchor));
  assert.equal(renderCsv(supplied), renderCsv(rows));
});

test("registry semantics: registered custom kinds and mixed-direction corpora share one graph", () => {
  const registry = createRelationshipKindRegistry();
  for (const definition of customKinds) registry.register(definition);
  const items = [
    item("a", [{ id: "b", kind: "SHIPS-FIRST" }]),
    item("b", [{ id: "a", kind: "waits_for" }, { id: "c", kind: "blocks" }]),
    item("c", [{ id: "b", kind: "depends-on" }, { id: "a", kind: "documents" }]),
    item("d", [{ id: "missing", kind: "blocks" }, { id: "missing", kind: "blocked_by" }]),
    { ...item("empty"), dependencies: undefined },
  ];
  const graph = buildPrerequisiteGraph(items, registry);
  assert.deepEqual(graph.get("b"), ["a"]);
  assert.deepEqual(graph.get("c"), ["b"]);
  const schedule = computeSchedule(items, anchor, 1, graph);
  assert.equal(schedule.get("c")!.start.getDate(), 14);
  assert.deepEqual(detectCycles(items, graph), []);
  assert.deepEqual([...computeCriticalPath(items, graph)], ["a", "b", "c"]);
  const slack = computeSlack(items, schedule, graph);
  assert.equal(slack.get("a")!.slackDays, 0);
  assert.equal(slack.get("d")!.slackDays, 2);
  const rows = buildRows(items, { ...options, criticalOnly: true }, anchor, graph);
  assert.deepEqual(rows.map((row) => row.item.id), ["a", "b", "c"]);
  assert.deepEqual(rows.map((row) => row.prerequisites), [[], ["a"], ["b"]]);
  assert.equal(graph.get("d")![0], "missing", "dangling prerequisite remains visible without scheduling absent work");
});

test("registry semantics: mixed-direction true cycle remains fatal", () => {
  const items = [item("a", [{ id: "b", kind: "blocks" }]), item("b", [{ id: "c", kind: "blocks" }]), item("c", [{ id: "a", kind: "blocks" }])];
  assert.equal(detectCycles(items).length, 1);
});

/** Hash durable tracker, history, settings and installed package bytes around exports. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["runtime", "locks", "search", "node_modules"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) result[entry.name] = readlinkSync(path);
    else if (entry.isDirectory()) {
      for (const [name, digest] of Object.entries(snapshot(path))) result[join(entry.name, name)] = digest;
    } else result[entry.name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return result;
}

/** JSON rows checked at the installed CLI boundary. */
interface ExportedRow {
  id: string;
  start: string;
  deps: string[];
  slackDays: number;
}

test("registry semantics: installed CLI honors custom registrations, preserves bytes and rejects true cycles", async () => {
  const root = mkdtempSync(join(tmpdir(), "gantt-registry-"));
  const repoRoot = resolve(import.meta.dirname, "..");
  const cli = join(repoRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const pmRoot = join(root, ".agents", "pm");
  const env = { ...process.env, PM_PATH: pmRoot, PATH: `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH}` };
  const sdk = new PmClient({ cwd: root, pmRoot, author: "fixture" });
  try {
    await sdk.init("ga", { defaults: true, mergeFence: false, agentGuidance: "skip" });
    const packed = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repoRoot, encoding: "utf8" });
    const receipt = JSON.parse(packed.slice(packed.search(/^[[{]/m))) as { filename: string }[] | Record<string, { filename: string }>;
    const tarball = join(root, Object.values(receipt)[0]!.filename);
    execFileSync(process.execPath, [cli, "package", "install", tarball, "--project"], { cwd: root, env, encoding: "utf8" });
    const customRoot = writeOrderingFixture(root);
    const customInstall = JSON.parse(execFileSync(process.execPath, [cli, "--json", "package", "install", customRoot, "--project"], { cwd: root, env, encoding: "utf8" })) as { details: { contributions: { relationship_kinds: string[] } } };
    assert.deepEqual(customInstall.details.contributions.relationship_kinds, customKinds.map((definition) => definition.kind).sort());
    await sdk.create({ id: "ga-a", title: "ga-a", type: "Task", estimatedMinutes: "480", createMode: "progressive" });
    await sdk.create({ id: "ga-b", title: "ga-b", type: "Decision", estimatedMinutes: "480", createMode: "progressive" });
    const cases = ["related", "implements", "blocked_by", "blocks", "inverse", "recurs_from", "incident_from", "ships_before", "waits_for", "documents", "custom_self", "cycle"];
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
    const commandSdk = createExtensionCommandSdk(pmRoot, sdk);
    const sourceOutput = join(root, "source.json");
    const commandOptions = { schedule: true, from: "2026-10-12" };
    for (const kind of cases) {
      await sdk.update("ga-a", { clearDeps: true });
      await sdk.update("ga-b", { clearDeps: true });
      const custom = kind === "custom_self" || customKinds.some((definition) => definition.kind === kind);
      const taskPath = join(pmRoot, "tasks", "ga-a.toon");
      let originalTask: string | undefined;
      if (custom) {
        // SDK 2026.10.6's mutation grammar still limits dependency input to
        // built-ins despite active custom registrations. Seed an explicit custom
        // fixture row; restore it after the export to preserve setup history.
        await sdk.update("ga-a", { dep: ["id=ga-b,kind=blocked_by"] });
        originalTask = readFileSync(taskPath, "utf8");
        assert.ok(originalTask.includes("ga-b,blocked_by,"));
        writeFileSync(taskPath, originalTask.replace("ga-b,blocked_by,", kind === "custom_self" ? "ga-a,ships_before," : `ga-b,${kind},`));
      } else if (kind === "recurs_from") {
        // Recurrence is chronological context: the source is a later occurrence.
        await sdk.update("ga-b", { dep: ["id=ga-a,kind=recurs_from"] });
      } else {
        await sdk.update("ga-a", { dep: [`id=ga-b,kind=${kind === "inverse" ? "blocks" : kind === "cycle" ? "blocked_by" : kind}`] });
        if (kind === "inverse" || kind === "cycle") await sdk.update("ga-b", { dep: ["id=ga-a,kind=blocked_by"] });
      }
      const before = snapshot(pmRoot);
      const output = join(root, "chart.json");
      rmSync(output, { force: true });
      const run = spawnSync(process.execPath, [cli, "gantt", "export", "--format", "json", "--schedule", "--from", "2026-10-12", "--output", "chart.json"], { cwd: root, env, encoding: "utf8" });
      assert.deepEqual(snapshot(pmRoot), before, `${kind}: export must preserve durable bytes`);
      const sourceCommand = { command: "gantt", pmRoot, options: commandOptions, sdk: commandSdk };
      const sourceExporter = { exporter: "gantt", pmRoot, options: { ...commandOptions, format: "json", output: sourceOutput } };
      if (kind === "cycle" || kind === "custom_self") {
        assert.equal(run.status, 2);
        assert.equal(run.stdout, "");
        assert.match(run.stderr, /dependency cycle/);
        assert.throws(() => readFileSync(output), /ENOENT/);
        await assert.rejects(harness.runCommand(sourceCommand), /dependency cycle/);
        await assert.rejects(harness.runExporter(sourceExporter), /dependency cycle/);
        if (originalTask !== undefined) writeFileSync(taskPath, originalTask);
        continue;
      }
      assert.equal(run.status, 0, `${kind}: ${run.stderr}`);
      const rows = (JSON.parse(readFileSync(output, "utf8")) as { items: ExportedRow[] }).items;
      const a = rows.find((row) => row.id === "ga-a")!;
      const b = rows.find((row) => row.id === "ga-b")!;
      const sourceFirst = ["blocks", "inverse", "ships_before"].includes(kind);
      const targetFirst = ["blocked_by", "waits_for"].includes(kind);
      assert.equal(a.start, targetFirst ? "2026-10-13" : "2026-10-12", kind);
      assert.equal(b.start, sourceFirst ? "2026-10-13" : "2026-10-12", kind);
      assert.deepEqual(a.deps, targetFirst ? ["ga-b"] : [], kind);
      assert.deepEqual(b.deps, sourceFirst ? ["ga-a"] : [], kind);
      assert.equal((await harness.runCommand(sourceCommand)).handled, true);
      assert.equal((await harness.runExporter(sourceExporter)).handled, true);
      const sourceRows = (JSON.parse(readFileSync(sourceOutput, "utf8")) as { items: ExportedRow[] }).items;
      assert.deepEqual(sourceRows, rows, `${kind}: source and installed handlers agree`);
      assert.deepEqual(snapshot(pmRoot), before, `${kind}: source handlers preserve durable bytes`);
      if (originalTask !== undefined) writeFileSync(taskPath, originalTask);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("older host census omission falls back to built-in ordering on a real tracker", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-old-census-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = new PmClient({ cwd: root, pmRoot: join(root, ".agents", "pm"), author: "fixture" });
  await sdk.init("old", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  await sdk.create({ id: "old-a", title: "Predecessor", createMode: "progressive" });
  await sdk.create({ id: "old-b", title: "Successor", dep: ["id=old-a,kind=blocked_by"], createMode: "progressive" });
  const contracts = await sdk.run("contracts", { options: { runtimeOnly: true, outputInclude: "full" } }) as ContractsResult;
  const { relationship_kind_contracts: _census, ...olderContracts } = contracts;
  const registry = createRelationshipKindRegistry();
  assert.deepEqual(customOrderingContracts(olderContracts, registry), []);
  assert.deepEqual(customOrderingContracts(contracts, registry), []);
  const items = (await sdk.list({ outputInclude: "full" })).items as PmItem[];
  assert.deepEqual(buildPrerequisiteGraph(items, registry).get("old-b"), ["old-a"]);
});

test("custom predecessor queries overlap within four calls on a real tracker", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gantt-concurrency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  const sdk = new PmClient({ cwd: root, pmRoot, author: "fixture" });
  await sdk.init("batch", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  writeOrderingFixture(join(pmRoot, "extensions"));
  for (let index = 0; index < 7; index += 1) await sdk.create({ id: `batch-${index}`, title: "Context", createMode: "progressive" });
  await sdk.update("batch-0", { dep: ["id=batch-1,kind=blocked_by"] });
  const taskPath = join(pmRoot, "tasks", "batch-0.toon");
  const task = readFileSync(taskPath, "utf8");
  writeFileSync(taskPath, task.replace("batch-1,blocked_by,", "batch-1,ships_before,"));
  const items = (await sdk.list({ outputInclude: "full" })).items as PmItem[];
  const before = snapshot(pmRoot);
  const originalGraph = PmClient.prototype.graph;
  const descriptor = Object.getOwnPropertyDescriptor(PmClient.prototype, "graph")!;
  let active = 0;
  let peak = 0;
  let calls = 0;
  // Observe real SDK traversals without changing requests or results.
  Object.defineProperty(PmClient.prototype, "graph", { ...descriptor, value: async function (this: PmClient, ...args: Parameters<typeof originalGraph>) {
    active += 1;
    calls += 1;
    peak = Math.max(peak, active);
    try { return await originalGraph.apply(this, args); }
    finally { active -= 1; }
  } as typeof originalGraph });
  try {
    const graph = await commandPrerequisiteGraph(items, pmRoot);
    assert.equal(calls, 7, "incoming custom constraints require all roots");
    assert.equal(peak, 4, "real traversals overlap within the bound");
    assert.equal(active, 0);
    assert.deepEqual(graph.get("batch-1"), ["batch-0"]);
    assert.deepEqual(graph.get("batch-0"), []);
    assert.deepEqual([...graph.keys()], items.map((row) => row.id), "corpus order is retained");
    assert.deepEqual(snapshot(pmRoot), before);
  } finally { Object.defineProperty(PmClient.prototype, "graph", descriptor); }
});
