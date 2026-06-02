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
declare function buildRows(items: PmItem[], opts: GanttOptions, windowStart: Date): GanttRow[];
declare function renderMermaid(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
/**
 * Render rows as a CSV schedule: id,title,start,end,duration_days,deps,status.
 * `start`/`end` use the row's computed bounds (scheduler- or date-derived);
 * `duration_days` is the inclusive day span, blank when undated. `deps` is a
 * space-separated list of blocking dependency ids. Exported for tests.
 */
declare function renderCsv(rows: GanttRow[]): string;
interface ResolvedOptions extends GanttOptions {
    windowStart: Date;
}
declare function resolveGanttOptions(options: Record<string, unknown>): ResolvedOptions;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
export { computeSchedule, computeCriticalPath, itemDurationDays, renderCsv, renderMermaid, buildRows, resolveGanttOptions, getGroupKey, };
export type { PmItem, GanttOptions, GanttRow, GroupBy, ScheduleEntry };
//# sourceMappingURL=index.d.ts.map