import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
interface PmDependency {
    id: string;
    kind?: string;
    created_at?: string;
}
/** Core lifecycle states the renderer can order and encode consistently. */
declare const PM_ITEM_STATUSES: readonly ["open", "in_progress", "blocked", "closed", "canceled", "draft"];
/** Runtime-validated lifecycle state accepted from `pm list-all`. */
type PmItemStatus = (typeof PM_ITEM_STATUSES)[number];
interface PmItem {
    id: string;
    title: string;
    body?: string;
    status: PmItemStatus;
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
/** A fixed deadline/release date drawn as a labeled vertical marker on the
 *  timeline. Parsed from `--milestones "name=YYYY-MM-DD,..."`. `date` is the
 *  local-midnight Date the milestone lands on. */
interface Milestone {
    name: string;
    date: Date;
}
interface GanttOptions {
    weeks: number;
    groupBy: GroupBy;
    statusFilter: StatusFilter;
    today: Date;
    criticalPath: boolean;
    criticalOnly: boolean;
    schedule: boolean;
    defaultDuration: number;
    progress: boolean;
    width: number;
    milestones: Milestone[];
}
/** Why a row has no in-window bar.
 *  - "undated": the item carries no start/end at all (genuinely unscheduled).
 *  - "before":  the item's dates fall entirely BEFORE the chart window (earlier).
 *  - "after":   the item's dates fall entirely AFTER the chart window (later).
 */
type OffWindow = "undated" | "before" | "after";
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
    progress: number;
    overdue: boolean;
    /** When startWeek is null, WHY: genuinely undated, or off-window before/after.
     *  null when the row does have an in-window bar (startWeek !== null). */
    offWindow: OffWindow | null;
}
/**
 * Parse the `--milestones` flag: a comma-separated list of `name=YYYY-MM-DD`
 * entries (e.g. `v1.0=2026-06-30,v1.1=2026-08-15`). Returns the parsed list
 * (empty when the flag is absent/blank). Throws a CommandError (USAGE) on any
 * malformed entry — missing `=`, empty name, or an unparseable/non-ISO date —
 * rather than crashing. Exported for tests.
 */
export declare function parseMilestones(raw: unknown): Milestone[];
/**
 * 0-based week column a milestone lands in for the given window, or -1 when the
 * milestone falls outside the rendered window. Mirrors the TODAY-marker math so
 * markers and items never disagree about column placement. Exported for tests.
 */
export declare function milestoneWeek(date: Date, windowStart: Date, weeks: number): number;
/**
 * Classify WHY an item has no in-window bar. `computeWeekRange` collapses two
 * very different cases to `null`: a genuinely undated item (no start/end at all)
 * and an item whose dates fall entirely OUTSIDE the chart window. Renderers used
 * to draw both as the same `··` "undated" glyph, which misled users. This
 * disambiguates them so off-window items can show a directional hint.
 *
 * Returns:
 *   - "undated" — no start and no end date.
 *   - "before"  — the item's (effective) span ends at/before the window start.
 *   - "after"   — the item's (effective) span starts at/after the window end.
 * Exported for tests. Mirrors computeWeekRange's effective-span derivation so
 * the two never disagree about overlap.
 */
export declare function classifyOffWindow(itemStart: Date | null, itemEnd: Date | null, windowStart: Date, totalWeeks: number): OffWindow;
/**
 * Derive a 0..100 completion ratio for an item from available pm signals,
 * deterministically:
 *   • closed / canceled            → 100 (work is finished/dropped from the plan)
 *   • a meta `progress`/`percent_complete` number (0..100 or 0..1) is honored verbatim
 *   • acceptance-criteria checklist (checked / total) from the body, when present
 *   • in_progress with no other signal → 50 (a sensible "halfway" default)
 *   • blocked                         → 25 (started but stalled)
 *   • everything else (open/draft)    → 0
 * Exported for tests.
 */
export declare function itemProgress(item: PmItem): number;
/**
 * An item is overdue when it has a deadline strictly before `today` AND is not
 * already closed or canceled. Exported for tests.
 */
export declare function isOverdue(item: PmItem, today: Date): boolean;
/**
 * Select the row-group key for `item` under the chosen {@link GroupBy} field.
 *
 * A missing value collapses to a parenthesized placeholder (`(no milestone)`,
 * `(unassigned)`, …) rather than an empty string, so unattributed items gather
 * into one named fallback bucket instead of scattering as blank-headed rows.
 * The `tag` field keys on only the first tag, since a Gantt group needs a single
 * column. `status` is the one field that is always present, so it has no
 * fallback.
 *
 * @param item - The pm item to classify.
 * @param groupBy - The grouping dimension selected via `--group-by`.
 * @returns The group label this item belongs under.
 */
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
/**
 * Outcome of the preflight data-sanity checks run before any chart is rendered.
 *
 * Split into hard failures that make scheduling impossible and must abort the
 * command, versus soft warnings that still yield a useful chart. The caller
 * decides how to act on each list; see {@link runDataSanityGate} for the
 * handler policy that turns a non-empty `fatal` into a thrown
 * {@link CommandError}.
 */
