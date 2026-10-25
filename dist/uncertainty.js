import { createHash } from "node:crypto";
import { analyzeRelationshipExecution, RelationshipGraph } from "@unbrained/pm-cli/sdk/graph";
/** Uniform/triangular declarations are checked at runtime, including SDK callers. */
function resolveEstimate(raw) {
    if (raw === undefined || raw === null)
        return null;
    if (Array.isArray(raw)) {
        if (raw.length !== 2)
            return undefined;
        raw = { kind: "uniform", min: raw[0], max: raw[1] };
    }
    if (typeof raw !== "object")
        return undefined;
    const value = raw;
    const { kind, min, max, mode, minutes } = value;
    /** Finite nonnegative effort, bounded to one 365-day working year. */
    const valid = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 175200;
    if (kind === "empirical")
        return Array.isArray(value.values) && value.values.length >= 1 && value.values.length <= 2000 && value.values.every(valid)
            ? { kind, values: [...value.values].sort((a, b) => a - b) } : undefined;
    if (kind === "point")
        return valid(minutes) ? { kind, minutes } : undefined;
    if (!valid(min) || !valid(max) || min > max)
        return undefined;
    if (kind === "uniform")
        return { kind, min, max };
    if (kind === "triangular" && valid(mode) && mode >= min && mode <= max)
        return { kind, min, mode, max };
    return undefined;
}
/** Portable unsigned 32-bit generator; zero is a valid nondegenerate seed. */
function generator(seed) {
    let state = seed;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}
/** Inverse-CDF draws; fixed distributions consume no random values. */
function draw(estimate, random) {
    if (estimate.kind === "point")
        return estimate.minutes;
    if (estimate.kind === "empirical")
        return estimate.values[Math.floor(random() * estimate.values.length)];
    if (estimate.min === estimate.max)
        return estimate.min;
    const u = random();
    const width = estimate.max - estimate.min;
    if (estimate.kind === "uniform")
        return estimate.min + u * width;
    const split = (estimate.mode - estimate.min) / width;
    return u < split
        ? estimate.min + Math.sqrt(u * width * (estimate.mode - estimate.min))
        : estimate.max - Math.sqrt((1 - u) * width * (estimate.max - estimate.mode));
}
/** Centered two-pass Pearson coefficient; a constant input/output has no association. */
function correlation(x, y) {
    if (y.every((value) => value === y[0]))
        return 0;
    const mx = x.reduce((sum, n) => sum + n, 0) / x.length;
    const my = y.reduce((sum, n) => sum + n, 0) / y.length;
    let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < x.length; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        xx += dx * dx;
        yy += dy * dy;
        xy += dx * dy;
    }
    return xx === 0 || yy === 0 ? 0 : Math.max(-1, Math.min(1, xy / (Math.sqrt(xx) * Math.sqrt(yy))));
}
/** Return a structured refusal without exceptions or partial numerical claims. */
function refuse(code, message, remedy) {
    return { ok: false, code, message, remedy };
}
/** Compare UTF-16 code units so seed assignment and sensitivity ties ignore host locale. */
function compareIds(a, b) {
    return Number(a > b) - Number(a < b);
}
/**
 * Sample declared independent effort over the SDK execution order. Ordering has
 * already been normalized by the package's registry-aware graph adapter. Completed
 * prerequisites are satisfied; unknown effort propagates through every successor.
 * Sampling is O(samples * (items + edges)), with no shared-resource/calendar model.
 */
