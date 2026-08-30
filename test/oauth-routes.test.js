import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject, name } from '../lib/index.js';

const REPO_PAYLOAD = {
  data: {
    repository: {
      id: 'R_kgDOfficialRepo',
      discussionCategories: { nodes: [{ id: 'DIC_ideas', name: 'Ideas' }] },
    },
  },
};
const DISCUSSION_URL = 'https://github.com/deepseek-ai/deepseek-harness/discussions/4242';
const FAKE_TOKEN = 'gho_route-oauth-secret';
const FAKE_CODE = 'code-route-secret';

/** In-memory fake credentials provider storing one grant record. */
function fakeCredentials() {
  let record;
  return {
    record: () => record,
    async readRecord() { return record; },
    async modifyRecord(_key, mutate) { record = await mutate(record); return record; },
    async deleteRecord() { record = undefined; },
    async describeRecord() { return { configured: record !== undefined, writable: true }; },
    async listRecords() { return record === undefined ? [] : [{ key: 'x', kind: record.kind }]; },
  };
}

/** The HTTP handler harness with every injected service. */
function createHarness(dshHome, config) {
  const routes = new Map();
  const context = new Context();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
  const sessions = { get() { return undefined; } };
  const llm = { stream() { throw new Error('unused'); } };
  const credentials = fakeCredentials();
  return {
    routes,
    credentials,
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', sessions);
        ctx.provide('llm', llm);
        ctx.provide('credentials', credentials);
      });
      await provider;
      const previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = dshHome;
      const previousVersion = process.env.DSH_VERSION;
      process.env.DSH_VERSION = '0.1.1-rc.2';
      const fiber = config === undefined
        ? context.plugin({ name, inject, apply })
        : context.plugin({ name, inject, apply }, config);
      await fiber;
      return {
        fiber,
        restore() {
          if (previousHome === undefined) delete process.env.DSH_HOME;
          else process.env.DSH_HOME = previousHome;
          if (previousVersion === undefined) delete process.env.DSH_VERSION;
          else process.env.DSH_VERSION = previousVersion;
        },
      };
    },
  };
}

function createRequest({ method = 'GET', body = null, url = '/dsh-feedback-bridge/oauth/status' } = {}) {
  const chunks = body === null ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    resume() {},
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async () => (index < chunks.length
          ? { value: chunks[index++], done: false }
          : { value: undefined, done: true }),
      };
    },
  };
}

function createResponse() {
  return {
    code: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function oauthConfig(base, extra = {}) {
  return {
    github: {
      graphqlEndpoint: base + '/graphql',
      timeoutMs: 300,
      auth: { provider: 'oauth' },
      oauth: {
        clientId: 'client-route',
        authorizeEndpoint: base + '/authorize',
        tokenEndpoint: base + '/access_token',
        userEndpoint: base + '/user',
        redirectBaseUrl: 'http://127.0.0.1:0',
        stateTtlMs: 60000,
        timeoutMs: 300,
        ...extra,
      },
    },
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-oauth-routes-'));
}

/** Local fake OAuth + GitHub server. */
async function startFakeServer() {
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body, headers: req.headers });
      if (req.url?.startsWith('/access_token')) {
        const params = new URLSearchParams(body);
        if (params.get('code') !== FAKE_CODE) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_verification_code' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: FAKE_TOKEN, scope: 'repo' }));
        return;
      }
      if (req.url?.startsWith('/user')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ login: 'alice' }));
        return;
      }
      if (req.url?.startsWith('/graphql')) {
        const payload = JSON.parse(body);
        if (/mutation\s+CreateDiscussion/.test(payload.query ?? '')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { createDiscussion: { discussion: { url: DISCUSSION_URL } } } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(REPO_PAYLOAD));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port);
  return { server, requests, base };
}

async function loadOauth(home, config) {
  const harness = createHarness(home, config);
  const { fiber, restore } = await harness.load();
  return { harness, fiber, restore };
}

