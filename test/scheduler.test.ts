import assert from "node:assert/strict";
import test from "node:test";

import type { PmItem } from "../index.ts";
import {
  computeSchedule,
  computeSlack,
  computeCriticalPath,
  computeSummary,
  itemDurationDays,
  renderCsv,
  renderMermaid,
  renderGantt,
  renderHtml,
  renderSvg,
  infeasibleWarnings,
  buildRows,
  resolveGanttOptions,
  getGroupKey,
  itemProgress,
  isOverdue,
  classifyOffWindow,
} from "../index.ts";

// A small, deterministic project: A -> B -> C chain plus an isolated item.
//   A (Design)      estimate 480m  = 1 working day
//   B (Build)       estimate 960m  = 2 working days, blocked_by A
//   C (Integration) estimate 720m  = 2 working days, blocked_by B
//   D (Docs)        estimate 480m  = 1 working day, no deps, deadline far out
function chainItems(): PmItem[] {
  return [
    { id: "A", title: "Design API", status: "closed", estimated_minutes: 480, sprint: "S1", dependencies: [] },
    { id: "B", title: "Build endpoint", status: "in_progress", estimated_minutes: 960, sprint: "S1", dependencies: [{ id: "A", kind: "blocked_by" }] },
    { id: "C", title: "Integration tests", status: "open", estimated_minutes: 720, sprint: "S2", dependencies: [{ id: "B", kind: "blocked_by" }] },
    { id: "D", title: "Write docs", status: "open", estimated_minutes: 480, sprint: "S2", dependencies: [] },
  ];
}

const ANCHOR = new Date("2026-06-01T00:00:00"); // a Monday

test("itemDurationDays converts estimated_minutes via 8h workday, rounding up", () => {
  assert.equal(itemDurationDays({ id: "x", title: "x", status: "open", estimated_minutes: 480 } as any, 5), 1);
  assert.equal(itemDurationDays({ id: "x", title: "x", status: "open", estimated_minutes: 960 } as any, 5), 2);
  assert.equal(itemDurationDays({ id: "x", title: "x", status: "open", estimated_minutes: 720 } as any, 5), 2); // 1.5 -> 2
  // no estimate -> default
  assert.equal(itemDurationDays({ id: "x", title: "x", status: "open" } as any, 4), 4);
  // zero/garbage estimate -> default, min 1
  assert.equal(itemDurationDays({ id: "x", title: "x", status: "open", estimated_minutes: 0 } as any, 3), 3);
});

