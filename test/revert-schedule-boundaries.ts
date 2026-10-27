import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const mutations = [
  { file: "schedule-files.ts", name: "saved-file reader restored to the control cap", pattern: "producer closure", before: 'kind === "snapshot" ? SCHEDULE_FILE_MAX_BYTES', after: 'kind === "snapshot" ? 262144' },
  { file: "duration-input.ts", name: "producer byte-budget validation removed", pattern: "producer closure", before: '      if (rule.maxJsonBytes !== undefined && Buffer.byteLength(JSON.stringify(result, null, 2)) > rule.maxJsonBytes) throw new DurationInputError(`${path}.encoded_bytes`);', after: "" },
  { file: "schedule-files.ts", name: "read-time growth guard removed", pattern: "all file readers", before: '      if (used > limit) throw new Error("File exceeded its byte budget during reading");', after: "" },
  { file: "duration-input.ts", name: "own-entry lookup restored to inherited lookup", pattern: "own-entry semantics", before: 'return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;', after: 'return record?.[key];' },
  { file: "drift.ts", name: "calendar comparison restored to inherited lookup", pattern: "own-entry semantics", before: 'const previous = ownDurationValue(before.owners, owner), current = ownDurationValue(after.owners, owner);', after: 'const previous = before.owners[owner], current = after.owners[owner];' },
  { file: "drift.ts", name: "calendar reconstruction restored to prototype setters", pattern: "own-entry semantics", before: 'snapshot: { ...after, owners: Object.fromEntries(owners) },', after: 'snapshot: { ...after, owners: Object.assign({}, Object.fromEntries(owners)) },' },
];
for (const mutation of mutations) {
  const path = join(root, mutation.file), original = readFileSync(path, "utf8");
  try {
    assert.ok(original.includes(mutation.before), mutation.name); writeFileSync(path, original.replace(mutation.before, mutation.after));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${mutation.pattern}`, "test/schedule-boundaries.test.ts"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
    console.log(`Behavioral reversion caught: ${mutation.name}`);
  } finally { writeFileSync(path, original); }
}