export interface DataSanityReport {
    /** Render-breaking problems. Non-empty ⇒ the command must hard-fail. */
    fatal: string[];
    /** Soft problems worth surfacing but which still allow a useful chart. */
    warnings: string[];
}
/**
 * Find every dependency cycle reachable through `dependencies[].id` edges
 * (an edge points item → prerequisite). Returns one human-readable path string
 * per distinct cycle, e.g. `A "Login" → B "API" → A "Login"`. Dangling
 * dependencies (ids not present in the item set) are ignored — they are a soft
 * concern handled elsewhere, not a cycle. Exported for tests.
 */
export declare function detectCycles(items: PmItem[]): string[];
/**
 * Run the preflight data-sanity checks over the items that will be charted.
 * Pure + deterministic; exported for tests. The caller decides what to do with
 * `fatal` (block) vs `warnings` (surface but proceed).
 */
export declare function dataSanityReport(items: PmItem[]): DataSanityReport;
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
/**
 * Turn the fetched items into render-ready {@link GanttRow} entries.
 *
 * Groups items by the configured field, sorts groups (named groups first, then
 * fallback buckets), and within each group sorts by {@link statusOrderValue}.
 * Per item it derives the bar bounds (scheduler-driven under `--schedule`,
 * otherwise `created_at`/deadline), the active week range via
 * {@link computeWeekRange}, completion via {@link itemProgress}, the overdue
 * flag, and — only when the item has no in-window bar — the off-window reason
 * via {@link classifyOffWindow}. `--critical-only` clips the input to the
 * longest dependency chain before any of the above runs.
 *
 * @param items - All fetched pm items (already status-filtered by the caller).
 * @param opts - The resolved chart options.
 * @param windowStart - The Monday that opens the chart window.
 * @returns One row per item, in render order.
 */
declare function buildRows(items: PmItem[], opts: GanttOptions, windowStart: Date): GanttRow[];
/**
 * Render the chart as a fixed-width ASCII table for the terminal.
 *
 * Lays out one column per week with a header, a `▼TODAY` marker in the current
 * week, labeled `▼<name>` milestone carets, and one row per item whose cells
 * carry status/critical/progress glyphs across the active week span. Off-window
 * and undated rows get directional or dotted hints instead of a bar, and a
 * trailing legend names every glyph used. All widths are hard-coded so the
 * table aligns in any monospace terminal.
 *
 * @param rows - The render-ready rows from {@link buildRows}.
 * @param opts - The resolved chart options.
 * @param windowStart - The Monday that opens the chart window.
 * @returns The complete ASCII chart as a newline-joined string.
 */
