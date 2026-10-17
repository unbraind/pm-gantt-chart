/** Exercise branded output using real disposable tracker documents, never mocked SDK reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PmClient, listAllComplete, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { buildRows,resolveGanttOptions,renderSvg,renderHtml,renderMermaid,type PmItem } from '../index.ts';

test('real tracker states retain labels, form strips, edges and deterministic Triplicate output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triplicate-tracker-'));
  const pmRoot = join(root, '.agents', 'pm');
  const sdk = new PmClient({ cwd: root, pmRoot, author: 'fixture' });
  try {
    await sdk.init('visual', { defaults: true, mergeFence: false, agentGuidance: 'skip' });
    const states = ['open', 'in_progress', 'blocked', 'closed', 'canceled'] as const;
    for (const [index, status] of states.entries()) await sdk.create({ id: `visual-${status.replaceAll("_", "-")}`, title: `Review <${status}> & output`, type: 'Task', priority: index % 4, status, closeReason: 'Synthetic review fixture', estimatedMinutes: '480', createMode: 'progressive' });
    const result = certifyCompleteListResult(await listAllComplete({}, { pmRoot, noExtensions: true }));
    assert.equal(result.items.length, 5);
    const items: PmItem[] = result.items.map(item => ({ id:item.id,title:item.title,type:item.type,priority:item.priority,status:item.status as PmItem['status'],created_at:'2026-10-12T00:00:00.000Z',estimated_minutes:480 }));
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
    assert.match(svg,/fill="var\(--pm-status-blocked-bg\)"/u);
    const html=renderHtml(rows,opts,opts.windowStart);
    assert.match(html,/max-width:600px/u);
    assert.match(html,/:focus-visible/u);
    assert.match(html,/prefers-reduced-motion:reduce/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
