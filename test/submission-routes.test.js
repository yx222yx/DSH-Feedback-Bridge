import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject, name } from '../lib/index.js';

/** GraphQL-shaped payload with the pinned official repo and two categories. */
const REPO_PAYLOAD = {
  data: {
    repository: {
      id: 'R_kgDOfficialRepo',
      discussionCategories: {
        nodes: [
          { id: 'DIC_ideas', name: 'Ideas' },
          { id: 'DIC_qna', name: 'Q&A' },
        ],
      },
    },
  },
};

const DISCUSSION_URL = 'https://github.com/deepseek-ai/deepseek-harness/discussions/4242';

/**
 * Start a local fake GitHub GraphQL server that records every request and
 * answers per scenario. mutationMode controls the CreateDiscussion response:
 * ok (URL), hang (record then never respond -> unknown), or an HTTP/error
 * class.
 */
function startFakeGitHub({ mutationMode = 'ok' } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      const match = /(query|mutation)\s+(\w+)/.exec(body);
      const operation = match === null ? 'unknown' : match[2];
      if (operation === 'PrepareSubmission') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(REPO_PAYLOAD));
        return;
      }
      if (operation === 'CreateDiscussion') {
        if (mutationMode === 'hang') return; // record but never respond
        if (mutationMode === 'rate-limited') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (mutationMode === 'auth-required') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (mutationMode === 'network') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const payload = mutationMode === 'forbidden'
          ? { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }
          : mutationMode === 'validation'
            ? { errors: [{ type: 'VALIDATION', message: 'Title is invalid' }] }
            : { data: { createDiscussion: { discussion: { url: DISCUSSION_URL } } } };
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const base = 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port);
      resolve({ server, requests, base });
    });
  });
}

/** Mutation-count helper: requests whose body carries the CreateDiscussion operation. */
function mutationRequests(requests) {
  return requests.filter((request) => /mutation\s+CreateDiscussion/.test(request.body));
}

