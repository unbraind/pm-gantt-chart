# Changelog

## 2026.6.2 - 2026-06-02

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
