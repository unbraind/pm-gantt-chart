import { spawnSync } from "node:child_process";
import type { defineExtension as defineExtensionType, CommandHandlerContext, ExtensionApi  } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PmItem {
  id: string;
  title: string;
  body?: string;
  status: "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft";
  priority?: string;
  type?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  due_date?: string; // ISO date string e.g. "2026-06-15"
  milestone?: string;
  created_at?: string; // ISO date string
}

type GroupBy = "milestone" | "tag" | "type";
type StatusFilter = "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft" | "all";

interface GanttOptions {
  weeks: number;
  groupBy: GroupBy;
  statusFilter: StatusFilter;
  today: Date;
}

interface GanttRow {
  group: string;
  item: PmItem;
  startWeek: number | null; // 0-based week index, null = undated
  endWeek: number | null;   // 0-based week index (inclusive), null = undated
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
      return item.milestone?.trim() || "(no milestone)";
    case "tag":
      return item.tags && item.tags.length > 0
        ? item.tags[0]
        : "(no tag)";
    case "type":
      return item.type?.trim() || "(no type)";
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BLOCK_ACTIVE = "██";
const BLOCK_PLANNED = "░░";
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
  const todayStr = opts.today.toISOString().slice(0, 10);
  lines.push(`pm gantt  •  ${weeks} weeks from ${todayStr}`);
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

    // Item title (truncated)
    const itemLabel = item.title.slice(0, COL_ITEM).padEnd(COL_ITEM);

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
          // Active: use different block for in_progress/blocked vs open
          const block =
            item.status === "in_progress" || item.status === "blocked"
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
    `Legend: ${BLOCK_ACTIVE} in_progress/blocked  ${BLOCK_PLANNED} open/planned  ${BLOCK_UNDATED} undated  ` +
      `S: ▶in_progress  !blocked  ✓closed  ○open`
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-gantt-chart-chart",
  version: "0.1.0",

  activate(api: ExtensionApi) {
    api.registerCommand({
      name: "gantt",
      description: "Render pm items as an ASCII Gantt chart",
      intent: "visualize project timeline week-by-week in the terminal",
      examples: [
        "pm gantt",
        "pm gantt --weeks 12",
        "pm gantt --group-by tag",
        "pm gantt --group-by type --weeks 6",
        "pm gantt --status in_progress",
        "pm gantt --status open --weeks 16",
      ],
      flags: [
        {
          long: "--weeks",
          value_name: "n",
          description: "Number of weeks to show (default: 8)",
        },
        {
          long: "--group-by",
          value_name: "field",
          description:
            "Group items by: milestone | tag | type (default: milestone)",
        },
        {
          long: "--status",
          value_name: "filter",
          description:
            "Filter by status: open | in_progress | blocked | closed | canceled | draft | all (default: all)",
        },
      ],

      async run(ctx: CommandHandlerContext) {
        // --- Parse flags ---
        const rawWeeks = ctx.options["weeks"];
        const weeks = rawWeeks ? Math.max(1, Math.min(52, parseInt(String(rawWeeks), 10))) : 8;

        const rawGroupBy = ctx.options["group-by"] ?? "milestone";
        const groupBy: GroupBy = ["milestone", "tag", "type"].includes(String(rawGroupBy))
          ? (String(rawGroupBy) as GroupBy)
          : "milestone";

        const rawStatus = ctx.options["status"] ?? "all";
        const statusFilter: StatusFilter = [
          "open", "in_progress", "blocked", "closed", "canceled", "draft", "all",
        ].includes(String(rawStatus))
          ? (String(rawStatus) as StatusFilter)
          : "all";

        // --- Fetch items ---
        const result = spawnSync("pm", ["--path", ctx.pm_root, "list-all", "--json"], { encoding: "utf-8" });
        if (result.error || result.status !== 0) {
          return { error: "Failed to fetch pm items", details: result.stderr };
        }
        const allItems: PmItem[] = JSON.parse(result.stdout).items ?? [];

        if (allItems.length === 0) {
          console.error("No pm items found. Add some items first.");
          return { chart: null, itemCount: 0 };
        }

        // --- Filter by status ---
        const items =
          statusFilter === "all"
            ? allItems
            : allItems.filter((i) => i.status === statusFilter);

        if (items.length === 0) {
          console.error(`No items with status "${statusFilter}". Try --status all.`);
          return { chart: null, itemCount: 0, warning: `No items with status "${statusFilter}"` };
        }

        // --- Build opts ---
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const windowStart = weekStart(today);

        const opts: GanttOptions = {
          weeks,
          groupBy,
          statusFilter,
          today,
        };

        // --- Group items ---
        const groupMap = new Map<string, PmItem[]>();
        for (const item of items) {
          const key = getGroupKey(item, groupBy);
          if (!groupMap.has(key)) groupMap.set(key, []);
          groupMap.get(key)!.push(item);
        }

        // Sort groups: named groups first (alphabetically), then fallback "(no *)" groups
        const sortedGroups = [...groupMap.keys()].sort((a, b) => {
          const aFallback = a.startsWith("(no ");
          const bFallback = b.startsWith("(no ");
          if (aFallback && !bFallback) return 1;
          if (!aFallback && bFallback) return -1;
          return a.localeCompare(b);
        });

        // --- Build rows ---
        const rows: GanttRow[] = [];

        for (const group of sortedGroups) {
          const groupItems = groupMap.get(group)!;

          // Sort items within group: in_progress first, then open, then blocked, then closed
          const statusOrder: Record<PmItem["status"], number> = {
            in_progress: 0,
            open: 1,
            blocked: 2,
            closed: 3,
            canceled: 4,
            draft: 5,
          };
          groupItems.sort(
            (a, b) => statusOrder[a.status] - statusOrder[b.status]
          );

          for (const item of groupItems) {
            // Compute week range from created_at → due_date
            const itemStart = item.created_at ? parseDate(item.created_at) : null;
            const itemEnd = item.due_date ? parseDate(item.due_date) : null;

            const range = computeWeekRange(
              itemStart,
              itemEnd,
              windowStart,
              weeks
            );

            rows.push({
              group,
              item,
              startWeek: range?.firstActive ?? null,
              endWeek: range?.lastActive ?? null,
            });
          }
        }

        // --- Render ---
        const chart = renderGantt(rows, opts, windowStart);

        // Print to stdout
        process.stdout.write(chart + "\n");

        return {
          chart,
          itemCount: items.length,
          groupCount: sortedGroups.length,
          weeks,
          groupBy,
          statusFilter,
        };
      },
    });
  },
});
