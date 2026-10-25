import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { canonicalDocument, createHistoryEntry, emptyImportedDocument, getHistoryPath, getItemPath, PmClient, serializeItemDocument, type ItemDocument, type ItemMetadata } from "@unbrained/pm-cli/sdk";

/** A real SDK-created tracker outside git; every seeded document gets SDK-sealed history. */
export async function calibrationTracker(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gantt-calibration-"));
  const pmRoot = join(root, ".agents", "pm");
  const sdk = new PmClient({ cwd: root, pmRoot, author: "fixture" });
  await sdk.init("calibration", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, pmRoot, sdk };
}

/** Seed deterministic historical transitions without wall-clock sleeps or hand-written normalization. */
export function seedHistory(pmRoot: string, id: string, changes: Partial<ItemMetadata>[], options: { ops?: string[]; body?: string; times?: string[] } = {}) {
  let before = emptyImportedDocument();
  const entries = [];
  const documents: ItemDocument[] = [];
  for (let index = 0; index < changes.length; index++) {
    const ts = options.times?.[index] ?? new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    const after = canonicalDocument({ metadata: {
      ...before.metadata, id, title: id, description: "Seeded lifecycle", type: "Task", priority: 2, status: "open", created_at: "2026-01-01T00:00:00.000Z", estimated_minutes: 60,
      ...changes[index], updated_at: ts,
    }, body: options.body ?? "" });
    entries.push(createHistoryEntry({ nowIso: ts, author: "fixture", op: options.ops?.[index] ?? (index === 0 ? "create" : "update"), before, after }));
    documents.push(after);
    before = after;
  }
  writeFileSync(getItemPath(pmRoot, before.metadata.type, id, "toon"), serializeItemDocument(before, { format: "toon" }));
  writeFileSync(getHistoryPath(pmRoot, id), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { entries, documents, document: before };
}
