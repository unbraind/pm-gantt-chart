import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { PmClient, createRelationshipKindRegistry } from "@unbrained/pm-cli/sdk";

/** Check the refusal contract shared by read-only scheduling commands. */
export function assertTypedRefusal(result: { ok: true } | { ok: false; code: string; remedy: string }, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected refusal");
  assert.equal(result.code, code);
  assert.ok(result.remedy.length > 15);
}

/** Test registry with a source-first ordering kind absent from the core ontology. */
export function orderingRegistry() {
  const registry = createRelationshipKindRegistry();
  registry.register({ kind: "ships_before", direction: "directed", ordering: true, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false });
  return registry;
}

/** Hash durable tracker documents, ignoring locks and disposable read caches. */
export function snapshot(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["runtime", "locks", "search", "node_modules"].includes(entry.name)) continue;
    hash.update(entry.name);
    const path = join(root, entry.name);
    if (entry.isDirectory()) hash.update(snapshot(path));
    else if (entry.isFile()) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

/** Install the real tarball into an SDK-created tracker outside git, with a git-free PATH. */
export async function packedTracker(t: TestContext, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `gantt-${prefix}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(import.meta.dirname, "..");
  const cli = join(repo, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const pmRoot = join(root, ".agents", "pm");
  const sdk = new PmClient({ cwd: root, pmRoot, author: "fixture" });
  await sdk.init(prefix, { defaults: true, mergeFence: false, agentGuidance: "skip" });
  const env = { ...process.env, PM_PATH: pmRoot, GIT_CEILING_DIRECTORIES: dirname(root) };
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, encoding: "utf8" })) as { filename: string }[];
  execFileSync(process.execPath, [cli, "package", "install", join(root, packed[0].filename), "--project"], { cwd: root, env, encoding: "utf8" });
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(cli, join(bin, "pm"));
  const noGit = { ...env, PATH: bin };
  /** Execute the installed command without a git executable available. */
  const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: noGit, encoding: "utf8" });
  return { root, cli, pmRoot, sdk, bin, noGit, invoke };
}

/** Make archived public evidence read-only while allowing disposable SDK read caches. */
export function protectPublicTracker(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) protectPublicTracker(path); else chmodSync(path, 0o444);
  }
}

/** Archive public evidence into a disposable non-git tracker with read-only native documents. */
export function archivePublicTracker(prefix: string, ref = "origin/main") {
  const source = execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    const bytes = execFileSync("git", ["archive", source, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", root], { input: bytes });
    const pmRoot = join(root, ".agents", "pm");
    protectPublicTracker(pmRoot);
    return { source, root, pmRoot };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
