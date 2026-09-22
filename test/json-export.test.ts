import assert from "node:assert/strict";
import test from "node:test";

import type { PmItem } from "../index.ts";
import { chainItems } from "./chain-items.ts";
import {
  buildRows,
  resolveGanttOptions,
  renderJson,
} from "../index.ts";

/** Per-item payload `renderJson` emits (see renderJson in index.ts). */
interface JsonExportItem {
  id: string;
  group: string;
  status: string;
  start: string | null;
  end: string | null;
  durationDays: number | null;
  progress: number;
  critical: boolean;
  deps: string[];
}

/** Parse the per-item array a `renderJson` payload carries. */
function parseJsonItems(rendered: string): JsonExportItem[] {
  return (JSON.parse(rendered) as { items: JsonExportItem[] }).items;
}

/** Resolve the standard scheduled-sprint options shared by multiple JSON export tests. */
function scheduledSprintOpts(): ReturnType<typeof resolveGanttOptions> {
  return resolveGanttOptions({ schedule: true, "group-by": "sprint", weeks: "12", from: "2026-06-01" });
}

/** Assert that item X's gating deps list contains only Y, given X's first dep. */
function assertXGatingDeps(firstDep: NonNullable<PmItem["dependencies"]>[number], message: string): void {
  const items: PmItem[] = [
    { id: "X", title: "X", status: "open", estimated_minutes: 480, dependencies: [firstDep, { id: "Z", kind: "related" }] },
    { id: "Y", title: "Y", status: "open", estimated_minutes: 480, dependencies: [] },
    { id: "Z", title: "Z", status: "open", estimated_minutes: 480, dependencies: [] },
  ];
  const opts = resolveGanttOptions({ schedule: true, from: "2026-06-01", weeks: "12" });
  const rows = buildRows(items, opts, opts.windowStart);
  const x = parseJsonItems(renderJson(rows, opts, opts.windowStart, opts.milestones)).find((i) => i.id === "X");
  assert.deepEqual(x!.deps, ["Y"], message);
}

// Same deterministic A -> B -> C chain (+ isolated D) used by scheduler.test.ts.
test("renderJson emits a structured schedule with window, options, summary and items", () => {
  const opts = scheduledSprintOpts();
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
  const opts = scheduledSprintOpts();
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const items = parseJsonItems(renderJson(rows, opts, opts.windowStart, opts.milestones));

  const b = items.find((i) => i.id === "B");
  assert.ok(b, "B present");
  assert.equal(b.group, "S1");
  assert.equal(b.status, "in_progress");
  assert.match(b.start!, /^\d{4}-\d{2}-\d{2}$/, "ISO start");
  assert.match(b.end!, /^\d{4}-\d{2}-\d{2}$/, "ISO end");
  assert.deepEqual(b.deps, ["A"], "B's gating dep is A");
  assert.equal(typeof b.progress, "number");
  assert.equal(typeof b.durationDays, "number");

  // A closed item reports 100% progress.
  const a = items.find((i) => i.id === "A");
  assert.equal(a!.progress, 100, "closed item is 100% complete");
});

test("renderJson excludes non-gating dependency kinds from deps", () => {
  assertXGatingDeps({ id: "Y", kind: "blocked_by" }, "only the blocking dep is listed; related is excluded");
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

test("renderJson summary.criticalPathLength matches the count of critical items", () => {
  // --schedule populates slackDays so the slack==0 critical predicate is exercised.
  const opts = scheduledSprintOpts();
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  const parsed = JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones));
  const criticalItems = (JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones)) as { items: JsonExportItem[] }).items.filter((i) => i.critical).length;
  assert.equal(
    parsed.summary.criticalPathLength,
    criticalItems,
    "summary count and per-item critical flags must agree within one payload",
  );
});

test("renderJson output round-trips through JSON.parse (valid JSON)", () => {
  const opts = resolveGanttOptions({});
  const rows = buildRows(chainItems(), opts, opts.windowStart);
  assert.doesNotThrow(() => JSON.parse(renderJson(rows, opts, opts.windowStart, opts.milestones)));
});

test("renderJson includes a gating dep with undefined kind in the deps array", () => {
  // A dependency without an explicit `kind` defaults to "blocked_by" (via ??),
  // so it must appear in the gating deps list. A "related" dep must not.
  assertXGatingDeps({ id: "Y" }, "undefined-kind dep is gating; related is excluded");
});
