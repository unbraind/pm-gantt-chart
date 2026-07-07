# Changelog

## Unreleased

### Added

- Add SVG export, chart width control, and progress alias to gantt ([pm-gantt-chart-3dnj](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-3dnj.toon))

## 2026.7.6 - 2026-07-06

### Added

- Add structured JSON output format to the gantt exporter ([pm-gantt-chart-53tr](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-53tr.toon))
- Add --milestones markers to gantt chart and exports ([pm-gantt-chart-xqak](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-xqak.toon))
- Add schedule risk columns to Gantt CSV exports ([pm-gantt-chart-4a5d](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-4a5d.toon))
- preflight: data-sanity gate (hard-fail on dependency cycles, warn on soft issues) ([pm-gantt-chart-ayz2](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-ayz2.toon))
- Slack/float, infeasible-deadline flag, ASCII TODAY marker, HTML summary + assignee workload ([pm-gantt-chart-ao93](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-ao93.toon))
- Deepen gantt: scheduling, csv, sprint/release/status grouping, --to ([pm-gantt-chart-uscf](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-uscf.toon))
- Add --to date-window clip ([pm-gantt-chart-fotb](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-fotb.toon))
- Add sprint/release/status group-by keys ([pm-gantt-chart-f2mr](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-f2mr.toon))
- Add --critical-only filter (mark already existed) ([pm-gantt-chart-xkr0](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-xkr0.toon))
- Add CSV schedule export format (id,title,start,end,duration,deps,status) ([pm-gantt-chart-3reu](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-3reu.toon))
- Add gantt export (mermaid/html/ascii) + critical-path, assignee grouping, --from window ([pm-gantt-chart-q3zh](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-q3zh.toon))
- Hands-on functional test pass 2026-05-29 (real data) ([pm-gantt-chart-35p0](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-35p0.toon))
- Add publish retry + provenance fallback to release workflow ([pm-gantt-chart-qvnl](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-qvnl.toon))
- Add bun-install verification to release workflow ([pm-gantt-chart-cd9u](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-cd9u.toon))

### Changed

- Decision: estimate source = estimated_minutes via 8h workday; no capability change (exporter is under importers) ([pm-gantt-chart-g2pj](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/decisions/pm-gantt-chart-g2pj.toon))

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-gantt-chart-m3y4](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-m3y4.toon))
- Command handler threw plain Error (no exitCode) → runtime double-invocation ([pm-gantt-chart-hl8t](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-hl8t.toon))
- gantt: extension name typo pm-gantt-chart-chart ([pm-gantt-chart-dorh](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-dorh.toon))
- gantt: returns {error} (exit 0) on fetch failure + pollutes --json stdout ([pm-gantt-chart-80dm](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-80dm.toon))
- gantt: milestone grouping empty (pm has no milestone field; use sprint/release) ([pm-gantt-chart-f9cv](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-f9cv.toon))
- gantt: due dates ignored (read item.due_date, pm uses deadline) ([pm-gantt-chart-v0ry](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-v0ry.toon))
- gantt: --group-by ignored (kebab vs camelCase option key) ([pm-gantt-chart-76at](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-76at.toon))
- ci: fix release workflow step ordering ([pm-gantt-chart-y12r](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-y12r.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-gantt-chart-bkph](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-bkph.toon))
- Regenerate CHANGELOG after pm close item ([pm-gantt-chart-2r7k](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-2r7k.toon))
- Harden release readiness checks ([pm-gantt-chart-ws4i](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-ws4i.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-gantt-chart-yv1k](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-yv1k.toon))
- Decision: forward-schedule from anchor, back-anchor to reachable deadlines, chain may overrun deadline ([pm-gantt-chart-oy33](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/decisions/pm-gantt-chart-oy33.toon))
- Unit tests for scheduler, critical path, csv/mermaid renderers ([pm-gantt-chart-tc2y](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-tc2y.toon))
- Dependency-aware --schedule mode + --default-duration ([pm-gantt-chart-ifbx](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-ifbx.toon))
- Release readiness hardening for pm-gantt-chart ([pm-gantt-chart-41p5](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-41p5.toon))
