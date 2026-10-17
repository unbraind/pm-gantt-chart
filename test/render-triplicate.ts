/** Reproduce review artifacts from the captured public brand-kit tracker, without hosted data. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRows, resolveGanttOptions, renderSvg, renderHtml, renderMermaid, type PmItem } from '../index.ts';
const output = resolve(process.argv[2]);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/triplicate.json', import.meta.url), 'utf8')) as { items: PmItem[] };
const opts = resolveGanttOptions({ from:'2026-10-12',weeks:'4',width:'1440','group-by':'type',progress:true });
opts.today = new Date('2026-10-17T00:00:00.000Z');
const rows = buildRows(fixture.items,opts,opts.windowStart);
mkdirSync(output,{recursive:true});
for (const [name, render] of [['svg',renderSvg],['html',renderHtml],['mmd',renderMermaid]] as const) writeFileSync(resolve(output,`gantt.${name}`),render(rows,opts,opts.windowStart));
console.log('Three deterministic Gantt review artifacts generated');
