import { resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { type PmItem, type PrerequisiteGraph } from "./index.ts";
import { type ResourceCalendar, type ResourceScenarioOptions } from "./resources.ts";
/** Scheduling projection only: native status roles are resolved by the SDK at capture time. */
export interface ScheduleTask {
    id: string;
    status: string;
    role: "active" | "terminal" | "unknown";
    owner?: string;
    minutes?: number;
    prerequisites: readonly string[];
    deadline?: string;
}
/** Portable saved engine inputs, without titles, bodies, paths, capture times or cached computed dates. */
export interface ScheduleSnapshot {
    version: 1;
    from: string;
    through: string;
    timeZone: string;
    tasks: readonly ScheduleTask[];
    owners: Readonly<Record<string, ResourceCalendar>>;
}
/** Output row limit; computations always use the entire bounded pair. */
export interface ScheduleDriftOptions {
    limit?: number;
}
/** Strict input and work-budget refusals carry a recovery action. */
export interface ScheduleDriftRefusal {
    ok: false;
    code: "invalid_estimate" | "invalid_scenario" | "comparison_too_large";
    message: string;
    remedy: string;
}
/** Unsupported evidence remains explicit and never becomes an attributed cause. */
export interface ScheduleGap {
    code: string;
    ids: string[];
    remedy: string;
}
/** A reversible scheduling input change; unchanged changes are not listed as causes. */
export interface ScheduleChange {
    id: string;
    kind: "estimate" | "owner" | "calendar" | "prerequisites";
    target: string;
    before: string | number | readonly string[] | ResourceCalendar | null;
    after: string | number | readonly string[] | ResourceCalendar | null;
}
/** A counterfactual witness, not an additive share of the overall date delta. */
export interface ScheduleCause {
    change: string;
    restoredFinish: string | null;
    effectDays: number | null;
    chain: string[];
}
/** Each moved goal retains its exact civil-day delta and the witnessed causal routes. */
export interface ScheduleMovedRow {
    id: string;
    before: string | null;
    after: string | null;
    deltaDays: number | null;
    causes: ScheduleCause[];
    gaps: string[];
}
/** Compact agent output keeps unchanged rows as references to the earlier snapshot. */
export interface ScheduleDriftSuccess {
    ok: true;
    before: string;
    after: string;
    method: "individual-reversal-v1";
    evaluations: number;
    counts: {
        tasks: number;
        moved: number;
        unchanged: number;
        gaps: number;
        returned: number;
    };
    truncated: boolean;
    unchanged: {
        snapshot: string;
        ids: string[];
    };
    changes: ScheduleChange[];
    moved: ScheduleMovedRow[];
    gaps: ScheduleGap[];
}
/** Public read-only comparison contract. */
export type ScheduleDriftResult = ScheduleDriftSuccess | ScheduleDriftRefusal;
/** Validate imported JSON values with the exact schema used by the snapshot producer. */
export declare function validateScheduleSnapshot(raw: unknown): import("./duration-input.ts").DurationInputResult<ScheduleSnapshot>;
/** Capture one explicit alternative using configured status roles and resolved prerequisite ordering. */
export declare function captureScheduleScenario(items: readonly (Omit<PmItem, "status"> & {
    status: string;
})[], options: ResourceScenarioOptions, registry: ReturnType<typeof resolveRuntimeStatusRegistry>, graph?: PrerequisiteGraph): {
    ok: true;
    snapshot: ScheduleSnapshot;
} | ScheduleDriftRefusal;
/** Compare two saved scenarios; individual reversals witness causes, never infer them from correlation. */
export declare function explainScheduleDrift(rawBefore: ScheduleSnapshot, rawAfter: ScheduleSnapshot, rawOptions?: ScheduleDriftOptions): ScheduleDriftResult;
//# sourceMappingURL=drift.d.ts.map