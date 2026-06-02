import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { defineExtension as defineExtensionType, CommandHandlerContext, ExtensionApi, ImportExportContext } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  due_date?: string; // ISO date string e.g. "2026-06-15" (legacy/optional)
  deadline?: string; // pm canonical due field (ISO date string)
  milestone?: string;
  sprint?: string;
  release?: string;
  assignee?: string;
  estimated_minutes?: number; // pm canonical estimate field
  dependencies?: PmDependency[];
  created_at?: string; // ISO date string
}

/** pm has no `milestone` field; map the "milestone" grouping onto its closest
 * canonical fields (sprint, then release). */
function itemMilestone(item: PmItem): string | undefined {
  return item.milestone ?? item.sprint ?? item.release;
}

/** pm exposes the due date as `deadline`; older payloads may use `due_date`. */
function itemDueDate(item: PmItem): string | undefined {
  return item.deadline ?? item.due_date;
}

// `tag` is retained for backward compatibility; `assignee` was added in the
// 2026.6.2 enhancement; `sprint`/`release`/`status` were added in 2026.6.2-1.
// The documented set is milestone|sprint|release|assignee|status|type|tag.
// `milestone` remains the aggregate group key (sprint, then release).
type GroupBy =
  | "milestone"
  | "sprint"
  | "release"
  | "tag"
  | "type"
  | "assignee"
  | "status";

const GROUP_BY_VALUES: GroupBy[] = [
  "milestone",
  "sprint",
  "release",
  "tag",
  "type",
  "assignee",
  "status",
];
type StatusFilter = "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft" | "all";

interface GanttOptions {
  weeks: number;
  groupBy: GroupBy;
  statusFilter: StatusFilter;
  today: Date;
  criticalPath: boolean;
  criticalOnly: boolean; // restrict output to the critical path
  schedule: boolean;     // dependency-aware forward scheduling
  defaultDuration: number; // fallback duration in days when no estimate
}

interface GanttRow {
  group: string;
  item: PmItem;
  startWeek: number | null; // 0-based week index, null = undated
  endWeek: number | null;   // 0-based week index (inclusive), null = undated
  critical: boolean;        // on the computed critical (longest dependency) path
  start: Date | null;       // concrete start date used for the bar / export
  end: Date | null;         // concrete (inclusive) end date used for the bar / export
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns the Monday of the week containing `d`. */
function weekStart(d: Date): Date {
  const day = d.getDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  const mon = new Date(d);
  mon.setHours(0, 0, 0, 0);
  mon.setDate(d.getDate() + diff);
  return mon;
}

/** Adds `n` weeks (7 * n days) to `d`. */
function addWeeks(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n * 7);
  return result;
}

/** Short label for the week starting on `d`: "May 11", "Jun  2", etc. */
function weekLabel(d: Date): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const m = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, " ");
  return `${m} ${day}`;
}

