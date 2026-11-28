/** Project rendering policy around the pinned generator; all selection stays upstream. */
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliTestSurface } from "pm-changelog/cli";
import { isMainInvocation } from "./main-invocation.ts";

/** Omit only the generator's empty leading pending window, retaining every dated release. */
export function omitEmptyUnreleased(markdown: string): string {
  return markdown.replace(/^(# [^\n]+\n\n)## Unreleased\n\nNo changes\.\n(?:\n|$)(?=## |$)/u, "$1");
}

/**
 * Check with the pinned CLI, whose current renderer already omits empty Unreleased sections.
 * Keep project normalization for generated files, stdout and release notes.
 */
export function projectChangelog(args: readonly string[], cwd = process.cwd()): number {
  // Reuse the pinned CLI parser, including aliases, values and last-option precedence.
  const options = cliTestSurface.parseArgs([...args]);
  const summary = options.githubStepSummary;
  const summaryPath = summary ? process.env.GITHUB_STEP_SUMMARY : undefined;
  if (summary && !summaryPath) throw new Error("--github-step-summary requires GITHUB_STEP_SUMMARY");
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pm-arg") {
      // This option consumes even flag-shaped values; preserve them verbatim.
      forwarded.push(arg, args[++i]);
    } else if (arg !== "--github-step-summary") forwarded.push(arg);
  }
  const check = options.check && !options.stdout;
  const generatorArgs = check ? args : [...forwarded, "--stdout"];
  const generated = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("pm-changelog/cli")),
    ...generatorArgs],
  { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (generated.stderr) process.stderr.write(generated.stderr);
  if (generated.error) throw generated.error;
  if (generated.status !== 0) return generated.status ?? 1;
  if (check) return 0;
  const markdown = omitEmptyUnreleased(generated.stdout);
  if (options.stdout) process.stdout.write(markdown);
  else writeFileSync(resolve(cwd, options.output), markdown);
  if (summaryPath) appendFileSync(summaryPath, markdown);
  return 0;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  process.exitCode = projectChangelog(process.argv.slice(2));
}
