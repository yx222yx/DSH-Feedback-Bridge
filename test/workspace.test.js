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
  gap: '你碰到的问题或情况',
  desired: '期望结果',
  context: '补充上下文',
};
const enHeadings = {
  scenario: 'Scenario',
  gap: 'The problem or situation you encountered',
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
    '## 你碰到的问题或情况',
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
    '## The problem or situation you encountered',
    '',
    'Harness exposes no public registration interface.',
  ].join('\n');
  assert.equal(moduleExports.buildDraftMarkdown(draft, enHeadings), expected);
});

// ---------------------------------------------------------------------------
// Workspace interactions: stateful renderer + fake window + fake persistence
// ---------------------------------------------------------------------------

/** Stateful fake React: persists hook state across re-renders and re-runs an
 * effect only when its deps change, matching real React enough for tests. */
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
    useEffect(effect, deps) {
      const i = cursor++;
      if (hookSlots[i] === undefined) hookSlots[i] = { deps: undefined, cleanup: null, effect: null };
      const slot = hookSlots[i];
      slot.effect = effect;
      const changed = slot.deps === undefined
        || deps === undefined
        || deps.length !== slot.deps.length
        || deps.some((dep, index) => dep !== slot.deps[index]);
      if (changed) {
        slot.deps = deps === undefined ? undefined : [...deps];
        this.pendingEffects.push(slot);
      }
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

/** Fake browser surface with a same-origin draft route. With manualTimers the
 * fake setTimeout queues callbacks instead of firing them immediately. */
function createFakeWindow({ manualTimers = false, persisted = null, failSave = false, failRemove = false, failLoad = false } = {}) {
  const state = {
    listeners: {},
    docListeners: {},
    clipboard: [],
    downloads: [],
    revoked: [],
    anchorClicks: 0,
    fetchLog: [],
    timers: new Map(),
    nextTimerId: 1,
    persisted,
    failSave,
    failRemove,
    failLoad,
  };
  const document = {
    addEventListener(name, fn) {
      (state.docListeners[name] ??= []).push(fn);
    },
    removeEventListener(name, fn) {
      state.docListeners[name] = (state.docListeners[name] ?? []).filter((existing) => existing !== fn);
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
    addEventListener(name, fn) {
      (state.listeners[name] ??= []).push(fn);
    },
    removeEventListener(name, fn) {
      state.listeners[name] = (state.listeners[name] ?? []).filter((existing) => existing !== fn);
    },
    setTimeout(fn, ms) {
      if (manualTimers) {
        const id = state.nextTimerId++;
        state.timers.set(id, { fn, ms });
        return id;
      }
      fn();
      return 0;
    },
    clearTimeout(id) {
      state.timers.delete(id);
    },
    fetch: async (url, init) => {
      state.fetchLog.push({ url, init });
      if (init?.method === 'GET') {
        if (state.failLoad) throw new Error('load boom');
        return { ok: true, json: async () => ({ draft: state.persisted }) };
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action === 'save') {
          if (state.failSave) throw new Error('save boom');
          state.persisted = body.draft;
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (body.action === 'remove') {
          if (state.failRemove) throw new Error('remove boom');
          state.persisted = null;
          return { ok: true, json: async () => ({ ok: true }) };
        }
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    },
    XMLHttpRequest: class {
      open() {}
      send() {}
    },
  };
  return { window, state };
}

/** Persistence bound to the fake window's draft route. */
function createFakePersistence({ window, state }) {
  const moduleExports = loadClientExports();
  return moduleExports.createDraftPersistence({ draftUrl: '/dsh-feedback-bridge/draft', fetchImpl: window.fetch });
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

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setupWorkspace({ manualTimers = false, persisted = null, failSave = false, failRemove = false, failLoad = false } = {}) {
  const { React, render, reset } = createStatefulReact();
  const { window, state } = createFakeWindow({ manualTimers, persisted, failSave, failRemove, failLoad });
  const moduleExports = loadClientExports(React, window);
  const t = (key) => moduleExports.dictionaries.zh[key] ?? key;
  const sessions = moduleExports.createFeedbackSessionController();
  const persistence = createFakePersistence({ window, state });
  const closed = [];
  const workspace = () => React.createElement(moduleExports.FeedbackWorkspace, { t, sessions, persistence, onClose: () => closed.push(true) });
  return { React, render, reset, window, state, moduleExports, t, sessions, persistence, closed, workspace };
}

test('opening the workspace starts a custom-feedback session and typing updates the exact preview', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  assert.ok(findByTestId(vnode, 'dsh-feedback-workspace'));
  assert.equal(findByTestId(vnode, 'dsh-feedback-type').children.join(''), '自定义反馈');
  assert.ok(findByTestId(vnode, 'dsh-feedback-draft-label'));

  const set = (testid, value) => {
    findByTestId(vnode, testid).props.onChange({ target: { value } });
    vnode = h.render(h.workspace);
  };
  set('dsh-feedback-title', '我想给 Harness 加一个插件 API');
  set('dsh-feedback-scenario', '我经常在对话中想调用自定义工具。');
  set('dsh-feedback-gap', 'Harness 没有公开的注册接口。');
  set('dsh-feedback-desired', '提供文档化的插件注册 API。');
  set('dsh-feedback-context', '用户故事与示例代码。');
  await waitTick();

  const preview = findByTestId(vnode, 'dsh-feedback-preview');
  assert.equal(preview.children.join(''), [
    '# 我想给 Harness 加一个插件 API',
    '',
    '## 场景',
    '',
    '我经常在对话中想调用自定义工具。',
    '',
    '## 你碰到的问题或情况',
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
  assert.equal(h.sessions.getDraft().title, '我想给 Harness 加一个插件 API');
  // Every request is same-origin: only the draft route.
  assert.ok(h.state.fetchLog.length > 0);
  assert.ok(h.state.fetchLog.every((entry) => entry.url === '/dsh-feedback-bridge/draft'));
});

test('typing autosaves the draft to the host and the queue posts the latest fields', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '自动保存的标题' } });
  vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-scenario').props.onChange({ target: { value: '自动保存的场景' } });
  vnode = h.render(h.workspace);
  await waitTick();

  const saves = h.state.fetchLog.filter((entry) => entry.init?.method === 'POST' && JSON.parse(entry.init.body).action === 'save');
  assert.ok(saves.length >= 2);
  const last = JSON.parse(saves[saves.length - 1].init.body);
  assert.deepEqual(last.draft, { title: '自动保存的标题', scenario: '自动保存的场景', gap: '', desired: '', context: '' });
  assert.deepEqual(h.state.persisted, last.draft);
});

test('a persisted draft is restored on open with the restored notice', async () => {
  const h = setupWorkspace({ persisted: { title: '已保存标题', scenario: '已保存场景', gap: '', desired: '', context: '' } });
  let vnode = h.render(h.workspace);
  await waitTick();
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-title').props.value, '已保存标题');
  assert.equal(findByTestId(vnode, 'dsh-feedback-scenario').props.value, '已保存场景');
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '已恢复未完成的草稿');
  assert.equal(h.sessions.getDraft().title, '已保存标题');
});

