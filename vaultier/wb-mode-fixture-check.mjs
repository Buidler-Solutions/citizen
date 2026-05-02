import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/wb-mode-journeys.json', import.meta.url), 'utf8'));
assert.equal(fixture.schemaVersion, 'v1alpha1', 'WB fixture schemaVersion drifted');
assert.equal(fixture.contractVersion, '2026-05-01', 'WB fixture contractVersion drifted');
assert.ok(Array.isArray(fixture.journeys) && fixture.journeys.length >= 2, 'WB fixtures must include decoy and critical journeys');

for (const journey of fixture.journeys) {
  assert.ok(journey.id?.startsWith('wb-'), 'journey id must be wb-*');
  const commands = journey.steps.map((s) => s.command);
  assert.equal(commands[0], 'backup_init', `${journey.id}: first step must be backup_init`);
  assert.ok(commands.includes('backup_verify'), `${journey.id}: must include backup_verify step`);
  assert.ok(commands.includes('backup_restore'), `${journey.id}: must include backup_restore step`);
  for (const step of journey.steps) {
    assert.equal(step.expectOk, true, `${journey.id}: step ${step.command} must set expectOk=true`);
  }
}

console.log('wb-mode-fixture-check: deterministic journey fixtures validated');
