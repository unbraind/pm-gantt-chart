import assert from "node:assert/strict";
import test, { before, after, describe } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

// ---------------------------------------------------------------------------
// Temp pm projects
//
// The command/exporter handlers shell out to `pm list --all --json` via
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

/** Run one handler assertion with a deterministic `pm` executable on PATH. */
async function withFakePm(response: unknown, run: () => Promise<void>, argsFile?: string): Promise<void> {
  const fakeDir = mkdtempSync(join(tmpdir(), "gantt-fakepm-envelope-"));
  const fakePm = join(fakeDir, "pm");
  writeFileSync(
    fakePm,
    "#!/bin/sh\nif [ -n \"${PM_GANTT_ARGS_FILE:-}\" ]; then\n  for arg in \"$@\"; do printf '%s\\n' \"$arg\"; done >> \"$PM_GANTT_ARGS_FILE\"\n  printf '%s\\n' '--- invocation ---' >> \"$PM_GANTT_ARGS_FILE\"\nfi\nprintf '%s\\n' \"$PM_GANTT_FAKE_RESPONSE\"\n",
    "utf-8",
  );
  chmodSync(fakePm, 0o755);
  const originalPath = process.env.PATH;
  const originalResponse = process.env.PM_GANTT_FAKE_RESPONSE;
  const originalArgsFile = process.env.PM_GANTT_ARGS_FILE;
  process.env.PATH = `${fakeDir}:${originalPath ?? ""}`;
  process.env.PM_GANTT_FAKE_RESPONSE = JSON.stringify(response);
  if (argsFile) process.env.PM_GANTT_ARGS_FILE = argsFile;
  else delete process.env.PM_GANTT_ARGS_FILE;
  try {
    await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalResponse === undefined) delete process.env.PM_GANTT_FAKE_RESPONSE;
    else process.env.PM_GANTT_FAKE_RESPONSE = originalResponse;
    if (originalArgsFile === undefined) delete process.env.PM_GANTT_ARGS_FILE;
    else process.env.PM_GANTT_ARGS_FILE = originalArgsFile;
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

/** Current complete `pm list --all --json` envelope, with caller overrides. */
function completeListAllEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [{ id: "fixture-1", title: "Fixture", status: "open" }],
    count: 1,
    total: 1,
    has_more: false,
    truncated: false,
    next_cursor: null,
    filters: {
      status: "all",
      include_body: true,
      no_truncate: true,
      strict_read: true,
      runtime_filters: {},
    },
    limit: null,
    requested_limit: null,
    effective_limit: null,
    source: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    projection: { mode: "full", fields: null },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
    ...overrides,
  };
}

/** Temp-project roots, populated by the setup hook. */
let normalRoot = "";
let closedTaskId = "";
let inProgressTaskId = "";
let cycleRoot = "";
let warnRoot = "";
let emptyRoot = "";
let infeasibleRoot = "";
let infeasibleBId = "";
let tempDir = "";

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
  const aId = closedTaskId = pmCreate(normalRoot, ["--type", "Task", "--id", "A", "--title", "Design API", "--status", "closed", "--close-reason", "done", "--deadline", "2026-06-10", "--estimate", "480", "--sprint", "S1", "--author", "pi-agent"]);
  const bId = inProgressTaskId = pmCreate(normalRoot, ["--type", "Task", "--id", "B", "--title", "Build endpoint", "--status", "in_progress", "--blocked-by", aId, "--deadline", "2026-06-20", "--estimate", "960", "--sprint", "S1", "--author", "pi-agent"]);
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

  // Infeasible project: A(2d) → B(2d) with B's deadline only 1 day after
  // the anchor, so B can never finish on time (A must complete first).
  const ifA = pmCreate(infeasibleRoot, ["--type", "Task", "--id", "A", "--title", "Late start", "--estimate", "960", "--author", "pi-agent"]);
  infeasibleBId = pmCreate(infeasibleRoot, ["--type", "Task", "--id", "B", "--title", "Tight deadline", "--estimate", "960", "--deadline", "2026-06-02", "--blocked-by", ifA, "--author", "pi-agent"]);

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
// Command handler: non-json mode
//
// The harness's `CommandHandlerResult` exposes `handled`, `result`, `warnings`
// and `errorMessage` — it does NOT capture stdout or stderr. These tests
// therefore assert the handler's returned summary in non-json mode, and are
// named for that. Asserting the rendered chart text would need a different
// mechanism than the harness provides.
// ---------------------------------------------------------------------------