/** Plugin harness with the webServer/sessions/llm services and a plugin config. */
function createHarness(dshHome, config) {
  const routes = new Map();
  const context = new Context();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => {
        routes.delete(route.path);
      };
    },
  };
  const sessions = { get() { return undefined; } };
  const llm = { stream() { throw new Error('unused'); } };
  return {
    routes,
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', sessions);
        ctx.provide('llm', llm);
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

function createRequest({ method = 'GET', body = null, url = '/dsh-feedback-bridge/submission' } = {}) {
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

function fakeAuthConfig(base, extra = {}) {
  return {
    github: {
      graphqlEndpoint: base + '/graphql',
      timeoutMs: 300,
      auth: { provider: 'fake', identity: { login: 'fake-user' } },
      ...extra,
    },
  };
}

function confirmBody(overrides = {}) {
  return {
    preparedId: 'nonce-1',
    title: 'Export a plugin draft',
    body: '# Export a plugin draft\n\nBody.',
    categoryId: 'DIC_ideas',
    ...overrides,
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-submission-routes-'));
}

async function loadWithGithub(base, githubConfig) {
  const home = tempHome();
  const harness = createHarness(home, githubConfig);
  const { fiber, restore } = await harness.load();
  return { home, harness, fiber, restore };
}

test('the submission route is registered and refuses methods other than GET/POST', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/submission');
    assert.ok(route);
    assert.equal(route.kind, 'exact');
    for (const method of ['PUT', 'DELETE']) {
      const response = createResponse();
      await route.handler(createRequest({ method }), response);
      assert.equal(response.code, 405, method);
      assert.equal(response.headers.allow, 'GET, POST');
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('prepare without an authorization boundary reports authorization-required with zero GitHub requests', async () => {
  const fake = await startFakeGitHub();
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, {
      github: { graphqlEndpoint: fake.base + '/graphql', timeoutMs: 300, auth: { provider: 'none' } },
    });
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const response = createResponse();
      await route.handler(createRequest({ method: 'GET' }), response);
      assert.equal(response.code, 200);
      assert.deepEqual(JSON.parse(response.body), { status: 'failed', code: 'authorization-required' });
      assert.equal(fake.requests.length, 0, 'no GitHub request may leave the host');
      assert.equal(mutationRequests(fake.requests).length, 0);
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('prepare resolves categories and identity read-only with zero mutation before any confirm', async () => {
  const fake = await startFakeGitHub();
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const response = createResponse();
      await route.handler(createRequest({ method: 'GET' }), response);
      assert.equal(response.code, 200);
      const payload = JSON.parse(response.body);
      assert.equal(payload.status, 'ready');
      assert.ok(typeof payload.preparedId === 'string' && payload.preparedId !== '');
      assert.deepEqual(payload.identity, { login: 'fake-user' });
      assert.deepEqual(payload.categories, [
        { id: 'DIC_ideas', name: 'Ideas' },
        { id: 'DIC_qna', name: 'Q&A' },
      ]);
      assert.deepEqual(payload.destination, {
        owner: 'deepseek-ai',
        repo: 'deepseek-harness',
        url: 'https://github.com/deepseek-ai/deepseek-harness/discussions',
      });
      // Only a read query was sent; no mutation may occur before confirmation.
      assert.equal(mutationRequests(fake.requests).length, 0);
      assert.ok(fake.requests.every((request) => /PrepareSubmission/.test(request.body)));
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('confirm creates exactly one Discussion mutation and returns the permanent URL', async () => {
  const fake = await startFakeGitHub();
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');

      const prepare = createResponse();
      await route.handler(createRequest({ method: 'GET' }), prepare);
      const prepared = JSON.parse(prepare.body);
      assert.equal(prepared.status, 'ready');

      const response = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
      }), response);
      assert.equal(response.code, 200);
      assert.deepEqual(JSON.parse(response.body), { status: 'created', url: DISCUSSION_URL });

      const mutations = mutationRequests(fake.requests);
      assert.equal(mutations.length, 1, 'exactly one mutation per confirm');
      const mutation = JSON.parse(mutations[0].body);
      assert.match(mutation.query, /mutation\s+CreateDiscussion/);
      assert.deepEqual(mutation.variables.input, {
        repositoryId: 'R_kgDOfficialRepo',
        categoryId: 'DIC_ideas',
        title: 'Export a plugin draft',
        body: '# Export a plugin draft\n\nBody.',
      });
      assert.ok(fake.requests.every((request) => !/issues/i.test(request.body) && !/issues/i.test(request.url)));
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('confirm maps every failure class to a distinct outcome with exactly one mutation', async () => {
  const cases = [
    ['rate-limited', { status: 'failed', code: 'rate-limited' }],
    ['auth-required', { status: 'failed', code: 'authorization-required' }],
    ['network', { status: 'failed', code: 'network' }],
    ['forbidden', { status: 'failed', code: 'permission-denied' }],
    ['validation', { status: 'failed', code: 'validation-rejected' }],
  ];
  for (const [mode, expected] of cases) {
    const fake = await startFakeGitHub({ mutationMode: mode });
    try {
      const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
      try {
        const route = harness.routes.get('/dsh-feedback-bridge/submission');
        const prepare = createResponse();
        await route.handler(createRequest({ method: 'GET' }), prepare);
        const prepared = JSON.parse(prepare.body);
        const response = createResponse();
        await route.handler(createRequest({
          method: 'POST',
          body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
        }), response);
        assert.equal(response.code, 200, mode);
        assert.deepEqual(JSON.parse(response.body), expected, mode);
        assert.equal(mutationRequests(fake.requests).length, 1, mode + ' must attempt exactly one mutation');
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

test('confirm with an unknown result performs exactly one mutation and never retries', async () => {
  const fake = await startFakeGitHub({ mutationMode: 'hang' });
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const prepare = createResponse();
      await route.handler(createRequest({ method: 'GET' }), prepare);
      const prepared = JSON.parse(prepare.body);

      const response = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
      }), response);
      assert.equal(response.code, 200);
      assert.deepEqual(JSON.parse(response.body), { status: 'unknown' });
      assert.equal(mutationRequests(fake.requests).length, 1, 'exactly one mutation attempt');

      // No automatic retry: the fake never receives a second mutation.
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(mutationRequests(fake.requests).length, 1, 'an unknown result must never retry');
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('confirm refuses an unknown or already-used prepared id with 409 and no mutation', async () => {
  const fake = await startFakeGitHub();
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const prepare = createResponse();
      await route.handler(createRequest({ method: 'GET' }), prepare);
      const prepared = JSON.parse(prepare.body);

      // Unknown nonce.
      const missing = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify(confirmBody({ preparedId: 'nope' })),
      }), missing);
      assert.equal(missing.code, 409);
      assert.equal(mutationRequests(fake.requests).length, 0);

      // First confirm consumes the nonce; a second confirm must be refused.
      const first = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
      }), first);
      assert.equal(JSON.parse(first.body).status, 'created');
      const second = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
      }), second);
      assert.equal(second.code, 409);
      assert.equal(mutationRequests(fake.requests).length, 1, 'one confirmation may mutate at most once');
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('confirm rejects an unknown category without any mutation', async () => {
  const fake = await startFakeGitHub();
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const prepare = createResponse();
      await route.handler(createRequest({ method: 'GET' }), prepare);
      const prepared = JSON.parse(prepare.body);

      const response = createResponse();
      await route.handler(createRequest({
        method: 'POST',
        body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId, categoryId: 'DIC_mystery' })),
      }), response);
      assert.equal(response.code, 200);
      assert.deepEqual(JSON.parse(response.body), { status: 'failed', code: 'category-unavailable' });
      assert.equal(mutationRequests(fake.requests).length, 0);
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

test('confirm rejects invalid request bodies with 400 and no mutation', async () => {
  const fake = await startFakeGitHub();
  try {
    const { home, harness, fiber, restore } = await loadWithGithub(fake.base, fakeAuthConfig(fake.base));
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/submission');
      const invalidBodies = [
        confirmBody({ title: '' }),
        confirmBody({ title: '   ' }),
        confirmBody({ body: 42 }),
        confirmBody({ preparedId: '' }),
        confirmBody({ categoryId: '' }),
        confirmBody({ extra: 'nope' }),
        { preparedId: 'x', title: 't', body: 'b' },
        'not-an-object',
        null,
      ];
      for (const body of invalidBodies) {
        const response = createResponse();
        const payload = typeof body === 'string' ? body : body === null ? null : JSON.stringify(body);
        await route.handler(createRequest({ method: 'POST', body: payload }), response);
        assert.equal(response.code, 400, String(payload).slice(0, 80));
      }
      assert.equal(mutationRequests(fake.requests).length, 0);
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
  }
});

/**
 * Fake gh runner used by the route-level gh provider tests: canned accounts
 * and tokens with a call log.
 */
function fakeGh(accounts, tokens) {
  const calls = [];
  return {
    calls,
    async listAccounts() {
      calls.push(['listAccounts']);
      return accounts;
    },
    async tokenFor(login) {
      calls.push(['tokenFor', login]);
      const token = tokens[login];
      if (token === undefined) throw new Error('no token for ' + login);
      return token;
    },
  };
}

/** In-memory fake fetch recording every request including its headers. */
function recordFetch() {
  const requests = [];
  return {
    requests,
    impl(url, init) {
      requests.push({ url: String(url), body: String(init?.body ?? ''), headers: { ...(init?.headers ?? {}) } });
      const match = /(query|mutation)\s+(\w+)/.exec(String(init?.body ?? ''));
      const operation = match === null ? 'unknown' : match[2];
      if (operation === 'PrepareSubmission') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => REPO_PAYLOAD,
        });
      }
      if (operation === 'CreateDiscussion') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { createDiscussion: { discussion: { url: DISCUSSION_URL } } } }),
        });
      }
      return Promise.reject(new Error('unexpected fetch: ' + String(init?.body)));
    },
  };
}

