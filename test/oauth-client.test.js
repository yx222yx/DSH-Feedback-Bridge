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

function jsonResponse(payload) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
}

test('createOAuthTransport reports the oauth status from the status route', async () => {
  const calls = [];
  const transport = moduleExports.createOAuthTransport({
    statusUrl: '/dsh-feedback-bridge/oauth/status',
    startUrl: '/dsh-feedback-bridge/oauth/start',
    cancelUrl: '/dsh-feedback-bridge/oauth/cancel',
    disconnectUrl: '/dsh-feedback-bridge/oauth/disconnect',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return jsonResponse({ supported: true, status: 'authorized', identity: { login: 'alice' } });
    },
  });
  const status = await transport.status();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/dsh-feedback-bridge/oauth/status');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(status, { supported: true, status: 'authorized', identity: { login: 'alice' } });
});

test('createOAuthTransport starts an attempt and returns the authorize URL', async () => {
  const calls = [];
  const transport = moduleExports.createOAuthTransport({
    statusUrl: '/oauth/status', startUrl: '/oauth/start', cancelUrl: '/oauth/cancel', disconnectUrl: '/oauth/disconnect',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return jsonResponse({ status: 'running', url: 'https://github.com/login/oauth/authorize?state=x' });
    },
  });
  const started = await transport.start();
  assert.equal(calls[0].input, '/oauth/start');
  assert.equal(calls[0].method, 'POST');
  assert.equal(started.url, 'https://github.com/login/oauth/authorize?state=x');
});

test('createOAuthTransport cancels and disconnects with POST requests', async () => {
  const calls = [];
  const transport = moduleExports.createOAuthTransport({
    statusUrl: '/oauth/status', startUrl: '/oauth/start', cancelUrl: '/oauth/cancel', disconnectUrl: '/oauth/disconnect',
    fetchImpl(input, init) {
      calls.push({ input, method: init.method });
      return jsonResponse({ ok: true });
    },
  });
  await transport.cancel();
  await transport.disconnect();
  assert.deepEqual(calls.map((call) => call.input + ' ' + call.method), [
    '/oauth/cancel POST',
    '/oauth/disconnect POST',
  ]);
});
