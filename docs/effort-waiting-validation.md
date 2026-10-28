# Effort/wait validation

Public source: pm-gantt-chart tracker at
`9d307c26e4956a5fa43c84546bb886e3cf58c7a9` (origin/main when work started).
`node test/validate-waiting.ts origin/main` archives only the public tracker into
a non-git scratch directory, makes its files read-only and runs the SDK preview
twice. Native fields and relationships read back through the SDK match the
initial corpus exactly, and the durable tracker digest stays unchanged.

| Measurement | Result |
| --- | ---: |
| Complete SDK corpus | 119 items |
| Nonterminal items by configured SDK roles | 9 |
| Explicit hypothetical waits | 2 |
| Missing native effort estimates | 6 |
| Known effort | 540 minutes |
| Total effort | unknown |
| Unknown completion bounds | 7 items |
| Returned diagnostic rows | 3 |
| Compact JSON | 1250 bytes |
| Two previews, including replay comparison | 7357 ms |

The first nonterminal item receives an explicitly hypothetical two-day wait;
the second receives an explicitly hypothetical unbounded wait. No effort,
ownership, status or relationship override fills missing native data. The final repeat took 2228 ms with identical counts and bytes. Timing on a
loaded host is not a scale/performance guarantee.

The focused `test/waiting.test.ts` suite checks the 120-minute effort plus
2880-minute wait example, independent and chained work, partial unknown bounds,
empty/zero/legacy estimates, contextual/custom/inverse ordering, 500 custom status
registries, malformed controls and extreme input/output numbers. Its seeded
model runs 500 native-operation/replay sequences on one real non-git SDK tracker,
with changing session focus, whitespace/CRLF text, ownership, estimates, statuses
and relationships. Native write results supply SDK-normalized reference values;
every preview is checked against an independent arithmetic model and complete
SDK state read-back, including every native field. Saved inputs are replayed
against current native state, and producer JSON must validate and round-trip.

The packed CLI test uses a git-free PATH and a real claim, checks TOON and JSON,
and compares native state and durable tracker digests. The packed acceptance
matrix exercises the two-hour/two-day example under npm and Bun local installs,
npx/bunx launchers, both global installations and the minimum supported SDK host.
The global consumers use CLI 2026.10.28; the development pin is unchanged.

`node test/revert-waiting.ts` mutates only a disposable copy: ignoring a declared
wait, replacing unknown upper bounds with zero, and classifying terminal work by
its name each fail the relevant regression. Restoring the implementation passes
all three. The package worktree is never modified by the revert proof.

No new import, sync, journal, ownership write, outbox or shared mutable state is
introduced. Existing native tracker imports/exports are outside this preview's
contract. Read-only snapshots do not lock out peer writes or claim future
consistency: rerun a preview after a peer changes native inputs.
