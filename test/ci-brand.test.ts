/** Committed brand values must be checked before a build can regenerate them. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('both quick matrix legs validate committed brand values before any build', () => {
  const document = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const steps = document.toJS().jobs.test.steps;
  const brand = steps.findIndex((step: { run?: string }) => step.run === 'npm run brand:check');
  assert.ok(brand >= 0);
  assert.equal(steps[brand].if, "steps.changes.outputs.code == 'true'");
  for (const name of ['Engines floor tests', 'Build and verify committed output is current', 'Quick npm release gate']) {
    assert.ok(steps.findIndex((step: { name?: string }) => step.name === name) > brand, name);
  }
});
