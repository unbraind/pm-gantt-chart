import type { PmItem, ScheduleSnapshot } from "../index.ts";

/** Complete 2000-item corpus whose valid replay exceeds the old 256 KiB transport cap. */
export function wideScheduleCorpus(): PmItem[] {
  return Array.from({ length: 2000 }, (_, index) => ({ id: `item-${String(index).padStart(4, "0")}-${"x".repeat(110)}`,
    title: "Synthetic public replay fixture", status: index === 0 ? "open" : "closed",
    ...(index === 0 ? { assignee: "worker", estimated_minutes: 480 } : {}), dependencies: [] }));
}

/** Public snapshot evidence can include terminal context without inventing estimates for it. */
export function wideScheduleSnapshot(): ScheduleSnapshot {
  return { version: 1, from: "2026-10-19", through: "2026-10-30", timeZone: "UTC",
    owners: { worker: { weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [], minutesPerDay: 480, minutesPerWeek: 3360, totalMinutes: 10000 } },
    tasks: wideScheduleCorpus().map((item) => ({ id: item.id, status: item.status, role: item.status === "open" ? "active" : "terminal",
      ...(item.assignee === undefined ? {} : { owner: item.assignee, minutes: item.estimated_minutes }), prerequisites: [] })) };
}
