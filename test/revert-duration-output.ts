import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../duration-input.ts", import.meta.url);
const root = new URL("..", import.meta.url);
const original = readFileSync(path, "utf8");
const guard = '    parse(outputSchemas[kind], value, kind);';
assert.ok(original.includes(guard));
try {
  writeFileSync(path, original.replace(guard, '    // Behavioral revert: return the computed result without checking its output contract.'));
  const probe = spawnSync(process.execPath, ["--test", "--test-name-pattern=output guard refuses", "test/duration-output.test.ts"], { cwd: root, encoding: "utf8" });
  assert.equal(probe.status, 1, probe.stdout + probe.stderr);
  assert.match(probe.stdout + probe.stderr, /ERR_ASSERTION/);
  console.log("Revert caught: an accepted SDK input returned an out-of-contract year-10000 completion when the output check was removed.");
} finally { writeFileSync(path, original); }
