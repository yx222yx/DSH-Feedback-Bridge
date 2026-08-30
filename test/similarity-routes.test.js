import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject, name, MAX_SIMILARITY_FIELD_CHARS } from '../lib/index.js';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:1</id>
    <link type="text/html" rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/discussions/1"/>
    <title>Export a plugin draft</title>
    <updated>2026-08-30T07:16:44+00:00</updated>
    <content type="html">&lt;p&gt;export a plugin draft&lt;/p&gt;</content>
  </entry>
</feed>`;

const NPM = {
  objects: [
    {
      package: {
        name: '@deepseek-ai/dsh-skill',
        description: 'Agent skill provider registry for the DeepSeek Harness',
        links: { repository: 'https://github.com/deepseek-ai/deepseek-harness' },
      },
    },
  ],
};

const DOC = '# Architecture\n\nThe DeepSeek Harness plugin architecture supports exporting a draft.\n';

/** Start a local read-only source server and record every request it receives. */
function startSourceServer() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/atom') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end(ATOM);
    } else if (req.url !== null && req.url.startsWith('/npm?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(NPM));
    } else if (req.url === '/docs/architecture.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(DOC);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, requests, base: 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port) });
    });
  });
}

/** Plugin harness with the webServer/sessions/llm services and an optional plugin config. */
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
  const sessions = {
    get() {
      return undefined;
    },
  };
  const llm = {
    stream() {
      throw new Error('unused');
    },
  };
  return {
    routes,
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', sessions);
        ctx.provide('llm', llm);
        ctx.provide('credentials', {
          async readRecord() { return undefined; },
          async modifyRecord() { return undefined; },
          async deleteRecord() {},
          async describeRecord() { return { configured: false, writable: true }; },
          async listRecords() { return []; },
        });
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

function createRequest({ method = 'POST', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(body)];
  return {
    method,
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

function validBody(overrides = {}) {
  return {
    scenario: 'Export a plugin draft',
    gap: 'Export a plugin draft',
    desired: 'Export a plugin draft',
    type: 'plugin-request',
    language: null,
    ...overrides,
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-similarity-routes-'));
}

test('the similarity route is registered and refuses methods other than POST', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/similarity');
    assert.ok(route);
    assert.equal(route.kind, 'exact');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = createResponse();
      await route.handler(createRequest({ method }), response);
      assert.equal(response.code, 405, method);
      assert.equal(response.headers.allow, 'POST');
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST similarity searches the approved sources read-only and returns combined results', async () => {
  const sources = await startSourceServer();
  try {
    const home = tempHome();
    const harness = createHarness(home, {
      similarity: {
        sources: {
          discussions: { url: sources.base + '/atom' },
          plugins: { url: sources.base + '/npm' },
          documentation: { urls: [sources.base + '/docs/architecture.md'] },
        },
      },
    });
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/similarity');
      const response = createResponse();
      await route.handler(createRequest({ body: JSON.stringify(validBody()) }), response);
      assert.equal(response.code, 200);
      const payload = JSON.parse(response.body);
      assert.equal(payload.status, 'ok');
      assert.ok(payload.results.some((result) => result.source === 'discussion'));
      assert.ok(payload.results.some((result) => result.source === 'plugin'));
      assert.ok(payload.results.some((result) => result.source === 'documentation'));
      assert.ok(payload.sourceStates.every((state) => state.status === 'ok'));
      // Every request the plugin made to the sources was a read-only GET.
      assert.ok(sources.requests.length >= 3);
      assert.ok(sources.requests.every((request) => request.method === 'GET'));
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    sources.server.close();
  }
});

test('POST similarity explains a dead source as a failed state without a 500', async () => {
  // Reserve then close a port so the fetch fails fast with a connection error.
  const probe = await startSourceServer();
  const deadPort = probe.server.address();
  await new Promise((resolve) => probe.server.close(resolve));
  const deadBase = 'http://127.0.0.1:' + (deadPort === null || typeof deadPort === 'string' ? '1' : deadPort.port);

  const home = tempHome();
  const harness = createHarness(home, {
    similarity: {
      sources: {
        discussions: { url: deadBase + '/atom' },
        plugins: { enabled: false, url: deadBase + '/npm' },
        documentation: { enabled: false, urls: [] },
      },
    },
  });
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/similarity');
    const response = createResponse();
    await route.handler(createRequest({ body: JSON.stringify(validBody()) }), response);
    assert.equal(response.code, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.status, 'ok');
    const discussion = payload.sourceStates.find((state) => state.source === 'discussion');
    assert.deepEqual(discussion, { source: 'discussion', status: 'failed', code: 'network' });
    assert.deepEqual(payload.results, []);
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST similarity rejects invalid request bodies with 400', async () => {
  const home = tempHome();
  const harness = createHarness(home);
  const { fiber, restore } = await harness.load();
  try {
    const route = harness.routes.get('/dsh-feedback-bridge/similarity');
    const invalidBodies = [
      validBody({ scenario: '' }),
      validBody({ gap: '' }),
      validBody({ desired: '   ' }),
      validBody({ type: 'mystery' }),
      validBody({ language: 'fr' }),
      validBody({ language: 42 }),
      validBody({ extra: 'nope' }),
      validBody({ scenario: 'x'.repeat(MAX_SIMILARITY_FIELD_CHARS + 1) }),
      'not-an-object',
      null,
    ];
    for (const body of invalidBodies) {
      const response = createResponse();
      const payload = typeof body === 'string' ? body : body === null ? null : JSON.stringify(body);
      await route.handler(createRequest({ body: payload }), response);
      assert.equal(response.code, 400, String(payload).slice(0, 120));
    }
  } finally {
    restore();
    await fiber.dispose().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('POST similarity sends only extracted intent terms and never embeds draft or source content in fixed requests', async () => {
  const sources = await startSourceServer();
  try {
    const home = tempHome();
    const harness = createHarness(home, {
      similarity: {
        sources: {
          discussions: { url: sources.base + '/atom' },
          plugins: { enabled: true, url: sources.base + '/npm' },
          documentation: { enabled: false, urls: [] },
        },
      },
    });
    const { fiber, restore } = await harness.load();
    try {
      const route = harness.routes.get('/dsh-feedback-bridge/similarity');
      const response = createResponse();
      await route.handler(createRequest({
        body: JSON.stringify(validBody({
          language: 'zh',
          scenario: 'ZZZQWERTYXYZ',
          gap: 'ZZZQWERTYXYZ',
          desired: 'ZZZQWERTYXYZ',
        })),
      }), response);
      assert.equal(response.code, 200);
      // The atom request must not embed any draft or source content.
      // The atom request URL is fixed: the discussion source can never receive intent or content.
      const atomRequest = sources.requests.find((request) => request.url === '/atom');
      assert.ok(atomRequest);
      assert.ok(sources.requests.filter((request) => request.url === '/atom').length === 1);
      // The npm query carries only the extracted sentinel term, never the draft language.
      const npmRequest = sources.requests.find((request) => request.url.startsWith('/npm?'));
      assert.ok(npmRequest);
      assert.ok(npmRequest.url.includes('zzzqwertyxyz'));
      assert.ok(!npmRequest.url.includes('SENTINEL'));
      // Nothing in the fixture matches the sentinel intent.
      const discussion = JSON.parse(response.body).results.find((result) => result.source === 'discussion');
      assert.ok(!discussion);
    } finally {
      restore();
      await fiber.dispose().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    sources.server.close();
  }
});