test('a load failure opens a blank workspace with an error notice and the queue keeps working', async () => {
  const h = setupWorkspace({ failLoad: true });
  let vnode = h.render(h.workspace);
  await waitTick();
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '无法加载已保存的草稿');
  assert.equal(findByTestId(vnode, 'dsh-feedback-title').props.value, '');

  // A later save still succeeds.
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '后续保存' } });
  vnode = h.render(h.workspace);
  await waitTick();
  assert.deepEqual(h.state.persisted.title, '后续保存');
});

test('copy puts the exact markdown on the clipboard and shows the copied notice', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '标题' } });
  vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-scenario').props.onChange({ target: { value: '场景内容' } });
  vnode = h.render(h.workspace);
  await waitTick();

  findByTestId(vnode, 'dsh-feedback-copy').props.onClick();
  await waitTick();

  assert.equal(h.state.clipboard.length, 1);
  assert.equal(h.state.clipboard[0], '# 标题\n\n## 场景\n\n场景内容');
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '已复制到剪贴板');
});

test('export downloads the exact markdown and shows the draft-retained notice', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '标题' } });
  vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-scenario').props.onChange({ target: { value: '场景内容' } });
  vnode = h.render(h.workspace);
  await waitTick();

  findByTestId(vnode, 'dsh-feedback-export').props.onClick();

  assert.equal(h.state.downloads.length, 1);
  const text = await h.state.downloads[0].text();
  assert.equal(text, '# 标题\n\n## 场景\n\n场景内容');
  assert.equal(h.state.anchorClicks, 1);

  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '已导出，草稿仍保留');
});

