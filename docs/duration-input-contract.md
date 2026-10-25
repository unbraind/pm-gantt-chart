# Strict duration inputs

All forecast and calibration inputs use the single declarative contract in
`duration-input.ts`; this package has no external validation library. It covers
`completionIntervals`, `simulateCompletionIntervals`, `resourceScenarios`,
`computeResourceScenarios`, `proposeDeadlineRepairs`, `calibrateObservedDurations`,
their CLI flags/files, and native item effort/history fields read through the SDK.

Malformed input returns `invalid_estimate` with a remedy. This includes malformed
sampling/calibration controls previously labeled `invalid_scenario` or
`invalid_calibration`. Semantic graph, scope, missing-work, sample-minimum and
computational-budget refusals retain their distinct codes.

One request is capped at 1000000 schema steps (including union attempts), and
objects at 10000 own fields, so shared source arrays cannot create unbounded
validation products. Graph size and entries are captured with Map intrinsics
before child values are inspected.

Arrays must have every own index from zero through length minus one, without
accessors or extra keys. Inherited entries never fill holes. Each nested value is
checked; sparse empirical populations and quantile arrays cannot reach sampling.
Numbers must be finite, within declared bounds, and not negative zero. Estimates
used by forecasts are zero or 1/60..175200 minutes (one second through 120
calendar days); empirical populations contain 1..2000 samples. Quantiles
contain 1..9 strictly increasing probabilities in [0,1]. Zero effort and seed zero
remain valid. Zero denotes explicit no work; calibration excludes zero start
estimates. Denormals and positive sub-second values refuse. Legacy chart input
has the same one-second positive floor and a 10512000-minute ceiling (20
365-day years), retaining bounded data-sanity warnings without allowing
multi-century values; forecast bounds remain 175200 minutes. Dates reject calendar rollover; recorded history timestamps require
ISO timezone notation. Native civil deadlines retain the existing local-timestamp
semantics. Resource calendars, capacity/work overrides and repair controls use
their documented integer, size and date bounds.

Estimate variants and scenario/control objects are closed: extra keys refuse.
Native item and relationship records remain open for SDK metadata fields; the
fields consumed by forecasts are checked explicitly. CLI number/CSV decoding is
transport conversion only, followed by the same contract. Forecast CLI commands
read native values through the SDK, preserving negative zero from JSON Markdown
instead of silently normalizing it through a JSON subprocess round trip. Formats
such as TOON that decode `-0` to ordinary zero are interpreted according to the
SDK's decoded state.

Validation returns detached, frozen values and a module-owned receipt. Internal
CLI calculators require that receipt; forged objects refuse. Validation precedes
relationship queries and numerical work. Calculators consume validated data
without repeating ad hoc shape checks. Historical replay uses the same contract
for each verified revision; invalid stored input is never repaired.

`test/duration-input.test.ts` runs seed **179202610** with 2000 malformed SDK cases
across six forecast APIs and two guarded internal adapters, plus 2000 CLI/native
transport cases. Inputs include holes, inherited indices, accessors, NaN, both
infinities, negative zero, huge values, wrong types, nested junk, invalid dates,
extra keys, malformed supplied graph maps and oversized arrays. Real non-git SDK trackers verify unchanged
current documents, histories and settings. A full tracker hash brackets the
transport run. Three hundred valid generated scenarios retain the pre-refactor
SHA-256 result digest
`2e450ce71178de3816724bc7bbd1013843d3413d5e06b133b55e206bf3d8b346`.

`node test/revert-duration-input.ts` temporarily bypasses only empirical array
validation. The sparse-array regression then fails with an assertion containing
`Invalid time value`; the source is restored in `finally`.


## Successful output contract

`validateDurationOutput` uses closed success schemas in the same validator module.
It runs before every successful calibration, interval, resource or repair result
reaches the SDK/CLI. Resource selection also checks a supplied success result
before recording a note. Every numeric leaf must be finite (negative zero is
refused), and every promised number rejects null. A failure returns
`invalid_estimate`, naming its output field and a remedy, without partial results.
No Infinity/NaN can silently become JSON null. Unknown completion fields may
still be explicitly nullable where documented.

| Output | Range |
| --- | --- |
| Calibration elapsed samples/quantiles | zero or 1/60..175200 minutes |
| Calibration planned quantiles | 1/60..175200 minutes |
| Elapsed/planned ratios | 0..10512000 |
| Probabilities / correlations | [0,1] / [-1,1] |
| Sampling completion days | 0..35040000 (200 maximum efforts at one minute/day) |
| Resource item effort/allocation | 0..175200 minutes; allocator inputs use integer minutes |
| Resource required/deficit/remaining totals | 0..35040000 minutes |
| Resource available capacity per owner | 0..527040 minutes (366 days) |
| Cohort / active-item counts | 0..2000 / 0..200, integers |
| Repair evaluations / changes / total proposals | 0..10000 / 0..3 / 0..2024, integers |
| Repair deferred minutes / added daily capacity | 0..525600 / 0..12960 |
| Seeds / simulation counts | unsigned 32-bit / 100..10000, integers |
| ISO output dates | real four-digit years 0000..9999; UTC timestamps or civil days as declared |

Derived continuous sampling quantiles can resolve fractional seconds; they
remain bounded and finite. Positive *declared* effort and observed episodes have
the one-second floor. Date arithmetic beyond the supported year range refuses
before return. The original valid-scenario digest remains unchanged for its
supported inputs.

`test/duration-output.test.ts` runs 2000 extreme cases at seed **1792202610**
across six SDK routes and four CLI routes, using real SDK-sealed single-episode
histories and identical empirical durations. Cases include Number.MIN_VALUE,
1e-308, 1e308, MAX_SAFE_INTEGER, minimum/maximum ratios, sub-second and
multi-century observations, zero work and date overflow. Accepted results pass
an independent finite/range oracle and JSON round-trip equality; SDK readback and
durable hashes prove refusals write nothing. The exact review case is also
checked through the installed CLI. Corruption probes exercise every numeric/date
leaf of representative successful results, including numeric nulls.

`node test/revert-duration-output.ts` removes only the output check, runs a public
SDK regression with accepted inputs that compute a year-10000 completion, and
requires its assertion to fail. Source restoration runs in `finally`.
