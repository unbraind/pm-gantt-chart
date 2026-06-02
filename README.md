# pm-gantt-chart

Gantt chart renderer and multi-format exporter for [pm-cli](https://github.com/unbraind/pm-cli).

Renders your pm items as a week-by-week timeline in the terminal — grouped by milestone, type, assignee, or tag — and exports the same chart to **Mermaid**, **standalone HTML**, or **ASCII** files. Can compute and highlight the **critical path** (longest dependency chain).

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

# Group by assignee / type
pm gantt --group-by assignee
pm gantt --group-by type

# Show only in-progress items
pm gantt --status in_progress

# Anchor the window at a specific date
pm gantt --from 2026-06-01 --weeks 16

# Compute & mark the longest dependency chain
pm gantt --critical-path
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

# Export honors the same shaping flags
pm gantt export --format html --group-by assignee --critical-path --weeks 12 --output team.html
```

The exporter writes to the file given by `--output`, or prints to stdout when omitted (handy for piping into a Mermaid live editor).

## Options

Both `pm gantt` and `pm gantt export` accept the shaping flags:

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--weeks <n>` | 1–52 | `8` | Number of weeks to display |
| `--group-by <field>` | `milestone` \| `type` \| `assignee` \| `tag` | `milestone` | How to group items into rows |
| `--status <filter>` | `open` \| `in_progress` \| `blocked` \| `closed` \| `canceled` \| `draft` \| `all` | `all` | Filter items by status |
| `--from <iso>` | `YYYY-MM-DD` | current week | Anchor the chart window at this date |
| `--critical-path` | flag | off | Compute & mark the longest dependency chain |

`pm gantt export` adds:

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--format <fmt>` | `mermaid` \| `html` \| `ascii` | `mermaid` | Output format |
| `--output <file>` | path | stdout | File to write (prints to stdout if omitted) |

## How it works

- **Columns** — each column is one calendar week, starting from the Monday of the anchor week (`--from`, or the current week by default).
- **Rows** — items are grouped by the chosen field; items with no value land in a `(no milestone)` / `(no type)` / `(unassigned)` / `(no tag)` group.
- **Bars** — a bar spans from the item's `created_at` to its `deadline`. If only a deadline is known, a one-week bar ending on it is shown. Items with no dates at all are shown as `··` (undated).
- **Critical path** — with `--critical-path`, the longest chain of `dependencies` edges is computed (cycle-safe), its items prefixed with `*` and drawn with `▓▓` bars. Ties break toward the chain with the latest final deadline.
- **Symbols** — `██` = in_progress/blocked, `░░` = open/planned, `▓▓` = critical path, `··` = undated.

## Item fields used

Items are read via `pm list-all --json --include-body`.

| Field | Used for |
|-------|----------|
| `title` | Row label |
| `status` | Bar style and status symbol; also used with `--status` filter |
| `deadline` (or legacy `due_date`) | Right edge of the bar |
| `created_at` | Left edge of the bar |
| `sprint` / `release` / `milestone` | Group key for `--group-by milestone` (default) |
| `type` | Group key for `--group-by type` |
| `assignee` | Group key for `--group-by assignee` |
| `tags[0]` | Group key for `--group-by tag` |
| `dependencies[].id` | Edges used to compute the critical path |

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
