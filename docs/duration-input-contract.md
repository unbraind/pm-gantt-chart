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

Arrays must have every own index from zero through length minus one, without
accessors or extra keys. Inherited entries never fill holes. Each nested value is
checked; sparse empirical populations and quantile arrays cannot reach sampling.
Numbers must be finite, within declared bounds, and not negative zero. Estimates
are 0..175200 minutes; empirical populations contain 1..2000 samples. Quantiles
contain 1..9 strictly increasing probabilities in [0,1]. Zero effort and seed zero
remain valid. Dates reject calendar rollover; recorded history timestamps require
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