/** Parse an ISO date string into a Date (midnight UTC treated as local). */
function parseDate(s: string): Date | null {
  if (!s) return null;
  // Accept "YYYY-MM-DD" or full ISO
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date as "YYYY-MM-DD" (local). */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Given a date range [start, end] and the chart window [windowStart, windowEnd),
 * compute the 0-based week indices that are "active" for this item.
 * Returns { firstActive, lastActive } or null if the item is outside the window.
 */
function computeWeekRange(
  itemStart: Date | null,
  itemEnd: Date | null,
  windowStart: Date,
  totalWeeks: number
): { firstActive: number; lastActive: number } | null {
  const windowEnd = addWeeks(windowStart, totalWeeks);

  // If both dates are absent → undated
  if (!itemStart && !itemEnd) return null;

  // Clamp: if only one date is known, use a 1-week span
  const effectiveStart = itemStart ?? (itemEnd ? addWeeks(itemEnd, -1) : windowStart);
  const effectiveEnd = itemEnd ?? (itemStart ? addWeeks(itemStart, 1) : windowEnd);

  // Check if this item overlaps the window at all
  if (effectiveEnd <= windowStart || effectiveStart >= windowEnd) {
    return null;
  }

  const clampedStart = effectiveStart < windowStart ? windowStart : effectiveStart;
  const clampedEnd = effectiveEnd > windowEnd ? windowEnd : effectiveEnd;

  const firstActive = Math.floor(
    (clampedStart.getTime() - windowStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  // lastActive: the last week that has any overlap (end is exclusive, so subtract 1 ms)
  const lastActive = Math.max(
    firstActive,
    Math.floor(
      (clampedEnd.getTime() - windowStart.getTime() - 1) /
        (7 * 24 * 60 * 60 * 1000)
    )
  );

  return {
    firstActive: Math.max(0, firstActive),
    lastActive: Math.min(totalWeeks - 1, lastActive),
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function getGroupKey(item: PmItem, groupBy: GroupBy): string {
  switch (groupBy) {
    case "milestone":
      return itemMilestone(item)?.trim() || "(no milestone)";
    case "sprint":
      return item.sprint?.trim() || "(no sprint)";
    case "release":
      return item.release?.trim() || "(no release)";
    case "tag":
      return item.tags && item.tags.length > 0
        ? item.tags[0]
        : "(no tag)";
    case "type":
      return item.type?.trim() || "(no type)";
    case "assignee":
      return item.assignee?.trim() || "(unassigned)";
    case "status":
      return item.status;
  }
}

// ---------------------------------------------------------------------------
// Critical path
// ---------------------------------------------------------------------------

/**
 * Compute the critical path: the longest chain of dependency edges across the
 * given items. Edges point from an item to each of its `dependencies[].id`
 * (i.e. "depends on" / "blocked-by"), so the chain is ordered prerequisite →
 * dependent. Cycles are guarded against. Returns the set of item ids that lie
 * on the longest chain (ties resolved by the chain whose final node has the
 * latest deadline, then by lexical id for determinism).
 */
function computeCriticalPath(items: PmItem[]): Set<string> {
  const byId = new Map<string, PmItem>();
  for (const it of items) byId.set(it.id, it);

  // memoized longest path *ending at* each node (following deps backwards):
  // depthEndingAt(node) = 1 + max(depthEndingAt(dep) for dep in node.deps that exist)
  const memo = new Map<string, { len: number; path: string[] }>();
  const visiting = new Set<string>();

  function longest(id: string): { len: number; path: string[] } {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { len: 0, path: [] }; // cycle guard
    const item = byId.get(id);
    if (!item) return { len: 0, path: [] };
    visiting.add(id);

    let best: { len: number; path: string[] } = { len: 1, path: [id] };
    for (const dep of item.dependencies ?? []) {
      if (!byId.has(dep.id)) continue; // dangling/missing dependency
      const sub = longest(dep.id);
      if (sub.len + 1 > best.len) {
        best = { len: sub.len + 1, path: [...sub.path, id] };
      }
    }

    visiting.delete(id);
    memo.set(id, best);
    return best;
  }

  let overall: { len: number; path: string[]; endId: string } = { len: 0, path: [], endId: "" };
  for (const it of items) {
    const r = longest(it.id);
    const better =
      r.len > overall.len ||
      (r.len === overall.len && r.len > 0 &&
        ((itemDueDate(it) ?? "") > (itemDueDate(byId.get(overall.endId)!) ?? "") ||
          ((itemDueDate(it) ?? "") === (itemDueDate(byId.get(overall.endId)!) ?? "") && it.id < overall.endId)));
    if (better) overall = { len: r.len, path: r.path, endId: it.id };
  }

  return new Set(overall.len > 1 ? overall.path : []);
}

// ---------------------------------------------------------------------------
// Dependency-aware scheduling
// ---------------------------------------------------------------------------

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes assumed in a working day when converting `estimated_minutes`. */
const MINUTES_PER_WORKDAY = 8 * 60;

/** Add `n` whole days to `d` (non-mutating). */
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Later of two dates. */
function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

interface ScheduleEntry {
  start: Date;
  end: Date; // inclusive last day of work
  durationDays: number;
}

/**
 * Derive an item's duration in whole days from its estimate, falling back to
 * `defaultDays`. `estimated_minutes` is the pm-canonical estimate field; it is
 * converted via an 8h working day and rounded up to at least one day.
 */
function itemDurationDays(item: PmItem, defaultDays: number): number {
  const mins = item.estimated_minutes;
  if (typeof mins === "number" && mins > 0) {
    return Math.max(1, Math.ceil(mins / MINUTES_PER_WORKDAY));
  }
  return Math.max(1, defaultDays);
}

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
function computeSchedule(
  items: PmItem[],
  anchor: Date,
  defaultDays: number,
): Map<string, ScheduleEntry> {
  const byId = new Map<string, PmItem>();
  for (const it of items) byId.set(it.id, it);

  const result = new Map<string, ScheduleEntry>();
  const visiting = new Set<string>();

  function schedule(id: string): ScheduleEntry | null {
    const existing = result.get(id);
    if (existing) return existing;
    const item = byId.get(id);
    if (!item) return null;
    if (visiting.has(id)) return null; // cycle guard
    visiting.add(id);

    // Earliest start = day after the latest dependency finishes.
    let start = new Date(anchor);
    for (const dep of item.dependencies ?? []) {
      // Only "blocked_by"/"depends_on" edges gate scheduling. Unknown kinds are
      // treated as prerequisites too (conservative), but informational kinds
      // like "related" are ignored.
      const kind = (dep.kind ?? "blocked_by").toLowerCase();
      if (kind === "related" || kind === "relates_to" || kind === "duplicate") continue;
      if (!byId.has(dep.id)) continue;
      const depEntry = schedule(dep.id);
      if (depEntry) start = maxDate(start, addDays(depEntry.end, 1));
    }

    const durationDays = itemDurationDays(item, defaultDays);

    // Back-anchor to a deadline when the deadline is reachable (later than the
    // dependency-driven earliest start). This produces a "just-in-time" plan.
    const due = itemDueDate(item);
    const deadline = due ? parseDate(due) : null;
    if (deadline) {
      const deadlineStart = addDays(deadline, -(durationDays - 1));
      if (deadlineStart.getTime() >= start.getTime()) {
        start = deadlineStart;
      }
    }

    const entry: ScheduleEntry = {
      start,
      end: addDays(start, durationDays - 1),
      durationDays,
    };
    visiting.delete(id);
    result.set(id, entry);
    return entry;
  }

  for (const it of items) schedule(it.id);
  return result;
}

// ---------------------------------------------------------------------------
// Row building (shared by terminal render and exporters)
// ---------------------------------------------------------------------------

function statusOrderValue(status: PmItem["status"]): number {
  const statusOrder: Record<PmItem["status"], number> = {
    in_progress: 0,
    open: 1,
    blocked: 2,
    closed: 3,
    canceled: 4,
    draft: 5,
  };
  return statusOrder[status];
}

function buildRows(items: PmItem[], opts: GanttOptions, windowStart: Date): GanttRow[] {
  // --critical-only implies critical-path computation even without --critical-path.
  const needCritical = opts.criticalPath || opts.criticalOnly;
  const criticalIds = needCritical ? computeCriticalPath(items) : new Set<string>();

  // --critical-only clips the input to just the critical-path items.
  let working = items;
  if (opts.criticalOnly) working = items.filter((i) => criticalIds.has(i.id));

  // Dependency-aware scheduling overrides created_at/deadline-derived bars.
  const scheduleMap = opts.schedule
    ? computeSchedule(working, windowStart, opts.defaultDuration)
    : null;

  const groupMap = new Map<string, PmItem[]>();
  for (const item of working) {
    const key = getGroupKey(item, opts.groupBy);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(item);
  }

  // Sort groups: named groups first (alphabetically), then fallback groups.
  const sortedGroups = [...groupMap.keys()].sort((a, b) => {
    const aFallback = a.startsWith("(no ") || a === "(unassigned)";
    const bFallback = b.startsWith("(no ") || b === "(unassigned)";
    if (aFallback && !bFallback) return 1;
    if (!aFallback && bFallback) return -1;
    return a.localeCompare(b);
  });

  const rows: GanttRow[] = [];
  for (const group of sortedGroups) {
    const groupItems = groupMap.get(group)!;
    groupItems.sort((a, b) => statusOrderValue(a.status) - statusOrderValue(b.status));

    for (const item of groupItems) {
      let itemStart: Date | null;
      let itemEnd: Date | null;
      if (scheduleMap) {
        const entry = scheduleMap.get(item.id);
        itemStart = entry ? entry.start : null;
        // computeWeekRange treats end as exclusive; the scheduler's end is the
        // inclusive last work day, so add a day for the half-open range.
        itemEnd = entry ? addDays(entry.end, 1) : null;
      } else {
        itemStart = item.created_at ? parseDate(item.created_at) : null;
        const due = itemDueDate(item);
        itemEnd = due ? parseDate(due) : null;
      }
      const range = computeWeekRange(itemStart, itemEnd, windowStart, opts.weeks);

      rows.push({
        group,
        item,
        startWeek: range?.firstActive ?? null,
        endWeek: range?.lastActive ?? null,
        critical: criticalIds.has(item.id),
        start: itemStart,
        // expose the inclusive end for exporters (undo the +1 day from above)
        end: scheduleMap
          ? (scheduleMap.get(item.id)?.end ?? null)
          : itemEnd,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering — ASCII (terminal)
// ---------------------------------------------------------------------------

const BLOCK_ACTIVE = "██";
const BLOCK_PLANNED = "░░";
const BLOCK_CRITICAL = "▓▓";
const BLOCK_UNDATED = "··";
const COL_SEP = "  ";

function statusSymbol(status: PmItem["status"]): string {
  switch (status) {
    case "in_progress": return "▶";
    case "blocked":     return "!";
    case "closed":      return "✓";
    case "canceled":    return "✗";
    default:            return "○";
  }
}

function renderGantt(
  rows: GanttRow[],
  opts: GanttOptions,
  windowStart: Date
): string {
  const { weeks } = opts;

  // Build week header labels
  const weekLabels: string[] = [];
  for (let w = 0; w < weeks; w++) {
    weekLabels.push(weekLabel(addWeeks(windowStart, w)));
  }

  // Column widths
  const COL_GROUP = 18;
  const COL_ITEM = 24;
  const COL_ST = 2; // status symbol
  const WEEK_COL = 6; // "May 11" = 6 chars

  const totalWidth =
    COL_GROUP + 2 + COL_ITEM + 2 + COL_ST + 2 +
    weeks * (WEEK_COL + COL_SEP.length);

  const lines: string[] = [];

  // Title line
  const startStr = isoDay(windowStart);
  lines.push(`pm gantt  •  ${weeks} weeks from ${startStr}${opts.criticalPath ? "  •  critical path marked" : ""}`);
  lines.push("━".repeat(Math.min(totalWidth, 90)));

  // Header
  const groupHeader = "GROUP".padEnd(COL_GROUP);
  const itemHeader = "ITEM".padEnd(COL_ITEM);
  const stHeader = " S";
  const weekHeaderCols = weekLabels
    .map((_, i) => `W${i + 1}`.padEnd(WEEK_COL))
    .join(COL_SEP);
  lines.push(
    `${groupHeader}  ${itemHeader}  ${stHeader}  ${weekHeaderCols}`
  );
  lines.push("─".repeat(Math.min(totalWidth, 90)));

  // Week sub-header (actual dates)
  const weekDateCols = weekLabels
    .map((l) => l.padEnd(WEEK_COL))
    .join(COL_SEP);
  lines.push(
    `${"".padEnd(COL_GROUP)}  ${"".padEnd(COL_ITEM)}  ${"".padEnd(COL_ST)}  ${weekDateCols}`
  );
  lines.push("─".repeat(Math.min(totalWidth, 90)));

  // Rows — track last group to only print group name on first row
  let lastGroup = "";

  for (const row of rows) {
    const { group, item } = row;

    // Group label: only show for first item in group
    const groupLabel =
      group !== lastGroup
        ? group.slice(0, COL_GROUP).padEnd(COL_GROUP)
        : "".padEnd(COL_GROUP);
    lastGroup = group;

    // Item title (truncated); mark critical-path items with a leading *
    const rawTitle = row.critical ? `*${item.title}` : item.title;
    const itemLabel = rawTitle.slice(0, COL_ITEM).padEnd(COL_ITEM);

    // Status symbol
    const st = statusSymbol(item.status);

    // Gantt cells
    const cells: string[] = [];

    if (row.startWeek === null) {
      // Undated item
      for (let w = 0; w < weeks; w++) {
        cells.push(BLOCK_UNDATED.padEnd(WEEK_COL));
      }
    } else {
      for (let w = 0; w < weeks; w++) {
        if (w >= row.startWeek && w <= (row.endWeek ?? row.startWeek)) {
          // Active: critical-path items override, then in_progress/blocked vs open.
          const block = row.critical
            ? BLOCK_CRITICAL
            : item.status === "in_progress" || item.status === "blocked"
              ? BLOCK_ACTIVE
              : BLOCK_PLANNED;
          cells.push(block.padEnd(WEEK_COL));
        } else {
          cells.push("  ".padEnd(WEEK_COL)); // empty
        }
      }
    }

    lines.push(
      `${groupLabel}  ${itemLabel}  ${st}   ${cells.join(COL_SEP)}`
    );
  }

  lines.push("━".repeat(Math.min(totalWidth, 90)));

  // Legend
  lines.push(
    `Legend: ${BLOCK_ACTIVE} in_progress/blocked  ${BLOCK_PLANNED} open/planned  ` +
      (opts.criticalPath ? `${BLOCK_CRITICAL} critical-path (*)  ` : "") +
      `${BLOCK_UNDATED} undated  ` +
      `S: ▶in_progress  !blocked  ✓closed  ○open`
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering — Mermaid `gantt`
// ---------------------------------------------------------------------------

/** Mermaid section/task names cannot contain `:` (the field separator); sanitize. */
function mermaidSafe(s: string): string {
  return s.replace(/:/g, "-").replace(/\n/g, " ").trim();
}

function mermaidStatusTag(status: PmItem["status"]): string {
  switch (status) {
    case "closed":      return "done, ";
    case "in_progress": return "active, ";
    case "canceled":    return "crit, ";
    default:            return "";
  }
}

function renderMermaid(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  const lines: string[] = [];
  lines.push("gantt");
  lines.push("    dateFormat  YYYY-MM-DD");
  lines.push(`    title       pm gantt (${opts.weeks} weeks from ${isoDay(windowStart)})`);
  lines.push("    excludes    weekends");
  lines.push("");

  const windowEnd = addWeeks(windowStart, opts.weeks);
  let lastGroup = "";
  let taskIndex = 0;

  for (const row of rows) {
    const { item } = row;
    if (row.group !== lastGroup) {
      lines.push(`    section ${mermaidSafe(row.group)}`);
      lastGroup = row.group;
    }

    // Determine concrete start/end dates for the task. When the row carries
    // scheduler-/date-derived bounds (set in buildRows) prefer those so the
    // export reflects --schedule; otherwise fall back to created_at/deadline.
    // Mermaid task end dates are exclusive, but row.end is the inclusive last
    // work day, so advance it one day to keep durations honest (a 1-day task
    // renders as exactly one day rather than collapsing).
    const startDate = row.start ?? (item.created_at ? parseDate(item.created_at) : null);
    const due = itemDueDate(item);
    const endDate = row.end ? addDays(row.end, 1) : (due ? parseDate(due) : null);

    let start: Date;
    let end: Date;
    if (startDate && endDate) {
      start = startDate;
      end = endDate;
    } else if (endDate) {
      start = addWeeks(endDate, -1);
      end = endDate;
    } else if (startDate) {
      start = startDate;
      end = addWeeks(startDate, 1);
    } else {
      // Undated: place a 1-week marker at the window start so it still renders.
      start = windowStart;
      end = addWeeks(windowStart, 1);
    }
    if (end <= start) end = addWeeks(start, 1); // mermaid requires positive duration

    const taskId = `t${taskIndex++}`;
    const tag = (row.critical ? "crit, " : "") + mermaidStatusTag(item.status);
    const name = mermaidSafe(`${item.title} [${item.id}]`);
    // `tag, id, startISO, endISO`
    lines.push(`    ${name} :${tag}${taskId}, ${isoDay(start)}, ${isoDay(end)}`);
  }

  // Mark a vertical "today" line within the window when applicable.
  const today = opts.today;
  if (today >= windowStart && today < windowEnd) {
    // Mermaid has no explicit today marker in source; documented via comment.
    lines.push(`    %% today: ${isoDay(today)}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering — CSV schedule
// ---------------------------------------------------------------------------

/** RFC-4180 style CSV field quoting (quote when the value has , " or newline). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Render rows as a CSV schedule: id,title,start,end,duration_days,deps,status.
 * `start`/`end` use the row's computed bounds (scheduler- or date-derived);
 * `duration_days` is the inclusive day span, blank when undated. `deps` is a
 * space-separated list of blocking dependency ids. Exported for tests.
 */
function renderCsv(rows: GanttRow[]): string {
  const header = "id,title,start,end,duration_days,deps,status";
  const lines = [header];
  for (const row of rows) {
    const { item } = row;
    const start = row.start ? isoDay(row.start) : "";
    const end = row.end ? isoDay(row.end) : "";
    let duration = "";
    if (row.start && row.end) {
      const days = Math.round((row.end.getTime() - row.start.getTime()) / DAY_MS) + 1;
      duration = String(Math.max(1, days));
    }
    const deps = (item.dependencies ?? [])
      .filter((d) => {
        const kind = (d.kind ?? "blocked_by").toLowerCase();
        return kind !== "related" && kind !== "relates_to" && kind !== "duplicate";
      })
      .map((d) => d.id)
      .join(" ");
    lines.push(
      [
        csvField(item.id),
        csvField(item.title),
        csvField(start),
        csvField(end),
        csvField(duration),
        csvField(deps),
        csvField(item.status),
      ].join(","),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering — standalone HTML
// ---------------------------------------------------------------------------

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  const weeks = opts.weeks;
  const weekLabels: string[] = [];
  for (let w = 0; w < weeks; w++) weekLabels.push(weekLabel(addWeeks(windowStart, w)));

  const headCols = weekLabels
    .map((l, i) => `<th title="${htmlEscape(l)}">W${i + 1}<br><span class="wk">${htmlEscape(l)}</span></th>`)
    .join("");

  const bodyRows: string[] = [];
  let lastGroup = "";
  for (const row of rows) {
    const { item } = row;
    const groupCell =
      row.group !== lastGroup
        ? `<td class="group">${htmlEscape(row.group)}</td>`
        : `<td class="group"></td>`;
    lastGroup = row.group;

    const cells: string[] = [];
    for (let w = 0; w < weeks; w++) {
      let cls = "cell";
      if (row.startWeek === null) {
        cls = "cell undated";
      } else if (w >= row.startWeek && w <= (row.endWeek ?? row.startWeek)) {
        cls = row.critical
          ? "cell bar critical"
          : item.status === "in_progress" || item.status === "blocked"
            ? "cell bar active"
            : "cell bar planned";
      }
      cells.push(`<td class="${cls}"></td>`);
    }

    const title = htmlEscape(item.title) + (row.critical ? ' <span class="crit-mark">★</span>' : "");
    const due = itemDueDate(item);
    bodyRows.push(
      `<tr class="status-${htmlEscape(item.status)}">` +
        groupCell +
        `<td class="item">${title}<br><span class="meta">${htmlEscape(item.id)}${due ? " · due " + htmlEscape(isoDay(parseDate(due)!)) : ""}</span></td>` +
        `<td class="st" title="${htmlEscape(item.status)}">${htmlEscape(item.status)}</td>` +
        cells.join("") +
        `</tr>`
    );
  }

  const title = `pm gantt — ${weeks} weeks from ${isoDay(windowStart)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 1.5rem; background: #fafafa; color: #1a1a1a; }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  table { border-collapse: collapse; font-size: 0.8rem; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; vertical-align: bottom; }
  .wk { font-weight: 400; color: #888; font-size: 0.7rem; }
  td.group { font-weight: 600; white-space: nowrap; }
  td.item { white-space: nowrap; }
  .meta { color: #888; font-size: 0.7rem; }
  td.st { text-transform: capitalize; white-space: nowrap; }
  td.cell { width: 28px; min-width: 28px; padding: 0; }
  td.bar.planned  { background: #b3d4fc; }
  td.bar.active   { background: #2b7de9; }
  td.bar.critical { background: #e05c5c; }
  td.cell.undated { background: repeating-linear-gradient(45deg,#eee,#eee 4px,#f7f7f7 4px,#f7f7f7 8px); }
  .crit-mark { color: #e05c5c; }
  .legend { margin-top: 1rem; font-size: 0.78rem; color: #555; }
  .legend span { display: inline-block; margin-right: 1rem; }
  .swatch { display: inline-block; width: 14px; height: 14px; vertical-align: middle; margin-right: 4px; border: 1px solid #ccc; }
  tr.status-closed td.item { text-decoration: line-through; color: #999; }
</style>
</head>
<body>
<h1>${htmlEscape(title)}</h1>
<table>
<thead>
<tr><th>Group</th><th>Item</th><th>Status</th>${headCols}</tr>
</thead>
<tbody>
${bodyRows.join("\n")}
</tbody>
</table>
<div class="legend">
  <span><i class="swatch" style="background:#2b7de9"></i>in_progress / blocked</span>
  <span><i class="swatch" style="background:#b3d4fc"></i>open / planned</span>
  ${opts.criticalPath ? '<span><i class="swatch" style="background:#e05c5c"></i>critical path (★)</span>' : ""}
  <span><i class="swatch" style="background:#eee"></i>undated</span>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared option parsing + data fetch
// ---------------------------------------------------------------------------

function readOption(options: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readBoolOption(options: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (options[key] !== undefined) return Boolean(options[key]);
  }
  return false;
}

interface ResolvedOptions extends GanttOptions {
  windowStart: Date;
}

function resolveGanttOptions(options: Record<string, unknown>): ResolvedOptions {
  const rawGroupBy = readOption(options, "group-by", "groupBy") ?? "milestone";
  const groupBy: GroupBy = (GROUP_BY_VALUES as string[]).includes(String(rawGroupBy))
    ? (String(rawGroupBy) as GroupBy)
    : "milestone";

  const rawStatus = readOption(options, "status") ?? "all";
  const statusFilter: StatusFilter = [
    "open", "in_progress", "blocked", "closed", "canceled", "draft", "all",
  ].includes(String(rawStatus))
    ? (String(rawStatus) as StatusFilter)
    : "all";

  const criticalPath = readBoolOption(options, "critical-path", "criticalPath");
  const criticalOnly = readBoolOption(options, "critical-only", "criticalOnly");
  const schedule = readBoolOption(options, "schedule");

  const rawDefaultDuration = readOption(options, "default-duration", "defaultDuration");
  let defaultDuration = 5;
  if (rawDefaultDuration !== undefined) {
    const parsed = parseInt(String(rawDefaultDuration), 10);
    if (isNaN(parsed) || parsed < 1) {
      throw new CommandError(
        `Invalid --default-duration "${rawDefaultDuration}" (expected a positive integer of days).`,
        EXIT_CODE.USAGE,
      );
    }
    defaultDuration = Math.min(365, parsed);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // --from anchors the chart window; default is the current week.
  const rawFrom = readOption(options, "from");
  let anchor = today;
  if (rawFrom) {
    const parsed = parseDate(String(rawFrom));
    if (!parsed) {
      throw new CommandError(`Invalid --from date: "${rawFrom}" (expected ISO YYYY-MM-DD).`, EXIT_CODE.USAGE);
    }
    anchor = parsed;
  }
  const windowStart = weekStart(anchor);

  // --to clips the window end. When given, weeks is derived from from..to
  // (overriding --weeks); otherwise --weeks (default 8) drives the width.
  const rawTo = readOption(options, "to");
  let weeks: number;
  if (rawTo !== undefined) {
    const parsedTo = parseDate(String(rawTo));
    if (!parsedTo) {
      throw new CommandError(`Invalid --to date: "${rawTo}" (expected ISO YYYY-MM-DD).`, EXIT_CODE.USAGE);
    }
    if (parsedTo.getTime() < windowStart.getTime()) {
      throw new CommandError(
        `--to (${isoDay(parsedTo)}) is before --from window start (${isoDay(windowStart)}).`,
        EXIT_CODE.USAGE,
      );
    }
    // Number of week-columns needed to cover windowStart..parsedTo inclusive.
    const spanWeeks = Math.ceil(
      (parsedTo.getTime() - windowStart.getTime()) / (7 * DAY_MS),
    ) + 1;
    weeks = Math.max(1, Math.min(52, spanWeeks));
  } else {
    const rawWeeks = readOption(options, "weeks");
    weeks = rawWeeks ? Math.max(1, Math.min(52, parseInt(String(rawWeeks), 10))) : 8;
  }

  return {
    weeks,
    groupBy,
    statusFilter,
    today,
    criticalPath,
    criticalOnly,
    schedule,
    defaultDuration,
    windowStart,
  };
}

function fetchItems(pmRoot: string): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "list-all", "--json", "--include-body"],
    { encoding: "utf-8" },
  );
  if (result.error || result.status !== 0) {
    throw new CommandError(
      `Failed to fetch pm items (exit ${result.status ?? "unknown"}): ${result.stderr?.trim() || result.error?.message || "no output"}`,
    );
  }
  let parsed: { items?: PmItem[] };
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err: unknown) {
    throw new CommandError(
      `Failed to parse pm list-all output as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsed.items ?? [];
}

function filterByStatus(items: PmItem[], statusFilter: StatusFilter): PmItem[] {
  return statusFilter === "all" ? items : items.filter((i) => i.status === statusFilter);
}

type ExportFormat = "mermaid" | "html" | "ascii" | "csv";

const EXPORT_FORMATS: ExportFormat[] = ["mermaid", "html", "ascii", "csv"];

function renderForFormat(format: ExportFormat, rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  switch (format) {
    case "mermaid": return renderMermaid(rows, opts, windowStart);
    case "html":    return renderHtml(rows, opts, windowStart);
    case "ascii":   return renderGantt(rows, opts, windowStart);
    case "csv":     return renderCsv(rows);
  }
}

function defaultExtension(format: ExportFormat): string {
  switch (format) {
    case "mermaid": return "mmd";
    case "html":    return "html";
    case "ascii":   return "txt";
    case "csv":     return "csv";
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-gantt-chart",
  version: "2026.6.2",

  activate(api: ExtensionApi) {
    api.registerCommand({
      name: "gantt",
      description: "Render pm items as an ASCII Gantt chart",
      intent: "visualize project timeline week-by-week in the terminal",
      examples: [
        "pm gantt",
        "pm gantt --weeks 12",
        "pm gantt --group-by assignee",
        "pm gantt --group-by sprint",
        "pm gantt --group-by status --weeks 6",
        "pm gantt --status in_progress",
        "pm gantt --from 2026-06-01 --to 2026-08-01",
        "pm gantt --schedule",
        "pm gantt --schedule --default-duration 3",
        "pm gantt --critical-path",
        "pm gantt --critical-only --schedule",
      ],
      flags: [
        {
          long: "--weeks",
          value_name: "n",
          description: "Number of weeks to show (default: 8; ignored when --to is set)",
        },
        {
          long: "--group-by",
          value_name: "field",
          description:
            "Group items by: milestone (sprint/release) | sprint | release | type | assignee | status | tag (default: milestone)",
        },
        {
          long: "--status",
          value_name: "filter",
          description:
            "Filter by status: open | in_progress | blocked | closed | canceled | draft | all (default: all)",
        },
        {
          long: "--from",
          value_name: "iso",
          description: "Anchor the chart window at this ISO date (default: current week)",
        },
        {
          long: "--to",
          value_name: "iso",
          description: "Clip the chart window to end at this ISO date (overrides --weeks)",
        },
        {
          long: "--schedule",
          description:
            "Dependency-aware scheduling: derive start/end from blocked-by chains + estimates",
        },
        {
          long: "--default-duration",
          value_name: "days",
          description: "Fallback duration in days for items without an estimate under --schedule (default: 5)",
        },
        {
          long: "--critical-path",
          description: "Compute & mark the longest dependency chain (critical path)",
        },
        {
          long: "--critical-only",
          description: "Show only items on the critical path (implies critical-path computation)",
        },
      ],

      async run(ctx: CommandHandlerContext) {
        const opts = resolveGanttOptions(ctx.options);

        const allItems = fetchItems(ctx.pm_root);
        if (allItems.length === 0) {
          console.error("No pm items found. Add some items first.");
          return { chart: null, itemCount: 0 };
        }

        const items = filterByStatus(allItems, opts.statusFilter);
        if (items.length === 0) {
          console.error(`No items with status "${opts.statusFilter}". Try --status all.`);
          return { chart: null, itemCount: 0, warning: `No items with status "${opts.statusFilter}"` };
        }

        const rows = buildRows(items, opts, opts.windowStart);
        if (rows.length === 0) {
          // The only way to reach here is --critical-only with no qualifying
          // chain (needs ≥2 linked items). Treat as a clean empty result.
          console.error("No critical-path items to show (need a chain of ≥2 linked items).");
          return {
            chart: null,
            itemCount: 0,
            warning: "No critical-path items (need a chain of ≥2 linked items)",
          };
        }
        const chart = renderGantt(rows, opts, opts.windowStart);

        // Print the human-readable chart to stdout, but not under --json:
        // mixing it with the JSON payload would corrupt machine-readable output.
        // The chart is still returned in the result object for JSON consumers.
        if (!ctx.global?.json) {
          process.stdout.write(chart + "\n");
        }

        return {
          chart,
          itemCount: rows.length,
          groupCount: new Set(rows.map((r) => r.group)).size,
          weeks: opts.weeks,
          groupBy: opts.groupBy,
          statusFilter: opts.statusFilter,
          criticalPath: opts.criticalPath,
          criticalOnly: opts.criticalOnly,
          schedule: opts.schedule,
          ...(opts.schedule ? { defaultDuration: opts.defaultDuration } : {}),
        };
      },
    });

    // -----------------------------------------------------------------------
    // Exporter: gantt  →  `pm gantt export`
    // Writes the chart to a file (or stdout) as Mermaid `gantt`, standalone
    // HTML, or ASCII. registerRenderer only supports toon|json, so a new
    // output format must go through the exporter pipeline.
    // -----------------------------------------------------------------------
    api.registerExporter("gantt", async (ctx: ImportExportContext) => {
      const opts = resolveGanttOptions(ctx.options);

      const rawFormat = String(readOption(ctx.options, "format") ?? "mermaid").toLowerCase();
      if (!(EXPORT_FORMATS as string[]).includes(rawFormat)) {
        throw new CommandError(
          `Unknown --format "${rawFormat}". Valid: ${EXPORT_FORMATS.join(" | ")}.`,
          EXIT_CODE.USAGE,
        );
      }
      const format = rawFormat as ExportFormat;

      const allItems = fetchItems(ctx.pm_root);
      const items = filterByStatus(allItems, opts.statusFilter);
      if (items.length === 0) {
        console.error("No matching pm items to export.");
        return { exported: 0, format };
      }

      const rows = buildRows(items, opts, opts.windowStart);
      if (rows.length === 0) {
        console.error("No matching pm items to export (e.g. --critical-only with no chain).");
        return { exported: 0, format };
      }
      const output = renderForFormat(format, rows, opts, opts.windowStart);
      const exportedCount = rows.length;

      const outputPath = readOption(ctx.options, "output") as string | undefined;
      if (outputPath) {
        const absolutePath = resolve(outputPath);
        writeFileSync(absolutePath, output + "\n", "utf-8");
        console.error(`gantt export: wrote ${exportedCount} item(s) as ${format} to ${absolutePath}`);
        return { exported: exportedCount, format, file: absolutePath };
      }

      // No --output: emit to stdout so it can be piped/redirected.
      console.log(output);
      console.error(`gantt export: rendered ${exportedCount} item(s) as ${format}.`);
      return { exported: exportedCount, format, output };
    });
  },
});

// ---------------------------------------------------------------------------
// Test-only exports
//
// These pure helpers carry the logic worth unit-testing (scheduler, critical
// path, CSV/Mermaid renderers, option resolution). They are not part of the
// runtime extension contract; the default export above is. Keeping them as
// named exports lets test/*.test.ts import them without touching pm internals.
// ---------------------------------------------------------------------------
export {
  computeSchedule,
  computeCriticalPath,
  itemDurationDays,
  renderCsv,
  renderMermaid,
  buildRows,
  resolveGanttOptions,
  getGroupKey,
};
export type { PmItem, GanttOptions, GanttRow, GroupBy, ScheduleEntry };
