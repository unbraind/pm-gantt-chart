# pm-gantt-chart

Gantt chart renderer and multi-format exporter for [pm-cli](https://github.com/unbraind/pm-cli).

Renders your pm items as a week-by-week timeline in the terminal — grouped by milestone, sprint, release, assignee, status, type, or tag — and exports the same chart to **Mermaid `gantt`**, **standalone HTML**, **ASCII**, or a **CSV schedule**. Can compute and highlight the **critical path** (longest dependency chain), and run **dependency-aware scheduling** that derives each item's start/end from its blocked-by chain plus estimates.

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

```sh
pm install unbraind/pm-gantt-chart
```

Or from a local clone:

```sh
pm install ./path/to/pm-gantt-chart
```

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
```

### Export — `pm gantt export`

```sh
# Mermaid `gantt` diagram (default format) to stdout
pm gantt export

# Mermaid to a file
pm gantt export --format mermaid --output roadmap.mmd

# Standalone, self-contained HTML
pm gantt export --format html --output roadmap.html

# Plain ASCII (the same chart `pm gantt` prints)
pm gantt export --format ascii --output roadmap.txt

# CSV schedule: id,title,start,end,duration_days,deps,status
pm gantt export --format csv --schedule --output schedule.csv

# Export honors the same shaping flags (including --schedule / --critical-only)
pm gantt export --format html --group-by assignee --critical-path --weeks 12 --output team.html
pm gantt export --format mermaid --schedule --group-by sprint --output plan.mmd
```

The exporter writes to the file given by `--output`, or prints to stdout when omitted (handy for piping into a Mermaid live editor).

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

`pm gantt export` adds:

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--format <fmt>` | `mermaid` \| `html` \| `ascii` \| `csv` | `mermaid` | Output format |
| `--output <file>` | path | stdout | File to write (prints to stdout if omitted) |

`csv` emits a schedule table: `id,title,start,end,duration_days,slack_days,deps,status` (deps = space-separated blocking ids). Pair it with `--schedule` for dependency-derived dates and slack. `slack_days` is the total float in days (only populated under `--schedule`; blank otherwise): `0` marks a critical-path item, a positive value is how many days the task can slip without delaying the project, and a **negative** value means the plan is already late for a downstream deadline.

### Slack / float, critical path & infeasible deadlines

Under `--schedule`, a **backward pass** (classic CPM) computes each item's *latest* feasible start/finish from the project end and any downstream deadlines, then derives **total slack** = latest start − earliest start:

- **0 slack** → the item is on the critical path; any slip delays the project.
- **positive slack** → the item can slip that many days harmlessly.
- **negative slack** → the item's required start (to hit a downstream deadline) is *before* its earliest feasible start. The plan is **already late**. These items are listed in a `WARNING:` block on stderr by both `pm gantt` and `pm gantt export`, and flagged per-task in the JSON result (`tasks[].slack_days`, `tasks[].infeasible`, plus `infeasibleCount` / `warnings`).

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

### ASCII TODAY marker

The terminal chart draws a `▼TODAY` caret under the week column that contains the current date (parity with the Mermaid `%% today:` marker), shown only when "today" falls inside the chart window.

### HTML summary & assignee workload

The HTML export ends with a **Summary** footer — project span (start → end and day count), critical-path length, and total task-days. When exported with `--group-by assignee`, an additional **Assignee workload** table lists each assignee's total task-days (descending).

## How it works

- **Columns** — each column is one calendar week, starting from the Monday of the anchor week (`--from`, or the current week by default). `--to` clips the window and derives the week count.
- **Rows** — items are grouped by the chosen field; items with no value land in a `(no milestone)` / `(no sprint)` / `(no release)` / `(no type)` / `(unassigned)` / `(no tag)` group. `--group-by status` groups by lifecycle status.
- **Bars (default)** — a bar spans from the item's `created_at` to its `deadline`. If only a deadline is known, a one-week bar ending on it is shown. Items with no dates at all are shown as `··` (undated).
- **Bars (`--schedule`)** — a forward pass schedules each item to start the day after the latest item it is `blocked_by` finishes. Duration comes from `estimated_minutes` (8h workday, rounded up to whole days) or `--default-duration`. Items with a reachable `deadline` are back-anchored to end on it. The chain ordering, not the calendar, drives the bars — a late chain can push a dependent past its deadline, which is exactly what a schedule should expose.
- **Critical path** — with `--critical-path` (or `--critical-only`), the longest chain of `dependencies` edges is computed (cycle-safe), its items prefixed with `*` and drawn with `▓▓` bars. Ties break toward the chain with the latest final deadline. `--critical-only` drops every off-path item.
- **Symbols** — `██` = in_progress/blocked, `░░` = open/planned, `▓▓` = critical path, `··` = undated.

## Item fields used

Items are read via `pm list-all --json --include-body`.

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
| `dependencies[].id` (kind `blocked_by`) | Edges used for scheduling and the critical path |

## Development

```sh
npm install      # install dev dependencies
npm run build    # build TypeScript → dist/
npm test         # build + run smoke tests
npm run check    # tsc --noEmit
pm install .     # load the built extension locally
```

## Requirements

- pm-cli `>=2026.5.29`
- Node.js `>=20`

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
