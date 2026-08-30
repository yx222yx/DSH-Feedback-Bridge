import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runAssist,
  buildAssistRequest,
  assembleSourcesText,
  effectiveLanguage,
  MAX_ASSIST_RESPONSE_CHARS,
} from '../lib/assist.js';

/** A known-good literal model result; the independent source of truth. */
const VALID_RESULT = {
  type: 'harness-defect',
  typeReason: 'Observable harness failure.',
  missingInfo: [{ field: 'reproduction', reason: 'Missing repro steps.', importance: 'high' }],
  draft: {
    title: 'Harness crashes on plugin load',
    scenario: 'It crashed.',
    gap: 'No message.',
    desired: 'Stay running.',
    context: '',
  },
  privacyFindings: [],
};

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function failedFinish(code, message) {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }];
}

function sampleSource(overrides = {}) {
  return {
    id: 'session-1:user:3',
    sessionId: 'session-1',
    kind: 'message',
    role: 'user',
    label: '用户消息',
    text: 'SENTINEL_CONFIRMED 我遇到了 error',
    truncated: false,
    sensitive: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sampleInput(overrides = {}) {
  return {
    sessionId: 'session-1',
    language: null,
    currentType: 'custom',
    sources: [sampleSource()],
    ...overrides,
  };
}

function deps(streamImpl, config = { provider: 'deepseek-official', model: 'deepseek-chat' }) {
  return {
    resolveConfig() {
      return config;
    },
    stream: streamImpl,
  };
}

test('runAssist returns a validated result for a clean structured JSON stream', async () => {
  const outcome = await runAssist(deps((options) => textChunks(JSON.stringify(VALID_RESULT))), sampleInput());
  assert.equal(outcome.status, 'ok');
  if (outcome.status === 'ok') {
    assert.equal(outcome.result.type, 'harness-defect');
    assert.equal(outcome.provider, 'deepseek-official');
    assert.equal(outcome.model, 'deepseek-chat');
  }
});

test('runAssist recovers JSON wrapped in markdown fences and prose', async () => {
  const text = 'Sure!\n\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\nDone.';
  const outcome = await runAssist(deps(() => textChunks(text)), sampleInput());
  assert.equal(outcome.status, 'ok');
  if (outcome.status === 'ok') assert.equal(outcome.result.type, 'harness-defect');
});

test('runAssist returns repair-needed preserving the raw text for unparseable output', async () => {
  const outcome = await runAssist(deps(() => textChunks('this is not json at all')), sampleInput());
  assert.equal(outcome.status, 'repair-needed');
  if (outcome.status === 'repair-needed') {
    assert.equal(outcome.rawText, 'this is not json at all');
    assert.ok(outcome.errors.length > 0);
  }
});

test('runAssist returns repair-needed when the stream hit the output cap', async () => {
  const oversized = 'x'.repeat(MAX_ASSIST_RESPONSE_CHARS + 1);
  const outcome = await runAssist(deps(() => textChunks(oversized)), sampleInput());
  assert.equal(outcome.status, 'repair-needed');
  if (outcome.status === 'repair-needed') assert.match(outcome.errors.join(' '), /truncat/i);
});

test('runAssist returns model-failed with the provider failure code', async () => {
  const outcome = await runAssist(deps(() => failedFinish('RATE_LIMIT', 'slow down')), sampleInput());
  assert.equal(outcome.status, 'model-failed');
  if (outcome.status === 'model-failed') {
    assert.equal(outcome.code, 'RATE_LIMIT');
    assert.equal(outcome.message, 'slow down');
  }
});

test('runAssist returns model-failed when the stream throws', async () => {
  const outcome = await runAssist(deps(() => {
    throw new Error('boom');
  }), sampleInput());
  assert.equal(outcome.status, 'model-failed');
});

test('runAssist returns model-failed when stream iteration throws', async () => {
  const throwingIterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          throw new Error('iteration boom');
        },
      };
    },
  };
  const outcome = await runAssist(deps(() => throwingIterable), sampleInput());
  assert.equal(outcome.status, 'model-failed');
  if (outcome.status === 'model-failed') assert.equal(outcome.code, 'UNKNOWN');
});

test('runAssist returns no-model-context when the session has no resolved model config', async () => {
  const outcome = await runAssist({
    resolveConfig() {
      return undefined;
    },
    stream() {
      throw new Error('must not be called');
    },
  }, sampleInput());
  assert.equal(outcome.status, 'no-model-context');
});

test('buildAssistRequest inherits the session config and carries only the confirmed sources', () => {
  const request = buildAssistRequest(
    { provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.3, maxTokens: 4000 },
    sampleInput({ language: 'zh', currentType: 'plugin-request' }),
  );
  assert.equal(request.provider, 'deepseek-official');
  assert.equal(request.model, 'deepseek-chat');
  assert.equal(request.temperature, 0.3);
  assert.equal(request.maxTokens, 4000);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.equal(request.messages[0].source.kind, 'plugin');
  const userText = request.messages[0].content[0].type === 'text' ? request.messages[0].content[0].text : '';
  assert.match(userText, /SENTINEL_CONFIRMED/);
  assert.doesNotMatch(userText, /SENTINEL_UNCONFIRMED/);
  assert.match(request.system ?? '', /Language: zh/);
  assert.match(request.system ?? '', /Current type: plugin-request/);
});

test('buildAssistRequest defaults the language to English when none is selected', () => {
  const request = buildAssistRequest({ provider: 'p', model: 'm' }, sampleInput({ language: null }));
  assert.match(request.system ?? '', /Language: en/);
});

test('assembleSourcesText joins every confirmed source snapshot in order', () => {
  const sources = [
    sampleSource({ id: 's:1', text: 'FIRST_SENTINEL' }),
    sampleSource({ id: 's:2', text: 'SECOND_SENTINEL', kind: 'tool-result', role: 'tool' }),
  ];
  const text = assembleSourcesText(sources);
  assert.ok(text.indexOf('FIRST_SENTINEL') < text.indexOf('SECOND_SENTINEL'));
  assert.match(text, /tool/);
  assert.doesNotMatch(text, /UNCONFIRMED_SENTINEL/);
});

test('effectiveLanguage returns English only when the user has not selected a language', () => {
  assert.equal(effectiveLanguage(null), 'en');
  assert.equal(effectiveLanguage(undefined), 'en');
  assert.equal(effectiveLanguage('zh'), 'zh');
  assert.equal(effectiveLanguage('en'), 'en');
});
