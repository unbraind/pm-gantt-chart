import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sources = ["uncertainty.ts", "index.ts"];
const originals = new Map(sources.map((file) => [file, readFileSync(join(import.meta.dirname, "..", file), "utf8")]));
const mutations = [
  { file: "uncertainty.ts", name: "fixed midpoint instead of distribution draws", pattern: "uniform quantiles match", before: "const u = random();", after: "const u = 0.5;" },
  { file: "uncertainty.ts", name: "missing effort silently becomes zero", pattern: "unknown estimates and their downstream", before: "if (raw === undefined || raw === null) return null;", after: 'if (raw === undefined || raw === null) return { kind: "point", minutes: 0 };' },
  { file: "uncertainty.ts", name: "sensitivity loses estimate association", pattern: "sensitivity ranks the dominating", before: "return xx === 0 || yy === 0 ? 0 : Math.max(-1, Math.min(1, xy / (Math.sqrt(xx) * Math.sqrt(yy))));", after: "return 0;" },
  { file: "uncertainty.ts", name: "seed assignment uses host locale", pattern: "portable receipts and sensitivity ties", before: ".sort((a, b) => compareIds(a.id, b.id));", after: ".sort((a, b) => a.id.localeCompare(b.id));" },
  { file: "uncertainty.ts", name: "sensitivity ties use host locale", pattern: "portable receipts and sensitivity ties", before: "|| compareIds(a.id, b.id));", after: "|| a.id.localeCompare(b.id));" },
  { file: "index.ts", name: "estimate-file refusal loses host remediation", pattern: "real non-git tracker: packed", before: 'message: "Cannot read a bounded estimate map.", remedy, remediation: remedy,', after: 'message: "Cannot read a bounded estimate map.", remedy,' },
];
try {
  for (const mutation of mutations) {
    const sourcePath = join(import.meta.dirname, "..", mutation.file);
    const original = originals.get(mutation.file)!;
    assert.ok(original.includes(mutation.before), `Mutation anchor absent: ${mutation.name}`);
    writeFileSync(sourcePath, original.replace(mutation.before, mutation.after));
    const probe = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`, "test/uncertainty.test.ts"], {
      cwd: join(import.meta.dirname, ".."), encoding: "utf8",
    });
    assert.equal(probe.status, 1, `${mutation.name}: expected an assertion failure\n${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout + probe.stderr, /ERR_ASSERTION/);
    writeFileSync(sourcePath, original);
    console.log(`Revert caught: ${mutation.name}`);
  }
} finally {
  for (const [file, original] of originals) writeFileSync(join(import.meta.dirname, "..", file), original);
}
