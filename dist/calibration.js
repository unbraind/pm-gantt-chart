import { createHash } from "node:crypto";
import { applyHistoryPatch, certifyCompleteListResult, getHistoryPath, locateItem, PmClient, readHistorySnapshot, readLocatedItem, readSettings, replayHistoryToTarget, resolveItemTypeRegistry, getActiveExtensionRegistrations, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
/** Unreadable foreign streams are excluded without exposing or repairing their contents. */
async function historySnapshot(pmRoot, id) {
    try {
        return await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
    }
    catch {
        return { raw: undefined, entries: [] };
    }
}
/** Stable numeric controls also protect JavaScript SDK callers from unbounded output. */
function validOptions(options) {
    const quantiles = options.quantiles ?? [0.1, 0.5, 0.9];
    return typeof options.type === "string" && options.type.trim().length > 0 && options.type.length <= 128
        && (options.tag === undefined || (typeof options.tag === "string" && options.tag.trim().length > 0 && options.tag.length <= 128))
        && Number.isInteger(options.minimumSamples) && options.minimumSamples >= 1 && options.minimumSamples <= 2000
        && Number.isInteger(options.limit ?? 20) && (options.limit ?? 20) >= 1 && (options.limit ?? 20) <= 200
        && quantiles.length >= 1 && quantiles.length <= 9
        && quantiles.every((q, i) => Number.isFinite(q) && q >= 0 && q <= 1 && (i === 0 || q > quantiles[i - 1]));
}
/** Exact current classification; no fuzzy title search or implicit selection. */
function matches(item, options) {
    return item.type === options.type && (options.tag === undefined || (Array.isArray(item.tags) && item.tags.includes(options.tag)));
}
/** Build typed refusals without exposing tracker paths or raw history content. */
function refusal(code, message, remedy, evidence) {
    return { ok: false, code, message, remedy, ...(evidence === undefined ? {} : { evidence }) };
}
/**
 * Read lifecycle state using the SDK patch kernel after full verified replay.
 * Imported/checkpoint snapshots are not starts; reopening or cancellation rejects
 * the entire item, including earlier completed work. Blocking stays in elapsed time.
 */
function episode(history, options) {
    replayHistoryToTarget(history, history.length - 1);
    let state = { metadata: {}, body: "" };
    let start;
    let end;
    let canceled = false, reopened = false, terminal = false, previousTime = -Infinity;
    for (const entry of history) {
        const before = state.metadata.status;
        state = applyHistoryPatch(state, entry.patch, 1, entry.op);
        const after = state.metadata.status;
        const at = Date.parse(entry.ts);
        if (!Number.isFinite(at) || at < previousTime)
            return { reason: "unverified_history" };
        previousTime = at;
        if (after === "canceled")
            canceled = true;
        if (terminal && after !== "closed" && after !== "canceled")
            reopened = true;
        if (after === "closed" || after === "canceled")
            terminal = true;
        if (after === "in_progress" && before !== "in_progress" && before !== undefined && entry.op === "update" && start === undefined) {
            start = { at, minutes: state.metadata.estimated_minutes, matching: matches(state.metadata, options) };
        }
        if (after === "closed" && before !== "closed" && (entry.op === "close" || entry.op === "update")) {
            // Actual completion is canonical when available; never infer it from later edits.
            const actual = state.metadata.completed_at ?? state.metadata.closed_at ?? entry.ts;
            end = Date.parse(String(actual));
        }
    }
    if (reopened)
        return { reason: "reopened" };
    if (canceled)
        return { reason: "canceled" };
    if (state.metadata.status !== "closed")
        return { reason: "incomplete" };
    if (start === undefined || end === undefined)
        return { reason: "missing_start" };
    if (!start.matching)
        return { reason: "class_changed" };
    if (typeof start.minutes !== "number" || !Number.isFinite(start.minutes) || start.minutes <= 0)
        return { reason: "missing_estimate" };
    const elapsedMinutes = (end - start.at) / 60000;
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0 || elapsedMinutes > 175200)
        return { reason: "invalid_duration" };
    return { reason: null, elapsedMinutes, plannedMinutes: start.minutes };
}
/**
 * Calibrate from complete SDK reads and hash-verified item histories. No writes,
 * journals, locks or git subprocesses are used. Optimistic second reads refuse
 * mixed revisions, including history-only changes, instead of caching stale work.
 */
