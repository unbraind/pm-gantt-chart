import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRows,
  resolveGanttOptions,
  renderJson,
} from "../dist/index.js";

// Same deterministic A -> B -> C chain (+ isolated D) used by scheduler.test.ts.
function chainItems(): any[] {
  return [
    { id: "A", title: "Design API", status: "closed", estimated_minutes: 480, sprint: "S1", dependencies: [] },
    { id: "B", title: "Build endpoint", status: "in_progress", estimated_minutes: 960, sprint: "S1", dependencies: [{ id: "A", kind: "blocked_by" }] },
    { id: "C", title: "Integration tests", status: "open", estimated_minutes: 720, sprint: "S2", dependencies: [{ id: "B", kind: "blocked_by" }] },
    { id: "D", title: "Write docs", status: "open", estimated_minutes: 480, sprint: "S2", dependencies: [] },
  ];
}

test("renderJson emits a structured schedule with window, options, summary and items", () => {
  const opts = resolveGanttOptions({ schedule: true, "group-by": "sprint", weeks: "12", from: "2026-06-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const parsed = JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones));

  assert.equal(parsed.window.start, "2026-06-01");
  assert.equal(parsed.window.weeks, 12);
  assert.equal(parsed.options.groupBy, "sprint");
  assert.equal(parsed.options.schedule, true);

  assert.ok(Array.isArray(parsed.items), "items is an array");
  assert.equal(parsed.items.length, 4, "one entry per item");

  // Summary reflects the dated chain.
  assert.equal(typeof parsed.summary.spanDays, "number");
  assert.equal(typeof parsed.summary.totalTaskDays, "number");
  assert.ok(Array.isArray(parsed.summary.workload));
});

test("renderJson per-item fields carry ISO dates, gating deps, progress and group", () => {
  const opts = resolveGanttOptions({ schedule: true, "group-by": "sprint", weeks: "12", from: "2026-06-01" });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const items = JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones)).items as any[];

  const b = items.find((i) => i.id === "B");
  assert.ok(b, "B present");
  assert.equal(b.group, "S1");
  assert.equal(b.status, "in_progress");
  assert.match(b.start, /^\d{4}-\d{2}-\d{2}$/, "ISO start");
  assert.match(b.end, /^\d{4}-\d{2}-\d{2}$/, "ISO end");
  assert.deepEqual(b.deps, ["A"], "B's gating dep is A");
  assert.equal(typeof b.progress, "number");
  assert.equal(typeof b.durationDays, "number");

  // A closed item reports 100% progress.
  const a = items.find((i) => i.id === "A");
  assert.equal(a.progress, 100, "closed item is 100% complete");
});

test("renderJson excludes non-gating dependency kinds from deps", () => {
  const items = [
    { id: "X", title: "X", status: "open", estimated_minutes: 480, dependencies: [
      { id: "Y", kind: "blocked_by" },
      { id: "Z", kind: "related" },
    ] },
    { id: "Y", title: "Y", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "Z", title: "Z", status: "open", estimated_minutes: 480, dependencies: [] },
  ] as any[];
  const opts = resolveGanttOptions({ schedule: true, from: "2026-06-01", weeks: "12" });
  const rows = buildRows(items, opts, opts.windowStart);
  const x = (JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones)).items as any[]).find((i) => i.id === "X");
  assert.deepEqual(x.deps, ["Y"], "only the blocking dep is listed; related is excluded");
});

test("renderJson surfaces milestones and is deterministic (no wall-clock)", () => {
  const opts = resolveGanttOptions({
    schedule: true,
    from: "2026-06-01",
    weeks: "12",
    milestones: "v1.0=2026-06-30",
  });
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const first = renderJson(rows, opts, opts.windowStart, opts.milestones);
  const second = renderJson(rows, opts, opts.windowStart, opts.milestones);
  assert.equal(first, second, "identical input yields byte-identical output");

  const parsed = JSON.parse(first);
  assert.deepEqual(parsed.milestones, [{ name: "v1.0", date: "2026-06-30" }]);
});

test("renderJson output round-trips through JSON.parse (valid JSON)", () => {
  const opts = resolveGanttOptions({});
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  assert.doesNotThrow(() => JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones)));
});
