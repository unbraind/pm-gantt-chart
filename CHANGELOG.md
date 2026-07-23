# Changelog

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-gantt-chart-6vw2](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-6vw2.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-gantt-chart-xcqd](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-xcqd.toon))

## 2026.7.10-1 - 2026-07-10

### Added

- Add % complete (progress) rendering to Gantt bars ([pm-gantt-chart-gtqn](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-gtqn.toon))
- Highlight overdue / deadline-risk items in Gantt charts ([pm-gantt-chart-30wt](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-30wt.toon))
- Distinguish off-window items from genuinely undated items in ASCII/HTML ([pm-gantt-chart-htj5](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-htj5.toon))
- Add a TODAY marker to the HTML Gantt export (parity with ASCII/Mermaid) ([pm-gantt-chart-169m](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-169m.toon))

### Fixed

- Fix SVG progress label duplication, canvas sizing, and TODAY rule layering ([pm-gantt-chart-3mqi](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-3mqi.toon))
- Adversarial review pass 2026-07-10 ([pm-gantt-chart-nqio](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-nqio.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-gantt-chart-kwkp](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-kwkp.toon))
- Full-cycle hardening wave: pm-gantt-chart ([pm-gantt-chart-t9de](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-t9de.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-gantt-chart-nq00](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-nq00.toon))

## 2026.7.10 - 2026-07-10

### Added

- Add SVG export, chart width control, and progress alias to gantt ([pm-gantt-chart-3dnj](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-3dnj.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-gantt-chart-m3y4](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-m3y4.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-gantt-chart-bkph](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-bkph.toon))
- Regenerate CHANGELOG after pm close item ([pm-gantt-chart-2r7k](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-2r7k.toon))

## 2026.6.14 - 2026-06-14

### Added

- Add structured JSON output format to the gantt exporter ([pm-gantt-chart-53tr](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-53tr.toon))

## 2026.6.9 - 2026-06-09

### Added

- Add --milestones markers to gantt chart and exports ([pm-gantt-chart-xqak](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-xqak.toon))

## 2026.6.7 - 2026-06-07

### Added

- Add schedule risk columns to Gantt CSV exports ([pm-gantt-chart-4a5d](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-4a5d.toon))

### Other

- Harden release readiness checks ([pm-gantt-chart-ws4i](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-ws4i.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-gantt-chart-yv1k](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/chores/pm-gantt-chart-yv1k.toon))

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: data-sanity gate (hard-fail on dependency cycles, warn on soft issues) ([pm-gantt-chart-ayz2](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-ayz2.toon))

## 2026.6.4 - 2026-06-04

### Added

- Slack/float, infeasible-deadline flag, ASCII TODAY marker, HTML summary + assignee workload ([pm-gantt-chart-ao93](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-ao93.toon))

## 2026.6.3 - 2026-06-02

### Added

- Deepen gantt: scheduling, csv, sprint/release/status grouping, --to ([pm-gantt-chart-uscf](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-uscf.toon))
- Add --to date-window clip ([pm-gantt-chart-fotb](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-fotb.toon))
- Add sprint/release/status group-by keys ([pm-gantt-chart-f2mr](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-f2mr.toon))
- Add --critical-only filter (mark already existed) ([pm-gantt-chart-xkr0](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-xkr0.toon))
- Add CSV schedule export format (id,title,start,end,duration,deps,status) ([pm-gantt-chart-3reu](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-3reu.toon))

### Changed

- Decision: estimate source = estimated_minutes via 8h workday; no capability change (exporter is under importers) ([pm-gantt-chart-g2pj](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/decisions/pm-gantt-chart-g2pj.toon))

### Other

- Decision: forward-schedule from anchor, back-anchor to reachable deadlines, chain may overrun deadline ([pm-gantt-chart-oy33](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/decisions/pm-gantt-chart-oy33.toon))
- Unit tests for scheduler, critical path, csv/mermaid renderers ([pm-gantt-chart-tc2y](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-tc2y.toon))
- Dependency-aware --schedule mode + --default-duration ([pm-gantt-chart-ifbx](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-ifbx.toon))

## 2026.6.2 - 2026-06-02

### Added

- Add gantt export (mermaid/html/ascii) + critical-path, assignee grouping, --from window ([pm-gantt-chart-q3zh](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-q3zh.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- Command handler threw plain Error (no exitCode) → runtime double-invocation ([pm-gantt-chart-hl8t](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-hl8t.toon))

## 2026.5.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-gantt-chart-35p0](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/features/pm-gantt-chart-35p0.toon))

### Fixed

- gantt: extension name typo pm-gantt-chart-chart ([pm-gantt-chart-dorh](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-dorh.toon))
- gantt: returns {error} (exit 0) on fetch failure + pollutes --json stdout ([pm-gantt-chart-80dm](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-80dm.toon))
- gantt: milestone grouping empty (pm has no milestone field; use sprint/release) ([pm-gantt-chart-f9cv](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-f9cv.toon))
- gantt: due dates ignored (read item.due_date, pm uses deadline) ([pm-gantt-chart-v0ry](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-v0ry.toon))
- gantt: --group-by ignored (kebab vs camelCase option key) ([pm-gantt-chart-76at](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/issues/pm-gantt-chart-76at.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-gantt-chart-qvnl](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-qvnl.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-gantt-chart-cd9u](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-cd9u.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-gantt-chart-y12r](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-y12r.toon))

### Other

- Release readiness hardening for pm-gantt-chart ([pm-gantt-chart-41p5](https://github.com/unbraind/pm-gantt-chart/blob/main/.agents/pm/tasks/pm-gantt-chart-41p5.toon))
