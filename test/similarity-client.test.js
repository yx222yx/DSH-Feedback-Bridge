import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

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

const moduleExports = loadClientExports();

function request(overrides = {}) {
  return {
    scenario: 'Export a plugin draft',
    gap: 'Export a plugin draft',
    desired: 'Export a plugin draft',
    type: 'plugin-request',
    language: null,
    ...overrides,
  };
}

test('createSimilarityTransport posts exactly the minimal intent to the similarity route', async () => {
  const calls = [];
  const transport = moduleExports.createSimilarityTransport({
    similarityUrl: '/dsh-feedback-bridge/similarity',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method, body: init.body, signal: init.signal });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok', results: [], sourceStates: [] }),
      });
    },
  });
  const signal = {};
  const outcome = await transport.run(request({ language: 'zh', type: 'harness-defect' }), signal);
  assert.equal(calls[0].input, '/dsh-feedback-bridge/similarity');
  assert.equal(calls[0].method, 'POST');
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body, {
    scenario: 'Export a plugin draft',
    gap: 'Export a plugin draft',
    desired: 'Export a plugin draft',
    type: 'harness-defect',
    language: 'zh',
  });
  assert.equal(calls[0].signal, signal);
  assert.equal(outcome.status, 'ok');
});

test('createSimilarityTransport surfaces a failed similarity HTTP response as a rejection', async () => {
  const transport = moduleExports.createSimilarityTransport({
    similarityUrl: '/dsh-feedback-bridge/similarity',
    fetchImpl() {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    },
  });
  await assert.rejects(() => transport.run(request()), /HTTP 500/);
});

test('similaritySignature is null until scenario, gap, and desired are all non-empty', () => {
  assert.equal(moduleExports.similaritySignature({ scenario: '', gap: 'g', desired: 'd', type: 'custom' }), null);
  assert.equal(moduleExports.similaritySignature({ scenario: 's', gap: '   ', desired: 'd', type: 'custom' }), null);
  assert.equal(moduleExports.similaritySignature({ scenario: 's', gap: 'g', desired: '', type: 'custom' }), null);
  assert.ok(moduleExports.similaritySignature({ scenario: 's', gap: 'g', desired: 'd', type: 'custom' }));
});

test('similaritySignature is stable across whitespace and case but changes with the feedback type', () => {
  const first = moduleExports.similaritySignature({ scenario: '  Export Plugin ', gap: 'Gap', desired: 'Desired', type: 'plugin-request' });
  const second = moduleExports.similaritySignature({ scenario: 'export plugin', gap: 'gap', desired: 'desired', type: 'plugin-request' });
  assert.equal(first, second);
  const third = moduleExports.similaritySignature({ scenario: 'export plugin', gap: 'gap', desired: 'desired', type: 'custom' });
  assert.notEqual(second, third);
});
