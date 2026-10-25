import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const mutations = [
  { file: "calibration.ts", before: "accepted.length < options.minimumSamples", after: "false", pattern: "compares start estimates", label: "sample-floor refusal removed" },
  { file: "calibration.ts", before: 'if (reopened) return { reason: "reopened" };', after: '', pattern: "discloses conservative exclusions", label: "reopened episodes retained" },
  { file: "calibration.ts", before: 'if (canceled) return { reason: "canceled" };', after: '', pattern: "discloses conservative exclusions", label: "cancellation exclusion removed" },
  { file: "calibration.ts", before: "minutes: state.metadata.estimated_minutes", after: "minutes: 1", pattern: "compares start estimates", label: "start estimate comparison removed" },
  { file: "calibration.ts", before: "Math.ceil(probability * accepted.length) - 1", after: "0", pattern: "compares start estimates", label: "quantile algorithm replaced with minimum" },
  { file: "calibration.ts", before: "JSON.stringify(corpus) !== JSON.stringify(after)", after: "false", pattern: "every SDK read boundary", label: "current revision validation removed" },
  { file: "uncertainty.ts", before: "estimate.values[Math.floor(random() * estimate.values.length)]", after: "estimate.values[0]", pattern: "empirical scenario adoption", label: "empirical sampling replaced with fixed minimum" },
];
for (const mutation of mutations) {
  const path = join(root, mutation.file);
  const original = readFileSync(path, "utf8");
  assert.ok(original.includes(mutation.before), mutation.label);
  try {
    writeFileSync(path, original.replace(mutation.before, mutation.after));
    const probe = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`, "test/calibration.test.ts"], { cwd: root, encoding: "utf8" });
    assert.equal(probe.status, 1, `${mutation.label}: ${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout + probe.stderr, /ERR_ASSERTION/);
    console.log(`Revert caught: ${mutation.label}`);
  } finally { writeFileSync(path, original); }
}
