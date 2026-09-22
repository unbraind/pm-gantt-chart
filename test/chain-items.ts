/**
 * Shared fixtures for the pm-gantt-chart test suite.
 *
 * @packageDocumentation
 */
import type { PmItem } from "../index.ts";

/**
 * A small, deterministic project: A -> B -> C chain plus an isolated item.
 *
 *   A (Design)      estimate 480m  = 1 working day
 *   B (Build)       estimate 960m  = 2 working days, blocked_by A
 *   C (Integration) estimate 720m  = 2 working days, blocked_by B
 *   D (Docs)        estimate 480m  = 1 working day, no deps, deadline far out
 */
export function chainItems(): PmItem[] {
  return [
    { id: "A", title: "Design API", status: "closed", estimated_minutes: 480, sprint: "S1", dependencies: [] },
    { id: "B", title: "Build endpoint", status: "in_progress", estimated_minutes: 960, sprint: "S1", dependencies: [{ id: "A", kind: "blocked_by" }] },
    { id: "C", title: "Integration tests", status: "open", estimated_minutes: 720, sprint: "S2", dependencies: [{ id: "B", kind: "blocked_by" }] },
    { id: "D", title: "Write docs", status: "open", estimated_minutes: 480, sprint: "S2", dependencies: [] },
  ];
}

/** An item with dates entirely before a 2026 window (off-window "before"). */
export function pastDatedItem(): PmItem {
  return { id: "P", title: "Past", status: "open", created_at: "2020-01-01", deadline: "2020-01-08", sprint: "S1", dependencies: [] };
}

/** An item with dates entirely after a 2026 window (off-window "after"). */
export function futureDatedItem(): PmItem {
  return { id: "F", title: "Future", status: "open", created_at: "2030-01-01", deadline: "2030-01-08", sprint: "S1", dependencies: [] };
}

/** An in-progress item with both created_at and deadline for progress-overlay tests. */
export function inProgressDatedItem(): PmItem {
  return { id: "A", title: "A", status: "in_progress", created_at: "2026-06-01", deadline: "2026-06-15", sprint: "S1", dependencies: [] };
}