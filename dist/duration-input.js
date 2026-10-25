/** Positive forecast effort/observations span one second through 120 elapsed days; zero is explicit no work. */
export const DURATION_MINUTES = Object.freeze({ minimumPositive: 1 / 60, maximum: 175200, legacyMaximum: 20 * 365 * 1440 });
const minutes = { kind: "number", min: 0, max: DURATION_MINUTES.maximum, positiveMin: DURATION_MINUTES.minimumPositive };
const text = { kind: "string", max: 128, nonblank: true };
const timestamp = { kind: "string", max: 40, format: "timestamp" };
const quantiles = { kind: "array", entry: { kind: "number", min: 0, max: 1 }, min: 1, max: 9, increasing: true, optional: true };
const rowLimit = { kind: "number", min: 1, max: 200, integer: true, optional: true };
const estimate = { kind: "union", choices: [
        { kind: "array", entry: minutes, tuple: [minutes, minutes], min: 2, max: 2, ordered: true },
        { kind: "object", fields: { kind: { kind: "literal", value: "point" }, minutes } },
        { kind: "object", fields: { kind: { kind: "literal", value: "uniform" }, min: minutes, max: minutes }, ordered: ["min", "max"] },
        { kind: "object", fields: { kind: { kind: "literal", value: "triangular" }, min: minutes, mode: minutes, max: minutes }, ordered: ["min", "mode", "max"] },
        { kind: "object", fields: { kind: { kind: "literal", value: "empirical" }, values: { kind: "array", entry: minutes, min: 1, max: 2000 } } },
    ] };
const item = { kind: "object", open: true, fields: {
        id: { kind: "string", max: 4096 }, status: { kind: "string", max: 128 },
        estimated_minutes: { ...minutes, optional: true },
        type: { kind: "string", max: 128, optional: true }, title: { kind: "string", max: 16384, optional: true },
        assignee: { kind: "string", max: 128, optional: true },
        tags: { kind: "array", entry: { kind: "string", max: 4096 }, min: 0, max: 1000, optional: true },
        created_at: { kind: "union", optional: true, choices: [{ kind: "string", max: 10, format: "day" }, { kind: "string", max: 40, format: "civil" }] },
        deadline: { kind: "union", optional: true, choices: [{ kind: "string", max: 10, format: "day" }, { kind: "string", max: 40, format: "civil" }] },
        due_date: { kind: "union", optional: true, choices: [{ kind: "string", max: 10, format: "day" }, { kind: "string", max: 40, format: "civil" }] },
        dependencies: { kind: "array", min: 0, max: 10000, optional: true, entry: { kind: "object", open: true, fields: {
                    id: { kind: "string", max: 4096 }, kind: { kind: "string", max: 128, optional: true }, created_at: { ...timestamp, optional: true },
                } } },
    } };
const corpus = { kind: "array", entry: item, min: 0, max: 100000 };
const calendar = { kind: "object", fields: {
        weekdays: { kind: "array", entry: { kind: "number", min: 1, max: 7, integer: true }, min: 0, max: 7, unique: true },
        holidays: { kind: "array", entry: { kind: "string", max: 10, format: "day" }, min: 0, max: 366 },
        minutesPerDay: { kind: "number", min: 0, max: 1440, integer: true }, minutesPerWeek: { kind: "number", min: 0, max: 10080, integer: true }, totalMinutes: { kind: "number", min: 0, max: 527040, integer: true },
    } };
