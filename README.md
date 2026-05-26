# pm-gantt-chart-chart

ASCII Gantt chart renderer for [pm-cli](https://github.com/unbraind/pm-cli).

Renders your pm items as a week-by-week timeline in the terminal, grouped by milestone, tag, or type.

## Example output

```
pm gantt  •  8 weeks from 2026-05-09
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GROUP               ITEM                      S   W1      W2      W3      W4      W5      W6      W7      W8
────────────────────────────────────────────────────────────────────────────────────────────────────────────
                    May 11  May 18  May 25  Jun  1  Jun  8  Jun 15  Jun 22  Jun 29
────────────────────────────────────────────────────────────────────────────────────────────────────────────
v1.0 Milestone      Auth system               ▶   ██      ██      ░░      ░░
                    User profile              ○           ░░      ░░      ░░
v2.0 Milestone      API redesign              ▶                           ██      ██      ██
(no milestone)      Fix typos                 ○   ··      ··      ··      ··      ··      ··      ··      ··
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Legend: ██ wip/blocked  ░░ todo/planned  ·· undated  S: ▶wip  !blocked  ✓done  ○todo
```

## Installation

```sh
pm ext install unbraind/pm-gantt-chart-chart
```

Or from a local clone:

```sh
pm ext install ./path/to/pm-cli-ext-gantt
```

## Usage

```sh
# Default: 8 weeks, grouped by milestone, all statuses
pm gantt

# Show 12 weeks
pm gantt --weeks 12

# Group by tag
pm gantt --group-by tag

# Group by item type
pm gantt --group-by type

# Show only in-progress items
pm gantt --status wip

# Show only todo items for the next 16 weeks
pm gantt --status todo --weeks 16

# Show only blocked items grouped by tag
pm gantt --status blocked --group-by tag
```

## Options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--weeks <n>` | 1–52 | `8` | Number of weeks to display in the chart |
| `--group-by <field>` | `milestone` \| `tag` \| `type` | `milestone` | How to group items into rows |
| `--status <filter>` | `todo` \| `wip` \| `blocked` \| `done` \| `all` | `all` | Filter items by status |

## How it works

- **Columns** — each column represents one calendar week, starting from the Monday of the current week
- **Rows** — items are grouped by the chosen field (milestone, tag, or type); items with no value go to a `(no milestone)` / `(no tag)` / `(no type)` group
- **Bars** — the bar spans from the item's creation date to its `due_date`. If only a due date is known, a one-week bar ending on that date is shown. Items with no dates at all are shown as `··` (undated) across all columns
- **Symbols** — `██` = wip or blocked (active work), `░░` = todo/planned, `··` = undated

## Item fields used

| Field | Used for |
|-------|----------|
| `title` | Row label |
| `status` | Bar style and status symbol; also used with `--status` filter |
| `due_date` | Right edge of the bar |
| `created_at` | Left edge of the bar |
| `milestone` | Group key when `--group-by milestone` (default) |
| `tags[0]` | Group key when `--group-by tag` |
| `type` | Group key when `--group-by type` |

## Development

```sh
# Install dev dependencies
npm install

# Build TypeScript → dist/
npm run build

# Load the built extension locally in pm-cli
pm ext install .
```

## Requirements

- pm-cli `>=2026.5.0`
- Node.js `>=18`

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
