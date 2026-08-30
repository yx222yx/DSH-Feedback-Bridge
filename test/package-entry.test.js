import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Host entry resolves through the package exports map with the plugin contract', async () => {
  const host = await import('dsh-feedback-bridge');
  assert.equal(host.name, 'dsh-feedback-bridge');
  assert.deepEqual(host.inject, ['webServer', 'sessions', 'llm', 'credentials']);
  assert.equal(typeof host.apply, 'function');
  for (const helper of [
    'compatibilityRangeOf',
    'isDshVersionCompatible',
    'detectDshVersion',
    'assertCompatibleDsh',
    'ownVersion',
    'statusPayload',
  ]) {
    assert.equal(typeof host[helper], 'function', `${helper} must be exported`);
  }
});

test('client entry is the ModuleLoader bundle registered under the package id', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /"dsh-feedback-bridge"/);
});
