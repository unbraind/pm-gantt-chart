const minutes = { kind: "number", min: 0, max: 175200 };
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
    corpus, graph, storedEstimate: { kind: "number", min: 0, max: Number.MAX_VALUE, optional: true },
    historyPoint: { kind: "object", fields: { type: item.fields.type, tags: item.fields.tags, at: timestamp, minutes: { ...minutes, optional: true }, completed_at: { ...timestamp, optional: true }, closed_at: { ...timestamp, optional: true } } },
    elapsed: minutes,
};
/** Marker keeps foreign malformed input separate from unavailable tracker evidence. */
export class DurationInputError extends Error {
    refusal;
    constructor(path) {
        super(`Invalid duration input at ${path}.`);
        this.refusal = { ok: false, code: "invalid_estimate", message: this.message,
            remedy: "Use dense own-index arrays, finite nonnegative numbers (not negative zero) within declared bounds, real ISO dates, and only declared keys in closed estimate/control objects. See the duration input contract." };
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
            if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value)))
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
//# sourceMappingURL=duration-input.js.map