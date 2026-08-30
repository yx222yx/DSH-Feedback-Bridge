import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

const moduleExports = loadClientExports();

function renderPanel(state, active = 'en') {
  const dictionaries = new Map();
  const locale = {
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.[active]?.[key] ?? key;
    },
  };
  dictionaries.set('dsh-feedback-bridge', moduleExports.dictionaries);
  const t = locale.bind('dsh-feedback-bridge');
  let retries = 0;
  const html = renderToStaticMarkup(React.createElement(moduleExports.SimilarityPanel, {
    t,
    state,
    onRetry() {
      retries += 1;
    },
  }));
  return { html, retries };
}

function okOutcome(results, sourceStates) {
  return { status: 'ok', results, sourceStates };
}

function result(overrides = {}) {
  return {
    id: 'discussion:0',
    source: 'discussion',
    title: 'Export a plugin draft',
    url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1',
    matchedTerms: ['export', 'plugin', 'draft'],
    updatedAt: '2026-08-30T07:16:44+00:00',
    ...overrides,
  };
}

test('SimilarityPanel shows the idle hint until the minimum intent exists', () => {
  const { html } = renderPanel({ phase: 'idle' });
  assert.match(html, /data-testid="dsh-feedback-similarity"/);
  assert.match(html, /data-testid="dsh-feedback-similarity-idle"/);
  assert.match(html, /Similar results appear after the scenario/);
  assert.doesNotMatch(html, /dsh-feedback-similarity-list/);
});

test('SimilarityPanel shows a checking message while the check runs', () => {
  const { html } = renderPanel({ phase: 'checking' });
  assert.match(html, /data-testid="dsh-feedback-similarity-checking"/);
  assert.match(html, /Checking for similar results/);
});

test('SimilarityPanel renders each result with a link, source badge, and matched-terms reason', () => {
  const outcome = okOutcome(
    [
      result(),
      result({ id: 'plugin:0', source: 'plugin', title: '@deepseek-ai/dsh-skill', url: 'https://github.com/deepseek-ai/deepseek-harness', matchedTerms: [] }),
      result({ id: 'documentation:0', source: 'documentation', title: 'Architecture', url: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md', matchedTerms: ['draft'] }),
    ],
    [
      { source: 'discussion', status: 'ok', resultCount: 1 },
      { source: 'plugin', status: 'ok', resultCount: 1 },
      { source: 'documentation', status: 'ok', resultCount: 1 },
    ],
  );
  const { html } = renderPanel({ phase: 'done', outcome });
  assert.match(html, /data-testid="dsh-feedback-similarity-list"/);
  assert.match(html, /data-testid="dsh-feedback-similarity-result"/);
  assert.ok(html.includes('href="https://github.com/deepseek-ai/deepseek-harness/discussions/1"'));
  assert.match(html, /Discussion/);
  assert.match(html, /Plugin/);
  assert.match(html, /Documentation/);
  assert.match(html, /Matched terms: export, plugin, draft/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
});

test('SimilarityPanel explains partial source failure without hiding the successful results', () => {
  const outcome = okOutcome(
    [result()],
    [
      { source: 'discussion', status: 'failed', code: 'rate-limited' },
      { source: 'plugin', status: 'ok', resultCount: 1 },
      { source: 'documentation', status: 'ok', resultCount: 1 },
    ],
  );
  const { html } = renderPanel({ phase: 'done', outcome });
  assert.match(html, /data-testid="dsh-feedback-similarity-partial"/);
  assert.match(html, /Some sources were unavailable/);
  assert.match(html, /rate limited/);
  assert.match(html, /data-testid="dsh-feedback-similarity-retry"/);
  // The successful results still render.
  assert.match(html, /data-testid="dsh-feedback-similarity-result"/);
});

test('SimilarityPanel shows the no-results state only when every enabled source completed without hits', () => {
  const outcome = okOutcome(
    [],
    [
      { source: 'discussion', status: 'empty' },
      { source: 'plugin', status: 'empty' },
      { source: 'documentation', status: 'empty' },
    ],
  );
  const { html } = renderPanel({ phase: 'done', outcome });
  assert.match(html, /data-testid="dsh-feedback-similarity-none"/);
  assert.match(html, /No similar results found/);
  assert.doesNotMatch(html, /dsh-feedback-similarity-partial/);
});

test('SimilarityPanel shows a retryable failure when every source failed', () => {
  const outcome = okOutcome(
    [],
    [
      { source: 'discussion', status: 'failed', code: 'network' },
      { source: 'plugin', status: 'failed', code: 'timeout' },
      { source: 'documentation', status: 'failed', code: 'parse' },
    ],
  );
  const { html } = renderPanel({ phase: 'failed' });
  assert.match(html, /data-testid="dsh-feedback-similarity-failed"/);
  assert.match(html, /could not be completed/);
  assert.match(html, /data-testid="dsh-feedback-similarity-retry"/);
  assert.doesNotMatch(html, /dsh-feedback-similarity-list/);
  assert.doesNotMatch(html, /dsh-feedback-similarity-none/);
});

test('SimilarityPanel renders disabled sources without any visible state', () => {
  const outcome = okOutcome(
    [],
    [
      { source: 'discussion', status: 'disabled' },
      { source: 'plugin', status: 'disabled' },
      { source: 'documentation', status: 'disabled' },
    ],
  );
  const { html } = renderPanel({ phase: 'done', outcome });
  assert.doesNotMatch(html, /dsh-feedback-similarity-none/);
  assert.doesNotMatch(html, /dsh-feedback-similarity-partial/);
  assert.doesNotMatch(html, /dsh-feedback-similarity-list/);
});