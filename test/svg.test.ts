import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSvg,
  renderHtml,
  buildRows,
  resolveGanttOptions,
  getGroupKey,
  EXPORT_FORMATS,
} from "../dist/index.js";

// Deterministic chain + isolated item, anchored on a Monday.
function chainItems(): any[] {
  return [
    { id: "A", title: "Design API", status: "closed", estimated_minutes: 480, sprint: "S1", dependencies: [] },
    { id: "B", title: "Build endpoint", status: "in_progress", estimated_minutes: 960, sprint: "S1", dependencies: [{ id: "A", kind: "blocked_by" }] },
    { id: "C", title: "Integration tests", status: "open", estimated_minutes: 720, sprint: "S2", dependencies: [{ id: "B", kind: "blocked_by" }] },
    { id: "D", title: "Write docs", status: "open", estimated_minutes: 480, sprint: "S2", dependencies: [] },
  ];
}

const FROM = "2026-06-01"; // Monday

// ---------------------------------------------------------------------------
// SVG format scaffolding
// ---------------------------------------------------------------------------

test("renderSvg produces a self-contained, well-formed SVG document", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "6" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);

  assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>/m, "XML declaration present");
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "svg root with namespace");
  assert.match(svg, /<\/svg>$/, "svg root is closed");
  assert.match(svg, /width="\d+"/, "carries a numeric width attribute");
  assert.match(svg, /height="\d+"/, "carries a numeric height attribute");
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, "carries a viewBox");
  // One bar rect per active week-cell exists.
  assert.match(svg, /<rect .*fill="#2b7de9"/, "in_progress bar is the active blue");
  assert.match(svg, /<text[^>]*>Build endpoint<\/text>/, "item title rendered");
});

test("renderSvg reflects the chosen --width in the canvas width and viewBox", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "6", width: "1600" });
  assert.equal(opts.width, 1600, "resolveGanttOptions exposes the width");
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, new RegExp(`width="${1600}"`), "svg width honors --width");
  assert.match(svg, /viewBox="0 0 1600 \d+"/, "viewBox width honors --width");
});

test("renderSvg expands long timelines instead of clipping outside the viewBox", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "52", width: "320" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  const width = Number(svg.match(/<svg[^>]* width="(\d+)"/)?.[1]);
  const chartEnd = 16 + 120 + 190 + 56 + 52 * 24;
  assert.ok(width >= chartEnd + 16, `canvas ${width}px should contain chart ending at ${chartEnd}px`);
  assert.match(svg, new RegExp(`viewBox="0 0 ${width} \\d+"`));
});

test("renderSvg default width is 1000", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "6" });
  assert.equal(opts.width, 1000);
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, /width="1000"/);
});

test("renderSvg clamps absurd widths to the [320, 8192] range", () => {
  const tooSmall = resolveGanttOptions({ from: FROM, weeks: "6", width: "10" });
  assert.equal(tooSmall.width, 320, "below-minimum clamps up to 320");
  const tooBig = resolveGanttOptions({ from: FROM, weeks: "6", width: "99999" });
  assert.equal(tooBig.width, 8192, "above-maximum clamps down to 8192");
});

test("resolveGanttOptions rejects a non-numeric --width with a usage error", () => {
  assert.throws(() => resolveGanttOptions({ from: FROM, width: "wide" }), /Invalid --width/);
});

test("renderSvg marks critical-path bars with the critical color under --critical-path", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "12", "critical-path": true, schedule: true });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, /fill="#e05c5c"/, "critical-path bars use the critical red");
  assert.match(svg, /\* Design API/, "critical items are prefixed with * in the label");
});

test("renderSvg draws a milestone diamond for in-window milestones", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "8", milestones: "v1.0=2026-06-30" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, /<polygon /, "milestone diamond rendered");
  assert.match(svg, />v1\.0</, "milestone name label present");
});

test("renderSvg omits the milestone diamond for out-of-window milestones", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "4", milestones: "far=2027-01-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.doesNotMatch(svg, />far</, "out-of-window milestone not drawn");
});

test("renderSvg --show-progress overlays a fill sized to the completion ratio", () => {
  // --show-progress is the alias; must behave identically to --progress.
  const optsAlias = resolveGanttOptions({ "show-progress": true, schedule: true, from: FROM, weeks: "6" });
  const optsPlain = resolveGanttOptions({ progress: true, schedule: true, from: FROM, weeks: "6" });
  assert.equal(optsAlias.progress, true, "--show-progress enables progress");
  assert.equal(optsAlias.progress, optsPlain.progress, "--show-progress and --progress are equivalent");

  const rows = buildRows(chainItems(), optsAlias, optsAlias.windowStart);
  const svg = renderSvg(rows, optsAlias, optsAlias.windowStart);
  assert.match(svg, /fill="rgba\(0,0,0,0\.35\)"/, "progress fill overlay present");
  assert.match(svg, /100%/, "closed item reports 100%");
  assert.match(svg, /50%/, "in_progress item reports 50%");
  assert.equal((svg.match(/>50%<\/text>/g) ?? []).length, 1, "multi-week progress label is emitted once");
});

