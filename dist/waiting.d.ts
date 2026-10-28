import { type RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { type PmItem, type PrerequisiteGraph } from "./index.ts";
/** One explicitly declared external wait after effort; absent bounds remain unknown. */
export interface ExternalWait {
    minMinutes?: number;
    maxMinutes?: number;
}
/** Preview declarations are local inputs, never tracker mutations or reservations. */
export interface EffortWaitingOptions {
    waits: Readonly<Record<string, ExternalWait>>;
    limit?: number;
}
/** Scheduling fields accept configured status names without restricting the native registry. */
export type EffortWaitingItem = Omit<PmItem, "status"> & {
    status: string;
};
/** Null is unknown, including an unknown predecessor; zero always means explicit zero. */
export interface EffortWaitingRow {
    id: string;
    effortMinutes: number | null;
    declaredWait: boolean;
    waitMinMinutes: number | null;
    waitMaxMinutes: number | null;
    elapsedMinMinutes: number | null;
    elapsedMaxMinutes: number | null;
    finishMinMinutes: number | null;
    finishMaxMinutes: number | null;
    role: "active" | "blocked" | "unknown";
}
/** Refusals are actionable and never contain a partial successful forecast. */
export interface EffortWaitingRefusal {
    ok: false;
    code: "invalid_estimate" | "invalid_graph" | "invalid_wait_target" | "preview_too_large" | "corpus_unavailable";
    message: string;
    remedy: string;
}
/** Counts cover all nonterminal work even when the returned rows are truncated. */
export type EffortWaitingResult = EffortWaitingRefusal | {
    ok: true;
    activeCount: number;
    waitingCount: number;
    unknownCount: number;
    knownEffortMinutes: number;
    totalEffortMinutes: number | null;
    finishMinMinutes: number | null;
    finishMaxMinutes: number | null;
    truncated: boolean;
    items: EffortWaitingRow[];
    assumptions: string[];
};
/**
 * Separate capacity effort from serial external waits, then propagate elapsed
 * bounds through the SDK ordering kernel. This continuous-minute lower-bound
 * model does not allocate shared owners or decide core readiness.
 */
export declare function effortWaitingPreview(items: readonly EffortWaitingItem[], options: EffortWaitingOptions, registry: RuntimeStatusRegistry, suppliedGraph?: PrerequisiteGraph): EffortWaitingResult;
/** Read a certified native corpus through the supported host context, only when preview is requested. */
export declare function previewEffortWaiting(pmRoot: string, options: EffortWaitingOptions): Promise<EffortWaitingResult>;
//# sourceMappingURL=waiting.d.ts.map