import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type CompletionIntervalResult, type UncertainEstimate } from "../index.ts";
import { snapshot } from "./tracker-fixture.ts";

// Read public committed tracker documents into a disposable directory outside git.
const ref = process.argv[2] ?? "origin/main";
const source = execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "gantt-public-validation-"));
const originalPath = process.env.PATH, originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
try {
  const archive = join(scratch, "tracker.tar");
  execFileSync("git", ["archive", "--output", archive, source, ".agents/pm"]);
  execFileSync("tar", ["-xf", archive, "-C", scratch]);
  const pmRoot = join(scratch, ".agents", "pm"), bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(import.meta.dirname, "..", "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"), join(bin, "pm"));
  process.env.PATH = bin;
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  const before = snapshot(pmRoot);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  const controls = { from: "2026-10-22", seed: "42", samples: "10000" };
  const started = performance.now();
  const baseline = (await harness.runCommand({ command: "gantt uncertainty", pmRoot, options: controls })).result as CompletionIntervalResult;
  assert.ok(baseline.ok, JSON.stringify(baseline));
  // Explore an explicit hypothetical assumption without editing a single tracker estimate.
  const estimates: Record<string, UncertainEstimate> = Object.fromEntries(baseline.receipt.tasks.map((task, index) => [task.id, {
    kind: "uniform", min: 480, max: index === 0 ? 48000 : 960,
  }]));
  const file = join(scratch, "estimates.json");
  writeFileSync(file, JSON.stringify(estimates));
  const declared = (await harness.runCommand({ command: "gantt uncertainty", pmRoot, options: { ...controls, estimates: file } })).result as CompletionIntervalResult;
  assert.ok(declared.ok, JSON.stringify(declared));
  const repeated = (await harness.runCommand({ command: "gantt uncertainty", pmRoot, options: { ...controls, estimates: file } })).result;
  assert.deepEqual(repeated, declared);
  assert.equal(snapshot(pmRoot), before);
  console.log(JSON.stringify({
    source, active: baseline.activeCount, unknownEstimates: baseline.unknownEstimateCount, unknownCompletions: baseline.unknownCount,
    baselineProject: baseline.project, receiptTasks: baseline.receipt.tasks.length,
    orderingEdges: baseline.receipt.tasks.reduce((n, task) => n + task.prerequisites.length, 0),
    hypothetical: { declaration: "First canonical active id uniform 480..48000 minutes; remaining active ids uniform 480..960 minutes", project: declared.project,
      dominantEstimate: declared.dominantEstimate, topCorrelation: declared.sensitivity[0]?.correlation, samples: declared.receipt.samples, inputHash: declared.receipt.inputHash },
    compactJsonBytes: Buffer.byteLength(JSON.stringify(declared)), replayIdentical: true, durableTrackerUnchanged: true, gitAvailable: false,
    elapsedMs: Math.round(performance.now() - started),
  }, null, 2));
} finally {
  process.env.PATH = originalPath;
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  rmSync(scratch, { recursive: true, force: true });
}