const GH_FAKE_TOKEN = 'gho_route-secret-alice';

test('gh provider: prepare with several accounts returns account-selection-required and never fetches', async () => {
  const { createGitHubService } = await import('../lib/github.js');
  const { createSubmissionRouteHandler } = await import('../lib/index.js');
  const { createSubmissionStore } = await import('../lib/submission.js');
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ], { alice: GH_FAKE_TOKEN, bob: 'gho_route-secret-bob' });
  const fetch = recordFetch();
  const service = createGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:8123/graphql', timeoutMs: 300, auth: { provider: 'gh' } },
    { fetchImpl: fetch.impl, gh },
  );
  const handler = createSubmissionRouteHandler(service, createSubmissionStore());
  const response = createResponse();
  await handler(createRequest({ method: 'GET' }), response);
  assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.body), {
    status: 'account-selection-required',
    accounts: [{ login: 'alice' }, { login: 'bob' }],
  });
  assert.equal(fetch.requests.length, 0, 'no GitHub request before an account is chosen');
  assert.equal(mutationRequests(fetch.requests).length, 0);
});

test('gh provider: prepare with an explicitly selected account resolves read-only with that identity', async () => {
  const { createGitHubService } = await import('../lib/github.js');
  const { createSubmissionRouteHandler } = await import('../lib/index.js');
  const { createSubmissionStore } = await import('../lib/submission.js');
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ], { alice: GH_FAKE_TOKEN, bob: 'gho_route-secret-bob' });
  const fetch = recordFetch();
  const service = createGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:8123/graphql', timeoutMs: 300, auth: { provider: 'gh' } },
    { fetchImpl: fetch.impl, gh },
  );
  const handler = createSubmissionRouteHandler(service, createSubmissionStore());
  const response = createResponse();
  await handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission?account=bob' }), response);
  const payload = JSON.parse(response.body);
  assert.equal(payload.status, 'ready');
  assert.deepEqual(payload.identity, { login: 'bob' });
  assert.ok(typeof payload.preparedId === 'string' && payload.preparedId !== '');
  assert.equal(fetch.requests[0].headers.authorization, 'Bearer gho_route-secret-bob');
  assert.equal(mutationRequests(fetch.requests).length, 0);
});

