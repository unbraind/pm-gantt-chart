import { DurationInputError, requireDurationInput, validateDurationInput } from "./duration-input.ts";
import { createHash } from "node:crypto";
import { applyHistoryPatch, certifyCompleteListResult, isPmCliExpectedError, getHistoryPath, locateItem, PmClient, readHistorySnapshot, readLocatedItem, readSettings, replayHistoryToTarget, resolveItemTypeRegistry, resolveCompletionTimestamp, getActiveExtensionRegistrations, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";

/** Explicit cohort and evidence floor; all durations are elapsed UTC calendar minutes. */
export interface DurationCalibrationOptions {
  type: string;
  tag?: string;
  minimumSamples: number;
  quantiles?: readonly number[];
  limit?: number;
}

/** Mutually exclusive exclusions; conservative whole-item rejection avoids episode selection bias. */
export type DurationExclusion = "unverified_history" | "reopened" | "canceled" | "incomplete" | "missing_start" | "missing_estimate" | "class_changed" | "invalid_duration";

/** Complete counts with bounded evidence rows; diagnostic truncation never affects the distribution. */
export interface DurationCalibrationEvidence {
  selectedCount: number;
  sampleCount: number;
  minimumSamples: number;
  excluded: Record<DurationExclusion, number>;
  rows: { id: string; reason: DurationExclusion | null; elapsedMinutes?: number; plannedMinutes?: number }[];
  truncated: boolean;
}

/** Failures include remedies and, after scanning, every exclusion count. */
export type DurationCalibrationRefusalCode = "invalid_estimate" | "corpus_unavailable" | "calibration_too_large" | "tracker_changed" | "insufficient_samples";

/** An empirical population: each accepted item contributes exactly one equally weighted observation. */
export type DurationCalibrationResult =
  | { ok: false; code: DurationCalibrationRefusalCode; message: string; remedy: string; evidence?: DurationCalibrationEvidence }
  | { ok: true; evidence: DurationCalibrationEvidence;
      distribution: { kind: "empirical"; values: number[] };
      quantiles: { probability: number; elapsedMinutes: number; plannedMinutes: number; elapsedToPlannedRatio: number }[];
      receipt: { version: 1; method: "verified-single-episode-nearest-rank-v1"; inputHash: string; type: string; tag: string | null; unit: "elapsed_calendar_minutes"; assumptions: string[] } };

type History = Awaited<ReturnType<typeof readHistorySnapshot>>["entries"];
type Metadata = Record<string, unknown>;

/** Unreadable foreign streams are excluded without exposing or repairing their contents. */
async function historySnapshot(pmRoot: string, id: string) {
  try { return await readHistorySnapshot(getHistoryPath(pmRoot, id), id); }
  catch { return { raw: undefined, entries: [] as History }; }
}

/** Exact current classification; no fuzzy title search or implicit selection. */
function matches(item: { type?: string; tags?: readonly string[] }, options: DurationCalibrationOptions): boolean {
  return item.type === options.type && (options.tag === undefined || (item.tags?.includes(options.tag) === true));
}

/** Build typed refusals without exposing tracker paths or raw history content. */
function refusal(code: DurationCalibrationRefusalCode, message: string, remedy: string, evidence?: DurationCalibrationEvidence): DurationCalibrationResult {
  return { ok: false, code, message, remedy, ...(evidence === undefined ? {} : { evidence }) };
}

/**
 * Read lifecycle state using the SDK patch kernel after full verified replay.
 * Imported/checkpoint snapshots are not starts; reopening or cancellation rejects
 * the entire item, including earlier completed work. Blocking stays in elapsed time.
 */
function episode(history: History, options: DurationCalibrationOptions): { reason: DurationExclusion | null; elapsedMinutes?: number; plannedMinutes?: number } {
  replayHistoryToTarget(history, history.length - 1);
  let state = { metadata: {} as Metadata, body: "" };
  let start: { at: number; minutes: number | undefined; matching: boolean } | undefined;
  let end: number | undefined;
  let canceled = false, reopened = false, terminal = false, previousTime = -Infinity;
  for (const entry of history) {
    const before = state.metadata.status;
    state = applyHistoryPatch(state, entry.patch, 1, entry.op);
    const after = state.metadata.status;
    const point = requireDurationInput("historyPoint", { type: state.metadata.type, tags: state.metadata.tags, at: entry.ts, minutes: state.metadata.estimated_minutes, completed_at: state.metadata.completed_at, closed_at: state.metadata.closed_at });
    const at = Date.parse(point.at);
    if (at < previousTime) return { reason: "unverified_history" };
    previousTime = at;
    if (after === "canceled") canceled = true;
    if (terminal && after !== "closed" && after !== "canceled") reopened = true;
    if (after === "closed" || after === "canceled") terminal = true;
    if (after === "in_progress" && before !== "in_progress" && before !== undefined && entry.op === "update" && start === undefined) {
      start = { at, minutes: point.minutes, matching: matches(point, options) };
    }
    if (after === "closed" && before !== "closed" && (entry.op === "close" || entry.op === "update")) {
      // Actual completion is canonical when available; never infer it from later edits.
      const completion = resolveCompletionTimestamp({
        completed_at: point.completed_at,
        closed_at: point.closed_at,
        updated_at: entry.ts,
      });
      end = Date.parse(String(completion.timestamp));
    }
  }
  if (reopened) return { reason: "reopened" };
  if (canceled) return { reason: "canceled" };
  if (state.metadata.status !== "closed") return { reason: "incomplete" };
  if (start === undefined || end === undefined) return { reason: "missing_start" };
  if (!start.matching) return { reason: "class_changed" };
  if (start.minutes === undefined || start.minutes === 0) return { reason: "missing_estimate" };
  const elapsedMinutes = (end - start.at) / 60000;
  if (!validateDurationInput("elapsed", elapsedMinutes).ok) return { reason: "invalid_duration" };
  return { reason: null, elapsedMinutes, plannedMinutes: start.minutes };
}

/**
 * Calibrate from complete SDK reads and hash-verified item histories. No writes,
 * journals, locks or git subprocesses are used. Optimistic second reads refuse
 * mixed revisions, including history-only changes, instead of caching stale work.
 */
export async function calibrateObservedDurations(pmRoot: string, rawOptions: DurationCalibrationOptions): Promise<DurationCalibrationResult> {
  const validated = validateDurationInput("calibration", rawOptions);
  if (!validated.ok) return validated;
  const options = validated.value;
  const client = PmClient.forActiveExtensionHost({ pmRoot });
  try {
    const corpus = requireDurationInput("corpus", certifyCompleteListResult(await client.listAllComplete()).items);
    const selected = corpus.filter((item) => matches(item, options)).sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
    if (selected.length > 2000) return refusal("calibration_too_large", "Selected cohort exceeds 2000 items.", "Select a narrower exact type/tag cohort with at most 2000 items.");
    const settings = await readSettings(pmRoot);
    const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const evidence: DurationCalibrationEvidence = { selectedCount: selected.length, sampleCount: 0, minimumSamples: options.minimumSamples,
      excluded: { unverified_history: 0, reopened: 0, canceled: 0, incomplete: 0, missing_start: 0, missing_estimate: 0, class_changed: 0, invalid_duration: 0 }, rows: [], truncated: selected.length > (options.limit ?? 20) };
    const snapshots: { id: string; raw: string | null | undefined }[] = [];
    const accepted: { elapsed: number; planned: number }[] = [];
    const hashes: { id: string; historyHash: string }[] = [];
    let entries = 0;
    for (const item of selected) {
      const snapshot = await historySnapshot(pmRoot, item.id);
      snapshots.push({ id: item.id, raw: snapshot.raw });
      entries += snapshot.entries.length;
      if (snapshot.entries.length > 10000 || entries > 100000) return refusal("calibration_too_large", "History exceeds the replay budget.", "Select a cohort with at most 10000 entries per item and 100000 entries in total; preserve original histories.");
      let row: ReturnType<typeof episode> = { reason: "unverified_history" };
      try {
        const located = await locateItem(pmRoot, item.id, settings.id_prefix, settings.item_format, registry.type_to_folder);
        if (located !== null && snapshot.entries.length > 0) {
          const { document } = await readLocatedItem(located, { schema: settings.schema });
          if (verifyHistoryEntries(snapshot.entries, document).ok) row = episode(snapshot.entries, options);
        }
      } catch (error) {
        if (error instanceof DurationInputError) return error.refusal;
        // A foreign, corrupt or unsupported stream is disclosed, never repaired.
      }
      hashes.push({ id: item.id, historyHash: createHash("sha256").update(snapshot.raw === undefined ? "unreadable" : snapshot.raw ?? "").digest("hex") });
      if (row.reason === null) accepted.push({ elapsed: row.elapsedMinutes!, planned: row.plannedMinutes! });
      else evidence.excluded[row.reason]++;
      if (evidence.rows.length < (options.limit ?? 20)) evidence.rows.push({ id: item.id, ...row });
    }
    const after = certifyCompleteListResult(await client.listAllComplete()).items;
    if (JSON.stringify(corpus) !== JSON.stringify(after)) return refusal("tracker_changed", "Tracker changed during calibration.", "Retry against a stable tracker or a read-only copy.");
    for (const snapshot of snapshots) {
      if ((await historySnapshot(pmRoot, snapshot.id)).raw !== snapshot.raw) return refusal("tracker_changed", "History changed during calibration.", "Retry against a stable tracker or a read-only copy.");
    }
    evidence.sampleCount = accepted.length;
    if (accepted.length < options.minimumSamples) return refusal("insufficient_samples", "Verified episodes do not meet the declared sample minimum.", "Collect more verified starts/completions with positive start estimates, or explicitly declare a smaller evidence floor after reviewing exclusions.", evidence);
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
  } catch (error) {
    if (error instanceof DurationInputError) return error.refusal;
    if (isPmCliExpectedError(error) && error.code === "list_source_incomplete") return new DurationInputError("corpus").refusal;
    return refusal("corpus_unavailable", "Complete tracker or history evidence could not be read.", "Verify tracker initialization, readability and SDK completeness; retry on a stable copy. No calibration was produced.");
  }
}
