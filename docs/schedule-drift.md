# Explain schedule drift

Save two **input snapshots** with `pm gantt snapshot`, then compare them with
`pm gantt drift`. Dates are replayed with the existing resource scenario engine;
saved computed dates are never trusted as scheduling evidence. These operations
read the tracker and files; they do not apply schedules or import tracker state.

For two tasks `build` and `ship`, where `ship` is blocked by `build`, give each
an assignee and a 480 minute estimate. Save these controls as `resources.json`:

```json
{
  "from": "2026-10-19",
  "through": "2026-10-30",
  "timeZone": "UTC",
  "scenarios": [{
    "id": "reviewed",
    "owners": {
      "builder": {"weekdays":[1,2,3,4,5],"holidays":[],"minutesPerDay":480,"minutesPerWeek":2400,"totalMinutes":4800},
      "shipper": {"weekdays":[1,2,3,4,5],"holidays":[],"minutesPerDay":480,"minutesPerWeek":2400,"totalMinutes":4800}
    }
  }]
}
```

With `build` assigned to `builder` and `ship` to `shipper`:

```sh
pm gantt snapshot --scenarios resources.json --json > before.json
# After the reviewed estimate of build becomes 960 minutes:
pm gantt snapshot --scenarios resources.json --json > after.json
pm gantt drift --before before.json --after after.json --limit 10
pm gantt drift --before before.json --after after.json --json
```

`ship` moves from October 20 to October 21: `deltaDays: 1`, with a cause chain
`[build, ship]`. The `estimate` change identifies `build`, before=480 and
after=960. Reverting that estimate alone in the later scenario restores October
20; the witness records `restoredFinish` and `effectDays: 1`. Weekends, holidays,
daily/weekly/total capacity and shared owners use the same deterministic,
preemptible, civil-day allocator as `gantt resources`. Its stable-id heuristic is
reproducible, not an optimal schedule claim.

## Reading the result

- `before` / `after` are semantic SHA-256 references to the supplied snapshots.
  Dictionary, task, prerequisite, weekday and holiday ordering do not change them.
- `changes` lists reversible estimate, owner, prerequisite and calendar edits,
  with the old and new values. Effort/owner overrides are resolved at capture.
- `moved` reports changed **finish dates**, exact integer civil-day `deltaDays`,
  individual reversal witnesses and their routes. Routes prefer prerequisite
  chains, then allow shared-owner contention in either saved scenario. A missing route stays unattributed.
- `unchanged` collapses unchanged computed finish dates to ids plus the earlier
  snapshot reference. Terminal items have no computed resource-engine row.
- `gaps` preserves missing work, incomplete graphs, unknown status roles,
  unsupported scope/role/horizon changes and observational deadline edits.
  Per-row gaps retain unfinished dates and effects without an individual witness.
  A malformed snapshot refuses; semantically unsupported scheduling evidence
  returns explicit gaps with remedies and never invented causes.

Effects are **individual counterfactuals**, not additive contributions: each
replay restores one earlier input while keeping every other later input fixed.
Two interacting edits can mask each other, or individually over-explain a delta.
Do not sum `effectDays` or interpret the list as an exhaustive minimal causal set.
Scope, status-role, horizon or zone differences suppress all attribution; a
changed deadline is observational in this engine and cannot be a cause.
Unknown statuses are retained as gaps rather than treated as active or done.
Status meanings come from the tracker's SDK registry roles at capture time,
including custom active and terminal statuses. Snapshots are local evidence,
not signed attestations of a third party's role/graph declarations.

Null finish dates mean the bounded allocator did not finish. Their deltas stay
null. A capacity witness can prove a capacity shortfall; a heuristic's exhaustion
cannot prove no feasible ordering exists. Missing estimates/owners are never
filled by default. Explicit scenario work overrides remain visible saved inputs.
The package never changes item deadlines, estimates, relationships or statuses.

## SDK

```ts
import { PmClient, certifyCompleteListResult, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { captureScheduleScenario, explainScheduleDrift, validateScheduleSnapshot } from "pm-gantt-chart";

const sdk = new PmClient({ pmRoot });
const items = certifyCompleteListResult(await sdk.listAllComplete()).items;
const registry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
const captured = captureScheduleScenario(items, controls, registry, resolvedPrerequisites);
if (!captured.ok) throw new Error(captured.remedy);
const imported = validateScheduleSnapshot(JSON.parse(savedJson));
if (!imported.ok) throw new Error(imported.remedy);
const report = explainScheduleDrift(imported.value, captured.snapshot, { limit: 20 });
```

`resolvedPrerequisites` is the existing `PrerequisiteGraph`, obtained with the
package's registry-aware graph adapter. Supply the complete corpus and complete
resolved graph for custom relationship ordering. Omitting the graph uses the
existing built-in adapter. The CLI resolves configured relationship contracts
and certified complete reads itself. SDK acquisition uses public SDK exports and
the existing host context; no launcher-path or global-symlink resolution is used.

The CLI accepts either a bare `ScheduleSnapshot` or the `gantt snapshot --json`
envelope. Save with JSON and unbounded host output controls for larger corpora;
TOON is the compact human/agent report transport, not a JSON snapshot file.
Capture requires exactly one explicit alternative. `version: 1` snapshots contain
only ids, native statuses, resolved roles, effective owners/effort, resolved
prerequisites, observational deadlines, horizon/zone and calendars. They exclude
item titles, bodies, comments and tracker location. They contain no live target
revision, mutation plan or replay/idempotency key because nothing is applied.

## Bounds, validation and recovery

All saved inputs and producer outputs use one shared strict duration schema:
dense own-index arrays, closed scheduling objects, finite integer minute budgets,
real ISO dates, explicit time zone and no coercion of structured values. Bounds
are inherited from resource scenarios: 2000 corpus items, 200 active tasks,
5000 ordering edges, 50 owners, at most 366 inclusive days; task effort
0..175200, daily budget 0..1440, weekly 0..10080, total 0..527040 minutes.
At most 32 reversible edits are compared (34 engine evaluations). `--limit` is
1..200, default 20; it limits moved output rows, never the evaluated graph.
Unchanged references and exact totals survive truncation. Each input file must
be regular JSON at most 256 KiB. Output numbers are validated before success. Date deltas span at most +/-3652424 civil days (the four-digit ISO date domain); individual effects stay within +/-366 days.
Typed refusals contain `code`, `message`, `remedy`; CLI refusals exit 2.
`comparison_too_large` asks for intermediate snapshots; `invalid_scenario`
asks for one alternative or a complete graph; `invalid_estimate` identifies
malformed/bounded input. Gap remedies request the missing evidence explicitly.

No importer, export-to-tracker, sync, selection, journal, lease, checkpoint or
shared mutation state is introduced. Old snapshots can be replayed after later
tracker changes without modifying any tracker. The seeded model test runs 500
operation sequences across effort, owners, prerequisites, deadlines and native
statuses, reads state back through the real SDK, round-trips CRLF/whitespace JSON,
replays older evidence and randomizes SDK custom status registries. Separate
boundary tests fuzz extreme inputs and emitted numbers.

## Without git

Capture, comparison and SDK serialization work in ordinary non-git trackers.
Comparison needs only two files and does not acquire a tracker. Packed regression
acceptance removes git from PATH and sets a discovery ceiling. Public data
validation uses read-only archived tracker documents in a non-git scratch project;
see [measured validation](schedule-drift-validation.md).
