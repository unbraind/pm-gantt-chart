# Triplicate visual exports

The build reads typed token values from the exact `pm-brand` development pin in
`package.json`. `scripts/brand-values.ts` serializes values into generated source,
sharing common aliases and typography between palettes. The package runtime and
compiled declarations import only that generated source. No Git dependency is
published as a production dependency, and no brand file or font is vendored.
`npm run brand:check` fails before the release gates if the baked values are stale;
`npm run brand:build` regenerates them. The parity test compares both complete
palettes with the pinned kit's typed tokens. Thresholds are unchanged.

Every item sheet opens with actual id, type and priority data. Paper, ruled sheet
borders and carbon ink use contract values. Status labels have distinct borders
and fills: outlined open, canary-wash in_progress, rose-wash blocked, stamp closed,
and struck graphite canceled. Draft/custom states stay neutral. Canary and rose
are used only for the two working states. There is no merge animation.

Archivo, Public Sans and Martian Mono lead the appropriate font stacks. Portable
exports request no font URLs: renderers use installed fonts or the declared
fallbacks. Hosts can self-host the kit's fonts independently. Every used text and
status fill pairing is tested against WCAG AA in both themes; chip borders remain
decorative, per the contract. Static exports have no keyboard actions or animation.

## Reproduce the review

`test/fixtures/triplicate.json` captures seven public items from the brand kit's
own tracker, with its immutable source URL. Only id, title, type, status, priority,
creation date and hierarchy are retained; no hosted data is used.

```sh
node test/render-triplicate.ts REVIEW_OUTPUT
node test/revert-triplicate.ts origin/main
node --test test/brand-values.test.ts test/triplicate-visuals.test.ts
npm run release:check
bun run release:check
```

The revert script changes one renderer at a time in a disposable source copy,
keeps the new regression test intact, and requires a failure for each old renderer.
It then restores the implementations and requires a passing test. Regression
fixtures use real disposable pm trackers and complete certified SDK reads.

Review PNGs cover 1440, 768 and 390 px in light/dark, at both 1× and 2× pixel ratios.
Browser checks cover page overflow, all image decodes, actual Mermaid chip fills,
reduced motion and network requests. There are no interactive controls to tab to.
The HTML renderer also defines a contract focus-visible ring. Evidence is kept on
the repository's `pr-screenshots` branch, outside this PR's source tree.

## Formats and themes

SVG and standalone HTML follow `prefers-color-scheme` and support an explicit
`data-theme` on the root. HTML reflows into item sheets at 600 px and below;
SVG retains its canvas/viewBox and scales to the container. Critical paths retain
their star and a heavier outline, and overdue items retain text and a dashed edge,
without taking status colors. Progress bands and percentages are preserved.

Mermaid Gantt uses the same palettes and native task ids, tags, dates, comments and
milestones. Its initialization directive precedes the diagram header so renderers
actually apply it. Its native single-line labels retain the mono data stack.
ASCII remains a portable monochrome chart with explicit status glyphs; CSV and
JSON retain their existing schedule-data contract. Mermaid hosts must retain the
initialization directive and allow its scoped theme CSS; use SVG when a host strips
custom Mermaid styles.

The Git devDependency is locked by its exact commit. Its npm lock entry omits the
optional prepared-archive integrity field: Bun 1.4.3 imports that hash while
fetching a different Git archive and rejects it. Registry package integrity
values remain intact. A clean-cache installation reproduces the failure with
the original Git entry and succeeds with commit-based identity. npm's Git fetcher
also [ignores archive integrity for Git dependencies](https://github.com/npm/pacote/blob/main/lib/git.js).
