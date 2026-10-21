# Public tracker validation

Source: [unbraind/pm-gantt-chart](https://github.com/unbraind/pm-gantt-chart)
at `80717afb81f1b7ee6e435cfcd02a5f76746097d4` (`origin/main`, 2026-10-21).
Only the committed public `.agents/pm` tree was exported into a fresh non-git
directory. Durable files were read-only. The pinned SDK certified a full,
strict, all-status, unbounded list before calculation; the source tracker was
never modified. No raw tracker bodies are reproduced here.

| Measurement | Result |
| --- | ---: |
| Certified items | 107 |
| Active items | 16 |
| Ordering edges | 0 |
| Fixed scenario | 2026-10-21 through 2026-12-31 |
| Baseline deadline violations | 1 |
| Explicit deferral offers | 1 |
| Candidate sets evaluated | 1 |
| Minimum moves / feasible proposals | 1 / 1 |
| Retained active items | 15 |
| Deferred effort / extra capacity | 120 minutes / 0 minutes per day |
| Recomputed completion | 2026-10-25 |
| Compact SDK JSON bytes | 384 |
| Compute-only sample | 4.59 ms |

The single expired public item was offered as a hypothetical scope deferral.
Independent `computeSchedule`/`computeSlack` recomputation confirmed that every
retained item met its own deadline and the scenario horizon. Offering that
same deferral while forbidding its item returned `no_allowed_repair`.
SHA-256 snapshots of durable item/settings/history bytes matched before and
after both queries. This measurement is one local sample, not a throughput
benchmark. With zero ordering edges in this public snapshot, dependency-chain
and custom-ordering acceptance comes from the targeted regression fixtures.

The no-git regression additionally installs the packed extension into a tracker
created by the SDK in a fresh plain directory, sets `GIT_CEILING_DIRECTORIES`,
and executes the actual CLI with only Node and the pinned pm executable on
`PATH`. JSON and TOON succeed; forbidden repair refusal exits 2. Durable tracker
hashes remain unchanged across installed CLI and source-handler invocations.

Behavioral revert proof: replace only the hypothetical capacity application in
`proposeDeadlineRepairs` with the unchanged item, keeping validation and the
public API intact. `node --test --test-name-pattern='capacity on a prerequisite'
test/deadline-repair.test.ts` fails (0 passed, 1 failed, exit 1) because the
baseline-only behavior returns `no_allowed_repair`. The implementation was
restored immediately. The regression imports source, so this proof does not
depend on stale compiled output.

## PR 164 deadline placement regression

Review thread `PRRT_kwDOSYpIas6u9Nrl` identified a false infeasibility when
an item's deadline follows the scenario horizon. The forward chart scheduler
waits until a reachable deadline, which is a placement preference rather than
a required start. Self-review found that simply clamping deadlines to the
horizon still delays a prerequisite until the last day and pushes its dependent
past the horizon. The same defect occurs with prerequisites whose deadlines
already fall inside the horizon.

Repair evaluation now removes both deadline aliases from copied forward-pass
inputs to compute earliest possible completion. The backward pass receives
original items and still enforces earlier real deadlines. This applies to both
the baseline and every hypothetical repair; chart rendering is unchanged.
Regressions cover canonical/legacy/timestamp late deadlines, prerequisites and
dependents with deadlines inside or beyond the horizon, an actual capacity
repair, affected ids, input immutability, and earlier deadlines that still refuse.

Behavioral revert proof for this review: restored only `repairSchedule` to its
pre-review implementation, leaving all tests and other functions unchanged.
`node --test --test-name-pattern='post-horizon|deadline placement|late deadlines'
test/deadline-repair.test.ts` failed all 3 tests (0 passed, exit 1), each with
`no_allowed_repair` in a feasible case. Restoring the fix passed 3/3 (exit 0).
The PM-linked repair/scheduler/activation run passed 94/94, including the real
non-git installed CLI and unchanged durable tracker bytes. Local typecheck,
test typecheck, lint and the committed distribution rebuild passed. Full npm
and Bun release gates remain CI evidence at unchanged thresholds.
