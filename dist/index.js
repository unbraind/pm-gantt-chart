import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
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
};
class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
/** pm has no `milestone` field; map the "milestone" grouping onto its closest
 * canonical fields (sprint, then release). */
function itemMilestone(item) {
    return item.milestone ?? item.sprint ?? item.release;
}
/** pm exposes the due date as `deadline`; older payloads may use `due_date`. */
function itemDueDate(item) {
    return item.deadline ?? item.due_date;
}
const GROUP_BY_VALUES = [
    "milestone",
    "sprint",
    "release",
    "tag",
    "type",
    "assignee",
    "status",
];
// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
/** Returns the Monday of the week containing `d`. */
function weekStart(d) {
    const day = d.getDay(); // 0=Sun … 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    const mon = new Date(d);
    mon.setHours(0, 0, 0, 0);
    mon.setDate(d.getDate() + diff);
    return mon;
}
/** Adds `n` weeks (7 * n days) to `d`. */
function addWeeks(d, n) {
    const result = new Date(d);
    result.setDate(result.getDate() + n * 7);
    return result;
}
/** Short label for the week starting on `d`: "May 11", "Jun  2", etc. */
function weekLabel(d) {
    const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const m = months[d.getMonth()];
    const day = String(d.getDate()).padStart(2, " ");
    return `${m} ${day}`;
}
/** Parse an ISO date string into a Date (midnight UTC treated as local). */
function parseDate(s) {
    if (!s)
        return null;
    // Accept "YYYY-MM-DD" or full ISO
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
export function parseMilestones(raw) {
    if (raw === undefined || raw === null)
        return [];
    const text = String(raw).trim();
    if (text === "")
        return [];
    const out = [];
    for (const part of text.split(",")) {
        const entry = part.trim();
        if (entry === "")
            continue; // tolerate trailing/double commas
        const eq = entry.indexOf("=");
        if (eq < 0) {
            throw new CommandError(`Invalid --milestones entry "${entry}" (expected name=YYYY-MM-DD).`, EXIT_CODE.USAGE);
        }
        const name = entry.slice(0, eq).trim();
        const dateStr = entry.slice(eq + 1).trim();
        if (name === "") {
            throw new CommandError(`Invalid --milestones entry "${entry}": empty milestone name (expected name=YYYY-MM-DD).`, EXIT_CODE.USAGE);
        }
        // Require the strict ISO calendar-day shape; parseDate alone would accept
        // looser forms (full ISO timestamps), which we deliberately reject here so
        // milestone dates round-trip predictably through every export.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            throw new CommandError(`Invalid --milestones date for "${name}": "${dateStr}" (expected ISO YYYY-MM-DD).`, EXIT_CODE.USAGE);
        }
        const date = parseDate(dateStr);
        if (!date) {
            throw new CommandError(`Invalid --milestones date for "${name}": "${dateStr}" (expected ISO YYYY-MM-DD).`, EXIT_CODE.USAGE);
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
export function milestoneWeek(date, windowStart, weeks) {
    const windowEnd = addWeeks(windowStart, weeks);
    if (date < windowStart || date >= windowEnd)
        return -1;
    return Math.floor((date.getTime() - windowStart.getTime()) / (7 * DAY_MS));
}
/** Format a Date as "YYYY-MM-DD" (local). */
function isoDay(d) {
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
function computeWeekRange(itemStart, itemEnd, windowStart, totalWeeks) {
    const windowEnd = addWeeks(windowStart, totalWeeks);
    // If both dates are absent → undated
    if (!itemStart && !itemEnd)
        return null;
    // Clamp: if only one date is known, use a 1-week span
    const effectiveStart = itemStart ?? (itemEnd ? addWeeks(itemEnd, -1) : windowStart);
    const effectiveEnd = itemEnd ?? (itemStart ? addWeeks(itemStart, 1) : windowEnd);
    // Check if this item overlaps the window at all
    if (effectiveEnd <= windowStart || effectiveStart >= windowEnd) {
        return null;
    }
    const clampedStart = effectiveStart < windowStart ? windowStart : effectiveStart;
    const clampedEnd = effectiveEnd > windowEnd ? windowEnd : effectiveEnd;
    const firstActive = Math.floor((clampedStart.getTime() - windowStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
    // lastActive: the last week that has any overlap (end is exclusive, so subtract 1 ms)
    const lastActive = Math.max(firstActive, Math.floor((clampedEnd.getTime() - windowStart.getTime() - 1) /
        (7 * 24 * 60 * 60 * 1000)));
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
export function classifyOffWindow(itemStart, itemEnd, windowStart, totalWeeks) {
    if (!itemStart && !itemEnd)
        return "undated";
    const windowEnd = addWeeks(windowStart, totalWeeks);
    const effectiveStart = itemStart ?? (itemEnd ? addWeeks(itemEnd, -1) : windowStart);
    const effectiveEnd = itemEnd ?? (itemStart ? addWeeks(itemStart, 1) : windowEnd);
    if (effectiveEnd <= windowStart)
        return "before";
    if (effectiveStart >= windowEnd)
        return "after";
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
export function itemProgress(item) {
    if (item.status === "closed" || item.status === "canceled")
        return 100;
    // 1) An explicit numeric progress signal in meta wins (some pm setups store it).
    const metaProgress = readMetaProgress(item.meta);
    if (metaProgress !== null)
        return clampPercent(metaProgress);
    // 2) Acceptance-criteria checklist in the body: count [x] vs [ ] / [-].
    const checklist = checklistRatio(item.body);
    if (checklist !== null)
        return clampPercent(Math.round(checklist * 100));
    // 3) Status-based fallback.
    switch (item.status) {
        case "in_progress": return 50;
        case "blocked": return 25;
        default: return 0; // open / draft
    }
}
function clampPercent(n) {
    if (!isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}
/** Read a numeric progress hint from meta (`progress` or `percent_complete`).
 *  Accepts 0..1 fractions (scaled to %) or 0..100 percentages. Returns null when
 *  no usable numeric value is present. */
function readMetaProgress(meta) {
    if (!meta)
        return null;
    for (const key of ["progress", "percent_complete", "percentComplete"]) {
        const raw = meta[key];
        const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
        if (isFinite(n))
            return n > 0 && n <= 1 ? n * 100 : n;
    }
    return null;
}
/** Parse a GitHub-style task list from the body and return checked/total, or
 *  null when there are no checklist lines. `[x]`/`[X]` count as done. */
function checklistRatio(body) {
    if (!body)
        return null;
    let total = 0;
    let done = 0;
    for (const line of body.split("\n")) {
        const m = /^\s*[-*]\s*\[([ xX\-])\]/.exec(line);
        if (!m)
            continue;
        total++;
        if (m[1] === "x" || m[1] === "X")
            done++;
    }
    return total > 0 ? done / total : null;
}
/**
 * An item is overdue when it has a deadline strictly before `today` AND is not
 * already closed or canceled. Exported for tests.
 */
export function isOverdue(item, today) {
    if (item.status === "closed" || item.status === "canceled")
        return false;
    const due = itemDueDate(item);
    if (!due)
        return false;
    const deadline = parseDate(due);
    return deadline !== null && deadline.getTime() < today.getTime();
}
// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
function getGroupKey(item, groupBy) {
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
function computeCriticalPath(items) {
    const byId = new Map();
    for (const it of items)
        byId.set(it.id, it);
    // memoized longest path *ending at* each node (following deps backwards):
    // depthEndingAt(node) = 1 + max(depthEndingAt(dep) for dep in node.deps that exist)
    const memo = new Map();
    const visiting = new Set();
    function longest(id) {
        const cached = memo.get(id);
        if (cached)
            return cached;
        if (visiting.has(id))
            return { len: 0, path: [] }; // cycle guard
        const item = byId.get(id);
        if (!item)
            return { len: 0, path: [] };
        visiting.add(id);
        let best = { len: 1, path: [id] };
        for (const dep of item.dependencies ?? []) {
            if (!byId.has(dep.id))
                continue; // dangling/missing dependency
            const sub = longest(dep.id);
            if (sub.len + 1 > best.len) {
                best = { len: sub.len + 1, path: [...sub.path, id] };
            }
        }
        visiting.delete(id);
        memo.set(id, best);
        return best;
    }
    let overall = { len: 0, path: [], endId: "" };
    for (const it of items) {
        const r = longest(it.id);
        const better = r.len > overall.len ||
            (r.len === overall.len && r.len > 0 &&
                ((itemDueDate(it) ?? "") > (itemDueDate(byId.get(overall.endId)) ?? "") ||
                    ((itemDueDate(it) ?? "") === (itemDueDate(byId.get(overall.endId)) ?? "") && it.id < overall.endId)));
        if (better)
            overall = { len: r.len, path: r.path, endId: it.id };
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
 * Find every dependency cycle reachable through `dependencies[].id` edges
 * (an edge points item → prerequisite). Returns one human-readable path string
 * per distinct cycle, e.g. `A "Login" → B "API" → A "Login"`. Dangling
 * dependencies (ids not present in the item set) are ignored — they are a soft
 * concern handled elsewhere, not a cycle. Exported for tests.
 */
export function detectCycles(items) {
    const byId = new Map();
    for (const it of items)
        byId.set(it.id, it);
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const it of items)
        color.set(it.id, WHITE);
    const cycles = [];
    const seenCycleKeys = new Set();
    const stack = [];
    const label = (id) => {
        const it = byId.get(id);
        return it ? `${id} "${it.title}"` : id;
    };
    function visit(id) {
        color.set(id, GRAY);
        stack.push(id);
        const item = byId.get(id);
        for (const dep of item?.dependencies ?? []) {
            if (!byId.has(dep.id))
                continue; // dangling dep is not a cycle
            const c = color.get(dep.id);
            if (c === GRAY) {
                // Found a back-edge: extract the cycle from the recursion stack.
                const start = stack.indexOf(dep.id);
                const cyclePath = stack.slice(start);
                // De-dup cycles regardless of which node we entered from by keying on
                // the sorted node-set.
                const key = [...cyclePath].sort().join("|");
                if (!seenCycleKeys.has(key)) {
                    seenCycleKeys.add(key);
                    cycles.push([...cyclePath, dep.id].map(label).join(" → "));
                }
            }
            else if (c === WHITE) {
                visit(dep.id);
            }
        }
        stack.pop();
        color.set(id, BLACK);
    }
    for (const it of items) {
        if (color.get(it.id) === WHITE)
            visit(it.id);
    }
    return cycles;
}
/**
 * Run the preflight data-sanity checks over the items that will be charted.
 * Pure + deterministic; exported for tests. The caller decides what to do with
 * `fatal` (block) vs `warnings` (surface but proceed).
 */
export function dataSanityReport(items) {
    const fatal = [];
    const warnings = [];
    // HARD-FAIL: dependency cycles.
    for (const cycle of detectCycles(items)) {
        fatal.push(`dependency cycle: ${cycle}`);
    }
    // WARN: deadline before the item's own start date.
    for (const item of items) {
        const due = itemDueDate(item);
        if (!due || !item.created_at)
            continue;
        const deadline = parseDate(due);
        const start = parseDate(item.created_at);
        if (deadline && start && deadline.getTime() < start.getTime()) {
            warnings.push(`${item.id} "${item.title}": deadline ${isoDay(deadline)} is before its start ${isoDay(start)}.`);
        }
    }
    // WARN: implausibly large estimate (likely a data-entry error).
    for (const item of items) {
        const mins = item.estimated_minutes;
        if (typeof mins === "number" && mins > MAX_SANE_ESTIMATE_MINUTES) {
            const hours = Math.round(mins / 60);
            warnings.push(`${item.id} "${item.title}": estimate of ${mins} min (~${hours}h) is implausibly large; check the units.`);
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
function runDataSanityGate(items, where, json) {
    const report = dataSanityReport(items);
    if (report.fatal.length > 0) {
        throw new CommandError(`${where}: ${report.fatal.length} fatal data problem(s) make scheduling impossible:\n` +
            report.fatal.map((f) => `  • ${f}`).join("\n") +
            `\nResolve the dependency cycle(s) above and re-run.`, EXIT_CODE.USAGE);
    }
    if (report.warnings.length > 0 && !json) {
        process.stderr.write(`\nNOTE: ${report.warnings.length} data-sanity warning(s) (chart still rendered):\n` +
            report.warnings.map((w) => `  • ${w}`).join("\n") +
            "\n");
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
function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}
/** Later of two dates. */
function maxDate(a, b) {
    return a.getTime() >= b.getTime() ? a : b;
}
/**
 * Derive an item's duration in whole days from its estimate, falling back to
 * `defaultDays`. `estimated_minutes` is the pm-canonical estimate field; it is
 * converted via an 8h working day and rounded up to at least one day.
 */
function itemDurationDays(item, defaultDays) {
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
function computeSchedule(items, anchor, defaultDays) {
    const byId = new Map();
    for (const it of items)
        byId.set(it.id, it);
    const result = new Map();
    const visiting = new Set();
    function schedule(id) {
        const existing = result.get(id);
        if (existing)
            return existing;
        const item = byId.get(id);
        if (!item)
            return null;
        if (visiting.has(id))
            return null; // cycle guard
        visiting.add(id);
        // Earliest start = day after the latest dependency finishes.
        let start = new Date(anchor);
        for (const dep of item.dependencies ?? []) {
            // Only "blocked_by"/"depends_on" edges gate scheduling. Unknown kinds are
            // treated as prerequisites too (conservative), but informational kinds
            // like "related" are ignored.
            const kind = (dep.kind ?? "blocked_by").toLowerCase();
            if (kind === "related" || kind === "relates_to" || kind === "duplicate")
                continue;
            if (!byId.has(dep.id))
                continue;
            const depEntry = schedule(dep.id);
            if (depEntry)
                start = maxDate(start, addDays(depEntry.end, 1));
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
        const entry = {
            start,
            end: addDays(start, durationDays - 1),
            durationDays,
        };
        visiting.delete(id);
        result.set(id, entry);
        return entry;
    }
    for (const it of items)
        schedule(it.id);
    return result;
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
function computeSlack(items, schedule) {
    const byId = new Map();
    for (const it of items)
        byId.set(it.id, it);
    /** Only gating ("blocked_by"/unknown) edges drive scheduling & slack. */
    const gating = (dep) => {
        const kind = (dep.kind ?? "blocked_by").toLowerCase();
        return kind !== "related" && kind !== "relates_to" && kind !== "duplicate";
    };
    // Build successor adjacency: successors[depId] = [items depending on depId].
    const successors = new Map();
    for (const it of items) {
        for (const dep of it.dependencies ?? []) {
            if (!gating(dep) || !byId.has(dep.id))
                continue;
            if (!successors.has(dep.id))
                successors.set(dep.id, []);
            successors.get(dep.id).push(it.id);
        }
    }
    // Project latest finish = the latest forward-pass end across all items.
    let projectEnd = null;
    for (const entry of schedule.values()) {
        if (!projectEnd || entry.end.getTime() > projectEnd.getTime()) {
            projectEnd = new Date(entry.end);
        }
    }
    const latestFinish = new Map();
    const visiting = new Set();
    function lf(id) {
        const cached = latestFinish.get(id);
        if (cached)
            return cached;
        const entry = schedule.get(id);
        if (!entry) {
            // Unscheduled fallback: treat the project end as the bound.
            return projectEnd ?? new Date(0);
        }
        if (visiting.has(id)) {
            // Cycle guard: contribute no successor constraint (mirror other passes).
            return projectEnd ?? entry.end;
        }
        visiting.add(id);
        // Start from the project's latest finish.
        let bound = projectEnd ? new Date(projectEnd) : new Date(entry.end);
        // Constrain by each successor: this item must finish the day BEFORE the
        // successor's latest start.
        for (const succId of successors.get(id) ?? []) {
            const succEntry = schedule.get(succId);
            if (!succEntry)
                continue;
            const succLatestStart = addDays(lf(succId), -(succEntry.durationDays - 1));
            const beforeSucc = addDays(succLatestStart, -1);
            if (beforeSucc.getTime() < bound.getTime())
                bound = beforeSucc;
        }
        // Constrain by this item's OWN deadline (must finish on or before it).
        const item = byId.get(id);
        const due = item ? itemDueDate(item) : undefined;
        const deadline = due ? parseDate(due) : null;
        if (deadline && deadline.getTime() < bound.getTime()) {
            bound = deadline;
        }
        visiting.delete(id);
        latestFinish.set(id, bound);
        return bound;
    }
    const result = new Map();
    for (const it of items) {
        const entry = schedule.get(it.id);
        if (!entry)
            continue;
        const finish = lf(it.id);
        const start = addDays(finish, -(entry.durationDays - 1));
        const slackDays = Math.round((start.getTime() - entry.start.getTime()) / DAY_MS);
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
function statusOrderValue(status) {
    const statusOrder = {
        in_progress: 0,
        open: 1,
        blocked: 2,
        closed: 3,
        canceled: 4,
        draft: 5,
    };
    return statusOrder[status];
}
function buildRows(items, opts, windowStart) {
    // --critical-only implies critical-path computation even without --critical-path.
    const needCritical = opts.criticalPath || opts.criticalOnly;
    const criticalIds = needCritical ? computeCriticalPath(items) : new Set();
    // --critical-only clips the input to just the critical-path items.
    let working = items;
    if (opts.criticalOnly)
        working = items.filter((i) => criticalIds.has(i.id));
    // Dependency-aware scheduling overrides created_at/deadline-derived bars.
    const scheduleMap = opts.schedule
        ? computeSchedule(working, windowStart, opts.defaultDuration)
        : null;
    // Backward pass: total slack/float + infeasible-deadline detection. Only
    // meaningful when we have a forward schedule to measure against.
    const slackMap = scheduleMap ? computeSlack(working, scheduleMap) : null;
    const groupMap = new Map();
    for (const item of working) {
        const key = getGroupKey(item, opts.groupBy);
        if (!groupMap.has(key))
            groupMap.set(key, []);
        groupMap.get(key).push(item);
    }
    // Sort groups: named groups first (alphabetically), then fallback groups.
    const sortedGroups = [...groupMap.keys()].sort((a, b) => {
        const aFallback = a.startsWith("(no ") || a === "(unassigned)";
        const bFallback = b.startsWith("(no ") || b === "(unassigned)";
        if (aFallback && !bFallback)
            return 1;
        if (!aFallback && bFallback)
            return -1;
        return a.localeCompare(b);
    });
    const rows = [];
    for (const group of sortedGroups) {
        const groupItems = groupMap.get(group);
        groupItems.sort((a, b) => statusOrderValue(a.status) - statusOrderValue(b.status));
        for (const item of groupItems) {
            let itemStart;
            let itemEnd;
            if (scheduleMap) {
                const entry = scheduleMap.get(item.id);
                itemStart = entry ? entry.start : null;
                // computeWeekRange treats end as exclusive; the scheduler's end is the
                // inclusive last work day, so add a day for the half-open range.
                itemEnd = entry ? addDays(entry.end, 1) : null;
            }
            else {
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
                slackDays: slackMap ? (slackMap.get(item.id)?.slackDays ?? null) : null,
                infeasible: slackMap ? (slackMap.get(item.id)?.infeasible ?? false) : false,
                progress: itemProgress(item),
                overdue: isOverdue(item, opts.today),
                // Only classify the no-bar reason when there is no in-window bar.
                offWindow: range === null
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
const OFF_WINDOW_AFTER = "·→"; // dates fall entirely after the window
const COL_SEP = "  ";
/** Half-filled block glyphs for a coarse 0..100 % progress indicator in ASCII.
 *  Mapped onto the existing 2-char cell width so alignment is preserved. */
function progressGlyph(pct) {
    if (pct >= 100)
        return "██";
    if (pct >= 75)
        return "▓▓";
    if (pct >= 50)
        return "▓░";
    if (pct >= 25)
        return "░░";
    return "··";
}
function statusSymbol(status) {
    switch (status) {
        case "in_progress": return "▶";
        case "blocked": return "!";
        case "closed": return "✓";
        case "canceled": return "✗";
        default: return "○";
    }
}
function renderGantt(rows, opts, windowStart) {
    const { weeks } = opts;
    // Build week header labels
    const weekLabels = [];
    for (let w = 0; w < weeks; w++) {
        weekLabels.push(weekLabel(addWeeks(windowStart, w)));
    }
    // Column widths
    const COL_GROUP = 18;
    const COL_ITEM = 24;
    const COL_ST = 2; // status symbol
    const WEEK_COL = 6; // "May 11" = 6 chars
    const totalWidth = COL_GROUP + 2 + COL_ITEM + 2 + COL_ST + 2 +
        weeks * (WEEK_COL + COL_SEP.length);
    const lines = [];
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
    lines.push(`${groupHeader}  ${itemHeader}  ${stHeader}  ${weekHeaderCols}`);
    lines.push("─".repeat(Math.min(totalWidth, 90)));
    // Week sub-header (actual dates)
    const weekDateCols = weekLabels
        .map((l) => l.padEnd(WEEK_COL))
        .join(COL_SEP);
    lines.push(`${"".padEnd(COL_GROUP)}  ${"".padEnd(COL_ITEM)}  ${"".padEnd(COL_ST)}  ${weekDateCols}`);
    // TODAY marker line — parity with the mermaid `%% today:` marker. Drops a
    // caret in the week column that contains `today`, when it falls in-window.
    const windowEnd = addWeeks(windowStart, weeks);
    const todayWeek = opts.today >= windowStart && opts.today < windowEnd
        ? Math.floor((opts.today.getTime() - windowStart.getTime()) / (7 * DAY_MS))
        : -1;
    if (todayWeek >= 0 && todayWeek < weeks) {
        const markerCells = weekLabels.map((_, w) => (w === todayWeek ? "▼TODAY" : "").padEnd(WEEK_COL));
        lines.push(`${"".padEnd(COL_GROUP)}  ${"".padEnd(COL_ITEM)}  ${"".padEnd(COL_ST)}  ${markerCells.join(COL_SEP)}`);
    }
    // Milestone marker line(s) — fixed release/deadline dates dropped as labeled
    // ▼<name> carets in the week column they land in (parity with ▼TODAY). When
    // several milestones share a week, their names are comma-joined in that cell.
    // The cell content may overflow WEEK_COL; that is intentional (the label is
    // the point), so we do not pad/truncate the joined names. Milestones outside
    // the window are skipped here and reported to stderr by the caller.
    const inWindowMilestones = opts.milestones.filter((m) => milestoneWeek(m.date, windowStart, weeks) >= 0);
    if (inWindowMilestones.length > 0) {
        const perWeek = weekLabels.map(() => []);
        for (const m of inWindowMilestones) {
            const w = milestoneWeek(m.date, windowStart, weeks);
            perWeek[w].push(m.name);
        }
        const markerCells = weekLabels.map((_, w) => perWeek[w].length > 0 ? `▼${perWeek[w].join(",")}` : "".padEnd(WEEK_COL));
        lines.push(`${"".padEnd(COL_GROUP)}  ${"".padEnd(COL_ITEM)}  ${"".padEnd(COL_ST)}  ${markerCells.join(COL_SEP)}`);
    }
    lines.push("─".repeat(Math.min(totalWidth, 90)));
    // Rows — track last group to only print group name on first row
    let lastGroup = "";
    for (const row of rows) {
        const { group, item } = row;
        // Group label: only show for first item in group
        const groupLabel = group !== lastGroup
            ? group.slice(0, COL_GROUP).padEnd(COL_GROUP)
            : "".padEnd(COL_GROUP);
        lastGroup = group;
        // Item title (truncated); mark critical-path items with a leading *
        const rawTitle = row.critical ? `*${item.title}` : item.title;
        const itemLabel = rawTitle.slice(0, COL_ITEM).padEnd(COL_ITEM);
        // Status symbol
        const st = statusSymbol(item.status);
        // Gantt cells
        const cells = [];
        if (row.startWeek === null) {
            // No in-window bar. Distinguish a genuinely undated item (`··`) from one
            // whose dates fall entirely outside the window (directional hint), so the
            // two no longer look identical. The hint is placed at the nearest edge
            // column and points toward where the work actually lives.
            const glyph = row.offWindow === "before"
                ? OFF_WINDOW_BEFORE
                : row.offWindow === "after"
                    ? OFF_WINDOW_AFTER
                    : BLOCK_UNDATED;
            for (let w = 0; w < weeks; w++) {
                if (row.offWindow === "before") {
                    cells.push((w === 0 ? glyph : "  ").padEnd(WEEK_COL));
                }
                else if (row.offWindow === "after") {
                    cells.push((w === weeks - 1 ? glyph : "  ").padEnd(WEEK_COL));
                }
                else {
                    cells.push(BLOCK_UNDATED.padEnd(WEEK_COL));
                }
            }
        }
        else {
            for (let w = 0; w < weeks; w++) {
                if (w >= row.startWeek && w <= (row.endWeek ?? row.startWeek)) {
                    // Active: critical-path items override, then in_progress/blocked vs open.
                    // Under --progress, fill the bar's cells with a coarse completion glyph.
                    let block;
                    if (opts.progress) {
                        block = progressGlyph(row.progress);
                    }
                    else {
                        block = row.critical
                            ? BLOCK_CRITICAL
                            : item.status === "in_progress" || item.status === "blocked"
                                ? BLOCK_ACTIVE
                                : BLOCK_PLANNED;
                    }
                    cells.push(block.padEnd(WEEK_COL));
                }
                else {
                    cells.push("  ".padEnd(WEEK_COL)); // empty
                }
            }
        }
        // Trailing annotations (do not affect the week-column grid alignment):
        //   • overdue items get a distinct "‼ OVERDUE" marker (default-on; data-driven).
        //   • --progress appends the numeric "NN%".
        const suffixParts = [];
        if (opts.progress)
            suffixParts.push(`${String(row.progress).padStart(3)}%`);
        if (row.overdue)
            suffixParts.push("‼ OVERDUE");
        const suffix = suffixParts.length > 0 ? "  " + suffixParts.join("  ") : "";
        lines.push(`${groupLabel}  ${itemLabel}  ${st}   ${cells.join(COL_SEP)}${suffix}`);
    }
    lines.push("━".repeat(Math.min(totalWidth, 90)));
    // Legend
    const anyOffWindow = rows.some((r) => r.offWindow === "before" || r.offWindow === "after");
    const anyOverdue = rows.some((r) => r.overdue);
    lines.push(`Legend: ${BLOCK_ACTIVE} in_progress/blocked  ${BLOCK_PLANNED} open/planned  ` +
        (opts.criticalPath ? `${BLOCK_CRITICAL} critical-path (*)  ` : "") +
        `${BLOCK_UNDATED} undated  ` +
        (anyOffWindow ? `${OFF_WINDOW_BEFORE}/${OFF_WINDOW_AFTER} off-window (earlier/later)  ` : "") +
        (opts.progress ? `progress: ·· 0% ░░ 25% ▓░ 50% ▓▓ 75% ██ 100%  ` : "") +
        (anyOverdue ? `‼ OVERDUE (deadline passed, not closed)  ` : "") +
        (inWindowMilestones.length > 0 ? `▼<name> milestone date  ` : "") +
        `S: ▶in_progress  !blocked  ✓closed  ○open`);
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Rendering — Mermaid `gantt`
// ---------------------------------------------------------------------------
/** Mermaid section/task names cannot contain `:` (the field separator); sanitize. */
function mermaidSafe(s) {
    return s.replace(/:/g, "-").replace(/\n/g, " ").trim();
}
function mermaidStatusTag(status) {
    switch (status) {
        case "closed": return "done, ";
        case "in_progress": return "active, ";
        case "canceled": return "crit, ";
        default: return "";
    }
}
function renderMermaid(rows, opts, windowStart) {
    const lines = [];
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
        let start;
        let end;
        if (startDate && endDate) {
            start = startDate;
            end = endDate;
        }
        else if (endDate) {
            start = addWeeks(endDate, -1);
            end = endDate;
        }
        else if (startDate) {
            start = startDate;
            end = addWeeks(startDate, 1);
        }
        else {
            // Undated: place a 1-week marker at the window start so it still renders.
            start = windowStart;
            end = addWeeks(windowStart, 1);
        }
        if (end <= start)
            end = addWeeks(start, 1); // mermaid requires positive duration
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
        const name = mermaidSafe(`${item.title} [${item.id}]`);
        // `tag, id, startISO, endISO`
        lines.push(`    ${name} :${tag}${taskId}, ${isoDay(start)}, ${isoDay(end)}`);
        if (opts.progress) {
            lines.push(`    %% ${taskId} progress: ${row.progress}%${row.overdue ? " (overdue)" : ""}`);
        }
        else if (row.overdue) {
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
function csvField(value) {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
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
function renderCsv(rows, milestones = []) {
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
        const deps = (item.dependencies ?? [])
            .filter((d) => {
            const kind = (d.kind ?? "blocked_by").toLowerCase();
            return kind !== "related" && kind !== "relates_to" && kind !== "duplicate";
        })
            .map((d) => d.id)
            .join(" ");
        lines.push([
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
        ].join(","));
    }
    for (const m of milestones) {
        const day = isoDay(m.date);
        lines.push([
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
        ].join(","));
    }
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Rendering — standalone HTML
// ---------------------------------------------------------------------------
function htmlEscape(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
/** Inclusive day span of a dated row, else 0. */
function rowDurationDays(row) {
    if (!row.start || !row.end)
        return 0;
    return Math.max(1, Math.round((row.end.getTime() - row.start.getTime()) / DAY_MS) + 1);
}
/** Compute the footer summary stats shared by the HTML export. */
function computeSummary(rows) {
    let projectStart = null;
    let projectEnd = null;
    let totalTaskDays = 0;
    let criticalPathLength = 0;
    const workloadMap = new Map();
    for (const row of rows) {
        if (row.critical)
            criticalPathLength++;
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
    const spanDays = projectStart && projectEnd
        ? Math.max(1, Math.round((projectEnd.getTime() - projectStart.getTime()) / DAY_MS) + 1)
        : 0;
    const workload = [...workloadMap.entries()]
        .map(([group, days]) => ({ group, days }))
        .sort((a, b) => b.days - a.days || a.group.localeCompare(b.group));
    return { projectStart, projectEnd, spanDays, criticalPathLength, totalTaskDays, workload };
}
function renderHtml(rows, opts, windowStart) {
    const weeks = opts.weeks;
    const weekLabels = [];
    for (let w = 0; w < weeks; w++)
        weekLabels.push(weekLabel(addWeeks(windowStart, w)));
    // TODAY column: highlight the week column containing opts.today (parity with
    // the ASCII ▼TODAY row and the Mermaid `%% today:` comment). -1 when today
    // falls outside the chart window, in which case no column is highlighted.
    const windowEndHtml = addWeeks(windowStart, weeks);
    const todayWeek = opts.today >= windowStart && opts.today < windowEndHtml
        ? Math.floor((opts.today.getTime() - windowStart.getTime()) / (7 * DAY_MS))
        : -1;
    const headCols = weekLabels
        .map((l, i) => {
        const todayCls = i === todayWeek ? " today-col" : "";
        const todayMark = i === todayWeek ? '<br><span class="today-mark">▼ today</span>' : "";
        return `<th class="wk-th${todayCls}" title="${htmlEscape(l)}">W${i + 1}<br><span class="wk">${htmlEscape(l)}</span>${todayMark}</th>`;
    })
        .join("");
    const bodyRows = [];
    let lastGroup = "";
    for (const row of rows) {
        const { item } = row;
        const groupCell = row.group !== lastGroup
            ? `<td class="group">${htmlEscape(row.group)}</td>`
            : `<td class="group"></td>`;
        lastGroup = row.group;
        const cells = [];
        for (let w = 0; w < weeks; w++) {
            let cls = "cell";
            let inner = "";
            if (row.startWeek === null) {
                // Distinguish off-window (directional hint) from genuinely undated.
                if (row.offWindow === "before" && w === 0) {
                    cls = "cell offwindow";
                    inner = '<span class="offwindow-hint" title="dates fall before this window">←</span>';
                }
                else if (row.offWindow === "after" && w === weeks - 1) {
                    cls = "cell offwindow";
                    inner = '<span class="offwindow-hint" title="dates fall after this window">→</span>';
                }
                else if (row.offWindow === "before" || row.offWindow === "after") {
                    cls = "cell";
                }
                else {
                    cls = "cell undated";
                }
            }
            else if (w >= row.startWeek && w <= (row.endWeek ?? row.startWeek)) {
                cls = row.critical
                    ? "cell bar critical"
                    : item.status === "in_progress" || item.status === "blocked"
                        ? "cell bar active"
                        : "cell bar planned";
                if (row.overdue)
                    cls += " overdue";
                // --progress: overlay a fill whose width is the completion ratio.
                if (opts.progress) {
                    inner = `<span class="fill" style="width:${row.progress}%"></span>`;
                }
            }
            if (w === todayWeek)
                cls += " today-col";
            cells.push(`<td class="${cls}">${inner}</td>`);
        }
        const critMark = row.critical ? ' <span class="crit-mark">★</span>' : "";
        const overdueMark = row.overdue ? ' <span class="overdue-mark" title="deadline passed, not closed">‼ overdue</span>' : "";
        const progressMark = opts.progress ? ` <span class="pct">${row.progress}%</span>` : "";
        const title = htmlEscape(item.title) + critMark + overdueMark + progressMark;
        const due = itemDueDate(item);
        bodyRows.push(`<tr class="status-${htmlEscape(item.status)}${row.overdue ? " is-overdue" : ""}">` +
            groupCell +
            `<td class="item">${title}<br><span class="meta">${htmlEscape(item.id)}${due ? ' · due <span class="due">' + htmlEscape(isoDay(parseDate(due))) + "</span>" : ""}</span></td>` +
            `<td class="st" title="${htmlEscape(item.status)}">${htmlEscape(item.status)}</td>` +
            cells.join("") +
            `</tr>`);
    }
    // Footer summary + (for --group-by assignee) per-assignee workload.
    const summary = computeSummary(rows);
    const spanText = summary.projectStart && summary.projectEnd
        ? `${isoDay(summary.projectStart)} → ${isoDay(summary.projectEnd)} (${summary.spanDays} day${summary.spanDays === 1 ? "" : "s"})`
        : "—";
    const summaryRows = [
        `<tr><th>Project span</th><td>${htmlEscape(spanText)}</td></tr>`,
        `<tr><th>Critical-path length</th><td>${summary.criticalPathLength} item${summary.criticalPathLength === 1 ? "" : "s"}</td></tr>`,
        `<tr><th>Total task-days</th><td>${summary.totalTaskDays}</td></tr>`,
    ];
    let workloadBlock = "";
    if (opts.groupBy === "assignee" && summary.workload.length > 0) {
        const workloadRows = summary.workload
            .map((w) => `<tr><td>${htmlEscape(w.group)}</td><td>${w.days} day${w.days === 1 ? "" : "s"}</td></tr>`)
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
  td.cell { width: 28px; min-width: 28px; padding: 0; position: relative; }
  td.bar.planned  { background: #b3d4fc; }
  td.bar.active   { background: #2b7de9; }
  td.bar.critical { background: #e05c5c; }
  td.cell.undated { background: repeating-linear-gradient(45deg,#eee,#eee 4px,#f7f7f7 4px,#f7f7f7 8px); }
  /* off-window directional hint: dates fall before / after the chart window */
  td.cell.offwindow { text-align: center; color: #b07000; font-weight: 700; }
  .offwindow-hint { font-size: 0.95rem; }
  /* overdue bars: red striped overlay + a warning marker on the row label */
  td.bar.overdue { background: repeating-linear-gradient(45deg,#e05c5c,#e05c5c 5px,#c23b3b 5px,#c23b3b 10px); }
  tr.is-overdue td.item .due { color: #c23b3b; font-weight: 700; }
  .overdue-mark { color: #c23b3b; font-weight: 700; font-size: 0.72rem; }
  /* --progress fill overlay: a darker band sized to the completion ratio */
  td.bar .fill { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(0,0,0,0.35); }
  .pct { color: #2b7de9; font-size: 0.72rem; font-weight: 600; }
  /* TODAY column highlight (parity with ASCII ▼TODAY / Mermaid %% today:) */
  th.today-col, td.today-col { box-shadow: inset 2px 0 0 #d33, inset -2px 0 0 #d33; }
  td.cell.today-col { background-image: linear-gradient(rgba(221,51,51,0.10),rgba(221,51,51,0.10)); }
  .today-mark { color: #d33; font-weight: 700; font-size: 0.66rem; }
  .crit-mark { color: #e05c5c; }
  .legend { margin-top: 1rem; font-size: 0.78rem; color: #555; }
  .legend span { display: inline-block; margin-right: 1rem; }
  .swatch { display: inline-block; width: 14px; height: 14px; vertical-align: middle; margin-right: 4px; border: 1px solid #ccc; }
  tr.status-closed td.item { text-decoration: line-through; color: #999; }
  h2 { font-size: 1rem; margin: 1.4rem 0 0.5rem; }
  table.summary, table.workload { width: auto; min-width: 18rem; }
  table.summary th, table.workload th { text-align: left; }
  table.summary td, table.workload td { white-space: nowrap; }
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
<h2>Summary</h2>
<table class="summary">
<tbody>
${summaryRows.join("\n")}
</tbody>
</table>
${workloadBlock}
<div class="legend">
  <span><i class="swatch" style="background:#2b7de9"></i>in_progress / blocked</span>
  <span><i class="swatch" style="background:#b3d4fc"></i>open / planned</span>
  ${opts.criticalPath ? '<span><i class="swatch" style="background:#e05c5c"></i>critical path (★)</span>' : ""}
  <span><i class="swatch" style="background:#eee"></i>undated</span>
  <span><i class="swatch" style="background:repeating-linear-gradient(45deg,#e05c5c,#e05c5c 5px,#c23b3b 5px,#c23b3b 10px)"></i>overdue (deadline passed)</span>
  <span style="color:#b07000;font-weight:700">← / →</span> off-window (earlier / later)
  ${opts.progress ? '<span><i class="swatch" style="background:rgba(0,0,0,0.35)"></i>% complete fill</span>' : ""}
  ${todayWeek >= 0 ? '<span style="color:#d33;font-weight:700">▼ today</span> current week' : ""}
</div>
</body>
</html>`;
}
// ---------------------------------------------------------------------------
// Shared option parsing + data fetch
// ---------------------------------------------------------------------------
function readOption(options, ...keys) {
    for (const key of keys) {
        const value = options[key];
        if (value !== undefined && value !== null)
            return value;
    }
    return undefined;
}
function readBoolOption(options, ...keys) {
    for (const key of keys) {
        if (options[key] !== undefined)
            return Boolean(options[key]);
    }
    return false;
}
function resolveGanttOptions(options) {
    const rawGroupBy = readOption(options, "group-by", "groupBy") ?? "milestone";
    const groupBy = GROUP_BY_VALUES.includes(String(rawGroupBy))
        ? String(rawGroupBy)
        : "milestone";
    const rawStatus = readOption(options, "status") ?? "all";
    const statusFilter = [
        "open", "in_progress", "blocked", "closed", "canceled", "draft", "all",
    ].includes(String(rawStatus))
        ? String(rawStatus)
        : "all";
    const criticalPath = readBoolOption(options, "critical-path", "criticalPath");
    const criticalOnly = readBoolOption(options, "critical-only", "criticalOnly");
    const schedule = readBoolOption(options, "schedule");
    const progress = readBoolOption(options, "progress");
    const rawDefaultDuration = readOption(options, "default-duration", "defaultDuration");
    let defaultDuration = 5;
    if (rawDefaultDuration !== undefined) {
        const parsed = parseInt(String(rawDefaultDuration), 10);
        if (isNaN(parsed) || parsed < 1) {
            throw new CommandError(`Invalid --default-duration "${rawDefaultDuration}" (expected a positive integer of days).`, EXIT_CODE.USAGE);
        }
        defaultDuration = Math.min(365, parsed);
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
    let weeks;
    if (rawTo !== undefined) {
        const parsedTo = parseDate(String(rawTo));
        if (!parsedTo) {
            throw new CommandError(`Invalid --to date: "${rawTo}" (expected ISO YYYY-MM-DD).`, EXIT_CODE.USAGE);
        }
        if (parsedTo.getTime() < windowStart.getTime()) {
            throw new CommandError(`--to (${isoDay(parsedTo)}) is before --from window start (${isoDay(windowStart)}).`, EXIT_CODE.USAGE);
        }
        // Number of week-columns needed to cover windowStart..parsedTo inclusive.
        const spanWeeks = Math.ceil((parsedTo.getTime() - windowStart.getTime()) / (7 * DAY_MS)) + 1;
        weeks = Math.max(1, Math.min(52, spanWeeks));
    }
    else {
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
        milestones,
        windowStart,
    };
}
function fetchItems(pmRoot) {
    const result = spawnSync("pm", ["--path", pmRoot, "list-all", "--json", "--include-body"], { encoding: "utf-8" });
    if (result.error || result.status !== 0) {
        throw new CommandError(`Failed to fetch pm items (exit ${result.status ?? "unknown"}): ${result.stderr?.trim() || result.error?.message || "no output"}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch (err) {
        throw new CommandError(`Failed to parse pm list-all output as JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsed.items ?? [];
}
function filterByStatus(items, statusFilter) {
    return statusFilter === "all" ? items : items.filter((i) => i.status === statusFilter);
}
/**
 * Collect infeasible-deadline warnings from scheduled rows. A row is infeasible
 * when its backward-pass latest-feasible start is before its earliest possible
 * start — the plan is already late for a downstream deadline. Returns one
 * human-readable line per affected item (empty when none / not scheduling).
 */
function infeasibleWarnings(rows) {
    return rows
        .filter((r) => r.infeasible)
        .map((r) => {
        const slip = r.slackDays === null ? 0 : Math.abs(r.slackDays);
        return `  • ${r.item.id} "${r.item.title}" is ${slip} day(s) late: its required start to hit a downstream deadline is before its earliest feasible start.`;
    });
}
/**
 * Names of milestones that fall entirely outside the rendered window (so they
 * cannot be drawn). Returned for a one-line stderr note. Exported for tests.
 */
export function offWindowMilestones(milestones, windowStart, weeks) {
    return milestones
        .filter((m) => milestoneWeek(m.date, windowStart, weeks) < 0)
        .map((m) => `${m.name} (${isoDay(m.date)})`);
}
const EXPORT_FORMATS = ["mermaid", "html", "ascii", "csv"];
function renderForFormat(format, rows, opts, windowStart) {
    switch (format) {
        case "mermaid": return renderMermaid(rows, opts, windowStart);
        case "html": return renderHtml(rows, opts, windowStart);
        case "ascii": return renderGantt(rows, opts, windowStart);
        case "csv": return renderCsv(rows, opts.milestones);
    }
}
function defaultExtension(format) {
    switch (format) {
        case "mermaid": return "mmd";
        case "html": return "html";
        case "ascii": return "txt";
        case "csv": return "csv";
    }
}
// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-gantt-chart",
    version: "2026.6.9",
    activate(api) {
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
                "pm gantt --milestones \"v1.0=2026-06-30,v1.1=2026-08-15\"",
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
                    description: "Group items by: milestone (sprint/release) | sprint | release | type | assignee | status | tag (default: milestone)",
                },
                {
                    long: "--status",
                    value_name: "filter",
                    description: "Filter by status: open | in_progress | blocked | closed | canceled | draft | all (default: all)",
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
                    description: "Dependency-aware scheduling: derive start/end from blocked-by chains + estimates",
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
                    long: "--milestones",
                    value_name: "list",
                    description: "Draw fixed release/deadline dates as labeled vertical markers. Comma-separated name=YYYY-MM-DD (e.g. \"v1.0=2026-06-30,v1.1=2026-08-15\")",
                },
            ],
            async run(ctx) {
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
                runDataSanityGate(allItems, "gantt", ctx.global?.json);
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
                // Backward-pass infeasible-deadline warnings (only under --schedule).
                const warnings = infeasibleWarnings(rows);
                // Print the human-readable chart to stdout, but not under --json:
                // mixing it with the JSON payload would corrupt machine-readable output.
                // The chart is still returned in the result object for JSON consumers.
                const droppedMilestones = offWindowMilestones(opts.milestones, opts.windowStart, opts.weeks);
                if (!ctx.global?.json) {
                    process.stdout.write(chart + "\n");
                    if (droppedMilestones.length > 0) {
                        process.stderr.write(`NOTE: ${droppedMilestones.length} milestone(s) fall outside the chart window and were not drawn: ${droppedMilestones.join(", ")}\n`);
                    }
                    if (warnings.length > 0) {
                        process.stderr.write(`\nWARNING: ${warnings.length} item(s) have an infeasible deadline (plan already late):\n` +
                            warnings.join("\n") +
                            "\n");
                    }
                }
                const overdueRows = rows.filter((r) => r.overdue);
                const offWindowCount = rows.filter((r) => r.offWindow === "before" || r.offWindow === "after").length;
                const undatedCount = rows.filter((r) => r.offWindow === "undated").length;
                if (!ctx.global?.json && overdueRows.length > 0) {
                    process.stderr.write(`\nNOTE: ${overdueRows.length} item(s) are overdue (deadline passed, not closed):\n` +
                        overdueRows
                            .map((r) => `  • ${r.item.id} "${r.item.title}" (due ${itemDueDate(r.item)})`)
                            .join("\n") +
                        "\n");
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
                        ? { overdue: overdueRows.map((r) => ({ id: r.item.id, deadline: itemDueDate(r.item) ?? null })) }
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
        // HTML, or ASCII. registerRenderer only supports toon|json, so a new
        // output format must go through the exporter pipeline.
        // -----------------------------------------------------------------------
        api.registerExporter("gantt", async (ctx) => {
            const opts = resolveGanttOptions(ctx.options);
            const rawFormat = String(readOption(ctx.options, "format") ?? "mermaid").toLowerCase();
            if (!EXPORT_FORMATS.includes(rawFormat)) {
                throw new CommandError(`Unknown --format "${rawFormat}". Valid: ${EXPORT_FORMATS.join(" | ")}.`, EXIT_CODE.USAGE);
            }
            const format = rawFormat;
            const allItems = fetchItems(ctx.pm_root);
            const items = filterByStatus(allItems, opts.statusFilter);
            if (items.length === 0) {
                console.error("No matching pm items to export.");
                return { exported: 0, format };
            }
            // Same preflight gate as the `gantt` command: a cycle would otherwise emit
            // a silently-wrong artifact. Warnings go to stderr (never the artifact).
            runDataSanityGate(allItems, "gantt export", ctx.global?.json);
            const rows = buildRows(items, opts, opts.windowStart);
            if (rows.length === 0) {
                console.error("No matching pm items to export (e.g. --critical-only with no chain).");
                return { exported: 0, format };
            }
            const output = renderForFormat(format, rows, opts, opts.windowStart);
            const exportedCount = rows.length;
            const droppedMilestones = offWindowMilestones(opts.milestones, opts.windowStart, opts.weeks);
            if (droppedMilestones.length > 0) {
                console.error(`gantt export NOTE: ${droppedMilestones.length} milestone(s) fall outside the chart window and were omitted: ${droppedMilestones.join(", ")}`);
            }
            // Surface backward-pass infeasible-deadline warnings on stderr so they do
            // not corrupt the exported artifact written to stdout / a file.
            const warnings = infeasibleWarnings(rows);
            if (warnings.length > 0) {
                console.error(`gantt export WARNING: ${warnings.length} item(s) have an infeasible deadline (plan already late):\n` +
                    warnings.join("\n"));
            }
            const outputPath = readOption(ctx.options, "output");
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
        // -----------------------------------------------------------------------
        // Preflight (capability surface): a scoped, pass-through override.
        //
        // The package's real data-sanity gate runs inside the gantt command /
        // exporter handlers (see runDataSanityGate): the pm runtime wraps
        // registerPreflight overrides in try/catch and downgrades a thrown error to
        // a non-fatal warning, so a throw HERE would NOT abort the command. We still
        // register a scoped preflight so the extension truthfully advertises the
        // "preflight" capability; it leaves the runtime decision untouched for every
        // command except our own, where it is a no-op delta.
        // -----------------------------------------------------------------------
        api.registerPreflight((preflightCtx) => {
            if (preflightCtx.command !== "gantt")
                return {};
            // Intentionally no enforcement here (runtime swallows throws); the gate is
            // enforced in the command handler. Return an empty delta = no change.
            return {};
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
export { computeSchedule, computeSlack, computeCriticalPath, computeSummary, itemDurationDays, renderCsv, renderMermaid, renderGantt, renderHtml, infeasibleWarnings, buildRows, resolveGanttOptions, getGroupKey, };
//# sourceMappingURL=index.js.map