test('copy and export are disabled until a title is entered', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  assert.equal(findByTestId(vnode, 'dsh-feedback-copy').props.disabled, true);
  assert.equal(findByTestId(vnode, 'dsh-feedback-export').props.disabled, true);

  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '有标题' } });
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-copy').props.disabled, false);
  assert.equal(findByTestId(vnode, 'dsh-feedback-export').props.disabled, false);
});

test('closing a clean workspace closes without a save request', async () => {
  const h = setupWorkspace();
  h.render(h.workspace);
  await waitTick();
  h.render(h.workspace);
  findByTestId(h.render(h.workspace), 'dsh-feedback-close').props.onClick();
  assert.equal(h.closed.length, 1);
  assert.equal(h.state.fetchLog.filter((entry) => entry.init?.method === 'POST').length, 0);
});

test('closing a dirty workspace flushes the save and only then closes', async () => {
  const h = setupWorkspace({ manualTimers: true });
  let vnode = h.render(h.workspace);
  await waitTick();
  // With manual timers the autosave stays pending; the workspace is dirty.
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '要保留的草稿' } });
  vnode = h.render(h.workspace);

  findByTestId(vnode, 'dsh-feedback-close').props.onClick();
  assert.equal(h.closed.length, 0); // not closed until the flush settles
  await waitTick();
  assert.equal(h.closed.length, 1);
  const saves = h.state.fetchLog.filter((entry) => entry.init?.method === 'POST' && JSON.parse(entry.init.body).action === 'save');
  assert.ok(saves.length >= 1);
  assert.deepEqual(JSON.parse(saves[saves.length - 1].init.body).draft.title, '要保留的草稿');
  assert.equal(h.state.persisted.title, '要保留的草稿');
});

test('closing after a failed save keeps the workspace open and shows the failure notice', async () => {
  const h = setupWorkspace({ failSave: true });
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '保存会失败' } });
  vnode = h.render(h.workspace);
  await waitTick();

  findByTestId(vnode, 'dsh-feedback-close').props.onClick();
  await waitTick();
  assert.equal(h.closed.length, 0); // must not claim success
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '草稿保存失败');
});

test('after a save failure a later save succeeds and close then closes', async () => {
  const h = setupWorkspace({ failSave: true });
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '第一版' } });
  vnode = h.render(h.workspace);
  await waitTick();

  h.state.failSave = false;
  h.state.persisted = null;
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '第二版' } });
  vnode = h.render(h.workspace);
  await waitTick();
  assert.deepEqual(h.state.persisted.title, '第二版');

  findByTestId(vnode, 'dsh-feedback-close').props.onClick();
  await waitTick();
  assert.equal(h.closed.length, 1);
});

test('cancel shows a clear confirmation and keep-editing stays in the workspace', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '要丢弃的草稿' } });
  vnode = h.render(h.workspace);
  await waitTick();

  findByTestId(vnode, 'dsh-feedback-cancel').props.onClick();
  vnode = h.render(h.workspace);
  assert.ok(findByTestId(vnode, 'dsh-feedback-discard-confirm'));
  assert.equal(h.closed.length, 0);

  findByTestId(vnode, 'dsh-feedback-discard-keep').props.onClick();
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-discard-confirm'), null);
  assert.equal(h.closed.length, 0);
  assert.equal(h.sessions.getDraft().title, '要丢弃的草稿');
  assert.notEqual(h.state.persisted, null);
});

test('confirming the discard removes the persisted draft and closes', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '要丢弃的草稿' } });
  vnode = h.render(h.workspace);
  await waitTick();

  findByTestId(vnode, 'dsh-feedback-cancel').props.onClick();
  vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-discard-confirm-action').props.onClick();
  await waitTick();

  assert.equal(h.closed.length, 1);
  assert.equal(h.sessions.getDraft(), null);
  assert.equal(h.state.persisted, null);
  const removes = h.state.fetchLog.filter((entry) => entry.init?.method === 'POST' && JSON.parse(entry.init.body).action === 'remove');
  assert.equal(removes.length, 1);
});

