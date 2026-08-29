import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Minimal React stand-in for pure-function tests; interactions add state later. */
function createBaseReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props, children };
    },
    Fragment: 'fragment',
    useState(initial) {
      return [initial, () => {}];
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial };
    },
  };
}

function loadClientExports(React = createBaseReact(), win = {}) {
  let registration;
  win.__ModuleLoader__ = {
    load(value) {
      registration = value;
    },
  };
  new Function('window', clientBundle)(win);
  assert.ok(registration);
  return registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected client require: ${specifier}`);
  });
}

const zhHeadings = {
  scenario: '场景',
  gap: '当前缺口或行为',
  desired: '期望结果',
  context: '补充上下文',
};
const enHeadings = {
  scenario: 'Scenario',
  gap: 'Current gap or behavior',
  desired: 'Desired result',
  context: 'Additional context',
};

test('emptyFeedbackDraft creates a blank custom-feedback draft with the five editable fields', () => {
  const moduleExports = loadClientExports();
  assert.deepEqual(moduleExports.emptyFeedbackDraft(), {
    type: 'custom',
    title: '',
    scenario: '',
    gap: '',
    desired: '',
    context: '',
  });
});

test('the manual submission destination is the official DeepSeek Harness Discussions URL', () => {
  const moduleExports = loadClientExports();
  assert.equal(moduleExports.OFFICIAL_DISCUSSIONS_URL, 'https://github.com/deepseek-ai/deepseek-harness/discussions');
});

test('the exported draft file uses a stable markdown filename', () => {
  const moduleExports = loadClientExports();
  assert.equal(moduleExports.feedbackDraftFileName(), 'dsh-community-feedback-draft.md');
});

test('buildDraftMarkdown renders the exact expected markdown for a fully filled Chinese draft', () => {
  const moduleExports = loadClientExports();
  const draft = {
    type: 'custom',
    title: '我想给 Harness 加一个插件 API',
    scenario: '我经常在对话中想调用自定义工具。',
    gap: 'Harness 没有公开的注册接口。',
    desired: '提供文档化的插件注册 API。',
    context: '用户故事与示例代码。',
  };
  const expected = [
    '# 我想给 Harness 加一个插件 API',
    '',
    '## 场景',
    '',
    '我经常在对话中想调用自定义工具。',
    '',
    '## 当前缺口或行为',
    '',
    'Harness 没有公开的注册接口。',
    '',
    '## 期望结果',
    '',
    '提供文档化的插件注册 API。',
    '',
    '## 补充上下文',
    '',
    '用户故事与示例代码。',
  ].join('\n');
  assert.equal(moduleExports.buildDraftMarkdown(draft, zhHeadings), expected);
});

test('buildDraftMarkdown omits empty optional sections and keeps multiline values intact', () => {
  const moduleExports = loadClientExports();
  const draft = {
    type: 'custom',
    title: '标题',
    scenario: '第一行\n第二行',
    gap: '',
    desired: '期望',
    context: '   ',
  };
  const expected = [
    '# 标题',
    '',
    '## 场景',
    '',
    '第一行\n第二行',
    '',
    '## 期望结果',
    '',
    '期望',
  ].join('\n');
  assert.equal(moduleExports.buildDraftMarkdown(draft, zhHeadings), expected);
});

test('buildDraftMarkdown emits no H1 without a title and an empty string for an empty draft', () => {
  const moduleExports = loadClientExports();
  const titled = {
    type: 'custom',
    title: '   ',
    scenario: '只有场景',
    gap: '',
    desired: '',
    context: '',
  };
  assert.equal(moduleExports.buildDraftMarkdown(titled, zhHeadings), '## 场景\n\n只有场景');
  const empty = moduleExports.emptyFeedbackDraft();
  assert.equal(moduleExports.buildDraftMarkdown(empty, zhHeadings), '');
});

test('buildDraftMarkdown uses English section headings for an English workspace locale', () => {
  const moduleExports = loadClientExports();
  const draft = {
    type: 'custom',
    title: 'Add a plugin API',
    scenario: 'I want to call a custom tool in conversations.',
    gap: 'Harness exposes no public registration interface.',
    desired: '',
    context: '',
  };
  const expected = [
    '# Add a plugin API',
    '',
    '## Scenario',
    '',
    'I want to call a custom tool in conversations.',
    '',
    '## Current gap or behavior',
    '',
    'Harness exposes no public registration interface.',
  ].join('\n');
  assert.equal(moduleExports.buildDraftMarkdown(draft, enHeadings), expected);
});

// ---------------------------------------------------------------------------
// Slice 3: workspace interactions (stateful renderer + fake window)
// ---------------------------------------------------------------------------

/** Stateful fake React: persists hook state across re-renders, runs effects. */
function createStatefulReact() {
  const hookSlots = [];
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) {
      return { type, props, children };
    },
    Fragment: 'fragment',
    useState(initial) {
      const i = cursor++;
      if (hookSlots[i] === undefined) hookSlots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        hookSlots[i].value,
        (next) => {
          hookSlots[i].value = typeof next === 'function' ? next(hookSlots[i].value) : next;
        },
      ];
    },
    useEffect(effect) {
      const i = cursor++;
      if (hookSlots[i] === undefined) hookSlots[i] = { cleanup: null, effect: null };
      hookSlots[i].effect = effect;
      this.pendingEffects.push(hookSlots[i]);
    },
    useRef(initial) {
      const i = cursor++;
      if (hookSlots[i] === undefined) hookSlots[i] = { value: { current: initial } };
      return hookSlots[i].value;
    },
  };
  function invoke(vnode) {
    if (vnode === null || vnode === undefined || typeof vnode !== 'object') return vnode;
    if (typeof vnode.type === 'function') {
      return invoke(vnode.type(vnode.props));
    }
    if (Array.isArray(vnode.children)) {
      return { ...vnode, children: vnode.children.map(invoke) };
    }
    return vnode;
  }
  function render(fn) {
    cursor = 0;
    React.pendingEffects = [];
    const vnode = invoke(fn());
    for (const slot of React.pendingEffects) {
      if (slot.cleanup) slot.cleanup();
      if (slot.effect) slot.cleanup = slot.effect();
    }
    return vnode;
  }
  function reset() {
    hookSlots.length = 0;
    cursor = 0;
    React.pendingEffects = [];
  }
  return { React, render, reset };
}

/** Fake browser surface: clipboard, downloads, revocation, listeners, network log. */
function createFakeWindow() {
  const state = {
    listeners: {},
    clipboard: [],
    downloads: [],
    revoked: [],
    anchorClicks: 0,
    network: [],
  };
  const document = {
    addEventListener(name, fn) {
      (state.listeners[name] ??= []).push(fn);
    },
    removeEventListener(name, fn) {
      state.listeners[name] = (state.listeners[name] ?? []).filter((existing) => existing !== fn);
    },
    createElement(tag) {
      return {
        tag,
        style: {},
        setAttribute() {},
        click() {
          state.anchorClicks += 1;
        },
      };
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
    execCommand: () => true,
  };
  const window = {
    document,
    navigator: {
      clipboard: {
        writeText: async (text) => {
          state.clipboard.push(text);
        },
      },
    },
    URL: {
      createObjectURL: (blob) => {
        state.downloads.push(blob);
        return `blob:mock-${state.downloads.length}`;
      },
      revokeObjectURL: (url) => {
        state.revoked.push(url);
      },
    },
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    fetch: async (...args) => {
      state.network.push(['fetch', ...args]);
      throw new Error('workspace must not fetch');
    },
    XMLHttpRequest: class {
      open() {
        state.network.push(['xhr-open']);
      }
      send() {
        state.network.push(['xhr-send']);
      }
    },
  };
  return { window, state };
}

function findByTestId(vnode, testid) {
  if (vnode == null || typeof vnode !== 'object') return null;
  if (vnode.props && vnode.props['data-testid'] === testid) return vnode;
  if (Array.isArray(vnode.children)) {
    for (const child of vnode.children) {
      const found = findByTestId(child, testid);
      if (found) return found;
    }
  }
  return null;
}

function collectText(vnode, acc = []) {
  if (vnode === null || vnode === undefined) return acc;
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    acc.push(String(vnode));
    return acc;
  }
  if (Array.isArray(vnode)) {
    for (const child of vnode) collectText(child, acc);
    return acc;
  }
  if (typeof vnode === 'object' && Array.isArray(vnode.children)) {
    for (const child of vnode.children) collectText(child, acc);
  }
  return acc;
}

test('opening the workspace starts a custom-feedback session and typing updates the exact preview', async () => {
  const { React, render } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const closed = [];
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => closed.push(true) });

  let vnode = render(workspace);
  assert.ok(findByTestId(vnode, 'dsh-feedback-workspace'));
  const typeBadge = findByTestId(vnode, 'dsh-feedback-type');
  assert.equal(typeBadge.children.join(''), '自定义反馈');

  const set = (testid, value) => {
    findByTestId(vnode, testid).props.onChange({ target: { value } });
    vnode = render(workspace);
  };
  set('dsh-feedback-title', '我想给 Harness 加一个插件 API');
  set('dsh-feedback-scenario', '我经常在对话中想调用自定义工具。');
  set('dsh-feedback-gap', 'Harness 没有公开的注册接口。');
  set('dsh-feedback-desired', '提供文档化的插件注册 API。');
  set('dsh-feedback-context', '用户故事与示例代码。');

  const preview = findByTestId(vnode, 'dsh-feedback-preview');
  assert.equal(preview.children.join(''), [
    '# 我想给 Harness 加一个插件 API',
    '',
    '## 场景',
    '',
    '我经常在对话中想调用自定义工具。',
    '',
    '## 当前缺口或行为',
    '',
    'Harness 没有公开的注册接口。',
    '',
    '## 期望结果',
    '',
    '提供文档化的插件注册 API。',
    '',
    '## 补充上下文',
    '',
    '用户故事与示例代码。',
  ].join('\n'));

  // The in-memory draft is written back so a reopened workspace resumes it.
  assert.equal(sessions.getDraft().title, '我想给 Harness 加一个插件 API');
  assert.equal(state.network.length, 0);
});

test('copy puts the exact markdown on the clipboard and shows the copied notice without network', async () => {
  const { React, render } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => {} });

  let vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '标题' } });
  vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-scenario').props.onChange({ target: { value: '场景内容' } });
  vnode = render(workspace);

  findByTestId(vnode, 'dsh-feedback-copy').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.clipboard.length, 1);
  assert.equal(state.clipboard[0], '# 标题\n\n## 场景\n\n场景内容');

  vnode = render(workspace);
  const notice = findByTestId(vnode, 'dsh-feedback-notice');
  assert.equal(notice.children.join(''), '已复制到剪贴板');
  assert.equal(state.network.length, 0);
});

test('export downloads a markdown file with the exact preview content and revokes its object URL', async () => {
  const { React, render } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => {} });

  let vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '标题' } });
  vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-scenario').props.onChange({ target: { value: '场景内容' } });
  vnode = render(workspace);

  findByTestId(vnode, 'dsh-feedback-export').props.onClick();

  assert.equal(state.downloads.length, 1);
  const blob = state.downloads[0];
  const text = await blob.text();
  assert.equal(text, '# 标题\n\n## 场景\n\n场景内容');
  assert.equal(state.anchorClicks, 1);
  assert.equal(state.revoked.length, 1);
  assert.equal(state.revoked[0], 'blob:mock-1');

  vnode = render(workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '已导出 Markdown 文件');
  assert.equal(state.network.length, 0);
});

test('copy and export are disabled until a title is entered', () => {
  const { React, render } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => {} });

  let vnode = render(workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-copy').props.disabled, true);
  assert.equal(findByTestId(vnode, 'dsh-feedback-export').props.disabled, true);

  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '有标题' } });
  vnode = render(workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-copy').props.disabled, false);
  assert.equal(findByTestId(vnode, 'dsh-feedback-export').props.disabled, false);
  assert.equal(state.network.length, 0);
});

test('closing the workspace keeps the draft; reopening resumes it', () => {
  const { React, render, reset } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const closed = [];
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => closed.push(true) });

  let vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '草稿标题' } });
  vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-scenario').props.onChange({ target: { value: '草稿场景' } });
  vnode = render(workspace);

  // Close via the workspace close control (X): draft survives in memory.
  findByTestId(vnode, 'dsh-feedback-close').props.onClick();
  assert.equal(closed.length, 1);
  assert.deepEqual(sessions.getDraft(), { type: 'custom', title: '草稿标题', scenario: '草稿场景', gap: '', desired: '', context: '' });

  // A fresh workspace mount resumes the same draft.
  reset();
  vnode = render(workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-title').props.value, '草稿标题');
  assert.equal(findByTestId(vnode, 'dsh-feedback-scenario').props.value, '草稿场景');
  assert.equal(state.network.length, 0);
});

test('cancel discards the draft: reopening starts a blank custom-feedback session', () => {
  const { React, render, reset } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const closed = [];
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => closed.push(true) });

  let vnode = render(workspace);
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '要丢弃的草稿' } });
  vnode = render(workspace);

  findByTestId(vnode, 'dsh-feedback-cancel').props.onClick();
  assert.equal(closed.length, 1);
  assert.equal(sessions.getDraft(), null);

  reset();
  vnode = render(workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-title').props.value, '');
  const typeBadge = findByTestId(vnode, 'dsh-feedback-type');
  assert.equal(typeBadge.children.join(''), '自定义反馈');
  assert.equal(state.network.length, 0);
});

test('the workspace shows the manual submission guidance with the official destination link', () => {
  const { React, render } = createStatefulReact();
  const { window, state } = createFakeWindow();
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, onClose: () => {} });

  const vnode = render(workspace);
  const guidance = findByTestId(vnode, 'dsh-feedback-guidance');
  assert.ok(guidance);
  const link = findByTestId(vnode, 'dsh-feedback-destination-link');
  assert.equal(link.props.href, moduleExports.OFFICIAL_DISCUSSIONS_URL);
  assert.equal(link.props.target, '_blank');
  const text = collectText(guidance).join('');
  assert.ok(text.includes('人工提交指引'));
  assert.ok(text.includes('官方 DSH Discussions'));
  assert.equal(state.network.length, 0);
});
