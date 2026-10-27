# Public tracker schedule-drift validation

Source: public `unbraind/pm-gantt-chart` main commit
`ce2cfea9d22c562bd5b4926e1707ddcf2c9339fd`. Reproduce with:

```sh
node test/validate-drift.ts ce2cfea9d22c562bd5b4926e1707ddcf2c9339fd
```

The validator archives only the public tracker, marks its documents read-only,
loads a certified complete corpus through the SDK in a non-git scratch project,
captures both scenarios, JSON round-trips them through the producer's schema,
compares twice and verifies the durable source content hash remains unchanged.
It never edits a canonical tracker or uses hosted data.

| Measurement | Result |
| --- | ---: |
| Complete corpus | 117 items |
| Active items, resolved through SDK roles | 8 |
| Recorded relationships | 9 |
| Active items missing estimates | 5 |
| Active items missing assignees | 8 |
| Changed estimate | 60 to 540 minutes |
| Moved computed goal dates | 8 |
| Returned moved rows | 3 |
| Unchanged active finishes | 0 |
| Gaps | 0 |
| Engine evaluations | 3 |
| Returned exact date deltas | 4, 4, 1 civil days |
| Compact JSON | 1,160 bytes |
| TOON | 1,221 bytes |
| Saved snapshot envelope | 10,906 bytes |
| Deterministic replay / durable source unchanged | Both verified |

The change targets `pm-gantt-chart-1j46`. Recorded owners and effort are retained;
missing owners are **explicitly** assigned to a hypothetical shared pool, and
missing estimates are **explicitly** set to 480 minutes by scenario overrides.
Calendars use Monday through Friday, a holiday on October 26, 480 minutes per
day, 2400 per week, 50000 total, a Vienna civil zone and the inclusive horizon
October 23 through December 1. These are hypothetical planning assumptions,
not inferred facts about the project's staffing or actual completion dates.
The 4-day movements include the weekend and holiday; the other returned goal
moves by 1 civil day under the same shared-capacity allocator. Every returned
row has a counterfactual witness and causal route. A row limit of 3 preserves the
measured total of 8 moved goals and marks the report truncated.

Targeted regression evidence lives in `test/drift.test.ts`: exact estimate and
prerequisite chains, resource contention, calendars, reassignment, unchanged
references, unsupported inputs, strict-schema numeric input/output fuzz,
500 seeded SDK-state operation sequences, old-input replays, CRLF/whitespace
transports, custom SDK status registries, ambient focus and a real packed CLI
with git removed from PATH. The model compares captured state read back through
the SDK against an independent field model; it does not normalize expected
values by hand. No tracker import, sync or schedule-application path is added.

`node test/revert-drift.ts` restores the comparison's unsupported baseline,
removes counterfactual replays, removes unchanged-reference collapse and replaces
SDK roles with name guessing in turn. Each behavioral regression must fail;
original source bytes are restored after each check. Tests import TypeScript
source directly, so stale compiled output cannot satisfy those proofs.

The packed release acceptance matrix executes snapshot/drift with project-local
npm/npx and Bun/bunx hosts, the minimum supported host, and isolated npm-global
and Bun-global installations. Full npm and Bun release gate run URLs and exact
suite counts are recorded in the PR after CI completes. Local work uses targeted
tests, typecheck, lint, docstrings and duplication checks to limit host CPU load.
