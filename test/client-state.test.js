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

/** Fetch-like double that records request bodies and serves a persisted record. */
function recordingFetch(respondWith = { draft: null }) {
  const calls = [];
  return {
    calls,
    impl(input, init = {}) {
      calls.push({ input, method: init.method ?? 'GET', body: init.body ?? null });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(respondWith),
      });
    },
  };
}

test('emptyFeedbackDraft creates a blank custom-feedback draft with the five editable fields', () => {
  assert.deepEqual(moduleExports.emptyFeedbackDraft(), {
    type: 'custom',
    title: '',
    scenario: '',
    gap: '',
    desired: '',
    context: '',
  });
});

test('the session controller carries the authoritative type and language and restores them', () => {
  const controller = moduleExports.createFeedbackSessionController();
  controller.openOrResume();
  assert.equal(controller.getType(), 'custom');
  assert.equal(controller.getLanguage(), undefined);

  controller.setType('harness-defect');
  controller.setLanguage('zh');
  assert.equal(controller.getType(), 'harness-defect');
  assert.equal(controller.getLanguage(), 'zh');

  const resumed = {
    type: 'plugin-request',
    language: 'en',
    title: 't',
    scenario: '',
    gap: '',
    desired: '',
    context: '',
  };
  controller.restore(resumed);
  assert.equal(controller.getType(), 'plugin-request');
  assert.equal(controller.getLanguage(), 'en');

  controller.setLanguage(undefined);
  assert.equal(controller.getLanguage(), undefined);

  controller.cancel();
  assert.equal(controller.getType(), 'custom');
  assert.equal(controller.getLanguage(), undefined);
});

test('the persistence save payload carries the type and omits an unset language', async () => {
  const fetchImpl = recordingFetch();
  const persistence = moduleExports.createDraftPersistence({
    draftUrl: '/dsh-feedback-bridge/draft',
    fetchImpl: fetchImpl.impl,
  });
  const draft = { type: 'harness-defect', title: 't', scenario: '', gap: '', desired: '', context: '' };
  await persistence.save(draft, []);
  const [call] = fetchImpl.calls;
  assert.equal(call.method, 'POST');
  const payload = JSON.parse(call.body);
  assert.equal(payload.action, 'save');
  assert.equal(payload.draft.type, 'harness-defect');
  assert.equal('language' in payload.draft, false);
});

test('the persistence save payload carries the selected language', async () => {
  const fetchImpl = recordingFetch();
  const persistence = moduleExports.createDraftPersistence({
    draftUrl: '/dsh-feedback-bridge/draft',
    fetchImpl: fetchImpl.impl,
  });
  const draft = { type: 'custom', language: 'zh', title: 't', scenario: '', gap: '', desired: '', context: '' };
  await persistence.save(draft, []);
  const payload = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(payload.draft.language, 'zh');
});

test('the persistence load maps the type and language back from a stored record', async () => {
  const fetchImpl = recordingFetch({
    draft: {
      version: 3,
      title: 't',
      scenario: '',
      gap: '',
      desired: '',
      context: '',
      sources: [sampleSource()],
      type: 'harness-defect',
      language: 'zh',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const persistence = moduleExports.createDraftPersistence({
    draftUrl: '/dsh-feedback-bridge/draft',
    fetchImpl: fetchImpl.impl,
  });
  const loaded = await persistence.load();
  assert.equal(loaded.type, 'harness-defect');
  assert.equal(loaded.language, 'zh');
  assert.deepEqual(loaded.sources, [sampleSource()]);
});
