import { createHash } from "node:crypto";
import { analyzeRelationshipExecution, RelationshipGraph } from "@unbrained/pm-cli/sdk/graph";
import { commitItemMutations, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
/** Exact content hashes are portable and contain no tracker paths or wall clock. */
function digest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Check a real civil date without the permissive Date parser's rollover. */
function day(value) {
    if (typeof value !== "string")
        return NaN;
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}
/** Nonnegative bounded integers prevent fractional minutes and unbounded work. */
function integer(value, maximum) {
    return Number.isInteger(value) && value >= 0 && value <= maximum;
}
/** Refusals deliberately carry no partial schedule that could be mistaken for success. */
function refuse(code, message, remedy) {
    return { ok: false, code, message, remedy };
}
/** Structural check shared by the CLI JSON boundary and typed SDK callers. */
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validate an owner's explicit work limits, including holidays outside the selected horizon. */
function calendarValid(value) {
    return record(value) && Array.isArray(value.weekdays) && value.weekdays.length <= 7
        && value.weekdays.every((n) => Number.isInteger(n) && n >= 1 && n <= 7)
        && new Set(value.weekdays).size === value.weekdays.length
        && Array.isArray(value.holidays) && value.holidays.length <= 366
        && value.holidays.every((date) => typeof date === "string" && Number.isFinite(day(date)))
        && integer(value.minutesPerDay, 1440) && integer(value.minutesPerWeek, 10080) && integer(value.totalMinutes, 527040);
}
/** Compute civil dates and ISO-week keys in UTC arithmetic, independent of DST and host zone. */
function dates(from, through) {
    const result = [];
    for (let time = from; time <= through; time += 86400000) {
        const date = new Date(time);
        const weekday = (date.getUTCDay() + 6) % 7 + 1;
        result.push({ date: date.toISOString().slice(0, 10), weekday, week: new Date(time - (weekday - 1) * 86400000).toISOString().slice(0, 10) });
    }
    return result;
}
/** Resolve a horizon budget before allocating work; unused daily capacity does not carry forward. */
function budgets(calendar, horizon) {
    let total = calendar.totalMinutes;
    const weeks = new Map();
    return horizon.map(({ date, weekday, week }) => {
        const left = weeks.get(week) ?? calendar.minutesPerWeek;
        const minutes = calendar.weekdays.includes(weekday) && !calendar.holidays.includes(date) ? Math.min(calendar.minutesPerDay, left, total) : 0;
        weeks.set(week, left - minutes);
        total -= minutes;
        return minutes;
    });
}
/**
 * Compare bounded explicit resource alternatives using the SDK execution kernel.
 * The allocator shares each owner's daily/weekly/total budget, preempts work at
 * day boundaries and releases successors on the next civil day. Stable id order
 * is a reproducible heuristic, not an optimal resource-leveling claim. Capacity
 * witnesses are necessary bounds; exhaustion alone is not an impossibility proof.
 */
export function computeResourceScenarios(corpus, options, graph) {
    if (!record(options))
        return refuse("invalid_scenario", "Scenario controls must be an object.", "Provide from, through, timeZone and an explicit scenarios array.");
    const from = day(options.from), through = day(options.through), limit = options.limit ?? 20;
    if (!Number.isFinite(from) || !Number.isFinite(through) || through < from || !integer(limit, 200) || limit < 1
        || typeof options.timeZone !== "string" || options.timeZone.length === 0 || !Array.isArray(options.scenarios) || options.scenarios.length < 1) {
        return refuse("invalid_scenario", "Invalid horizon, zone, alternatives or row limit.", "Use real YYYY-MM-DD from <= through, explicit IANA timeZone, 1..5 alternatives and limit 1..200.");
    }
    try {
        new Intl.DateTimeFormat("en", { timeZone: options.timeZone }).format(0);
    }
    catch {
        return refuse("invalid_scenario", "Unknown IANA time zone.", "Use a supported IANA zone such as UTC or Europe/Vienna; dates are civil days in that zone.");
    }
    const active = corpus.filter((item) => item.status !== "closed" && item.status !== "canceled").slice().sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
    if (corpus.length > 2000 || active.length > 200 || options.scenarios.length > 5 || through - from > 365 * 86400000
        || [...graph.values()].reduce((n, deps) => n + deps.length, 0) > 5000) {
        return refuse("scenario_too_large", "Resource scenario exceeds its bounded work budget.", "Use at most 2000 corpus items, 200 active tasks, 5000 edges, 5 alternatives and 366 inclusive days.");
    }
    const identities = corpus.map(({ id }) => id);
    const ids = new Set(identities);
    const invalidReferences = corpus.some((item) => (item.dependencies ?? []).some((dependency) => !ids.has(dependency.id)));
    const invalidIdentity = identities.some((id) => !id || id.length > 128 || !graph.has(id));
    const invalidEdges = [...graph].some(([id, deps]) => !ids.has(id) || deps.some((dep) => !ids.has(dep)));
    if (ids.size !== identities.length || invalidIdentity || invalidEdges || invalidReferences) {
        return refuse("invalid_graph", "Duplicate identities, unresolved relationship targets or incomplete prerequisite graph.", "Read the complete corpus and resolve every declared relationship target before evaluating scenarios.");
    }
    const activeIds = new Set(active.map((item) => item.id));
    const prerequisites = new Map(active.map((item) => [item.id, [...new Set(graph.get(item.id).filter((id) => activeIds.has(id)))].sort()]));
    const kernel = new RelationshipGraph([...activeIds], [...prerequisites].flatMap(([id, deps]) => deps.map((dep) => ({ source: dep, target: id, kind: "blocks" }))));
    if (!analyzeRelationshipExecution(kernel).acyclic)
        return refuse("invalid_graph", "Active ordering cycle prevents allocation.", "Resolve the ordering cycle; association edges do not constrain work.");
    // Content revision binds all interpreted item fields, including deadlines, and resolved ordering.
    const revision = digest(corpus.slice().sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id)).map((item) => [item.id, item.status, item.assignee ?? null, item.estimated_minutes ?? null, item.deadline ?? item.due_date ?? null, [...graph.get(item.id)].sort()]));
    const horizon = dates(from, through), scenarioIds = new Set();
    const scenarios = [];
    for (const alternative of options.scenarios) {
        if (!record(alternative) || typeof alternative.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(alternative.id) || scenarioIds.has(alternative.id)
            || !record(alternative.owners) || Object.keys(alternative.owners).length > 50 || Object.entries(alternative.owners).some(([owner, calendar]) => !owner || owner.length > 128 || !calendarValid(calendar))
            || (alternative.work !== undefined && (!record(alternative.work) || Object.entries(alternative.work).some(([id, work]) => !activeIds.has(id) || !record(work) || typeof work.owner !== "string" || !integer(work.minutes, 175200))))) {
            return refuse("invalid_scenario", "Invalid alternative, owner calendar or work override.", "Use unique short scenario ids, <=50 named owners with explicit weekday/holiday and integer daily/weekly/total limits, and active-id work overrides of 0..175200 minutes.");
        }
        scenarioIds.add(alternative.id);
        const tasks = [];
        for (const item of active) {
            const override = alternative.work?.[item.id], owner = override?.owner ?? item.assignee, minutes = override?.minutes ?? item.estimated_minutes;
            if (owner === undefined || !Object.hasOwn(alternative.owners, owner) || minutes === undefined || !integer(minutes, 175200)) {
                return refuse("missing_work", `Missing declared owner capacity or effort for ${item.id}.`, "Declare its assignee calendar and integer estimated minutes, or provide an explicit scenario work override; no estimates are invented.");
            }
            tasks.push({ id: item.id, owner, minutes, allocatedMinutes: 0, start: null, finish: null });
        }
        const capacity = new Map(Object.keys(alternative.owners).sort().map((owner) => [owner, budgets(alternative.owners[owner], horizon)]));
        const witnesses = [];
        for (const [owner, available] of capacity) {
            const requiredMinutes = tasks.filter((task) => task.owner === owner).reduce((n, task) => n + task.minutes, 0);
            const availableMinutes = available.reduce((n, minutes) => n + minutes, 0);
            if (requiredMinutes > availableMinutes)
                witnesses.push({ owner, requiredMinutes, availableMinutes, deficitMinutes: requiredMinutes - availableMinutes });
        }
        const completed = new Set();
        const weeklyUsed = new Map(), totalUsed = new Map();
        for (let i = 0; i < horizon.length; i++) {
            const dailyUsed = new Map();
            const ready = tasks.filter((task) => !completed.has(task.id) && prerequisites.get(task.id).every((id) => completed.has(id)));
            const doneToday = [];
            for (const task of ready) {
                const calendar = alternative.owners[task.owner], date = horizon[i];
                const weekKey = `${task.owner}:${date.week}`;
                const available = calendar.weekdays.includes(date.weekday) && !calendar.holidays.includes(date.date)
                    ? Math.min(calendar.minutesPerDay - (dailyUsed.get(task.owner) ?? 0), calendar.minutesPerWeek - (weeklyUsed.get(weekKey) ?? 0), calendar.totalMinutes - (totalUsed.get(task.owner) ?? 0)) : 0;
                const minutes = Math.min(task.minutes - task.allocatedMinutes, available);
                if (minutes > 0 || task.minutes === 0) {
                    task.start ??= horizon[i].date;
                    task.allocatedMinutes += minutes;
                    dailyUsed.set(task.owner, (dailyUsed.get(task.owner) ?? 0) + minutes);
                    weeklyUsed.set(weekKey, (weeklyUsed.get(weekKey) ?? 0) + minutes);
                    totalUsed.set(task.owner, (totalUsed.get(task.owner) ?? 0) + minutes);
                    if (task.allocatedMinutes === task.minutes) {
                        task.finish = horizon[i].date;
                        doneToday.push(task.id);
                    }
                }
            }
            for (const id of doneToday)
                completed.add(id);
        }
        const remainingMinutes = tasks.reduce((n, task) => n + task.minutes - task.allocatedMinutes, 0);
        const feasible = completed.size === tasks.length;
        const selection = digest([revision, options.from, options.through, options.timeZone, alternative.id, [...capacity.keys()].map((owner) => [owner, alternative.owners[owner]]), tasks.map(({ id, owner, minutes }) => [id, owner, minutes])]);
        scenarios.push({ id: alternative.id, selection, feasible, outcome: feasible ? "feasible" : witnesses.length > 0 ? "capacity_infeasible" : "allocation_exhausted", remainingMinutes, itemCount: tasks.length, truncated: tasks.length > limit, items: tasks.slice(0, limit), witnesses });
    }
    return { ok: true, revision, activeCount: active.length, assumptions: ["civil-day-v1", `timeZone=${options.timeZone}`, "inclusive-horizon", "preemptive-minute-budgets", "successors-next-day", "stable-id-heuristic", "deadlines-observational; horizon-is-hard-limit"], scenarios };
}
/**
 * Record a chosen feasible snapshot as a core note, without editing item dates.
 * Recompute against a fresh certified read before calling. The SDK checks the
 * target updated_at under its item lock, journals the mutation and preserves
 * history. Source revision identifies the read snapshot, not a future lock on
 * every source item; later changes require a new evaluation and selection.
 */
