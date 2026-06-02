import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSchedule,
  computeCriticalPath,
  itemDurationDays,
  renderCsv,
  renderMermaid,
  buildRows,
  resolveGanttOptions,
  getGroupKey,
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
  assert.equal(lines[0], "id,title,start,end,duration_days,deps,status");
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
