# Changelog

## 2026.06.07 - 2026-06-07

### Added

- Add schedule risk columns to Gantt CSV exports ([pm-gantt-chart-4a5d](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-4a5d.toon))

### Other

- Harden release readiness checks ([pm-gantt-chart-ws4i](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-ws4i.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-gantt-chart-yv1k](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-yv1k.toon))

## 2026.06.04-1 - 2026-06-04

### Added

- preflight: data-sanity gate \(hard-fail on dependency cycles, warn on soft issues\) ([pm-gantt-chart-ayz2](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-ayz2.toon))

## 2026.06.04 - 2026-06-04

### Added

- Slack/float, infeasible-deadline flag, ASCII TODAY marker, HTML summary + assignee workload ([pm-gantt-chart-ao93](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-ao93.toon))

## 2026.06.03 - 2026-06-02

### Added

- Deepen gantt: scheduling, csv, sprint/release/status grouping, --to ([pm-gantt-chart-uscf](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-uscf.toon))
- Add --to date-window clip ([pm-gantt-chart-fotb](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-fotb.toon))
- Add sprint/release/status group-by keys ([pm-gantt-chart-f2mr](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-f2mr.toon))
- Add --critical-only filter \(mark already existed\) ([pm-gantt-chart-xkr0](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-xkr0.toon))
- Add CSV schedule export format \(id,title,start,end,duration,deps,status\) ([pm-gantt-chart-3reu](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-3reu.toon))

### Changed

- Decision: estimate source = estimated\_minutes via 8h workday; no capability change \(exporter is under importers\) ([pm-gantt-chart-g2pj](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/decisions/pm-gantt-chart-g2pj.toon))

### Other

- Decision: forward-schedule from anchor, back-anchor to reachable deadlines, chain may overrun deadline ([pm-gantt-chart-oy33](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/decisions/pm-gantt-chart-oy33.toon))
- Unit tests for scheduler, critical path, csv/mermaid renderers ([pm-gantt-chart-tc2y](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-tc2y.toon))
- Dependency-aware --schedule mode + --default-duration ([pm-gantt-chart-ifbx](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-ifbx.toon))

## 2026.06.02 - 2026-06-02

### Added

- Add gantt export \(mermaid/html/ascii\) + critical-path, assignee grouping, --from window ([pm-gantt-chart-q3zh](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-q3zh.toon))

## 2026.06.01 - 2026-06-01

### Fixed

- Command handler threw plain Error \(no exitCode\) → runtime double-invocation ([pm-gantt-chart-hl8t](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-hl8t.toon))

## 2026.05.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-gantt-chart-35p0](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-35p0.toon))

### Fixed

- gantt: extension name typo pm-gantt-chart-chart ([pm-gantt-chart-dorh](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-dorh.toon))
- gantt: returns {error} \(exit 0\) on fetch failure + pollutes --json stdout ([pm-gantt-chart-80dm](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-80dm.toon))
- gantt: milestone grouping empty \(pm has no milestone field; use sprint/release\) ([pm-gantt-chart-f9cv](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-f9cv.toon))
- gantt: due dates ignored \(read item.due\_date, pm uses deadline\) ([pm-gantt-chart-v0ry](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-v0ry.toon))
- gantt: --group-by ignored \(kebab vs camelCase option key\) ([pm-gantt-chart-76at](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-76at.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-gantt-chart-qvnl](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-qvnl.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-gantt-chart-cd9u](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-cd9u.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-gantt-chart-y12r](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-y12r.toon))

### Other

- Release readiness hardening for pm-gantt-chart ([pm-gantt-chart-41p5](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-41p5.toon))
