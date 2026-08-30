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
const FAKE_TOKEN = 'gho_route-device-secret';
const FAKE_DEVICE_CODE = 'device-route-secret';

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
  const { provider = 'oauth', ...oauthExtra } = extra;
  return {
    github: {
      graphqlEndpoint: base + '/graphql',
      timeoutMs: 300,
      auth: { provider },
      oauth: {
        clientId: 'client-route',
        deviceEndpoint: base + '/device',
        tokenEndpoint: base + '/token',
        userEndpoint: base + '/user',
        timeoutMs: 300,
        ...oauthExtra,
      },
    },
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-oauth-routes-'));
}

/** Local fake Device Flow + GitHub server; the token endpoint follows a script. */
async function startFakeServer({ tokenScript, refreshTokenScript } = {}) {
  const { createServer } = await import('node:http');
  const requests = [];
  let tokenCalls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body, headers: req.headers });
      if (req.url?.startsWith('/device')) {
        const params = new URLSearchParams(body);
        assert.equal(params.get('client_id'), 'client-route');
        assert.equal(params.get('client_secret'), null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          device_code: FAKE_DEVICE_CODE,
          user_code: 'ROUTE-CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 0.01,
        }));
        return;
      }
      if (req.url?.startsWith('/token')) {
        tokenCalls += 1;
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'refresh_token') {
          const answer = refreshTokenScript ? refreshTokenScript(tokenCalls) : { error: 'bad_refresh_token' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer));
          return;
        }
        assert.equal(params.get('device_code'), FAKE_DEVICE_CODE);
        assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
        assert.equal(params.get('client_secret'), null);
        const answer = tokenScript(tokenCalls);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
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

/** Poll the status route until it leaves the running phase. */
async function waitForTerminal(route, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = createResponse();
    await route.handler(createRequest(), response);
    const payload = JSON.parse(response.body);
    if (payload.status !== 'running') return payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('oauth flow did not settle');
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
    assert.deepEqual(JSON.parse(response.body), { supported: false });
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('device flow authorizes through host polling, stores the grant, and submits with exactly one mutation; no callback route exists', async () => {
  const fake = await startFakeServer({ tokenScript: (n) => (n === 1 ? { error: 'authorization_pending' } : { access_token: FAKE_TOKEN, scope: 'public_repo' }) });
  const home = tempHome();
  try {
    const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base));
    try {
      const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
      const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
      const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');
      assert.ok(statusRoute && startRoute && submissionRoute);
      assert.equal(harness.routes.get('/dsh-feedback-bridge/oauth/callback'), undefined, 'no callback route may exist for device flow');

      const start = createResponse();
      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), start);
      const started = JSON.parse(start.body);
      assert.equal(started.status, 'running');
      assert.equal(started.verificationUri, 'https://github.com/login/device');
      assert.equal(started.userCode, 'ROUTE-CODE');

      const running = createResponse();
      await statusRoute.handler(createRequest(), running);
      const runningPayload = JSON.parse(running.body);
      assert.equal(runningPayload.status, 'running');
      assert.equal(runningPayload.userCode, 'ROUTE-CODE');
      assert.ok(!JSON.stringify(runningPayload).includes(FAKE_DEVICE_CODE), 'the device code must never reach the Client');

      const terminal = await waitForTerminal(statusRoute);
      assert.equal(terminal.status, 'authorized');
      assert.deepEqual(terminal.identity, { login: 'alice' });
      assert.equal(harness.credentials.record().payload.login, 'alice', 'the grant must be stored through the credentials service');
      assert.ok(!JSON.stringify(terminal).includes(FAKE_TOKEN), 'the token must never reach the Client');
      assert.ok(!JSON.stringify(terminal).includes(FAKE_DEVICE_CODE));

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
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('device flow denial and expiry settle as distinct failures with zero mutation', async () => {
  for (const [script, expected] of [
    [() => ({ error: 'access_denied' }), 'denied'],
    [() => ({ error: 'expired_token' }), 'expired'],
    [() => ({ access_token: 'gho_x', scope: 'repo' }), 'insufficient-scope'],
  ]) {
    const fake = await startFakeServer({ tokenScript: script });
    const home = tempHome();
    try {
      const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base));
      try {
        const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
        const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
        await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), createResponse());
        const terminal = await waitForTerminal(statusRoute);
        assert.equal(terminal.status, 'failed', expected);
        assert.equal(terminal.code, expected);
        assert.equal(harness.credentials.record(), undefined, 'a failed flow must never commit a grant');
        const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');
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
  }
});

