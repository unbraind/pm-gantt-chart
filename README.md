# pm-gantt-chart

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/unbraind/pm-brand/5c80a2b707f3a00afe986e81e520843b86f3ee83/banners/pm-gantt-chart-dark.svg">
  <img src="https://raw.githubusercontent.com/unbraind/pm-brand/5c80a2b707f3a00afe986e81e520843b86f3ee83/banners/pm-gantt-chart.svg" alt="pm-gantt-chart · Triplicate">
</picture>

Gantt chart renderer for [pm-cli](https://github.com/unbraind/pm-cli) with ASCII, SVG, HTML and Mermaid exports, dependency-aware scheduling and Triplicate styling.

Renders your pm items as a week-by-week timeline in the terminal — grouped by milestone, sprint, release, assignee, status, type, or tag — and exports the same chart to **Mermaid `gantt`**, **standalone HTML**, **ASCII**, a **CSV schedule**, or **structured JSON**. Can compute and highlight the **critical path** (longest dependency chain), and run **dependency-aware scheduling** that derives each item's start/end from its blocked-by chain plus estimates.

## Example output

```
pm gantt  •  8 weeks from 2026-06-01  •  critical path marked
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GROUP               ITEM                       S  W1      W2      W3      W4      W5      W6      W7      W8
──────────────────────────────────────────────────────────────────────────────────────────
                                                  Jun  1  Jun  8  Jun 15  Jun 22  Jun 29  Jul  6  Jul 13  Jul 20
──────────────────────────────────────────────────────────────────────────────────────────
S1                  *Build endpoint           ▶   ▓▓      ▓▓
                    *Design API               ✓   ▓▓
S2                  *Release                   ○   ▓▓      ▓▓      ▓▓      ▓▓
                    Write docs                ○   ░░      ░░      ░░
                    *Integration tests        ○   ▓▓      ▓▓      ▓▓
(no milestone)      Backlog grooming          ○   ░░      ░░
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Legend: ██ in_progress/blocked  ░░ open/planned  ▓▓ critical-path (*)  ·· undated  S: ▶in_progress  !blocked  ✓closed  ○open
```

## Installation

Requires pm CLI `2026.10.20` or newer for locked scenario-selection guards.
Development and CI retain the existing exact pin at 2026.10.20;
the consumer floor is independently exercised by packed npm acceptance.

In a plain project directory, initialize a tracker and activate the published package:

```sh
npx -y @unbrained/pm-cli@2026.10.21 init --defaults --agent-guidance skip
npx -y @unbrained/pm-cli@2026.10.21 install npm:pm-gantt-chart@2026.10.20 --project
```

With Bun:

```sh
bunx @unbrained/pm-cli@2026.10.21 init --defaults --agent-guidance skip
bunx @unbrained/pm-cli@2026.10.21 install npm:pm-gantt-chart@2026.10.20 --project
```

Use the explicit `npm:` source: an owner/repository shorthand is interpreted as a
local path, not as a registry package.

### Without git

Rendering, scheduling and chart exports work with a plain-directory tracker;
no git repository or git executable is required. GitHub sync and changelog
commands based on tags need a git repository and their separate tools.

## Usage

### Terminal chart — `pm gantt`

```sh
# Default: 8 weeks, grouped by milestone, all statuses
pm gantt

# Show 12 weeks
pm gantt --weeks 12

# Group by sprint / release / assignee / status / type
pm gantt --group-by sprint
pm gantt --group-by release
pm gantt --group-by assignee
pm gantt --group-by status

# Show only in-progress items
pm gantt --status in_progress

# Anchor the window at a specific date, or clip it with --to
pm gantt --from 2026-06-01 --weeks 16
pm gantt --from 2026-06-01 --to 2026-08-01

# Dependency-aware scheduling: derive start/end from blocked-by chains + estimates
pm gantt --schedule
pm gantt --schedule --default-duration 3

# Compute & mark the longest dependency chain
pm gantt --critical-path

# Show only the critical path (great paired with --schedule)
pm gantt --critical-only --schedule

# Show each item's % complete on its bar
pm gantt --progress
# (or use the --show-progress alias)
pm gantt --show-progress

# Overlay fixed release/deadline dates as labeled vertical markers
pm gantt --milestones "v1.0=2026-06-30,v1.1=2026-08-15"
```

### Export — `pm gantt export`

```sh
# Mermaid `gantt` diagram (default format) to stdout. Use the global --quiet
# flag when piping so the CLI's command receipt is not appended to the artifact.
pm --quiet gantt export

# Mermaid to a file
pm gantt export --format mermaid --output roadmap.mmd

# Standalone, self-contained HTML
pm gantt export --format html --output roadmap.html

# Scalable Vector Graphic (SVG) — a self-contained vector render of the chart.
# Use --width to request the canvas width in pixels (default 1000, clamped 320..8192).
pm gantt export --format svg --width 1600 --output roadmap.svg

# Plain ASCII (the same chart `pm gantt` prints)
pm gantt export --format ascii --output roadmap.txt

# CSV schedule: id,title,start,end,duration_days,slack_days,deps,status,critical,progress_percent,overdue,off_window
pm gantt export --format csv --schedule --output schedule.csv

# Structured JSON schedule for agents / programmatic consumers
pm gantt export --format json --schedule --output schedule.json

# Export honors the same shaping flags (including --schedule / --critical-only)
pm gantt export --format html --group-by assignee --critical-path --weeks 12 --output team.html
pm gantt export --format mermaid --schedule --group-by sprint --output plan.mmd
```

The exporter writes to the file given by `--output`, or prints to stdout when omitted. For a clean pipe or redirect, invoke it as `pm --quiet gantt export …`; `--quiet` suppresses the CLI's trailing command receipt while retaining the exported artifact.

## Options

Both `pm gantt` and `pm gantt export` accept the shaping flags:

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--weeks <n>` | 1–52 | `8` | Number of weeks to display (ignored when `--to` is set) |
| `--group-by <field>` | `milestone` \| `sprint` \| `release` \| `type` \| `assignee` \| `status` \| `tag` | `milestone` | How to group items into rows |
| `--status <filter>` | `open` \| `in_progress` \| `blocked` \| `closed` \| `canceled` \| `draft` \| `all` | `all` | Filter items by status |
| `--from <iso>` | `YYYY-MM-DD` | current week | Anchor the chart window at this date |
| `--to <iso>` | `YYYY-MM-DD` | — | Clip the window to end at this date (derives the week count, overriding `--weeks`) |
| `--schedule` | flag | off | Dependency-aware scheduling: derive start/end from blocked-by chains + estimates |
| `--default-duration <days>` | integer ≥ 1 | `5` | Fallback duration for items with no estimate under `--schedule` |
| `--critical-path` | flag | off | Compute & mark the longest dependency chain |
| `--critical-only` | flag | off | Show only items on the critical path (implies critical-path computation) |
| `--progress` | flag | off | Show each item's **% complete** on its bar |
| `--show-progress` | flag | off | Alias for `--progress` — show each item's % complete on its bar |
| `--width <px>` | integer ≥ 1 | `1000` | Requested render width in pixels for **SVG** and **HTML** (clamped 320..8192; SVG expands when needed to preserve readable week columns; ignored by ASCII/Mermaid/CSV/JSON) |
| `--milestones <list>` | `name=YYYY-MM-DD,…` | — | Draw fixed release/deadline dates as labeled vertical markers on the timeline |

`pm gantt export` adds:

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--format <fmt>` | `mermaid` \| `html` \| `svg` \| `ascii` \| `csv` \| `json` | `mermaid` | Output format |
| `--output <file>` | path | stdout | File to write (prints to stdout if omitted) |

`json` emits the computed schedule as structured, machine-readable data — `window`, `options`, a `summary` (project span, critical-path length, total task-days, per-group workload), `milestones`, and an `items[]` array where each entry carries `id`, `title`, `type`, `status`, `group`, ISO `start`/`end`, `durationDays`, `slackDays`, `progress`, `critical`, `overdue`, `infeasible`, `offWindow`, and gating `deps`. Unlike `pm --json gantt` (which returns the rendered ASCII chart plus summary counts), this is the full per-item plan, so agents and scripts can reason about the schedule without parsing a chart or CSV. Output is deterministic (no embedded wall-clock), so identical input produces byte-identical JSON. Pair with `--schedule` for dependency-derived dates and slack.

`csv` emits a schedule table: `id,title,start,end,duration_days,slack_days,deps,status,critical,progress_percent,overdue,off_window` (deps = space-separated blocking ids). Pair it with `--schedule` for dependency-derived dates and slack. `slack_days` is the total float in days (only populated under `--schedule`; blank otherwise): `0` marks a critical-path item, a positive value is how many days the task can slip without delaying the project, and a **negative** value means the plan is already late for a downstream deadline. The trailing risk columns make the CSV useful directly in spreadsheets and portfolio reports: `critical`/`overdue` are `yes`/`no`, `progress_percent` is `0..100`, and `off_window` distinguishes `before`, `after`, and `undated` rows.

`svg` emits a self-contained, scalable vector graphic of the chart — the same grouped rows, week columns, status-colored bars, critical-path highlighting, overdue markers, off-window hints, today rule, milestone diamonds, and `--progress` fill as the HTML render, but as resolution-independent SVG primitives. Use `--width` to request the canvas width in pixels (default 1000, clamped to 320..8192). For long timelines the SVG expands beyond that request rather than clipping the chart, preserving a readable 24px minimum per week. The output is a single `<svg>` document (with an `<?xml?>` prologue) suitable for embedding in docs, slides, or websites, or for rendering at any zoom level without pixelation.

### Slack / float, critical path & infeasible deadlines

Under `--schedule`, a **backward pass** (classic CPM) computes each item's *latest* feasible start/finish from the project end and any downstream deadlines, then derives **total slack** = latest start − earliest start:

- **0 slack** → the item is on the critical path; any slip delays the project.
- **positive slack** → the item can slip that many days harmlessly.
- **negative slack** → the item's required start (to hit a downstream deadline) is *before* its earliest feasible start. The plan is **already late**. These items are listed in a `WARNING:` block on stderr by both `pm gantt` and `pm gantt export`, and flagged per-task in the JSON result (`tasks[].slack_days`, `tasks[].infeasible`, plus `infeasibleCount` / `warnings`).

### Minimal deadline repair proposals

`pm gantt repair` evaluates explicit changes for a fixed deadline. It returns the
fewest moves that make **every retained active item** feasible under the existing
forward/backward scheduler, including each item's own deadline. Repair feasibility
uses earliest starts rather than the chart's just-in-time deadline placement:
waiting until a later deadline must not create a need for extra capacity.
Closed/canceled prerequisites count as satisfied. It never writes items, estimates, deadlines,
dependencies, or plan decisions.

```sh
pm gantt repair --from 2026-10-21 --deadline 2026-10-22 \
  --capacity task-a=960 --defer task-b --forbid task-release --json
```

Only named offers are considered: `--capacity id=minutesPerDay,...` supplies
dedicated daily capacity for estimated work (baseline 480 minutes/day; offers
481..4800), and `--defer id,...` allows those exact items to leave this scenario.
No retained item may depend on deferred work. `--forbid id,...` overrides both.
Capacity availability is a caller-supplied assumption; this is a precedence and
calendar-day model, without shared-resource contention, weekends, or holidays.

Output uses the host's compact TOON by default or JSON with `--json`. Each
proposal includes exact `moves`, `affectedIds` (moved items plus items whose dates
change), recomputed `finish`/`retainedCount`, `deferredMinutes`, and
`addedMinutesPerDay`. Titles, bodies and full schedules are omitted.
`minimalChanges` is minimum **move count within the explicit vocabulary**;
ties prefer less deferred effort, then less added daily capacity, then stable
move order. `totalProposals` and `truncated` describe output limiting.

Bounds: 200 corpus items, 2000 ordering edges, 24 effective offers, 1..3 moves
(`--max-changes`, default 3), 1..10 results (`--max-proposals`, default 5), and
1..10000 evaluations (`--max-evaluations`, default 5000). Missing estimates use
`--default-duration` (default 5 calendar days, 1..365); they cannot receive a
capacity offer. Estimates must be zero or finite values from one second (1/60 minute) through 175200 minutes.
Cycles, missing prerequisites, malformed dates, invalid offers, oversized
scenarios, exhausted search and unavailable repairs return typed refusals with
`code`, `message`, `remedy` (CLI exit 2). Search exhaustion never presents an
uncertified minimum. An already feasible scenario returns zero changes and no
proposals. Full ISO tracker deadlines are accepted; CLI scenario days require
real `YYYY-MM-DD` values.

The typed SDK exports `proposeDeadlineRepairs(items, options, graph?)` and
`DeadlineRepairOptions`, `DeadlineRepairResult`, `DeadlineRepairProposal`,
`DeadlineRepairMove`, `DeadlineCapacityShift`, `DeadlineRepairRefusalCode`.
Pass a complete dependency-closed corpus. The optional graph uses the existing
`PrerequisiteGraph` contract for custom registry ordering; the CLI resolves
workspace registrations automatically. Core `plan decision` can record a chosen
proposal after review. See the [worked example](docs/deadline-repair.md).

### Without git

Rendering, scheduling, exports, duration calibration, uncertainty intervals and deadline repair proposals work in plain
trackers without git installed. This package's runtime commands do not require
a git repository. Repository release/changelog tooling needs git history.

Forecast and calibration APIs share one [strict duration input contract](docs/duration-input-contract.md).
Malformed estimates, sampling controls, calibration controls and native effort
fields return `invalid_estimate` with remedies before numerical work. Sparse
arrays, nonfinite numbers, negative zero, invalid dates and extra keys in closed
objects are refused.

Successful calibration and forecast results pass a numeric/date output contract
before SDK return or CLI serialization. Invalid computed fields return
`invalid_estimate` naming the field; ratios are never emitted as Infinity or null.
See the [documented domain and output ranges](docs/duration-input-contract.md).

### Observed-duration calibration

`pm gantt calibrate --type Task --minimum-samples 10 --json` compares elapsed
calendar minutes with planned effort at verified start, for an exact task class
and optional `--tag`. Default output is compact TOON. Canceled, reopened,
incomplete and unverifiable histories are disclosed; too few usable episodes
returns a typed refusal with remedies and no numerical calibration.

The typed SDK `calibrateObservedDurations(pmRoot, options)` returns deterministic
nearest-rank quantiles, complete sample counts, bounded diagnostics and an
explicit `{kind: "empirical", values: [...]}` duration population. Callers can
choose to pass it to `completionIntervals` with `minutesPerDay: 1440` for calendar
time. Estimates stay unchanged; elapsed time includes waits and makes no causal
productivity claim. See the [worked SDK/CLI example and evidence rules](docs/observed-duration-calibration.md).

### Resource-constrained schedule scenarios

`pm gantt resources --scenarios resources.json` compares explicitly named
alternatives with shared assignee capacity, weekday/holiday calendars and daily,
weekly and total minute limits. It returns bounded TOON (default) or `--json`,
per-item computed dates, numerical owner overload witnesses, counts and revision
receipts. Existing item dates stay unchanged. Calendar days use an explicit IANA
time zone and reproduce across host zones and daylight-saving weekends.

Explicit `--select`, `--selection`, `--expect-revision`, `--target` and
`--target-revision` record a feasible reviewed snapshot as a core note through
the SDK's journaled mutation and locked target revision check. Source changes
require recomputation. The allocator is a deterministic heuristic; exhaustion
without a capacity witness does not prove global infeasibility. Missing effort
or capacity refuses with a typed remedy. The typed SDK exports
`resourceScenarios`, `applyResourceSelection` and their calendar, alternative,
result, refusal and selection types. Everything works without git. See the
[worked example, bounds and selection semantics](docs/resource-scenarios.md).

### Completion intervals for agent plans

`pm gantt uncertainty` samples declared effort uncertainty over the existing
registry-aware prerequisite graph. Pass a JSON map of active item ids to bounded
minute ranges (`[480,2400]`), uniform distributions
(`{"kind":"uniform","min":480,"max":2400}`), triangular distributions
(`{"kind":"triangular","min":480,"mode":960,"max":2400}`), or fixed points
(`{"kind":"point","minutes":960}`). Unchanged recorded estimates are fixed
points; missing estimates and every dependent completion remain **unknown**.

```sh
pm gantt uncertainty --from 2026-10-22 --seed 42 --estimates estimates.json
pm gantt uncertainty --from 2026-10-22 --seed 42 --estimates estimates.json --json
```

Compact TOON (default) and JSON include project/per-item completion quantiles,
unknown counts, a sensitivity ranking and a complete scenario receipt. Defaults
are 2000 samples, probabilities 0.1/0.5/0.9, 480 effort minutes per calendar day
and 20 output rows. Override with `--samples`, `--quantiles`,
`--minutes-per-day`, and `--limit`. Quantile finishes are exclusive UTC instants;
continuous durations do not round up to whole days like the bar renderer.
Independent effort draws, unlimited parallel capacity and no holidays/resource
contention are explicit assumptions. Deadlines and creation dates do not postpone
earliest starts. This evaluates declared uncertainty and trains no model.

The receipt retains the algorithm version, unsigned 32-bit seed, resolved inputs,
normalized dependencies, controls, assumptions and SHA-256 input hash. Output
limits bound item/sensitivity rows while retaining all receipt inputs; counts
and `truncated` expose omissions. An unknown project finish suppresses project
quantiles and sensitivity. Otherwise `dominantEstimate` identifies the largest
absolute Pearson correlation between a sampled estimate and project finish.
This is linear association, not causal variance attribution; constants return
zero correlation. Monte Carlo quantiles and sensitivity are approximate.

Bounds: 200 corpus items, 2000 ordering edges, 100..10000 samples, at most
5,000,000 sample × (item + edge) operations, 1..200 output rows and 1..9 strictly
increasing probabilities in [0,1]. Effort is finite, ordered and within
zero or 1/60..175200 minutes; effort per day is 1..1440. `--estimates` must be a regular JSON
object file no larger than 64 KiB. Cycles, missing prerequisites, invalid inputs
and exceeded bounds return typed `code`, `message`, `remedy` refusals (exit 2).
The command does not mutate tracker documents or write the receipt implicitly.

The typed SDK exports `completionIntervals(items, options, graph?)`,
`CompletionIntervalOptions`, `CompletionIntervalResult`, `UncertainEstimate`,
`CompletionScenarioReceipt` and related quantile/refusal types. It reuses the
SDK execution kernel and the package's registry-aware graph adapter. Supply a
complete dependency-closed corpus; the CLI certifies its full read and resolves
custom workspace ordering automatically. See the [worked example and receipt
replay](docs/uncertainty-intervals.md).

### Preflight data-sanity gate

Before rendering, both `pm gantt` and `pm gantt export` run a **preflight data-sanity gate** so bad data surfaces early instead of producing a silently-confusing chart. It splits problems into two tiers:

- **Hard-fail (blocks, non-zero exit)** — a **dependency cycle**. A cycle has no valid topological order, so dependency-aware scheduling is impossible and any chart drawn from it would be plausible-looking but wrong. The command aborts with a clear error naming the full cycle path, e.g.:

  ```
  gantt: 1 fatal data problem(s) make scheduling impossible:
    • dependency cycle: pm-a "Design" → pm-b "Build" → pm-a "Design"
  Resolve the dependency cycle(s) above and re-run.
  ```

- **Warn (non-blocking, stderr; chart still renders, exit 0)** — soft issues that still yield a useful chart: a **deadline that precedes the item's own start date**, and an **implausibly large estimate** (over ~2000h, almost always a minutes-vs-hours unit error). These print a `NOTE:` block on stderr and are suppressed under `--json` to keep machine-readable output clean.

Fully valid data produces no warnings and no block. (Infeasible/unreachable *downstream* deadlines are a separate, lighter signal — they are flagged in the schedule's backward pass rather than by this gate; see above.)

### TODAY marker (all formats)

The current week is indicated in every format, shown only when "today" falls inside the chart window:

- **ASCII** — a `▼TODAY` caret under the week column that contains the current date.
- **Mermaid** — a `%% today: <date>` comment.
- **HTML** — the matching week column is highlighted with a red vertical rule and a `▼ today` label in the header.

### `--milestones` — fixed release/deadline dates

Items are *scheduled* work; **milestones** are immovable calendar targets (a release, a launch, a contractual deadline). In cross-functional views that aren't grouped by milestone, those dates are otherwise invisible. `--milestones` overlays them as labeled vertical markers so deadline pressure is obvious at a glance.

Pass a comma-separated list of `name=YYYY-MM-DD` entries:

```sh
pm gantt --milestones "v1.0=2026-06-30,v1.1=2026-08-15"
```

- **ASCII** — a `▼<name>` caret in the week column the milestone lands in (parity with the `▼TODAY` marker). Multiple milestones in the same week are comma-joined (`▼v1.0,beta`).
- **Mermaid** — a dedicated `section Milestones` with native zero-duration `:milestone` markers on the exact date, so they render as the diamond marker.
- **CSV** — appended rows (`id=milestone:<name>`, `status=milestone`, `start`=`end`=date) so the dates round-trip alongside the schedule.

Milestones outside the rendered window are ignored on the chart/Mermaid output, with a one-line note on **stderr** (CSV still includes them so the data round-trips). Malformed entries (missing `=`, empty name, or a non-ISO date) fail cleanly with a usage error rather than crashing. The same flag is honored by `pm gantt export`.

### `--progress` — % complete on bars

`--progress` (opt-in) renders each item's completion ratio on its bar. The ratio is derived deterministically from available pm signals:

- **closed / canceled** → 100%
- an explicit `meta.progress` / `meta.percent_complete` number (a `0..1` fraction or a `0..100` percent) → honored verbatim
- an **acceptance-criteria checklist** in the body (`- [x]` vs `- [ ]`) → checked / total
- **in_progress** with no other signal → 50% (a "halfway" default); **blocked** → 25%
- everything else (open / draft) → 0%

It surfaces as a trailing `NN%` plus a coarse fill glyph in ASCII (`·· 0% · ░░ 25% · ▓░ 50% · ▓▓ 75% · ██ 100%`), as a `%% tN progress:` comment in Mermaid (the diagram has no native per-task percent field), as a width-sized fill overlay plus a `NN%` label in HTML, and as `progress_percent` in CSV.

### Overdue / deadline-risk highlighting

Items whose `deadline` is **before today** and that are **not** closed/canceled are flagged automatically (no flag needed):

- **ASCII** — a trailing `‼ OVERDUE` marker on the row.
- **Mermaid** — the task carries the `crit` tag (the diagram's deadline-risk styling) plus an `%% overdue:` comment.
- **HTML** — the bar gets a red striped fill, the due date turns red, and the row label shows a `‼ overdue` marker.

Overdue items are also counted in the JSON result (`overdueCount`, `overdue[]`) and listed in a `NOTE:` block on stderr (suppressed under `--json`).

### Off-window vs. undated items

A genuinely **undated** item (no dates at all) and an item whose dates fall **entirely outside** the chart window used to look identical (both `··`). They are now distinguished:

- **undated** → `··` (ASCII) / a hatched cell (HTML).
- **off-window earlier** → `←·` (ASCII) / a `←` hint in the first column (HTML).
- **off-window later** → `·→` (ASCII) / a `→` hint in the last column (HTML).

The JSON result reports `offWindowCount` and `undatedCount`. Mermaid is unaffected (it always renders real dates).

### ASCII TODAY marker

The terminal chart draws a `▼TODAY` caret under the week column that contains the current date (parity with the Mermaid `%% today:` marker and the HTML today column), shown only when "today" falls inside the chart window.

### HTML summary & assignee workload

The HTML export ends with a **Summary** footer — project span (start → end and day count), critical-path length, and total task-days. When exported with `--group-by assignee`, an additional **Assignee workload** table lists each assignee's total task-days (descending).

## How it works

- **Columns** — each column is one calendar week, starting from the Monday of the anchor week (`--from`, or the current week by default). `--to` clips the window and derives the week count.
- **Rows** — items are grouped by the chosen field; items with no value land in a `(no milestone)` / `(no sprint)` / `(no release)` / `(no type)` / `(unassigned)` / `(no tag)` group. `--group-by status` groups by lifecycle status.
- **Bars (default)** — a bar spans from the item's `created_at` to its `deadline`. If only a deadline is known, a one-week bar ending on it is shown. Items with no dates at all are shown as `··` (undated).
- **Bars (`--schedule`)** — a forward pass schedules each item after its registry-defined prerequisites finish. `A blocks B` and `B blocked_by A` both put A before B; equivalent inverse rows are deduplicated. Active extension kinds use their declared ordering and precedence. Association, implementation, provenance, temporal, and unknown kinds remain context without ordering work. Duration comes from `estimated_minutes` (8h workday, rounded up to whole days) or `--default-duration`. Items with a reachable `deadline` are back-anchored to end on it. The chain ordering, not the calendar, drives the bars — a late chain can push a dependent past its deadline, which is exactly what a schedule should expose.
- **Critical path** — with `--critical-path` (or `--critical-only`), the longest chain of `dependencies` edges is computed (cycle-safe), its items prefixed with `*` and drawn with `▓▓` bars. Ties break toward the chain with the latest final deadline. `--critical-only` drops every off-path item.
- **Symbols** — `██` = in_progress/blocked, `░░` = open/planned, `▓▓` = critical path, `··` = undated, `←·` / `·→` = off-window (dates earlier / later than the window), `‼ OVERDUE` = past deadline & not closed.

## Item fields used

Items are read via canonical `pm list --all --json` with bodies, strict source
reads, full projection, no truncation, and both universal output bounds set to
`unbounded`. The public pm SDK certifies source, filter, pagination,
projection, count, and identity receipts; pm-gantt-chart adds narrow
fail-closed checks for unreadable counters and omission/read-output evidence
not yet covered by SDK 2026.8.21. A partial or unverifiable workspace read
exits non-zero instead of drawing a plausible-looking chart with missing work.

| Field | Used for |
|-------|----------|
| `title` | Row label |
| `status` | Bar style and status symbol; also used with `--status` filter |
| `deadline` (or legacy `due_date`) | Right edge of the bar; back-anchor target under `--schedule` |
| `created_at` | Left edge of the bar (default mode) |
| `estimated_minutes` | Task duration under `--schedule` (8h workday) |
| `sprint` / `release` / `milestone` | Group key for `--group-by milestone` (default), `sprint`, `release` |
| `type` | Group key for `--group-by type` |
| `assignee` | Group key for `--group-by assignee` |
| `status` | Group key for `--group-by status`; also bar style |
| `tags[0]` | Group key for `--group-by tag` |
| `dependencies[].id` (registry `ordering: true`) | Normalized prerequisites used for scheduling, cycles, critical path, slack, and CSV/JSON exports |

## Development

```sh
npm install      # install dev dependencies
npm run build    # build TypeScript → dist/
npm test         # build + run smoke tests
npm run check    # tsc --noEmit
pm install .     # load the built extension locally
```

## Requirements

- pm-cli `>=2026.10.20`
- Node.js `>=22.18.0`

## License

MIT

## Release Automation

The repository release gate runs type checking, build, coverage, docstrings,
production dependency audit, package packing, and unbounded pm-changelog
validation. It also installs the real tarball into fresh npm/npx and Bun/bunx
projects on the pinned 2026.10.20 host and into npm/npx on the declared
2026.10.20 minimum, then executes both `pm gantt` and `pm --quiet gantt export
--format json` against real tracker data. The daily workflow publishes at most
once when commits exist after the latest release tag. These technical gates do
not override repository-owned privacy or all-source coverage blockers.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.


## Triplicate visual identity

Visual exports use build-time values from the exact `pm-brand` development pin:
form paper, carbon ink, ruled item sheets and explicit status fills. Portable font
stacks put Archivo, Public Sans and Martian Mono first and fetch no external fonts.
[Design, themes, token parity and reproducible review renders](docs/triplicate-visuals.md).
The README banner embeds pm-brand's committed output at an immutable SHA.
