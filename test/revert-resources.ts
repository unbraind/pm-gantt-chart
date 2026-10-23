import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, ".."), path = join(root, "resources.ts");
const original = readFileSync(path, "utf8");
const mutations = [
  { name: "dangling forward relationship validation is removed", pattern: "dangling forward relationships refuse", before: "const invalidReferences = corpus.some((item) => (item.dependencies ?? []).some((dependency) => !ids.has(dependency.id)));", after: "const invalidReferences = false;" },
  { name: "non-string horizon type guard is removed", pattern: "non-string horizon values return", before: '  if (typeof value !== "string") return NaN;\n', after: "" },
  { name: "unlimited parallel effort replaces shared capacity", pattern: "resource contention delays", before: "Math.min(task.minutes - task.allocatedMinutes, available)", after: "task.minutes - task.allocatedMinutes" },
  { name: "weekends become working days", pattern: "resource contention delays", before: "calendar.weekdays.includes(date.weekday) && !calendar.holidays.includes(date.date)", after: "!calendar.holidays.includes(date.date)" },
  { name: "overload witnesses disappear", pattern: "overloads have independent", before: "if (requiredMinutes > availableMinutes)", after: "if (false)" },
  { name: "source revision guard is removed", pattern: "explicit application requires", before: "if (result.revision !== choice.expectedRevision)", after: "if (false)" },
  { name: "target revision guard is removed", pattern: "packed CLI runs", before: 'match: { key: "updated_at", value: choice.targetRevision },', after: "" },
];
try {
  for (const mutation of mutations) {
    if (process.argv.length > 2 && !process.argv.slice(2).some((name) => mutation.name.includes(name))) continue;
    assert.ok(original.includes(mutation.before), mutation.name);
    writeFileSync(path, original.replace(mutation.before, mutation.after));
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`, "test/resources.test.ts"], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 1, `${mutation.name}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /ERR_ASSERTION/);
    writeFileSync(path, original);
    console.log(`Revert caught: ${mutation.name}`);
  }
} finally { writeFileSync(path, original); }
