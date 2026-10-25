import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { calibrateObservedDurations } from "../index.ts";
import { snapshot } from "./tracker-fixture.ts";

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
  console.log(JSON.stringify({ source, results, durableTrackerUnchanged: true, repeatIdentical: true, gitAvailable: false, elapsedMs: Math.round(performance.now() - started) }, null, 2));
} finally {
  for (const key of ["PATH", "GIT_CEILING_DIRECTORIES"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  rmSync(scratch, { recursive: true, force: true });
}
