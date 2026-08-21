import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Package fields that define the installed-extension acceptance matrix. */
interface PackageContract {
  readonly name: string;
  readonly version: string;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** One package-manager and host-version combination exercised in isolation. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
}

/** Machine-readable proof emitted for one successful packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly command_stdout_bytes: number;
  readonly export_stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly fixture_present: true;
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const developmentVersion = packageJson.devDependencies[cliPackage];
const minimumVersion = packageJson.peerDependencies[cliPackage]?.replace(/^>=/, "");
if (!developmentVersion || !minimumVersion) {
  throw new Error(`package.json must declare exact development and minimum peer versions for ${cliPackage}`);
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
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
}

/** Run one shell-free command and fail with bounded diagnostics.
 *
 * @param command - Executable resolved directly by the operating system.
 * @param args - Argument vector passed without interpolation.
 * @param cwd - Fresh scenario directory or the package root.
 * @returns Captured UTF-8 process output.
 */
function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnvironment,
    maxBuffer: 64 * 1024 * 1024,
  });
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
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "pm", ...args], cwd)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd);
}

/** Require parseable object stdout from one installed command surface.
 *
 * @param stdout - Captured command stdout.
 * @param label - Scenario and command label used in failures.
 */
function requireJsonObject(stdout: string, label: string): void {
  const parsed: unknown = JSON.parse(stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} stdout was not a JSON object`);
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-gantt-packed-acceptance-"));
try {
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  run(npmCommand, ["pack", "--silent", "--pack-destination", packRoot], repoRoot);
  const tarball = join(packRoot, `${packageJson.name}-${packageJson.version}.tgz`);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    mkdirSync(scenarioRoot);
    if (scenario.manager === "npm") {
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
      "progressive",
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
    requireJsonObject(exported.stdout, `${scenario.name} pm gantt export`);
    if (!exported.stdout.includes(fixtureTitle)) {
      throw new Error(`${scenario.name} pm gantt export omitted the real tracker fixture`);
    }
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
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
