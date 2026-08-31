import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  apply,
  assertCompatibleDsh,
  compatibilityRangeOf,
  detectDshVersion,
  inject,
  isDshVersionCompatible,
  name,
} from '../lib/index.js';

function createHarness({ dshVersion = '0.1.1-rc.2', routes = new Map() } = {}) {
  const context = new Context();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => {
        routes.delete(route.path);
      };
    },
  };
  return {
    context,
    routes,
    async load() {
      const provider = context.plugin(function provideServices(ctx) {
        ctx.provide('webServer', webServer);
        ctx.provide('sessions', { get() { return undefined; } });
        ctx.provide('llm', { stream() { return []; } });
        ctx.provide('credentials', {
          async readRecord() { return undefined; },
          async modifyRecord() { return undefined; },
          async deleteRecord() {},
          async describeRecord() { return { configured: false, writable: true }; },
          async listRecords() { return []; },
        });
      });
      await provider;
      const previous = process.env.DSH_VERSION;
      process.env.DSH_VERSION = dshVersion;
      const fiber = context.plugin({ name, inject, apply });
      await fiber;
      return { fiber, restore: () => {
        if (previous === undefined) delete process.env.DSH_VERSION;
        else process.env.DSH_VERSION = previous;
      } };
    },
  };
}

test('declares the documented DSH Web host injection', () => {
  assert.equal(name, 'dsh-feedback-bridge');
  assert.deepEqual(inject, ['webServer', 'sessions', 'llm', 'credentials']);
});

test('declared DSH compatibility range accepts the target Web profile and rejects incompatible versions', () => {
  assert.equal(isDshVersionCompatible('0.1.1-rc.2'), true);
  assert.equal(isDshVersionCompatible('0.1.1-rc.10'), true);
  assert.equal(isDshVersionCompatible('0.1.1'), true);
  assert.equal(isDshVersionCompatible('0.0.9'), false);
  assert.equal(isDshVersionCompatible('0.2.0'), false);
  assert.equal(isDshVersionCompatible('not-a-version'), false);
});

test('detectDshVersion prefers the explicit test override', () => {
  const previous = process.env.DSH_VERSION;
  process.env.DSH_VERSION = '0.1.1-rc.2';
  assert.equal(detectDshVersion(), '0.1.1-rc.2');
  if (previous === undefined) delete process.env.DSH_VERSION;
  else process.env.DSH_VERSION = previous;
});

test('compatibilityRangeOf fails loud when the manifest field is missing', () => {
  assert.throws(
    () => compatibilityRangeOf({}),
    /dsh-feedback-bridge: package\.json must declare a non-empty dsh\.compatibility\.dsh range/,
  );
  assert.equal(
    compatibilityRangeOf({ dsh: { compatibility: { dsh: '>=0.1.1-rc.2 <0.2.0' } } }),
    '>=0.1.1-rc.2 <0.2.0',
  );
});

test('assertCompatibleDsh throws a clear message for an incompatible or undetectable version', () => {
  assert.throws(
    () => assertCompatibleDsh('0.0.9'),
    /dsh-feedback-bridge: incompatible DeepSeek Harness version 0\.0\.9; this bundle supports >=0\.1\.1-rc\.2 <0\.2\.0\./,
  );
  assert.throws(
    () => assertCompatibleDsh(null),
    /dsh-feedback-bridge: unable to detect DeepSeek Harness version; this bundle supports >=0\.1\.1-rc\.2 <0\.2\.0\./,
  );
  assert.doesNotThrow(() => assertCompatibleDsh('0.1.1-rc.2'));
});

test('host registers the status and draft routes through webServer and disposes them on unload', async () => {
  const harness = createHarness();
  const { fiber, restore } = await harness.load();
  try {
    assert.equal(harness.routes.size, 7);
    assert.ok(harness.routes.has('/dsh-feedback-bridge/draft'));
    assert.ok(harness.routes.has('/dsh-feedback-bridge/assist'));
    assert.ok(harness.routes.has('/dsh-feedback-bridge/similarity'));
    assert.ok(harness.routes.has('/dsh-feedback-bridge/submission'));
    assert.ok(harness.routes.has('/dsh-feedback-bridge/records'));
    assert.ok(harness.routes.has('/dsh-feedback-bridge/oauth/status'));
    const route = harness.routes.get('/dsh-feedback-bridge/status');
    assert.ok(route);
    assert.equal(route.kind, 'exact');

    const response = {
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
    route.handler({}, response);
    assert.equal(response.code, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    const payload = JSON.parse(response.body);
    assert.equal(payload.name, 'DSH Feedback Bridge');
    assert.equal(payload.status, 'loaded');
    assert.equal(payload.version, '0.1.3');
    assert.equal(payload.dshVersion, '0.1.1-rc.2');
    assert.equal(payload.compatible, true);

    await fiber.dispose();
    assert.equal(harness.routes.size, 0);
  } finally {
    restore();
    const disposed = fiber.dispose();
    if (disposed !== undefined) await disposed.catch(() => {});
  }
});

test('an incompatible DSH version fails before any route is registered', async () => {
  const routes = new Map();
  const context = new Context();
  await context.plugin(function provideServices(ctx) {
    ctx.provide('webServer', {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    });
    ctx.provide('sessions', { get() { return undefined; } });
    ctx.provide('llm', { stream() { return []; } });
    ctx.provide('credentials', {
      async readRecord() { return undefined; },
      async modifyRecord() { return undefined; },
      async deleteRecord() {},
      async describeRecord() { return { configured: false, writable: true }; },
      async listRecords() { return []; },
    });
  });
  const previous = process.env.DSH_VERSION;
  process.env.DSH_VERSION = '0.0.9';
  const fiber = context.plugin({ name, inject, apply });
  await assert.rejects(
    async () => {
      await fiber;
    },
    /dsh-feedback-bridge: incompatible DeepSeek Harness version 0\.0\.9/,
  );
  if (previous === undefined) delete process.env.DSH_VERSION;
  else process.env.DSH_VERSION = previous;
  assert.equal(routes.size, 0);
});