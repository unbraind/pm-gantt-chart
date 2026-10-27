import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient, certifyCompleteListResult, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { encodeToon } from "@unbrained/pm-cli/sdk/testing";
import { captureScheduleScenario, explainScheduleDrift, validateScheduleSnapshot, type ResourceScenarioOptions } from "../index.ts";
import { protectPublicTracker, snapshot } from "./tracker-fixture.ts";

const source = execFileSync("git", ["rev-parse", process.argv[2] ?? "origin/main"], { encoding: "utf8" }).trim();
const root = mkdtempSync(join(tmpdir(), "gantt-drift-public-"));
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
try {
  execFileSync("tar", ["-xf", "-", "-C", root], { input: execFileSync("git", ["archive", source, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 }) });
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const pmRoot = join(root, ".agents", "pm"); protectPublicTracker(pmRoot);
  const hash = snapshot(pmRoot), sdk = new PmClient({ pmRoot }), read = certifyCompleteListResult(await sdk.listAllComplete());
  const registry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
  const active = read.items.filter((row) => registry.active_statuses.has(row.status)).sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(active.length > 1);
  const work = Object.fromEntries(active.map((row) => [row.id, { owner: row.assignee ?? "scenario-pool", minutes: row.estimated_minutes ?? 480 }]));
  const owners = Object.fromEntries([...new Set(Object.values(work).map((row) => row.owner))].map((owner) => [owner, {
    weekdays: [1, 2, 3, 4, 5], holidays: ["2026-10-26"], minutesPerDay: 480, minutesPerWeek: 2400, totalMinutes: 50000,
  }]));
  const options: ResourceScenarioOptions = { from: "2026-10-23", through: "2026-12-01", timeZone: "Europe/Vienna", scenarios: [{ id: "baseline", owners, work }] };
  const before = captureScheduleScenario(read.items, options, registry); assert.ok(before.ok);
  const selected = active[0].id, minutes = work[selected].minutes;
  const after = captureScheduleScenario(read.items, { ...options, scenarios: [{ id: "estimate-change", owners, work: { ...work, [selected]: { ...work[selected], minutes: minutes + 480 } } }] }, registry);
  assert.ok(after.ok);
  const importedBefore = validateScheduleSnapshot(JSON.parse(JSON.stringify(before.snapshot))), importedAfter = validateScheduleSnapshot(JSON.parse(JSON.stringify(after.snapshot)));
  assert.ok(importedBefore.ok && importedAfter.ok);
  const started = performance.now(), result = explainScheduleDrift(importedBefore.value, importedAfter.value, { limit: 3 }); assert.ok(result.ok);
  assert.deepEqual(explainScheduleDrift(before.snapshot, after.snapshot, { limit: 3 }), result);
  assert.equal(snapshot(pmRoot), hash);
  assert.ok(result.counts.moved > 0); assert.equal(result.changes.length, 1); assert.equal(result.gaps.length, 0);
  console.log(JSON.stringify({ source, corpus: read.items.length, active: active.length, relationships: read.items.reduce((n, row) => n + (row.dependencies ?? []).length, 0),
    missingEstimates: active.filter((row) => row.estimated_minutes === undefined).length, missingAssignees: active.filter((row) => row.assignee === undefined).length,
    assumptions: "Recorded estimates/owners retained; missing effort explicitly set to 480 minutes, missing owner explicitly pooled; weekdays with October 26 holiday.",
    changedItem: selected, estimateBefore: minutes, estimateAfter: minutes + 480, counts: result.counts, evaluations: result.evaluations,
    deltaDays: result.moved.map((row) => row.deltaDays), chains: result.moved.map((row) => row.causes.map((cause) => cause.chain)),
    compactJsonBytes: Buffer.byteLength(JSON.stringify(result)), toonBytes: Buffer.byteLength(encodeToon(result)),
    snapshotBytes: Buffer.byteLength(JSON.stringify(before)), elapsedMs: Math.round(performance.now() - started), deterministicReplay: true, durableSourceUnchanged: true, nonGit: true }, null, 2));
} finally {
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  rmSync(root, { recursive: true, force: true });
}