export async function calibrateObservedDurations(pmRoot, options) {
    if (!validOptions(options))
        return refusal("invalid_calibration", "Invalid cohort, sample floor or output controls.", "Supply an exact type, optional nonblank tag, minimumSamples 1..2000, limit 1..200 and 1..9 increasing quantiles in [0,1].");
    const client = PmClient.forActiveExtensionHost({ pmRoot });
    try {
        const corpus = certifyCompleteListResult(await client.listAllComplete()).items;
        const selected = corpus.filter((item) => matches(item, options)).sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
        if (selected.length > 2000)
            return refusal("calibration_too_large", "Selected cohort exceeds 2000 items.", "Select a narrower exact type/tag cohort with at most 2000 items.");
        const settings = await readSettings(pmRoot);
        const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        const evidence = { selectedCount: selected.length, sampleCount: 0, minimumSamples: options.minimumSamples,
            excluded: { unverified_history: 0, reopened: 0, canceled: 0, incomplete: 0, missing_start: 0, missing_estimate: 0, class_changed: 0, invalid_duration: 0 }, rows: [], truncated: selected.length > (options.limit ?? 20) };
        const snapshots = [];
        const accepted = [];
        const hashes = [];
        let entries = 0;
        for (const item of selected) {
            const snapshot = await historySnapshot(pmRoot, item.id);
            snapshots.push({ id: item.id, raw: snapshot.raw });
            entries += snapshot.entries.length;
            if (snapshot.entries.length > 10000 || entries > 100000)
                return refusal("calibration_too_large", "History exceeds the replay budget.", "Select a cohort with at most 10000 entries per item and 100000 entries in total; preserve original histories.");
            let row = { reason: "unverified_history" };
            try {
                const located = await locateItem(pmRoot, item.id, settings.id_prefix, settings.item_format, registry.type_to_folder);
                if (located !== null && snapshot.entries.length > 0) {
                    const { document } = await readLocatedItem(located, { schema: settings.schema });
                    if (verifyHistoryEntries(snapshot.entries, document).ok)
                        row = episode(snapshot.entries, options);
                }
            }
            catch {
                // A foreign, corrupt or unsupported stream is disclosed, never repaired.
            }
            hashes.push({ id: item.id, historyHash: createHash("sha256").update(snapshot.raw === undefined ? "unreadable" : snapshot.raw ?? "").digest("hex") });
            if (row.reason === null)
                accepted.push({ elapsed: row.elapsedMinutes, planned: row.plannedMinutes });
            else
                evidence.excluded[row.reason]++;
            if (evidence.rows.length < (options.limit ?? 20))
                evidence.rows.push({ id: item.id, ...row });
        }
        const after = certifyCompleteListResult(await client.listAllComplete()).items;
        if (JSON.stringify(corpus) !== JSON.stringify(after))
            return refusal("tracker_changed", "Tracker changed during calibration.", "Retry against a stable tracker or a read-only copy.");
        for (const snapshot of snapshots) {
            if ((await historySnapshot(pmRoot, snapshot.id)).raw !== snapshot.raw)
                return refusal("tracker_changed", "History changed during calibration.", "Retry against a stable tracker or a read-only copy.");
        }
        evidence.sampleCount = accepted.length;
        if (accepted.length < options.minimumSamples)
            return refusal("insufficient_samples", "Verified episodes do not meet the declared sample minimum.", "Collect more verified starts/completions with positive start estimates, or explicitly declare a smaller evidence floor after reviewing exclusions.", evidence);
        const elapsed = accepted.map((row) => row.elapsed).sort((a, b) => a - b);
        const planned = accepted.map((row) => row.planned).sort((a, b) => a - b);
        const ratios = accepted.map((row) => row.elapsed / row.planned).sort((a, b) => a - b);
        const quantiles = (options.quantiles ?? [0.1, 0.5, 0.9]).map((probability) => {
            const index = Math.max(0, Math.ceil(probability * accepted.length) - 1);
            return { probability, elapsedMinutes: elapsed[index], plannedMinutes: planned[index], elapsedToPlannedRatio: ratios[index] };
        });
        return { ok: true, evidence, distribution: { kind: "empirical", values: elapsed }, quantiles,
            receipt: { version: 1, method: "verified-single-episode-nearest-rank-v1", inputHash: createHash("sha256").update(JSON.stringify({ options: { type: options.type, tag: options.tag ?? null }, hashes })).digest("hex"),
                type: options.type, tag: options.tag ?? null, unit: "elapsed_calendar_minutes",
                assumptions: ["current exact type/tag cohort; class must match at start", "one equally weighted verified episode per item", "whole-item exclusion after cancellation or reopening", "elapsed time includes waits, blocking and nonworking time", "positive planned estimate recorded at start", "marginal nearest-rank quantiles; ratio computed per item", "no causal productivity or confidence claim", "explicit scenario adoption only; estimates unchanged"] } };
    }
    catch {
        return refusal("corpus_unavailable", "Complete tracker or history evidence could not be read.", "Verify tracker initialization, readability and SDK completeness; retry on a stable copy. No calibration was produced.");
    }
}
//# sourceMappingURL=calibration.js.map