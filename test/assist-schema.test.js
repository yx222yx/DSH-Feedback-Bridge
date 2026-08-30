import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAssistText,
  validateAssistResult,
  MAX_MISSING_INFO,
} from '../lib/assist-schema.js';

/** A known-good literal model response; the independent source of truth. */
function validResult(overrides = {}) {
  return {
    type: 'harness-defect',
    typeReason: 'The conversation describes an observable harness failure.',
    missingInfo: [
      { field: 'reproduction', reason: 'Reproduction steps are missing.', importance: 'high' },
    ],
    draft: {
      title: 'Harness crashes on plugin load',
      scenario: 'I loaded a plugin and the harness crashed.',
      gap: 'The harness exits without a message.',
      desired: 'The harness should stay running.',
      context: '',
    },
    privacyFindings: [
      { kind: 'secret', severity: 'critical', quote: 'sk-abc…', reason: 'An API key shape appears.' },
    ],
    ...overrides,
  };
}

test('parseAssistText accepts a clean structured JSON response and returns the validated result', () => {
  const outcome = parseAssistText(JSON.stringify(validResult()));
  assert.equal(outcome.status, 'ok');
  if (outcome.status === 'ok') {
    assert.equal(outcome.result.type, 'harness-defect');
    assert.equal(outcome.result.missingInfo[0].field, 'reproduction');
    assert.equal(outcome.result.draft.title, 'Harness crashes on plugin load');
    assert.equal(outcome.result.privacyFindings[0].severity, 'critical');
  }
});

test('parseAssistText accepts JSON wrapped in prose and markdown fences', () => {
  const text = 'Here is the classification result:\n\n```json\n'
    + JSON.stringify(validResult())
    + '\n```\nHope this helps.';
  const outcome = parseAssistText(text);
  assert.equal(outcome.status, 'ok');
  if (outcome.status === 'ok') assert.equal(outcome.result.type, 'harness-defect');
});

test('parseAssistText reports repair-needed for truncated or unparseable output', () => {
  for (const text of [
    '{',
    '{"type": "harness-defect", "typeReason": "unterminated',
    'not json at all',
    '',
    '[]',
  ]) {
    const outcome = parseAssistText(text);
    assert.equal(outcome.status, 'repair-needed', JSON.stringify(text));
    if (outcome.status === 'repair-needed') assert.ok(outcome.errors.length > 0);
  }
});

test('parseAssistText reports repair-needed when the JSON fails the schema', () => {
  const outcome = parseAssistText(JSON.stringify(validResult({ type: 'mystery' })));
  assert.equal(outcome.status, 'repair-needed');
  if (outcome.status === 'repair-needed') assert.match(outcome.errors.join(' '), /type/);
});

test('validateAssistResult rejects a draft that misses a required public field', () => {
  const broken = validResult();
  delete broken.draft.scenario;
  assert.throws(() => validateAssistResult(broken), /draft/);
});

test('validateAssistResult rejects missing-info entries beyond the cap', () => {
  const tooMany = validResult({
    missingInfo: Array.from({ length: MAX_MISSING_INFO + 1 }, (_, i) => ({
      field: 'reproduction',
      reason: 'r' + i,
      importance: 'low',
    })),
  });
  assert.throws(() => validateAssistResult(tooMany), /missingInfo/);
});

test('validateAssistResult rejects an unknown missing-information topic', () => {
  const broken = validResult({ missingInfo: [{ field: 'kittens', reason: 'x', importance: 'low' }] });
  assert.throws(() => validateAssistResult(broken), /field/);
});

test('validateAssistResult rejects a privacy finding with an unknown severity', () => {
  const broken = validResult({ privacyFindings: [{ kind: 'secret', severity: 'fatal', quote: 'x', reason: 'y' }] });
  assert.throws(() => validateAssistResult(broken), /severity/);
});

test('validateAssistResult rejects an oversized type reason', () => {
  const broken = validResult({ typeReason: 'x'.repeat(501) });
  assert.throws(() => validateAssistResult(broken), /typeReason/);
});
