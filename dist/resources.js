import { createHash } from "node:crypto";
import { analyzeRelationshipExecution, RelationshipGraph } from "@unbrained/pm-cli/sdk/graph";
import { commitItemMutations, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { buildPrerequisiteGraph } from "./index.js";
import { ownDurationValue, durationInputGraph, durationValidatedValue, validateDurationInput, validateDurationOutput } from "./duration-input.js";
/** Exact content hashes are portable and contain no tracker paths or wall clock. */
function digest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Refusals deliberately carry no partial schedule that could be mistaken for success. */
function refuse(code, message, remedy) {
    return { ok: false, code, message, remedy };
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
export function computeResourceScenarios(rawCorpus, rawOptions, suppliedGraph) {
    const validated = validateDurationInput("resources", { corpus: rawCorpus, options: rawOptions, graph: suppliedGraph });
    if (!validated.ok)
        return validated;
    return runValidatedResources(validated);
}
/** Internal command adapter consumes the same immutable validation receipt as the public SDK. */
export function runValidatedResources(receipt, suppliedGraph) {
    const validated = durationValidatedValue("resources", receipt);
    if (!validated.ok)
        return validated;
    const { corpus, options } = validated.value;
    const checkedGraph = durationInputGraph(validated.value.graph, suppliedGraph);
    if (!checkedGraph.ok)
        return checkedGraph;
    const graph = checkedGraph.value ?? buildPrerequisiteGraph(corpus);
    const from = Date.parse(`${options.from}T00:00:00.000Z`), through = Date.parse(`${options.through}T00:00:00.000Z`), limit = options.limit ?? 20;
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
        if (scenarioIds.has(alternative.id) || Object.keys(alternative.work ?? {}).some((id) => !activeIds.has(id))) {
            return refuse("invalid_scenario", "Duplicate scenario or work override outside active scope.", "Use unique scenario ids and work overrides naming active tasks only.");
        }
        scenarioIds.add(alternative.id);
        const tasks = [];
        for (const item of active) {
            const override = ownDurationValue(alternative.work, item.id), owner = override?.owner ?? item.assignee, minutes = override?.minutes ?? item.estimated_minutes;
            if (owner === undefined || !Object.hasOwn(alternative.owners, owner) || minutes === undefined) {
                return refuse("missing_work", `Missing declared owner capacity or effort for ${item.id}.`, "Declare its assignee calendar and integer estimated minutes, or provide an explicit scenario work override; no estimates are invented.");
            }
            tasks.push({ id: item.id, owner, minutes, allocatedMinutes: 0, start: null, finish: null });
        }
        const capacity = new Map(Object.keys(alternative.owners).sort().map((owner) => [owner, budgets(ownDurationValue(alternative.owners, owner), horizon)]));
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
                const calendar = ownDurationValue(alternative.owners, task.owner), date = horizon[i];
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
        const selection = digest([revision, options.from, options.through, options.timeZone, alternative.id, [...capacity.keys()].map((owner) => [owner, ownDurationValue(alternative.owners, owner)]), tasks.map(({ id, owner, minutes }) => [id, owner, minutes])]);
        scenarios.push({ id: alternative.id, selection, feasible, outcome: feasible ? "feasible" : witnesses.length > 0 ? "capacity_infeasible" : "allocation_exhausted", remainingMinutes, itemCount: tasks.length, truncated: tasks.length > limit, items: tasks.slice(0, limit), witnesses });
    }
    return validateDurationOutput("resources", { ok: true, revision, activeCount: active.length, assumptions: ["civil-day-v1", `timeZone=${options.timeZone}`, "inclusive-horizon", "preemptive-minute-budgets", "successors-next-day", "stable-id-heuristic", "deadlines-observational; horizon-is-hard-limit"], scenarios });
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
    const checked = validateDurationOutput("resources", result);
    if (!checked.ok)
        return checked;
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