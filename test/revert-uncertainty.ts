import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sourcePath = join(import.meta.dirname, "..", "uncertainty.ts");
const original = readFileSync(sourcePath, "utf8");
const mutations = [
  { name: "fixed midpoint instead of distribution draws", pattern: "uniform quantiles match", before: "const u = random();", after: "const u = 0.5;" },
  { name: "missing effort silently becomes zero", pattern: "unknown estimates and their downstream", before: "if (raw === undefined || raw === null) return null;", after: 'if (raw === undefined || raw === null) return { kind: "point", minutes: 0 };' },
  { name: "sensitivity loses estimate association", pattern: "sensitivity ranks the dominating", before: "return xx === 0 || yy === 0 ? 0 : Math.max(-1, Math.min(1, xy / (Math.sqrt(xx) * Math.sqrt(yy))));", after: "return 0;" },
];
try {
  for (const mutation of mutations) {
    assert.ok(original.includes(mutation.before), `Mutation anchor absent: ${mutation.name}`);
    writeFileSync(sourcePath, original.replace(mutation.before, mutation.after));
    const probe = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`, "test/uncertainty.test.ts"], {
      cwd: join(import.meta.dirname, ".."), encoding: "utf8",
    });
    assert.equal(probe.status, 1, `${mutation.name}: expected an assertion failure\n${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout + probe.stderr, /ERR_ASSERTION/);
    console.log(`Revert caught: ${mutation.name}`);
  }
} finally {
  writeFileSync(sourcePath, original);
}
