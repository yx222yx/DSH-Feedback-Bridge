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

function sessionsWith(draft, sources = []) {
  return {
    openOrResume() {
      return draft;
    },
    getDraft() {
      return draft;
    },
    update() {},
    restore() {},
    getSources() {
      return sources;
    },
    setSources() {},
    cancel() {},
    dispose() {},
  };
}

/** Fake conversation source for SSR-safe DOM rendering. */
function conversationSourceWith(nodes, overrides = {}) {
  const read = {
    sessionId: overrides.sessionId ?? 'session-1',
    snapshot: { nodes, openState: 'open', ...(overrides.snapshot ?? {}) },
    meta: overrides.meta ?? { title: '我的会话', cwd: '/home/u/p', agentPreset: 'default' },
  };
  return {
    subscribe() {
      return () => {};
    },
    getSnapshot() {
      return read;
    },
    getServerSnapshot() {
      return read;
    },
  };
}

/** SSR-safe persistence stub: renderToStaticMarkup never runs effects. */
function persistenceStub() {
  return {
    load: async () => null,
    save: async () => true,
    remove: async () => true,
    keepalive() {},
    generation: () => 0,
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
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), persistence: persistenceStub(), onClose: () => {} }, 'zh');
  assert.match(html, /data-testid="dsh-feedback-workspace"/);
  assert.match(html, /data-testid="dsh-feedback-type">自定义反馈<\/span>/);
  assert.match(html, /data-testid="dsh-feedback-draft-label">进行中的草稿<\/span>/);
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
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(moduleExports.emptyFeedbackDraft()), persistence: persistenceStub(), onClose: () => {} }, 'zh');
  assert.match(html, /data-testid="dsh-feedback-guidance"/);
  assert.match(html, /href="https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/discussions"/);
  assert.match(html, /人工提交指引/);
});



// ---------------------------------------------------------------------------
// Slice 5: feedback sources panel renders candidates, confirmations and empty states
// ---------------------------------------------------------------------------

function textBlock(text) {
  return { type: 'text', text };
}

function userNode(seq, content) {
  return { kind: 'user', seq, time: seq * 1000, content, source: null };
}

function toolResultNode(seq, callId, content) {
  return { kind: 'tool-result', seq, time: seq * 1000, callId, call: { name: 'bash', argsRaw: 'ls' }, callTime: seq * 1000, content, isError: true, error: undefined, meta: undefined, callView: null, resultView: null, subCalls: [] };
}

test('workspace with an open conversation lists candidate sources with recommended, sensitive and session badges in Chinese', () => {
  const draft = moduleExports.emptyFeedbackDraft();
  const conversation = conversationSourceWith([
    userNode(1, [textBlock('SENTINEL_REVIEWED 我遇到 error 报错')]),
    userNode(2, [textBlock('普通的中段消息')]),
    toolResultNode(3, 'call-9', [textBlock('SENTINEL_DIAG_RAW 工具输出')]),
    userNode(4, [textBlock('我的 api_key 是 sk-abcdef1234567890')]),
  ]);
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), persistence: persistenceStub(), conversation, onClose: () => {} }, 'zh');

  assert.match(html, /data-testid="dsh-feedback-sources"/);
  assert.match(html, /候选来源/);
  assert.match(html, /已确认来源/);
  // Session diagnostics candidate on top.
  assert.match(html, /会话诊断/);
  assert.match(html, /我的会话/);
  // Recommended badges with reasons, distinct from confirmation.
  assert.match(html, /推荐 · 最近一条用户消息/);
  assert.match(html, /推荐 · 提到错误或缺陷/);
  assert.match(html, /推荐 · 工具执行失败/);
  // Advisory sensitive badge.
  assert.match(html, /可能含敏感内容/);
  // Candidate rows carry confirm actions; nothing is pre-selected.
  assert.match(html, /data-testid="dsh-feedback-source-confirm"/);
  assert.doesNotMatch(html, /data-testid="dsh-feedback-source-remove"/);
  assert.doesNotMatch(html, /已确认<[/]span>/);
});

test('workspace confirmed sources render the confirmed state, remove and quote-to-field controls', () => {
  const draft = moduleExports.emptyFeedbackDraft();
  const record = {
    id: 'session-1:node:user:1',
    sessionId: 'session-1',
    kind: 'message',
    role: 'user',
    label: '用户消息',
    text: 'SENTINEL_CONFIRMED 已确认内容',
    truncated: false,
    sensitive: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  const conversation = conversationSourceWith([userNode(1, [textBlock('SENTINEL_CONFIRMED 已确认内容')])]);
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft, [record]), persistence: persistenceStub(), conversation, onClose: () => {} }, 'zh');

  // The confirmed panel lists the record with its captured label and text.
  assert.match(html, /data-testid="dsh-feedback-confirmed-session-1:node:user:1"/);
  assert.match(html, /用户消息/);
  assert.match(html, /SENTINEL_CONFIRMED 已确认内容/);
  // Quote-to-field select offers the four public fields.
  assert.match(html, /data-testid="dsh-feedback-source-quote"/);
  assert.match(html, /选择要引用的字段…/);
  assert.match(html, /<option value="scenario">场景<[/]option>/);
  assert.match(html, /<option value="context">补充上下文<[/]option>/);
  // The matching candidate row shows the confirmed state; remove controls exist.
  assert.match(html, /已确认<[/]span>/);
  assert.match(html, /data-testid="dsh-feedback-source-remove"/);
});

test('workspace without a conversation shows the no-session empty state', () => {
  const draft = moduleExports.emptyFeedbackDraft();
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), persistence: persistenceStub(), conversation: null, onClose: () => {} }, 'zh');
  assert.match(html, /data-testid="dsh-feedback-sources"/);
  assert.match(html, /data-testid="dsh-feedback-sources-empty"/);
  assert.match(html, /当前没有打开的会话/);
});

test('workspace sources panel renders English labels when the locale is English', () => {
  const draft = moduleExports.emptyFeedbackDraft();
  const conversation = conversationSourceWith([userNode(1, [textBlock('a plain message')])]);
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), persistence: persistenceStub(), conversation, onClose: () => {} }, 'en');
  assert.match(html, /Feedback sources/);
  assert.match(html, /Candidate sources/);
  assert.match(html, /Confirmed sources/);
  assert.match(html, /Recommended/);
  assert.match(html, /Confirm/);
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
  const html = renderComponent(moduleExports.FeedbackWorkspace, { sessions: sessionsWith(draft), persistence: persistenceStub(), onClose: () => {} }, 'en');
  assert.match(html, /data-testid="dsh-feedback-type">Custom feedback<\/span>/);
  assert.match(html, /data-testid="dsh-feedback-draft-label">In-progress draft<\/span>/);
  assert.match(html, /data-testid="dsh-feedback-copy">Copy draft<\/button>/);
  assert.match(html, /# Add a plugin API/);
  assert.match(html, /## Scenario\n\nI want to call custom tools\./);
  assert.match(html, /Manual submission instructions/);
});
