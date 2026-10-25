import type { CompletionIntervalOptions, PmItem, UncertainEstimate } from "../index.ts";

/** Frozen valid-input generator used for the pre-validation compatibility digest. */
export function validDurationCases() {
  let state = 1792026;
  /** Fixed unsigned generator independent of the production sampler. */
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({ length: 300 }, (_, index) => {
    const a = next() % 1000, b = a + next() % 500, c = a + (b - a) / 2;
    const estimates: UncertainEstimate[] = [[a, b], { kind: "point", minutes: a }, { kind: "uniform", min: a, max: b },
      { kind: "triangular", min: a, mode: c, max: b }, { kind: "empirical", values: [b, a, b, c] }];
    const items: PmItem[] = [{ id: "future", title: "Future", status: "open", estimated_minutes: a }];
    const options: CompletionIntervalOptions = { from: "2026-10-25", seed: next(), samples: 100, quantiles: [0, 0.5, 1], minutesPerDay: 1 + next() % 1440,
      estimates: { future: estimates[index % estimates.length] } };
    return { items, options };
  });
}
