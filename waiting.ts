import { certifyCompleteListResult, normalizeRawItemId, normalizeStatusInput, PmClient, readSettings, resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { analyzeRelationshipExecution, RelationshipGraph } from "@unbrained/pm-cli/sdk/graph";
import { buildPrerequisiteGraph, commandPrerequisiteGraph, type PmItem, type PrerequisiteGraph } from "./index.ts";
import { validateDurationInput, validateDurationOutput } from "./duration-input.ts";

/** One explicitly declared external wait after effort; absent bounds remain unknown. */
export interface ExternalWait { minMinutes?: number; maxMinutes?: number }

/** Preview declarations are local inputs, never tracker mutations or reservations. */
export interface EffortWaitingOptions { waits: Readonly<Record<string, ExternalWait>>; limit?: number }

/** Scheduling fields accept configured status names without restricting the native registry. */
export type EffortWaitingItem = Omit<PmItem, "status"> & { status: string };

/** Null is unknown, including an unknown predecessor; zero always means explicit zero. */
export interface EffortWaitingRow {
  id: string; effortMinutes: number | null; declaredWait: boolean;
  waitMinMinutes: number | null; waitMaxMinutes: number | null;
  elapsedMinMinutes: number | null; elapsedMaxMinutes: number | null;
  finishMinMinutes: number | null; finishMaxMinutes: number | null;
  role: "active" | "blocked" | "unknown";
}

/** Refusals are actionable and never contain a partial successful forecast. */
export interface EffortWaitingRefusal {
  ok: false; code: "invalid_estimate" | "invalid_graph" | "invalid_wait_target" | "preview_too_large" | "corpus_unavailable";
  message: string; remedy: string;
}

/** Counts cover all nonterminal work even when the returned rows are truncated. */
export type EffortWaitingResult = EffortWaitingRefusal | {
  ok: true; activeCount: number; waitingCount: number; unknownCount: number;
  knownEffortMinutes: number; totalEffortMinutes: number | null;
  finishMinMinutes: number | null; finishMaxMinutes: number | null;
  truncated: boolean; items: EffortWaitingRow[]; assumptions: string[];
};

/** Add only measured bounds, preserving unknowns instead of inventing zero waits. */
function add(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

/** Independent prerequisites can run in parallel; any unknown bound stays unknown. */
function latest(values: readonly (number | null)[]): number | null {
  return values.includes(null) ? null : Math.max(0, ...values as number[]);
}

/**
 * Separate capacity effort from serial external waits, then propagate elapsed
 * bounds through the SDK ordering kernel. This continuous-minute lower-bound
 * model does not allocate shared owners or decide core readiness.
 */
export function effortWaitingPreview(items: readonly EffortWaitingItem[], options: EffortWaitingOptions, registry: RuntimeStatusRegistry, suppliedGraph?: PrerequisiteGraph): EffortWaitingResult {
  const checked = validateDurationInput("waiting", { corpus: items, options, graph: suppliedGraph });
  if (!checked.ok) return checked;
  const input = checked.value;
  const corpus = input.corpus.map((item) => ({ ...item, id: normalizeRawItemId(item.id),
    dependencies: item.dependencies?.map((dep) => ({ ...dep, id: normalizeRawItemId(dep.id) })) }));
  const graph = input.graph === undefined ? buildPrerequisiteGraph(corpus as PmItem[]) : new Map(input.graph.map(([id, deps]) => [normalizeRawItemId(id), deps.map(normalizeRawItemId)]));
  const ids = new Set(corpus.map((item) => item.id));
  if (ids.size !== corpus.length || (input.graph !== undefined && input.graph.length !== graph.size) || graph.size !== ids.size || corpus.some((item) => !item.id || !graph.has(item.id)
    || item.dependencies?.some((dep) => !ids.has(dep.id))) || [...graph].some(([id, deps]) => !ids.has(id) || deps.some((dep) => !ids.has(dep) || dep === id))) {
    return { ok: false, code: "invalid_graph", message: "The preview needs unique identities and complete relationships.", remedy: "Read the complete corpus, resolve missing relationship targets and include a graph row for every item." };
  }
  const active = corpus.filter((item) => !registry.terminal_statuses.has(normalizeStatusInput(item.status, registry) ?? item.status)).sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
  const activeIds = new Set(active.map((item) => item.id));
  if (active.length > 200 || [...graph.values()].reduce((n, deps) => n + deps.length, 0) > 5000) {
    return { ok: false, code: "preview_too_large", message: "The preview exceeds its bounded execution budget.", remedy: "Use at most 200 nonterminal items, 2000 corpus items and 5000 ordering edges in a dependency-complete scope." };
  }
  const waits = new Map(Object.entries(input.options.waits).map(([id, wait]) => [normalizeRawItemId(id), wait]));
  if (waits.size !== Object.keys(input.options.waits).length || [...waits.keys()].some((id) => !activeIds.has(id))) {
    return { ok: false, code: "invalid_wait_target", message: "A wait names absent or terminal work.", remedy: "Use exact nonterminal ids from the SDK read; remove declarations for completed or canceled work." };
  }
  const prerequisites = new Map(active.map((item) => [item.id, [...new Set(graph.get(item.id)!.filter((id) => activeIds.has(id)))]]));
  const execution = analyzeRelationshipExecution(new RelationshipGraph([...activeIds], [...prerequisites].flatMap(([id, deps]) => deps.map((dep) => ({ source: dep, target: id, kind: "blocks" })))));
  if (!execution.acyclic) return { ok: false, code: "invalid_graph", message: "Active ordering cycle prevents elapsed forecasting.", remedy: "Resolve the ordering cycle through the core relationship commands and preview again." };
  const order = [...execution.order, ...active.map((item) => item.id).filter((id) => !execution.order.includes(id))];
  const byId = new Map(active.map((item) => [item.id, item]));
  const rows = new Map<string, EffortWaitingRow>();
  for (const id of order) {
    const item = byId.get(id)!, status = normalizeStatusInput(item.status, registry) ?? item.status;
    const role = registry.blocked_statuses.has(status) ? "blocked" : registry.active_statuses.has(status) ? "active" : "unknown";
    const wait = waits.get(id), effortMinutes = item.estimated_minutes ?? null;
    const waitMinMinutes = wait === undefined ? 0 : wait.minMinutes ?? null, waitMaxMinutes = wait === undefined ? 0 : wait.maxMinutes ?? null;
    const elapsedMinMinutes = add(effortMinutes, waitMinMinutes), elapsedMaxMinutes = add(effortMinutes, waitMaxMinutes);
    const deps = prerequisites.get(id)!.map((dep) => rows.get(dep)!);
    rows.set(id, { id, role, effortMinutes, declaredWait: wait !== undefined, waitMinMinutes, waitMaxMinutes, elapsedMinMinutes, elapsedMaxMinutes,
      finishMinMinutes: role === "unknown" ? null : add(latest(deps.map((dep) => dep.finishMinMinutes)), elapsedMinMinutes),
      finishMaxMinutes: role === "unknown" ? null : add(latest(deps.map((dep) => dep.finishMaxMinutes)), elapsedMaxMinutes) });
  }
  const all = active.map((item) => rows.get(item.id)!), limit = input.options.limit ?? 20;
  const knownEffortMinutes = all.reduce((sum, row) => sum + (row.effortMinutes ?? 0), 0);
  return validateDurationOutput("waiting", { ok: true as const, activeCount: all.length, waitingCount: all.filter((row) => row.declaredWait).length,
    unknownCount: all.filter((row) => row.finishMinMinutes === null || row.finishMaxMinutes === null).length,
    knownEffortMinutes, totalEffortMinutes: all.some((row) => row.effortMinutes === null) ? null : knownEffortMinutes,
    finishMinMinutes: latest(all.map((row) => row.finishMinMinutes)), finishMaxMinutes: latest(all.map((row) => row.finishMaxMinutes)),
    truncated: all.length > limit, items: all.slice(0, limit),
    assumptions: ["continuous-minute-offsets; not calendar dates", "one serial external wait after effort per item", "wait consumes zero capacity", "no declaration means zero declared wait; missing bounds are unknown", "unlimited parallel effort; use gantt resources for shared capacity", "core blockers decide readiness; use pm next", "terminal prerequisites satisfied", "read-only; ownership unchanged"] });
}

/** Read a certified native corpus through the supported host context, only when preview is requested. */
export async function previewEffortWaiting(pmRoot: string, options: EffortWaitingOptions): Promise<EffortWaitingResult> {
  let items: EffortWaitingItem[], registry: RuntimeStatusRegistry, graph: PrerequisiteGraph;
  try {
    const client = PmClient.forActiveExtensionHost({ pmRoot });
    items = certifyCompleteListResult(await client.listAllComplete()).items;
    registry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
    graph = await commandPrerequisiteGraph(items as PmItem[], pmRoot);
  } catch {
    return { ok: false, code: "corpus_unavailable", message: "Cannot certify the native scheduling corpus.", remedy: "Check tracker access and SDK complete-read/relationship contracts, then retry the read-only preview." };
  }
  return effortWaitingPreview(items, options, registry, graph);
}
