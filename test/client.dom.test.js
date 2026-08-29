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
    throw new Error(`unexpected client require: ${specifier}`);
  });
}

function renderSection(active) {
  const dictionaries = new Map();
  const locale = {
    register(namespace, dict) {
      dictionaries.set(namespace, dict);
      return () => {
        dictionaries.delete(namespace);
      };
    },
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.[active]?.[key] ?? key;
    },
  };
  let captured;
  const slots = {
    inject(slot, callback) {
      callback();
      return () => {};
    },
    register(meta, component) {
      captured = { meta, component };
      return () => {};
    },
  };
  const moduleExports = loadClientExports();
  moduleExports.apply({
    locale,
    slots,
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  });
  return renderToStaticMarkup(React.createElement(captured.component));
}

test('status section renders as real DOM markup in English by default', () => {
  const html = renderSection('en');
  assert.match(html, /data-testid="dsh-feedback-bridge-status"/);
  assert.match(html, /DSH Feedback Bridge/);
  assert.match(html, /Loading status…/);
});

test('status section renders as real DOM markup in Chinese', () => {
  const html = renderSection('zh');
  assert.match(html, /data-testid="dsh-feedback-bridge-status"/);
  assert.match(html, /DSH 社区反馈桥/);
  assert.match(html, /正在加载状态…/);
});

// ---------------------------------------------------------------------------
// Slice 4: left-nav entry + workspace render as real DOM markup (zh/en)
// ---------------------------------------------------------------------------

const moduleExports = loadClientExports();

function renderComponent(Component, props, active) {
  const dictionaries = new Map();
  const locale = {
    register(namespace, dict) {
      dictionaries.set(namespace, dict);
      return () => {
        dictionaries.delete(namespace);
      };
    },
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.[active]?.[key] ?? key;
    },
  };
  let captured;
  const slots = {
    inject(slot, callback) {
      callback();
      return () => {};
    },
    register(meta, component) {
      captured = { meta, component };
      return () => {};
    },
  };
  const moduleExports = loadClientExports();
  moduleExports.apply({ locale, slots, effect(callback) {
    const dispose = callback();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  } });
  const t = locale.bind('dsh-feedback-bridge');
  return renderToStaticMarkup(React.createElement(Component, { t, ...props }));
}

function sessionsWith(draft) {
  return {
    openOrResume() {
      return draft;
    },
    getDraft() {
      return draft;
    },
    update() {},
    cancel() {},
    dispose() {},
  };
}

test('left-nav entry renders the pure Chinese label 社区反馈 in the expanded sidebar', () => {
  const html = renderComponent(moduleExports.FeedbackTrigger, { sessions: sessionsWith(null), wide: true }, 'en');
  assert.match(html, /data-testid="dsh-feedback-trigger"/);
  assert.match(html, /aria-label="社区反馈"/);
  assert.match(html, /title="社区反馈"/);
  // The label span contains exactly the Chinese label — no English text.
  const label = html.match(/<span class="dsh-feedback-trigger-label">([^<]*)<\/span>/);
  assert.ok(label);
  assert.equal(label[1], '社区反馈');
  assert.doesNotMatch(label[1], /[A-Za-z]/);
});

test('collapsed left-nav entry renders an icon-only button with a Chinese accessible name', () => {
  const html = renderComponent(moduleExports.FeedbackTrigger, { sessions: sessionsWith(null), wide: false }, 'zh');
  assert.match(html, /data-testid="dsh-feedback-trigger"/);
  assert.match(html, /aria-label="社区反馈"/);
  assert.match(html, /title="社区反馈"/);
  // Rail state must not render the wide label span.
  assert.doesNotMatch(html, /dsh-feedback-trigger-label/);
  assert.match(html, /dsh-feedback-trigger-rail/);
});

test('feedback workspace renders the five editable fields, type badge, preview and actions in Chinese', () => {
  const draft = {
    type: 'custom',
    title: '标题示例',
    scenario: '场景示例',
    gap: '',
    desired: '期望示例',
    context: '',
  };
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), onClose: () => {} }, 'zh');
  assert.match(html, /data-testid="dsh-feedback-workspace"/);
  assert.match(html, /data-testid="dsh-feedback-type">自定义反馈<\/span>/);
  assert.match(html, /data-testid="dsh-feedback-title"/);
  assert.match(html, /data-testid="dsh-feedback-scenario"/);
  assert.match(html, /data-testid="dsh-feedback-gap"/);
  assert.match(html, /data-testid="dsh-feedback-desired"/);
  assert.match(html, /data-testid="dsh-feedback-context"/);
  // The review card carries the exact Markdown that copy/export would produce.
  assert.match(html, /# 标题示例/);
  assert.match(html, /## 场景\n\n场景示例/);
  assert.match(html, /## 期望结果\n\n期望示例/);
  // Optional empty sections are absent from the exact Markdown.
  assert.doesNotMatch(html, /你碰到的问题或情况\n\n<\/pre>/);
  assert.match(html, /data-testid="dsh-feedback-copy">复制草稿<\/button>/);
  assert.match(html, /data-testid="dsh-feedback-export">导出草稿<\/button>/);
  assert.match(html, /data-testid="dsh-feedback-cancel">取消<\/button>/);
  assert.match(html, /aria-label="关闭"/);
});

test('feedback workspace guidance links to the official DSH Discussions destination', () => {
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(moduleExports.emptyFeedbackDraft()), onClose: () => {} }, 'zh');
  assert.match(html, /data-testid="dsh-feedback-guidance"/);
  assert.match(html, /href="https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/discussions"/);
  assert.match(html, /人工提交指引/);
});

test('feedback workspace renders English labels and English markdown headings when the locale is English', () => {
  const draft = {
    type: 'custom',
    title: 'Add a plugin API',
    scenario: 'I want to call custom tools.',
    gap: '',
    desired: '',
    context: '',
  };
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), onClose: () => {} }, 'en');
  assert.match(html, /data-testid="dsh-feedback-type">Custom feedback<\/span>/);
  assert.match(html, /data-testid="dsh-feedback-copy">Copy draft<\/button>/);
  assert.match(html, /# Add a plugin API/);
  assert.match(html, /## Scenario\n\nI want to call custom tools\./);
  assert.match(html, /Manual submission instructions/);
});