test("renderSvg renders overdue bars in the overdue color and marker", () => {
  // Anchor far in the future so the off-window "before" hint path is NOT taken;
  // we want the overdue path. Use a window starting after today but the item's
  // dates are in the past -> off-window "before". To exercise the overdue color
  // on a bar, give the item an in-window date range with a past deadline.
  const items2: any[] = [
    { id: "L", title: "Late", status: "open", created_at: "2026-06-01", deadline: "2026-06-05", sprint: "S1", dependencies: [] },
  ];
  // Use today's week so the past deadline (relative to a future "today") is overdue.
  // To keep it deterministic, anchor on a fixed Monday and set deadline before
  // the actual current date is not deterministic; instead verify the color
  // function via a known overdue row by constructing opts with today after deadline.
  const opts = resolveGanttOptions({ from: FROM, weeks: "4" });
  // Override today to a date after the deadline to force overdue.
  (opts as any).today = new Date("2026-07-01T00:00:00");
  const rows = buildRows(items2, opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, /fill="#c23b3b"/, "overdue bar uses the overdue red");
  assert.match(svg, /\u203c overdue/, "overdue marker text present");
});

test("renderSvg --group-by assignee produces assignee-labeled group rows", () => {
  const items: any[] = [
    { id: "A", title: "A", status: "open", estimated_minutes: 480, assignee: "alice", dependencies: [] },
    { id: "B", title: "B", status: "open", estimated_minutes: 480, assignee: "bob", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ "group-by": "assignee", schedule: true, from: FROM, weeks: "6" });
  const rows = buildRows(items, opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, />alice</, "alice group label rendered");
  assert.match(svg, />bob</, "bob group label rendered");
});

test("renderSvg output is well-formed enough to contain matching open/close tags", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "4" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  const opens = (svg.match(/<svg\b/g) ?? []).length;
  const closes = (svg.match(/<\/svg>/g) ?? []).length;
  assert.equal(opens, 1, "exactly one <svg> open tag");
  assert.equal(closes, 1, "exactly one </svg> close tag");
});

// ---------------------------------------------------------------------------
// --show-progress alias parity (applies to all renderers, verified on ASCII
// behavior via the shared option; here we assert resolveGanttOptions parity
// and that the HTML render also honors it identically).
// ---------------------------------------------------------------------------

test("renderHtml --show-progress emits the fill overlay (alias parity with --progress)", () => {
  const items: any[] = [
    { id: "A", title: "A", status: "in_progress", created_at: "2026-06-01", deadline: "2026-06-15", sprint: "S1", dependencies: [] },
  ];
  const opts = resolveGanttOptions({ "show-progress": true, from: FROM, weeks: "6" });
  const rows = buildRows(items, opts, opts.windowStart);
  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /class="fill" style="width:50%"/, "fill overlay sized to 50% under --show-progress");
  assert.match(html, /class="pct">50%/, "numeric percent label present under --show-progress");
});

test("renderHtml --width sets the table width style", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "4", width: "1400" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const html = renderHtml(rows, opts, opts.windowStart);
  assert.match(html, /<table style="width:1400px">/, "HTML table width honors --width");
});

// ---------------------------------------------------------------------------
// Existing --group-by sprint/type/assignee coverage (regression guard for the
// requested grouping options, which already existed).
// ---------------------------------------------------------------------------

test("getGroupKey resolves sprint / type / assignee grouping keys", () => {
  const item: any = { id: "x", title: "x", status: "open", sprint: "S1", type: "bug", assignee: "alice" };
  assert.equal(getGroupKey(item, "sprint"), "S1");
  assert.equal(getGroupKey(item, "type"), "bug");
  assert.equal(getGroupKey(item, "assignee"), "alice");
  // fallbacks for missing values
  assert.equal(getGroupKey({ id: "y", title: "y", status: "open" } as any, "type"), "(no type)");
  assert.equal(getGroupKey({ id: "y", title: "y", status: "open" } as any, "assignee"), "(unassigned)");
});

test("EXPORT_FORMATS includes svg", () => {
  assert.ok(EXPORT_FORMATS.includes("svg"));
});

test("renderSvg draws the TODAY rule after body rows so backgrounds can't cover it", () => {
  const opts = resolveGanttOptions({ from: FROM, weeks: "6" });
  // Force today inside the window so the rule is drawn.
  (opts as any).today = new Date("2026-06-10T00:00:00");
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const svg = renderSvg(rows, opts, opts.windowStart);
  const ruleAt = svg.indexOf("▼ today");
  const lastBackground = svg.lastIndexOf('fill="#f4f4f4"');
  assert.ok(ruleAt >= 0, "TODAY rule present when today is in-window");
  assert.ok(lastBackground >= 0, "alternating row backgrounds present");
  assert.ok(ruleAt > lastBackground, "TODAY rule painted after (on top of) row backgrounds");
});