export async function applyResourceSelection(pmRoot, author, result, choice) {
    if (!result.ok)
        return result;
    if (!choice.scenarioId || !choice.selection || !choice.expectedRevision || !choice.targetId || !choice.targetRevision) {
        return refuse("selection_required", "An explicit scenario selection and both revisions are required.", "Pass scenarioId, selection token, expectedRevision, targetId and the target's updated_at as targetRevision.");
    }
    if (result.revision !== choice.expectedRevision)
        return refuse("revision_conflict", "Source scheduling inputs changed since review.", "Recompute alternatives, review consequences and select a fresh revision explicitly.");
    const scenario = result.scenarios.find((candidate) => candidate.id === choice.scenarioId && candidate.selection === choice.selection);
    if (!scenario)
        return refuse("selection_required", "Selected scenario or token does not match this computation.", "Copy an exact scenario id and selection token from the reviewed result.");
    if (!scenario.feasible)
        return refuse("infeasible_selection", "The selected scenario did not finish within its horizon.", "Increase declared capacity or horizon and explicitly select a feasible alternative.");
    try {
        await commitItemMutations({ pmRoot, author, transactionId: `resource-${digest([choice, author])}`, mutations: [{ op: "update", id: choice.targetId, match: { key: "updated_at", value: choice.targetRevision }, options: { note: [JSON.stringify({ kind: "resource-scenario-selection", scenarioId: scenario.id, selection: scenario.selection, sourceRevision: result.revision, assumptions: result.assumptions })] } }] });
    }
    catch (error) {
        if (!isPmCliExpectedError(error))
            throw error;
        return refuse("application_refused", "The core mutation guard refused the scenario selection.", "Read the target again, resolve ownership/policy or revision conflicts, then explicitly select against its fresh updated_at.");
    }
    return { ok: true, targetId: choice.targetId, scenarioId: scenario.id, revision: result.revision };
}
//# sourceMappingURL=resources.js.map