# Repair a deadline with explicit capacity

Given `task-a` (960 estimated minutes) followed by `task-b` (480 minutes), a
start of 2026-10-21 and a fixed deadline of 2026-10-22 are infeasible: baseline
completion is 2026-10-23. Offer an additional 480 minutes/day dedicated to A:

```sh
pm gantt repair --from 2026-10-21 --deadline 2026-10-22 \
  --capacity task-a=960 --json
```

The result contains one minimum move:

```json
{
  "moves": [{
    "kind": "capacity_shift", "itemId": "task-a",
    "beforeDays": 2, "afterDays": 1,
    "minutesPerDay": 960, "addedMinutesPerDay": 480
  }],
  "affectedIds": ["task-a", "task-b"],
  "finish": "2026-10-22", "retainedCount": 2,
  "deferredMinutes": 0, "addedMinutesPerDay": 480
}
```

The same calculation is available without a tracker or git:

```ts
import { proposeDeadlineRepairs, type PmItem } from "pm-gantt-chart";

const items: PmItem[] = [
  { id: "task-a", title: "Implementation", status: "open", estimated_minutes: 960 },
  { id: "task-b", title: "Validation", status: "open", estimated_minutes: 480,
    dependencies: [{ id: "task-a", kind: "blocked_by" }] },
];
const result = proposeDeadlineRepairs(items, {
  from: "2026-10-21", deadline: "2026-10-22",
  capacityShifts: [{ itemId: "task-a", minutesPerDay: 960 }],
});
if (!result.ok) console.error(result.code, result.remedy);
else console.log(result.proposals);
```

Adding `--forbid task-a` excludes this move and produces `no_allowed_repair`
with a remedy and exit 2. Offering `--defer task-a` alone also fails: B still
needs A. Offering both A and B as deferrable is permitted only if some other
active work remains; each deferred item counts as one move. Deferral removes
work from the hypothetical scenario, never dependency rows from the tracker.

Capacity offers keep effort constant and assume independently available daily
capacity; confirm staffing before selecting a proposal. All retained work must
fit the horizon and its own existing deadlines. No result automatically changes
the plan. Store a selected proposal through core `plan decision` if desired.
