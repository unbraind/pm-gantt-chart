/** Exercise branded output using real disposable tracker documents, never mocked SDK reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Resvg } from '@resvg/resvg-js';
import { brandValue } from '../brand.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PmClient, listAllComplete, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { buildRows,resolveGanttOptions,renderSvg,renderHtml,renderMermaid,type PmItem } from '../index.ts';

test('real tracker states retain labels, form strips, edges and deterministic Triplicate output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triplicate-tracker-'));
  const pmRoot = join(root, '.agents', 'pm');
  const sdk = new PmClient({ cwd: root, pmRoot, author: 'fixture' });
  try {
    await sdk.init('visual', { defaults: true, mergeFence: false, agentGuidance: 'skip' });
    const states = ['open', 'in_progress', 'blocked', 'closed', 'canceled'] as const;
    for (const [index, status] of states.entries()) await sdk.create({ id: `visual-${status.replaceAll("_", "-")}`, title: `Review <${status}> & output`, type: 'Task', priority: index % 4, status, closeReason: 'Synthetic review fixture', dep: status === 'blocked' ? ['id=visual-in-progress,kind=blocked_by'] : [], estimatedMinutes: '480', createMode: 'progressive' });
    const result = certifyCompleteListResult(await listAllComplete({}, { pmRoot, noExtensions: true }));
    assert.equal(result.items.length, 5);
    const items: PmItem[] = result.items.map(item => ({ id:item.id,title:item.title,type:item.type,priority:item.priority,status:item.status as PmItem['status'],dependencies:item.dependencies,created_at:'2026-10-12T00:00:00.000Z',estimated_minutes:480 }));
    const opts = resolveGanttOptions({ from:'2026-10-12',weeks:'4',schedule:true,progress:true });
    opts.today = new Date('2026-10-17T00:00:00.000Z');
    const rows = buildRows(items,opts,opts.windowStart);
    for (const render of [renderSvg,renderHtml,renderMermaid]) {
      const output=render(rows,opts,opts.windowStart);
      assert.equal(output,render(rows,opts,opts.windowStart));
      assert.ok(output.includes('--pm-paper'));
      assert.ok(output.includes('Martian Mono'));
      assert.ok(output.includes('prefers-color-scheme:dark'));
      for(const state of states) assert.ok(output.includes(`--pm-status-${state}-bg`));
      assert.ok(output.includes('line-through'));
      assert.doesNotMatch(output, /https?:\/\/(?!www\.w3\.org)/u);
    }
    const svg=renderSvg(rows,opts,opts.windowStart);
    assert.match(svg,/visual-open · Task · P0/u);
    assert.match(svg,/Review &lt;open&gt; &amp; output/u);
    assert.ok(svg.includes(`fill="${brandValue('light', 'status-blocked-bg')}"`));
    const html=renderHtml(rows,opts,opts.windowStart);
    assert.match(html,/max-width:600px/u);
    assert.match(html,/:focus-visible/u);
    assert.match(html,/prefers-reduced-motion:reduce/u);
    const criticalOpts = resolveGanttOptions({ from:'2026-10-12',weeks:'4',schedule:true,'critical-path':true });
    const criticalRows = buildRows(items,criticalOpts,criticalOpts.windowStart);
    assert.ok(criticalRows.some(row => row.critical), 'the real dependency chain must produce critical rows');
    const criticalDiagram = JSON.parse(/^%%\{init: (.*)\}%%/u.exec(renderMermaid(criticalRows,criticalOpts,criticalOpts.windowStart))![1]) as {themeCSS:string};
    assert.match(criticalDiagram.themeCSS,/stroke-width:3px/u, 'computed critical tasks keep their stronger outline');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('standalone SVG retains literal paper, ink and status paints in a non-browser rasterizer', () => {
  const opts = resolveGanttOptions({ from: '2026-10-12', weeks: '1', progress: true });
  opts.today = new Date('2026-10-14T00:00:00Z');
  const items: PmItem[] = ['open', 'in_progress', 'blocked', 'closed', 'canceled'].map((status, index) => ({
    id: `paint-${index}`, title: `Review ${status} var(--pm-paper)`, type: 'Task', priority: 1,
    status: status as PmItem['status'], created_at: '2026-10-12T00:00:00Z', deadline: '2026-10-16',
  }));
  const svg = renderSvg(buildRows(items, opts, opts.windowStart), opts, opts.windowStart);
  assert.ok(svg.includes('Review open var(--pm-paper)'), 'token-like user text stays literal');
  const image = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [fileURLToPath(new URL('./fixtures/readability.ttf', import.meta.url))], defaultFontFamily: 'DejaVu Sans' } }).render();
  const pixels = image.pixels;
  const blank = new Resvg(svg.replace(/<text\b[\s\S]*?<\/text>/gu, ''), {
    font: { loadSystemFonts: false, fontFiles: [fileURLToPath(new URL('./fixtures/readability.ttf', import.meta.url))], defaultFontFamily: 'DejaVu Sans' },
  }).render();
  const blankPixels = blank.pixels;
  let glyphPixels = 0;
  // This first item-title region contains only glyphs over a flat sheet fill.
  for (let y = 136; y < 149; y++) for (let x = 132; x < 410; x++) {
    const offset = (y * image.width + x) * 4;
    if (!pixels.subarray(offset, offset + 4).equals(blankPixels.subarray(offset, offset + 4))) glyphPixels++;
  }
  assert.ok(glyphPixels > 40, `item title must rasterize visible glyphs, found ${glyphPixels} changed pixels`);
  const colors = new Set<string>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 255) colors.add('#' + pixels.subarray(offset, offset + 3).toString('hex').toUpperCase());
  }
  for (const name of ['paper', 'sheet', 'carbon', 'canary-wash', 'rose-wash', 'stamp'] as const) {
    const expected = brandValue('light', name).slice(1);
    const channels = [0, 2, 4].map(offset => parseInt(expected.slice(offset, offset + 2), 16));
    const tolerance = name === 'stamp' || name === 'carbon' ? 24 : 0;
    const visible = [...colors].some(color => channels.every((channel, index) =>
      Math.abs(parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) - channel) <= tolerance));
    assert.ok(visible, `${name} paint must survive rasterization, allowing edge antialiasing`);
  }
  assert.ok(colors.size > 5, 'the standalone chart must contain visible paper, text and status fills');
  assert.doesNotMatch(svg, /(?:fill|stroke)[=:]\s*["']?var\(/u);
});


test('SVG labels ellipsize complete words and preserve full accessible titles', () => {
  const title = 'Approve contract changes for low-contrast status borders';
  for (const [text, expected] of [[title, 'Approve contract changes…'], ['WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', '…'], ['Short title', 'Short title'], ['Approve  contract changes for review', 'Approve  contract changes…']] as const) {
    const opts = resolveGanttOptions({ from: '2026-10-12', weeks: '1', width: '320', 'critical-path': true });
    const item: PmItem = { id: 'label-1', title: text, type: 'Task', status: 'open', created_at: '2026-10-12T00:00:00Z' };
    const svg = renderSvg(buildRows([item], opts, opts.windowStart), opts, opts.windowStart);
    assert.ok(svg.includes(`<title>${text} · open</title>`));
    assert.ok(svg.includes(`font-size="11">${expected}</text>`), expected);
    assert.match(svg, /<title id="pm-gantt-title">pm gantt — 1 weeks from 2026-10-12 • critical path marked<\/title>/u);
    assert.match(svg, /font-stretch:125%">pm gantt — 1 weeks…<\/text>/u);
  }
});


test('all five status legend chips fit inside narrow short-window SVG canvases', () => {
  for (const width of ['320', '600', '1440']) for (const weeks of ['1', '2', '3', '4']) {
    const opts = resolveGanttOptions({ from: '2026-10-12', width, weeks });
    const svg = renderSvg([], opts, opts.windowStart);
    const canvas = Number(/viewBox="0 0 (\d+) /u.exec(svg)![1]);
    const chips = [...svg.matchAll(/<g class="status-[^"]+"><rect x="(\d+)" y="\d+" width="(\d+)" height="22"/gu)];
    assert.equal(chips.length, 5);
    for (const chip of chips) assert.ok(Number(chip[1]) + Number(chip[2]) + 16 <= canvas, `legend fits width ${width}, weeks ${weeks}`);
  }
});

test('SVG text inherits literal carbon ink when stylesheets are ignored', () => {
  const opts = resolveGanttOptions({ from: '2026-10-12', weeks: '1' });
  const item: PmItem = { id: 'ink-1', title: 'Review fallback ink', type: 'Task', status: 'open', created_at: '2026-10-12T00:00:00Z' };
  const svg = renderSvg(buildRows([item], opts, opts.windowStart), opts, opts.windowStart);
  const unstyled = svg.replace(/<style>[\s\S]*?<\/style>/gu, '');
  const image = new Resvg(unstyled, {
    font: { loadSystemFonts: false, fontFiles: [fileURLToPath(new URL('./fixtures/readability.ttf', import.meta.url))], defaultFontFamily: 'DejaVu Sans' },
  }).render();
  const pixels = image.pixels;
  let carbonPixels = 0;
  for (let y = 136; y < 149; y++) for (let x = 132; x < 410; x++) {
    const offset = (y * image.width + x) * 4;
    if ('#' + pixels.subarray(offset, offset + 3).toString('hex').toUpperCase() === brandValue('light', 'carbon')) carbonPixels++;
  }
  assert.ok(carbonPixels > 10, `unstyled item text must inherit carbon ink, found ${carbonPixels} pixels`);
  assert.ok(svg.includes(`:root:not([data-theme="light"]) text{fill:${brandValue('dark', 'carbon')}}`), 'browser dark-theme text still overrides the fallback');
});

test('SVG row titles retain critical path context without changing ordinary titles', () => {
  const opts = resolveGanttOptions({ from: '2026-10-12', weeks: '1', 'critical-path': true });
  const items: PmItem[] = ['critical', 'ordinary'].map(id => ({ id, title: `Review <${id}> & context`, type: 'Task', status: 'open', created_at: '2026-10-12T00:00:00Z' }));
  const rows = buildRows(items, opts, opts.windowStart);
  rows[0].critical = true;
  rows[1].critical = false;
  const svg = renderSvg(rows, opts, opts.windowStart);
  assert.match(svg, /data-item="critical">\s*<title>Review &lt;critical&gt; &amp; context · open · critical path<\/title>/u);
  assert.match(svg, /data-item="ordinary">\s*<title>Review &lt;ordinary&gt; &amp; context · open<\/title>/u);
});
