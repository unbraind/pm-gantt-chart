import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const path = join(import.meta.dirname, "..", "drift.ts"), original = readFileSync(path, "utf8");
const reversions = [
  { name: "drift comparison restored to unsupported baseline", pattern: "one estimate change", before: '  const checked = validateDurationInput("drift",',
    after: '  return { ok: false, code: "invalid_scenario", message: "Schedule drift is unavailable.", remedy: "Compare the scenarios manually." };\n  const checked = validateDurationInput("drift",' },
  { name: "individual causal replays removed", pattern: "one estimate change", before: "const edits = reversals(before, after);", after: "const edits: Reversal[] = [];" },
  { name: "unchanged reference collapse removed", pattern: "unchanged finishes", before: "unchanged.push(row.id);", after: "" },
  { name: "SDK roles replaced by status-name guessing", pattern: "capture producer uses SDK registry roles", before: 'registry.terminal_statuses.has(item.status) ? "terminal" : registry.active_statuses.has(item.status) ? "active" : "unknown"', after: 'item.status === "closed" ? "terminal" : "active"' },
];
try {
  for (const reversion of reversions) {
    assert.ok(original.includes(reversion.before), reversion.name);
    writeFileSync(path, original.replace(reversion.before, reversion.after));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${reversion.pattern}`, "test/drift.test.ts"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
    writeFileSync(path, original);
    console.log(`Behavioral reversion caught: ${reversion.name}`);
  }
} finally { writeFileSync(path, original); }
