import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."), scratch = mkdtempSync(join(tmpdir(), "gantt-wait-revert-"));
try {
  for (const file of readdirSync(root).filter((file) => file.endsWith(".ts") || file === "package.json")) cpSync(join(root, file), join(scratch, file));
  cpSync(join(root, ".agents", "pm"), join(scratch, ".agents", "pm"), { recursive: true });
  mkdirSync(join(scratch, "test"));
  for (const file of ["waiting.test.ts", "tracker-fixture.ts"]) cpSync(join(root, "test", file), join(scratch, "test", file));
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const path = join(scratch, "waiting.ts"), original = readFileSync(path, "utf8");
  const mutations = [
    { name: "elapsed ignores declared wait", pattern: "two hours plus two days", before: "add(effortMinutes, waitMinMinutes)", after: "effortMinutes" },
    { name: "missing upper wait becomes zero", pattern: "missing bounds and effort", before: "wait.maxMinutes ?? null", after: "wait.maxMinutes ?? 0" },
    { name: "native status names replace registry roles", pattern: "SDK registry roles", before: "registry.terminal_statuses.has(normalizeStatusInput(item.status, registry) ?? item.status)", after: 'item.status === "closed"' },
  ];
  /** Keep disposable regression launches identical for mutations and restoration. */
  function runRegression(pattern: string, expectedStatus: number): void {
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${pattern}`, "test/waiting.test.ts"], { cwd: scratch, encoding: "utf8" });
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    if (expectedStatus === 1) assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
  }
  for (const mutation of mutations) {
    assert.ok(original.includes(mutation.before));
    writeFileSync(path, original.replace(mutation.before, mutation.after));
    runRegression(mutation.pattern, 1);
    writeFileSync(path, original);
    console.log(`Revert caught: ${mutation.name}`);
  }
  runRegression("two hours plus two days|missing bounds and effort|SDK registry roles", 0);
  console.log("Restored implementation: 3 regression checks pass");
} finally { rmSync(scratch, { recursive: true, force: true }); }