test('cancelling the device flow settles as cancelled, and disconnect returns to draft export', async () => {
  const fake = await startFakeServer({ tokenScript: () => ({ error: 'authorization_pending' }) });
  const home = tempHome();
  try {
    const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base));
    try {
      const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
      const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
      const cancelRoute = harness.routes.get('/dsh-feedback-bridge/oauth/cancel');
      const disconnectRoute = harness.routes.get('/dsh-feedback-bridge/oauth/disconnect');
      const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');

      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), createResponse());
      await new Promise((resolve) => setTimeout(resolve, 60));
      const cancel = createResponse();
      await cancelRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/cancel' }), cancel);
      const cancelled = createResponse();
      await statusRoute.handler(createRequest(), cancelled);
      assert.equal(JSON.parse(cancelled.body).status, 'cancelled');
      assert.equal(harness.credentials.record(), undefined);

      // Authorize, then disconnect: submission returns to authorization-required.
      const fakeOk = await startFakeServer({ tokenScript: (n) => (n === 1 ? { error: 'authorization_pending' } : { access_token: FAKE_TOKEN, scope: 'public_repo' }) });
      try {
        const home2 = tempHome();
        const { harness: harness2, fiber: fiber2, restore: restore2 } = await loadOauth(home2, oauthConfig(fakeOk.base));
        try {
          const statusRoute2 = harness2.routes.get('/dsh-feedback-bridge/oauth/status');
          const startRoute2 = harness2.routes.get('/dsh-feedback-bridge/oauth/start');
          const disconnectRoute2 = harness2.routes.get('/dsh-feedback-bridge/oauth/disconnect');
          const submissionRoute2 = harness2.routes.get('/dsh-feedback-bridge/submission');
          await startRoute2.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), createResponse());
          await waitForTerminal(statusRoute2);
          const disconnect = createResponse();
          await disconnectRoute2.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/disconnect' }), disconnect);
          assert.equal(harness2.credentials.record(), undefined);
          const prepare = createResponse();
          await submissionRoute2.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
          assert.deepEqual(JSON.parse(prepare.body), { status: 'failed', code: 'authorization-required' });
        } finally {
          restore2();
          await fiber2.dispose().catch(() => {});
          rmSync(home2, { recursive: true, force: true });
        }
      } finally {
        fakeOk.server.close();
      }
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

/** Test-only fake `gh` shim with one stored account, served from a temp PATH dir. */
const DUAL_GH_SHIM = [
  '#!/usr/bin/env bash',
  'set -e',
  'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
  '  printf "github.com\n  ✓ Logged in to github.com account gh-user (/h.yml)\n  - Active account: true\n  - Token: gho_x\n"',
  '  exit 0',
  'fi',
  'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then',
  '  echo "gho_dual-shim-token"',
  '  exit 0',
  'fi',
  'echo "unexpected gh: $*" >&2',
  'exit 1',
  '',
].join('\n');

