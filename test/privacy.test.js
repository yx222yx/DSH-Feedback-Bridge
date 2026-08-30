import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClientExports() {
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  new Function('window', clientBundle)(window);
  assert.ok(registration);
  return registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error('unexpected client require: ' + specifier);
  });
}

const React = {
  createElement() {
    return { type: null, props: {}, children: [] };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
};

const moduleExports = loadClientExports();
const { scanPrivacy } = moduleExports;

function cleanFields(overrides = {}) {
  return { title: 't', scenario: 's', gap: 'g', desired: 'd', context: 'c', ...overrides };
}

function sampleSource(overrides = {}) {
  return {
    id: 'session-1:user:3',
    sessionId: 'session-1',
    kind: 'message',
    role: 'user',
    label: '用户消息',
    text: 'SENTINEL_CONFIRMED',
    truncated: false,
    sensitive: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('scanPrivacy flags a credential marker in a public draft field as critical and never mutates the field', () => {
  const fields = cleanFields({ gap: 'the key is sk-abc1234567890abcdefghijklmnop and more text' });
  const before = JSON.stringify(fields);
  const findings = scanPrivacy(fields, []);
  const draftFindings = findings.filter((finding) => finding.location === 'draft');
  assert.ok(draftFindings.length > 0);
  assert.equal(draftFindings[0].kind, 'secret');
  assert.equal(draftFindings[0].severity, 'critical');
  assert.equal(draftFindings[0].field, 'gap');
  assert.ok(draftFindings[0].excerpt.length <= 80);
  // The scan is read-only: the fields object is byte-identical afterwards.
  assert.equal(JSON.stringify(fields), before);
});

test('scanPrivacy flags a credential marker in a confirmed source as a warning', () => {
  const sources = [sampleSource({ text: 'use token abc123 to login' })];
  const findings = scanPrivacy(cleanFields(), sources);
  const sourceFindings = findings.filter((finding) => finding.location === 'source');
  assert.ok(sourceFindings.length > 0);
  assert.equal(sourceFindings[0].severity, 'warning');
  assert.equal(sourceFindings[0].sourceId, 'session-1:user:3');
});

test('scanPrivacy flags a private path and reports excess context as advisory info', () => {
  const fields = cleanFields({ context: 'the workspace lives at /home/jason/project/src' });
  const findings = scanPrivacy(fields, []);
  assert.ok(findings.some((finding) => finding.kind === 'private-path'));

  const huge = Array.from({ length: 40 }, (_, i) => sampleSource({ id: 's:' + i, text: 'x'.repeat(4000) }));
  const contextFindings = scanPrivacy(cleanFields(), huge);
  assert.ok(contextFindings.some((finding) => finding.kind === 'excess-context' && finding.severity === 'info'));
});

test('scanPrivacy returns no findings for clean content', () => {
  assert.deepEqual(scanPrivacy(cleanFields(), [sampleSource()]), []);
});
