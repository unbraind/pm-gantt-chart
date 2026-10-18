/** Prove the SVG paint, title, legend and shared-source regressions with independent disposable behavioral reverts. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'gantt-review-proof-'));
try {
  for (const path of ['test', 'scripts']) cpSync(path, join(root, path), { recursive: true });
  for (const path of ['index.ts', 'brand.ts', 'brand-values.ts', 'package.json']) cpSync(path, join(root, path));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  for (const [name, path, from, to, pattern, test] of [
    ['literal text ink', 'index.ts', 'fill="var(--pm-carbon)" role="img"', 'role="img"', 'SVG text inherits', 'test/triplicate-visuals.test.ts'],
    ['critical row title', 'index.ts', "${row.critical ? ' · critical path' : ''}</title>", '</title>', 'SVG row titles', 'test/triplicate-visuals.test.ts'],
    ['legend extent', 'index.ts', ', PAD * 2 + (brandStatuses.length - 1) * LEGEND_STEP + LEGEND_CHIP_W', '', 'all five status legend', 'test/triplicate-visuals.test.ts'],
    ['shared source write', 'test/brand-values.test.ts', "    main(['--check']);", "    main([]); main(['--check']);", 'the build gate fails', 'test/brand-values.test.ts'],
  ]) {
    const target = join(root, path);
    const original = readFileSync(target, 'utf8');
    assert.ok(original.includes(from));
    writeFileSync(target, original.replace(from, to));
    const failed = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, test], { cwd: root, encoding: 'utf8' });
    writeFileSync(target, original);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /AssertionError/u);
    const restored = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, test], { cwd: root, encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    console.log(`${name}: reverted fails 1/1; restored passes 1/1`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
