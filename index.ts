import type {
  CommandHandlerContext,
  ExtensionApi,
  ExtensionModule,
  FlagDefinition,
  ImportExportContext,
  ImportExportRegistrationOptions,
} from "@unbrained/pm-cli/sdk/authoring";
import type { brandValues } from './brand-values.ts';
import { brandCss, brandStatus, brandStatuses, brandValue, mermaidBrand, type BrandTheme } from "./brand.ts";
import { certifyCompleteListResult, EXIT_CODE, inspectCompleteListResult, PmClient } from "@unbrained/pm-cli/sdk";
import type { RelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
import type { ContractsResult } from "@unbrained/pm-cli/sdk/runtime";
import type { GraphTraversalResult } from "@unbrained/pm-cli/sdk/graph";
import { resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";


// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property.
// The numeric values come directly from the same public SDK peer that certifies
// complete-list results, so package and host cannot drift independently.

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

/** Core lifecycle states the renderer can order and encode consistently. */
const PM_ITEM_STATUSES = ["open", "in_progress", "blocked", "closed", "canceled", "draft"] as const;
/** Runtime-validated lifecycle state accepted from `pm list --all`. */
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
type StatusFilter = PmItemStatus | "all";

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
  criticalOnly: boolean; // restrict output to the critical path
  schedule: boolean;     // dependency-aware forward scheduling
  defaultDuration: number; // fallback duration in days when no estimate
  progress: boolean;     // opt-in: show per-item % complete on bars
  width: number;         // target render width in px for vector/graphical formats (SVG/HTML)
  milestones: Milestone[]; // fixed release/deadline dates drawn as vertical markers
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
  /** Normalized prerequisites retained even when chart rows are filtered. */
  prerequisites?: readonly string[];
  startWeek: number | null; // 0-based week index, null = undated
  endWeek: number | null;   // 0-based week index (inclusive), null = undated
  critical: boolean;        // on the computed critical (longest dependency) path
  start: Date | null;       // concrete start date used for the bar / export
  end: Date | null;         // concrete (inclusive) end date used for the bar / export
  slackDays: number | null; // total float in days (only under --schedule); null otherwise
  infeasible: boolean;      // required start precedes earliest start (plan already late)
  progress: number;         // 0..100 derived completion ratio for the item
  overdue: boolean;         // deadline is before today and item is not closed/canceled
  /** When startWeek is null, WHY: genuinely undated, or off-window before/after.
   *  null when the row does have an in-window bar (startWeek !== null). */
  offWindow: OffWindow | null;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Return the local-midnight {@link Date} of the Monday that opens the week
 * containing `d`.
 *
 * Node's `getDay()` counts Sunday as `0`, so a naive "subtract one day" would
 * push a Sunday into the following week; the `day === 0 ? -6 : 1 - day` shift
 * folds Sunday back as the last day of its week so the result always lands on a
 * Monday. The returned date is a fresh object set to local midnight — the input
 * is not mutated — which keeps the week-column math stable for the whole chart.
 *
 * @param d - Any date within the target week.
 * @returns A new Monday-at-midnight date for that week.
 */
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

/** Week-column labels for a chart window of `weeks` weeks opening on `windowStart`. */
function buildWeekLabels(windowStart: Date, weeks: number): string[] {
  const weekLabels: string[] = [];
  for (let w = 0; w < weeks; w++) {
    weekLabels.push(weekLabel(addWeeks(windowStart, w)));
  }
  return weekLabels;
}

/** Parse an ISO date string into a Date (midnight UTC treated as local). */
function parseDate(s: string): Date | null {
  // Accept "YYYY-MM-DD" or full ISO.  All callers guard against falsy input,
  // so the former `if (!s) return null` guard was unreachable and is removed.
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse the `--milestones` flag: a comma-separated list of `name=YYYY-MM-DD`
 * entries (e.g. `v1.0=2026-06-30,v1.1=2026-08-15`). Returns the parsed list
 * (empty when the flag is absent/blank). Throws a CommandError (USAGE) on any
 * malformed entry — missing `=`, empty name, or an unparseable/non-ISO date —
 * rather than crashing. Exported for tests.
 */
export function parseMilestones(raw: unknown): Milestone[] {
  if (raw === undefined || raw === null) return [];
  const text = String(raw).trim();
  if (text === "") return [];
  const out: Milestone[] = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (entry === "") continue; // tolerate trailing/double commas
    const eq = entry.indexOf("=");
    if (eq < 0) {
      throw new CommandError(
        `Invalid --milestones entry "${entry}" (expected name=YYYY-MM-DD).`,
        EXIT_CODE.USAGE,
      );
    }
    const name = entry.slice(0, eq).trim();
    const dateStr = entry.slice(eq + 1).trim();
    if (name === "") {
      throw new CommandError(
        `Invalid --milestones entry "${entry}": empty milestone name (expected name=YYYY-MM-DD).`,
        EXIT_CODE.USAGE,
      );
    }
    // Require the strict ISO calendar-day shape; parseDate alone would accept
    // looser forms (full ISO timestamps), which we deliberately reject here so
    // milestone dates round-trip predictably through every export.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new CommandError(
        `Invalid --milestones date for "${name}": "${dateStr}" (expected ISO YYYY-MM-DD).`,
        EXIT_CODE.USAGE,
      );
    }
    const date = parseDate(dateStr);
    if (!date) {
      throw new CommandError(
        `Invalid --milestones date for "${name}": "${dateStr}" (expected ISO YYYY-MM-DD).`,
        EXIT_CODE.USAGE,
      );
    }
    out.push({ name, date });
  }
  return out;
}

/**
 * 0-based week column a milestone lands in for the given window, or -1 when the
 * milestone falls outside the rendered window. Mirrors the TODAY-marker math so
 * markers and items never disagree about column placement. Exported for tests.
 */
