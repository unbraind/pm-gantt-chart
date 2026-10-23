import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type ResourceScenarioResult, type ResourceScenarioOptions } from "../index.ts";
import { snapshot } from "./tracker-fixture.ts";

/** Protect every archived source document; derived caches remain disposable. */
function protect(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) protect(path);
    else chmodSync(path, 0o444);
  }
}

const source = execFileSync("git", ["rev-parse", process.argv[2] ?? "origin/main"], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "gantt-resource-public-"));
const oldPath = process.env.PATH, oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
try {
  const archived = execFileSync("git", ["archive", source, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archived });
  const pmRoot = join(scratch, ".agents", "pm");
  protect(pmRoot);
  const bin = join(scratch, "bin"); mkdirSync(bin);
  const cli = join(import.meta.dirname, "..", "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  for (const [name, executable] of [["node", process.execPath], ["pm", cli]]) symlinkSync(executable, join(bin, name));
  Object.assign(process.env, { PATH: bin, GIT_CEILING_DIRECTORIES: dirname(scratch) });
  const before = snapshot(pmRoot), sdk = new PmClient({ pmRoot });
  const read = await sdk.listAllComplete();
  const items = read.items;
  const active = items.filter((item) => item.status !== "closed" && item.status !== "canceled");
  const owners = [...new Set(active.map((item) => item.assignee ?? "unassigned-scenario-pool"))];
  const work = Object.fromEntries(active.map((item) => [item.id, { owner: item.assignee ?? "unassigned-scenario-pool", minutes: item.estimated_minutes ?? 480 }]));
  const options: ResourceScenarioOptions = {
    from: "2026-10-23", through: "2026-11-06", timeZone: "Europe/Vienna", limit: 3,
    scenarios: [0, 480].map((minutes) => ({ id: `capacity-${minutes}`, work, owners: Object.fromEntries(owners.map((owner) => [owner, { weekdays: [1, 2, 3, 4, 5], holidays: ["2026-10-26"], minutesPerDay: minutes, minutesPerWeek: minutes * 5, totalMinutes: minutes * 11 }])) })),
  };
  const file = join(scratch, "resources.json"); writeFileSync(file, JSON.stringify(options));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  const started = performance.now();
  const result = (await harness.runCommand({ command: "gantt resources", pmRoot, options: { scenarios: file } })).result as ResourceScenarioResult;
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual((await harness.runCommand({ command: "gantt resources", pmRoot, options: { scenarios: file } })).result, result);
  assert.equal(snapshot(pmRoot), before);
  console.log(JSON.stringify({ source, corpus: items.length, active: active.length, owners: owners.length, missingEstimates: active.filter((item) => item.estimated_minutes === undefined).length,
    missingAssignees: active.filter((item) => item.assignee === undefined).length, hypothetical: "Preserve recorded owner/effort; explicitly pool unassigned work and assume 480 minutes only where effort is missing; public holiday October 26",
    totalMinutes: Object.values(work).reduce((n, row) => n + row.minutes, 0),
    scenarios: result.scenarios.map((scenario) => ({ id: scenario.id, outcome: scenario.outcome, itemCount: scenario.itemCount, returned: scenario.items.length, remainingMinutes: scenario.remainingMinutes, witnesses: scenario.witnesses.length, deficitMinutes: scenario.witnesses.reduce((n, row) => n + row.deficitMinutes, 0) })),
    compactJsonBytes: Buffer.byteLength(JSON.stringify(result)), revision: result.revision, elapsedMs: Math.round(performance.now() - started), deterministicReplay: true, durableSourceUnchanged: true, gitAvailable: false,
  }, null, 2));
} finally {
  process.env.PATH = oldPath;
  if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
  rmSync(scratch, { recursive: true, force: true });
}
