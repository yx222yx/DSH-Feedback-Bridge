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

test('package metadata identifies the plugin and carries the dsh-plugin discovery keyword', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'dsh-feedback-bridge');
  assert.ok(manifest.keywords.includes('dsh-plugin'), 'keywords must include the recommended dsh-plugin discovery topic');
  assert.ok(manifest.keywords.includes('deepseek-harness'));
  assert.equal(manifest.repository.type, 'git');
  assert.equal(manifest.repository.url, 'git+https://github.com/yx222yx/DSH-Feedback-Bridge.git');
  assert.equal(manifest.homepage, 'https://github.com/yx222yx/DSH-Feedback-Bridge');
  assert.equal(manifest.bugs.url, 'https://github.com/yx222yx/DSH-Feedback-Bridge/issues');
});

test('client entry is the ModuleLoader bundle registered under the package id', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /"dsh-feedback-bridge"/);
});