declare function renderGantt(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
/**
 * Render the chart as Mermaid `gantt` diagram source.
 *
 * Emits one `section` per group and one task per item, with `done`/`active`/
 * `crit` tags mapped from status plus a `crit` tag for critical-path and overdue
 * items. Mermaid's end dates are exclusive, so each inclusive row end is
 * advanced one day to keep durations honest; undated items get a one-week
 * placeholder so they still render. Numeric progress and the today line are
 * preserved as `%%` comments, since Mermaid has no native field for either.
 * In-window milestones are appended as native zero-duration `milestone` tasks.
 *
 * @param rows - The render-ready rows from {@link buildRows}.
 * @param opts - The resolved chart options.
 * @param windowStart - The Monday that opens the chart window.
 * @returns Valid Mermaid gantt source as a newline-joined string.
 */
declare function renderMermaid(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
/**
 * Render rows as a CSV schedule:
 * id,title,start,end,duration_days,slack_days,deps,status.
 * `start`/`end` use the row's computed bounds (scheduler- or date-derived);
 * `duration_days` is the inclusive day span, blank when undated. `slack_days`
 * is the backward-pass total float (only populated under `--schedule`; blank
 * otherwise) — 0 marks a critical-path item, negative means the plan is already
 * late for a downstream deadline. The trailing risk columns make CSV exports
 * directly usable for portfolio reporting: critical, progress_percent, overdue,
 * off_window. `deps` is a space-separated list of blocking dependency ids.
 *
 * Milestones (from `--milestones`) are appended as extra rows so the timeline's
 * fixed dates round-trip in the same table: `id` = `milestone:<name>`, `title`
 * = the milestone name, `start` = `end` = the milestone date, `status` =
 * `milestone`, all other columns blank. They sort after the item rows.
 * Exported for tests.
 */
declare function renderCsv(rows: GanttRow[], milestones?: Milestone[]): string;
/** The computed CPM schedule as structured JSON. Unlike the ASCII chart (a
 *  rendered string) or `pm --json gantt` (chart string + summary counts), this
 *  gives agents and programmatic consumers the per-item plan — start/end,
 *  duration, slack, progress, critical-path membership, overdue/infeasible
 *  flags, gating deps — without parsing a chart or CSV. Deterministic: no
 *  wall-clock is embedded, so identical input yields byte-identical output. */
declare function renderJson(rows: GanttRow[], opts: GanttOptions, windowStart: Date, milestones?: Milestone[]): string;
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
/**
 * Render the chart as a standalone, styled HTML document.
 *
 * Builds a table with one column per week, status-colored bar cells (with a
 * `--progress` fill overlay), critical-path and overdue markers, off-window
 * directional hints, a highlighted today column, and a footer summary table
 * (plus a per-assignee workload breakdown when grouping by assignee). All
 * dynamic text is passed through {@link htmlEscape}, and the layout width
 * follows `--width`. The returned string is a full document, ready to write to
 * disk.
 *
 * @param rows - The render-ready rows from {@link buildRows}.
 * @param opts - The resolved chart options.
 * @param windowStart - The Monday that opens the chart window.
 * @returns A complete `<!DOCTYPE html>` document as a string.
 */
declare function renderHtml(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
/**
 * Render the chart as a self-contained, scalable SVG document.
 *
 * Mirrors the HTML render as vector graphics: a left label gutter, one column
 * per week, status-colored bars with critical/overdue handling, a dashed today
 * rule drawn last so it stays visible, milestone diamonds, off-window arrows,
 * and a `--progress` fill overlay. The canvas width follows `--width` but grows
 * for long timelines to keep a readable minimum per-week column. All dynamic
 * text is passed through {@link svgEscape}, and the result is a complete
 * `<?xml …><svg …>` document.
 *
 * @param rows - The render-ready rows from {@link buildRows}.
 * @param opts - The resolved chart options.
 * @param windowStart - The Monday that opens the chart window.
 * @returns A complete SVG document as a string.
 */
declare function renderSvg(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string;
interface ResolvedOptions extends GanttOptions {
    windowStart: Date;
}
/**
 * Validate and normalize raw command flags into a fully resolved options object.
 *
 * Reads every supported flag through {@link readOption}/{@link readBoolOption},
 * coerces enums (`group-by`, `status`) to their typed values with safe
 * fallbacks, and derives the chart window: `--from` anchors the start (default
 * the current week's Monday), and `--to` overrides `--weeks` by computing the
 * column count from the start..end span. Invalid values throw a
 * {@link CommandError} (USAGE) naming the bad flag rather than silently
 * substituting a default. The returned object also carries the resolved
 * `windowStart` for the renderers.
 *
 * @param options - The raw flag record handed to the command.
 * @returns The validated options plus the computed window start date.
 */
declare function resolveGanttOptions(options: Record<string, unknown>): ResolvedOptions;
/**
 * Collect infeasible-deadline warnings from scheduled rows. A row is infeasible
 * when its backward-pass latest-feasible start is before its earliest possible
 * start — the plan is already late for a downstream deadline. Returns one
 * human-readable line per affected item (empty when none / not scheduling).
 */
declare function infeasibleWarnings(rows: GanttRow[]): string[];
/**
 * Names of milestones that fall entirely outside the rendered window (so they
 * cannot be drawn). Returned for a one-line stderr note. Exported for tests.
 */
export declare function offWindowMilestones(milestones: Milestone[], windowStart: Date, weeks: number): string[];
/**
 * Output formats accepted by the `gantt` and `gantt export` commands.
 *
 * The tuple is `as const` so {@link ExportFormat} is the exact string union,
 * which lets {@link renderForFormat} and {@link defaultExtension} switch over it
 * exhaustively with no default arm. Order is the order shown in `--help`.
 */
export declare const EXPORT_FORMATS: readonly ["mermaid", "html", "ascii", "csv", "json", "svg"];
type ExportFormat = (typeof EXPORT_FORMATS)[number];
/**
 * File extension to use when writing an export of the given format.
 *
 * Each {@link ExportFormat} maps to the extension its toolchain expects —
 * Mermaid uses `.mmd`, ASCII uses `.txt`, and the rest use their native
 * extensions — so a bare `--format` without `--output` still lands in a file the
 * right opener recognises.
 *
 * @param format - One of {@link EXPORT_FORMATS}.
 * @returns The dotted file extension (without the leading path).
 */
declare function defaultExtension(format: ExportFormat): string;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
export { computeSchedule, computeSlack, computeCriticalPath, computeSummary, itemDurationDays, renderCsv, renderJson, renderMermaid, renderGantt, renderHtml, renderSvg, infeasibleWarnings, buildRows, resolveGanttOptions, getGroupKey, defaultExtension, };
export type { PmItem, GanttOptions, GanttRow, GroupBy, ScheduleEntry, SlackEntry, GanttSummary, OffWindow, Milestone };
//# sourceMappingURL=index.d.ts.map