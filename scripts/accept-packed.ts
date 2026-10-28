import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScheduleSnapshot } from "../index.ts";
import { wideScheduleSnapshot } from "../test/schedule-adversaries.ts";

/** Package fields that define the installed-extension acceptance matrix. */
interface PackageContract {
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** One package-manager and host-version combination exercised in isolation. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
  readonly global?: true;
}

/** Machine-readable proof emitted for one successful packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly command_stdout_bytes: number;
  readonly export_stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly fixture_present: true;
  readonly drift_delta_days: 1;
  readonly replay_items: 2000;
  readonly replay_bytes: number;
  readonly prototype_calendars: true;
  readonly waiting_effort_minutes: 120;
  readonly waiting_elapsed_minutes: 3000;
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const developmentVersion = packageJson.devDependencies[cliPackage];
/** Exercise the deployed consumer separately while retaining the repository's development SDK pin. */
const consumerVersion = "2026.10.28";
const minimumMatch = packageJson.peerDependencies[cliPackage]?.match(/^>=\s*(\d+\.\d+\.\d+)$/u);
const minimumVersion = minimumMatch?.[1];
if (!developmentVersion || !/^\d+\.\d+\.\d+$/u.test(developmentVersion) || !minimumVersion) {
  throw new Error(
    `package.json must declare an exact development version and a >= exact minimum peer version for ${cliPackage}`,
  );
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const bunxCommand = process.platform === "win32" ? "bunx.exe" : "bunx";
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: devNull,
  NPM_CONFIG_USERCONFIG: devNull,
};
// PM linked tests select a sandbox tracker through PM_PATH. Each packed
// scenario must initialize its own tracker inside its fresh project directory.
delete cleanEnvironment.PM_PATH;
delete cleanEnvironment.PM_SOURCE_PM_PATH;
delete cleanEnvironment.PM_SOURCE_WORKSPACE_ROOT;
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts" || /token|secret|password|credential|npm_media_server/i.test(key)) delete cleanEnvironment[key];
}
/** Maximum time allowed for one install, pack, or pm subprocess. */
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics.
 *
 * @param command - Executable resolved directly by the operating system.
 * @param args - Argument vector passed without interpolation.
 * @param cwd - Fresh scenario directory or the package root.
 * @returns Captured UTF-8 process output.
 */
