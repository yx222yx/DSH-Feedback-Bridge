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
const { createAssistTransport, effectiveLanguage } = moduleExports;

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

function request(overrides = {}) {
  return {
    sessionId: 'session-1',
    language: null,
    currentType: 'custom',
    sources: [sampleSource()],
    ...overrides,
  };
}

test('createAssistTransport posts exactly the assist request to the assist route', async () => {
  const calls = [];
  const transport = moduleExports.createAssistTransport({
    assistUrl: '/dsh-feedback-bridge/assist',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method, body: init.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok', result: { type: 'custom' } }),
      });
    },
  });
  const outcome = await transport.run(request({ language: 'zh', currentType: 'harness-defect' }));
  assert.deepEqual(calls[0].input, '/dsh-feedback-bridge/assist');
  assert.equal(calls[0].method, 'POST');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.sessionId, 'session-1');
  assert.equal(body.language, 'zh');
  assert.equal(body.currentType, 'harness-defect');
  assert.deepEqual(body.sources, [sampleSource()]);
  assert.equal(outcome.status, 'ok');
});

test('createAssistTransport surfaces a failed assist HTTP response as a rejection', async () => {
  const transport = moduleExports.createAssistTransport({
    assistUrl: '/dsh-feedback-bridge/assist',
    fetchImpl() {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    },
  });
  await assert.rejects(() => transport.run(request()), /HTTP 500/);
});

test('effectiveLanguage defaults to English only when no language is selected', () => {
  assert.equal(effectiveLanguage(null), 'en');
  assert.equal(effectiveLanguage(undefined), 'en');
  assert.equal(effectiveLanguage('zh'), 'zh');
  assert.equal(effectiveLanguage('en'), 'en');
});

test('revalidateRepairText validates a repaired response locally without a model call', () => {
  const valid = moduleExports.revalidateRepairText(JSON.stringify({
    type: 'harness-defect',
    typeReason: 'x',
    missingInfo: [],
    draft: { title: 't', scenario: 's', gap: 'g', desired: 'd', context: 'c' },
    privacyFindings: [],
  }));
  assert.equal(valid.status, 'ok');
  if (valid.status === 'ok') assert.equal(valid.result.type, 'harness-defect');

  const invalid = moduleExports.revalidateRepairText('{"type": "mystery"}');
  assert.equal(invalid.status, 'repair-needed');
  if (invalid.status === 'repair-needed') assert.ok(invalid.errors.length > 0);
});
