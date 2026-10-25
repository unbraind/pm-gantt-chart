import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { calibrateObservedDurations } from "../index.ts";
import { snapshot } from "./tracker-fixture.ts";

/** Enforce read-only fixture permissions; restore write access only for scratch cleanup. */
function permissions(directory: string, readOnly: boolean): void {
  chmodSync(directory, readOnly ? 0o555 : 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) permissions(path, readOnly);
    else if (entry.isFile()) chmodSync(path, readOnly ? 0o444 : 0o644);
  }
}

// Only committed public tracker data is copied. The original is never opened for mutation.
const source = execFileSync("git", ["rev-parse", process.argv[2] ?? "origin/main"], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "gantt-calibration-public-"));
const environment = { ...process.env };
try {
  const archive = execFileSync("git", ["archive", source, ".agents/pm"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", scratch], { input: archive });
  const pmRoot = join(scratch, ".agents", "pm");
  process.env.PATH = join(scratch, "no-executables");
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  permissions(pmRoot, true);
  const before = snapshot(pmRoot);
  const started = performance.now();
  const results = [];
  for (const type of ["Task", "Feature", "Issue", "Chore"]) {
    const options = { type, minimumSamples: 5 };
    const result = await calibrateObservedDurations(pmRoot, options);
    assert.deepEqual(await calibrateObservedDurations(pmRoot, options), result);
    results.push({ type, result, jsonBytes: Buffer.byteLength(JSON.stringify(result)) });
  }
  assert.equal(snapshot(pmRoot), before);
  console.log(JSON.stringify({ source, results, durableTrackerUnchanged: true, repeatIdentical: true, gitAvailable: false, copyReadOnly: true, elapsedMs: Math.round(performance.now() - started) }, null, 2));
} finally {
  for (const key of ["PATH", "GIT_CEILING_DIRECTORIES"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  permissions(scratch, false);
  rmSync(scratch, { recursive: true, force: true });
}
