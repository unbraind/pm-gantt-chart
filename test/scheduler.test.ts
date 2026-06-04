import assert from "node:assert/strict";
import test from "node:test";

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
  infeasibleWarnings,
  buildRows,
  resolveGanttOptions,
  getGroupKey,
  itemProgress,
  isOverdue,
  classifyOffWindow,
} from "../dist/index.js";

// A small, deterministic project: A -> B -> C chain plus an isolated item.
//   A (Design)      estimate 480m  = 1 working day
//   B (Build)       estimate 960m  = 2 working days, blocked_by A
//   C (Integration) estimate 720m  = 2 working days, blocked_by B
//   D (Docs)        estimate 480m  = 1 working day, no deps, deadline far out
function chainItems(): any[] {
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
  assert.equal(lines[0], "id,title,start,end,duration_days,slack_days,deps,status");
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
  const items: any[] = [
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
  const items: any[] = [
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
    "id,title,start,end,duration_days,slack_days,deps,status",
  );

  // With --schedule: A on the critical path -> slack 0.
  const opts = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const csv = renderCsv(rows);
  const aLine = csv.split("\n").find((l) => l.startsWith("A,"))!;
  // columns: id,title,start,end,duration_days,slack_days,deps,status
  const aCols = aLine.split(",");
  assert.equal(aCols[5], "0", "A (critical) has slack_days = 0");
  const dLine = csv.split("\n").find((l) => l.startsWith("D,"))!;
  assert.equal(dLine.split(",")[5], "4", "D has slack_days = 4");
});

test("infeasibleWarnings surfaces a line per already-late item", () => {
  const opts = resolveGanttOptions({ schedule: true, weeks: "12", from: "2026-06-01" });
  const items: any[] = [
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
  const items: any[] = [
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
  const items: any[] = [
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
  assert.match(html, /Critical-path length/);
  assert.match(html, /<h2>Assignee workload<\/h2>/, "workload table present under --group-by assignee");
  assert.match(html, /alice/);

  // Not grouped by assignee -> summary present, but no workload table.
  const opts2 = resolveGanttOptions({ schedule: true, "group-by": "sprint", weeks: "12", from: "2026-06-01" });
  const rows2 = buildRows(items, opts2, opts2.windowStart);
  const html2 = renderHtml(rows2, opts2, opts2.windowStart);
  assert.match(html2, /<h2>Summary<\/h2>/);
  assert.doesNotMatch(html2, /Assignee workload/);
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
  const items: any[] = [
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
  const items: any[] = [
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
  const items: any[] = [
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
  const items: any[] = [
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
  const items: any[] = [
    { id: "A", title: "A", status: "in_progress", created_at: "2026-06-01", deadline: "2026-06-15", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ progress: true, from: "2026-06-01", weeks: "6" });
  const rows = buildRows(items, opts, opts.windowStart);
  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /class="fill" style="width:50%"/, "fill overlay sized to 50%");
  assert.match(html, /class="pct">50%/, "numeric percent label present");
});

test("renderMermaid keeps valid scaffolding under --progress and flags overdue via crit", () => {
  const items: any[] = [
    { id: "A", title: "Late", status: "open", created_at: "2020-01-01", deadline: "2020-01-08", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ progress: true }); // today's week
  const rows = buildRows(items, opts, opts.windowStart);
  const mmd = renderMermaid(rows, opts, opts.windowStart);
  assert.match(mmd, /^gantt/m, "still valid gantt scaffolding");
  assert.match(mmd, /progress:/, "progress comment present under --progress");
  assert.match(mmd, /:crit, /, "overdue item carries the crit tag");
});