test("gantt command returns its item summary when json is false", async () => {
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

test("preflight override declines for a command pm-gantt-chart does not own", async () => {
  // The override is scoped to `gantt`, so for any other command the runtime
  // must report overridden: false — this is what stops it contending with
  // another package's preflight override (a global override would report
  // overridden: true for every command and collide pairwise).
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
  assert.equal(res.overridden, false, "scoped override must decline a non-owned command");
});

// ---------------------------------------------------------------------------
// Command handler: milestones in non-json mode (dropped note + return payload)
//
// Exercises the gantt command with --milestones that include both an
// in-window and an out-of-window entry in non-json mode. The handler writes a
// NOTE to stderr for the dropped milestone and includes a milestones array in
// the returned result object.
// ---------------------------------------------------------------------------

test("gantt command writes a dropped-milestone NOTE to stderr and includes milestones in the result", async () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const res = await harness.runCommand({
      command: "gantt",
      pmRoot: normalRoot,
      options: {
        schedule: true,
        weeks: "12",
        from: "2026-06-01",
        milestones: "v1.0=2026-06-10,far=2027-01-01",
      },
      global: { json: false },
    });
    assert.equal(res.handled, true);
    const result = res.result as Record<string, unknown>;
    // The return payload includes a milestones array with the in-window entry.
    const milestones = result.milestones as Array<{ name: string; date: string; week: number; inWindow: boolean }>;
    assert.ok(Array.isArray(milestones), "milestones array present in result");
    const v1 = milestones.find((m) => m.name === "v1.0");
    assert.ok(v1, "v1.0 milestone in result");
    assert.equal(v1!.date, "2026-06-10");
    assert.equal(v1!.inWindow, true);
    const far = milestones.find((m) => m.name === "far");
    assert.ok(far, "far milestone in result");
    assert.equal(far!.inWindow, false);
    // The NOTE about the dropped out-of-window milestone went to stderr.
    assert.match(stderr, /NOTE: 1 milestone\(s\) fall outside the chart window/);
    assert.match(stderr, /far/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

// ---------------------------------------------------------------------------
// Command handler: infeasible deadline warning in non-json mode
//
// The infeasible project has A(2d) → B(2d) with B's deadline only 1 day after
// the anchor. Under --schedule, the backward pass flags B as infeasible. In
// non-json mode the handler writes a WARNING to stderr and includes
// infeasibleCount + warnings in the result.
// ---------------------------------------------------------------------------

test("gantt command writes an infeasible-deadline WARNING to stderr and includes warnings in the result", async () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const res = await harness.runCommand({
      command: "gantt",
      pmRoot: infeasibleRoot,
      options: { schedule: true, weeks: "12", from: "2026-06-01" },
      global: { json: false },
    });
    assert.equal(res.handled, true);
    const result = res.result as Record<string, unknown>;
    assert.ok(typeof result.infeasibleCount === "number");
    assert.ok((result.infeasibleCount as number) > 0, "at least one infeasible item");
    const warnings = result.warnings as string[];
    assert.ok(Array.isArray(warnings), "warnings array present");
    assert.ok(warnings.some((w) => w.includes(infeasibleBId) && w.includes("Tight deadline")), "B is flagged late");
    // The WARNING went to stderr.
    assert.match(stderr, /WARNING: \d+ item\(s\) have an infeasible deadline/);
    assert.match(stderr, /Tight deadline/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

// ---------------------------------------------------------------------------
// Exporter: --critical-only with no chain (rows.length === 0)
// ---------------------------------------------------------------------------

test("exporter returns exported=0 with --critical-only when there is no chain", async () => {
  const res = await harness.runExporter({
    exporter: "gantt",
    pmRoot: warnRoot,
    options: { format: "mermaid", "critical-only": true },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.exported, 0);
  assert.equal(result.format, "mermaid");
});

// ---------------------------------------------------------------------------
// Exporter: dropped-milestone NOTE + infeasible-deadline WARNING on stderr
//
// Exports the infeasible project with a --milestones entry outside the chart
// window and --schedule. The exporter writes a NOTE for the dropped milestone
// and a WARNING for the infeasible deadline to stderr, keeping the artifact on
// stdout clean.
// ---------------------------------------------------------------------------

test("exporter writes dropped-milestone NOTE and infeasible-deadline WARNING to stderr", async () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const res = await harness.runExporter({
      exporter: "gantt",
      pmRoot: infeasibleRoot,
      options: {
        format: "ascii",
        schedule: true,
        weeks: "12",
        from: "2026-06-01",
        milestones: "far=2027-01-01",
      },
    });
    assert.equal(res.handled, true);
    const result = res.result as Record<string, unknown>;
    assert.ok((result.exported as number) > 0, "items were exported");
    // The NOTE about the dropped milestone.
    assert.match(stderr, /gantt export NOTE: 1 milestone\(s\) fall outside the chart window/);
    assert.match(stderr, /far/);
    // The WARNING about the infeasible deadline.
    assert.match(stderr, /gantt export WARNING: \d+ item\(s\) have an infeasible deadline/);
    assert.match(stderr, /Tight deadline/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

// ---------------------------------------------------------------------------
// fetchItems: JSON parse failure (pm exits 0 but emits non-JSON stdout)
//
// Creates a fake `pm` script that prints a plain-text line and exits 0, then
// prepends its directory to PATH so fetchItems spawns it instead of the real
// binary. The handler must throw a CommandError naming the parse failure.
// ---------------------------------------------------------------------------

test("gantt command throws a CommandError when pm emits non-JSON output", async () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "gantt-fakepm-"));
  const fakePm = join(fakeDir, "pm");
  writeFileSync(fakePm, "#!/bin/sh\necho 'not json at all'\nexit 0\n", "utf-8");
  chmodSync(fakePm, 0o755);
  const originalPath = process.env.PATH!;
  // Prepend the fake directory so the fake pm shadows the real one.
  process.env.PATH = `${fakeDir}:${originalPath}`;
  try {
    await assert.rejects(
      harness.runCommand({ command: "gantt", pmRoot: normalRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /Failed to parse pm list --all output as JSON/);
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeDir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// Command handler: --progress flag (itemProgress in the result object)
// ---------------------------------------------------------------------------

test("gantt command includes itemProgress in the result under --progress", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: normalRoot,
    options: { schedule: true, progress: true, weeks: "12", from: "2026-06-01" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  const itemProgress = result.itemProgress as Array<{ id: string; percent: number }>;
  assert.ok(Array.isArray(itemProgress), "itemProgress array present");
  assert.equal(itemProgress.length, 4, "one entry per item");
  // A is closed, so its progress is 100. Selecting by `startsWith("pm-")`
  // matched any fixture item and asserting only that something was found let
  // the test pass with the closed item's percentage wrong — which is the whole
  // property. Select A by its own id and assert the value.
  const a = itemProgress.find((ip) => ip.id === closedTaskId);
  assert.ok(a, `task A must appear in itemProgress, got: ${itemProgress.map((ip) => ip.id).join(", ")}`);
  assert.equal(a.percent, 100, "a closed item is 100 percent complete");
  // And the in-progress item is not, so the field varies with status rather
  // than being a constant the assertion above would also accept.
  const b = itemProgress.find((ip) => ip.id === inProgressTaskId);
  assert.ok(b && b.percent < 100, `an in_progress item must be below 100, got: ${String(b?.percent)}`);
});

// ---------------------------------------------------------------------------
// Command handler: overdue items (overdue array in the result)
// ---------------------------------------------------------------------------

test("gantt command includes overdue items in the result when deadlines have passed", async () => {
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: warnRoot,
    options: { weeks: "200", from: "2019-01-01" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  const overdue = result.overdue as Array<{ id: string; deadline: string | null }>;
  assert.ok(Array.isArray(overdue), "overdue array present");
  assert.ok(overdue.length > 0, "at least one overdue item");
});

// ---------------------------------------------------------------------------
// Exporter: default format (no --format option → defaults to mermaid)
// ---------------------------------------------------------------------------

test("exporter defaults to mermaid format when --format is omitted", async () => {
  const res = await harness.runExporter({
    exporter: "gantt",
    pmRoot: normalRoot,
    options: { schedule: true, weeks: "12", from: "2026-06-01" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.equal(result.format, "mermaid");
  assert.equal(result.exported, 4);
});

// ---------------------------------------------------------------------------
// fetchItems: pm exits non-zero with no stderr (|| "no output" fallback)
// ---------------------------------------------------------------------------

test("gantt command throws a CommandError when pm exits non-zero with no output", async () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "gantt-fakepm-empty-"));
  const fakePm = join(fakeDir, "pm");
  writeFileSync(fakePm, "#!/bin/sh\nexit 1\n", "utf-8");
  chmodSync(fakePm, 0o755);
  const originalPath = process.env.PATH!;
  process.env.PATH = `${fakeDir}:${originalPath}`;
  try {
    await assert.rejects(
      harness.runCommand({ command: "gantt", pmRoot: normalRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /Failed to fetch pm items/);
        assert.match((err as Error).message, /no output/);
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fetchItems: pm returns valid JSON without an items field (?? [] fallback)
// ---------------------------------------------------------------------------

test("gantt command refuses JSON without a verifiable item envelope", async () => {
  await withFakePm({}, async () => {
    await assert.rejects(
      harness.runCommand({ command: "gantt", pmRoot: normalRoot }),
      /invalid_envelope/,
    );
  });
});

test("gantt requests the exact canonical strict full unbounded list and accepts the current complete envelope", async () => {
  const argsFile = join(tempDir, "fake-pm-args.txt");
  await withFakePm(completeListAllEnvelope(), async () => {
    const res = await harness.runCommand({ command: "gantt", pmRoot: normalRoot });
    assert.equal(res.handled, true);
    assert.equal((res.result as Record<string, unknown>).itemCount, 1);
  }, argsFile);
  const invocations = readFileSync(argsFile, "utf8")
    .split("--- invocation ---\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => block.split("\n").filter((line) => line.length > 0));
  assert.equal(invocations.length, 1, "the handler must read the tracker exactly once");
  assert.deepEqual(invocations[0], [
    "--pm-path",
    normalRoot,
    "list",
    "--all",
    "--json",
    "--include-body",
    "--strict-read",
    "--no-truncate",
    "--output-budget",
    "unbounded",
    "--output-limit",
    "unbounded",
    "--output-include",
    "full",
  ]);
});

test("gantt accepts a complete envelope with zero items", async () => {
  await withFakePm(completeListAllEnvelope({ items: [], count: 0, total: 0 }), async () => {
    const res = await harness.runCommand({ command: "gantt", pmRoot: normalRoot });
    assert.equal(res.handled, true);
    assert.equal((res.result as Record<string, unknown>).itemCount, 0);
  });
});

test("gantt preserves validated compound fields in exported rows", async () => {
  const items = [
    { id: "blocker", title: "Blocker", status: "closed" },
    { id: "annotation", title: "Annotation target", status: "open" },
    {
      id: "fixture-1",
      title: "Fixture",
      status: "open",
      tags: ["agent"],
      meta: { progress: 75 },
      dependencies: [
        { id: "blocker", kind: "blocked_by", created_at: "2026-08-17T00:00:00.000Z" },
        { id: "annotation" },
      ],
    },
  ];
  await withFakePm(completeListAllEnvelope({ items, count: 3, total: 3 }), async () => {
    const res = await harness.runExporter({
      exporter: "gantt",
      pmRoot: normalRoot,
      options: { format: "json", "group-by": "tag", progress: true },
    });
    assert.equal(res.handled, true);
    const result = res.result as Record<string, unknown>;
    assert.equal(result.exported, 3);
    assert.equal(typeof result.output, "string");
    const artifact: unknown = JSON.parse(result.output as string);
    assert.ok(artifact !== null && typeof artifact === "object" && !Array.isArray(artifact));
    const exportedItems = (artifact as Record<string, unknown>).items;
    assert.ok(Array.isArray(exportedItems));
    const fixture = exportedItems.find(
      (item): item is Record<string, unknown> => item !== null
        && typeof item === "object"
        && !Array.isArray(item)
        && (item as Record<string, unknown>).id === "fixture-1",
    );
    assert.ok(fixture);
    assert.equal(fixture.group, "agent");
    assert.equal(fixture.progress, 75);
    assert.deepEqual(fixture.deps, ["blocker", "annotation"]);
  });
});

test("command and exporter refuse every independent incomplete or malformed envelope signal", async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["bare array", [], /invalid_envelope/],
    ["null", null, /invalid_envelope/],
    ["non-array items", completeListAllEnvelope({ items: {} }), /invalid_envelope/],
    ["truncated", completeListAllEnvelope({ truncated: true }), /page_incomplete/],
    ["paginated", completeListAllEnvelope({ has_more: true }), /page_incomplete/],
    ["cursor", completeListAllEnvelope({ next_cursor: "more" }), /page_incomplete/],
    ["partial corpus", completeListAllEnvelope({ completeness: { status: "partial", unreadable_item_count: 1, unreadable_directory_count: 0 } }), /source_incomplete/],
    ["unreadable item", completeListAllEnvelope({ completeness: { status: "complete", unreadable_item_count: 1, unreadable_directory_count: 0 } }), /completeness\.unreadable_item_count=1/],
    ["unreadable directory", completeListAllEnvelope({ completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 1 } }), /completeness\.unreadable_directory_count=1/],
    ["missing corpus receipt", (() => { const value = completeListAllEnvelope(); delete value.completeness; return value; })(), /source_unchecked/],
    ["missing omission receipt", (() => { const value = completeListAllEnvelope(); delete value.omission_receipt; return value; })(), /omission_receipt=<missing>/],
    ["omitted fields", completeListAllEnvelope({ omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: ["body"] } }), /field_omission/],
    ["contradictory omission count", completeListAllEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 1, omitted_field_groups: ["body"] } }), /omission_receipt\.omitted_field_group_count=1/],
    ["missing omitted groups", completeListAllEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 0 } }), /omission_receipt\.omitted_field_groups=<missing>/],
    ["contradictory omitted groups", completeListAllEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: ["body"] } }), /omission_receipt\.omitted_field_groups=\["body"\]/],
    ["compact projection", completeListAllEnvelope({ projection: { mode: "brief", fields: ["id"] } }), /projection_incomplete/],
    ["missing projection", (() => { const value = completeListAllEnvelope(); delete value.projection; return value; })(), /projection_incomplete/],
    ["missing read receipt", (() => { const value = completeListAllEnvelope(); delete value.read_output; return value; })(), /read_output=<missing>/],
    ["unknown read contract", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, contract_version: 2 } }), /read_output\.contract_version=2/],
    ["rows compacted", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, rows_compacted: true } }), /budget_compaction/],
    ["strings compacted", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, strings_compacted: true } }), /budget_compaction/],
    ["result omitted", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, result_omitted: true } }), /budget_omission/],
    ["budget not fit", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, within_budget: false } }), /read_output\.within_budget=false/],
    ["dimensions not an array", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, requested_dimensions: "amount,cost" } }), /read_output\.requested_dimensions=<missing>/],
    ["missing amount proof", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, requested_dimensions: ["include", "cost"] } }), /requested_dimensions missing amount/],
    ["missing cost proof", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, requested_dimensions: ["include", "amount"] } }), /requested_dimensions missing cost/],
    ["missing include proof", completeListAllEnvelope({ read_output: { ...completeListAllEnvelope().read_output as Record<string, unknown>, requested_dimensions: ["amount", "cost"] } }), /requested_dimensions missing include/],
    ["budget truncation disclosure", completeListAllEnvelope({ output_budget_truncation: { reason: "output_budget_reached" } }), /output_budget_truncation=<present>/],
    ["budget omission disclosure", completeListAllEnvelope({ output_budget_exceeded: { omitted_result: true } }), /output_budget_exceeded=<present>/],
    ["non-numeric count", completeListAllEnvelope({ count: "1" }), /count_mismatch/],
    ["negative count", completeListAllEnvelope({ count: -1 }), /count_mismatch/],
    ["non-numeric total", completeListAllEnvelope({ total: "1" }), /count_mismatch/],
    ["negative total", completeListAllEnvelope({ total: -1 }), /count_mismatch/],
    ["count disagrees with rows", completeListAllEnvelope({ count: 2, total: 2 }), /count_mismatch/],
    ["count disagrees with total", completeListAllEnvelope({ total: 2 }), /count_mismatch/],
    ["non-object row", completeListAllEnvelope({ items: [null] }), /invalid_item_id/],
    ["missing row id", completeListAllEnvelope({ items: [{ title: "Fixture", status: "open" }] }), /invalid_item_id/],
    ["empty row id", completeListAllEnvelope({ items: [{ id: " ", title: "Fixture", status: "open" }] }), /invalid_item_id/],
    ["duplicate row id", completeListAllEnvelope({ items: [{ id: "same", title: "A", status: "open" }, { id: "same", title: "B", status: "open" }], count: 2, total: 2 }), /duplicate_item_id/],
    ["non-string title", completeListAllEnvelope({ items: [{ id: "fixture-1", title: 1, status: "open" }] }), /must have a string title and a supported status/],
    ["non-string status", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: 1 }] }), /must have a string title and a supported status/],
    ["unsupported status", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "invented" }] }), /must have a string title and a supported status/],
    ["non-string optional field", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", deadline: 1 }] }), /field deadline must be a string/],
    ["invalid priority", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", priority: {} }] }), /priority must be a string or number/],
    ["tags not an array", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", tags: "agent" }] }), /tags must be an array of strings/],
    ["non-string tag", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", tags: [1] }] }), /tags must be an array of strings/],
    ["meta not an object", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", meta: [] }] }), /meta must be an object/],
    ["invalid estimate", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", estimated_minutes: -1 }] }), /estimated_minutes must be a non-negative finite number/],
    ["dependencies not an array", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", dependencies: {} }] }), /dependencies must be an array/],
    ["non-object dependency", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", dependencies: [null] }] }), /dependency 0 must have a non-empty id/],
    ["missing dependency id", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", dependencies: [{}] }] }), /dependency 0 must have a non-empty id/],
    ["empty dependency id", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", dependencies: [{ id: " " }] }] }), /dependency 0 must have a non-empty id/],
    ["invalid dependency kind", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", dependencies: [{ id: "fixture-0", kind: 1 }] }] }), /dependency 0 kind must be a string/],
    ["invalid dependency timestamp", completeListAllEnvelope({ items: [{ id: "fixture-1", title: "Fixture", status: "open", dependencies: [{ id: "fixture-0", created_at: 1 }] }] }), /dependency 0 created_at must be a string/],
  ];

  for (const [name, envelope, expected] of cases) {
    await withFakePm(envelope, async () => {
      await assert.rejects(
        harness.runCommand({ command: "gantt", pmRoot: normalRoot }),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${name}: expected Error`);
          assert.match(error.message, expected, name);
          return true;
        },
      );
    });
  }

  await withFakePm(completeListAllEnvelope({ truncated: true }), async () => {
    await assert.rejects(
      harness.runExporter({ exporter: "gantt", pmRoot: normalRoot }),
      /page_incomplete/,
    );
  });
});

// ---------------------------------------------------------------------------
// Command handler: no overdue items (overdue ternary false arm)
// ---------------------------------------------------------------------------

test("gantt command omits the overdue array when no items are overdue", async () => {
  // Filter to closed items only — A is closed, so isOverdue returns false.
  const res = await harness.runCommand({
    command: "gantt",
    pmRoot: normalRoot,
    options: { status: "closed", weeks: "12", from: "2026-06-01" },
  });
  assert.equal(res.handled, true);
  const result = res.result as Record<string, unknown>;
  assert.ok(result.itemCount, "at least one item rendered");
  assert.equal(result.overdue, undefined, "no overdue array when none are overdue");
});