const graph = { kind: "map", max: 100000, optional: true, entry: { kind: "array", entry: { kind: "string", max: 4096 }, min: 0, max: 10000 } };
const schemas = {
    sampling: { kind: "object", fields: { corpus, graph, options: { kind: "object", fields: {
                    from: { kind: "string", max: 10, format: "day" }, seed: { kind: "number", min: 0, max: 4294967295, integer: true },
                    samples: { kind: "number", min: 100, max: 10000, integer: true, optional: true },
                    minutesPerDay: { kind: "number", min: 1, max: 1440, optional: true }, limit: rowLimit, quantiles,
                    estimates: { kind: "dictionary", entry: estimate, max: 200, optional: true },
                } } } },
    calibration: { kind: "object", fields: { type: text, tag: { ...text, optional: true }, minimumSamples: { kind: "number", min: 1, max: 2000, integer: true }, limit: rowLimit, quantiles } },
    resources: { kind: "object", fields: { graph, corpus: { ...corpus, entry: { ...item, fields: { ...item.fields, estimated_minutes: { ...minutes, integer: true, optional: true } } } }, options: { kind: "object", ordered: ["from", "through"], fields: {
                    from: { kind: "string", max: 10, format: "day" }, through: { kind: "string", max: 10, format: "day" }, timeZone: { kind: "string", max: 128, format: "zone" }, limit: rowLimit,
                    scenarios: { kind: "array", min: 1, max: 100, entry: { kind: "object", fields: {
                                id: { kind: "string", max: 64, format: "identifier" }, owners: { kind: "dictionary", entry: calendar, max: 50, key: text },
                                work: { kind: "dictionary", max: 200, optional: true, entry: { kind: "object", fields: { owner: { kind: "string", max: 128 }, minutes: { ...minutes, integer: true } } } },
                            } } },
                } } } },
    repair: { kind: "object", fields: { corpus, graph, options: { kind: "object", ordered: ["from", "deadline"], fields: {
                    from: { kind: "string", max: 10, format: "day" }, deadline: { kind: "string", max: 10, format: "day" },
                    defaultDuration: { kind: "number", min: 1, max: 365, integer: true, optional: true }, maxChanges: { kind: "number", min: 1, max: 3, integer: true, optional: true },
                    maxProposals: { kind: "number", min: 1, max: 10, integer: true, optional: true }, maxEvaluations: { kind: "number", min: 1, max: 10000, integer: true, optional: true },
                    deferrableIds: { kind: "array", entry: text, min: 0, max: 200, optional: true }, forbiddenIds: { kind: "array", entry: text, min: 0, max: 200, optional: true },
                    capacityShifts: { kind: "array", min: 0, max: 200, optional: true, entry: { kind: "object", fields: { itemId: text, minutesPerDay: { kind: "number", min: 481, max: 4800, integer: true } } } },
                } } } },
    corpus, graph, storedEstimate: { kind: "number", min: 0, max: DURATION_MINUTES.legacyMaximum, positiveMin: DURATION_MINUTES.minimumPositive, optional: true },
    historyPoint: { kind: "object", fields: { type: item.fields.type, tags: item.fields.tags, at: timestamp, minutes: { ...minutes, optional: true }, completed_at: { ...timestamp, optional: true }, closed_at: { ...timestamp, optional: true } } },
    elapsed: minutes,
};
/** Marker keeps foreign malformed input separate from unavailable tracker evidence. */
export class DurationInputError extends Error {
    refusal;
    path;
    constructor(path) {
        super(`Invalid duration input at ${path}.`);
        this.path = path;
        this.refusal = { ok: false, code: "invalid_estimate", message: this.message,
            remedy: "Use dense own-index arrays, finite nonnegative numbers (not negative zero) within declared bounds, real ISO dates, and only declared keys in closed estimate/control objects. Positive duration estimates must be at least one second and at most the documented minute ceiling. See the duration input contract." };
    }
}
/** Validate bounded date, timestamp, zone and identifier text without coercion or date rollover. */
function validTextFormat(value, format) {
    if (format === "identifier")
        return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
    if (format === "zone") {
        try {
            new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
            return true;
        }
        catch {
            return false;
        }
    }
    const day = value.slice(0, 10), parsed = Date.parse(`${day}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day)
        return false;
    if (format === "day")
        return value === day;
    const pattern = format === "civil"
        ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/
        : /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
    return pattern.test(value) && Number.isFinite(Date.parse(value));
}
/** Reject inherited fields/accessors/symbol keys; read descriptors without invoking getters. */
function fields(value, path) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new DurationInputError(path);
    const result = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 10000)
        throw new DurationInputError(path);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !Object.hasOwn(descriptor, "value"))
            throw new DurationInputError(path);
        result[key] = descriptor.value;
    }
    return result;
}
/** Interpret the single declarative contract; recurse only after bounded shape checks. */
function parse(rule, value, path, budget = { remaining: 1000000 }) {
    if (--budget.remaining < 0)
        throw new DurationInputError("bounded_input_work");
    if (rule.optional && value === undefined)
        return undefined;
    switch (rule.kind) {
        case "number":
            if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < rule.min || value > rule.max || (rule.positiveMin !== undefined && value > 0 && value < rule.positiveMin) || (rule.integer && !Number.isInteger(value)))
                throw new DurationInputError(path);
            return value;
        case "string":
            if (typeof value !== "string" || value.length > rule.max || (rule.nonblank && value.trim().length === 0) || (rule.format && !validTextFormat(value, rule.format)))
                throw new DurationInputError(path);
            return value;
        case "literal":
            if (value !== rule.value)
                throw new DurationInputError(path);
            return value;
        case "nullable":
            return value === null ? null : parse(rule.entry, value, path, budget);
        case "union":
            for (const choice of rule.choices) {
                try {
                    const parsed = parse(choice, value, path, budget);
                    return rule === estimate ? canonicalDurationEstimate(parsed) : parsed;
                }
                catch { /* Try the next closed variant. */ }
            }
            throw new DurationInputError(path);
        case "array": {
            if (!Array.isArray(value))
                throw new DurationInputError(path);
            const length = parse({ kind: "number", min: rule.min, max: rule.max, integer: true }, Object.getOwnPropertyDescriptor(value, "length").value, `${path}.length`, budget);
            if (Reflect.ownKeys(value).length !== length + 1)
                throw new DurationInputError(path);
            const result = [];
            for (let index = 0; index < length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
                    throw new DurationInputError(`${path}[${index}]`);
                result.push(parse(rule.tuple?.[index] ?? rule.entry, descriptor.value, `${path}[${index}]`, budget));
                if (index > 0 && ((rule.increasing && result[index] <= result[index - 1]) || (rule.ordered && result[index] < result[index - 1])))
                    throw new DurationInputError(path);
            }
            if (rule.unique && new Set(result).size !== result.length)
                throw new DurationInputError(path);
            return Object.freeze(result);
        }
        case "map": {
            if (!(value instanceof Map) || Reflect.ownKeys(value).length > 0)
                throw new DurationInputError(path);
            const size = Object.getOwnPropertyDescriptor(Map.prototype, "size").get.call(value);
            if (size > rule.max)
                throw new DurationInputError(path);
            const entries = Array.from(Map.prototype.entries.call(value));
            const result = [];
            for (const [key, entry] of entries) {
                const id = parse({ kind: "string", max: 4096 }, key, path, budget);
                result.push(Object.freeze([id, parse(rule.entry, entry, `${path}.${id}`, budget)]));
            }
            return Object.freeze(result);
        }
        case "dictionary": {
            const input = fields(value, path), keys = Object.keys(input);
            if (keys.length > rule.max)
                throw new DurationInputError(path);
            return Object.freeze(Object.fromEntries(keys.map((key) => [rule.key ? parse(rule.key, key, path, budget) : key, parse(rule.entry, input[key], `${path}.${key}`, budget)])));
        }
        case "object": {
            const input = fields(value, path);
            if (!rule.open && Object.keys(input).some((key) => !Object.hasOwn(rule.fields, key)))
                throw new DurationInputError(path);
            const result = rule.open ? { ...input } : {};
            for (const [key, child] of Object.entries(rule.fields)) {
                const parsed = parse(child, input[key], `${path}.${key}`, budget);
                if (parsed !== undefined)
                    result[key] = parsed;
            }
            if (rule.ordered)
                for (let i = 1; i < rule.ordered.length; i++) {
                    if (result[rule.ordered[i]] < result[rule.ordered[i - 1]])
                        throw new DurationInputError(path);
                }
            return Object.freeze(result);
        }
    }
}
/** Canonicalize a schema-validated declaration once, preserving empirical multiplicities. */
function canonicalDurationEstimate(value) {
    if (Array.isArray(value))
        return Object.freeze({ kind: "uniform", min: value[0], max: value[1] });
    const declared = value;
    if (declared.kind === "empirical")
        return Object.freeze({ kind: declared.kind, values: Object.freeze([...declared.values].sort((a, b) => a - b)) });
    return declared;
}
const receipts = new WeakMap();
/** Internal calculators accept only receipts minted by this module; forged values refuse. */
export function durationValidatedValue(kind, token) {
    const found = receipts.get(token);
    return found?.kind === kind ? { ok: true, value: found.value } : new DurationInputError(kind).refusal;
}
/** Boundary for SDK values, decoded CLI files/flags and SDK-read native fields; never throws. */
export function validateDurationInput(kind, input) {
    try {
        const value = parse(schemas[kind], input, kind);
        const result = Object.freeze({ ok: true, value });
        receipts.set(result, { kind, value });
        return result;
    }
    catch (error) {
        return (error instanceof DurationInputError ? error : new DurationInputError(kind)).refusal;
    }
}
/** Historical replay calls use the same schema, forwarding typed failures through the reader. */
export function requireDurationInput(kind, input) {
    const result = validateDurationInput(kind, input);
    if (!result.ok)
        throw new DurationInputError(kind);
    return result.value;
}
/** Decode numeric flag transport without coercing objects, symbols or other structured inputs. */
export function durationFlagNumber(value) {
    return typeof value === "string" ? value.trim() === "" || value.length > 128 ? NaN : Number(value) : value;
}
/** Decode the CLI CSV transport; array shape and probability bounds belong to the schema. */
export function durationFlagQuantiles(value) {
    return typeof value === "string" ? value.split(",").map(durationFlagNumber) : value;
}
/** Decode a supplied graph once, or clone already validated detached graph entries. */
export function durationInputGraph(stored, override) {
    const read = override === undefined ? { ok: true, value: stored } : validateDurationInput("graph", override);
    if (!read.ok)
        return read;
    return { ok: true, value: read.value === undefined ? undefined : new Map(read.value.map(([id, deps]) => [id, [...deps]])) };
}
const count = { kind: "number", min: 0, max: 200, integer: true };
const probability = { kind: "number", min: 0, max: 1 };
const flag = { kind: "union", choices: [{ kind: "literal", value: true }, { kind: "literal", value: false }] };
const nil = { kind: "literal", value: null };
const day = { kind: "string", max: 10, format: "day" };
const totalMinutes = { kind: "number", min: 0, max: 200 * DURATION_MINUTES.maximum };
const quantileRow = { kind: "object", fields: { probability, days: totalMinutes, finish: timestamp } };
const completion = { kind: "nullable", entry: { kind: "array", min: 1, max: 9, entry: quantileRow } };
const labels = { kind: "array", min: 0, max: 200, entry: { kind: "string", max: 4096 } };
const strings = { kind: "array", min: 0, max: 32, entry: { kind: "string", max: 1024 } };
const nullableDay = { kind: "nullable", entry: day };
const successful = { kind: "literal", value: true };
const populationCount = { ...count, max: 2000 };
const baseline = { kind: "object", fields: { finish: nullableDay, infeasibleIds: labels } };
const repairMove = { kind: "union", choices: [
        { kind: "object", fields: { kind: { kind: "literal", value: "capacity_shift" }, itemId: text, beforeDays: { kind: "number", min: 1, max: 365, integer: true }, afterDays: { kind: "number", min: 1, max: 365, integer: true }, minutesPerDay: { kind: "number", min: 481, max: 4800, integer: true }, addedMinutesPerDay: { kind: "number", min: 1, max: 4320, integer: true } } },
        { kind: "object", fields: { kind: { kind: "literal", value: "scope_deferral" }, itemId: text, deferredMinutes: minutes } },
    ] };
const outputSchemas = {
    calibration: { kind: "object", fields: { ok: successful,
            evidence: { kind: "object", fields: { selectedCount: populationCount, sampleCount: populationCount, minimumSamples: { ...populationCount, min: 1 },
                    excluded: { kind: "object", fields: Object.fromEntries(["unverified_history", "reopened", "canceled", "incomplete", "missing_start", "missing_estimate", "class_changed", "invalid_duration"].map((key) => [key, populationCount])) },
                    truncated: flag, rows: { kind: "array", min: 0, max: 200, entry: { kind: "object", fields: { id: text,
                                reason: { kind: "union", choices: [nil, text] }, elapsedMinutes: { ...minutes, optional: true }, plannedMinutes: { ...minutes, min: DURATION_MINUTES.minimumPositive, optional: true } } } } } },
            distribution: { kind: "object", fields: { kind: { kind: "literal", value: "empirical" }, values: { kind: "array", min: 1, max: 2000, entry: minutes } } },
            quantiles: { kind: "array", min: 1, max: 9, entry: { kind: "object", fields: { probability, elapsedMinutes: minutes, plannedMinutes: { ...minutes, min: DURATION_MINUTES.minimumPositive }, elapsedToPlannedRatio: { kind: "number", min: 0, max: DURATION_MINUTES.maximum / DURATION_MINUTES.minimumPositive } } } },
            receipt: { kind: "object", fields: { version: { kind: "literal", value: 1 }, method: { kind: "literal", value: "verified-single-episode-nearest-rank-v1" }, inputHash: text, type: text, tag: { kind: "union", choices: [nil, text] }, unit: { kind: "literal", value: "elapsed_calendar_minutes" }, assumptions: strings } },
        } },
    sampling: { kind: "object", fields: { ok: successful, complete: flag, activeCount: count, unknownCount: count, unknownEstimateCount: count, itemCount: count, sensitivityCount: count, truncated: flag,
            project: completion, items: { kind: "array", min: 0, max: 200, entry: { kind: "object", fields: { id: text, completion, reason: { kind: "union", choices: [nil, text] } } } },
            sensitivity: { kind: "array", min: 0, max: 200, entry: { kind: "object", fields: { id: text, correlation: { kind: "number", min: -1, max: 1 } } } }, dominantEstimate: { kind: "union", choices: [nil, text] }, sensitivityMethod: { kind: "literal", value: "pearson-duration-project-finish" },
            receipt: { kind: "object", fields: { version: { kind: "literal", value: 1 }, algorithm: { kind: "literal", value: "mulberry32-nearest-rank-v1" }, inputHash: text, from: day, seed: schemas.sampling.fields.options.fields.seed,
                    samples: { kind: "number", min: 100, max: 10000, integer: true }, quantiles: { ...quantiles, optional: false }, minutesPerDay: { kind: "number", min: 1, max: 1440 }, tasks: { kind: "array", min: 0, max: 200, entry: { kind: "object", fields: { id: text, prerequisites: labels, estimate: { kind: "union", choices: [nil, estimate] } } } }, assumptions: strings } },
        } },
    resources: { kind: "object", fields: { ok: successful, revision: text, activeCount: count, assumptions: strings,
            scenarios: { kind: "array", min: 1, max: 5, entry: { kind: "object", fields: { id: text, selection: text, feasible: flag, outcome: text, remainingMinutes: totalMinutes, itemCount: count, truncated: flag,
                        items: { kind: "array", min: 0, max: 200, entry: { kind: "object", fields: { id: text, owner: { kind: "string", max: 128 }, minutes, allocatedMinutes: minutes, start: nullableDay, finish: nullableDay } } },
                        witnesses: { kind: "array", min: 0, max: 50, entry: { kind: "object", fields: { owner: text, requiredMinutes: totalMinutes, availableMinutes: { kind: "number", min: 0, max: 527040 }, deficitMinutes: totalMinutes } } },
                    } } },
        } },
    repair: { kind: "object", fields: { ok: successful, baseline, examined: { kind: "number", min: 0, max: 10000, integer: true }, minimalChanges: { kind: "number", min: 0, max: 3, integer: true }, totalProposals: { kind: "number", min: 0, max: 2024, integer: true }, truncated: flag,
            proposals: { kind: "array", min: 0, max: 10, entry: { kind: "object", fields: { moves: { kind: "array", min: 1, max: 3, entry: repairMove }, affectedIds: labels, finish: day, retainedCount: count,
                        deferredMinutes: { kind: "number", min: 0, max: 3 * DURATION_MINUTES.maximum }, addedMinutesPerDay: { kind: "number", min: 0, max: 12960, integer: true } } } },
        } },
};
/** Fail closed on arithmetic/domain defects, identifying the output field instead of serializing a bad number/date. */
export function validateDurationOutput(kind, value) {
    try {
        parse(outputSchemas[kind], value, kind);
        return value;
    }
    catch (error) {
        const path = error instanceof DurationInputError ? error.path : kind;
        return { ok: false, code: "invalid_estimate", message: `Duration output at ${path} violates its finite numeric/date contract.`,
            remedy: `Review ${path}, use documented bounded duration inputs and a representable ISO horizon, and retry. No successful numerical result was produced.` };
    }
}
//# sourceMappingURL=duration-input.js.map