import type { PmItem, PrerequisiteGraph } from "./index.ts";
/** Declared effort in minutes; a bounded pair is shorthand for uniform sampling. */
export type UncertainEstimate = readonly [number, number] | {
    kind: "point";
    minutes: number;
} | {
    kind: "empirical";
    values: readonly number[];
} | {
    kind: "uniform";
    min: number;
    max: number;
} | {
    kind: "triangular";
    min: number;
    mode: number;
    max: number;
};
/** Explicit, bounded controls; tracker point estimates are used only when not overridden. */
export interface CompletionIntervalOptions {
    from: string;
    seed: number;
    estimates?: Readonly<Record<string, UncertainEstimate>>;
    samples?: number;
    quantiles?: readonly number[];
    minutesPerDay?: number;
    limit?: number;
}
/** Canonical distribution stored in the receipt, or null for unknown effort. */
export type ResolvedEstimate = Exclude<UncertainEstimate, readonly [number, number]> | null;
/** Complete replay inputs; contains no titles, bodies, wall clock or local paths. */
export interface CompletionScenarioReceipt {
    version: 1;
    algorithm: "mulberry32-nearest-rank-v1";
    inputHash: string;
    from: string;
    seed: number;
    samples: number;
    quantiles: number[];
    minutesPerDay: number;
    assumptions: readonly string[];
    tasks: {
        id: string;
        prerequisites: string[];
        estimate: ResolvedEstimate;
    }[];
}
/** Completion is exclusive, measured from the UTC anchor in continuous calendar days. */
export interface CompletionQuantile {
    probability: number;
    days: number;
    finish: string;
}
/** Actionable refusals distinguish malformed controls, graph defects and work bounds. */
export type CompletionIntervalRefusalCode = "invalid_estimate" | "invalid_graph" | "scenario_too_large";
/** Bounded rows plus complete replay inputs; unknown project finish has no sensitivity claim. */
export type CompletionIntervalResult = {
    ok: false;
    code: CompletionIntervalRefusalCode;
    message: string;
    remedy: string;
} | {
    ok: true;
    complete: boolean;
    activeCount: number;
    unknownCount: number;
    unknownEstimateCount: number;
    project: CompletionQuantile[] | null;
    items: {
        id: string;
        completion: CompletionQuantile[] | null;
        reason: "unknown_estimate" | "unknown_prerequisite" | null;
    }[];
    sensitivity: {
        id: string;
        correlation: number;
    }[];
    dominantEstimate: string | null;
    sensitivityMethod: "pearson-duration-project-finish";
    itemCount: number;
    sensitivityCount: number;
    truncated: boolean;
    receipt: CompletionScenarioReceipt;
};
/**
 * Sample declared independent effort over the SDK execution order. Ordering has
 * already been normalized by the package's registry-aware graph adapter. Completed
 * prerequisites are satisfied; unknown effort propagates through every successor.
 * Sampling is O(samples * (items + edges)), with no shared-resource/calendar model.
 */
export declare function simulateCompletionIntervals(rawCorpus: readonly PmItem[], rawOptions: CompletionIntervalOptions, suppliedGraph?: PrerequisiteGraph): CompletionIntervalResult;
/** Internal CLI adapter consumes an immutable schema receipt; untrusted callers use the public sampler. */
export declare function runValidatedIntervals(receipt: unknown, suppliedGraph?: PrerequisiteGraph): CompletionIntervalResult;
//# sourceMappingURL=uncertainty.d.ts.map