import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const path = join(root, "duration-input.ts");
const original = readFileSync(path, "utf8");
const anchor = 'case "array": {';
assert.ok(original.includes(anchor));
try {
  // Restore the reviewed failure class by bypassing only empirical-population validation.
  writeFileSync(path, original.replace(anchor, anchor + '\n      if (path.endsWith(".values")) return value;'));
  const probe = spawnSync(process.execPath, ["--test", "--test-name-pattern=review 179: sparse", "test/duration-input.test.ts"], { cwd: root, encoding: "utf8" });
  assert.equal(probe.status, 1, probe.stdout + probe.stderr);
  assert.match(probe.stdout + probe.stderr, /ERR_ASSERTION/);
  assert.match(probe.stdout + probe.stderr, /Invalid time value/);
  console.log("Revert caught: empirical boundary bypass causes the sparse-array RangeError regression.");
} finally { writeFileSync(path, original); }
