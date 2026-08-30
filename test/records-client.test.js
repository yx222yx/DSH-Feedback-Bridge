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

const RECORDS = [
  {
    id: 'record-1',
    title: 'Export a plugin draft',
    url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/4242',
    submittedAt: '2026-08-30T12:00:00.000Z',
    account: 'fake-user',
  },
];

test('createRecordsTransport GETs the records list', async () => {
  const calls = [];
  const transport = moduleExports.createRecordsTransport({
    recordsUrl: '/dsh-feedback-bridge/records',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ records: RECORDS }) });
    },
  });
  const records = await transport.list();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/dsh-feedback-bridge/records');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(records, RECORDS);
});

test('createRecordsTransport resolves an empty list for a missing records field', async () => {
  const transport = moduleExports.createRecordsTransport({
    recordsUrl: '/dsh-feedback-bridge/records',
    fetchImpl() {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
  });
  assert.deepEqual(await transport.list(), []);
});

test('createRecordsTransport surfaces a failed records response as a rejection', async () => {
  const transport = moduleExports.createRecordsTransport({
    recordsUrl: '/dsh-feedback-bridge/records',
    fetchImpl() {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    },
  });
  await assert.rejects(() => transport.list(), /HTTP 500/);
});