test('oauth status reports supported false when the plugin ships without the oauth provider', async () => {
  const home = tempHome();
  const harness = createHarness(home, {
    github: { graphqlEndpoint: 'http://127.0.0.1:9/graphql', timeoutMs: 300, auth: { provider: 'none' } },
  });
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/oauth/status');
    assert.ok(route);
    const response = createResponse();
    await route.handler(createRequest(), response);
    assert.equal(response.code, 200);
    assert.deepEqual(JSON.parse(response.body), { supported: false });
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the full oauth flow authorizes through the callback, stores the grant, and submits with exactly one mutation', async () => {
  const fake = await startFakeServer();
  const home = tempHome();
  try {
    const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base));
    try {
      const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
      const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
      const callbackRoute = harness.routes.get('/dsh-feedback-bridge/oauth/callback');
      const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');
      assert.ok(statusRoute && startRoute && callbackRoute && submissionRoute);

      const before = createResponse();
      await statusRoute.handler(createRequest(), before);
      assert.equal(JSON.parse(before.body).supported, true);

      const start = createResponse();
      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), start);
      const started = JSON.parse(start.body);
      assert.equal(started.status, 'running');
      const authorizeUrl = new URL(started.url);
      assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(authorizeUrl.searchParams.get('state'));

      // A spurious callback is refused and leaves the attempt running.
      const spurious = createResponse();
      await callbackRoute.handler(createRequest({ url: '/dsh-feedback-bridge/oauth/callback?state=wrong&code=x' }), spurious);
      assert.equal(spurious.code, 400);
      const stillRunning = createResponse();
      await statusRoute.handler(createRequest(), stillRunning);
      assert.equal(JSON.parse(stillRunning.body).status, 'running');

      // The real callback completes the flow.
      const state = authorizeUrl.searchParams.get('state');
      const callback = createResponse();
      await callbackRoute.handler(createRequest({ url: '/dsh-feedback-bridge/oauth/callback?state=' + state + '&code=' + FAKE_CODE }), callback);
      assert.equal(callback.code, 200);
      const authorized = createResponse();
      await statusRoute.handler(createRequest(), authorized);
      assert.equal(JSON.parse(authorized.body).status, 'authorized');
      assert.deepEqual(JSON.parse(authorized.body).identity, { login: 'alice' });
      assert.equal(harness.credentials.record().payload.login, 'alice', 'the grant must be stored through the credentials service');

      // The route responses never leak the token or the code.
      const responses = [before.body, start.body, spurious.body, stillRunning.body, callback.body, authorized.body];
      assert.ok(responses.every((body) => !body.includes(FAKE_TOKEN) && !body.includes(FAKE_CODE)));

      // Submission now works through the oauth provider with exactly one mutation.
      const prepare = createResponse();
      await submissionRoute.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
      const prepared = JSON.parse(prepare.body);
      assert.equal(prepared.status, 'ready');
      assert.deepEqual(prepared.identity, { login: 'alice' });
      const confirm = createResponse();
      await submissionRoute.handler(createRequest({
        method: 'POST',
        url: '/dsh-feedback-bridge/submission',
        body: JSON.stringify({ preparedId: prepared.preparedId, title: 't', body: 'b', categoryId: 'DIC_ideas' }),
      }), confirm);
      assert.deepEqual(JSON.parse(confirm.body), { status: 'created', url: DISCUSSION_URL });
      const mutations = fake.requests.filter((request) => request.url?.startsWith('/graphql') && /mutation\s+CreateDiscussion/.test(request.body));
      assert.equal(mutations.length, 1, 'exactly one mutation per confirmation');
      assert.equal(mutations[0].headers.authorization, 'Bearer ' + FAKE_TOKEN);
      assert.ok(!JSON.stringify({ prepare: prepare.body, confirm: confirm.body }).includes(FAKE_TOKEN));
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('oauth denial settles as denied, cancel settles as cancelled, and disconnect returns to draft export', async () => {
  const fake = await startFakeServer();
  const home = tempHome();
  try {
    const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base));
    try {
      const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
      const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
      const callbackRoute = harness.routes.get('/dsh-feedback-bridge/oauth/callback');
      const cancelRoute = harness.routes.get('/dsh-feedback-bridge/oauth/cancel');
      const disconnectRoute = harness.routes.get('/dsh-feedback-bridge/oauth/disconnect');
      const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');

      // Denial.
      const startDeny = createResponse();
      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), startDeny);
      const denyState = new URL(JSON.parse(startDeny.body).url).searchParams.get('state');
      const deny = createResponse();
      await callbackRoute.handler(createRequest({ url: '/dsh-feedback-bridge/oauth/callback?state=' + denyState + '&error=access_denied' }), deny);
      const denied = createResponse();
      await statusRoute.handler(createRequest(), denied);
      assert.equal(JSON.parse(denied.body).status, 'failed');
      assert.equal(JSON.parse(denied.body).code, 'denied');

      // Cancel.
      const startCancel = createResponse();
      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), startCancel);
      const cancel = createResponse();
      await cancelRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/cancel' }), cancel);
      const cancelled = createResponse();
      await statusRoute.handler(createRequest(), cancelled);
      assert.equal(JSON.parse(cancelled.body).status, 'cancelled');

      // Authorize, then disconnect: submission returns to authorization-required.
      const startOk = createResponse();
      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), startOk);
      const okState = new URL(JSON.parse(startOk.body).url).searchParams.get('state');
      await callbackRoute.handler(createRequest({ url: '/dsh-feedback-bridge/oauth/callback?state=' + okState + '&code=' + FAKE_CODE }), createResponse());
      const disconnect = createResponse();
      await disconnectRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/disconnect' }), disconnect);
      assert.equal(harness.credentials.record(), undefined);
      const prepare = createResponse();
      await submissionRoute.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
      assert.deepEqual(JSON.parse(prepare.body), { status: 'failed', code: 'authorization-required' });
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});
