# Reproducible scheduling uncertainty

Suppose `plan-build` precedes `plan-check`. The first task needs between one and
ten effort days, uniformly distributed; checking takes exactly one day. With
independent effort and 480 minutes per calendar day, the analytic project
P10/P50/P90 durations are 2.9/6.5/10.1 calendar days. Finishes count from the
exclusive UTC anchor, with no weekends, holidays or shared-resource constraint.

Create `estimates.json` (replace the ids with ids from your tracker):

```json
{
  "plan-build": [480, 4800],
  "plan-check": { "kind": "point", "minutes": 480 }
}
```

```sh
pm gantt uncertainty --from 2026-10-22 --seed 42 \
  --samples 10000 --estimates estimates.json --json > scenario.json
```

The synthetic regression reproduces these analytic quantiles within 0.12 day
and reports `plan-build` as the dominant estimate. A triangular estimate can
instead declare an optimistic minimum, most likely mode and pessimistic maximum:

```json
{ "plan-build": { "kind": "triangular", "min": 480, "mode": 960, "max": 4800 } }
```

An omitted override uses `estimated_minutes` as a fixed point, including zero.
When neither exists the item's completion is null with `unknown_estimate`;
downstream items have `unknown_prerequisite`. Any active unknown makes the
overall project completion unknown, even if some independent tasks remain known.
Closed/canceled prerequisites are already satisfied and consume no future time.
Draft, open, blocked and in-progress items are active remaining-work assumptions;
there is no inference of remaining effort from progress percentages.

Use the typed SDK directly:

```ts
import { completionIntervals, type PmItem } from "pm-gantt-chart";

const items: PmItem[] = [
  { id: "plan-build", title: "Build", status: "open" },
  { id: "plan-check", title: "Check", status: "open", estimated_minutes: 480,
    dependencies: [{ id: "plan-build", kind: "blocked_by" }] }
];
const result = completionIntervals(items, {
  from: "2026-10-22", seed: 42, samples: 10000,
  estimates: { "plan-build": [480, 4800] }
});
if (!result.ok) throw new Error(`${result.code}: ${result.remedy}`);
console.log(result.project, result.dominantEstimate);

// Replay only the declared receipt inputs, without reading a tracker.
const r = result.receipt;
const replay = completionIntervals(
  r.tasks.map(({ id }) => ({ id, title: id, status: "open" })),
  { from: r.from, seed: r.seed, samples: r.samples, quantiles: r.quantiles,
    minutesPerDay: r.minutesPerDay,
    estimates: Object.fromEntries(r.tasks.filter(t => t.estimate !== null)
      .map(t => [t.id, t.estimate!])) },
  new Map(r.tasks.map(t => [t.id, t.prerequisites]))
);
```

Save the whole receipt rather than just its hash. The hash identifies canonical
simulation inputs, not the tracker snapshot or a security signature. Items,
dependencies and sensitivity ties use locale-independent UTF-16 code-unit id
order; reordered source rows or different host locales do not change the samples.
The receipt's versioned `mulberry32-nearest-rank-v1` algorithm uses inverse-CDF draws
and nearest-rank empirical quantiles (q=0 returns the observed minimum). Fixed
effort consumes no random draw. Replaying with another output limit may change
the displayed rows, while the numerical scenario and input hash remain the same.

Sensitivity ranks absolute Pearson correlation of each nonconstant declared
estimate with project finish, breaking ties by id. This detects a wide estimate
controlling a chain, but correlation can miss nonlinear effects or distribute
association among competing parallel paths. No causal contribution percentage
or calibrated confidence guarantee is claimed. Constant finishes yield zero
correlations and no dominant estimate; an unknown project suppresses the ranking.

Neither SDK nor command writes items, history, estimates or scenario decisions.
The installed CLI is exercised in a real plain-directory tracker with a PATH
containing no git executable. Existing scheduling, repair and exports continue
to work independently of this uncertainty model.

## Public tracker validation

`node test/validate-uncertainty.ts origin/main` archives only the public committed
tracker into a non-git scratch directory and reads it with no git executable in
PATH. At public source commit `d999e65c104391bfcda4e891476c53efdd335de8`:

| Measurement | Result |
| --- | --- |
| Active items / active ordering edges | 18 / 0 |
| Missing estimates / unknown completions | 14 / 14 |
| Baseline project finish | Unknown |
| Explicit hypothetical scenario | First canonical active id: uniform 480..48000 minutes; other active ids: uniform 480..960 |
| Seed / samples | 42 / 10000 |
| Hypothetical project P10 / P50 / P90 | 10.894413 / 50.703685 / 89.778522 calendar days |
| Dominant estimate / Pearson correlation | `pm-gantt-chart-2u8i` / 0.9999986156 |
| Compact JSON bytes, including complete receipt | 9616 |
| Repeat / durable tracker documents | Identical / unchanged |

These ranges are explicit hypothetical assumptions, not estimates inferred from
the tracker. This corpus validates unknown handling and read-only integration;
the synthetic chain/fork and custom-kind tests validate dependency propagation.
The numerical input hash is
`ee5bbb16cea39f5d291a22e6acc432c76952f0601058c73540aa357b4277cea0`.