test('a failed discard keeps the workspace open with the failure notice', async () => {
  const h = setupWorkspace({ failRemove: true });
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '删不掉的草稿' } });
  vnode = h.render(h.workspace);
  await waitTick();

  findByTestId(vnode, 'dsh-feedback-cancel').props.onClick();
  vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-discard-confirm-action').props.onClick();
  await waitTick();

  assert.equal(h.closed.length, 0);
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-notice').children.join(''), '草稿删除失败');
  assert.equal(findByTestId(vnode, 'dsh-feedback-discard-confirm'), null);
  assert.equal(h.sessions.getDraft().title, '删不掉的草稿');
});

test('a late autosave after a confirmed discard does not resurrect the draft', async () => {
  const h = setupWorkspace({ manualTimers: true });
  let vnode = h.render(h.workspace);
  await waitTick();
  // Autosave is scheduled but has not fired yet.
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '会被丢弃的草稿' } });
  vnode = h.render(h.workspace);

  // Discard: confirm the removal, which bumps the generation.
  findByTestId(vnode, 'dsh-feedback-cancel').props.onClick();
  vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-discard-confirm-action').props.onClick();
  await waitTick();
  assert.equal(h.closed.length, 1);
  assert.equal(h.state.persisted, null);

  // The late autosave timer now fires; it must not post a save.
  for (const timer of [...h.state.timers.values()]) timer.fn();
  await waitTick();

  const posts = h.state.fetchLog.filter((entry) => entry.init?.method === 'POST');
  assert.equal(posts.length, 1); // only the remove
  assert.deepEqual(JSON.parse(posts[0].init.body), { action: 'remove' });
  assert.equal(h.state.persisted, null);
});

test('reopening after a discard starts blank and a later autosave saves the new draft', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '第一份' } });
  vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-cancel').props.onClick();
  vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-discard-confirm-action').props.onClick();
  await waitTick();

  h.reset();
  vnode = h.render(h.workspace);
  await waitTick();
  vnode = h.render(h.workspace);
  assert.equal(findByTestId(vnode, 'dsh-feedback-title').props.value, '');

  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '第二份' } });
  vnode = h.render(h.workspace);
  await waitTick();
  assert.deepEqual(h.state.persisted.title, '第二份');
});

test('the beforeunload keepalive posts the current draft as a fallback', async () => {
  const h = setupWorkspace({ manualTimers: true });
  h.render(h.workspace);
  await waitTick();
  h.render(h.workspace);
  const unload = h.state.listeners.beforeunload;
  assert.ok(unload && unload.length === 1);

  const vnode = h.render(h.workspace);
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '卸载前的内容' } });
  h.render(h.workspace);

  unload[0]();
  await waitTick();
  const keepalives = h.state.fetchLog.filter((entry) => entry.init?.keepalive === true);
  assert.equal(keepalives.length, 1);
  assert.deepEqual(JSON.parse(keepalives[0].init.body).draft.title, '卸载前的内容');
});

test('Escape closes through the flush path', async () => {
  const h = setupWorkspace();
  let vnode = h.render(h.workspace);
  await waitTick();
  findByTestId(vnode, 'dsh-feedback-title').props.onChange({ target: { value: '内容' } });
  vnode = h.render(h.workspace);
  await waitTick();
  for (const listener of h.state.docListeners.keydown ?? []) listener({ key: 'Escape' });
  assert.equal(h.closed.length, 1);
});

test('the workspace shows the manual submission guidance with the official destination link', async () => {
  const h = setupWorkspace();
  const vnode = h.render(h.workspace);
  const guidance = findByTestId(vnode, 'dsh-feedback-guidance');
  assert.ok(guidance);
  const link = findByTestId(vnode, 'dsh-feedback-destination-link');
  assert.equal(link.props.href, h.moduleExports.OFFICIAL_DISCUSSIONS_URL);
  assert.equal(link.props.target, '_blank');
  const text = collectText(guidance).join('');
  assert.ok(text.includes('人工提交指引'));
  assert.ok(text.includes('官方 DSH Discussions'));
});
