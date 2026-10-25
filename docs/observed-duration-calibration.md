# Observed-duration calibration

```sh
pm gantt calibrate --type Task --tag maintenance --minimum-samples 10
pm gantt calibrate --type Task --tag maintenance --minimum-samples 10 --json
```

The required sample minimum is a caller decision, with no hidden fallback. The
exact, case-sensitive current type and optional tag select the cohort. All
statuses are included. The start snapshot must also match that class. The command
uses SDK complete-corpus certification, history verification against the current
item, and verified replay/patch primitives. It never infers execution from
creation dates, titles, deadlines, imported status snapshots or checkpoints.

A sample is one item's first recorded `update` transition into `in_progress`,
followed by a recorded `close`/`update` transition into `closed`. The estimate is
read at that start, before later estimate changes. Completion uses the closing
snapshot's `completed_at`, then `closed_at`, then the transition timestamp for
legacy histories. UTC elapsed calendar minutes include blocking, waiting and
nonworking time. They are **not measured labor effort**. Durations must be within
0..175200 minutes, the scenario sampler's supported range; the start estimate
must be finite and positive.

An item that was canceled or reopened at any point is excluded in full, including
its earlier completed episode. Reopened takes precedence over canceled in the
mutually exclusive exclusion counts. Incomplete work, missing starts, missing
estimates, classification changes, invalid durations and unverifiable history
have separate counts. Malformed foreign history is skipped with a reason. No
history is repaired. Compaction may remove start evidence and reduce the sample.
No lifetime-total history completeness claim is made.

The result includes counts, at most 20 diagnostic rows by default (`--limit`
1..200), and an explicit complete empirical population. `truncated` refers only
to diagnostics. Each sample has equal weight; duplicates of the same numeric
value retain their frequency. Quantiles use nearest rank, `ceil(q*n)-1`, with
q=0 selecting the minimum. Planned, elapsed and per-item elapsed/planned ratio
quantiles are **separate marginal summaries**, not paired rows. Input hashes use
canonical item order and history snapshots; no wall-clock timestamp, title, body
or local path appears in the output. Repeating a fixed corpus is deterministic.

## SDK example and explicit future scenario

```ts
import { calibrateObservedDurations, completionIntervals } from "pm-gantt-chart";

const calibrated = await calibrateObservedDurations(".agents/pm", {
  type: "Task", tag: "maintenance", minimumSamples: 10,
  quantiles: [0.1, 0.5, 0.9], limit: 5,
});
if (!calibrated.ok) {
  console.log(calibrated.code, calibrated.remedy, calibrated.evidence);
} else {
  const future = [{ id: "future", title: "Hypothetical maintenance", status: "open" as const }];
  const scenario = completionIntervals(future, {
    from: "2026-11-01", seed: 42, samples: 2000,
    // Explicit elapsed-calendar interpretation, including nights/weekends.
    minutesPerDay: 1440,
    estimates: { future: calibrated.distribution },
  });
  console.log(scenario);
}
```

`{kind: "empirical", values: [...]}` is accepted by `UncertainEstimate` and the
uncertainty CLI's estimate JSON map. Values are finite minutes in 0..175200,
1..2000 entries, sorted canonically without changing their relative weights.
Scenario sampling draws uniformly with replacement using the existing seeded
sampler. Its finite simulation quantiles may differ from population quantiles.
Use 1440 minutes/day explicitly when adopting calendar durations; the usual
480 effort-minutes/day default has a different meaning. Mixing effort and
calendar assumptions requires the caller's explicit modeling decision.

No causal productivity, confidence interval, staffing or calibrated probability
guarantee follows from this selected historical sample. Historical selection and
small samples can bias a future scenario. Existing estimates are never replaced.
`gantt uncertainty` still evaluates declared scenario inputs; `brief momentum`
remains a throughput/cycle-time summary.

## Refusals and bounds

| Code | Remedy |
| --- | --- |
| `invalid_calibration` | Supply exact type, optional nonblank tag, minimum 1..2000, limit 1..200 and increasing SDK quantiles (1..9 probabilities in [0,1]). |
| `insufficient_samples` | Inspect exclusion counts, collect verified starts/completions and estimates, or deliberately choose another evidence floor. No distribution or quantiles are returned. |
| `calibration_too_large` | Narrow the cohort: at most 2000 selected items, 10000 history entries per item, 100000 entries total. Preserve original histories. |
| `corpus_unavailable` | Restore tracker readability and complete SDK reads; retry a stable copy. |
| `tracker_changed` | Retry on a stable tracker or read-only copy. |

The CLI returns nonzero usage refusals with `code`, `remedy` and host
`remediation`; default TOON and `--json` share the same typed result. The command
requires no git, lock, journal, checkpoint, outbox, import or sync path. It writes
no tracker state. Second SDK corpus/history reads reject observed competing
revisions. A returned receipt describes the observed snapshot, not a lease on
future changes. Tests inject a real competing SDK transition at every observed
read boundary and preserve the peer's state.

## Validation

`node --test test/calibration.test.ts` exercises a seeded 500-sequence lifecycle
model (seed 20261025), including old-input replays, CRLF/whitespace, relationships,
all calibration input fields, SDK state readback and preservation. The package
has no item importer or synchronization path to round-trip: its registered
exporter is a read-only schedule projection. Calibration adds no persistent
idempotency key or journaled plan. Existing resource selection remains separate.

`node test/validate-calibration.ts origin/main` copies only committed public
tracker data into a non-git scratch project, removes git from PATH, runs each
cohort twice, and checks durable tracker hashes before/after. Original tracker
files are never mutated. Measured counts and gate results are reported in the PR.
