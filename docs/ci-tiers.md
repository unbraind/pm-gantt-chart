# Fleet CI v2

Required checks remain `test (22.18.0)` and `test (26)`. PR/manual jobs use
GitHub-hosted Ubuntu, quick depth, a 30-minute limit and PR cancellation.

| Check | Code PR 22.18.0 | Code PR 26 | Docs/tracker PR, both | Deep 22.18.0 + 26 |
| --- | --- | --- | --- | --- |
| npm ci, merge drivers, strict pm health | yes | yes | yes | yes |
| Build and tests | quick | quick coverage | README + identity suites | full npm + Bun |
| Committed dist drift | — | yes | — | yes |
| Brand, typecheck, lint, duplication, docstrings | — | yes | — | full npm + Bun |
| Coverage, unchanged 100% lines/branches/functions | — | quick | — | full npm + Bun |
| Release workflow verification | — | yes | — | full npm + Bun |
| Publish attestation verification (all tracked shebangs) | — | yes | yes | full npm + Bun |
| Production audit | — | yes | — | full npm + Bun |
| Package dry-run (includes README/CHANGELOG), changelog and date | — | yes | yes | full npm + Bun |
| Packed npm/npx, Bun/bunx, minimum/current host acceptance | — | yes | — | full npm + Bun |
| Bun package graph install smoke | — | yes | — | yes |
| CodeQL (separate workflow) | matching paths | matching paths | filtered | main matching paths + weekly Monday 03:29 UTC |

Deep runs on main pushes, dispatch, and daily 02:47 UTC, away from release at
03:23 and hourly reconciliation at :41. Checks use the distinct `deep` job name,
120-minute limits and per-ref cancellation. `PM_LOCAL_DEEP` selects persistent
local runners unless `off`; hosted fallback restores npm cache and installs Bun.
Local runners use their persistent npm cache and preinstalled Bun, whose version
is logged. Full npm and Bun release gates both run on both Node versions.

Quick uses the deterministic first 50 of 500 cases and 200 of 2000 cases;
unset depth stays full. The compatibility digest checks 30 of 300 cases in quick mode against a frozen
prefix digest. Product size boundaries and sampling contracts remain intact. Generated refusal counts
come from the independent case model. Acceptance command watchdogs alone scale
with `PM_TEST_TIME_SCALE` (deep: 3), validated before spawning and rounded up to
integer milliseconds. No product deadline is changed.

The docs path includes strict health, identity auditing, the README contract,
package dry-run, changelog and its date verifier. Source-bearing tracker files
select the code path. No separate privacy or secret script exists in this repo.
Packed acceptance already proves Bun project/global tarball installation and
bunx host execution, so the additional PR smoke is only `bun install --no-save`.

Baseline successful main run 43706369121: Node 22.18.0 execution 4m30s; Node 26
8m03s (wall time from run creation: 62m14s and 128m04s respectively). Its slowest
seeded test took 68.55s, calibration 18.50s and drift 15.82s. Quick timing is to be
measured on PR CI; full depth is not rerun on the overloaded local host.

Publish-attestation discovery reads the first line of every tracked file for a
shell shebang, including documentation and tracker files, so it also runs on
the cheap path. The verifier implementation is unchanged.

CodeQL filters inert tracker data by extension; executable tracker scripts remain eligible on PRs and main pushes.

## Review round E

PRRT_kwDOSYpIas63tpkT is valid: build regenerated committed brand values before validation. Both quick matrix legs now run brand:check before any build; ci-brand.test.ts asserts ordering. Brand, targeted workflow tests, typecheck, lint and strict YAML passed.

The cheap tier excludes only inert tracker record formats; executable tracker changes keep product gates. `test/ci-routing.test.ts` executes each detector with inert and executable tracker paths. Product deadlines, full-depth cases and coverage thresholds are unchanged.
