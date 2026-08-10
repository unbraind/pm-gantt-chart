import assert from "node:assert/strict";
import test, { before, after, describe } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

// ---------------------------------------------------------------------------
// Temp pm projects
//
// The command/exporter handlers shell out to `pm list-all --json` via
// fetchItems, so exercising them requires real tracker data. Three temp
// projects are created: a normal chain, a cyclic graph, and an empty tracker.
// ---------------------------------------------------------------------------

const PM_BIN = "pm";

function pmInit(root: string): void {
  execFileSync(PM_BIN, ["init", root, "--defaults", "--author", "pi-agent", "--no-merge-fence"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function pmCreate(root: string, args: string[]): string {
  const out = execFileSync(PM_BIN, ["--path", root, "create", ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const match = out.match(/^id: "(\S+)"/m);
  if (!match) throw new Error(`pm create did not emit an id: ${out}`);
  return match[1];
}

function pmUpdate(root: string, id: string, args: string[]): void {
  execFileSync(PM_BIN, ["--path", root, "update", id, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Temp-project roots, populated by the setup hook. */
let normalRoot = "";
let cycleRoot = "";
let warnRoot = "";
let emptyRoot = "";
let infeasibleRoot = "";
let tempDir = "";
let fakePmDir = "";

let harness: ExtensionTestHarness;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gantt-handler-"));
  normalRoot = join(tempDir, "normal");
  cycleRoot = join(tempDir, "cycle");
  warnRoot = join(tempDir, "warn");
  emptyRoot = join(tempDir, "empty");
  infeasibleRoot = join(tempDir, "infeasible");

  for (const root of [normalRoot, cycleRoot, warnRoot, emptyRoot, infeasibleRoot]) {
    pmInit(root);
  }

  // Normal project: A → B → C chain + isolated D.
  const aId = pmCreate(normalRoot, ["--type", "Task", "--id", "A", "--title", "Design API", "--status", "closed", "--close-reason", "done", "--deadline", "2026-06-10", "--estimate", "480", "--sprint", "S1", "--author", "pi-agent"]);
  const bId = pmCreate(normalRoot, ["--type", "Task", "--id", "B", "--title", "Build endpoint", "--status", "in_progress", "--blocked-by", aId, "--deadline", "2026-06-20", "--estimate", "960", "--sprint", "S1", "--author", "pi-agent"]);
  pmCreate(normalRoot, ["--type", "Task", "--id", "C", "--title", "Integration tests", "--status", "open", "--blocked-by", bId, "--estimate", "720", "--sprint", "S2", "--author", "pi-agent"]);
  pmCreate(normalRoot, ["--type", "Task", "--id", "D", "--title", "Write docs", "--status", "open", "--estimate", "480", "--sprint", "S2", "--author", "pi-agent"]);

  // Cycle project: X ↔ Y.
  const xId = pmCreate(cycleRoot, ["--type", "Task", "--id", "X", "--title", "Cyclic X", "--author", "pi-agent"]);
  const yId = pmCreate(cycleRoot, ["--type", "Task", "--id", "Y", "--title", "Cyclic Y", "--author", "pi-agent"]);
  pmUpdate(cycleRoot, xId, ["--blocked-by", yId, "--author", "pi-agent"]);
  pmUpdate(cycleRoot, yId, ["--blocked-by", xId, "--author", "pi-agent"]);

  // Warn project: deadline-before-start + absurd estimate.
  pmCreate(warnRoot, ["--type", "Task", "--id", "W1", "--title", "Bad deadline", "--deadline", "2020-01-01", "--author", "pi-agent"]);
  pmCreate(warnRoot, ["--type", "Task", "--id", "W2", "--title", "Huge estimate", "--estimate", "9999999", "--author", "pi-agent"]);

  // Empty project: no items.
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness activation
// ---------------------------------------------------------------------------

test("handler harness activates cleanly", async () => {
  harness = await createExtensionTestHarness(extension, {
    name: "pm-gantt-chart",
    capabilities: ["commands", "schema", "importers", "preflight"],
  });
  assert.deepEqual(harness.activation.failed, [], "activation must not fail");
});

// ---------------------------------------------------------------------------
// Command handler: normal run (json mode)
// ---------------------------------------------------------------------------

test("gantt command renders items and returns a structured result", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: normalRoot,
    options: { schedule: true, weeks: "12", from: "2026-06-01" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.itemCount, 4, "all four items rendered");
  assert.equal(result.schedule, true);
  assert.equal(result.weeks, 12);
  assert.ok(typeof result.chart === "string");
  assert.ok((result.chart as string).length > 0, "chart is non-empty");
});

// ---------------------------------------------------------------------------
// Command handler: non-json mode (stdout/stderr writes)
// ---------------------------------------------------------------------------

test("gantt command writes the chart to stdout when json is false", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: normalRoot,
    options: { schedule: true, weeks: "12", from: "2026-06-01", "group-by": "sprint" },
    global: { json: false },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.itemCount, 4);
});

// ---------------------------------------------------------------------------
// Command handler: empty tracker
// ---------------------------------------------------------------------------

test("gantt command returns early with no items on an empty tracker", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: emptyRoot,
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.itemCount, 0);
  assert.equal(result.chart, null);
});

// ---------------------------------------------------------------------------
// Command handler: status filter with no matches
// ---------------------------------------------------------------------------

test("gantt command returns a warning when the status filter matches nothing", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: normalRoot,
    options: { status: "canceled" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.itemCount, 0);
  assert.equal(result.chart, null);
  assert.ok(typeof result.warning === "string");
});

// ---------------------------------------------------------------------------
// Command handler: --critical-only with no chain
// ---------------------------------------------------------------------------

test("gantt command returns a warning with --critical-only when there is no chain", async () => {
  // The warn project has two unlinked items → no critical chain.
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: warnRoot,
    options: { "critical-only": true },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.itemCount, 0);
  assert.equal(result.chart, null);
  assert.ok(typeof result.warning === "string");
});

// ---------------------------------------------------------------------------
// Command handler: data-sanity gate fatal (dependency cycle)
// ---------------------------------------------------------------------------

test("gantt command throws a CommandError on a dependency cycle", async () => {
  await assert.rejects(
    harness.runCommand({ command: "gantt", pmRoot: cycleRoot }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /fatal data problem/);
      assert.match((err as Error).message, /dependency cycle/);
      assert.equal((err as { exitCode?: number }).exitCode, 2);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Command handler: data-sanity warnings (non-json mode → stderr)
// ---------------------------------------------------------------------------

test("gantt command renders with data-sanity warnings in non-json mode", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: warnRoot,
    global: { json: false },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.ok(result.itemCount, "chart still rendered despite warnings");
});

// ---------------------------------------------------------------------------
// Command handler: fetchItems failure (non-existent pm root)
// ---------------------------------------------------------------------------

test("gantt command throws a CommandError when pm root does not exist", async () => {
  await assert.rejects(
    harness.runCommand({ command: "gantt", pmRoot: "/nonexistent/path/xyz" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Failed to fetch pm items/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Command handler: pmJsonMaxBuffer env-var override
// ---------------------------------------------------------------------------

test("gantt command respects PM_JSON_MAX_BUFFER env var (small cap causes fetch failure)", async () => {
  const prev = process.env.PM_JSON_MAX_BUFFER;
  process.env.PM_JSON_MAX_BUFFER = "1";
  try {
    await assert.rejects(
      harness.runCommand({ command: "gantt", pmRoot: normalRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /Failed to fetch pm items/);
        return true;
      },
    );
  } finally {
    if (prev === undefined) {
      delete process.env.PM_JSON_MAX_BUFFER;
    } else {
      process.env.PM_JSON_MAX_BUFFER = prev;
    }
  }
});

// ---------------------------------------------------------------------------
// Exporter: each format via renderForFormat
// ---------------------------------------------------------------------------

describe("gantt export", () => {
  for (const format of ["mermaid", "html", "svg", "ascii", "csv", "json"] as const) {
    test(`exporter renders ${format} output`, async () => {
      const res = await harness.runExporter({
        exporter: "gantt",
        pmRoot: normalRoot,
        options: { format, schedule: true, weeks: "12", from: "2026-06-01" },
      });
      assert.equal(res.handled, true);
      const result = res.result as Record<string, unknown>;
      assert.equal(result.format, format);
      assert.equal(result.exported, 4);
      // stdout mode → result.output is the rendered string.
      assert.ok(typeof result.output === "string");
      assert.ok((result.output as string).length > 0, `${format} output is non-empty`);
    });
  }
});

// ---------------------------------------------------------------------------
// Exporter: --output writes a file with the correct extension
// ---------------------------------------------------------------------------

describe("gantt export --output", () => {
  for (const format of ["mermaid", "html", "svg", "ascii", "csv", "json"] as const) {
    test(`exporter writes ${format} to a file with the correct extension`, async () => {
      const outFile = join(tempDir, `chart-${format}.test`);
      const res = await harness.runExporter({
        exporter: "gantt",
        pmRoot: normalRoot,
        options: { format, schedule: true, weeks: "12", from: "2026-06-01", output: outFile },
      });
      assert.equal(res.handled, true);
      const result = res.result as Record<string, unknown>;
      assert.equal(result.format, format);
      assert.equal(result.exported, 4);
      assert.ok(typeof result.file === "string");
      assert.ok(existsSync(outFile), `${format} file was written`);
      const content = readFileSync(outFile, "utf-8");
      assert.ok(content.length > 0, `${format} file is non-empty`);
    });
  }
});

// ---------------------------------------------------------------------------
// Exporter: unknown format
// ---------------------------------------------------------------------------

test("exporter throws a CommandError for an unknown format", async () => {
  await assert.rejects(
    harness.runExporter({
      exporter: "gantt",
      pmRoot: normalRoot,
      options: { format: "pdf" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Unknown --format/);
      assert.equal((err as { exitCode?: number }).exitCode, 2);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Exporter: no items
// ---------------------------------------------------------------------------

test("exporter returns exported=0 on an empty tracker", async () => {
  const res = await harness.runExporter({
    exporter: "gantt",
    pmRoot: emptyRoot,
    options: { format: "mermaid" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.exported, 0);
});

// ---------------------------------------------------------------------------
// Exporter: data-sanity warnings (non-json → stderr)
// ---------------------------------------------------------------------------

test("exporter renders with data-sanity warnings in non-json mode", async () => {
  const res = await harness.runExporter({
    exporter: "gantt",
    pmRoot: warnRoot,
    options: { format: "ascii" },
    global: { json: false },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.ok((result.exported as number) > 0, "items exported despite warnings");
});

// ---------------------------------------------------------------------------
// Preflight override
// ---------------------------------------------------------------------------

test("preflight override returns empty delta for the gantt command", async () => {
  const res = await harness.runPreflightOverride({
    command: "gantt",
    args: [],
    options: {},
    global: { json: true },
    pm_root: normalRoot,
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  } as any);
  assert.equal(res.overridden, true, "override was applied");
  assert.deepEqual(res.warnings, [], "no warnings from empty delta");
});

test("preflight override returns empty delta for a non-gantt command", async () => {
  const res = await harness.runPreflightOverride({
    command: "list",
    args: [],
    options: {},
    global: { json: true },
    pm_root: normalRoot,
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  } as any);
  assert.equal(res.overridden, true, "override was applied");
  assert.deepEqual(res.warnings, [], "no warnings from empty delta");
});