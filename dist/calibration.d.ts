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
    rows: {
        id: string;
        reason: DurationExclusion | null;
        elapsedMinutes?: number;
        plannedMinutes?: number;
    }[];
    truncated: boolean;
}
/** Failures include remedies and, after scanning, every exclusion count. */
export type DurationCalibrationRefusalCode = "invalid_calibration" | "corpus_unavailable" | "calibration_too_large" | "tracker_changed" | "insufficient_samples";
/** An empirical population: each accepted item contributes exactly one equally weighted observation. */
export type DurationCalibrationResult = {
    ok: false;
    code: DurationCalibrationRefusalCode;
    message: string;
    remedy: string;
    evidence?: DurationCalibrationEvidence;
} | {
    ok: true;
    evidence: DurationCalibrationEvidence;
    distribution: {
        kind: "empirical";
        values: number[];
    };
    quantiles: {
        probability: number;
        elapsedMinutes: number;
        plannedMinutes: number;
        elapsedToPlannedRatio: number;
    }[];
    receipt: {
        version: 1;
        method: "verified-single-episode-nearest-rank-v1";
        inputHash: string;
        type: string;
        tag: string | null;
        unit: "elapsed_calendar_minutes";
        assumptions: string[];
    };
};
/**
 * Calibrate from complete SDK reads and hash-verified item histories. No writes,
 * journals, locks or git subprocesses are used. Optimistic second reads refuse
 * mixed revisions, including history-only changes, instead of caching stale work.
 */
export declare function calibrateObservedDurations(pmRoot: string, options: DurationCalibrationOptions): Promise<DurationCalibrationResult>;
//# sourceMappingURL=calibration.d.ts.map