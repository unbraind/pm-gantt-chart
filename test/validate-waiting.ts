import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { certifyCompleteListResult, PmClient, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { previewEffortWaiting, type EffortWaitingOptions } from "../index.ts";
import { archivePublicTracker, snapshot } from "./tracker-fixture.ts";

const { source, root: scratch, pmRoot } = archivePublicTracker("gantt-wait-public-", process.argv[2]);
try {
  const before = snapshot(pmRoot), sdk = new PmClient({ pmRoot });
  const items = certifyCompleteListResult(await sdk.listAllComplete()).items;
  const registry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
  const active = items.filter((item) => !registry.terminal_statuses.has(item.status));
  const options: EffortWaitingOptions = { waits: Object.fromEntries(active.slice(0, 2).map((item, i) => [item.id, i === 0 ? { minMinutes: 2880, maxMinutes: 2880 } : {}])), limit: 3 };
  const started = performance.now();
  const result = await previewEffortWaiting(pmRoot, options); assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(await previewEffortWaiting(pmRoot, options), result);
  assert.equal(snapshot(pmRoot), before);
  assert.deepEqual(certifyCompleteListResult(await sdk.listAllComplete()).items, items);
  console.log(JSON.stringify({ source, corpus: items.length, nonterminal: result.activeCount, declaredWaits: result.waitingCount,
    missingNativeEffort: active.filter((item) => item.estimated_minutes === undefined).length, knownEffortMinutes: result.knownEffortMinutes,
    totalEffortMinutes: result.totalEffortMinutes, unknownCompletion: result.unknownCount, returnedRows: result.items.length,
    compactJsonBytes: Buffer.byteLength(JSON.stringify(result)), elapsedMs: Math.round(performance.now() - started),
    hypothetical: "First nonterminal item: explicit two-day wait; second: unbounded external wait. No effort, ownership or relationship overrides.",
    deterministicReplay: true, sdkReadBackUnchanged: true, durableSourceUnchanged: true, gitRepository: false,
  }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