test('gh provider: confirm after an explicit account selection creates exactly one mutation as that account', async () => {
  const { createGitHubService } = await import('../lib/github.js');
  const { createSubmissionRouteHandler } = await import('../lib/index.js');
  const { createSubmissionStore } = await import('../lib/submission.js');
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ], { alice: GH_FAKE_TOKEN, bob: 'gho_route-secret-bob' });
  const fetch = recordFetch();
  const service = createGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:8123/graphql', timeoutMs: 300, auth: { provider: 'gh' } },
    { fetchImpl: fetch.impl, gh },
  );
  const handler = createSubmissionRouteHandler(service, createSubmissionStore());

  const prepare = createResponse();
  await handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission?account=alice' }), prepare);
  const prepared = JSON.parse(prepare.body);
  assert.equal(prepared.status, 'ready');

  const confirm = createResponse();
  await handler(createRequest({
    method: 'POST',
    body: JSON.stringify(confirmBody({ preparedId: prepared.preparedId })),
  }), confirm);
  assert.equal(JSON.parse(confirm.body).status, 'created');

  const mutations = mutationRequests(fetch.requests);
  assert.equal(mutations.length, 1, 'exactly one mutation per confirm');
  assert.equal(fetch.requests[1].headers.authorization, 'Bearer ' + GH_FAKE_TOKEN, 'the mutation runs as the selected account');
  // The token never reaches any route response body.
  assert.ok(!confirm.body.includes(GH_FAKE_TOKEN));
  assert.ok(!prepare.body.includes(GH_FAKE_TOKEN));
});

test('gh provider: prepare with an unknown account returns account-selection-required again', async () => {
  const { createGitHubService } = await import('../lib/github.js');
  const { createSubmissionRouteHandler } = await import('../lib/index.js');
  const { createSubmissionStore } = await import('../lib/submission.js');
  const gh = fakeGh([
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ], { alice: GH_FAKE_TOKEN, bob: 'gho_route-secret-bob' });
  const fetch = recordFetch();
  const service = createGitHubService(
    { graphqlEndpoint: 'http://127.0.0.1:8123/graphql', timeoutMs: 300, auth: { provider: 'gh' } },
    { fetchImpl: fetch.impl, gh },
  );
  const handler = createSubmissionRouteHandler(service, createSubmissionStore());
  const response = createResponse();
  await handler(createRequest({ method: 'GET', url: '/dsh-feedback-bridge/submission?account=mallory' }), response);
  assert.deepEqual(JSON.parse(response.body), {
    status: 'account-selection-required',
    accounts: [{ login: 'alice' }, { login: 'bob' }],
  });
  assert.equal(fetch.requests.length, 0);
});
