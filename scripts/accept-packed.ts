import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
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
function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnvironment,
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
  const packedReceipt: unknown = JSON.parse(packed.stdout);
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
