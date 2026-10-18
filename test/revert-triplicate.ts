/** Prove each visual renderer regression independently while keeping the package worktree untouched. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const portable = process.argv[2] === '--portable';
const labels = process.argv[2] === '--labels';
const glyphs = process.argv[2] === '--glyphs';
const baseline = portable ? 'a0bc8e247a1a5f1ffec3046a2d2320ba403c075b' : labels || glyphs ? '83f82037097e7756a759024549ef1d75193bb719' : process.argv[2] ?? '9bb005dcd477c4bf8e26dabee38e90e08b6a894f';
const pattern = labels ? 'SVG labels' : portable || glyphs ? 'standalone SVG retains literal' : 'real tracker states';
const sourcePath = 'index.ts';
const current = readFileSync(join(root, sourcePath), 'utf8');
const previous = execFileSync('git', ['show', `${baseline}:${sourcePath}`], { cwd:root,encoding:'utf8' });
const scratch = mkdtempSync(join(tmpdir(), 'triplicate-revert-'));

/** Return just the renderer implementation, stopping at the following stable section boundary. */
function implementation(source: string, start: string, boundary: string): { start:number; end:number; body:string } {
  const from=source.indexOf(start);
  const end=source.indexOf(boundary,from);
  assert.ok(from>=0&&end>from,'Renderer and following boundary must exist');
  return {start:from,end,body:source.slice(from,end)};
}

try {
  cpSync(join(root,'package.json'),join(scratch,'package.json'));
  for(const name of ['index.ts','brand.ts','brand-values.ts']) cpSync(join(root,name),join(scratch,name));
  mkdirSync(join(scratch,'test'),{recursive:true});
  cpSync(join(root,'test/fixtures'),join(scratch,'test/fixtures'),{recursive:true});
  cpSync(join(root,'test/triplicate-visuals.test.ts'),join(scratch,'test/triplicate-visuals.test.ts'));
  symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
  const target=join(scratch,sourcePath);
  const renderers: Array<readonly [string,string]> = portable || labels || glyphs ? [['function renderSvg(', '\n// ---------------------------------------------------------------------------']] : [
    ['function renderSvg(', '\n// ---------------------------------------------------------------------------'],
    ['function renderHtml(', '\n// ---------------------------------------------------------------------------'],
    ['function renderMermaid(', '\n// ---------------------------------------------------------------------------'],
  ];
  for(const [start,boundary] of renderers) {
    const before=implementation(previous,start,boundary);
    const after=implementation(current,start,boundary);
    const reverted = glyphs ? after.body.replace("return literal.replace('</svg>', paints + '</svg>');", "return literal.replace('</svg>', paints + '</svg>').replace(/<text\\b[\\s\\S]*?<\\/text>/gu, '');") : before.body;
    assert.notEqual(reverted, after.body, 'The selected function must actually change');
    writeFileSync(target,current.slice(0,after.start)+reverted+current.slice(after.end));
    const result=spawnSync(process.execPath,['--test',`--test-name-pattern=${pattern}`,'test/triplicate-visuals.test.ts'],{cwd:scratch,encoding:'utf8'});
    assert.equal(result.status,1,`${start}: reverting only this renderer must fail its unchanged regression test\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout,/fail 1/u);
    if (glyphs) assert.match(result.stdout, /item title must rasterize visible glyphs/u);
    console.log(`${start}: behavioral revert failed 1/1 as required`);
  }
  writeFileSync(target,current);
  const restored=spawnSync(process.execPath,['--test',`--test-name-pattern=${pattern}`,'test/triplicate-visuals.test.ts'],{cwd:scratch,encoding:'utf8'});
  assert.equal(restored.status,0,restored.stdout+restored.stderr);
  assert.match(restored.stdout,/pass 1/u);
  console.log('Restored Triplicate renderers passed 1/1');
} finally { rmSync(scratch,{recursive:true,force:true}); }