test("computeSchedule orders a dependency chain: each item starts after its blocker finishes", () => {
  const sched = computeSchedule(chainItems(), ANCHOR, 5);
  const a = sched.get("A")!;
  const b = sched.get("B")!;
  const c = sched.get("C")!;
  assert.ok(a && b && c, "all chain items scheduled");

  // A starts at anchor, 1 day long -> ends same day.
  assert.equal(a.start.getTime(), ANCHOR.getTime());
  assert.equal(a.durationDays, 1);

  // B starts the day AFTER A ends.
  assert.equal(b.start.getTime(), a.end.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(b.durationDays, 2);

  // C starts the day AFTER B ends.
  assert.equal(c.start.getTime(), b.end.getTime() + 24 * 60 * 60 * 1000);

  // Strict ordering of starts down the chain.
  assert.ok(a.start < b.start && b.start < c.start, "starts are strictly increasing along the chain");
});

test("computeSchedule respects --default-duration for items without an estimate", () => {
  const items = [{ id: "X", title: "X", status: "open", dependencies: [] }] as any[];
  const sched = computeSchedule(items, ANCHOR, 3);
  assert.equal(sched.get("X")!.durationDays, 3);
});

test("computeSchedule is cycle-safe (does not hang or throw on A<->B)", () => {
  const items = [
    { id: "A", title: "A", status: "open", dependencies: [{ id: "B", kind: "blocked_by" }] },
    { id: "B", title: "B", status: "open", dependencies: [{ id: "A", kind: "blocked_by" }] },
  ] as any[];
  const sched = computeSchedule(items, ANCHOR, 1);
  assert.equal(sched.size, 2);
});

test("computeSchedule back-anchors to a reachable deadline", () => {
  // Single item, 1-day duration, deadline far in the future -> ends ON deadline.
  const items = [
    { id: "D", title: "Docs", status: "open", estimated_minutes: 480, deadline: "2026-06-30", dependencies: [] },
  ] as any[];
  const sched = computeSchedule(items, ANCHOR, 5);
  const d = sched.get("D")!;
  assert.equal(d.end.getFullYear(), 2026);
  assert.equal(d.end.getMonth(), 5); // June
  assert.equal(d.end.getDate(), 30);
});

test("computeCriticalPath returns the longest chain A->B->C", () => {
  const crit = computeCriticalPath(chainItems());
  assert.ok(crit.has("A") && crit.has("B") && crit.has("C"), "chain nodes on critical path");
  assert.ok(!crit.has("D"), "isolated item not on critical path");
});

test("getGroupKey supports sprint / release / status / assignee", () => {
  const item: any = { id: "x", title: "x", status: "in_progress", sprint: "S1", release: "v1.0", assignee: "alice" };
  assert.equal(getGroupKey(item, "sprint"), "S1");
  assert.equal(getGroupKey(item, "release"), "v1.0");
  assert.equal(getGroupKey(item, "status"), "in_progress");
  assert.equal(getGroupKey(item, "assignee"), "alice");
  // fallbacks
  assert.equal(getGroupKey({ id: "y", title: "y", status: "open" } as any, "sprint"), "(no sprint)");
  assert.equal(getGroupKey({ id: "y", title: "y", status: "open" } as any, "release"), "(no release)");
});

test("renderCsv emits the documented header and a row per item with deps", () => {
  const opts = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const csv = renderCsv(rows);
  const lines = csv.split("\n");
  assert.equal(lines[0], "id,title,start,end,duration_days,slack_days,deps,status,critical,progress_percent,overdue,off_window");
  // B's row should list A as a dependency.
  const bLine = lines.find((l) => l.startsWith("B,"));
  assert.ok(bLine, "B row present");
  assert.ok(bLine!.includes(",A,"), "B lists A in deps column");
  // A's row has a duration of 1 day.
  const aLine = lines.find((l) => l.startsWith("A,"))!;
  assert.match(aLine, /,1,/, "A duration is 1 day");
});

test("renderCsv quotes fields containing commas", () => {
  const rows = buildRows(
    [{ id: "Z", title: "Hello, world", status: "open", dependencies: [] }] as any[],
    resolveGanttOptions({}),
    resolveGanttOptions({}).windowStart,
  );
  const csv = renderCsv(rows);
  assert.ok(csv.includes('"Hello, world"'), "comma-containing title is quoted");
});

test("renderMermaid produces valid gantt scaffolding with dateFormat + sections", () => {
  const opts = resolveGanttOptions({ schedule: true, "group-by": "sprint", weeks: "12", from: "2026-06-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const mmd = renderMermaid(rows, opts, opts.windowStart);
  assert.match(mmd, /^gantt/m);
  assert.match(mmd, /dateFormat\s+YYYY-MM-DD/);
  assert.match(mmd, /section S1/);
  assert.match(mmd, /section S2/);
  // every task line carries an ISO start and end date
  const taskLines = mmd.split("\n").filter((l) => /:\s*\w*t\d+,/.test(l) || /:.*\d{4}-\d{2}-\d{2}/.test(l));
  assert.ok(taskLines.length >= 4, "a task line per item");
});

test("resolveGanttOptions derives weeks from --from/--to and validates dates", () => {
  const opts = resolveGanttOptions({ from: "2026-06-01", to: "2026-06-28" });
  assert.ok(opts.weeks >= 4 && opts.weeks <= 5, "from..to spans ~4 weeks");
  assert.throws(() => resolveGanttOptions({ from: "2026-06-01", to: "2026-05-01" }), /before/);
  assert.throws(() => resolveGanttOptions({ from: "not-a-date" }), /Invalid --from/);
  assert.throws(() => resolveGanttOptions({ "default-duration": "0" }), /default-duration/);
});

test("buildRows with --critical-only keeps only critical-path items", () => {
  const opts = resolveGanttOptions({ "critical-only": true });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const ids = new Set(rows.map((r) => r.item.id));
  assert.deepEqual([...ids].sort(), ["A", "B", "C"]);
});

// ---------------------------------------------------------------------------
// Backward pass — slack / float
// ---------------------------------------------------------------------------

test("computeSlack: critical-path items have 0 slack, off-path slack > 0", () => {
  // A->B->C chain (1+2+2 = 5 days, ends day idx 4) plus isolated D (1 day).
  // Project end = C's end. D has no deps and no deadline -> it can slide to the
  // project end, so its total slack = (projectEnd - D.duration) - D.start.
  const items = chainItems();
  const sched = computeSchedule(items, ANCHOR, 5);
  const slack = computeSlack(items, sched);

  assert.equal(slack.get("A")!.slackDays, 0, "A is on the critical path");
  assert.equal(slack.get("B")!.slackDays, 0, "B is on the critical path");
  assert.equal(slack.get("C")!.slackDays, 0, "C ends the project");

  // D: 1 day, starts at anchor. Project end is C.end (day idx 4). D can finish
  // as late as the project end -> latest start = projectEnd, slack = 4 days.
  const d = slack.get("D")!;
  assert.equal(d.slackDays, 4, "isolated D can float to the project end");
  assert.equal(d.infeasible, false);
});

test("computeSlack: a slack-bearing parallel branch is non-zero, its blocker is 0", () => {
  // Chain A(2d) -> C(2d). Parallel short task B(1d) -> C. B has slack because
  // A is longer; A is critical, B floats.
  const items: PmItem[] = [
    { id: "A", title: "A long", status: "open", estimated_minutes: 960, dependencies: [] }, // 2d
    { id: "B", title: "B short", status: "open", estimated_minutes: 480, dependencies: [] }, // 1d
    { id: "C", title: "C join", status: "open", estimated_minutes: 960, dependencies: [
      { id: "A", kind: "blocked_by" }, { id: "B", kind: "blocked_by" },
    ] },
  ];
  const sched = computeSchedule(items, ANCHOR, 5);
  const slack = computeSlack(items, sched);
  assert.equal(slack.get("A")!.slackDays, 0, "longer predecessor A is critical");
  assert.equal(slack.get("C")!.slackDays, 0, "join task C is critical");
  assert.equal(slack.get("B")!.slackDays, 1, "shorter parallel B has 1 day of float");
});

test("computeSlack: infeasible deadline is flagged with negative slack", () => {
  // A(2d) -> B(2d), but B has a deadline only 1 day after the anchor. B cannot
  // possibly finish that early because A must complete first -> infeasible.
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 960, dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 960, deadline: "2026-06-02",
      dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const sched = computeSchedule(items, ANCHOR, 5);
  const slack = computeSlack(items, sched);
  const b = slack.get("B")!;
  assert.equal(b.infeasible, true, "B's deadline cannot be met");
  assert.ok(b.slackDays < 0, "infeasible task carries negative slack");
});

test("renderCsv includes slack_days column (blank without --schedule, filled with)", () => {
  // Without --schedule: header has slack_days, but values are blank.
  const plainOpts = resolveGanttOptions({});
  const plainRows = buildRows(chainItems(), plainOpts, plainOpts.windowStart);
  const plainCsv = renderCsv(plainRows);
  assert.equal(
    plainCsv.split("\n")[0],
    "id,title,start,end,duration_days,slack_days,deps,status,critical,progress_percent,overdue,off_window",
  );

  // With --schedule: A on the critical path -> slack 0.
  const opts = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const csv = renderCsv(rows);
  const aLine = csv.split("\n").find((l) => l.startsWith("A,"))!;
  // columns: id,title,start,end,duration_days,slack_days,deps,status,critical,progress_percent,overdue,off_window
  const aCols = aLine.split(",");
  assert.equal(aCols[5], "0", "A (critical) has slack_days = 0");
  assert.equal(aCols[8], "yes", "A is marked critical in CSV");
  assert.equal(aCols[9], "100", "A carries progress percent in CSV");
  const dLine = csv.split("\n").find((l) => l.startsWith("D,"))!;
  assert.equal(dLine.split(",")[5], "4", "D has slack_days = 4");
});

test("infeasibleWarnings surfaces a line per already-late item", () => {
  const opts = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 960, dependencies: [] },
    { id: "B", title: "Tight", status: "open", estimated_minutes: 960, deadline: "2026-06-02",
      dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const rows = buildRows(items, opts, opts.windowStart);
  const warnings = infeasibleWarnings(rows);
  // The deadline miss on B propagates back through its predecessor A (standard
  // CPM): both the deadline task and its blockers are flagged as already-late.
  assert.ok(warnings.length >= 1, "at least the deadline task is flagged");
  assert.ok(warnings.some((w) => /B "Tight"/.test(w)), "B is flagged late");
  assert.ok(warnings.every((w) => /late/.test(w)));
});

// ---------------------------------------------------------------------------
// ASCII TODAY marker
// ---------------------------------------------------------------------------

test("renderGantt draws a TODAY marker when today is in-window", () => {
  // Anchor the window on today's own week so the marker is guaranteed in-range.
  const opts = resolveGanttOptions({}); // from defaults to current week
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.match(ascii, /▼TODAY/, "ASCII chart contains the TODAY caret");
});

test("renderGantt omits the TODAY marker when today is outside the window", () => {
  // Anchor far in the past with a narrow window -> today not in range.
  const opts = resolveGanttOptions({ from: "2000-01-03", weeks: "2" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.doesNotMatch(ascii, /TODAY/, "no TODAY marker when out of window");
});

// ---------------------------------------------------------------------------
// HTML summary + assignee workload
// ---------------------------------------------------------------------------

test("computeSummary totals task-days, critical length, and per-group workload", () => {
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 960, assignee: "alice", dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480, assignee: "bob",
      dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const opts = resolveGanttOptions({ schedule: true, "group-by": "assignee", "critical-path": true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const summary = computeSummary(rows);
  assert.equal(summary.totalTaskDays, 3, "2 days (A) + 1 day (B)");
  assert.ok(summary.criticalPathLength >= 2, "A->B chain is critical");
  const alice = summary.workload.find((w) => w.group === "alice")!;
  const bob = summary.workload.find((w) => w.group === "bob")!;
  assert.equal(alice.days, 2);
  assert.equal(bob.days, 1);
});

test("renderHtml emits a Summary footer, and an assignee-workload table when grouped by assignee", () => {
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 960, assignee: "alice", dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480, assignee: "bob",
      dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const opts = resolveGanttOptions({ schedule: true, "group-by": "assignee", weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /<h2>Summary<\/h2>/, "summary footer present");
  assert.match(html, /Total task-days/);
  assert.match(html, /Project span/);
  // Asserting the rendered count and noun, not just the label: a hardcoded
  // "items" satisfies /Critical-path length/ forever. Neither item here is on
  // the longest chain, so the count is 0 and the noun is plural.
  assert.match(html, /Critical-path length<\/th><td>0 items</, "a zero count reads as items");
  assert.match(html, /<h2>Assignee workload<\/h2>/, "workload table present under --group-by assignee");
  assert.match(html, /alice/);

  // Not grouped by assignee -> summary present, but no workload table.
  const opts2 = resolveGanttOptions({ schedule: true, "group-by": "sprint", weeks: "12", from: "2026-06-01" });
  const rows2 = buildRows(items, opts2, opts2.windowStart);
  const html2 = renderHtml(rows2, opts2, opts2.windowStart);
  assert.match(html2, /<h2>Summary<\/h2>/);
  assert.doesNotMatch(html2, /Assignee workload/);

  // Pins the invariant that lets renderHtml hardcode the plural noun:
  // computeCriticalPath returns an empty set unless the longest chain exceeds
  // one item, so a lone item — even with --critical-path explicitly on — is
  // reported as 0, never 1. If that guard is ever relaxed, this fails and the
  // comment in renderHtml says to restore the singular arm.
  const solo: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, assignee: "alice", dependencies: [] },
  ];
  assert.equal(computeCriticalPath(solo).size, 0, "a lone item is not a critical path");
  const soloOpts = resolveGanttOptions({ schedule: true, "critical-path": true, weeks: "12", from: "2026-06-01" });
  const soloHtml = renderHtml(buildRows(solo, soloOpts, soloOpts.windowStart), soloOpts, soloOpts.windowStart);
  assert.match(soloHtml, /Critical-path length<\/th><td>0 items</, "a count that can never be 1 is always plural");
});

// ---------------------------------------------------------------------------
// Progress (% complete) derivation
// ---------------------------------------------------------------------------

test("itemProgress: closed/canceled are 100%, open is 0%, in_progress defaults to 50%, blocked 25%", () => {
  assert.equal(itemProgress({ id: "a", title: "a", status: "closed" } as any), 100);
  assert.equal(itemProgress({ id: "a", title: "a", status: "canceled" } as any), 100);
  assert.equal(itemProgress({ id: "a", title: "a", status: "open" } as any), 0);
  assert.equal(itemProgress({ id: "a", title: "a", status: "draft" } as any), 0);
  assert.equal(itemProgress({ id: "a", title: "a", status: "in_progress" } as any), 50);
  assert.equal(itemProgress({ id: "a", title: "a", status: "blocked" } as any), 25);
});

test("itemProgress: derives ratio from an acceptance-criteria checklist in the body", () => {
  const body = [
    "Some description",
    "- [x] write code",
    "- [x] add tests",
    "- [ ] update docs",
    "- [-] optional polish",
  ].join("\n");
  // 2 of 4 checked -> 50%.
  assert.equal(itemProgress({ id: "a", title: "a", status: "in_progress", body } as any), 50);
  // All checked -> 100% even when still in_progress.
  const allDone = "- [x] one\n- [x] two";
  assert.equal(itemProgress({ id: "a", title: "a", status: "in_progress", body: allDone } as any), 100);
});

test("itemProgress: honors an explicit meta.progress (fraction or percentage)", () => {
  assert.equal(itemProgress({ id: "a", title: "a", status: "open", meta: { progress: 0.4 } } as any), 40);
  assert.equal(itemProgress({ id: "a", title: "a", status: "open", meta: { percent_complete: 80 } } as any), 80);
  // out-of-range is clamped
  assert.equal(itemProgress({ id: "a", title: "a", status: "open", meta: { progress: 150 } } as any), 100);
});

test("renderGantt --progress appends NN% and a fill glyph without breaking default output", () => {
  const items: PmItem[] = [
    { id: "A", title: "Design", status: "closed", estimated_minutes: 480, sprint: "S1", dependencies: [] },
    { id: "B", title: "Build", status: "in_progress", estimated_minutes: 480, sprint: "S1", dependencies: [] },
  ];
  const optsPlain = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const rowsPlain = buildRows(items, optsPlain, optsPlain.windowStart);
  const plain = renderGantt(rowsPlain, optsPlain, optsPlain.windowStart);
  assert.doesNotMatch(plain, /\d+%/, "default ASCII output has no percentages");

  const opts = resolveGanttOptions({ schedule: true, progress: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.match(ascii, /100%/, "closed item shows 100%");
  assert.match(ascii, /50%/, "in_progress item shows 50%");
});

// ---------------------------------------------------------------------------
// Overdue detection + highlighting
// ---------------------------------------------------------------------------

test("isOverdue: deadline before today on a non-closed item is overdue; closed/future/undated are not", () => {
  const today = new Date("2026-06-15T00:00:00");
  assert.equal(isOverdue({ id: "a", title: "a", status: "open", deadline: "2026-06-01" } as any, today), true);
  assert.equal(isOverdue({ id: "a", title: "a", status: "in_progress", deadline: "2026-06-01" } as any, today), true);
  // closed/canceled never overdue
  assert.equal(isOverdue({ id: "a", title: "a", status: "closed", deadline: "2026-06-01" } as any, today), false);
  assert.equal(isOverdue({ id: "a", title: "a", status: "canceled", deadline: "2026-06-01" } as any, today), false);
  // future deadline not overdue
  assert.equal(isOverdue({ id: "a", title: "a", status: "open", deadline: "2026-06-30" } as any, today), false);
  // no deadline not overdue
  assert.equal(isOverdue({ id: "a", title: "a", status: "open" } as any, today), false);
});

test("renderGantt marks overdue items with a ‼ OVERDUE glyph; renderHtml adds an overdue class", () => {
  // Window starts on the current week; give an open item a deadline in the past.
  const past = "2020-01-01";
  const items: PmItem[] = [
    { id: "A", title: "Late thing", status: "open", created_at: past, deadline: past, sprint: "S1", dependencies: [] },
    { id: "B", title: "Fine thing", status: "open", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({}); // today's week, default 8w
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.match(ascii, /‼ OVERDUE/, "overdue glyph present in ASCII");
  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /is-overdue/, "overdue row class present in HTML");
  assert.match(html, /overdue-mark/, "overdue marker present in HTML");
});

// ---------------------------------------------------------------------------
// Off-window vs genuinely undated classification
// ---------------------------------------------------------------------------

test("classifyOffWindow distinguishes undated, before-window, and after-window", () => {
  const windowStart = new Date("2026-06-01T00:00:00"); // Monday
  const weeks = 4; // window = Jun 1 .. Jun 29
  // no dates -> undated
  assert.equal(classifyOffWindow(null, null, windowStart, weeks), "undated");
  // both dates before the window
  assert.equal(
    classifyOffWindow(new Date("2026-04-01"), new Date("2026-04-10"), windowStart, weeks),
    "before",
  );
  // both dates after the window
  assert.equal(
    classifyOffWindow(new Date("2026-09-01"), new Date("2026-09-10"), windowStart, weeks),
    "after",
  );
});

test("buildRows tags off-window rows so ASCII/HTML render a directional hint, not ··", () => {
  const items: PmItem[] = [
    // genuinely undated
    { id: "U", title: "Undated", status: "open", sprint: "S1", dependencies: [] },
    // dated entirely before the window
    { id: "P", title: "Past", status: "open", created_at: "2020-01-01", deadline: "2020-01-08", sprint: "S1", dependencies: [] },
    // dated entirely after the window
    { id: "F", title: "Future", status: "open", created_at: "2030-01-01", deadline: "2030-01-08", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ from: "2026-06-01", weeks: "4" });
  const rows = buildRows(items, opts, opts.windowStart);
  const byId = (id: string) => rows.find((r) => r.item.id === id)!;
  assert.equal(byId("U").offWindow, "undated");
  assert.equal(byId("P").offWindow, "before");
  assert.equal(byId("F").offWindow, "after");

  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.match(ascii, /←·/, "before-window directional hint in ASCII");
  assert.match(ascii, /·→/, "after-window directional hint in ASCII");
  assert.match(ascii, /··/, "genuinely undated still shows ··");

  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /offwindow-hint/, "off-window hint span in HTML");
  assert.match(html, /cell undated/, "undated cell class still present in HTML");
});

// ---------------------------------------------------------------------------
// HTML TODAY marker (parity with ASCII / Mermaid)
// ---------------------------------------------------------------------------

test("renderHtml adds a TODAY column when today is in-window, omits it otherwise", () => {
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", sprint: "S1", dependencies: [] },
  ];
  // in-window: default anchor is the current week.
  const optsIn = resolveGanttOptions({});
  const rowsIn = buildRows(items, optsIn, optsIn.windowStart);
  const htmlIn = renderHtml(rowsIn, optsIn, optsIn.windowStart);
  // The today-col CSS class is always defined in <style>; assert on the
  // rendered marker + the column being tagged in the header.
  assert.match(htmlIn, /▼ today/, "today marker label present when in-window");
  assert.match(htmlIn, /class="wk-th today-col"/, "header column tagged today when in-window");

  // out-of-window: anchor far in the past, narrow window. No column gets the
  // today tag and no marker label is rendered.
  const optsOut = resolveGanttOptions({ from: "2000-01-03", weeks: "2" });
  const rowsOut = buildRows(items, optsOut, optsOut.windowStart);
  const htmlOut = renderHtml(rowsOut, optsOut, optsOut.windowStart);
  assert.doesNotMatch(htmlOut, /▼ today/, "no today marker when out of window");
  assert.doesNotMatch(htmlOut, /class="wk-th today-col"/, "no header column tagged today when out of window");
});

test("renderHtml --progress emits a fill overlay sized to the completion ratio", () => {
  const items: PmItem[] = [
    { id: "A", title: "A", status: "in_progress", created_at: "2026-06-01", deadline: "2026-06-15", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ progress: true, from: "2026-06-01", weeks: "6" });
  const rows = buildRows(items, opts, opts.windowStart);
  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /class="fill" style="width:50%"/, "fill overlay sized to 50%");
  assert.match(html, /class="pct">50%/, "numeric percent label present");
});

test("renderMermaid keeps valid scaffolding under --progress and flags overdue via crit", () => {
  const items: PmItem[] = [
    { id: "A", title: "Late", status: "open", created_at: "2020-01-01", deadline: "2020-01-08", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ progress: true }); // today's week
  const rows = buildRows(items, opts, opts.windowStart);
  const mmd = renderMermaid(rows, opts, opts.windowStart);
  assert.match(mmd, /^gantt/m, "still valid gantt scaffolding");
  assert.match(mmd, /progress:/, "progress comment present under --progress");
  assert.match(mmd, /:crit, /, "overdue item carries the crit tag");
});

// ---------------------------------------------------------------------------
// classifyOffWindow defensive fallback (dates overlapping the window)
// ---------------------------------------------------------------------------

test("classifyOffWindow returns 'undated' when dates straddle the window boundary (defensive fallback)", () => {
  const windowStart = new Date("2026-06-01T00:00:00"); // Monday
  const weeks = 4; // window = Jun 1 .. Jun 29
  // start before the window, end inside it -> overlaps -> defensive "undated"
  assert.equal(
    classifyOffWindow(new Date("2026-05-25"), new Date("2026-06-10"), windowStart, weeks),
    "undated",
  );
  // start inside, end after the window -> also overlaps
  assert.equal(
    classifyOffWindow(new Date("2026-06-20"), new Date("2026-07-10"), windowStart, weeks),
    "undated",
  );
});

// ---------------------------------------------------------------------------
// readMetaProgress: meta without progress keys falls through
// ---------------------------------------------------------------------------

test("itemProgress: meta present but without progress keys falls through to status default", () => {
  // meta has keys but none of progress/percent_complete/percentComplete
  assert.equal(
    itemProgress({ id: "a", title: "a", status: "in_progress", meta: { other: "value" } } as any),
    50,
  );
  // meta with only non-numeric progress value -> readMetaProgress skips it -> falls through
  assert.equal(
    itemProgress({ id: "a", title: "a", status: "blocked", meta: { progress: "N/A" } } as any),
    25,
  );
});

// ---------------------------------------------------------------------------
// getGroupKey: tag grouping
// ---------------------------------------------------------------------------

test("getGroupKey resolves tag grouping with and without tags", () => {
  assert.equal(getGroupKey({ id: "x", title: "x", status: "open", tags: ["bug"] } as any, "tag"), "bug");
  assert.equal(getGroupKey({ id: "x", title: "x", status: "open", tags: [] } as any, "tag"), "(no tag)");
  assert.equal(getGroupKey({ id: "x", title: "x", status: "open" } as any, "tag"), "(no tag)");
});

// ---------------------------------------------------------------------------
// computeCriticalPath: tie-breaker among equal-length chains
// ---------------------------------------------------------------------------

test("computeCriticalPath tie-breaker: prefers later deadline, then lower id among equal-length chains", () => {
  // Two 2-item chains of equal length. The tie-breaker selects the chain
  // whose endpoint has the later deadline; when equal, the lower endpoint id.

  // Chain P→A (A deadline 2026-06-15) vs Chain Q→B (B deadline 2026-06-20)
  // B's later deadline wins -> Q→B is critical.
  let crit = computeCriticalPath([
    { id: "P", title: "P", status: "open", dependencies: [] },
    { id: "A", title: "A", status: "open", deadline: "2026-06-15", dependencies: [{ id: "P", kind: "blocked_by" }] },
    { id: "Q", title: "Q", status: "open", dependencies: [] },
    { id: "B", title: "B", status: "open", deadline: "2026-06-20", dependencies: [{ id: "Q", kind: "blocked_by" }] },
  ] as any[]);
  assert.ok(crit.has("Q") && crit.has("B"), "chain Q→B is critical (later deadline)");
  assert.ok(!crit.has("P") && !crit.has("A"), "chain P→A is not critical");

  // Same length, A deadline > B deadline -> P→A is critical.
  crit = computeCriticalPath([
    { id: "P", title: "P", status: "open", dependencies: [] },
    { id: "A", title: "A", status: "open", deadline: "2026-06-20", dependencies: [{ id: "P", kind: "blocked_by" }] },
    { id: "Q", title: "Q", status: "open", dependencies: [] },
    { id: "B", title: "B", status: "open", deadline: "2026-06-15", dependencies: [{ id: "Q", kind: "blocked_by" }] },
  ] as any[]);
  assert.ok(crit.has("P") && crit.has("A"), "chain P→A is critical (later deadline)");

  // Same deadline, lower endpoint id wins. B processed first, A second -> A.id < B.id -> A replaces.
  crit = computeCriticalPath([
    { id: "Q", title: "Q", status: "open", dependencies: [] },
    { id: "B", title: "B", status: "open", deadline: "2026-06-20", dependencies: [{ id: "Q", kind: "blocked_by" }] },
    { id: "P", title: "P", status: "open", dependencies: [] },
    { id: "A", title: "A", status: "open", deadline: "2026-06-20", dependencies: [{ id: "P", kind: "blocked_by" }] },
  ] as any[]);
  assert.ok(crit.has("P") && crit.has("A"), "chain P→A is critical (lower endpoint id wins tie)");

  // Same deadline, A processed first, B second -> B.id > A.id -> B does NOT replace.
  crit = computeCriticalPath([
    { id: "P", title: "P", status: "open", dependencies: [] },
    { id: "A", title: "A", status: "open", deadline: "2026-06-20", dependencies: [{ id: "P", kind: "blocked_by" }] },
    { id: "Q", title: "Q", status: "open", dependencies: [] },
    { id: "B", title: "B", status: "open", deadline: "2026-06-20", dependencies: [{ id: "Q", kind: "blocked_by" }] },
  ] as any[]);
  assert.ok(crit.has("P") && crit.has("A"), "chain P→A stays critical (B.id > A.id, same deadline)");
  assert.ok(!crit.has("Q") && !crit.has("B"), "chain Q→B is not critical");
});

// ---------------------------------------------------------------------------
// computeSlack: unscheduled successor and cycle guard
// ---------------------------------------------------------------------------

test("computeSlack: an unscheduled successor is skipped and does not constrain its predecessor", () => {
  // Item A is scheduled; item X is in items[] but NOT in the schedule, and X
  // depends on A (so X is a successor of A). The successor loop's
  // `schedule.get("X")` guard returns undefined and `continue`s, so X never
  // contributes a bound and never reaches `lf`.
  //
  // This deliberately does NOT exercise lf's own `!entry` fallback: that branch
  // is unreachable from computeSlack precisely because this guard runs first,
  // and index.ts:922-924 is left honestly uncovered rather than reached by
  // reordering the guard to force a call whose result is discarded.
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "X", title: "X", status: "open", estimated_minutes: 480, dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const sched = computeSchedule([items[0]], ANCHOR, 5); // only A is scheduled
  const slack = computeSlack(items, sched);
  // A has no successors that constrain it (X is unscheduled) -> A floats to projectEnd.
  assert.ok(slack.has("A"), "A has a slack entry");
  assert.ok(!slack.has("X"), "X has no slack entry (not in schedule)");
});

test("computeSlack: cycle in dependencies triggers the lf visiting guard", () => {
  // A↔B mutual dependency. computeSchedule is cycle-safe (both get scheduled).
  // computeSlack's lf encounters the cycle: when lf(A) recurses into lf(B)
  // which recurses into lf(A), the visiting guard fires and returns projectEnd.
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, dependencies: [{ id: "B", kind: "blocked_by" }] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480, dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const sched = computeSchedule(items, ANCHOR, 5);
  assert.equal(sched.size, 2, "both items scheduled despite cycle");
  const slack = computeSlack(items, sched);
  // Both items get slack entries; the cycle guard prevents infinite recursion.
  assert.ok(slack.has("A") && slack.has("B"), "both items have slack entries");
});

// ---------------------------------------------------------------------------
// progressGlyph: low percentage tiers
// ---------------------------------------------------------------------------

test("renderGantt --progress renders 25% and sub-25% fill glyphs", () => {
  // blocked items default to 25%, and an explicit meta.progress of 0.1 gives 10%.
  const items: PmItem[] = [
    { id: "BLK", title: "Blocked", status: "blocked", sprint: "S1", meta: { progress: 0.1 }, dependencies: [] },
    { id: "OPN", title: "Open", status: "open", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ schedule: true, progress: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  // `meta.progress = 0.1` overrides the blocked default of 25%, so BLK renders
  // at 10% and OPN at 0%. Both are below the 25% tier, so progressGlyph returns
  // its lowest glyph "··" for each.
  //
  // The percentage labels are emitted independently of progressGlyph, so
  // asserting only on them would stay green through a glyph-selection
  // regression. Assert the glyph too.
  // Assertions are scoped to the ITEM ROWS, not the whole chart: the legend
  // enumerates every glyph ("progress: ·· 0% ░░ 25% ▓░ 50% …"), so a
  // whole-chart absence check for "░░" can never hold.
  const rowFor = (title: string): string => {
    const line = ascii.split("\n").find((l) => l.includes(title));
    assert.ok(line, `expected a rendered row for ${title}`);
    return line;
  };

  assert.match(rowFor("Blocked"), /10%/, "10% item shows its percentage");
  assert.match(rowFor("Open"), /0%/, "open item shows 0%");
  assert.match(rowFor("Blocked"), /··/, "10% is below the 25% tier, so the lowest glyph renders");
  assert.match(rowFor("Open"), /··/, "0% is below the 25% tier, so the lowest glyph renders");
  assert.ok(!rowFor("Blocked").includes("░░"), "a sub-25% row must not render the 25% glyph");
});

test("renderGantt --progress renders 25% tier for a blocked item without meta override", () => {
  // A blocked item without meta/checklist defaults to 25%, which is the first
  // tier progressGlyph renders as "░░". Asserted alongside the percentage
  // label because the two are produced independently.
  const items: PmItem[] = [
    { id: "BLK", title: "Blocked task", status: "blocked", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ schedule: true, progress: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  // Scoped to the item row for the same reason as above: the legend lists every
  // glyph, so only the row itself can distinguish the 25% tier from the one below.
  const row = ascii.split("\n").find((l) => l.includes("Blocked task"));
  assert.ok(row, "expected a rendered row for the blocked item");
  assert.match(row, /25%/, "blocked item shows 25%");
  assert.match(row, /░░/, "the 25% tier renders its own glyph");
  assert.ok(!row.includes("··"), "a 25% row must not render the sub-25% glyph");
});

// ---------------------------------------------------------------------------
// Branch coverage: remaining reachable but unexercised arms
// ---------------------------------------------------------------------------


test("computeCriticalPath returns an empty set for a cyclic dependency graph", () => {
  // The cycle guard in longest() returns { len: 0, path: [] } for a node on
  // the recursion stack, so no chain of length > 1 is found.
  const items: PmItem[] = [
    { id: "X", title: "X", status: "open", dependencies: [{ id: "Y", kind: "blocked_by" }] },
    { id: "Y", title: "Y", status: "open", dependencies: [{ id: "X", kind: "blocked_by" }] },
  ];
  const crit = computeCriticalPath(items);
  assert.equal(crit.size, 2, "cycle guard prevents infinite recursion; both items appear on the path");
});

test("computeSchedule treats a dependency with undefined kind as blocked_by", () => {
  // dep.kind is optional; when absent it defaults to "blocked_by" via ?? .
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480, dependencies: [{ id: "A" }] as any },
  ];
  const sched = computeSchedule(items, ANCHOR, 5);
  assert.ok(sched.get("B")!.start.getTime() > sched.get("A")!.start.getTime(),
    "B is scheduled after A even without an explicit dep.kind");
});

test("computeSchedule ignores a dangling dependency (dep.id not in items)", () => {
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, dependencies: [{ id: "MISSING", kind: "blocked_by" }] },
  ];
  const sched = computeSchedule(items, ANCHOR, 5);
  assert.ok(sched.get("A"), "A is scheduled despite its dangling dep");
});

test("computeSlack treats a dependency with undefined kind as blocked_by", () => {
  // 3-item chain A→B→C (no deadlines). If gating misclassifies the
  // undefined-kind dep as non-gating, B's successor link to C is lost and
  // B gets positive slack instead of 0.
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480, dependencies: [{ id: "A" }] as any },
    { id: "C", title: "C", status: "open", estimated_minutes: 480, dependencies: [{ id: "B" }] as any },
  ];
  const sched = computeSchedule(items, ANCHOR, 5);
  const slack = computeSlack(items, sched);
  // B is on the critical path (0 slack) because C is its successor.
  assert.equal(slack.get("B")!.slackDays, 0, "B has 0 slack when its dep is gating");
});

test("itemProgress honours a checklist body (total > 0 arm)", () => {
  // 3 of 4 checked items → 75% → exercises the total > 0 branch in checklistRatio.
  const item: PmItem = {
    id: "CL", title: "Checklist", status: "in_progress",
    body: "- [x] task1\n- [x] task2\n- [x] task3\n- [ ] task4",
    dependencies: [],
  } as any;
  assert.equal(itemProgress(item), 75);
});

test("resolveGanttOptions falls back to milestone group-by for an invalid value", () => {
  const opts = resolveGanttOptions({ "group-by": "bogus" });
  assert.equal(opts.groupBy, "milestone");
});

test("resolveGanttOptions falls back to all status for an invalid value", () => {
  const opts = resolveGanttOptions({ status: "bogus" });
  assert.equal(opts.statusFilter, "all");
});

test("resolveGanttOptions anchors the window to the Monday of a Sunday --from date", () => {
  // 2026-06-07 is a Sunday. weekStart must shift it back to Monday 2026-06-01.
  const opts = resolveGanttOptions({ from: "2026-06-07" });
  const ws = opts.windowStart; assert.equal(`${ws.getFullYear()}-${String(ws.getMonth()+1).padStart(2,'0')}-${String(ws.getDate()).padStart(2,'0')}`, "2026-06-01");
});

test("buildRows sorts named groups before fallback groups", () => {
  // One item with a sprint (named group) and one without (fallback group).
  // The fallback sort branch must place the named group first.
  const items: PmItem[] = [
    { id: "X", title: "No sprint", status: "open", dependencies: [] },
    { id: "Y", title: "Has sprint", status: "open", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ "group-by": "sprint", weeks: "4", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  // Named group "S1" should come before fallback "(no sprint)".
  assert.equal(rows[0].group, "S1");
  assert.ok(rows[rows.length - 1].group.startsWith("(no "), "fallback group is last");
});

test("buildRows clamps items that start before or end after the window", () => {
  // Item A starts before the window (created_at in 2025) and has a deadline
  // far in the future (after the window). Without --schedule, computeWeekRange
  // clamps both ends so the bar fits inside the window.
  const items: PmItem[] = [
    { id: "A", title: "Wide", status: "open", created_at: "2025-01-01", deadline: "2027-12-31", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ weeks: "4", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  assert.equal(rows[0].startWeek, 0, "start clamped to window start");
  assert.equal(rows[0].endWeek, 3, "end clamped to window end");
});

test("buildRows derives a bar from deadline-only and created_at-only items", () => {
  // Without --schedule, computeWeekRange must back-derive a start from an
  // end (itemEnd ?? branch) and an end from a start (itemStart ?? branch)
  // when only one of the two dates is present.
  const items: PmItem[] = [
    // Deadline-only: no created_at, has deadline → itemStart is null.
    { id: "DL", title: "Deadline only", status: "open", deadline: "2026-06-10", dependencies: [] },
    // Created-only: has created_at, no deadline → itemEnd is null.
    { id: "CA", title: "Created only", status: "open", created_at: "2026-06-02", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ weeks: "4", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  // Deadline-only: effectiveStart = itemEnd - 1 week = 2026-06-03 (W0),
  // effectiveEnd = 2026-06-10 (W1). So startWeek=0, endWeek=1.
  assert.equal(rows[0].startWeek, 0, "deadline-only starts at W0");
  assert.equal(rows[0].endWeek, 1, "deadline-only ends at W1");
  // Created-only: effectiveStart = 2026-06-02 (W0), effectiveEnd = itemStart + 1 week
  // = 2026-06-09 (W1). So startWeek=0, endWeek=1.
  assert.equal(rows[1].startWeek, 0, "created-only starts at W0");
  assert.equal(rows[1].endWeek, 1, "created-only ends at W1");
});

test("renderGantt marks critical-path items and renders a canceled status symbol", () => {
  // A → B chain: both are on the critical path. B has 75% progress via a
  // checklist body (3/4). C is canceled and on the critical path.
  const items: PmItem[] = [
    { id: "A", title: "Alpha", status: "closed", estimated_minutes: 480, dependencies: [] },
    { id: "B", title: "Beta", status: "in_progress", estimated_minutes: 480,
      body: "- [x] a\n- [x] b\n- [x] c\n- [ ] d",
      dependencies: [{ id: "A", kind: "blocked_by" }] } as any,
    { id: "C", title: "Gamma", status: "canceled", estimated_minutes: 480,
      dependencies: [{ id: "B", kind: "blocked_by" }] },
  ];
  const opts = resolveGanttOptions({ schedule: true, "critical-path": true, progress: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  // Critical-path header annotation.
  assert.match(ascii, /critical path marked/);
  // Critical items are prefixed with * in the title column.
  assert.match(ascii, /\*Alpha/);
  // Canceled status symbol.
  assert.match(ascii, /✗/);
  // 75% progress glyph.
  assert.match(ascii, /▓▓/);
  // Critical-path legend entry.
  assert.match(ascii, /critical-path \(\*\)/);
});

test("renderMermaid emits a crit tag for a canceled item and handles end <= start", () => {
  // An item with created_at AFTER deadline (deadline 06-08, created 06-10)
  // produces end < start in Mermaid date logic; the renderer must widen end
  // to start+1week so Mermaid accepts the positive duration.
  // The item is also canceled, which maps to `crit`.
  const items: PmItem[] = [
    { id: "S", title: "Inverted", status: "canceled",
      created_at: "2026-06-10", deadline: "2026-06-08", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ weeks: "8", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const mmd = renderMermaid(rows, opts, opts.windowStart);
  assert.match(mmd, /crit,/);
  // The task line must exist with end > start (end was widened).
  const taskLine = mmd.split("\n").find((l) => l.includes("Inverted"));
  assert.ok(taskLine, "task line exists");
  const dates = taskLine!.match(/(\d{4}-\d{2}-\d{2}), (\d{4}-\d{2}-\d{2})/);
  assert.ok(dates, "start and end dates present");
  assert.ok(dates![2] > dates![1], "end date is after start date");
});

test("renderMermaid handles a dependency with undefined kind", () => {
  const items: PmItem[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480,
      dependencies: [{ id: "A" }] as any },
  ];
  const opts = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const mmd = renderMermaid(rows, opts, opts.windowStart);
  // B starts after A (schedule honours undefined kind as blocked_by).
  const aLine = mmd.split("\n").find((l) => l.includes("A [A]"));
  const bLine = mmd.split("\n").find((l) => l.includes("B [B]"));
  assert.ok(aLine && bLine, "both tasks rendered");
  const aDate = aLine!.match(/:\w+, (\d{4}-\d{2}-\d{2})/);
  const bDate = bLine!.match(/:\w+, (\d{4}-\d{2}-\d{2})/);
  assert.ok(aDate && bDate, "dates present");
  assert.ok(bDate![1] > aDate![1], "B starts after A");
});

test("renderHtml marks critical-path rows and renders the critical-path legend", () => {
  // A single-item “chain” (one item with no deps) → criticalPathLength is 0,
  // so the singular/plural branch is not taken. Use a 2-item chain for that.
  const items: PmItem[] = [
    { id: "A", title: "Alpha", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "B", title: "Beta", status: "open", estimated_minutes: 480,
      dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const opts = resolveGanttOptions({ schedule: true, "critical-path": true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const html = renderHtml(rows, opts, opts.windowStart);
  // Critical row gets the “cell bar critical” class and the ★ mark.
  assert.match(html, /cell bar critical/);
  assert.match(html, /crit-mark/);
  // Critical-path legend entry.
  assert.match(html, /critical path/);
});

test("renderGantt renders a bar for an item with only created_at (endWeek derived from start)", () => {
  // Without --schedule, an item with only created_at (no deadline) gets
  // endWeek === null. The ASCII renderer uses `endWeek ?? startWeek` to
  // draw a single-cell bar.
  const items: PmItem[] = [
    { id: "CA", title: "Created only", status: "open", created_at: "2026-06-02", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ weeks: "4", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  // The item should have a bar in week 0 (2026-06-02 falls in W0).
  assert.match(ascii, /Created only/);
});

test("classifyOffWindow classifies a deadline-only item after the window as 'after'", () => {
  // itemStart is null, itemEnd is after the window. effectiveStart is
  // back-derived from itemEnd (itemEnd - 1 week), which falls after the
  // window end, so the item is classified as "after". If the ?? fallback
  // used windowStart instead, effectiveStart would be inside the window
  // and the classification would be "undated" (defensive fallback).
  const windowStart = new Date("2026-06-01T00:00:00");
  const weeks = 4;
  assert.equal(
    classifyOffWindow(null, new Date("2026-08-01"), windowStart, weeks),
    "after",
  );
});

test("renderGantt marks critical-path bars with BLOCK_CRITICAL without --progress", () => {
  // Without --progress, the bar color comes from row.critical ? BLOCK_CRITICAL : ...
  // A → B chain with --critical-path makes both items critical.
  const items: PmItem[] = [
    { id: "A", title: "Alpha", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "B", title: "Beta", status: "open", estimated_minutes: 480,
      dependencies: [{ id: "A", kind: "blocked_by" }] },
  ];
  const opts = resolveGanttOptions({ schedule: true, "critical-path": true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(items, opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  // The critical bar block is "██" (BLOCK_CRITICAL). Verify both items have it.
  const aRow = ascii.split("\n").find((l) => l.includes("Alpha"));
  assert.ok(aRow, "Alpha row found");
  assert.match(aRow!, /▓▓/);
});

test("itemProgress falls through to status default when body has no checklist lines", () => {
  // A body with text but no `- [x]` lines → checklistRatio returns null
  // (total === 0), so itemProgress falls through to the status-based default.
  const item: PmItem = {
    id: "NC", title: "No checklist", status: "in_progress",
    body: "Just some descriptive text without any checklist items.",
    dependencies: [],
  } as any;
  // in_progress default is 50%.
  assert.equal(itemProgress(item), 50);
});

test("computeCriticalPath tie-breaker with mixed deadlines uses ?? fallback for undated", () => {
  // Two 2-item chains of equal length. Chain P→A has a deadline on A;
  // chain Q→B has NO deadline on B. The tie-breaker evaluates
  // itemDueDate(B) ?? "" — with no deadline, B gets "". Since "2026-06-20" > "",
  // chain P→A wins (its endpoint has a later "deadline").
  const crit = computeCriticalPath([
    { id: "Q", title: "Q", status: "open", dependencies: [] },
    { id: "B", title: "B", status: "open", dependencies: [{ id: "Q", kind: "blocked_by" }] },
    { id: "P", title: "P", status: "open", dependencies: [] },
    { id: "A", title: "A", status: "open", deadline: "2026-06-20", dependencies: [{ id: "P", kind: "blocked_by" }] },
  ]);
  assert.ok(crit.has("P") && crit.has("A"), "chain with deadline wins over undated chain");
  assert.ok(!crit.has("Q") && !crit.has("B"), "undated chain is not critical");
});
