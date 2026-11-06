/** Project rendering policy around the pinned generator; all selection stays upstream. */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainInvocation } from "./main-invocation.ts";

/** Omit only the generator's empty leading pending window, retaining every dated release. */
export function omitEmptyUnreleased(markdown: string): string {
  return markdown.replace(/^(# [^\n]+\n\n)## Unreleased\n\nNo changes\.\n(?:\n|$)(?=## |$)/u, "$1");
}

/**
 * Generate once through the pinned CLI, then use identical bytes for output and strict checks.
 * Upstream still validates flags, requested releases, attribution, dates and entry linting.
 * The extra stdout flag prevents it from writing or comparing its unfiltered placeholder.
 */
export function projectChangelog(args: readonly string[], cwd = process.cwd()): number {
  const summary = args.includes("--github-step-summary");
  const summaryPath = summary ? process.env.GITHUB_STEP_SUMMARY : undefined;
  if (summary && !summaryPath) throw new Error("--github-step-summary requires GITHUB_STEP_SUMMARY");
  const generated = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("pm-changelog/cli")),
    ...args.filter(arg => arg !== "--github-step-summary"), "--stdout"],
  { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (generated.stderr) process.stderr.write(generated.stderr);
  if (generated.error) throw generated.error;
  if (generated.status !== 0) return generated.status ?? 1;
  const markdown = omitEmptyUnreleased(generated.stdout);
  const outputIndex = args.indexOf("--output");
  const output = resolve(cwd, outputIndex >= 0 ? args[outputIndex + 1] :
    args.find(arg => arg.startsWith("--output="))?.slice("--output=".length) ?? "CHANGELOG.md");
  if (args.includes("--stdout")) process.stdout.write(markdown);
  else if (args.includes("--check")) {
    if (!existsSync(output) || readFileSync(output, "utf8") !== markdown) {
      if (summaryPath) appendFileSync(summaryPath, markdown);
      process.stderr.write("Changelog is out of date. Run npm run changelog:full.\n");
      return 1;
    }
    process.stderr.write("Changelog is up to date.\n");
  } else writeFileSync(output, markdown);
  if (summaryPath) appendFileSync(summaryPath, markdown);
  return 0;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  process.exitCode = projectChangelog(process.argv.slice(2));
}