export function simulateCompletionIntervals(corpus, options, graph) {
    const samples = options.samples ?? 2000, minutesPerDay = options.minutesPerDay ?? 480, limit = options.limit ?? 20;
    const quantiles = [...(options.quantiles ?? [0.1, 0.5, 0.9])];
    const anchor = Date.parse(`${options.from}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.from) || !Number.isFinite(anchor) || new Date(anchor).toISOString().slice(0, 10) !== options.from
        || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 4294967295
        || !Number.isInteger(samples) || samples < 100 || samples > 10000
        || !Number.isFinite(minutesPerDay) || minutesPerDay < 1 || minutesPerDay > 1440
        || !Number.isInteger(limit) || limit < 1 || limit > 200
        || quantiles.length < 1 || quantiles.length > 9 || quantiles.some((q, i) => !Number.isFinite(q) || q < 0 || q > 1 || (i > 0 && q <= quantiles[i - 1]))) {
        return refuse("invalid_scenario", "Invalid anchor, seed, sampling or output controls.", "Use a real YYYY-MM-DD day, seed 0..4294967295, samples 100..10000, minutesPerDay 1..1440, limit 1..200 and 1..9 strictly increasing quantiles in [0,1].");
    }
    const edgeCount = [...graph.values()].reduce((n, deps) => n + deps.length, 0);
    if (corpus.length > 200 || edgeCount > 2000 || samples * (corpus.length + edgeCount) > 5000000) {
        return refuse("scenario_too_large", "Scenario exceeds the bounded sampling budget.", "Supply at most 200 dependency-closed items, 2000 ordering edges and samples * (items + edges) <= 5000000.");
    }
    const ids = new Set(corpus.map((item) => item.id));
    if (ids.size !== corpus.length || corpus.some((item) => !item.id || item.id.length > 128 || !graph.has(item.id)
        || graph.get(item.id).some((id) => !ids.has(id))) || [...graph.keys()].some((id) => !ids.has(id))) {
        return refuse("invalid_graph", "Duplicate ids, missing graph rows or unresolved prerequisites.", "Supply unique ids (1..128 characters) and a complete dependency-closed graph; resolve missing references explicitly.");
    }
    const active = corpus.filter((item) => item.status !== "closed" && item.status !== "canceled").sort((a, b) => compareIds(a.id, b.id));
    const activeIds = new Set(active.map((item) => item.id));
    const overrides = options.estimates ?? {};
    if (Object.keys(overrides).some((id) => !activeIds.has(id))) {
        return refuse("invalid_estimate", "An estimate override names absent or completed work.", "Use only active ids from the complete tracker read; omit completed-work overrides.");
    }
    const tasks = [];
    for (const item of active) {
        const hasOverride = Object.hasOwn(overrides, item.id);
        const raw = hasOverride ? overrides[item.id] : item.estimated_minutes === undefined ? undefined : { kind: "point", minutes: item.estimated_minutes };
        const estimate = resolveEstimate(raw);
        if (estimate === undefined || (hasOverride && estimate === null)) {
            return refuse("invalid_estimate", `Invalid effort declaration for ${item.id}.`, "Use [min,max], point minutes, uniform min/max triangular min/mode/max, or empirical values (1..2000); all values must be finite, ordered and within 0..175200 minutes.");
        }
        tasks.push({ id: item.id, prerequisites: [...new Set(graph.get(item.id).filter((id) => activeIds.has(id)))].sort(compareIds), estimate });
    }
    const kernel = new RelationshipGraph(tasks.map((task) => task.id), tasks.flatMap((task) => task.prerequisites.map((id) => ({ source: id, target: task.id, kind: "blocks" }))));
    const execution = analyzeRelationshipExecution(kernel);
    if (!execution.acyclic)
        return refuse("invalid_graph", "Ordering cycle prevents completion sampling.", "Resolve active ordering cycles before computing completion intervals.");
    // The SDK execution kernel omits isolated nodes; add them explicitly.
    const order = [...execution.order, ...tasks.map((task) => task.id).filter((id) => !execution.order.includes(id))];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const unknown = new Set();
    for (const id of order) {
        const task = byId.get(id);
        if (task.estimate === null || task.prerequisites.some((dep) => unknown.has(dep)))
            unknown.add(id);
    }
    const completions = new Map(tasks.map((task) => [task.id, []]));
    const durations = new Map(tasks.filter((task) => task.estimate !== null && task.estimate.kind !== "point" && (task.estimate.kind === "empirical" ? task.estimate.values[0] !== task.estimate.values[task.estimate.values.length - 1] : task.estimate.min !== task.estimate.max)).map((task) => [task.id, []]));
    const projects = [], random = generator(options.seed);
    for (let run = 0; run < samples; run++) {
        const ends = new Map();
        // Draw in canonical id order so input and graph insertion order cannot alter the stream.
        const efforts = new Map(tasks.map((task) => [task.id, task.estimate === null ? 0 : draw(task.estimate, random)]));
        for (const [id, values] of durations)
            values.push(efforts.get(id));
        for (const id of order) {
            if (unknown.has(id))
                continue;
            const start = Math.max(0, ...byId.get(id).prerequisites.map((dep) => ends.get(dep)));
            const finish = start + efforts.get(id) / minutesPerDay;
            ends.set(id, finish);
            completions.get(id).push(finish);
        }
        projects.push(Math.max(0, ...ends.values()));
    }
    /** Nearest-rank empirical quantiles, with q=0 selecting the observed minimum. */
    const summarize = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        return quantiles.map((probability) => {
            const days = sorted[Math.max(0, Math.ceil(probability * samples) - 1)];
            return { probability, days, finish: new Date(anchor + days * 86400000).toISOString() };
        });
    };
    const sensitivity = unknown.size > 0 ? [] : [...durations].map(([id, values]) => ({ id, correlation: correlation(values, projects) }))
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation) || compareIds(a.id, b.id));
    const inputs = { from: options.from, seed: options.seed, samples, quantiles, minutesPerDay, tasks };
    return {
        ok: true, complete: unknown.size === 0, activeCount: tasks.length, unknownCount: unknown.size,
        unknownEstimateCount: tasks.filter((task) => task.estimate === null).length,
        project: unknown.size > 0 ? null : summarize(projects),
        items: tasks.slice(0, limit).map((task) => ({ id: task.id, completion: unknown.has(task.id) ? null : summarize(completions.get(task.id)),
            reason: task.estimate === null ? "unknown_estimate" : unknown.has(task.id) ? "unknown_prerequisite" : null })),
        sensitivity: sensitivity.slice(0, limit), dominantEstimate: sensitivity.length > 0 && Math.abs(sensitivity[0].correlation) > 0 ? sensitivity[0].id : null,
        sensitivityMethod: "pearson-duration-project-finish", itemCount: tasks.length, sensitivityCount: sensitivity.length,
        truncated: tasks.length > limit || sensitivity.length > limit,
        receipt: { version: 1, algorithm: "mulberry32-nearest-rank-v1", inputHash: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"), ...inputs,
            assumptions: ["independent effort draws", "continuous calendar days at minutesPerDay effort/day", "UTC exclusive completion", "unlimited parallel capacity", "completed prerequisites satisfied", "deadlines and created dates do not delay earliest starts", "missing estimates stay unknown", "Pearson association is not causal variance attribution"] },
    };
}
//# sourceMappingURL=uncertainty.js.map