function run(command: string, args: string[], cwd: string, environment = cleanEnvironment): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout: commandTimeoutMs,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} exceeded ${String(commandTimeoutMs)}ms and was terminated`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
    );
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher.
 *
 * @param scenario - Package manager and host version under acceptance.
 * @param cwd - Fresh project holding only the tarball and selected host.
 * @param args - pm arguments after the executable name.
 * @returns Captured pm output.
 */
function runPm(scenario: AcceptanceScenario, cwd: string, args: string[]): SpawnSyncReturns<string> {
  if (scenario.global) {
    const prefix = join(cwd, "global");
    const launcher = process.platform === "win32" && scenario.manager === "npm" ? join(prefix, "pm.cmd") : join(prefix, "bin", process.platform === "win32" ? "pm.exe" : "pm");
    return run(launcher, args, cwd);
  }
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "pm", ...args], cwd)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd);
}

/** Require parseable object stdout from one installed command surface.
 *
 * @param stdout - Captured command stdout.
 * @param label - Scenario and command label used in failures.
 * @returns Parsed object after rejecting arrays, primitives, and null.
 */
function requireJsonObject(stdout: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} stdout was not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-gantt-packed-acceptance-"));
try {
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  // release:check builds and runs a lifecycle-enabled pack dry-run immediately
  // before this gate. Ignore scripts here so prepare output cannot corrupt npm's
  // machine-readable filename receipt.
  const packed = run(
    npmCommand,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
    repoRoot,
  );
  // npm changed this receipt's shape: through npm 10 it is an array of entries,
  // from npm 11 it is an object keyed by package name. The CI matrix spans both
  // (Node 22.18 ships npm 10, Node 26 ships npm 12), so accepting only one shape
  // makes this gate pass on one runner and fail on the other for a reason that
  // has nothing to do with the package.
  // The receipt is not necessarily the whole of stdout. On npm 10 the pack
  // lifecycle can print ahead of it even under --ignore-scripts -- in this
  // repository `prepare` emits a pm merge-driver receipt -- and the parse then
  // fails on the first character of unrelated output. Start at the first line
  // that opens a JSON value.
  const receiptStart = packed.stdout.search(/^[[{]/m);
  const packedReceipt: unknown = JSON.parse(
    receiptStart === -1 ? packed.stdout : packed.stdout.slice(receiptStart),
  );
  const packedEntries = Array.isArray(packedReceipt)
    ? packedReceipt
    : packedReceipt !== null && typeof packedReceipt === "object"
      ? Object.values(packedReceipt as Record<string, unknown>)
      : [];
  const packedEntry = packedEntries.length === 1 ? packedEntries[0] : undefined;
  const packedName = packedEntry !== null && typeof packedEntry === "object"
    ? (packedEntry as Record<string, unknown>).filename
    : undefined;
  if (typeof packedName !== "string" || packedName.length === 0) {
    throw new Error(`npm pack must report exactly one tarball filename, got ${packed.stdout.trim()}`);
  }
  const tarball = join(packRoot, packedName);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
    { name: "npm-global", manager: "npm", hostVersion: consumerVersion, global: true },
    { name: "bun-global", manager: "bun", hostVersion: consumerVersion, global: true },
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    mkdirSync(scenarioRoot);
    if (scenario.global) {
      const prefix = join(scenarioRoot, "global");
      if (scenario.manager === "npm") run(npmCommand, ["install", "--global", "--prefix", prefix, "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
      else run(bunCommand, ["add", "--global", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, { ...cleanEnvironment, BUN_INSTALL: prefix });
    } else if (scenario.manager === "npm") {
      run(npmCommand, ["init", "-y"], scenarioRoot);
      run(npmCommand, ["install", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot);
      run(bunCommand, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    }

    runPm(scenario, scenarioRoot, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    const fixtureTitle = `Packed Gantt fixture ${scenario.name}`;
    runPm(scenario, scenarioRoot, [
      "create",
      "task",
      fixtureTitle,
      "--status",
      "open",
      "--create-mode",
      "progressive", "--assignee", "worker", "--estimate", "120",
      "--unset", "parent", "--unset", "goal", "--unset", "objective", "--unset", "sprint", "--unset", "release",
    ]);
    runPm(scenario, scenarioRoot, ["install", tarball, "--project"]);

    const command = runPm(scenario, scenarioRoot, ["--json", "gantt", "--from", "2026-08-17", "--weeks", "2"]);
    requireJsonObject(command.stdout, `${scenario.name} pm gantt`);
    const exported = runPm(scenario, scenarioRoot, [
      "--quiet",
      "gantt",
      "export",
      "--format",
      "json",
      "--from",
      "2026-08-17",
      "--weeks",
      "2",
    ]);
    const exportedResult = requireJsonObject(exported.stdout, `${scenario.name} pm gantt export`);
    const exportedItems = exportedResult.items;
    if (
      !Array.isArray(exportedItems)
      || !exportedItems.some((item) => (
        item !== null
        && typeof item === "object"
        && (item as Record<string, unknown>).title === fixtureTitle
      ))
    ) {
      throw new Error(`${scenario.name} pm gantt export omitted the real tracker fixture`);
    }
    const fixture = (exportedItems as Record<string, unknown>[]).find((item) => item.title === fixtureTitle)!;
    const waitsFile = join(scenarioRoot, "waits.json");
    writeFileSync(waitsFile, JSON.stringify({ waits: { [String(fixture.id)]: { minMinutes: 2880, maxMinutes: 2880 } } }));
    const waitingArgs = ["gantt", "waiting", "--waits", waitsFile];
    const waiting = requireJsonObject(runPm(scenario, scenarioRoot, [...waitingArgs, "--json"]).stdout, `${scenario.name} waiting`);
    if (waiting.ok !== true || waiting.totalEffortMinutes !== 120 || waiting.finishMinMinutes !== 3000) throw new Error(`${scenario.name} did not separate 120 effort from 2880 waiting minutes`);
    if (!runPm(scenario, scenarioRoot, waitingArgs).stdout.includes("effortMinutes")) throw new Error(`${scenario.name} waiting TOON is missing effort`);
    const controlsFile = join(scenarioRoot, "controls.json"), beforeFile = join(scenarioRoot, "before.json"), afterFile = join(scenarioRoot, "after.json");
    writeFileSync(controlsFile, JSON.stringify({ from: "2026-10-19", through: "2026-10-30", timeZone: "UTC", scenarios: [{ id: "saved", owners: {
      worker: { weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [], minutesPerDay: 480, minutesPerWeek: 3360, totalMinutes: 10000 },
    } }] }));
    const captureArgs = ["gantt", "snapshot", "--scenarios", controlsFile, "--json"];
    const beforeEnvelope = requireJsonObject(runPm(scenario, scenarioRoot, captureArgs).stdout, `${scenario.name} capture`);
    runPm(scenario, scenarioRoot, ["update", String(fixture.id), "--estimate", "960"]);
    const afterEnvelope = requireJsonObject(runPm(scenario, scenarioRoot, captureArgs).stdout, `${scenario.name} capture`);
    const savedBefore = beforeEnvelope.snapshot as ScheduleSnapshot, savedAfter = afterEnvelope.snapshot as ScheduleSnapshot;
    const context = wideScheduleSnapshot().tasks.slice(1);
    writeFileSync(beforeFile, JSON.stringify({ ...beforeEnvelope, snapshot: { ...savedBefore, tasks: [...savedBefore.tasks, ...context] } }, null, 2));
    const calendars = new Map(Object.entries(savedAfter.owners));
    for (const name of ["constructor", "__proto__"]) calendars.set(name, savedAfter.owners.worker);
    const replay = JSON.stringify({ ...afterEnvelope, snapshot: { ...savedAfter, owners: Object.fromEntries(calendars), tasks: [...savedAfter.tasks, ...context] } }, null, 4);
    writeFileSync(afterFile, replay);
    if (Buffer.byteLength(replay) <= 262144) throw new Error("Packed replay must exceed the former 256 KiB limit");
    const driftArgs = ["gantt", "drift", "--before", beforeFile, "--after", afterFile];
    const drift = requireJsonObject(runPm(scenario, scenarioRoot, [...driftArgs, "--json"]).stdout, `${scenario.name} drift`);
    if (drift.ok !== true || !Array.isArray(drift.moved) || drift.moved[0]?.deltaDays !== 1) throw new Error(`${scenario.name} must report exactly one day of estimate drift`);
    if ((drift.counts as Record<string, unknown>).tasks !== 2000 || !Array.isArray(drift.changes) || drift.changes.length !== 3) throw new Error(`${scenario.name} lost saved context or prototype-named calendars`);
    if (!runPm(scenario, scenarioRoot, driftArgs).stdout.includes("deltaDays")) throw new Error(`${scenario.name} drift TOON is missing its delta`);
    const stderr = `${command.stderr}\n${exported.stderr}`;
    if (stderr.includes("deprecated") || stderr.includes("list-all")) {
      throw new Error(`${scenario.name} emitted a deprecated-command diagnostic: ${stderr.trim()}`);
    }
    receipts.push({
      scenario: scenario.name,
      host_version: scenario.hostVersion,
      command_stdout_bytes: Buffer.byteLength(command.stdout),
      export_stdout_bytes: Buffer.byteLength(exported.stdout),
      stderr_bytes: Buffer.byteLength(stderr),
      fixture_present: true,
      drift_delta_days: 1,
      replay_items: 2000,
      replay_bytes: Buffer.byteLength(replay),
      prototype_calendars: true,
      waiting_effort_minutes: 120,
      waiting_elapsed_minutes: 3000,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
