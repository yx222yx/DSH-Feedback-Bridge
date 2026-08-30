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

const PREPARED = {
  status: 'ready',
  preparedId: 'nonce-1',
  identity: { login: 'fake-user' },
  categories: [
    { id: 'DIC_ideas', name: 'Ideas' },
    { id: 'DIC_qna', name: 'Q&A' },
  ],
  destination: {
    owner: 'deepseek-ai',
    repo: 'deepseek-harness',
    url: 'https://github.com/deepseek-ai/deepseek-harness/discussions',
  },
};

test('createSubmissionTransport GETs the prepared submission snapshot', async () => {
  const calls = [];
  const transport = moduleExports.createSubmissionTransport({
    submissionUrl: '/dsh-feedback-bridge/submission',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(PREPARED),
      });
    },
  });
  const result = await transport.prepare();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/dsh-feedback-bridge/submission');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(result, PREPARED);
});

test('createSubmissionTransport POSTs exactly the confirm payload', async () => {
  const calls = [];
  const transport = moduleExports.createSubmissionTransport({
    submissionUrl: '/dsh-feedback-bridge/submission',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method, body: init.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1' }),
      });
    },
  });
  const outcome = await transport.confirm({
    preparedId: 'nonce-1',
    title: 'Export a plugin draft',
    body: '# Export a plugin draft',
    categoryId: 'DIC_ideas',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/dsh-feedback-bridge/submission');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), {
    preparedId: 'nonce-1',
    title: 'Export a plugin draft',
    body: '# Export a plugin draft',
    categoryId: 'DIC_ideas',
  });
  assert.deepEqual(outcome, { status: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1' });
});

test('createSubmissionTransport surfaces a failed submission HTTP response as a rejection', async () => {
  const transport = moduleExports.createSubmissionTransport({
    submissionUrl: '/dsh-feedback-bridge/submission',
    fetchImpl() {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    },
  });
  await assert.rejects(() => transport.prepare(), /HTTP 500/);
});
test('createSubmissionTransport prepare appends the explicitly selected account query', async () => {
  const calls = [];
  const transport = moduleExports.createSubmissionTransport({
    submissionUrl: '/dsh-feedback-bridge/submission',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'account-selection-required',
          accounts: [{ login: 'alice' }, { login: 'bob' }],
        }),
      });
    },
  });
  const result = await transport.prepare('alice');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/dsh-feedback-bridge/submission?account=alice');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(result, {
    status: 'account-selection-required',
    accounts: [{ login: 'alice' }, { login: 'bob' }],
  });
});

test('createSubmissionTransport prepare without an account keeps the plain submission URL', async () => {
  const calls = [];
  const transport = moduleExports.createSubmissionTransport({
    submissionUrl: '/dsh-feedback-bridge/submission',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PREPARED) });
    },
  });
  const result = await transport.prepare();
  assert.equal(calls[0].input, '/dsh-feedback-bridge/submission');
  assert.deepEqual(result, PREPARED);
});