test('the dual provider requires an explicit auth choice, then honors both the gh and device flow methods', async () => {
  const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import('node:fs');
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-gh-shim-'));
  const shimPath = join(shimDir, 'gh');
  writeFileSync(shimPath, DUAL_GH_SHIM);
  chmodSync(shimPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = shimDir + (previousPath ? ':' + previousPath : '');
  try {
    const fake = await startFakeServer({ tokenScript: (n) => (n === 1 ? { error: 'authorization_pending' } : { access_token: 'gho_dual-oauth-token', scope: 'public_repo' }) });
    const home = tempHome();
    try {
      const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base, { provider: 'both' }));
      try {
        const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');
        const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
        const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
        assert.ok(submissionRoute && startRoute && statusRoute);

        const choice = createResponse();
        await submissionRoute.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), choice);
        assert.deepEqual(JSON.parse(choice.body), { status: 'auth-method-required', ghAvailable: true });

        const ghPrepare = createResponse();
        await submissionRoute.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission?method=gh' }), ghPrepare);
        const ghPrepared = JSON.parse(ghPrepare.body);
        assert.equal(ghPrepared.status, 'ready');
        assert.deepEqual(ghPrepared.identity, { login: 'gh-user' });
        const ghConfirm = createResponse();
        await submissionRoute.handler(createRequest({
          method: 'POST',
          url: '/dsh-feedback-bridge/submission',
          body: JSON.stringify({ preparedId: ghPrepared.preparedId, title: 't', body: 'b', categoryId: 'DIC_ideas' }),
        }), ghConfirm);
        assert.equal(JSON.parse(ghConfirm.body).status, 'created');
        const ghMutation = fake.requests.find((request) => request.url?.startsWith('/graphql') && /mutation\s+CreateDiscussion/.test(request.body));
        assert.ok(ghMutation);
        assert.equal(ghMutation.headers.authorization, 'Bearer gho_dual-shim-token', 'the gh path must submit with the CLI token');

        await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), createResponse());
        const terminal = await waitForTerminal(statusRoute);
        assert.equal(terminal.status, 'authorized');
        assert.deepEqual(terminal.identity, { login: 'alice' });
        const oauthPrepare = createResponse();
        await submissionRoute.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission?method=oauth' }), oauthPrepare);
        const oauthPrepared = JSON.parse(oauthPrepare.body);
        assert.equal(oauthPrepared.status, 'ready');
        assert.deepEqual(oauthPrepared.identity, { login: 'alice' });
        const oauthConfirm = createResponse();
        await submissionRoute.handler(createRequest({
          method: 'POST',
          url: '/dsh-feedback-bridge/submission',
          body: JSON.stringify({ preparedId: oauthPrepared.preparedId, title: 't', body: 'b', categoryId: 'DIC_ideas' }),
        }), oauthConfirm);
        assert.equal(JSON.parse(oauthConfirm.body).status, 'created');
        const oauthMutations = fake.requests.filter((request) => request.url?.startsWith('/graphql') && /mutation\s+CreateDiscussion/.test(request.body));
        assert.equal(oauthMutations.length, 2, 'one gh mutation and one oauth mutation');
        assert.equal(oauthMutations[1].headers.authorization, 'Bearer gho_dual-oauth-token', 'the device path must submit with the grant token');
      } finally {
        restore();
        await fiber.dispose().catch(() => {});
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      fake.server.close();
    }
  } finally {
    process.env.PATH = previousPath;
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test('an expired device-flow grant is renewed automatically through the refresh token before submission', async () => {
  const fake = await startFakeServer({
    tokenScript: (n) => (n === 1 ? { error: 'authorization_pending' } : {
      access_token: FAKE_TOKEN,
      scope: 'public_repo',
      refresh_token: 'ghr_route-refresh',
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
    }),
    refreshTokenScript: () => ({
      access_token: 'gho_route-renewed',
      scope: 'public_repo',
      refresh_token: 'ghr_route-rotated',
      expires_in: 28800,
    }),
  });
  const home = tempHome();
  try {
    const { harness, fiber, restore } = await loadOauth(home, oauthConfig(fake.base));
    try {
      const statusRoute = harness.routes.get('/dsh-feedback-bridge/oauth/status');
      const startRoute = harness.routes.get('/dsh-feedback-bridge/oauth/start');
      const submissionRoute = harness.routes.get('/dsh-feedback-bridge/submission');

      // Authorize: the stored grant carries the refresh token and both expiries.
      await startRoute.handler(createRequest({ method: 'POST', url: '/dsh-feedback-bridge/oauth/start' }), createResponse());
      const terminal = await waitForTerminal(statusRoute);
      assert.equal(terminal.status, 'authorized');
      const stored = harness.credentials.record().payload;
      assert.equal(stored.refreshToken, 'ghr_route-refresh');
      assert.ok(stored.expiresAt > Date.now());
      assert.ok(stored.refreshTokenExpiresAt > Date.now());

      // Simulate the access token expiring while the grant stays stored.
      stored.expiresAt = Date.now() - 1000;

      // Prepare renews the grant first, then answers with the fresh token.
      const prepare = createResponse();
      await submissionRoute.handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission' }), prepare);
      const prepared = JSON.parse(prepare.body);
      assert.equal(prepared.status, 'ready');
      const refreshRequest = fake.requests.find((request) => request.url?.startsWith('/token') && request.body.includes('grant_type=refresh_token'));
      assert.ok(refreshRequest, 'the expired grant must be renewed before preparing');
      const renewed = harness.credentials.record().payload;
      assert.equal(renewed.accessToken, 'gho_route-renewed');
      assert.equal(renewed.refreshToken, 'ghr_route-rotated');

      // The single mutation runs with the renewed token.
      const confirm = createResponse();
      await submissionRoute.handler(createRequest({
        method: 'POST',
        url: '/dsh-feedback-bridge/submission',
        body: JSON.stringify({ preparedId: prepared.preparedId, title: 't', body: 'b', categoryId: 'DIC_ideas' }),
      }), confirm);
      assert.equal(JSON.parse(confirm.body).status, 'created');
      const mutations = fake.requests.filter((request) => request.url?.startsWith('/graphql') && /mutation\s+CreateDiscussion/.test(request.body));
      assert.equal(mutations.length, 1, 'exactly one mutation per confirmation');
      assert.equal(mutations[0].headers.authorization, 'Bearer gho_route-renewed', 'the mutation must run with the renewed token');
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

