# Resource-constrained schedule scenarios

`pm gantt resources --scenarios resources.json` compares explicit alternatives.
The default host output is compact TOON; append `--json` for structured JSON.
Every computation reads the complete tracker, certifies the SDK receipt and
uses registered relationship ordering. No git repository or executable is needed.

For two active items assigned to `builder`, each estimated at 480 minutes, save:

```json
{
  "from": "2026-10-23",
  "through": "2026-10-26",
  "timeZone": "Europe/Vienna",
  "limit": 20,
  "scenarios": [
    {
      "id": "normal",
      "owners": {
        "builder": {
          "weekdays": [1, 2, 3, 4, 5],
          "holidays": [],
          "minutesPerDay": 240,
          "minutesPerWeek": 1200,
          "totalMinutes": 2400
        }
      }
    },
    {
      "id": "extra-capacity",
      "owners": {
        "builder": {
          "weekdays": [1, 2, 3, 4, 5],
          "holidays": [],
          "minutesPerDay": 480,
          "minutesPerWeek": 2400,
          "totalMinutes": 4800
        }
      }
    }
  ]
}
```

`normal` has only 480 available minutes over Friday and Monday: its owner
witness reports required=960, available=480, deficit=480. `extra-capacity`
finishes the first item Friday and the second Monday. The weekend, including
Vienna's daylight-saving transition, consumes no work. A prerequisite finishing
Friday makes its successor eligible Monday. Unrelated owners run concurrently.

Dates are **civil dates in the declared IANA zone**, not timestamps. Every owner
in one comparison uses that zone; run separate comparisons for different zones.
No clock-hour shifts or conversion between owners' local shifts is implied.
The inclusive horizon is the hard completion constraint. Existing item deadlines
are revision-bound observational inputs; this command does not certify meeting
each item deadline. Work is preemptible in integer minutes, with stable item-id
priority and next-day prerequisite release. Week budgets reset Monday; total
limits apply across the horizon. Idle time consumes neither weekly nor total
budget. Holidays and non-working weekdays have zero capacity. Zero-minute work
still requires its predecessors to finish and consumes one dependency day.

`capacity_infeasible` includes owner bounds proving demand exceeds available
horizon capacity. `allocation_exhausted` means this deterministic heuristic did
not finish; it does **not** prove no alternative ordering could work. There is no
claim of optimality, individual deadline feasibility or fractional-day sequencing.
`feasible` certifies this allocation finishes within the declared horizon.

An unassigned or unestimated task refuses with `missing_work`. A scenario may
explicitly override its work without editing the item:

```json
{"work":{"task-id":{"owner":"builder","minutes":480}}}
```

Add `work` alongside `id` and `owners` in that alternative. Every active item,
including active Plans, needs declared work and an owner calendar. Completed and
canceled prerequisites are satisfied. Missing references, duplicate identities
and active ordering cycles refuse rather than inventing constraints. Every
declared relationship target must exist in the corpus, including forward edges
that a prerequisite adapter could otherwise omit. Non-string horizon values
return `invalid_scenario` without invoking conversion hooks.

The package requires pm CLI 2026.10.20 or newer: the old 2026.10.6
SDK transaction contract does not expose the locked target match guard. The
development SDK dependency remains pinned at 2026.10.20.

## Explicit selection and revision checks

First review the computation. Copy its source `revision`, the chosen scenario's
`id` and `selection` token, and the target item's `updated_at` from
`pm get target-id --full --json`. Then:

```sh
pm gantt resources --scenarios resources.json \
  --select extra-capacity --selection REVIEWED_SELECTION_TOKEN \
  --expect-revision REVIEWED_SOURCE_REVISION \
  --target target-id --target-revision REVIEWED_UPDATED_AT --json
```

Any selection flag requires **all five** values. The command freshly reads and
recomputes the scenarios; changed scheduling inputs or changed controls invalidate
reviewed tokens. It refuses infeasible selections. The core SDK transaction
checks the target's `updated_at` while holding its item lock and appends a note
with the scenario token, source revision and assumptions. It preserves dates,
estimates, dependencies and append-only history. Exact retries are idempotent;
there is no date-application mode. A source revision identifies the certified
read snapshot, not a permanent lock on all source work. Later source edits need
a fresh review. Core ownership, schema and mutation policy remain authoritative.

SDK consumers use `resourceScenarios(items, options, graph?)` and
`applyResourceSelection(pmRoot, author, freshResult, selection)`. Supply a complete
corpus; the optional graph is the package's registry-aware `PrerequisiteGraph`.
Before applying, SDK callers must obtain a fresh certified read and recompute.
The CLI performs that step automatically. Treat an SDK result as trusted local
computation, not an untrusted deserialized approval artifact.

## Bounds and refusal contract

At most 2000 corpus items, 200 active tasks, 5000 ordering edges, five alternatives,
50 owners per alternative and 366 inclusive days. The default row limit is 20
(maximum 200). Output always retains source revision, scenario tokens, total
item counts, truncation flags and every owner witness. It excludes item titles,
bodies and per-day allocation logs. SDK controls require explicit calendars and
integer minute limits: daily 0..1440, weekly 0..10080, total 0..527040, task effort
0..175200; weekdays use Monday=1 through Sunday=7. CLI input is a regular JSON
file of at most 256 KiB. Invalid dates/zones/calendars/overrides, incomplete graphs,
missing work, exceeded bounds and unsafe selections return typed `code`,
`message`, `remedy` refusals (CLI exit 2). Unexpected infrastructure errors remain
errors; the command does not turn them into a successful schedule.
