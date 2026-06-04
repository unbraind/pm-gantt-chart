import type { ExtensionApi } from "@unbrained/pm-cli/sdk";
interface PmDependency {
    id: string;
    kind?: string;
    created_at?: string;
}
interface PmItem {
    id: string;
    title: string;
    body?: string;
    status: "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft";
    priority?: string | number;
    type?: string;
    tags?: string[];
    meta?: Record<string, unknown>;
    due_date?: string;
    deadline?: string;
    milestone?: string;
    sprint?: string;
    release?: string;
    assignee?: string;
    estimated_minutes?: number;
    dependencies?: PmDependency[];
    created_at?: string;
}
type GroupBy = "milestone" | "sprint" | "release" | "tag" | "type" | "assignee" | "status";
type StatusFilter = "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft" | "all";
interface GanttOptions {
    weeks: number;
    groupBy: GroupBy;
    statusFilter: StatusFilter;
    today: Date;
    criticalPath: boolean;
    criticalOnly: boolean;
    schedule: boolean;
    defaultDuration: number;
}
interface GanttRow {
    group: string;
    item: PmItem;
    startWeek: number | null;
    endWeek: number | null;
    critical: boolean;
    start: Date | null;
    end: Date | null;
    slackDays: number | null;
    infeasible: boolean;
}
declare function getGroupKey(item: PmItem, groupBy: GroupBy): string;
/**
 * Compute the critical path: the longest chain of dependency edges across the
 * given items. Edges point from an item to each of its `dependencies[].id`
 * (i.e. "depends on" / "blocked-by"), so the chain is ordered prerequisite →
 * dependent. Cycles are guarded against. Returns the set of item ids that lie
 * on the longest chain (ties resolved by the chain whose final node has the
 * latest deadline, then by lexical id for determinism).
 */
declare function computeCriticalPath(items: PmItem[]): Set<string>;
interface ScheduleEntry {
    start: Date;
    end: Date;
    durationDays: number;
}
/**
 * Derive an item's duration in whole days from its estimate, falling back to
 * `defaultDays`. `estimated_minutes` is the pm-canonical estimate field; it is
 * converted via an 8h working day and rounded up to at least one day.
 */
declare function itemDurationDays(item: PmItem, defaultDays: number): number;
/**
 * Forward-schedule items from `anchor`, honoring `blocked_by` dependencies:
 * an item cannot start until every prerequisite it depends on has finished.
 * Items with a `deadline` but no scheduling pressure are pulled so they END on
 * their deadline (back-anchored) when that is later than the dependency-driven
 * start; otherwise the dependency chain wins (a late chain can push past a
 * deadline, which is exactly what a schedule should surface).
 *
 * Returns a map of item id → { start, end, durationDays }. Cycles are
 * broken deterministically (a node already on the recursion stack contributes
 * no constraint, mirroring the critical-path cycle guard). Exported for tests.
 */
declare function computeSchedule(items: PmItem[], anchor: Date, defaultDays: number): Map<string, ScheduleEntry>;
interface SlackEntry {
    /** Total slack in whole days: how long the item can slip without delaying
     * the project (or breaching a downstream deadline). 0 = critical. */
    slackDays: number;
    /** Latest start the item can begin without delaying the project / a deadline. */
    latestStart: Date;
    /** Latest finish (inclusive last work day) consistent with downstream deadlines. */
    latestFinish: Date;
    /** True when the latest feasible start is BEFORE the forward-pass earliest
     * start — i.e. the plan is already late for a downstream deadline. */
    infeasible: boolean;
}
/**
 * Compute total slack/float for every scheduled item via a backward pass over
 * the dependency graph (CPM). The forward pass (`computeSchedule`) gives each
 * item's earliest start/finish (ES/EF). This computes the latest start/finish
 * (LS/LF):
 *
 *   - successors(node) = items that list `node` as a (gating) dependency.
 *   - A node's latest finish is the day before the earliest latest-start of any
 *     of its successors, and never later than the project's latest finish.
 *   - A node with its OWN `deadline` is additionally capped so it finishes on or
 *     before that deadline.
 *   - The project's latest finish is the maximum forward-pass EF across all
 *     items (the computed project end) — leaves with no deadline simply inherit
 *     it, giving them 0 slack only if they actually end the project.
 *
 * total slack = latestStart − earliestStart (in whole days). Items on the
 * critical path have ~0 slack. `infeasible` flags items whose latest feasible
 * start is before their earliest possible start (the deadline cannot be met).
 *
 * Exported for tests.
 */
declare function computeSlack(items: PmItem[], schedule: Map<string, ScheduleEntry>): Map<string, SlackEntry>;
declare function buildRows(items: PmItem[], opts: GanttOptions, windowStart: Date): GanttRow[];
declare function renderGantt(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
declare function renderMermaid(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
/**
 * Render rows as a CSV schedule:
 * id,title,start,end,duration_days,slack_days,deps,status.
 * `start`/`end` use the row's computed bounds (scheduler- or date-derived);
 * `duration_days` is the inclusive day span, blank when undated. `slack_days`
 * is the backward-pass total float (only populated under `--schedule`; blank
 * otherwise) — 0 marks a critical-path item, negative means the plan is already
 * late for a downstream deadline. `deps` is a space-separated list of blocking
 * dependency ids. Exported for tests.
 */
declare function renderCsv(rows: GanttRow[]): string;
interface GanttSummary {
    /** Earliest start across all dated rows (null when none are dated). */
    projectStart: Date | null;
    /** Latest end across all dated rows (null when none are dated). */
    projectEnd: Date | null;
    /** Calendar span in days from projectStart..projectEnd inclusive (0 if undated). */
    spanDays: number;
    /** Number of items on the critical path. */
    criticalPathLength: number;
    /** Sum of every row's inclusive duration in days. */
    totalTaskDays: number;
    /** Per-group total task-days (e.g. per-assignee workload), sorted descending. */
    workload: {
        group: string;
        days: number;
    }[];
}
/** Compute the footer summary stats shared by the HTML export. */
declare function computeSummary(rows: GanttRow[]): GanttSummary;
declare function renderHtml(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
interface ResolvedOptions extends GanttOptions {
    windowStart: Date;
}
declare function resolveGanttOptions(options: Record<string, unknown>): ResolvedOptions;
/**
 * Collect infeasible-deadline warnings from scheduled rows. A row is infeasible
 * when its backward-pass latest-feasible start is before its earliest possible
 * start — the plan is already late for a downstream deadline. Returns one
 * human-readable line per affected item (empty when none / not scheduling).
 */
declare function infeasibleWarnings(rows: GanttRow[]): string[];
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
export { computeSchedule, computeSlack, computeCriticalPath, computeSummary, itemDurationDays, renderCsv, renderMermaid, renderGantt, renderHtml, infeasibleWarnings, buildRows, resolveGanttOptions, getGroupKey, };
export type { PmItem, GanttOptions, GanttRow, GroupBy, ScheduleEntry, SlackEntry, GanttSummary };
//# sourceMappingURL=index.d.ts.map