import { createHash } from "node:crypto";
import { resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { buildPrerequisiteGraph, type PmItem, type PrerequisiteGraph } from "./index.ts";
import { computeResourceScenarios, type ResourceCalendar, type ResourceScenarioOptions, type ResourceScheduleRow } from "./resources.ts";
import { ownDurationValue, validateDurationInput, validateDurationOutput } from "./duration-input.ts";

/** Scheduling projection only: native status roles are resolved by the SDK at capture time. */
export interface ScheduleTask {
  id: string; status: string; role: "active" | "terminal" | "unknown";
  owner?: string; minutes?: number; prerequisites: readonly string[]; deadline?: string;
}
/** Portable saved engine inputs, without titles, bodies, paths, capture times or cached computed dates. */
export interface ScheduleSnapshot {
  version: 1; from: string; through: string; timeZone: string;
  tasks: readonly ScheduleTask[]; owners: Readonly<Record<string, ResourceCalendar>>;
}
/** Output row limit; computations always use the entire bounded pair. */
export interface ScheduleDriftOptions { limit?: number }
/** Strict input and work-budget refusals carry a recovery action. */
export interface ScheduleDriftRefusal { ok: false; code: "invalid_estimate" | "invalid_scenario" | "comparison_too_large"; message: string; remedy: string }
/** Unsupported evidence remains explicit and never becomes an attributed cause. */
export interface ScheduleGap { code: string; ids: string[]; remedy: string }
/** A reversible scheduling input change; unchanged changes are not listed as causes. */
export interface ScheduleChange { id: string; kind: "estimate" | "owner" | "calendar" | "prerequisites"; target: string; before: string | number | readonly string[] | ResourceCalendar | null; after: string | number | readonly string[] | ResourceCalendar | null }
/** A counterfactual witness, not an additive share of the overall date delta. */
export interface ScheduleCause { change: string; restoredFinish: string | null; effectDays: number | null; chain: string[] }
/** Each moved goal retains its exact civil-day delta and the witnessed causal routes. */
export interface ScheduleMovedRow { id: string; before: string | null; after: string | null; deltaDays: number | null; causes: ScheduleCause[]; gaps: string[] }
/** Compact agent output keeps unchanged rows as references to the earlier snapshot. */
export interface ScheduleDriftSuccess {
  ok: true; before: string; after: string; method: "individual-reversal-v1"; evaluations: number;
  counts: { tasks: number; moved: number; unchanged: number; gaps: number; returned: number }; truncated: boolean;
  unchanged: { snapshot: string; ids: string[] }; changes: ScheduleChange[]; moved: ScheduleMovedRow[]; gaps: ScheduleGap[];
}
/** Public read-only comparison contract. */
export type ScheduleDriftResult = ScheduleDriftSuccess | ScheduleDriftRefusal;

/** Validate imported JSON values with the exact schema used by the snapshot producer. */
export function validateScheduleSnapshot(raw: unknown) {
  return validateDurationInput("snapshot", raw);
}

/** Capture one explicit alternative using configured status roles and resolved prerequisite ordering. */
export function captureScheduleScenario(items: readonly (Omit<PmItem, "status"> & { status: string })[], options: ResourceScenarioOptions,
  registry: ReturnType<typeof resolveRuntimeStatusRegistry>, graph?: PrerequisiteGraph): { ok: true; snapshot: ScheduleSnapshot } | ScheduleDriftRefusal {
  const checked = validateDurationInput("resources", { corpus: items, options, graph });
  if (!checked.ok) return checked;
  if (checked.value.options.scenarios.length !== 1) return { ok: false, code: "invalid_scenario", message: "Capture requires exactly one alternative.", remedy: "Choose one alternative explicitly, then save it before comparing." };
  const input = checked.value, alternative = input.options.scenarios[0];
  const resolved = input.graph === undefined ? buildPrerequisiteGraph(input.corpus) : new Map(input.graph);
  if (resolved.size !== input.corpus.length || input.corpus.some((item) => !resolved.has(item.id))) return {
    ok: false, code: "invalid_scenario", message: "Saved prerequisite graph is incomplete.", remedy: "Supply every corpus id in the resolved graph, including rows with no prerequisites." };
  const ids = new Set(input.corpus.map((item) => item.id));
  if (ids.size !== input.corpus.length || input.corpus.some((item) => item.dependencies?.some((dep) => !ids.has(dep.id)))
    || Object.keys(alternative.work ?? {}).some((id) => !ids.has(id))) return { ok: false, code: "invalid_scenario",
    message: "Unresolved identities or work overrides cannot be saved.", remedy: "Read the complete corpus and resolve every relationship and work override target before capture." };
  const tasks = input.corpus.map((item): ScheduleTask => {
    const override = ownDurationValue(alternative.work, item.id);
    const owner = override?.owner ?? item.assignee, minutes = override?.minutes ?? item.estimated_minutes;
    return { id: item.id, status: item.status,
      role: registry.terminal_statuses.has(item.status) ? "terminal" : registry.active_statuses.has(item.status) ? "active" : "unknown",
      ...(owner === undefined ? {} : { owner }), ...(minutes === undefined ? {} : { minutes }),
      prerequisites: [...new Set(resolved.get(item.id)!)].sort(),
      ...((item.deadline ?? item.due_date) === undefined ? {} : { deadline: item.deadline ?? item.due_date }),
    };
  });
  return validateDurationOutput("snapshot", { ok: true as const, snapshot: { version: 1 as const, from: input.options.from,
    through: input.options.through, timeZone: input.options.timeZone, tasks, owners: alternative.owners } });
}

/** Compare UTF-16 code units independently of the host locale. */
function compareText(a: string, b: string): number { return a < b ? -1 : Number(a > b); }

/** Stable semantic serialization ignores dictionary, weekday, holiday and prerequisite ordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** References bind portable evidence rather than live tracker state. */
function reference(snapshot: ScheduleSnapshot): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

/** Reconstruct only interpreted fields and delegate every computed date to the existing engine. */
function evaluate(snapshot: ScheduleSnapshot) {
  if (snapshot.tasks.some((task) => task.role === "unknown")) return { ok: false as const, code: "unknown_status_role" as const,
    message: "A saved status has no scheduling role.", remedy: "Configure active or terminal roles in the SDK status registry and capture again; no dates were inferred for unknown roles." };
  if (snapshot.tasks.some((task) => task.prerequisites.includes(task.id))) return { ok: false as const, code: "invalid_graph" as const,
    message: "A saved task is its own prerequisite.", remedy: "Remove the self-ordering constraint and capture the complete scenario again." };
  const items = snapshot.tasks.map((task): PmItem => ({ id: task.id, title: task.id, status: task.role === "terminal" ? "closed" : "open",
    ...(task.owner === undefined ? {} : { assignee: task.owner }), ...(task.minutes === undefined ? {} : { estimated_minutes: task.minutes }) }));
  return computeResourceScenarios(items, { from: snapshot.from, through: snapshot.through, timeZone: snapshot.timeZone, limit: 200,
    scenarios: [{ id: "saved", owners: snapshot.owners }] }, new Map(snapshot.tasks.map((task) => [task.id, task.prerequisites])));
}

/** Exact integer civil-day differences; null dates retain a gap instead of an invented delta. */
function delta(before: string | null, after: string | null): number | null {
  return before === null || after === null ? null : (Date.parse(after) - Date.parse(before)) / 86400000;
}

/** Compute all causal routes once per edit; prerequisite routes precede shared-resource routes. */
function routes(snapshot: ScheduleSnapshot, sources: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>(), tasks = snapshot.tasks.filter((task) => task.role === "active").sort((a, b) => compareText(a.id, b.id));
  for (const contention of [false, true]) {
    const roots = sources.filter((source) => tasks.some((task) => task.id === source));
    const queue = roots.sort(compareText).map((source) => [source]), seen = new Set(roots);
    for (const path of queue) {
      const id = path[path.length - 1];
      if (!result.has(id)) result.set(id, path);
      const task = tasks.find((task) => task.id === id)!;
      for (const next of tasks) {
        if (!seen.has(next.id) && (next.prerequisites.includes(id) || (contention && task.owner === next.owner))) {
          seen.add(next.id); queue.push([...path, next.id]);
        }
      }
    }
  }
  return result;
}

/** One reversible edit and its affected task roots. */
interface Reversal { change: ScheduleChange; snapshot: ScheduleSnapshot; sources: string[] }

/** Enumerate individually reversible edits in stable order without assuming their effects add. */
function reversals(before: ScheduleSnapshot, after: ScheduleSnapshot): Reversal[] {
  const changes: Reversal[] = [];
  for (const task of [...after.tasks].sort((a, b) => compareText(a.id, b.id))) {
    const previous = before.tasks.find((row) => row.id === task.id);
    if (previous === undefined) continue;
    for (const [field, kind] of [["minutes", "estimate"], ["owner", "owner"], ["prerequisites", "prerequisites"]] as const) {
      if (canonical(previous[field]) === canonical(task[field])) continue;
      const restored = { ...task, [field]: previous[field] };
      // Undefined optional fields are absent in the shared strict schema.
      const snapshot = { ...after, tasks: after.tasks.map((row) => row.id === task.id ? restored : row) };
      changes.push({ change: { id: `c${changes.length + 1}`, kind, target: task.id, before: previous[field] ?? null, after: task[field] ?? null }, snapshot, sources: [task.id] });
    }
  }
  for (const owner of [...new Set([...Object.keys(before.owners), ...Object.keys(after.owners)])].sort()) {
    const previous = ownDurationValue(before.owners, owner), current = ownDurationValue(after.owners, owner);
    if (canonical(previous) === canonical(current)) continue;
    const owners = new Map(Object.entries(after.owners));
    if (previous === undefined) owners.delete(owner); else owners.set(owner, previous);
    changes.push({ change: { id: `c${changes.length + 1}`, kind: "calendar", target: owner, before: previous ?? null, after: current ?? null },
      snapshot: { ...after, owners: Object.fromEntries(owners) }, sources: after.tasks.filter((row) => row.owner === owner).map((row) => row.id) });
  }
  return changes;
}

/** Compare two saved scenarios; individual reversals witness causes, never infer them from correlation. */
export function explainScheduleDrift(rawBefore: ScheduleSnapshot, rawAfter: ScheduleSnapshot, rawOptions: ScheduleDriftOptions = {}): ScheduleDriftResult {
  const checked = validateDurationInput("drift", { before: rawBefore, after: rawAfter, options: rawOptions });
  if (!checked.ok) return checked;
  const { before, after, options } = checked.value;
  const beforeRef = reference(before), afterRef = reference(after), gaps: ScheduleGap[] = [];
  const gap = (code: string, ids: string[], remedy: string) => gaps.push({ code, ids, remedy });
  if (before.from !== after.from || before.through !== after.through || before.timeZone !== after.timeZone) gap("different_horizon", [], "Capture both scenarios with the same horizon and civil time zone for causal attribution.");
  if (canonical(before.tasks.map((row) => ({ id: row.id, role: row.role }))) !== canonical(after.tasks.map((row) => ({ id: row.id, role: row.role })))) gap("scope_or_role_changed", [], "Keep item scope and resolved status roles fixed when attributing scheduling inputs.");
  for (const task of after.tasks) {
    const previous = before.tasks.find((row) => row.id === task.id);
    if (previous && previous.deadline !== task.deadline) gap("observational_deadline", [task.id], "Deadlines are observational in this engine; use a deadline-feasibility analysis for their consequences.");
  }
  const initial = evaluate(before), current = evaluate(after);
  let evaluations = 2;
  if (!initial.ok || !current.ok) {
    for (const [snapshot, result] of [[before, initial], [after, current]] as const) if (!result.ok) {
      gap(result.code, snapshot.tasks.filter((task) => task.role === "unknown").map((task) => task.id), result.remedy);
    }
    return validateDurationOutput("drift", { ok: true as const, before: beforeRef, after: afterRef, method: "individual-reversal-v1" as const, evaluations,
      counts: { tasks: after.tasks.length, moved: 0, unchanged: 0, gaps: gaps.length, returned: 0 }, truncated: false,
      unchanged: { snapshot: beforeRef, ids: [] }, changes: [], moved: [], gaps });
  }
  const edits = reversals(before, after);
  if (edits.length > 32) return { ok: false, code: "comparison_too_large", message: "More than 32 changed scheduling inputs.", remedy: "Compare intermediate saved scenarios with at most 32 changed task fields or owner calendars." };
  const prior = new Map(initial.scenarios[0].items.map((row) => [row.id, row]));
  const unchanged: string[] = [], moved: ScheduleMovedRow[] = [];
  for (const row of current.scenarios[0].items) {
    const old = prior.get(row.id);
    if (old && old.finish === row.finish && row.finish !== null) { unchanged.push(row.id); continue; }
    moved.push({ id: row.id, before: old?.finish ?? null, after: row.finish, deltaDays: delta(old?.finish ?? null, row.finish), causes: [], gaps: [] });
  }
  const comparable = gaps.every((row) => row.code === "observational_deadline");
  if (comparable) for (const edit of edits) {
    const replay = evaluate(edit.snapshot); evaluations++;
    if (!replay.ok) { gap("counterfactual_unavailable", [edit.change.target], replay.remedy); continue; }
    const restored = new Map<string, ResourceScheduleRow>(replay.scenarios[0].items.map((row) => [row.id, row]));
    const afterRoutes = routes(after, edit.sources), beforeRoutes = routes(before, edit.sources);
    for (const row of moved) {
      const witness = restored.get(row.id);
      if (!witness || witness.finish === row.after) continue;
      const chain = [afterRoutes.get(row.id), beforeRoutes.get(row.id)].filter((path): path is string[] => path !== undefined).sort((a, b) => a.length - b.length)[0];
      if (chain) row.causes.push({ change: edit.change.id, restoredFinish: witness.finish, effectDays: delta(witness.finish, row.after), chain });
    }
  }
  for (const row of moved) {
    if (row.deltaDays === null) row.gaps.push("unfinished_or_absent");
    if (!comparable || row.causes.length === 0) row.gaps.push("unattributed_or_joint_effect");
  }
  const limit = options.limit ?? 20;
  return validateDurationOutput("drift", { ok: true as const, before: beforeRef, after: afterRef, method: "individual-reversal-v1" as const, evaluations,
    counts: { tasks: after.tasks.length, moved: moved.length, unchanged: unchanged.length, gaps: gaps.length + moved.reduce((n, row) => n + row.gaps.length, 0), returned: Math.min(limit, moved.length) },
    truncated: moved.length > limit, unchanged: { snapshot: beforeRef, ids: unchanged }, changes: edits.map((edit) => edit.change), moved: moved.slice(0, limit), gaps });
}
