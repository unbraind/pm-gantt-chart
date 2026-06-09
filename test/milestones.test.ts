import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMilestones,
  milestoneWeek,
  offWindowMilestones,
  renderGantt,
  renderMermaid,
  renderCsv,
  buildRows,
  resolveGanttOptions,
} from "../dist/index.js";

// A Monday anchor so the window starts cleanly on a week boundary.
const FROM = "2026-06-01"; // Monday
const ANCHOR = new Date("2026-06-01T00:00:00");

function sampleItems(): any[] {
  return [
    { id: "A", title: "Design", status: "in_progress", created_at: "2026-06-02", deadline: "2026-06-10", sprint: "S1", dependencies: [] },
  ];
}

// --- parseMilestones ---------------------------------------------------------

test("parseMilestones parses comma-separated name=YYYY-MM-DD entries", () => {
  const ms = parseMilestones("v1.0=2026-06-30,v1.1=2026-08-15");
  assert.equal(ms.length, 2);
  assert.equal(ms[0].name, "v1.0");
  assert.equal(ms[0].date.getTime(), new Date("2026-06-30T00:00:00").getTime());
  assert.equal(ms[1].name, "v1.1");
});

test("parseMilestones returns [] for absent/blank input and tolerates stray commas", () => {
  assert.deepEqual(parseMilestones(undefined), []);
  assert.deepEqual(parseMilestones(""), []);
  assert.deepEqual(parseMilestones("   "), []);
  const ms = parseMilestones("v1.0=2026-06-30,,");
  assert.equal(ms.length, 1);
});

function caught(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected throw");
}

test("parseMilestones rejects malformed entries with a CommandError-shaped error", () => {
  // missing '='
  const e1 = caught(() => parseMilestones("v1.0 2026-06-30"));
  assert.match(e1.message, /Invalid --milestones entry/);
  assert.equal(e1.exitCode, 2);
  // empty name
  assert.throws(() => parseMilestones("=2026-06-30"), /empty milestone name/);
  // non-ISO date
  const e2 = caught(() => parseMilestones("v1.0=June 30"));
  assert.match(e2.message, /Invalid --milestones date/);
  assert.equal(e2.exitCode, 2);
  // impossible calendar date
  assert.throws(() => parseMilestones("v1.0=2026-13-40"), /Invalid --milestones date/);
});

// --- milestoneWeek: column mapping -------------------------------------------

test("milestoneWeek maps a date to the correct 0-based week column", () => {
  // window: 2026-06-01 (Mon), 4 weeks -> W0 06-01..06-07, W1 06-08..06-14, ...
  assert.equal(milestoneWeek(new Date("2026-06-01T00:00:00"), ANCHOR, 4), 0);
  assert.equal(milestoneWeek(new Date("2026-06-07T00:00:00"), ANCHOR, 4), 0);
  assert.equal(milestoneWeek(new Date("2026-06-08T00:00:00"), ANCHOR, 4), 1);
  assert.equal(milestoneWeek(new Date("2026-06-22T00:00:00"), ANCHOR, 4), 3);
});

test("milestoneWeek returns -1 for dates outside the window (before and after)", () => {
  // before the window
  assert.equal(milestoneWeek(new Date("2026-05-25T00:00:00"), ANCHOR, 4), -1);
  // 4 weeks => window end exclusive at 2026-06-29
  assert.equal(milestoneWeek(new Date("2026-06-29T00:00:00"), ANCHOR, 4), -1);
});

test("offWindowMilestones lists only the out-of-window names", () => {
  const ms = parseMilestones("inA=2026-06-10,past=2026-01-01,future=2027-01-01");
  const dropped = offWindowMilestones(ms, ANCHOR, 4);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.some((d) => d.includes("past")));
  assert.ok(dropped.some((d) => d.includes("future")));
  assert.ok(!dropped.some((d) => d.includes("inA")));
});

// --- ASCII render ------------------------------------------------------------

test("renderGantt draws a milestone marker in the correct week column", () => {
  // v1.0 on 2026-06-10 falls in W1 (06-08..06-14) of a window anchored 06-01.
  const opts = resolveGanttOptions({ from: FROM, weeks: "4", milestones: "v1.0=2026-06-10" });
  const rows = buildRows(sampleItems(), opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  const markerLine = ascii.split("\n").find((l) => l.includes("▼v1.0"));
  assert.ok(markerLine, "milestone marker line present");
  // It must NOT collide with the TODAY marker line.
  assert.ok(!markerLine!.includes("TODAY"));
  assert.match(ascii, /Legend:.*milestone date/);
});

test("renderGantt comma-joins multiple milestones that share a week", () => {
  // both 2026-06-09 and 2026-06-11 are in W1.
  const opts = resolveGanttOptions({ from: FROM, weeks: "4", milestones: "alpha=2026-06-09,beta=2026-06-11" });
  const rows = buildRows(sampleItems(), opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.match(ascii, /▼alpha,beta/);
});

test("renderGantt omits markers for out-of-window milestones", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "4", milestones: "far=2027-01-01" });
  const rows = buildRows(sampleItems(), opts, opts.windowStart);
  const ascii = renderGantt(rows, opts, opts.windowStart);
  assert.ok(!ascii.includes("▼far"), "out-of-window milestone not drawn");
});

// --- Mermaid export ----------------------------------------------------------

test("renderMermaid emits a Milestones section with native milestone markers", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "8", milestones: "v1.0=2026-06-30" });
  const rows = buildRows(sampleItems(), opts, opts.windowStart);
  const mmd = renderMermaid(rows, opts, opts.windowStart);
  assert.match(mmd, /section Milestones/);
  assert.match(mmd, /v1\.0 :milestone, m0, 2026-06-30, 0d/);
});

// --- CSV export --------------------------------------------------------------

test("renderCsv appends milestone rows that round-trip the date", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "8", milestones: "v1.0=2026-06-30" });
  const rows = buildRows(sampleItems(), opts, opts.windowStart);
  const csv = renderCsv(rows, opts.milestones);
  const milestoneRow = csv.split("\n").find((l) => l.startsWith("milestone:v1.0"));
  assert.ok(milestoneRow, "milestone CSV row present");
  // id,title,start,end,...,status -> start==end==date, status==milestone
  const cols = milestoneRow!.split(",");
  assert.equal(cols[0], "milestone:v1.0");
  assert.equal(cols[1], "v1.0");
  assert.equal(cols[2], "2026-06-30"); // start
  assert.equal(cols[3], "2026-06-30"); // end
  assert.equal(cols[7], "milestone"); // status
});

test("renderCsv with no milestones is unchanged (backward compatible single-arg)", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "8" });
  const rows = buildRows(sampleItems(), opts, opts.windowStart);
  assert.equal(renderCsv(rows), renderCsv(rows, []));
});
