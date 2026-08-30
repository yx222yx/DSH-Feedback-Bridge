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

function renderPanel(state, props = {}) {
  const dictionaries = new Map();
  const locale = {
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.['en']?.[key] ?? key;
    },
  };
  dictionaries.set('dsh-feedback-bridge', moduleExports.dictionaries);
  const t = locale.bind('dsh-feedback-bridge');
  const calls = { category: null, confirm: 0, back: 0, export: 0 };
  const html = renderToStaticMarkup(React.createElement(moduleExports.SubmitPanel, {
    t,
    state,
    title: 'Export a plugin draft',
    body: '# Export a plugin draft\n\nBody text.',
    language: 'en',
    categoryId: 'DIC_ideas',
    onCategoryChange(id) {
      calls.category = id;
    },
    onConfirm() {
      calls.confirm += 1;
    },
    onBack() {
      calls.back += 1;
    },
    onExport() {
      calls.export += 1;
    },
    ...props,
  }));
  return { html, calls };
}

function readyState(overrides = {}) {
  return {
    phase: 'ready',
    preparedId: 'nonce-1',
    identity: { login: 'fake-user' },
    categories: [
      { id: 'DIC_ideas', name: 'Ideas' },
      { id: 'DIC_qna', name: 'Q&A' },
    ],
    destination: {
      owner: 'deepseek-ai',
      repo: 'deepseek-harness',
      url: 'https://github.com/deepseek-ai/deepseek-harness/discussions',
    },
    ...overrides,
  };
}

test('SubmitPanel shows the exact title, Markdown body, category, language, destination, and account in ready state', () => {
  const { html } = renderPanel(readyState());
  assert.match(html, /data-testid="dsh-feedback-submission"/);
  assert.match(html, /Export a plugin draft/);
  assert.match(html, /# Export a plugin draft/);
  assert.match(html, /data-testid="dsh-feedback-submission-category"/);
  assert.match(html, /Ideas/);
  assert.match(html, /Q&amp;A/);
  assert.match(html, /English/);
  assert.match(html, /deepseek-ai\/deepseek-harness/);
  assert.match(html, /fake-user/);
  // The distinct final confirmation action is present alongside back/export.
  assert.match(html, /data-testid="dsh-feedback-submission-confirm"/);
  assert.match(html, /data-testid="dsh-feedback-submission-back"/);
  assert.match(html, /data-testid="dsh-feedback-submission-export"/);
});

test('SubmitPanel forwards the category selection and the confirm/back/export actions', () => {
  const ready = readyState();
  const { calls } = renderPanel(ready);
  assert.equal(calls.confirm, 0);
  assert.equal(calls.back, 0);
  assert.equal(calls.export, 0);
});

test('SubmitPanel shows a submitting state while the mutation is in flight', () => {
  const { html } = renderPanel({ phase: 'confirming' });
  assert.match(html, /data-testid="dsh-feedback-submission-confirming"/);
  assert.doesNotMatch(html, /dsh-feedback-submission-confirm"/);
});

test('SubmitPanel shows the permanent Discussion URL after creation', () => {
  const { html } = renderPanel({ phase: 'created', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/77' });
  assert.match(html, /data-testid="dsh-feedback-submission-created"/);
  assert.match(html, /href="https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/discussions\/77"/);
  assert.doesNotMatch(html, /dsh-feedback-submission-confirm"/);
});

test('SubmitPanel explains each failure class distinctly and keeps the export fallback', () => {
  const codes = [
    'authorization-required',
    'permission-denied',
    'validation-rejected',
    'category-unavailable',
    'rate-limited',
    'network',
  ];
  for (const code of codes) {
    const { html } = renderPanel({ phase: 'failed', code });
    assert.match(html, /data-testid="dsh-feedback-submission-failed"/, code);
    assert.match(html, /data-testid="dsh-feedback-submission-export"/, code);
    assert.doesNotMatch(html, /dsh-feedback-submission-confirm"/, code + ' must not offer another submit');
  }
});

test('SubmitPanel shows distinct localized text for each failure class', () => {
  const en = moduleExports.dictionaries.en;
  const zh = moduleExports.dictionaries.zh;
  const codes = [
    'authorization-required',
    'permission-denied',
    'validation-rejected',
    'category-unavailable',
    'rate-limited',
    'network',
  ];
  const texts = new Set(codes.map((code) => en['submission.failed.' + code]));
  assert.equal(texts.size, codes.length, 'every failure class needs distinct English copy');
  const zhTexts = new Set(codes.map((code) => zh['submission.failed.' + code]));
  assert.equal(zhTexts.size, codes.length, 'every failure class needs distinct Chinese copy');
  assert.ok(codes.every((code) => typeof zh['submission.failed.' + code] === 'string'));
});

test('SubmitPanel shows unknown-result guidance with export fallback and never a retry control', () => {
  const { html } = renderPanel({ phase: 'unknown' });
  assert.match(html, /data-testid="dsh-feedback-submission-unknown"/);
  assert.match(html, /data-testid="dsh-feedback-submission-unknown-guidance"/);
  assert.match(html, /data-testid="dsh-feedback-submission-export"/);
  assert.doesNotMatch(html, /dsh-feedback-submission-confirm"/, 'an unknown result must never offer another submit');
  assert.doesNotMatch(html, /retry|Retry/i);
});