export function milestoneWeek(date: Date, windowStart: Date, weeks: number): number {
  const windowEnd = addWeeks(windowStart, weeks);
  if (date < windowStart || date >= windowEnd) return -1;
  return Math.floor((date.getTime() - windowStart.getTime()) / (7 * DAY_MS));
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

  // The overlap check above guarantees the span intersects the window.
  // firstActive/lastActive are clamped by Math.max(0,...) and Math.min below,
  // so explicit pre-clamping of the dates was redundant and is removed.
  const firstActive = Math.floor(
    (effectiveStart.getTime() - windowStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  // lastActive: the last week that has any overlap (end is exclusive, so subtract 1 ms)
  const lastActive = Math.max(
    firstActive,
    Math.floor(
      (effectiveEnd.getTime() - windowStart.getTime() - 1) /
        (7 * 24 * 60 * 60 * 1000)
    )
  );

  return {
    firstActive: Math.max(0, firstActive),
    lastActive: Math.min(totalWeeks - 1, lastActive),
  };
}

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
export function classifyOffWindow(
  itemStart: Date | null,
  itemEnd: Date | null,
  windowStart: Date,
  totalWeeks: number,
): OffWindow {
  if (!itemStart && !itemEnd) return "undated";
  const windowEnd = addWeeks(windowStart, totalWeeks);
  const effectiveStart = itemStart ?? (itemEnd ? addWeeks(itemEnd, -1) : windowStart);
  const effectiveEnd = itemEnd ?? (itemStart ? addWeeks(itemStart, 1) : windowEnd);
  if (effectiveEnd <= windowStart) return "before";
  if (effectiveStart >= windowEnd) return "after";
  // Overlaps the window (caller should have used computeWeekRange); default to
  // "undated" only as a defensive fallback that should never be reached.
  return "undated";
}

// ---------------------------------------------------------------------------
// Progress (% complete) + overdue detection
// ---------------------------------------------------------------------------

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
export function itemProgress(item: PmItem): number {
  if (item.status === "closed" || item.status === "canceled") return 100;

  // 1) An explicit numeric progress signal in meta wins (some pm setups store it).
  const metaProgress = readMetaProgress(item.meta);
  if (metaProgress !== null) return clampPercent(metaProgress);

  // 2) Acceptance-criteria checklist in the body: count [x] vs [ ] / [-].
  const checklist = checklistRatio(item.body);
  if (checklist !== null) return clampPercent(Math.round(checklist * 100));

  // 3) Status-based fallback.
  switch (item.status) {
    case "in_progress": return 50;
    case "blocked":     return 25;
    default:            return 0; // open / draft
  }
}

function clampPercent(n: number): number {
  // All callers pass finite numbers (readMetaProgress/checklistRatio guard),
  // so the former `if (!isFinite(n)) return 0` guard was unreachable.
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Read a numeric progress hint from meta (`progress` or `percent_complete`).
 *  Accepts 0..1 fractions (scaled to %) or 0..100 percentages. Returns null when
 *  no usable numeric value is present. */
function readMetaProgress(meta: Record<string, unknown> | undefined): number | null {
  if (!meta) return null;
  for (const key of ["progress", "percent_complete", "percentComplete"]) {
    const raw = meta[key];
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
    if (isFinite(n)) return n > 0 && n <= 1 ? n * 100 : n;
  }
  return null;
}

/** Parse a GitHub-style task list from the body and return checked/total, or
 *  null when there are no checklist lines. `[x]`/`[X]` count as done. */
function checklistRatio(body: string | undefined): number | null {
  if (!body) return null;
  let total = 0;
  let done = 0;
  for (const line of body.split("\n")) {
    const m = /^\s*[-*]\s*\[([ xX-])\]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] === "x" || m[1] === "X") done++;
  }
  if (total > 0) return done / total;
  return null;
}

/**
 * An item is overdue when it has a deadline strictly before `today` AND is not
 * already closed or canceled. Exported for tests.
 */
export function isOverdue(item: PmItem, today: Date): boolean {
  if (item.status === "closed" || item.status === "canceled") return false;
  const due = itemDueDate(item);
  if (!due) return false;
  const deadline = parseDate(due);
  return deadline !== null && deadline.getTime() < today.getTime();
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

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
 * given items. Registry ordering and precedence normalize storage directions
 * into item-to-prerequisite edges, so chains run prerequisite → dependent.
 * Cycles are guarded against. Returns the set of item ids that lie
 * on the longest chain (ties resolved by the chain whose final node has the
 * latest deadline, then by lexical id for determinism).
 */
function computeCriticalPath(items: PmItem[], graph: PrerequisiteGraph = buildPrerequisiteGraph(items)): Set<string> {
  const byId = new Map<string, PmItem>();
  for (const it of items) byId.set(it.id, it);

  // memoized longest path *ending at* each node (following deps backwards):
  // depthEndingAt(node) = 1 + max(depthEndingAt(dep) for dep in node.deps that exist)
  const memo = new Map<string, { len: number; path: string[] }>();
  const visiting = new Set<string>();

  /**
   * Memoized longest dependency chain that *ends* at `id`, following each
   * item's `dependencies` edges backward to its prerequisites.
   *
   * Returns both the chain length and the ordered id path so the caller can
   * reconstruct the critical sequence. A node already on the recursion stack
   * contributes a zero-length result, which is the cycle guard: it keeps a
   * dependency loop from inflating the depth or recursing forever. Results are
   * cached in `memo` so each node is expanded once across the whole graph.
   *
   * @param id - The item id to measure the longest ending chain for.
   * @returns The deepest chain ending at `id` (length 1, just itself, when it
   *   has no present prerequisites).
   */
  function longest(id: string): { len: number; path: string[] } {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { len: 0, path: [] }; // cycle guard
    visiting.add(id);

    let best: { len: number; path: string[] } = { len: 1, path: [id] };
    for (const depId of graph.get(id)!) {
      if (!byId.has(depId)) continue;
      const sub = longest(depId);
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
    let better = r.len > overall.len;
    if (!better && r.len === overall.len && r.len > 0) {
      // Tie-break: prefer the chain whose endpoint has the later deadline,
      // then the lower endpoint id. Deadlines are compared as strings (""
      // when absent) so an endpoint with a deadline beats one without.
      const itDue = itemDueDate(it) ?? "";
      const overallDue = itemDueDate(byId.get(overall.endId)!) ?? "";
      better = itDue > overallDue || (itDue === overallDue && it.id < overall.endId);
    }
    if (better) overall = { len: r.len, path: r.path, endId: it.id };
  }

  return new Set(overall.len > 1 ? overall.path : []);
}

// ---------------------------------------------------------------------------
// Preflight data-sanity gate
//
// Validates date / dependency / estimate sanity BEFORE any chart is rendered so
// problems surface early instead of producing a silently-confusing chart.
//
// Policy (deliberately split into HARD-FAIL vs WARN):
//   • HARD-FAIL — a dependency CYCLE. A cycle makes forward scheduling
//     impossible (there is no valid topological order), so any --schedule chart
//     is meaningless. The render path's existing cycle *guards* would silently
//     break the cycle and emit a plausible-looking but wrong chart; that is the
//     confusing-data case this gate exists to stop. Fail fast and name the cycle.
//   • WARN (non-blocking, stderr) — soft data issues that still yield a useful
//     chart: a deadline that precedes the item's own start date, and an absurd
//     estimate. These are informative, not render-breaking, so we never block.
//
// NOTE: infeasible/unreachable deadlines (a downstream deadline the dependency
// chain can't hit) are already FLAGGED in the render via the backward pass
// (`infeasibleWarnings`); we deliberately do NOT duplicate that here, and we do
// NOT hard-fail on it — the chart is still useful.
// ---------------------------------------------------------------------------

/** Upper bound for a "sane" single-item estimate, in minutes. 2000h (~50
 * 40h-weeks / a full work-year of one person) — anything larger is almost
 * certainly a data-entry error (e.g. minutes typed where hours were meant). */
const MAX_SANE_ESTIMATE_MINUTES = 2000 * 60;

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
 * Find every cycle in the normalized registry ordering graph
 * (an edge points item → prerequisite, regardless of storage direction).
 * Returns one human-readable path string
 * per distinct cycle, e.g. `A "Login" → B "API" → A "Login"`. Dangling
 * dependencies (ids not present in the item set) are ignored — they are a soft
 * concern handled elsewhere, not a cycle. Exported for tests.
 */
export function detectCycles(items: PmItem[], graph: PrerequisiteGraph = buildPrerequisiteGraph(items)): string[] {
  const byId = new Map<string, PmItem>();
  for (const it of items) byId.set(it.id, it);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const it of items) color.set(it.id, WHITE);

  const cycles: string[] = [];
  const seenCycleKeys = new Set<string>();
  const stack: string[] = [];

  // label is only called with ids from the DFS stack, which are always in
  // byId (deps are checked with byId.has before recursing), so the former
  // null arm `: id` was unreachable.
  const label = (id: string): string => {
    const it = byId.get(id)!;
    return `${id} "${it.title}"`;
  };

  function visit(id: string): void {
    color.set(id, GRAY);
    stack.push(id);
    for (const depId of graph.get(id)!) {
      if (!byId.has(depId)) continue;
      const c = color.get(depId);
      if (c === GRAY) {
        // Found a back-edge: extract the cycle from the recursion stack.
        const start = stack.indexOf(depId);
        const cyclePath = stack.slice(start);
        // De-dup cycles regardless of which node we entered from by keying on
        // the sorted node-set.
        const key = [...cyclePath].sort().join("|");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push([...cyclePath, depId].map(label).join(" → "));
        }
      } else if (c === WHITE) {
        visit(depId);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }

  for (const it of items) {
    if (color.get(it.id) === WHITE) visit(it.id);
  }
  return cycles;
}

/**
 * Run the preflight data-sanity checks over the items that will be charted.
 * Pure + deterministic; exported for tests. The caller decides what to do with
 * `fatal` (block) vs `warnings` (surface but proceed).
 */
export function dataSanityReport(items: PmItem[], graph: PrerequisiteGraph = buildPrerequisiteGraph(items)): DataSanityReport {
  const fatal: string[] = [];
  const warnings: string[] = [];

  // HARD-FAIL: dependency cycles.
  for (const cycle of detectCycles(items, graph)) {
    fatal.push(`dependency cycle: ${cycle}`);
  }

  // WARN: deadline before the item's own start date.
  for (const item of items) {
    const due = itemDueDate(item);
    if (!due || !item.created_at) continue;
    const deadline = parseDate(due);
    const start = parseDate(item.created_at);
    if (deadline && start && deadline.getTime() < start.getTime()) {
      warnings.push(
        `${item.id} "${item.title}": deadline ${isoDay(deadline)} is before its start ${isoDay(start)}.`,
      );
    }
  }

  // WARN: implausibly large estimate (likely a data-entry error).
  for (const item of items) {
    const mins = item.estimated_minutes;
    if (typeof mins === "number" && mins > MAX_SANE_ESTIMATE_MINUTES) {
      const hours = Math.round(mins / 60);
      warnings.push(
        `${item.id} "${item.title}": estimate of ${mins} min (~${hours}h) is implausibly large; check the units.`,
      );
    }
  }

  return { fatal, warnings };
}

/**
 * Preflight gate invoked from the command/exporter handlers BEFORE rendering.
 * Hard-fails (throws CommandError → non-zero exit) when the report has fatal
 * problems; otherwise prints any soft warnings to stderr and returns so the
 * chart still renders. `where` labels the message (e.g. "gantt", "gantt export").
 *
 * Why gate in the handler rather than registerPreflight? The pm runtime wraps
 * registerPreflight overrides in a try/catch and downgrades a thrown error to a
 * non-fatal warning, so a throw there does NOT abort the command. Gating in the
 * handler with the package's CommandError is the clean way to truly fail fast.
 */
function runDataSanityGate(items: PmItem[], where: string, json?: boolean, graph: PrerequisiteGraph = buildPrerequisiteGraph(items)): void {
  const report = dataSanityReport(items, graph);

  if (report.fatal.length > 0) {
    throw new CommandError(
      `${where}: ${report.fatal.length} fatal data problem(s) make scheduling impossible:\n` +
        report.fatal.map((f) => `  • ${f}`).join("\n") +
        `\nResolve the dependency cycle(s) above and re-run.`,
      EXIT_CODE.USAGE,
    );
  }

  if (report.warnings.length > 0 && !json) {
    process.stderr.write(
      `\nNOTE: ${report.warnings.length} data-sanity warning(s) (chart still rendered):\n` +
        report.warnings.map((w) => `  • ${w}`).join("\n") +
        "\n",
    );
  }
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
 * Forward-schedule items from `anchor`, honoring registry-defined prerequisites:
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
  graph: PrerequisiteGraph = buildPrerequisiteGraph(items),
): Map<string, ScheduleEntry> {
  const byId = new Map<string, PmItem>();
  for (const it of items) byId.set(it.id, it);

  const result = new Map<string, ScheduleEntry>();
  const visiting = new Set<string>();

  /**
   * Recursively forward-schedule a single item and cache its entry.
   *
   * The earliest start is the day after the latest finish of every gating
   * prerequisite (informational `related`/`duplicate` edges are ignored), then
   * the item is pulled to end on its own deadline when that deadline is still
   * reachable from that start. A node on the recursion stack returns `null`,
   * which is the cycle guard: it breaks a dependency loop by contributing no
   * constraint rather than recursing forever. Each computed entry is stored in
   * `result` so a prerequisite shared by several dependents is scheduled once.
   *
   * @param id - The item id to schedule.
   * @returns The scheduled entry, or `null` for a cycle hit.
   */
  function schedule(id: string): ScheduleEntry | null {
    const existing = result.get(id);
    if (existing) return existing;
    // All callers (the items loop and the recursive dep walk) pass ids that
    // are in byId; the former `if (!item) return null` guard was unreachable.
    const item = byId.get(id)!;
    if (visiting.has(id)) return null; // cycle guard
    visiting.add(id);

    // Earliest start = day after the latest dependency finishes.
    let start = new Date(anchor);
    for (const depId of graph.get(id)!) {
      if (!byId.has(depId)) continue;
      const depEntry = schedule(depId);
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
// Backward pass — total slack / float + infeasible-deadline detection
// ---------------------------------------------------------------------------

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
function computeSlack(
  items: PmItem[],
  schedule: Map<string, ScheduleEntry>,
  graph: PrerequisiteGraph = buildPrerequisiteGraph(items),
): Map<string, SlackEntry> {
  const byId = new Map<string, PmItem>();
  for (const it of items) byId.set(it.id, it);



  // Build successor adjacency: successors[depId] = [items depending on depId].
  const successors = new Map<string, string[]>();
  for (const it of items) {
    for (const depId of graph.get(it.id)!) {
      if (!byId.has(depId)) continue;
      if (!successors.has(depId)) successors.set(depId, []);
      successors.get(depId)!.push(it.id);
    }
  }

  // Project latest finish = the latest forward-pass end across all items.
  let projectEnd: Date | null = null;
  for (const entry of schedule.values()) {
    if (!projectEnd || entry.end.getTime() > projectEnd.getTime()) {
      projectEnd = new Date(entry.end);
    }
  }

  const latestFinish = new Map<string, Date>();
  const visiting = new Set<string>();

  /**
   * Latest-feasible finish date for `id` from the CPM backward pass.
   *
   * Starts from the project's latest finish, then tightens the bound two ways:
   * it must end the day before the earliest latest-start of any successor, and
   * it must finish on or before the item's own deadline. A node on the
   * recursion stack falls back to the project end, which is the cycle guard that
   * keeps a loop from deadlocking the pass. Results are cached in
   * `latestFinish` so each node is solved once.
   *
   * @param id - The item id whose latest finish to compute.
   * @returns The latest date the item may finish without delaying the project
   *   or breaching a downstream deadline.
   */
  function lf(id: string): Date {
    const cached = latestFinish.get(id);
    if (cached) return cached;
    // All callers (the result loop at the bottom and the recursive successor
    // walk below) guard on schedule.get(id) before invoking lf, so entry is
    // always defined here — the former unscheduled fallback was unreachable.
    const entry = schedule.get(id)!;
    if (visiting.has(id)) {
      // Cycle guard: contribute no successor constraint (mirror other passes).
      return projectEnd ?? entry.end;
    }
    visiting.add(id);

    // Start from the project's latest finish.  projectEnd is always
    // non-null here because lf is only called when schedule is non-empty
    // (all callers guard), and projectEnd is computed from schedule.values().
    let bound = new Date(projectEnd!);

    // Constrain by each successor: this item must finish the day BEFORE the
    // successor's latest start.
    for (const succId of successors.get(id) ?? []) {
      const succEntry = schedule.get(succId);
      if (!succEntry) continue;
      const succLatestStart = addDays(lf(succId), -(succEntry.durationDays - 1));
      const beforeSucc = addDays(succLatestStart, -1);
      if (beforeSucc.getTime() < bound.getTime()) bound = beforeSucc;
    }

    // Constrain by this item's OWN deadline (must finish on or before it).
    // byId.get(id) always finds the item because lf is only called with ids
    // that have schedule entries, and schedule entries only exist for items
    // in the items array (which byId is built from).
    const item = byId.get(id)!;
    const due = itemDueDate(item);
    const deadline = due ? parseDate(due) : null;
    if (deadline && deadline.getTime() < bound.getTime()) {
      bound = deadline;
    }

    visiting.delete(id);
    latestFinish.set(id, bound);
    return bound;
  }

  const result = new Map<string, SlackEntry>();
  for (const it of items) {
    const entry = schedule.get(it.id);
    if (!entry) continue;
    const finish = lf(it.id);
    const start = addDays(finish, -(entry.durationDays - 1));
    const slackDays = Math.round(
      (start.getTime() - entry.start.getTime()) / DAY_MS,
    );
    result.set(it.id, {
      // Negative slack means infeasible; report it (don't clamp) so callers can
      // distinguish "0 = on the critical path" from "<0 = already late".
      slackDays,
      latestStart: start,
      latestFinish: finish,
      infeasible: start.getTime() < entry.start.getTime(),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Row building (shared by terminal render and exporters)
// ---------------------------------------------------------------------------

/** An explicitly available capacity increase for one item's unchanged effort. */
export interface DeadlineCapacityShift {
  itemId: string;
  minutesPerDay: number;
}

/** Bounded, read-only scenario: every retained active item must meet the horizon. */
export interface DeadlineRepairOptions {
  from: string;
  deadline: string;
  capacityShifts?: readonly DeadlineCapacityShift[];
  deferrableIds?: readonly string[];
  forbiddenIds?: readonly string[];
  defaultDuration?: number;
  maxChanges?: number;
  maxProposals?: number;
  maxEvaluations?: number;
}

/** Exact hypothetical change, never a tracker mutation. */
export type DeadlineRepairMove =
  | { kind: "capacity_shift"; itemId: string; beforeDays: number; afterDays: number; minutesPerDay: number; addedMinutesPerDay: number }
  | { kind: "scope_deferral"; itemId: string; deferredMinutes: number };

/** Recomputed feasibility certificate and explicit resource/scope tradeoffs. */
export interface DeadlineRepairProposal {
  moves: DeadlineRepairMove[];
  affectedIds: string[];
  finish: string;
  retainedCount: number;
  deferredMinutes: number;
  addedMinutesPerDay: number;
}

/** Stable refusal codes let agents select remedies without parsing prose. */
export type DeadlineRepairRefusalCode = "invalid_scenario" | "invalid_graph" | "scenario_too_large" | "search_budget_exceeded" | "no_allowed_repair";

/** Small JSON/TOON-compatible result; no titles, bodies, or full schedule dump. */
export type DeadlineRepairResult =
  | { ok: false; code: DeadlineRepairRefusalCode; message: string; remedy: string }
  | { ok: true; baseline: { finish: string | null; infeasibleIds: string[] }; examined: number; minimalChanges: number; totalProposals: number; truncated: boolean; proposals: DeadlineRepairProposal[] };

/** Construct a typed refusal shared by validation and bounded search. */
function repairRefusal(code: DeadlineRepairRefusalCode, message: string, remedy: string): DeadlineRepairResult {
  return { ok: false, code, message, remedy };
}

/** Accept real calendar days only, avoiding date rollover and timezone ambiguity. */
function repairDate(value: string): Date | null {
  const date = parseDate(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && date && isoDay(date) === value ? date : null;
}

/** Evaluate a complete hypothetical schedule with the existing forward/backward passes. */
function repairSchedule(items: PmItem[], anchor: Date, horizon: Date, duration: number, graph: PrerequisiteGraph) {
  const schedule = computeSchedule(items, anchor, duration, graph);
  const slack = computeSlack(items, schedule, graph);
  let finish: Date | null = null;
  const horizonEnd = addDays(horizon, 1);
  const infeasibleIds: string[] = [];
  for (const item of items) {
    const end = schedule.get(item.id)!.end;
    if (finish === null || end > finish) finish = end;
    if (end >= horizonEnd || slack.get(item.id)!.infeasible) infeasibleIds.push(item.id);
  }
  return { schedule, finish: finish === null ? null : isoDay(finish), infeasibleIds };
}

/**
 * Enumerate the smallest feasible sets of explicitly allowed moves. Minimality
 * means fewest moves within this vocabulary (one move per item), not an
 * inferred resource allocation optimum. Capacity is dedicated to the named
 * item; the caller must ensure that offered capacity is actually available.
 * Deferral is legal only when no retained item requires deferred work. Closed
 * and canceled prerequisites are satisfied. All own deadlines and the scenario
 * horizon remain fixed. Search is exhaustive at the first successful size;
 * exhausting a budget refuses instead of making an unproved minimality claim.
 * Neither input items, graph, nor tracker state is modified.
 */
export function proposeDeadlineRepairs(
  corpus: readonly PmItem[], options: DeadlineRepairOptions,
  graph: PrerequisiteGraph = buildPrerequisiteGraph(corpus),
): DeadlineRepairResult {
  const anchor = repairDate(options.from);
  const horizon = repairDate(options.deadline);
  const duration = options.defaultDuration ?? 5;
  const maxChanges = options.maxChanges ?? 3;
  const maxProposals = options.maxProposals ?? 5;
  const maxEvaluations = options.maxEvaluations ?? 5000;
  const limits = [[duration, 365], [maxChanges, 3], [maxProposals, 10], [maxEvaluations, 10000]];
  if (!anchor || !horizon || horizon < anchor || limits.some(([value, max]) => !Number.isInteger(value) || value < 1 || value > max)) {
    return repairRefusal("invalid_scenario", "Invalid dates or search limits.", "Use real YYYY-MM-DD days with from <= deadline; duration 1..365, changes 1..3, proposals 1..10, evaluations 1..10000.");
  }
  const byId = new Map(corpus.map((item) => [item.id, item]));
  const items = corpus.filter((item) => item.status !== "closed" && item.status !== "canceled").sort((a, b) => a.id.localeCompare(b.id));
  if (corpus.length > 200 || [...graph.values()].reduce((sum, deps) => sum + deps.length, 0) > 2000) {
    return repairRefusal("scenario_too_large", "Scenario exceeds 200 items or 2000 ordering edges.", "Select a complete dependency-closed scenario within these limits.");
  }
  if (byId.size !== corpus.length || corpus.some((item) => !item.id || item.id.length > 128) || items.some((item) =>
    !graph.has(item.id) || graph.get(item.id)!.some((id) => !byId.has(id)) ||
    (itemDueDate(item) !== undefined && (!repairDate(itemDueDate(item)!.slice(0, 10)) || !parseDate(itemDueDate(item)!))) ||
    (item.estimated_minutes !== undefined && (!Number.isFinite(item.estimated_minutes) || item.estimated_minutes < 0 || item.estimated_minutes > 175200))
  )) {
    return repairRefusal("invalid_graph", "Duplicate ids, missing prerequisites, invalid deadlines or estimates.", "Supply unique ids (1..128 characters), complete ordering edges, real ISO deadlines and finite estimates of 0..175200 minutes.");
  }
  const activeIds = new Set(items.map((item) => item.id));
  const activeGraph = new Map(items.map((item) => [item.id, graph.get(item.id)!.filter((id) => activeIds.has(id))]));
  if (detectCycles(items, activeGraph).length > 0) {
    return repairRefusal("invalid_graph", "Ordering cycle prevents a valid schedule.", "Resolve the cycle explicitly before requesting deadline repairs.");
  }
  const shifts = options.capacityShifts ?? [];
  const deferrable = options.deferrableIds ?? [];
  const forbidden = new Set(options.forbiddenIds ?? []);
  if ([...shifts.map((shift) => shift.itemId), ...deferrable, ...forbidden].some((id) => !activeIds.has(id)) ||
    shifts.some((shift) => !Number.isInteger(shift.minutesPerDay) || shift.minutesPerDay <= MINUTES_PER_WORKDAY || shift.minutesPerDay > 4800 || !(byId.get(shift.itemId)!.estimated_minutes! > 0))) {
    return repairRefusal("invalid_scenario", "Moves must name active items and real capacity increases for estimated work.", "Use active ids; capacity needs a positive effort estimate and 481..4800 minutes/day. Omit forbidden moves or list them in forbiddenIds.");
  }
  const baseline = repairSchedule(items, anchor, horizon, duration, activeGraph);
  const summary = { finish: baseline.finish, infeasibleIds: baseline.infeasibleIds };
  if (baseline.infeasibleIds.length === 0) return { ok: true, baseline: summary, examined: 0, minimalChanges: 0, totalProposals: 0, truncated: false, proposals: [] };
  const candidates: DeadlineRepairMove[] = [];
  const seen = new Set<string>();
  for (const shift of shifts) {
    const item = byId.get(shift.itemId)!;
    const beforeDays = itemDurationDays(item, duration);
    const afterDays = Math.max(1, Math.ceil(item.estimated_minutes! / shift.minutesPerDay));
    const key = `${item.id}:${shift.minutesPerDay}`;
    if (!forbidden.has(item.id) && afterDays < beforeDays && !seen.has(key)) {
      candidates.push({ kind: "capacity_shift", itemId: item.id, beforeDays, afterDays, minutesPerDay: shift.minutesPerDay, addedMinutesPerDay: shift.minutesPerDay - MINUTES_PER_WORKDAY });
      seen.add(key);
    }
  }
  for (const id of new Set(deferrable)) {
    if (!forbidden.has(id)) {
      const item = byId.get(id)!;
      candidates.push({ kind: "scope_deferral", itemId: id, deferredMinutes: item.estimated_minutes || itemDurationDays(item, duration) * MINUTES_PER_WORKDAY });
    }
  }
  if (candidates.length > 24) return repairRefusal("scenario_too_large", "More than 24 effective allowed moves.", "Offer at most 24 distinct capacity/deferral moves, or forbid additional items.");
  candidates.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  let examined = 0;
  let exhausted = false;
  const proposals: DeadlineRepairProposal[] = [];
  /** Recompute one candidate set; reject incomplete scope deferrals and an empty plan. */
  function evaluate(moves: DeadlineRepairMove[]): void {
    if (examined >= maxEvaluations) { exhausted = true; return; }
    examined++;
    const deferred = new Set(moves.filter((move) => move.kind === "scope_deferral").map((move) => move.itemId));
    const retained = items.filter((item) => !deferred.has(item.id));
    if (retained.length === 0 || retained.some((item) => activeGraph.get(item.id)!.some((id) => deferred.has(id)))) return;
    const hypothetical = retained.map((item) => {
      const move = moves.find((entry) => entry.itemId === item.id && entry.kind === "capacity_shift");
      return move?.kind === "capacity_shift" ? { ...item, estimated_minutes: move.afterDays * MINUTES_PER_WORKDAY } : item;
    });
    const computed = repairSchedule(hypothetical, anchor!, horizon!, duration, activeGraph);
    if (computed.infeasibleIds.length > 0) return;
    const affectedIds = items.filter((item) => {
      if (moves.some((move) => move.itemId === item.id)) return true;
      const before = baseline.schedule.get(item.id)!;
      const after = computed.schedule.get(item.id)!;
      return before.start.getTime() !== after.start.getTime() || before.end.getTime() !== after.end.getTime();
    }).map((item) => item.id);
    proposals.push({ moves: [...moves], affectedIds, finish: computed.finish!, retainedCount: retained.length,
      deferredMinutes: moves.reduce((sum, move) => sum + (move.kind === "scope_deferral" ? move.deferredMinutes : 0), 0),
      addedMinutesPerDay: moves.reduce((sum, move) => sum + (move.kind === "capacity_shift" ? move.addedMinutesPerDay : 0), 0) });
  }
  /** Visit combinations in increasing cardinality, with at most one move per item. */
  function enumerate(start: number, remaining: number, chosen: DeadlineRepairMove[]): void {
    if (remaining === 0) { evaluate(chosen); return; }
    for (let index = start; index <= candidates.length - remaining; index++) {
      if (exhausted) break;
      const candidate = candidates[index];
      if (!chosen.some((move) => move.itemId === candidate.itemId)) enumerate(index + 1, remaining - 1, [...chosen, candidate]);
    }
  }
  for (let size = 1; size <= Math.min(maxChanges, candidates.length); size++) {
    enumerate(0, size, []);
    if (exhausted) return repairRefusal("search_budget_exceeded", "Search stopped before minimal proposals could be certified.", "Increase maxEvaluations (up to 10000) or narrow the explicit move set.");
    if (proposals.length > 0) {
      proposals.sort((a, b) => a.deferredMinutes - b.deferredMinutes || a.addedMinutesPerDay - b.addedMinutesPerDay || JSON.stringify(a.moves).localeCompare(JSON.stringify(b.moves)));
      return { ok: true, baseline: summary, examined, minimalChanges: size, totalProposals: proposals.length, truncated: proposals.length > maxProposals, proposals: proposals.slice(0, maxProposals) };
    }
  }
  return repairRefusal("no_allowed_repair", "No feasible repair within the allowed moves and maxChanges.", "Offer more capacity or dependency-complete scope deferrals, or raise maxChanges up to 3; deadline and dependency edits require a separate explicit decision.");
}

/**
 * Sort rank for a status so active work surfaces above finished or shelved items.
 *
 * In-progress sorts first, then open, blocked, closed, canceled, and finally
 * draft, which keeps each group's still-moving work at the top of its block in
 * {@link buildRows}. The numbers themselves are opaque; only their relative
 * order is meaningful.
 *
 * @param status - The pm item status to rank.
 * @returns A small integer used only for ordering.
 */
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
function buildRows(items: PmItem[], opts: GanttOptions, windowStart: Date, graph: PrerequisiteGraph = buildPrerequisiteGraph(items)): GanttRow[] {
  // --critical-only implies critical-path computation even without --critical-path.
  const needCritical = opts.criticalPath || opts.criticalOnly;
  const criticalIds = needCritical ? computeCriticalPath(items, graph) : new Set<string>();

  // --critical-only clips the input to just the critical-path items.
  let working = items;
  if (opts.criticalOnly) working = items.filter((i) => criticalIds.has(i.id));

  // Dependency-aware scheduling overrides created_at/deadline-derived bars.
  const scheduleMap = opts.schedule
    ? computeSchedule(working, windowStart, opts.defaultDuration, graph)
    : null;
  // Backward pass: total slack/float + infeasible-deadline detection. Only
  // meaningful when we have a forward schedule to measure against.
  const slackMap = scheduleMap ? computeSlack(working, scheduleMap, graph) : null;

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
    // Named groups sort before fallback groups; within each tier, alphabetical.
    if (aFallback !== bFallback) return aFallback ? 1 : -1;
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
        // Both passes populate every working item; row lookups cannot be absent.
        const entry = scheduleMap.get(item.id)!;
        itemStart = entry.start;
        // computeWeekRange treats end as exclusive; the scheduler's end is the
        // inclusive last work day, so add a day for the half-open range.
        itemEnd = addDays(entry.end, 1);
      } else {
        itemStart = item.created_at ? parseDate(item.created_at) : null;
        const due = itemDueDate(item);
        itemEnd = due ? parseDate(due) : null;
      }
      const range = computeWeekRange(itemStart, itemEnd, windowStart, opts.weeks);

      rows.push({
        group,
        item,
        prerequisites: graph.get(item.id)!,
        startWeek: range?.firstActive ?? null,
        endWeek: range?.lastActive ?? null,
        critical: criticalIds.has(item.id),
        start: itemStart,
        // expose the inclusive end for exporters (undo the +1 day from above)
        end: scheduleMap
          ? scheduleMap.get(item.id)!.end
          : itemEnd,
        slackDays: slackMap ? slackMap.get(item.id)!.slackDays : null,
        infeasible: slackMap ? slackMap.get(item.id)!.infeasible : false,
        progress: itemProgress(item),
        overdue: isOverdue(item, opts.today),
        // Only classify the no-bar reason when there is no in-window bar.
        offWindow:
          range === null
            ? classifyOffWindow(itemStart, itemEnd, windowStart, opts.weeks)
            : null,
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
const OFF_WINDOW_BEFORE = "←·"; // dates fall entirely before the window
const OFF_WINDOW_AFTER = "·→";  // dates fall entirely after the window
const COL_SEP = "  ";
const COL_GROUP = 18; // ASCII chart: group column width
const COL_ITEM = 24;  // ASCII chart: item column width
const COL_ST = 2;    // ASCII chart: status symbol column width
const WEEK_COL = 6;  // ASCII chart: week column width ("May 11" = 6 chars)

/** Append one full-width marker row (▼TODAY, ▼<milestone>) to the ASCII chart. */
function pushMarkerLine(lines: string[], markerCells: string[]): void {
  lines.push(
    `${"".padEnd(COL_GROUP)}  ${"".padEnd(COL_ITEM)}  ${"".padEnd(COL_ST)}  ${markerCells.join(COL_SEP)}`
  );
}

/** Half-filled block glyphs for a coarse 0..100 % progress indicator in ASCII.
 *  Mapped onto the existing 2-char cell width so alignment is preserved. */
function progressGlyph(pct: number): string {
  if (pct >= 100) return "██";
  if (pct >= 75) return "▓▓";
  if (pct >= 50) return "▓░";
  if (pct >= 25) return "░░";
  return "··";
}

/**
 * Single-glyph status marker for the ASCII chart's status column.
 *
 * Maps each status to one fixed-width character — `▶` for in-progress, `!` for
 * blocked, `✓` for closed, `✗` for canceled, and `○` for open/draft — so the
 * column stays aligned while still readable at a glance. The width-1 contract
 * matters because the column width is hard-coded in {@link renderGantt}.
 *
 * @param status - The pm item status to mark.
 * @returns One status glyph.
 */
function statusSymbol(status: PmItem["status"]): string {
  switch (status) {
    case "in_progress": return "▶";
    case "blocked":     return "!";
    case "closed":      return "✓";
    case "canceled":    return "✗";
    default:            return "○";
  }
}

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
function renderGantt(
  rows: GanttRow[],
  opts: GanttOptions,
  windowStart: Date
): string {
  const { weeks } = opts;

  // Build week header labels
  const weekLabels = buildWeekLabels(windowStart, weeks);

  // Column widths
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

  // TODAY marker line — parity with the mermaid `%% today:` marker. Drops a
  // caret in the week column that contains `today`, when it falls in-window.
  const todayWeek = todayColumn(opts, windowStart);
  if (todayWeek >= 0 && todayWeek < weeks) {
    const markerCells = weekLabels.map((_, w) =>
      (w === todayWeek ? "▼TODAY" : "").padEnd(WEEK_COL),
    );
    pushMarkerLine(lines, markerCells);
  }

  // Milestone marker line(s) — fixed release/deadline dates dropped as labeled
  // ▼<name> carets in the week column they land in (parity with ▼TODAY). When
  // several milestones share a week, their names are comma-joined in that cell.
  // The cell content may overflow WEEK_COL; that is intentional (the label is
  // the point), so we do not pad/truncate the joined names. Milestones outside
  // the window are skipped here and reported to stderr by the caller.
  const inWindowMilestones = opts.milestones.filter(
    (m) => milestoneWeek(m.date, windowStart, weeks) >= 0,
  );
  if (inWindowMilestones.length > 0) {
    const perWeek: string[][] = weekLabels.map(() => []);
    for (const m of inWindowMilestones) {
      const w = milestoneWeek(m.date, windowStart, weeks);
      perWeek[w].push(m.name);
    }
    const markerCells = weekLabels.map((_, w) =>
      perWeek[w].length > 0 ? `▼${perWeek[w].join(",")}` : "".padEnd(WEEK_COL),
    );
    pushMarkerLine(lines, markerCells);
  }
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
      // No in-window bar. Distinguish a genuinely undated item (`··`) from one
      // whose dates fall entirely outside the window (directional hint), so the
      // two no longer look identical. The hint is placed at the nearest edge
      // column and points toward where the work actually lives.
      const glyph =
        row.offWindow === "before"
          ? OFF_WINDOW_BEFORE
          : row.offWindow === "after"
            ? OFF_WINDOW_AFTER
            : BLOCK_UNDATED;
      for (let w = 0; w < weeks; w++) {
        if (row.offWindow === "before") {
          cells.push((w === 0 ? glyph : "  ").padEnd(WEEK_COL));
        } else if (row.offWindow === "after") {
          cells.push((w === weeks - 1 ? glyph : "  ").padEnd(WEEK_COL));
        } else {
          cells.push(BLOCK_UNDATED.padEnd(WEEK_COL));
        }
      }
    } else {
      for (let w = 0; w < weeks; w++) {
        if (w >= row.startWeek && w <= (row.endWeek!)) {
          // Active: critical-path items override, then in_progress/blocked vs open.
          // Under --progress, fill the bar's cells with a coarse completion glyph.
          let block: string;
          if (opts.progress) {
            block = progressGlyph(row.progress);
          } else {
            block = row.critical
              ? BLOCK_CRITICAL
              : item.status === "in_progress" || item.status === "blocked"
                ? BLOCK_ACTIVE
                : BLOCK_PLANNED;
          }
          cells.push(block.padEnd(WEEK_COL));
        } else {
          cells.push("  ".padEnd(WEEK_COL)); // empty
        }
      }
    }

    // Trailing annotations (do not affect the week-column grid alignment):
    //   • overdue items get a distinct "‼ OVERDUE" marker (default-on; data-driven).
    //   • --progress appends the numeric "NN%".
    const suffixParts: string[] = [];
    if (opts.progress) suffixParts.push(`${String(row.progress).padStart(3)}%`);
    if (row.overdue) suffixParts.push("‼ OVERDUE");
    const suffix = suffixParts.length > 0 ? "  " + suffixParts.join("  ") : "";

    lines.push(
      `${groupLabel}  ${itemLabel}  ${st}   ${cells.join(COL_SEP)}${suffix}`
    );
  }

  lines.push("━".repeat(Math.min(totalWidth, 90)));

  // Legend
  const anyOffWindow = rows.some((r) => r.offWindow === "before" || r.offWindow === "after");
  const anyOverdue = rows.some((r) => r.overdue);
  lines.push(
    `Legend: ${BLOCK_ACTIVE} in_progress/blocked  ${BLOCK_PLANNED} open/planned  ` +
      (opts.criticalPath ? `${BLOCK_CRITICAL} critical-path (*)  ` : "") +
      `${BLOCK_UNDATED} undated  ` +
      (anyOffWindow ? `${OFF_WINDOW_BEFORE}/${OFF_WINDOW_AFTER} off-window (earlier/later)  ` : "") +
      (opts.progress ? `progress: ·· 0% ░░ 25% ▓░ 50% ▓▓ 75% ██ 100%  ` : "") +
      (anyOverdue ? `‼ OVERDUE (deadline passed, not closed)  ` : "") +
      (inWindowMilestones.length > 0 ? `▼<name> milestone date  ` : "") +
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

/**
 * Map a status onto the Mermaid `gantt` task-state tag prefix that conveys it.
 *
 * Mermaid has no per-task status field, so `done,`/`active,`/`crit,` are its
 * closest native signals: closed becomes `done`, in-progress becomes `active`,
 * and canceled becomes `crit` — Mermaid's critical-task style, which renders
 * the bar in its emphasis color rather than striking it through, and is
 * borrowed here only because it is the most visually distinct tag available.
 * Open/draft carry no tag. Each
 * result is a trailing `, ` so it composes directly with the critical/overdue
 * tag assembled in {@link renderMermaid}.
 *
 * @param status - The pm item status to encode.
 * @returns The Mermaid tag prefix (including the trailing comma), or "".
 */
function mermaidStatusTag(status: PmItem["status"]): string {
  switch (status) {
    case "closed":      return "done, ";
    case "in_progress": return "active, ";
    case "canceled":    return "crit, ";
    default:            return "";
  }
}

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
function renderMermaid(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  const lines: string[] = [];
  const taskStyles = rows.map((row, index) => {
    const status = brandStatus(row.item.status);
    return `[id="t${index}"],[id$="-t${index}"]{fill:var(--pm-status-${status}-bg);stroke:var(--pm-status-${status}-border);stroke-width:${row.critical ? 3 : 1}px}[id="t${index}-text"][id],[id$="-t${index}-text"][id]{fill:var(--pm-status-${status}-fg)!important;${status === "canceled" ? "text-decoration:line-through;" : ""}}`;
  }).join("\n");
  lines.push(mermaidBrand(brandCss + `
    .section{fill:var(--pm-paper);opacity:1}
    .exclude-range{fill:var(--pm-sheet)}
    text{fill:var(--pm-carbon)}
    .taskText,.taskTextOutsideRight,.taskTextOutsideLeft{fill:var(--pm-carbon)}
    .sectionTitle{fill:var(--pm-carbon);font-family:var(--pm-font-caption);font-stretch:75%;font-weight:600}
    .titleText{fill:var(--pm-carbon);font-family:var(--pm-font-display);font-stretch:125%;font-weight:800}
    .grid .tick text{font-family:var(--pm-font-mono);fill:var(--pm-graphite)!important}
    .today{stroke:var(--pm-stamp)!important}
  ` + taskStyles));
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
    // Mermaid gantt has no per-task numeric % field; its closest native signals
    // are the `done`/`active`/`crit` task tags. We map status via
    // mermaidStatusTag (closed→done, in_progress→active, canceled→crit) and add
    // `crit` for critical-path AND overdue items (overdue == deadline-risk, the
    // semantic mermaid's `crit` styling conveys). The exact numeric progress is
    // preserved as a trailing `%% progress:` comment under --progress so no data
    // is lost while the diagram stays valid.
    const critTag = row.critical || row.overdue ? "crit, " : "";
    const tag = critTag + mermaidStatusTag(item.status);
    const name = mermaidSafe(`${item.title} [${item.id}] (${item.status})`);
    // `tag, id, startISO, endISO`
    lines.push(`    ${name} :${tag}${taskId}, ${isoDay(start)}, ${isoDay(end)}`);
    if (opts.progress) {
      lines.push(`    %% ${taskId} progress: ${row.progress}%${row.overdue ? " (overdue)" : ""}`);
    } else if (row.overdue) {
      lines.push(`    %% ${taskId} overdue: deadline ${itemDueDate(item) ?? "?"} passed`);
    }
  }

  // Mark a vertical "today" line within the window when applicable.
  const today = opts.today;
  if (today >= windowStart && today < windowEnd) {
    // Mermaid has no explicit today marker in source; documented via comment.
    lines.push(`    %% today: ${isoDay(today)}`);
  }

  // Milestones: Mermaid's native zero-duration `milestone` task. We emit one
  // per in-window milestone under a dedicated section so they render as the
  // diamond marker on their exact date. Out-of-window milestones are dropped
  // (the caller notes them on stderr). `0d` duration keeps it a point marker.
  const mileInWindow = opts.milestones.filter((m) => m.date >= windowStart && m.date < windowEnd);
  if (mileInWindow.length > 0) {
    lines.push("    section Milestones");
    let mi = 0;
    for (const m of mileInWindow) {
      lines.push(`    ${mermaidSafe(m.name)} :milestone, m${mi++}, ${isoDay(m.date)}, 0d`);
    }
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

/** Item-to-prerequisite adjacency shared by every scheduling traversal. */
export type PrerequisiteGraph = ReadonlyMap<string, readonly string[]>;

/**
 * Interpret stored relationships through the active SDK registry without
 * rewriting items. Only ordering definitions contribute constraints; execution
 * precedence reverses source-before-target rows. Equivalent inverse rows and
 * provenance-distinct copies collapse to one prerequisite. Unknown kinds stay
 * contextual, and an omitted kind retains the legacy blocked_by meaning.
 *
 * @param items - Complete item corpus whose relationships are being interpreted.
 * @param registry - Built-in and active extension definitions, or an explicit registry.
 * @returns Prerequisite ids in first-seen order for each item.
 */
export function buildPrerequisiteGraph(
  items: readonly PmItem[],
  registry: RelationshipKindRegistry = resolveWorkspaceRelationshipKindRegistry(),
): PrerequisiteGraph {
  const prerequisites = new Map<string, Set<string>>();
  for (const item of items) prerequisites.set(item.id, new Set());
  for (const item of items) {
    for (const dep of item.dependencies ?? []) {
      const definition = registry.resolve(dep.kind ?? "blocked_by");
      if (!definition?.ordering) continue;
      const sourceFirst = definition.precedence !== "target_before_source";
      const dependent = sourceFirst ? dep.id : item.id;
      const prerequisite = sourceFirst ? item.id : dep.id;
      // Inverse rows targeting absent work cannot constrain a present item.
      prerequisites.get(dependent)?.add(prerequisite);
    }
  }
  return new Map([...prerequisites].map(([id, deps]) => [id, Object.freeze([...deps])]));
}

/** Select custom ordering contracts; older hosts without a census use built-ins. */
function customOrderingContracts(contracts: ContractsResult, registry: RelationshipKindRegistry) {
  return (contracts.relationship_kind_contracts ?? []).filter((definition) => definition.ordering && !registry.resolve(definition.canonical));
}

/**
 * Combine built-in constraints with registered custom ordering from the
 * workspace SDK client. Module copies and injected clients can omit active
 * custom registrations, so resolve the workspace explicitly and use native
 * one-hop predecessor queries for registered custom ordering kinds.
 * Full queries remove neighbor limits; depth one deliberately selects direct
 * prerequisites.
 * No tracker or history mutation is requested.
 */
async function commandPrerequisiteGraph(items: PmItem[], pmRoot: string): Promise<PrerequisiteGraph> {
  const registry = resolveWorkspaceRelationshipKindRegistry();
  const graph = buildPrerequisiteGraph(items, registry);
  const client = new PmClient({ pmRoot });
  const contracts = await client.run("contracts", { options: {
    runtimeOnly: true, outputInclude: "full", outputBudget: "unbounded", outputLimit: "unbounded",
  } }) as ContractsResult;
  const custom = customOrderingContracts(contracts, registry);
  if (custom.length === 0) return graph;
  const kinds = custom.map((definition) => definition.canonical);
  const spellings = new Set(custom.flatMap((definition) => [definition.canonical, ...definition.aliases]));
  const combined = new Map(graph);
  // The SDK accepts one root per traversal. Bound host work and retain corpus order.
  for (let offset = 0; offset < items.length; offset += 4) {
    const batch = items.slice(offset, offset + 4);
    const results = await Promise.all(batch.map((item) => client.graph("predecessors", { id: item.id }, {
      kind: kinds, maxDepth: 1, full: true,
      outputInclude: "full", outputBudget: "unbounded", outputLimit: "unbounded",
    }) as Promise<GraphTraversalResult>));
    for (const [index, item] of batch.entries()) {
      const deps = new Set([...graph.get(item.id)!, ...results[index]!.ids!]);
      // Native closure omits the root; a registered self-order still forms a cycle.
      for (const dep of item.dependencies ?? []) {
        if (dep.id === item.id && spellings.has(String(dep.kind).trim().toLowerCase().replaceAll("-", "_"))) deps.add(item.id);
      }
      combined.set(item.id, Object.freeze([...deps]));
    }
  }
  return combined;
}

/** Resolve exporter prerequisites for both built rows and caller-supplied rows. */
function rowPrerequisites(rows: GanttRow[]): PrerequisiteGraph {
  const graph = buildPrerequisiteGraph(rows.map((row) => row.item));
  return new Map(rows.map((row) => [row.item.id, row.prerequisites ?? graph.get(row.item.id)!]));
}

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
function renderCsv(rows: GanttRow[], milestones: Milestone[] = []): string {
  const prerequisites = rowPrerequisites(rows);
  const header = "id,title,start,end,duration_days,slack_days,deps,status,critical,progress_percent,overdue,off_window";
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
    const slack = row.slackDays === null ? "" : String(row.slackDays);
    const deps = prerequisites.get(item.id)!.join(" ");
    lines.push(
      [
        csvField(item.id),
        csvField(item.title),
        csvField(start),
        csvField(end),
        csvField(duration),
        csvField(slack),
        csvField(deps),
        csvField(item.status),
        csvField(row.critical || row.slackDays === 0 ? "yes" : "no"),
        csvField(String(row.progress)),
        csvField(row.overdue ? "yes" : "no"),
        csvField(row.offWindow ?? ""),
      ].join(","),
    );
  }
  for (const m of milestones) {
    const day = isoDay(m.date);
    lines.push(
      [
        csvField(`milestone:${m.name}`),
        csvField(m.name),
        csvField(day),
        csvField(day),
        "", // duration_days
        "", // slack_days
        "", // deps
        csvField("milestone"),
        "", // critical
        "", // progress_percent
        "", // overdue
        "", // off_window
      ].join(","),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering — structured JSON schedule (machine-readable)
// ---------------------------------------------------------------------------

/** The computed CPM schedule as structured JSON. Unlike the ASCII chart (a
 *  rendered string) or `pm --json gantt` (chart string + summary counts), this
 *  gives agents and programmatic consumers the per-item plan — start/end,
 *  duration, slack, progress, critical-path membership, overdue/infeasible
 *  flags, gating deps — without parsing a chart or CSV. Deterministic: no
 *  wall-clock is embedded, so identical input yields byte-identical output. */
function renderJson(
  rows: GanttRow[],
  opts: GanttOptions,
  windowStart: Date,
  milestones: Milestone[] = [],
): string {
  const prerequisites = rowPrerequisites(rows);
  const summary = computeSummary(rows);
  const items = rows.map((row) => {
    const duration = rowDurationDays(row);
    return {
      id: row.item.id,
      title: row.item.title,
      type: row.item.type ?? null,
      status: row.item.status,
      group: row.group,
      start: row.start ? isoDay(row.start) : null,
      end: row.end ? isoDay(row.end) : null,
      durationDays: duration > 0 ? duration : null,
      slackDays: row.slackDays,
      progress: row.progress,
      // On the critical path if it is on the longest chain OR has zero total
      // float (mirrors the CSV `critical` column's predicate).
      critical: row.critical || row.slackDays === 0,
      overdue: row.overdue,
      infeasible: row.infeasible,
      offWindow: row.offWindow,
      deps: prerequisites.get(row.item.id)!,
    };
  });
  const payload = {
    window: { start: isoDay(windowStart), weeks: opts.weeks },
    options: {
      groupBy: opts.groupBy,
      statusFilter: opts.statusFilter,
      schedule: opts.schedule,
      criticalPath: opts.criticalPath,
      progress: opts.progress,
    },
    summary: {
      projectStart: summary.projectStart ? isoDay(summary.projectStart) : null,
      projectEnd: summary.projectEnd ? isoDay(summary.projectEnd) : null,
      spanDays: summary.spanDays,
      // Derived from the per-item `critical` flag above (not computeSummary,
      // which counts only longest-chain membership) so the count and the
      // items[] flags can never disagree within the same JSON payload.
      criticalPathLength: items.filter((i) => i.critical).length,
      totalTaskDays: summary.totalTaskDays,
      workload: summary.workload,
    },
    milestones: milestones.map((m) => ({ name: m.name, date: isoDay(m.date) })),
    items,
  };
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Rendering — standalone HTML
// ---------------------------------------------------------------------------

/**
 * Escape the HTML-significant characters in `s` for safe text interpolation.
 *
 * Replaces `&`, `<`, `>`, and `"` with their entity references so item titles
 * and ids can be dropped into the generated document without risking markup
 * injection or broken tags. It deliberately does not escape `'`, because every
 * attribute value written by {@link renderHtml} is double-quoted.
 *
 * @param s - The raw string drawn from item data.
 * @returns The string with the four dangerous characters entity-encoded.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  workload: { group: string; days: number }[];
}

/** Inclusive day span of a dated row, else 0. */
function rowDurationDays(row: GanttRow): number {
  if (!row.start || !row.end) return 0;
  return Math.max(1, Math.round((row.end.getTime() - row.start.getTime()) / DAY_MS) + 1);
}

/** Compute the footer summary stats shared by the HTML export. */
function computeSummary(rows: GanttRow[]): GanttSummary {
  let projectStart: Date | null = null;
  let projectEnd: Date | null = null;
  let totalTaskDays = 0;
  let criticalPathLength = 0;
  const workloadMap = new Map<string, number>();

  for (const row of rows) {
    if (row.critical) criticalPathLength++;
    const days = rowDurationDays(row);
    totalTaskDays += days;
    workloadMap.set(row.group, (workloadMap.get(row.group) ?? 0) + days);
    if (row.start && (!projectStart || row.start.getTime() < projectStart.getTime())) {
      projectStart = new Date(row.start);
    }
    if (row.end && (!projectEnd || row.end.getTime() > projectEnd.getTime())) {
      projectEnd = new Date(row.end);
    }
  }

  const spanDays =
    projectStart && projectEnd
      ? Math.max(1, Math.round((projectEnd.getTime() - projectStart.getTime()) / DAY_MS) + 1)
      : 0;

  const workload = [...workloadMap.entries()]
    .map(([group, days]) => ({ group, days }))
    .sort((a, b) => b.days - a.days || a.group.localeCompare(b.group));

  return { projectStart, projectEnd, spanDays, criticalPathLength, totalTaskDays, workload };
}

/** Return the week containing today, or -1 when the date falls outside the chart window. */
function todayColumn(opts: GanttOptions, windowStart: Date): number {
  return opts.today >= windowStart && opts.today < addWeeks(windowStart, opts.weeks)
    ? Math.floor((opts.today.getTime() - windowStart.getTime()) / (7 * DAY_MS)) : -1;
}

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
function renderHtml(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  const weeks = opts.weeks;
  const weekLabels = buildWeekLabels(windowStart, weeks);

  // TODAY column: highlight the week column containing opts.today (parity with
  // the ASCII ▼TODAY row and the Mermaid `%% today:` comment). -1 when today
  // falls outside the chart window, in which case no column is highlighted.
  const todayWeek = todayColumn(opts, windowStart);

  const headCols = weekLabels
    .map((l, i) => {
      const todayCls = i === todayWeek ? " today-col" : "";
      const todayMark = i === todayWeek ? '<br><span class="today-mark">▼ today</span>' : "";
      return `<th class="wk-th${todayCls}" title="${htmlEscape(l)}">W${i + 1}<br><span class="wk">${htmlEscape(l)}</span>${todayMark}</th>`;
    })
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
      let inner = "";
      if (row.startWeek === null) {
        // Distinguish off-window (directional hint) from genuinely undated.
        if (row.offWindow === "before" && w === 0) {
          cls = "cell offwindow";
          inner = '<span class="offwindow-hint" title="dates fall before this window">←</span>';
        } else if (row.offWindow === "after" && w === weeks - 1) {
          cls = "cell offwindow";
          inner = '<span class="offwindow-hint" title="dates fall after this window">→</span>';
        } else if (row.offWindow === "before" || row.offWindow === "after") {
          cls = "cell";
        } else {
          cls = "cell undated";
        }
      } else if (w >= row.startWeek && w <= (row.endWeek!)) {
        cls = row.critical
          ? "cell bar critical"
          : item.status === "in_progress" || item.status === "blocked"
            ? "cell bar active"
            : "cell bar planned";
        if (row.overdue) cls += " overdue";
        // --progress: overlay a fill whose width is the completion ratio.
        if (opts.progress) {
          inner = `<span class="fill" style="width:${row.progress}%"></span>`;
        }
      }
      if (w === todayWeek) cls += " today-col";
      cells.push(`<td class="${cls}">${inner}</td>`);
    }

    const critMark = row.critical ? ' <span class="crit-mark">★</span>' : "";
    const overdueMark = row.overdue ? ' <span class="overdue-mark" title="deadline passed, not closed">‼ overdue</span>' : "";
    const progressMark = opts.progress ? ` <span class="pct">${row.progress}%</span>` : "";
    const title = htmlEscape(item.title) + critMark + overdueMark + progressMark;
    const due = itemDueDate(item);
    bodyRows.push(
      `<tr class="status-${htmlEscape(item.status)}${row.overdue ? " is-overdue" : ""}">` +
        groupCell +
        `<td class="item"><span class="strip">${htmlEscape(item.id)} · ${htmlEscape(item.type ?? "Task")} · P${htmlEscape(String(item.priority ?? 2))}</span><br>${title}<br><span class="meta">${htmlEscape(item.id)}${due ? ' · due <span class="due">' + htmlEscape(isoDay(parseDate(due)!)) + "</span>" : ""}</span></td>` +
        `<td class="st" title="${htmlEscape(item.status)}"><span class="status-chip">${htmlEscape(item.status)}</span></td>` +
        cells.join("") +
        `</tr>`
    );
  }

  // Footer summary + (for --group-by assignee) per-assignee workload.
  const summary = computeSummary(rows);
  const spanText =
    summary.projectStart && summary.projectEnd
      ? `${isoDay(summary.projectStart)} → ${isoDay(summary.projectEnd)} (${summary.spanDays} day${summary.spanDays === 1 ? "" : "s"})`
      : "—";
  const summaryRows: string[] = [
    `<tr><th>Project span</th><td>${htmlEscape(spanText)}</td></tr>`,
    // Always plural: computeCriticalPath returns an empty set unless the longest
    // chain exceeds one item (`overall.len > 1`), so this count is 0 or >= 2 and
    // never 1. The singular arm this replaced was unreachable. If that guard is
    // ever relaxed to admit a lone item, restore the singular — the test pinning
    // criticalPathLength to 0 for a solo item fails first and points here.
    `<tr><th>Critical-path length</th><td>${summary.criticalPathLength} items</td></tr>`,
    `<tr><th>Total task-days</th><td>${summary.totalTaskDays}</td></tr>`,
  ];
  let workloadBlock = "";
  if (opts.groupBy === "assignee" && summary.workload.length > 0) {
    const workloadRows = summary.workload
      .map(
        (w) =>
          `<tr><td>${htmlEscape(w.group)}</td><td>${w.days} day${w.days === 1 ? "" : "s"}</td></tr>`,
      )
      .join("\n");
    workloadBlock = `<h2>Assignee workload</h2>
<table class="workload">
<thead><tr><th>Assignee</th><th>Total days</th></tr></thead>
<tbody>
${workloadRows}
</tbody>
</table>`;
  }

  const title = `pm gantt — ${weeks} weeks from ${isoDay(windowStart)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
  ${brandCss}
  * { box-sizing: border-box; }
  body { font-family: var(--pm-font-body); margin: clamp(12px, 3vw, 32px); background: var(--pm-paper); color: var(--pm-carbon); }
  h1 { font-family: var(--pm-font-display); font-stretch:125%; font-weight:800; font-size:clamp(1.2rem, 3vw, 2.3rem); margin:0 0 1.5rem; }
  table { border-collapse:separate; border-spacing:0 6px; font-size:.82rem; max-width:100%; table-layout:fixed; }
  th, td { padding:8px; text-align:left; overflow-wrap:anywhere; }
  th { font-family:var(--pm-font-caption); font-stretch:75%; font-weight:600; text-transform:uppercase; letter-spacing:.09em; color:var(--pm-graphite); vertical-align:bottom; }
  td { background:var(--pm-sheet); border-top:1px solid var(--pm-rule); border-bottom:1px solid var(--pm-rule); }
  td:first-child { border-left:1px solid var(--pm-rule); border-radius:var(--pm-radius) 0 0 var(--pm-radius); }
  td:last-child { border-right:1px solid var(--pm-rule); border-radius:0 var(--pm-radius) var(--pm-radius) 0; }
  .wk,.meta,.strip,.due,.pct,.summary td,.workload td,h1 time { font-family:var(--pm-font-mono); }
  .wk,.meta { color:var(--pm-graphite); font-size:.72rem; }
  .strip { font-size:.7rem; color:var(--pm-graphite); }
  td.group { font-weight:600; }
  td.item { width:30%; }
  .status-chip { display:inline-block; border:1px solid var(--pm-status-open-border); background:var(--pm-status-open-bg); color:var(--pm-status-open-fg); border-radius:var(--pm-radius-sm); padding:3px 5px; font-size:.7rem; }
  ${brandStatuses.map(status => `.status-${status} .status-chip { color:var(--pm-status-${status}-fg);background:var(--pm-status-${status}-bg);border-color:var(--pm-status-${status}-border); }`).join("\n  ")}
  .status-canceled .status-chip { text-decoration:line-through; }
  td.cell { width:28px; min-width:0; padding:0; position:relative; }
  td.bar { background:var(--pm-sheet); box-shadow:inset 0 0 0 1px var(--pm-carbon); }
  tr.status-in_progress td.bar { background:var(--pm-canary-wash); box-shadow:inset 0 0 0 1px var(--pm-canary); }
  tr.status-blocked td.bar { background:var(--pm-rose-wash); box-shadow:inset 0 0 0 1px var(--pm-rose); }
  tr.status-closed td.bar { box-shadow:inset 0 0 0 1px var(--pm-stamp); }
  tr.status-canceled td.bar { background:var(--pm-paper); box-shadow:inset 0 0 0 1px var(--pm-rule); }
  td.bar.critical { outline:2px solid var(--pm-carbon); outline-offset:-3px; }
  td.bar.overdue { border-bottom:3px dashed var(--pm-graphite); }
  td.cell.undated { background:repeating-linear-gradient(45deg,var(--pm-paper),var(--pm-paper) 4px,var(--pm-sheet) 4px,var(--pm-sheet) 8px); }
  td.cell.offwindow { text-align:center; color:var(--pm-carbon); font-weight:700; }
  .offwindow-hint { font-size:.95rem; }
  tr.is-overdue .due { font-weight:700; }
  .overdue-mark,.crit-mark,.pct,.today-mark { color:var(--pm-carbon); font-weight:600; }
  .overdue-mark { font-size:.72rem; }
  td.bar .fill { position:absolute; left:0; top:50%; bottom:0; background:var(--pm-carbon); opacity:.2; }
  th.today-col,td.today-col { border-left:2px solid var(--pm-stamp); }
  .today-mark { font-family:var(--pm-font-mono); font-size:.66rem; }
  .legend { margin-top:1rem; font-size:.78rem; color:var(--pm-graphite); display:flex; gap:12px; flex-wrap:wrap; }
  .legend span { display:inline-block; }
  h2 { font-family:var(--pm-font-caption); font-stretch:75%; text-transform:uppercase; letter-spacing:.09em; font-size:1rem; margin:1.4rem 0 .5rem; }
  table.summary,table.workload { width:100%; }
  :focus-visible { outline:var(--pm-focus); outline-offset:var(--pm-focus-offset); }
  @media(prefers-reduced-motion:reduce) { * { animation:none; transition:none; } }
  @media(max-width:600px) {
    table[style] { display:block; width:100%!important; table-layout:auto; }
    table[style] colgroup { display:none; }
    table[style] thead,table[style] tbody { display:block; width:100%; }
    table[style] tr { display:grid; width:100%; grid-template-columns:repeat(${weeks},minmax(0,1fr)); margin-bottom:12px; border:1px solid var(--pm-rule); border-radius:var(--pm-radius); background:var(--pm-sheet); padding:8px; }
    table[style] thead tr { border:0; border-radius:0; background:none; padding:0; }
    table[style] thead th:nth-child(-n+3) { display:none; }
    table[style] th { min-width:0; padding:4px; font-size:.7rem; }
    table[style] td { border:0!important; border-radius:0!important; padding:5px; }
    table[style] td.group,table[style] td.item,table[style] td.st { grid-column:1/-1; width:auto; }
    table[style] td.group:empty { display:none; }
    table[style] td.cell { width:auto; min-height:24px; }
  }
</style>
</head>
<body>
<h1>pm gantt — ${weeks} weeks from <time datetime="${isoDay(windowStart)}">${isoDay(windowStart)}</time></h1>
<table style="width:${opts.width}px">
<colgroup><col style="width:9%"><col style="width:30%"><col style="width:12%">${weekLabels.map(() => `<col style="width:${49 / weeks}%">`).join("")}</colgroup>
<thead>
<tr><th>Group</th><th>Item</th><th>Status</th>${headCols}</tr>
</thead>
<tbody>
${bodyRows.join("\n")}
</tbody>
</table>
<h2>Summary</h2>
<table class="summary">
<tbody>
${summaryRows.join("\n")}
</tbody>
</table>
${workloadBlock}
<div class="legend">
  ${brandStatuses.map(status => `<span class="status-${status}"><span class="status-chip">${status}</span></span>`).join("\n  ")}
  ${opts.criticalPath ? '<span>★ critical path</span>' : ""}
  <span>Hatched cells: undated</span><span>Dashed edge: overdue (deadline passed)</span>
  <span>← / → off-window (earlier / later)</span>
  ${opts.progress ? '<span>Lower band: % complete fill</span>' : ""}
  ${todayWeek >= 0 ? '<span>▼ today · current week</span>' : ""}
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Rendering — standalone SVG (vector Gantt)
//
// A self-contained SVG document mirroring the HTML table render: grouped rows,
// week columns, status-colored bars, critical-path highlighting, overdue,
// off-window hints, today marker, milestone diamonds, and a --progress fill.
// The chart width is controlled by --width (default 1000); the left label
// gutter and per-week column width are derived from it so the layout scales.
// ---------------------------------------------------------------------------

/** Escape a string for safe use inside SVG text nodes / attribute values. */
function svgEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Fit complete words to a conservative em budget; full text remains in SVG titles. */
function svgLabel(text: string, width: number, em: number): string {
  const limit = Math.floor(width / em);
  if (Array.from(text).length <= limit) return text;
  const prefix = Array.from(text).slice(0, limit - 1).join('');
  const boundary = text.slice(prefix.length).startsWith(' ') ? prefix.length : prefix.lastIndexOf(' ');
  return (boundary < 0 ? '' : prefix.slice(0, boundary).trimEnd()) + '…';
}

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
function renderSvg(rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  const weeks = opts.weeks;
  const weekLabels = buildWeekLabels(windowStart, weeks);
  const requestedW = Math.max(320, Math.round(opts.width));
  const PAD = 16;
  const GROUP_W = 110;
  const ITEM_W = 300;
  const STATUS_W = 110;
  const GUTTER = GROUP_W + ITEM_W + STATUS_W;
  const LEGEND_STEP = 125;
  const LEGEND_CHIP_W = 116;
  const W = Math.max(requestedW, PAD + GUTTER + PAD + weeks * 24, PAD * 2 + (brandStatuses.length - 1) * LEGEND_STEP + LEGEND_CHIP_W);
  const colW = (W - PAD - GUTTER - PAD) / weeks;
  const rowH = 52;
  const chartX = PAD + GUTTER;
  const chartY = PAD + 100;
  const legendH = 88;
  const H = chartY + rows.length * rowH + PAD + legendH;
  const todayWeek = todayColumn(opts, windowStart);
  const heading = `pm gantt — ${weeks} weeks from ${isoDay(windowStart)}${opts.criticalPath ? ' • critical path marked' : ''}`;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="var(--pm-carbon)" role="img" aria-labelledby="pm-gantt-title" style="max-width:100%;height:auto">`,
    `<title id="pm-gantt-title">${svgEscape(heading)}</title>`,
    `<style>${brandCss}
      text{font-family:var(--pm-font-body);fill:var(--pm-carbon)}
      .data{font-family:var(--pm-font-mono)} .caption{font-family:var(--pm-font-caption);font-stretch:75%;font-weight:600;letter-spacing:.09em}
      .secondary{fill:var(--pm-graphite)} .chip{rx:var(--pm-radius-sm)}
      .status-canceled .status-label{text-decoration:line-through}
      @media(prefers-reduced-motion:reduce){*{animation:none;transition:none}}
    </style>`,
    `<rect width="${W}" height="${H}" fill="var(--pm-paper)"/>`,
    `<text x="${PAD}" y="38" font-size="22" font-weight="800" style="font-family:var(--pm-font-display);font-stretch:125%">${svgEscape(svgLabel(heading, W - PAD * 2, 22 * 1.25)).replace(isoDay(windowStart), `<tspan class="data">${isoDay(windowStart)}</tspan>`)}</text>`,
  ];
  for (const [offset, label] of [[0, 'GROUP'], [GROUP_W, 'ITEM'], [GROUP_W + ITEM_W, 'STATUS']] as const) {
    parts.push(`<text class="caption secondary" x="${PAD + offset}" y="72" font-size="10">${label}</text>`);
  }
  for (let w = 0; w < weeks; w++) {
    const x = chartX + w * colW;
    parts.push(`<text class="data" x="${x + 2}" y="72" font-size="10">W${w + 1}</text>`);
    parts.push(`<text class="data secondary" x="${x + 2}" y="88" font-size="9">${svgEscape(weekLabels[w])}</text>`);
  }
  for (const m of opts.milestones) {
    const mw = milestoneWeek(m.date, windowStart, weeks);
    if (mw < 0) continue;
    const mx = chartX + mw * colW + colW / 2;
    const my = chartY - 14;
    parts.push(`<polygon points="${mx},${my - 5} ${mx + 5},${my} ${mx},${my + 5} ${mx - 5},${my}" fill="var(--pm-sheet)" stroke="var(--pm-carbon)"/>`);
    parts.push(`<text class="data" x="${mx + 7}" y="${my + 3}" font-size="9">${svgEscape(m.name)}</text>`);
  }
  let lastGroup = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const y = chartY + i * rowH;
    const status = brandStatus(row.item.status);
    parts.push(`<g class="status-${status}" data-item="${svgEscape(row.item.id)}">`);
    parts.push(`<title>${svgEscape(row.item.title)} · ${svgEscape(row.item.status)}${row.critical ? ' · critical path' : ''}</title>`);
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${rowH - 4}" rx="6" fill="var(--pm-sheet)" stroke="var(--pm-rule)"/>`);
    if (row.group !== lastGroup) parts.push(`<text x="${PAD + 6}" y="${y + 29}" font-size="11">${svgEscape(row.group)}</text>`);
    lastGroup = row.group;
    const ix = PAD + GROUP_W + 6;
    parts.push(`<clipPath id="pm-item-${i}"><rect x="${ix}" y="${y}" width="${ITEM_W - 12}" height="${rowH}"/></clipPath>`);
    parts.push(`<g clip-path="url(#pm-item-${i})"><text class="data secondary" x="${ix}" y="${y + 13}" font-size="8">${svgEscape(row.item.id)} · ${svgEscape(row.item.type ?? 'Task')} · P${svgEscape(String(row.item.priority ?? 2))}</text>`);
    parts.push(`<text x="${ix}" y="${y + 31}" font-size="11">${svgEscape(svgLabel((row.critical ? '* ' : '') + row.item.title, ITEM_W - 12, 11))}</text></g>`);
    const sx = PAD + GROUP_W + ITEM_W + 4;
    parts.push(`<rect class="chip" x="${sx}" y="${y + 18}" width="98" height="20" rx="3" fill="var(--pm-status-${status}-bg)" stroke="var(--pm-status-${status}-border)"/>`);
    parts.push(`<text class="status-label data" x="${sx + 5}" y="${y + 31}" font-size="9" style="fill:var(--pm-status-${status}-fg)">${svgEscape(row.item.status)}</text>`);
    for (let w = 0; w < weeks; w++) {
      const cx = chartX + w * colW;
      if (row.startWeek === null) {
        if (row.offWindow === 'before' && w === 0) parts.push(`<text x="${cx + colW / 2}" y="${y + 31}" font-size="12" text-anchor="middle">←</text>`);
        else if (row.offWindow === 'after' && w === weeks - 1) parts.push(`<text x="${cx + colW / 2}" y="${y + 31}" font-size="12" text-anchor="middle">→</text>`);
        continue;
      }
      if (w >= row.startWeek && w <= row.endWeek!) {
        const bw = Math.max(1, colW - 4);
        const by = y + 24;
        parts.push(`<rect x="${cx + 2}" y="${by}" width="${bw}" height="16" rx="3" fill="var(--pm-status-${status}-bg)" stroke="var(--pm-status-${status}-border)" stroke-width="${row.critical ? 3 : 1}"${row.overdue ? ' stroke-dasharray="3 2"' : ''}/>`);
        if (opts.progress) {
          const fw = Math.max(0, Math.min(bw, (row.progress / 100) * bw));
          if (fw > 0) parts.push(`<rect x="${cx + 2}" y="${by + 8}" width="${fw}" height="8" fill="var(--pm-carbon)" opacity=".2"/>`);
        }
      }
    }
    if (opts.progress && row.startWeek !== null) {
      const px = chartX + (Math.min(weeks - 1, row.endWeek!) + 1) * colW - 3;
      parts.push(`<text class="data" x="${px}" y="${y + 17}" font-size="9" text-anchor="end">${row.progress}%</text>`);
    }
    if (row.overdue) parts.push(`<text x="${W - PAD - 6}" y="${y + 46}" font-size="9" font-weight="700" text-anchor="end">‼ overdue</text>`);
    parts.push('</g>');
  }
  if (todayWeek >= 0) {
    const tx = chartX + todayWeek * colW + colW / 2;
    parts.push(`<line x1="${tx}" y1="${chartY - 6}" x2="${tx}" y2="${chartY + rows.length * rowH}" stroke="var(--pm-stamp)" stroke-width="1" stroke-dasharray="3 3"/>`);
    parts.push(`<text class="data" x="${tx + 2}" y="${chartY - 8}" font-size="9">▼ today</text>`);
  }
  const legendY = chartY + rows.length * rowH + PAD;
  brandStatuses.forEach((status, index) => {
    const lx = PAD + index * LEGEND_STEP;
    parts.push(`<g class="status-${status}"><rect x="${lx}" y="${legendY}" width="${LEGEND_CHIP_W}" height="22" rx="3" fill="var(--pm-status-${status}-bg)" stroke="var(--pm-status-${status}-border)"/><text class="status-label data" x="${lx + 5}" y="${legendY + 15}" font-size="9" style="fill:var(--pm-status-${status}-fg)">${status}</text></g>`);
  });
  parts.push(`<text class="secondary" x="${PAD}" y="${legendY + 46}" font-size="10">${opts.criticalPath ? '* critical path · ' : ''}Dashed edge: overdue${opts.progress ? ' · Lower band: % complete' : ''} · ← / → off-window</text>`);
  parts.push('</svg>');
  const paintTokens = new Set<keyof typeof brandValues.light>();
  const literal = parts.join('\n').replace(brandCss, '').replace(/style="fill:(var\(--pm-[\w-]+\))"/gu, 'fill="$1"')
    .replace(/(fill|stroke)="var\(--pm-([\w-]+)\)"/gu, (_match, attribute: string, token: string) => {
      const name = token as keyof typeof brandValues.light;
      paintTokens.add(name);
      return `${attribute}="${brandValue('light', name)}" data-pm-${attribute}="${name}"`;
    }).replace(/<style>[\s\S]*?<\/style>|style="[^"]*"/gu, css =>
      css.replace(/var\(--pm-([\w-]+)\)/gu, (_match, token: string) => brandValue('light', token as keyof typeof brandValues.light).replaceAll('"', "'")));
  /** Generate literal theme overrides while retaining presentation attributes for desktop renderers. */
  const paintRules = (theme: BrandTheme, scope: string): string =>
    `${scope} text{fill:${brandValue(theme, 'carbon')}}${scope} .secondary{fill:${brandValue(theme, 'graphite')}}` +
    [...paintTokens].flatMap(name => ['fill', 'stroke'].map(attribute =>
      `${scope} [data-pm-${attribute}="${name}"]{${attribute}:${brandValue(theme, name)}}`)).join('');
  const paints = `<style>${brandCss}${paintRules('light', ':root')}@media(prefers-color-scheme:dark){${paintRules('dark', ':root:not([data-theme="light"])')}}${paintRules('dark', ':root[data-theme="dark"]')}</style>`;
  return literal.replace('</svg>', paints + '</svg>');
}

// ---------------------------------------------------------------------------
// Shared option parsing + data fetch
// ---------------------------------------------------------------------------

/**
 * Return the first present, non-null value among the candidate option keys.
 *
 * Options arrive as a loose record whose keys may be the kebab-case CLI form
 * (`group-by`) or a camelCase alias (`groupBy`); this walks the given keys in
 * order and returns the first that is neither `undefined` nor `null`, so each
 * flag can accept both spellings without duplicating the lookup. A truly absent
 * option yields `undefined`, which the callers coerce to a documented default.
 *
 * @param options - The raw flag record handed to the command.
 * @param keys - The candidate key spellings, tried in preference order.
 * @returns The first present value, or `undefined` when none of the keys are set.
 */
function readOption(options: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Return the first option whose key is set, coerced to a boolean.
 *
 * The presence test is `!== undefined` alone. That is deliberately narrower than
 * {@link readOption}, which also skips `null` and keeps searching: here an
 * explicit `null` counts as present and coerces to `false`, ending the search.
 * Only a key that is entirely absent falls through to the `false` default, so a
 * flag the user set explicitly always beats that default.
 *
 * Coercion is plain `Boolean()`, with the usual JavaScript truthiness that
 * follows from it — every non-empty string is true, **including `"0"`**. This
 * helper is therefore only safe for flags the caller knows arrive as booleans or
 * as absent; do not route a value-taking flag through it and expect `"0"` or
 * `"false"` to read as false.
 *
 * @param options - The raw flag record handed to the command.
 * @param keys - The candidate key spellings, tried in preference order.
 * @returns The first present value coerced to boolean, or `false` when none are set.
 */
function readBoolOption(options: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (options[key] !== undefined) return Boolean(options[key]);
  }
  return false;
}

/** Parse the repair command's explicit move vocabulary without inferring permissions. */
function deadlineRepairOptions(options: Record<string, unknown>): DeadlineRepairOptions {
  /** Comma-separated ids are exact; empty flags offer no moves. */
  const ids = (key: string): string[] => String(readOption(options, key) ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  /** Missing numbers use SDK defaults; malformed numbers reach typed validation. */
  const number = (key: string, camel: string): number | undefined => {
    const raw = readOption(options, key, camel);
    return raw === undefined ? undefined : Number(raw);
  };
  return {
    from: String(readOption(options, "from") ?? ""), deadline: String(readOption(options, "deadline") ?? ""),
    capacityShifts: ids("capacity").map((entry) => {
      const [itemId, minutes, extra] = entry.split("=");
      return { itemId, minutesPerDay: extra === undefined ? Number(minutes) : NaN };
    }),
    deferrableIds: ids("defer"), forbiddenIds: ids("forbid"),
    defaultDuration: number("default-duration", "defaultDuration"), maxChanges: number("max-changes", "maxChanges"),
    maxProposals: number("max-proposals", "maxProposals"), maxEvaluations: number("max-evaluations", "maxEvaluations"),
  };
}

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
function resolveGanttOptions(options: Record<string, unknown>): ResolvedOptions {
  const rawGroupBy = readOption(options, "group-by", "groupBy") ?? "milestone";
  const groupBy: GroupBy = (GROUP_BY_VALUES as string[]).includes(String(rawGroupBy))
    ? (String(rawGroupBy) as GroupBy)
    : "milestone";

  const rawStatus = readOption(options, "status") ?? "all";
  const rawStatusText = String(rawStatus);
  const statusFilter: StatusFilter = rawStatusText === "all"
    ? "all"
    : PM_ITEM_STATUSES.find((status) => status === rawStatusText) ?? "all";

  const criticalPath = readBoolOption(options, "critical-path", "criticalPath");
  const criticalOnly = readBoolOption(options, "critical-only", "criticalOnly");
  const schedule = readBoolOption(options, "schedule");
  // --show-progress is an alias for --progress (both opt-in to % complete on bars).
  const progress = readBoolOption(options, "progress", "show-progress", "showProgress");

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

  // --width controls the render width (px) of vector/graphical formats (SVG,
  // and the HTML chart). It is ignored by ASCII/Mermaid/CSV/JSON. Default 1000;
  // clamped to [320, 8192] so absurd values never produce a broken canvas.
  const rawWidth = readOption(options, "width");
  let width = 1000;
  if (rawWidth !== undefined) {
    const parsed = parseInt(String(rawWidth), 10);
    if (isNaN(parsed) || parsed < 1) {
      throw new CommandError(
        `Invalid --width "${rawWidth}" (expected a positive integer of pixels).`,
        EXIT_CODE.USAGE,
      );
    }
    width = Math.max(320, Math.min(8192, parsed));
  }

  const milestones = parseMilestones(readOption(options, "milestones"));

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
    progress,
    width,
    milestones,
    windowStart,
  };
}

// Node's spawnSync defaults to a 1 MiB stdout cap, which a mature tracker's JSON
// dump passes at a few hundred items. Past that the child is killed with ENOBUFS,
// status null and EMPTY stderr, so the failure surfaces with nothing to diagnose
// (and at larger sizes stdout is genuinely truncated mid-document).
// 64 MiB matches the cap the sibling pm packages settled on.
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
function pmJsonMaxBuffer(): number {
  // Number(), not parseInt(): parseInt("64MiB") silently yields 64, which would
  // impose a 64-BYTE cap and break every ordinary read while appearing to honor
  // the documented invalid-value fallback. Number() rejects the whole string.
  const raw = Number(process.env.PM_JSON_MAX_BUFFER);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
}

/** True only for a JSON object, excluding arrays and `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Render an untrusted receipt value while preserving missing evidence. */
function describeReceiptValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  return String(JSON.stringify(value));
}

/** Receipt contracts whose completeness semantics this reader has verified. */
const SUPPORTED_READ_OUTPUT_CONTRACT_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Collect the pm 2026.8.21 receipt gaps not yet rejected by the public SDK. */
function supplementalCompleteListFindings(record: Record<string, unknown>): string[] {
  const findings: string[] = [];
  const completeness = isRecord(record.completeness) ? record.completeness : undefined;
  for (const field of ["unreadable_item_count", "unreadable_directory_count"] as const) {
    const value = completeness?.[field];
    if (value !== 0) {
      findings.push(`completeness.${field}=${describeReceiptValue(value)}`);
    }
  }

  const omission = isRecord(record.omission_receipt) ? record.omission_receipt : undefined;
  if (omission === undefined) {
    findings.push("omission_receipt=<missing>");
  } else {
    if (omission.has_omissions !== false) {
      findings.push(`omission_receipt.has_omissions=${describeReceiptValue(omission.has_omissions)}`);
    }
    if (!Number.isSafeInteger(omission.omitted_field_group_count) || omission.omitted_field_group_count !== 0) {
      findings.push(`omission_receipt.omitted_field_group_count=${describeReceiptValue(omission.omitted_field_group_count)}`);
    }
    if (!Array.isArray(omission.omitted_field_groups) || omission.omitted_field_groups.length !== 0) {
      findings.push(`omission_receipt.omitted_field_groups=${describeReceiptValue(omission.omitted_field_groups)}`);
    }
  }

  const readOutput = isRecord(record.read_output) ? record.read_output : undefined;
  if (readOutput === undefined) {
    findings.push("read_output=<missing>");
  } else {
    for (const [field, expected] of [
      ["command", "list"],
      ["within_budget", true],
      ["strings_compacted", false],
      ["rows_compacted", false],
      ["result_omitted", false],
    ] as const) {
      if (readOutput[field] !== expected) {
        findings.push(`read_output.${field}=${describeReceiptValue(readOutput[field])}`);
      }
    }
    const contractVersion = readOutput.contract_version;
    if (
      typeof contractVersion !== "number"
      || !SUPPORTED_READ_OUTPUT_CONTRACT_VERSIONS.has(contractVersion)
    ) {
      findings.push(`read_output.contract_version=${describeReceiptValue(contractVersion)}`);
    }
    const dimensions = readOutput.requested_dimensions;
    if (!Array.isArray(dimensions)) {
      findings.push("read_output.requested_dimensions=<missing>");
    } else {
      for (const dimension of ["include", "amount", "cost"] as const) {
        if (!dimensions.includes(dimension)) {
          findings.push(`read_output.requested_dimensions missing ${dimension}`);
        }
      }
    }
  }

  if (record.output_budget_truncation !== undefined) findings.push("output_budget_truncation=<present>");
  if (record.output_budget_exceeded !== undefined) findings.push("output_budget_exceeded=<present>");
  return findings;
}

/**
 * Decode only a complete, unbounded `pm list --all` envelope.
 *
 * The rows are untrusted subprocess JSON. Every independent completeness
 * signal is checked before a row is returned: pagination/truncation, corpus
 * readability, projection omissions, universal-output compaction, envelope
 * arithmetic, and stable row identities. Missing receipts fail closed because
 * an unverifiable workspace read is not a complete workspace read.
 *
 * @param parsed - JSON decoded from the installed `pm` CLI.
 * @returns Runtime-validated items whose envelope proves the whole workspace
 *          was read without degraded fields.
 * @throws {@link CommandError} When any receipt or row invariant is absent or
 *         contradictory.
 */
function decodeCompleteListAll(parsed: unknown): PmItem[] {
  const record = isRecord(parsed) ? parsed : undefined;
  const sdkFindings = inspectCompleteListResult(parsed).findings
    .map((finding) => `${finding.code}: ${finding.message}`);
  const findings = record === undefined
    ? sdkFindings
    : [...sdkFindings, ...supplementalCompleteListFindings(record)];
  if (findings.length > 0 || record === undefined) {
    const count = record && typeof record.count === "number" ? record.count : "unknown";
    const total = record && typeof record.total === "number" ? record.total : "unknown";
    throw new CommandError(
      `pm list --all complete-corpus answer was refused: ${findings.join("; ")}; count=${count} of total=${total}. `
      + "A partial tracker read would make a Gantt chart or export misleading; retry the canonical strict unbounded read.",
    );
  }
  const items = certifyCompleteListResult(record).items;

  const rows: PmItem[] = [];
  for (const item of items) {
    const status = typeof item.status === "string"
      ? PM_ITEM_STATUSES.find((candidate) => candidate === item.status)
      : undefined;
    if (typeof item.title !== "string" || status === undefined) {
      throw new CommandError(
        `Refusing unverifiable pm list --all output: item ${item.id} must have a string title and a supported status.`,
      );
    }
    const row: PmItem = { id: item.id, title: item.title, status };
    for (const field of [
      "body",
      "type",
      "due_date",
      "deadline",
      "milestone",
      "sprint",
      "release",
      "assignee",
      "created_at",
    ] as const) {
      if (item[field] !== undefined && typeof item[field] !== "string") {
        throw new CommandError(
          `Refusing unverifiable pm list --all output: item ${item.id} field ${field} must be a string when present.`,
        );
      }
      if (typeof item[field] === "string") row[field] = item[field];
    }
    if (
      item.priority !== undefined
      && typeof item.priority !== "string"
      && typeof item.priority !== "number"
    ) {
      throw new CommandError(
        `Refusing unverifiable pm list --all output: item ${item.id} priority must be a string or number when present.`,
      );
    }
    if (item.priority !== undefined) row.priority = item.priority;
    if (item.tags !== undefined) {
      if (!Array.isArray(item.tags)) {
        throw new CommandError(
          `Refusing unverifiable pm list --all output: item ${item.id} tags must be an array of strings when present.`,
        );
      }
      const tags: string[] = [];
      for (const tag of item.tags) {
        if (typeof tag !== "string") {
          throw new CommandError(
            `Refusing unverifiable pm list --all output: item ${item.id} tags must be an array of strings when present.`,
          );
        }
        tags.push(tag);
      }
      row.tags = tags;
    }
    if (item.meta !== undefined && !isRecord(item.meta)) {
      throw new CommandError(
        `Refusing unverifiable pm list --all output: item ${item.id} meta must be an object when present.`,
      );
    }
    if (item.meta !== undefined) row.meta = item.meta;
    if (
      item.estimated_minutes !== undefined
      && (typeof item.estimated_minutes !== "number" || !Number.isFinite(item.estimated_minutes) || item.estimated_minutes < 0)
    ) {
      throw new CommandError(
        `Refusing unverifiable pm list --all output: item ${item.id} estimated_minutes must be a non-negative finite number when present.`,
      );
    }
    if (item.estimated_minutes !== undefined) row.estimated_minutes = item.estimated_minutes;
    if (item.dependencies !== undefined) {
      if (!Array.isArray(item.dependencies)) {
        throw new CommandError(
          `Refusing unverifiable pm list --all output: item ${item.id} dependencies must be an array when present.`,
        );
      }
      const dependencies: PmDependency[] = [];
      for (const [dependencyIndex, dependency] of item.dependencies.entries()) {
        if (!isRecord(dependency) || typeof dependency.id !== "string" || dependency.id.trim().length === 0) {
          throw new CommandError(
            `Refusing unverifiable pm list --all output: item ${item.id} dependency ${dependencyIndex} must have a non-empty id.`,
          );
        }
        if (dependency.kind !== undefined && typeof dependency.kind !== "string") {
          throw new CommandError(
            `Refusing unverifiable pm list --all output: item ${item.id} dependency ${dependencyIndex} kind must be a string when present.`,
          );
        }
        if (dependency.created_at !== undefined && typeof dependency.created_at !== "string") {
          throw new CommandError(
            `Refusing unverifiable pm list --all output: item ${item.id} dependency ${dependencyIndex} created_at must be a string when present.`,
          );
        }
        dependencies.push({
          id: dependency.id,
          ...(typeof dependency.kind === "string" ? { kind: dependency.kind } : {}),
          ...(typeof dependency.created_at === "string" ? { created_at: dependency.created_at } : {}),
        });
      }
      row.dependencies = dependencies;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Shell out to `pm list --all --json` and return a proven-complete item list.
 *
 * Spawns the `pm` binary scoped to `pmRoot` with bodies included, using the
 * enlarged buffer from {@link pmJsonMaxBuffer} so a large tracker's JSON dump is
 * not truncated. The invocation requests strict, full, unbounded output; the
 * response then passes {@link decodeCompleteListAll}, independently proving
 * the CLI honored those controls before chart rendering begins. A subprocess,
 * parse, or completeness failure throws a {@link CommandError}, so a broken or
 * partial fetch never becomes an empty or misleading chart.
 *
 * @param pmRoot - The `--path` value pointing at the pm project to read.
 * @returns The decoded items, or an empty array when the project holds none.
 */
function fetchItems(pmRoot: string): PmItem[] {
  const maxBuffer = pmJsonMaxBuffer();
  const result = spawnSync(
    "pm",
    [
      "--pm-path",
      pmRoot,
      "list",
      "--all",
      "--json",
      "--include-body",
      "--strict-read",
      "--no-truncate",
      "--output-budget",
      "unbounded",
      "--output-limit",
      "unbounded",
      "--output-include",
      "full",
    ],
    { encoding: "utf-8", maxBuffer },
  );
  if (result.error || result.status !== 0) {
    throw new CommandError(
      `Failed to fetch pm items (exit ${result.status ?? "unknown"}): ${result.stderr?.trim() || result.error?.message || "no output"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err: unknown) {
    // JSON.parse always throws SyntaxError (extends Error), so the former
    // `: String(err)` arm was unreachable.  The cast is safe for that reason.
    throw new CommandError(
      `Failed to parse pm list --all output as JSON: ${(err as Error).message}`,
    );
  }
  return decodeCompleteListAll(parsed);
}

function filterByStatus(items: PmItem[], statusFilter: StatusFilter): PmItem[] {
  return statusFilter === "all" ? items : items.filter((i) => i.status === statusFilter);
}

/**
 * Collect infeasible-deadline warnings from scheduled rows. A row is infeasible
 * when its backward-pass latest-feasible start is before its earliest possible
 * start — the plan is already late for a downstream deadline. Returns one
 * human-readable line per affected item (empty when none / not scheduling).
 */
function infeasibleWarnings(rows: GanttRow[]): string[] {
  return rows
    .filter((r) => r.infeasible)
    .map((r) => {
      // r.infeasible is only true when the backward pass set slackDays to a
      // number, so the former `=== null ? 0` guard was unreachable.
      const slip = Math.abs(r.slackDays!);
      return `  • ${r.item.id} "${r.item.title}" is ${slip} day(s) late: its required start to hit a downstream deadline is before its earliest feasible start.`;
    });
}

/**
 * Names of milestones that fall entirely outside the rendered window (so they
 * cannot be drawn). Returned for a one-line stderr note. Exported for tests.
 */
export function offWindowMilestones(
  milestones: Milestone[],
  windowStart: Date,
  weeks: number,
): string[] {
  return milestones
    .filter((m) => milestoneWeek(m.date, windowStart, weeks) < 0)
    .map((m) => `${m.name} (${isoDay(m.date)})`);
}

/**
 * Output formats accepted by the `gantt` and `gantt export` commands.
 *
 * The tuple is `as const` so {@link ExportFormat} is the exact string union,
 * which lets {@link renderForFormat} and {@link defaultExtension} switch over it
 * exhaustively with no default arm. Order is the order shown in `--help`.
 */
export const EXPORT_FORMATS = ["mermaid", "html", "ascii", "csv", "json", "svg"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Dispatch to the renderer for the requested export format.
 *
 * A single switch over {@link ExportFormat} selects the matching renderer —
 * {@link renderMermaid}, {@link renderHtml}, {@link renderSvg},
 * {@link renderGantt} (ascii), {@link renderCsv}, or {@link renderJson} — so the
 * command handlers stay agnostic of the concrete output. The union is exhaustive,
 * so adding a format is a compile error here until a case is supplied.
 *
 * @param format - One of {@link EXPORT_FORMATS}.
 * @param rows - The render-ready rows from {@link buildRows}.
 * @param opts - The resolved chart options.
 * @param windowStart - The Monday that opens the chart window.
 * @returns The fully rendered document string for that format.
 */
function renderForFormat(format: ExportFormat, rows: GanttRow[], opts: GanttOptions, windowStart: Date): string {
  switch (format) {
    case "mermaid": return renderMermaid(rows, opts, windowStart);
    case "html":    return renderHtml(rows, opts, windowStart);
    case "svg":     return renderSvg(rows, opts, windowStart);
    case "ascii":   return renderGantt(rows, opts, windowStart);
    case "csv":     return renderCsv(rows, opts.milestones);
    case "json":    return renderJson(rows, opts, windowStart, opts.milestones);
  }
}

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
function defaultExtension(format: ExportFormat): string {
  switch (format) {
    case "mermaid": return "mmd";
    case "html":    return "html";
    case "svg":     return "svg";
    case "ascii":   return "txt";
    case "csv":     return "csv";
    case "json":    return "json";
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;

/** Shared timeline-shaping flags accepted by both terminal rendering and every
 * exporter format. A single definition prevents the derived `gantt export`
 * contract from drifting away from the options its handler actually reads. */
const GANTT_FLAGS = [
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
  {
    long: "--progress",
    description: "Show each item's % complete on its bar (closed/canceled 100%, in_progress 50% or acceptance-criteria ratio, open 0%)",
  },
  {
    long: "--show-progress",
    description: "Alias for --progress: show each item's % complete on its bar",
  },
  {
    long: "--width",
    value_name: "px",
    description: "Render width in pixels for vector/graphical formats (SVG export, HTML chart). Default: 1000; clamped to 320..8192",
  },
  {
    long: "--milestones",
    value_name: "list",
    description:
      "Draw fixed release/deadline dates as labeled vertical markers. Comma-separated name=YYYY-MM-DD (e.g. \"v1.0=2026-06-30,v1.1=2026-08-15\")",
  },
] satisfies FlagDefinition[];

/** First-class SDK metadata for the derived `gantt export` command.
 *
 * Exporters are executable without this metadata, but their derived command
 * otherwise accepts only the implicit optional file argument. Registering the
 * complete contract makes documented flags parseable and discoverable through
 * help, activation receipts, and agent command introspection. */
const GANTT_EXPORT_OPTIONS = {
  action: "gantt-export",
  description: "Export the Gantt chart as Mermaid, HTML, SVG, ASCII, CSV, or structured JSON.",
  intent: "Export a filtered, optionally scheduled project timeline as a portable artifact.",
  examples: [
    "pm --quiet gantt export --format json --schedule",
    "pm gantt export --format mermaid --output roadmap.mmd",
    "pm gantt export --format html --group-by assignee --critical-path --output team.html",
  ],
  failure_hints: [
    `Use --format with one of: ${EXPORT_FORMATS.join(" | ")}.`,
    "Use --output <path> to write an artifact; omit it to render on stdout.",
  ],
  flags: [
    ...GANTT_FLAGS,
    {
      long: "--format",
      value_name: "format",
      description: `Artifact format: ${EXPORT_FORMATS.join(" | ")} (default: mermaid)`,
    },
    {
      long: "--output",
      value_name: "path",
      description: "Write the artifact to this path instead of stdout.",
    },
  ],
} satisfies ImportExportRegistrationOptions;

export default defineExtension({
  name: "pm-gantt-chart",
  version: "2026.10.20",

  activate(api: ExtensionApi) {
    api.registerCommand({
      name: "gantt repair",
      description: "Propose minimal explicit capacity or scope changes for an infeasible deadline.",
      intent: "Evaluate deadline repairs without modifying items, deadlines or dependencies.",
      read_output: { row_keys: [] },
      examples: ["pm gantt repair --from 2026-10-21 --deadline 2026-10-30 --capacity task-a=960 --defer task-b --json"],
      failure_hints: ["Offer capacity with --capacity id=minutesPerDay or scope with --defer id,id; protect work with --forbid id,id."],
      flags: [
        { long: "--from", value_name: "day", description: "Required inclusive start day (YYYY-MM-DD)." },
        { long: "--deadline", value_name: "day", description: "Required fixed completion horizon (YYYY-MM-DD)." },
        { long: "--capacity", value_name: "moves", description: "Explicit dedicated capacity offers: id=minutesPerDay,id=minutesPerDay (481..4800)." },
        { long: "--defer", value_name: "ids", description: "Exact ids allowed to leave this scenario; retained dependents prevent deferral." },
        { long: "--forbid", value_name: "ids", description: "Exact ids that cannot be changed or deferred; overrides offers." },
        { long: "--default-duration", value_name: "days", description: "Fallback calendar days for unestimated work (default 5, max 365)." },
        { long: "--max-changes", value_name: "n", description: "Maximum moves per proposal (default/max 3)." },
        { long: "--max-proposals", value_name: "n", description: "Output proposals (default 5, max 10); total and truncation stay explicit." },
        { long: "--max-evaluations", value_name: "n", description: "Search evaluations (default 5000, max 10000); exhaustion refuses." },
      ],
      async run(ctx: CommandHandlerContext) {
        const items = fetchItems(ctx.pm_root);
        const graph = await commandPrerequisiteGraph(items, ctx.pm_root);
        const result = proposeDeadlineRepairs(items, deadlineRepairOptions(ctx.options), graph);
        return result.ok ? result : { ...result, exit_code: EXIT_CODE.USAGE, remediation: result.remedy };
      },
    });
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
        "pm gantt --progress",
        "pm gantt --show-progress",
        "pm gantt --milestones \"v1.0=2026-06-30,v1.1=2026-08-15\"",
      ],
      flags: GANTT_FLAGS,

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

        // Preflight data-sanity gate: hard-fail on dependency cycles (scheduling
        // impossible), warn on soft issues (deadline<start, absurd estimate).
        // Runs over all status-filtered items so a cycle anywhere is caught.
        const graph = await commandPrerequisiteGraph(allItems, ctx.pm_root);
        runDataSanityGate(allItems, "gantt", ctx.global?.json, graph);

        const rows = buildRows(items, opts, opts.windowStart, graph);
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

        // Backward-pass infeasible-deadline warnings (only under --schedule).
        const warnings = infeasibleWarnings(rows);

        // Print the human-readable chart to stdout, but not under --json:
        // mixing it with the JSON payload would corrupt machine-readable output.
        // The chart is still returned in the result object for JSON consumers.
        const droppedMilestones = offWindowMilestones(opts.milestones, opts.windowStart, opts.weeks);
        if (!ctx.global?.json) {
          process.stdout.write(chart + "\n");
          if (droppedMilestones.length > 0) {
            process.stderr.write(
              `NOTE: ${droppedMilestones.length} milestone(s) fall outside the chart window and were not drawn: ${droppedMilestones.join(", ")}\n`,
            );
          }
          if (warnings.length > 0) {
            process.stderr.write(
              `\nWARNING: ${warnings.length} item(s) have an infeasible deadline (plan already late):\n` +
                warnings.join("\n") +
                "\n",
            );
          }
        }

        const overdueRows = rows.filter((r) => r.overdue);
        const offWindowCount = rows.filter((r) => r.offWindow === "before" || r.offWindow === "after").length;
        const undatedCount = rows.filter((r) => r.offWindow === "undated").length;
        if (!ctx.global?.json && overdueRows.length > 0) {
          process.stderr.write(
            `\nNOTE: ${overdueRows.length} item(s) are overdue (deadline passed, not closed):\n` +
              overdueRows
                .map((r) => `  • ${r.item.id} "${r.item.title}" (due ${itemDueDate(r.item)})`)
                .join("\n") +
              "\n",
          );
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
          progress: opts.progress,
          ...(opts.milestones.length > 0
            ? {
                milestones: opts.milestones.map((m) => ({
                  name: m.name,
                  date: isoDay(m.date),
                  week: milestoneWeek(m.date, opts.windowStart, opts.weeks),
                  inWindow: milestoneWeek(m.date, opts.windowStart, opts.weeks) >= 0,
                })),
              }
            : {}),
          overdueCount: overdueRows.length,
          offWindowCount,
          undatedCount,
          ...(overdueRows.length > 0
            ? { overdue: overdueRows.map((r) => ({ id: r.item.id, deadline: itemDueDate(r.item)! })) }
            : {}),
          ...(opts.progress
            ? { itemProgress: rows.map((r) => ({ id: r.item.id, percent: r.progress })) }
            : {}),
          ...(opts.schedule ? { defaultDuration: opts.defaultDuration } : {}),
          ...(opts.schedule
            ? {
                tasks: rows.map((r) => ({
                  id: r.item.id,
                  slack_days: r.slackDays,
                  critical: r.critical,
                  infeasible: r.infeasible,
                })),
                infeasibleCount: warnings.length,
                ...(warnings.length > 0 ? { warnings } : {}),
              }
            : {}),
        };
      },
    });

    // -----------------------------------------------------------------------
    // Exporter: gantt  →  `pm gantt export`
    // Writes the chart to a file (or stdout) as Mermaid `gantt`, standalone
    // HTML, ASCII, CSV, or structured JSON (the computed schedule).
    // registerRenderer only supports toon|json, so a new output format must go
    // through the exporter pipeline.
    // -----------------------------------------------------------------------
    api.registerExporter("gantt", async (ctx: ImportExportContext) => {
      const opts = resolveGanttOptions(ctx.options);

      const rawFormat = String(readOption(ctx.options, "format") ?? "mermaid").toLowerCase();
      if (!EXPORT_FORMATS.includes(rawFormat as ExportFormat)) {
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

      // Same preflight gate as the `gantt` command: a cycle would otherwise emit
      // a silently-wrong artifact. Warnings go to stderr (never the artifact).
      const graph = await commandPrerequisiteGraph(allItems, ctx.pm_root);
      runDataSanityGate(allItems, "gantt export", ctx.global?.json, graph);

      const rows = buildRows(items, opts, opts.windowStart, graph);
      if (rows.length === 0) {
        console.error("No matching pm items to export (e.g. --critical-only with no chain).");
        return { exported: 0, format };
      }
      const output = renderForFormat(format, rows, opts, opts.windowStart);
      const exportedCount = rows.length;

      const droppedMilestones = offWindowMilestones(opts.milestones, opts.windowStart, opts.weeks);
      if (droppedMilestones.length > 0) {
        console.error(
          `gantt export NOTE: ${droppedMilestones.length} milestone(s) fall outside the chart window and were omitted: ${droppedMilestones.join(", ")}`,
        );
      }

      // Surface backward-pass infeasible-deadline warnings on stderr so they do
      // not corrupt the exported artifact written to stdout / a file.
      const warnings = infeasibleWarnings(rows);
      if (warnings.length > 0) {
        console.error(
          `gantt export WARNING: ${warnings.length} item(s) have an infeasible deadline (plan already late):\n` +
            warnings.join("\n"),
        );
      }

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
    }, GANTT_EXPORT_OPTIONS);

    // -----------------------------------------------------------------------
    // Preflight (capability surface): a scoped, pass-through override.
    //
    // The package's real data-sanity gate runs inside the gantt command /
    // exporter handlers (see runDataSanityGate): the pm runtime wraps
    // registerPreflight overrides in try/catch and downgrades a thrown error to
    // a non-fatal warning, so a throw HERE would NOT abort the command. We still
    // register a scoped preflight so the extension truthfully advertises the
    // "preflight" capability. The scope declares every command path pm-gantt-chart
    // owns — the registered `gantt` command AND the `gantt export` alias the
    // runtime derives from the exporter registration — so the override cannot
    // contend with another package's preflight override: an unscoped (global)
    // override collides pairwise with every other installed package's override
    // (pm health reports extension_preflight_override_collision). Both paths
    // were covered by accident under the global form; omitting the export alias
    // from the scope would silently exclude it again the moment this override
    // ever gains enforcement. The override leaves the runtime decision untouched
    // (empty delta).
    // -----------------------------------------------------------------------
    api.registerPreflight({
      commands: ["gantt", "gantt export", "gantt repair"],
      run: () => {
        // Intentionally no enforcement here (runtime swallows throws); the real
        // data-sanity gate is enforced in the command and exporter handlers
        // (runDataSanityGate). This override only advertises the preflight
        // capability for the command paths pm-gantt-chart owns and returns an
        // empty delta (no runtime decision change).
        return {};
      },
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
  computeSlack,
  computeCriticalPath,
  computeSummary,
  itemDurationDays,
  renderCsv,
  renderJson,
  renderMermaid,
  renderGantt,
  renderHtml,
  renderSvg,
  infeasibleWarnings,
  buildRows,
  resolveGanttOptions,
  getGroupKey,
  defaultExtension,
  customOrderingContracts,
  commandPrerequisiteGraph,
};
// itemProgress, isOverdue, classifyOffWindow are already `export function`s above.
export type { PmItem, GanttOptions, GanttRow, GroupBy, ScheduleEntry, SlackEntry, GanttSummary, OffWindow, Milestone };
