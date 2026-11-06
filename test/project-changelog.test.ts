import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";

const repo = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** Run the package's actual configured commands in an isolated SDK tracker. */
async function fixture(t: TestContext, git = true) {
  const root = mkdtempSync(join(tmpdir(), "gantt-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
  symlinkSync(join(repo, "scripts"), join(root, "scripts"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.11.5", scripts: manifest.scripts }));
  const sdk = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), author: "fixture" });
  await sdk.init("fixture", { defaults: true, mergeFence: false, agentGuidance: "skip" });
  let releaseDate = "2026-11-05T12:00:00Z";
  /** Explicit fixture identity makes the tests independent of global git configuration. */
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: releaseDate, GIT_COMMITTER_DATE: releaseDate } });
  if (git) runGit("init", "--quiet");
  /** Exercise the scripts rather than a test-owned copy of their generator options. */
  const run = (name = "changelog:full", ...args: string[]) => spawnSync("npm", ["run", "--silent", name, "--", ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: join(root, ".agents/pm"),
      GITHUB_STEP_SUMMARY: join(root, "step-summary.md") } });
  /** Capture the real native tracker at a release boundary. */
  const commit = (date = "2026-11-05T12:00:00Z") => {
    releaseDate = date;
    runGit("add", "package.json", ".agents/pm");
    runGit("commit", "--quiet", "--allow-empty", "-m", "Fixture release");
  };
  return { root, sdk, run, runGit, commit };
}

test("empty pending work stays byte-identical before and after the matching release tag", async t => {
  const f = await fixture(t);
  f.commit("2026-11-04T12:00:00Z");
  f.runGit("tag", "v2026.11.04");
  f.commit();
  const before = f.run();
  assert.equal(before.status, 0, before.stderr);
  const expected = readFileSync(join(f.root, "CHANGELOG.md"), "utf8");
  assert.match(expected, /## 2026\.11\.5 - 2026-11-05\n\nNo changes\./);
  assert.match(expected, /## 2026\.11\.4 - [^\n]+\n\nNo changes\./);
  f.runGit("tag", "v2026.11.05");
  const after = f.run("changelog:full", "--stdout");
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, expected);
  const check = f.run("changelog:check");
  assert.equal(check.status, 0, check.stderr);
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), expected);
  assert.equal(f.run("changelog").status, 0);
  assert.equal(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), expected);
  const notes = f.run("release:notes");
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(notes.stdout, expected.slice(0, expected.indexOf("## 2026.11.4")).trimEnd() + "\n");
  assert.equal(readFileSync(join(f.root, "step-summary.md"), "utf8"), notes.stdout);
  const noGit = await fixture(t, false);
  writeFileSync(join(noGit.root, "CHANGELOG.md"), "Keep this artifact.\n");
  const refused = noGit.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /git|repository/i);
  assert.equal(readFileSync(join(noGit.root, "CHANGELOG.md"), "utf8"), "Keep this artifact.\n");
});

test("nonempty pending work and historical attribution survive; checks still reject drift", async t => {
  const f = await fixture(t);
  await f.sdk.create({ id: "shipped", type: "Issue", title: "Preserve historical attribution", status: "closed",
    closeReason: "Delivered fixture behavior", release: "2026.11.5", unset: ["parent", "goal", "objective", "sprint"] });
  f.commit();
  f.runGit("tag", "v2026.11.05");
  assert.equal(f.run().status, 0);
  assert.doesNotMatch(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), /## Unreleased/);
  await f.sdk.create({ id: "pending", type: "Issue", title: "Preserve pending work", status: "closed",
    closeReason: "Delivered pending fixture behavior", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const generated = f.run();
  assert.equal(generated.status, 0, generated.stderr);
  const expected = readFileSync(join(f.root, "CHANGELOG.md"), "utf8");
  const [pending, historical] = expected.split("## 2026.11.5 - 2026-11-05");
  assert.match(pending, /## Unreleased/);
  assert.match(pending, /Preserve pending work/);
  assert.doesNotMatch(pending, /Preserve historical attribution/);
  assert.match(historical, /Preserve historical attribution/);
  assert.doesNotMatch(historical, /Preserve pending work/);
  assert.equal(f.run("changelog:check").status, 0);
  writeFileSync(join(f.root, "CHANGELOG.md"), expected.replace("Preserve pending work", "Stale pending work"));
  const stale = f.run("changelog:check");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /out of date/);
  assert.match(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), /Stale pending work/);
});

test("checked drift preserves the normalized step summary without writing the changelog", async t => {
  const f = await fixture(t);
  f.commit();
  f.runGit("tag", "v2026.11.05");
  const generated = f.run();
  assert.equal(generated.status, 0, generated.stderr);
  const output = join(f.root, "CHANGELOG.md"), summary = join(f.root, "step-summary.md");
  const expected = readFileSync(output, "utf8");
  assert.doesNotMatch(expected, /## Unreleased/);
  assert.equal(existsSync(summary), false, "callers without the flag do not create a summary");
  writeFileSync(output, "Stale artifact.\n");
  const stale = f.run("changelog:check", "--github-step-summary");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /out of date/);
  assert.equal(readFileSync(output, "utf8"), "Stale artifact.\n");
  assert.equal(existsSync(summary), true, "failed checks must still append their generated summary");
  assert.equal(readFileSync(summary, "utf8"), expected);
  unlinkSync(output);
  const missing = f.run("changelog:check", "--github-step-summary");
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /out of date/);
  assert.equal(existsSync(output), false, "checking a missing artifact must not create it");
  assert.equal(readFileSync(summary, "utf8"), expected.repeat(2));
  writeFileSync(output, expected);
  const current = f.run("changelog:check", "--github-step-summary");
  assert.equal(current.status, 0, current.stderr);
  assert.equal(readFileSync(output, "utf8"), expected);
  assert.equal(readFileSync(summary, "utf8"), expected.repeat(3), "each check appends exactly once");
});
