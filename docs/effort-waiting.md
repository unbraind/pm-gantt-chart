# Effort and external waits

Core blockers define readiness, resource scenarios allocate effort, and swarm
resources provide exclusive reservations. External wait bounds add elapsed-time
evidence to those existing contracts. Use `pm next` to choose actionable work
while a provider or human response is pending. A wait declaration never claims,
releases, reassigns, reminds or changes a task.

Save this example as `waits.json`, replacing both ids with real nonterminal
tasks. The example provider task's native estimate is 120 minutes:

```json
{
  "waits": {
    "project-provider": { "minMinutes": 2880, "maxMinutes": 2880 },
    "project-approval": {}
  },
  "limit": 20
}
```

```sh
pm gantt waiting --waits waits.json
pm gantt waiting --waits waits.json --json
```

`project-provider` uses 120 effort/capacity minutes; its local elapsed range is
3000..3000 minutes. `project-approval` declares an external wait with unknown
bounds, so its wait, elapsed and completion bounds are null. A minimum-only wait
preserves its lower bound and leaves its upper bound unknown. Unknowns propagate
independently through prerequisites. Independent tasks overlap in this model;
ordered work starts after all predecessors' effort **and** waits finish. The
project finish is the maximum completion offset, rather than the sum of parallel
tasks. Native completed/canceled prerequisites satisfy ordering according to
configured SDK terminal roles. Unknown/draft roles retain effort but have unknown
completion. A blocked role remains visible and does not itself declare a wait
duration or override readiness.

```ts
import { previewEffortWaiting } from "pm-gantt-chart";

const result = await previewEffortWaiting(".agents/pm", {
  waits: { "project-provider": { minMinutes: 2880, maxMinutes: 2880 } },
  limit: 20,
});
if (!result.ok) throw new Error(`${result.code}: ${result.remedy}`);
console.log(result.totalEffortMinutes, result.finishMinMinutes);
```

For an existing certified SDK read, `effortWaitingPreview(items, options,
statusRegistry, prerequisiteGraph?)` avoids acquiring another corpus. Resolve
the registry through `resolveRuntimeStatusRegistry(settings.schema)` and pass the
workspace's resolved prerequisite graph when extensions register ordering kinds.
The SDK-backed helper and CLI resolve that graph automatically. Older saved wait
inputs always evaluate against the current native read; they contain no frozen
mutation plan, idempotency key or target ownership.

Inputs use one strict declarative schema. Native ids, relationship ids, graph ids
and declaration keys use the same SDK raw-id normalizer (whitespace, case and
optional `#` shorthand); canonical collisions refuse. Use full ids including the
tracker prefix. Wait bounds are finite integer minutes
in 0..525600, ordered when both are supplied. Dense corpus/relationship arrays,
unique identities, complete references and an acyclic active graph are required.
The budget is 2000 corpus items, 200 nonterminal items, 5000 ordering edges and
200 wait declarations. `limit` is 1..200, default 20; the JSON controls file is at
most 256 KiB. Existing native effort values remain supported through the legacy
20-year ceiling, including one-second estimates; absent effort stays unknown.
New waits do not rewrite or normalize native estimates. All output numbers are
checked for finite values and their documented ranges before success. Native
text, owners, titles, raw histories and tracker paths are omitted from output.

| Refusal | Remedy |
| --- | --- |
| `invalid_estimate` | Supply valid dense data, finite bounded effort/wait values, ordered bounds and declared control keys. |
| `invalid_wait_target` | Use exact nonterminal ids from the current complete SDK read. |
| `invalid_graph` | Resolve missing identities, self prerequisites or ordering cycles; include every graph row. |
| `preview_too_large` | Reduce a dependency-complete scope to the execution budgets. |
| `corpus_unavailable` | Check SDK access and complete-read/relationship contracts, then retry. |

CLI refusals exit 2 and include a concrete remedy. Invalid declarations refuse
before producing any successful forecast; foreign tracker records are never
rewritten. There is no import, sync, journal, apply path or mutable shared state
in this feature. JSON/TOON are output transports, not native tracker import formats.

## Without git

The CLI and both SDK functions work in plain trackers with git absent from PATH.
Neither elapsed preview nor wait input replay requires repository discovery.
See [validation evidence](effort-waiting-validation.md) for the public-tracker
archive measurement and the seeded state-preservation/property coverage.
