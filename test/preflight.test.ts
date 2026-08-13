import assert from "node:assert/strict";
import test from "node:test";

import { detectCycles, dataSanityReport, computeSchedule, computeCriticalPath, computeSlack } from "../index.ts";

// Minimal item shape for the data-sanity helpers.
function item(id: string, opts: Partial<any> = {}): any {
  return { id, title: opts.title ?? id, status: "open", ...opts };
}

function dep(id: string) {
  return { id };
}

test("detectCycles: clean DAG has no cycles", () => {
  const items = [
    item("A", { dependencies: [dep("B")] }),
    item("B", { dependencies: [dep("C")] }),
    item("C"),
  ];
  assert.deepStrictEqual(detectCycles(items), []);
});

test("detectCycles: direct 2-cycle is reported once", () => {
  const items = [
    item("A", { title: "Login", dependencies: [dep("B")] }),
    item("B", { title: "API", dependencies: [dep("A")] }),
  ];
  const cycles = detectCycles(items);
  assert.strictEqual(cycles.length, 1, "exactly one distinct cycle");
  assert.match(cycles[0], /A "Login"/);
  assert.match(cycles[0], /B "API"/);
});

test("detectCycles: a symmetric annotation edge is not a scheduling cycle", () => {
  // `related` is symmetric — pm records the edge on BOTH items — so every
  // mutually-related pair looked like a two-node cycle to a detector that did
  // not filter by kind. On the companion's real 664-item tracker that produced
  // four "fatal dependency cycles" and `pm gantt` refused to run at all, none
  // of them an ordering. `related_to` is the same concept under the spelling
  // real trackers also emit, and it was missing from the non-gating set.
  for (const kind of ["related", "related_to", "relates_to", "duplicate", "duplicate_of", "discovered_from", "supersedes", "verifies", "parent", "child"]) {
    const items = [
      item("A", { title: "Arch", dependencies: [{ id: "B", kind }] }),
      item("B", { title: "Gate", dependencies: [{ id: "A", kind }] }),
    ];
    assert.deepStrictEqual(detectCycles(items), [], `${kind} annotates a relationship and must not order the work`);
  }
});

test("every dependency traversal shares one gating predicate, so the graph is read the same way throughout", () => {
  // The predicate was applied to detectCycles and gatingDepIds and NOT to
  // computeCriticalPath, computeSchedule or computeSlack, which each kept their
  // own narrower filter. So `related_to`, `parent`, `child` and `supersedes`
  // were excluded from cycle detection and the JSON export while still ordering
  // the work — one command interpreting the same graph two ways. This asserts
  // the interpretations agree, for every non-gating kind.
  const anchor = new Date("2026-06-01T00:00:00");
  // A is deliberately SHORTER than B. That asymmetry is what makes slack a real
  // discriminator: when the edge does not gate, A and B both start at the anchor
  // and the project ends when the longer B ends, so the shorter A can slip —
  // positive slack. When the edge gates, A→B is the only chain, so A ends the
  // project through B and cannot slip at all — zero slack. A computeSlack that
  // ignored the predicate would report the gated answer for annotation edges.
  for (const kind of ["related", "related_to", "relates_to", "duplicate", "duplicate_of", "discovered_from", "supersedes", "verifies", "parent", "child"]) {
    const items: any[] = [
      item("A", { title: "A", estimated_minutes: 480, dependencies: [] }),
      item("B", { title: "B", estimated_minutes: 2400, dependencies: [{ id: "A", kind }] }),
    ];
    // Scheduling: an annotation edge must not push B after A.
    const sched = computeSchedule(items, anchor, 1);
    assert.equal(sched.get("B")!.start.getTime(), anchor.getTime(), `${kind} must not order the work in computeSchedule`);
    // Critical path: an annotation edge must not build a two-item chain.
    assert.equal(computeCriticalPath(items).size, 0, `${kind} must not form a critical path`);
    // Slack: with no ordering, the shorter A floats inside B's longer span.
    assert.ok(
      computeSlack(items, sched).get("A")!.slackDays > 0,
      `${kind} must not consume A's slack in computeSlack`,
    );
  }
  // The gating control: blocked_by still does all three.
  const gated: any[] = [
    item("A", { title: "A", estimated_minutes: 480, dependencies: [] }),
    item("B", { title: "B", estimated_minutes: 2400, dependencies: [{ id: "A", kind: "blocked_by" }] }),
  ];
  const gatedSched = computeSchedule(gated, anchor, 1);
  assert.ok(gatedSched.get("B")!.start.getTime() > anchor.getTime(), "blocked_by must still order the work");
  assert.equal(computeCriticalPath(gated).size, 2, "blocked_by must still form the critical path");
  assert.equal(computeSlack(gated, gatedSched).get("A")!.slackDays, 0, "blocked_by must still make A critical in computeSlack");
});

test("detectCycles: a gating cycle is still reported when annotation edges are present alongside it", () => {
  // The filter must not become a way to hide a real cycle: an item carrying
  // both a `related` edge and a genuine `blocked_by` cycle must still fail.
  const items = [
    item("A", { title: "Login", dependencies: [{ id: "B", kind: "related" }, { id: "C", kind: "blocked_by" }] }),
    item("B", { title: "Docs" }),
    item("C", { title: "API", dependencies: [{ id: "A", kind: "blocked_by" }] }),
  ];
  const cycles = detectCycles(items);
  assert.strictEqual(cycles.length, 1, "the blocked_by cycle must survive the annotation filter");
  assert.match(cycles[0], /A "Login"/);
  assert.match(cycles[0], /C "API"/);
});

test("detectCycles: self-loop is a cycle", () => {
  const cycles = detectCycles([item("A", { dependencies: [dep("A")] })]);
  assert.strictEqual(cycles.length, 1);
});

test("detectCycles: dangling deps are ignored (not a cycle)", () => {
  const items = [item("A", { dependencies: [dep("GHOST")] })];
  assert.deepStrictEqual(detectCycles(items), []);
});

test("dataSanityReport: cycle is fatal", () => {
  const items = [
    item("A", { dependencies: [dep("B")] }),
    item("B", { dependencies: [dep("A")] }),
  ];
  const r = dataSanityReport(items);
  assert.strictEqual(r.fatal.length, 1);
  assert.match(r.fatal[0], /dependency cycle/);
  assert.strictEqual(r.warnings.length, 0);
});

test("dataSanityReport: deadline-before-start warns, does not fail", () => {
  const items = [
    item("A", { created_at: "2026-06-10", deadline: "2026-06-01" }),
  ];
  const r = dataSanityReport(items);
  assert.strictEqual(r.fatal.length, 0);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /deadline .* is before its start/);
});

test("dataSanityReport: absurd estimate warns, does not fail", () => {
  const items = [
    item("A", { estimated_minutes: 9_999_999 }),
  ];
  const r = dataSanityReport(items);
  assert.strictEqual(r.fatal.length, 0);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /implausibly large/);
});

test("dataSanityReport: normal valid data is clean", () => {
  const items = [
    item("A", { created_at: "2026-06-01", deadline: "2026-06-15", estimated_minutes: 480, dependencies: [dep("B")] }),
    item("B", { created_at: "2026-06-01", deadline: "2026-06-10", estimated_minutes: 240 }),
  ];
  const r = dataSanityReport(items);
  assert.deepStrictEqual(r.fatal, []);
  assert.deepStrictEqual(r.warnings, []);
});
