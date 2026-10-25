import type { PmItem, PrerequisiteGraph } from "./index.ts";
/** A civil-day calendar: weekday numbers follow ISO (Monday=1, Sunday=7). */
export interface ResourceCalendar {
    weekdays: readonly number[];
    holidays: readonly string[];
    minutesPerDay: number;
    minutesPerWeek: number;
    totalMinutes: number;
}
/** An explicitly named alternative with shared assignee budgets and optional work overrides. */
export interface ResourceAlternative {
    id: string;
    owners: Readonly<Record<string, ResourceCalendar>>;
    work?: Readonly<Record<string, {
        owner: string;
        minutes: number;
    }>>;
}
/** Inclusive civil-day horizon in one explicit IANA zone; no host-clock defaults. */
export interface ResourceScenarioOptions {
    from: string;
    through: string;
    timeZone: string;
    scenarios: readonly ResourceAlternative[];
    limit?: number;
}
/** Actionable failures keep invalid/unknown input separate from measured capacity shortfalls. */
export type ResourceRefusalCode = "invalid_estimate" | "invalid_scenario" | "invalid_graph" | "missing_work" | "scenario_too_large" | "selection_required" | "revision_conflict" | "infeasible_selection" | "application_refused";
/** All refusal results include a concrete way to proceed. */
export interface ResourceRefusal {
    ok: false;
    code: ResourceRefusalCode;
    message: string;
    remedy: string;
}
/** Aggregated row: work can be preempted across civil days, and finish is inclusive. */
export interface ResourceScheduleRow {
    id: string;
    owner: string;
    minutes: number;
    allocatedMinutes: number;
    start: string | null;
    finish: string | null;
}
/** A necessary capacity bound; required > available is a proof, independent of allocation order. */
export interface ResourceWitness {
    owner: string;
    requiredMinutes: number;
    availableMinutes: number;
    deficitMinutes: number;
}
/** Successful computation may contain infeasible alternatives; limits never hide total counts. */
export interface ResourceScenarioSuccess {
    ok: true;
    revision: string;
    activeCount: number;
    assumptions: readonly string[];
    scenarios: {
        id: string;
        selection: string;
        feasible: boolean;
        outcome: "feasible" | "capacity_infeasible" | "allocation_exhausted";
        remainingMinutes: number;
        itemCount: number;
        truncated: boolean;
        items: ResourceScheduleRow[];
        witnesses: ResourceWitness[];
    }[];
}
/** SDK result suitable for native TOON or JSON serialization by the host. */
export type ResourceScenarioResult = ResourceScenarioSuccess | ResourceRefusal;
/**
 * Compare bounded explicit resource alternatives using the SDK execution kernel.
 * The allocator shares each owner's daily/weekly/total budget, preempts work at
 * day boundaries and releases successors on the next civil day. Stable id order
 * is a reproducible heuristic, not an optimal resource-leveling claim. Capacity
 * witnesses are necessary bounds; exhaustion alone is not an impossibility proof.
 */
export declare function computeResourceScenarios(rawCorpus: readonly PmItem[], rawOptions: ResourceScenarioOptions, suppliedGraph?: PrerequisiteGraph): ResourceScenarioResult;
/** Internal command adapter consumes the same immutable validation receipt as the public SDK. */
export declare function runValidatedResources(receipt: unknown, suppliedGraph?: PrerequisiteGraph): ResourceScenarioResult;
/** Explicit selection binds both the current source snapshot and the target item's optimistic revision. */
export interface ResourceSelection {
    scenarioId: string;
    selection: string;
    expectedRevision: string;
    targetId: string;
    targetRevision: string;
}
/**
 * Record a chosen feasible snapshot as a core note, without editing item dates.
 * Recompute against a fresh certified read before calling. The SDK checks the
 * target updated_at under its item lock, journals the mutation and preserves
 * history. Source revision identifies the read snapshot, not a future lock on
 * every source item; later changes require a new evaluation and selection.
 */
export declare function applyResourceSelection(pmRoot: string, author: string, result: ResourceScenarioResult, choice: ResourceSelection): Promise<{
    ok: true;
    targetId: string;
    scenarioId: string;
    revision: string;
} | ResourceRefusal>;
//# sourceMappingURL=resources.d.ts.map