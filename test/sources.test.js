import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

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

function textBlock(text) {
  return { type: 'text', text };
}

function userNode(seq, content, overrides = {}) {
  return { kind: 'user', seq, time: seq * 1000, content, source: null, ...overrides };
}

function assistantNode(seq, blocks, overrides = {}) {
  return { kind: 'assistant', seq, time: seq * 1000, turn: 1, step: 1, blocks, ...overrides };
}

function toolResultNode(seq, callId, content, overrides = {}) {
  return { kind: 'tool-result', seq, time: seq * 1000, callId, call: { name: 'bash', argsRaw: 'ls' }, callTime: seq * 1000, content, isError: false, error: undefined, meta: undefined, callView: null, resultView: null, subCalls: [], ...overrides };
}

function turnErrorNode(seq, message, overrides = {}) {
  return { kind: 'turn-error', seq, time: seq * 1000, turn: 1, step: 1, message, ...overrides };
}

function openSnapshot(nodes) {
  return { nodes, openState: 'open' };
}

function zhCopy() {
  return {
    diagTitle: '标题：',
    diagCwd: '工作目录：',
    diagPreset: 'Agent 预设：',
    diagVersion: 'DSH 版本：',
    diagSession: '会话 ID：',
    turnMaxTokens: '该回合达到了输出 token 上限',
    errorCode: 'code: ',
    roleUser: '用户消息',
    roleAssistant: '模型回复',
    roleTool: '工具结果',
    roleError: '运行错误',
    roleSteering: '指令',
    roleContext: '上下文',
  };
}

function enCopy() {
  return {
    diagTitle: 'Title: ',
    diagCwd: 'Working directory: ',
    diagPreset: 'Agent preset: ',
    diagVersion: 'DSH version: ',
    diagSession: 'Session ID: ',
    turnMaxTokens: 'The turn reached the output token cap.',
    errorCode: 'code: ',
    roleUser: 'User',
    roleAssistant: 'Assistant',
    roleTool: 'Tool result',
    roleError: 'Run error',
    roleSteering: 'Steering',
    roleContext: 'Context',
  };
}

function derivationContext(overrides = {}) {
  return {
    sessionId: 'session-1',
    title: '我的会话',
    cwd: '/home/user/project',
    agentPreset: 'default',
    dshVersion: '0.1.1-rc.2',
    copy: zhCopy(),
    ...overrides,
  };
}

test('deriveSourceCandidates groups conversation nodes into full exchanges newest-first with a session diagnostics block on top', () => {
  const candidates = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('第一条用户消息')]),
    assistantNode(2, [{ kind: 'text', text: '第一条回复' }]),
    userNode(3, [textBlock('SENTINEL_REVIEWED 第二条用户消息')]),
    toolResultNode(4, 'call-9', [textBlock('SENTINEL_DIAG_RAW 工具输出')], { isError: true }),
  ]), derivationContext());

  // One exchange per user prompt: [user1 + assistant2] and [user3 + tool4].
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].role, 'session');
  assert.equal(candidates[0].id, 'session-1:session:meta');
  assert.match(candidates[0].fullText, /标题：我的会话/);
  assert.match(candidates[0].fullText, /DSH 版本：0\.1\.1-rc\.2/);
  assert.match(candidates[0].fullText, /会话 ID：session-1/);
  // Newest exchange first, with the tool error folded into its exchange.
  assert.equal(candidates[1].id, 'session-1:exchange:3');
  assert.equal(candidates[1].role, 'user');
  assert.equal(candidates[1].exchange, true);
  assert.equal(candidates[1].errorSource, 'tool');
  assert.match(candidates[1].fullText, /SENTINEL_REVIEWED/);
  assert.match(candidates[1].fullText, /SENTINEL_DIAG_RAW/);
  // Older exchange carries the user prompt plus the assistant reply.
  assert.equal(candidates[2].id, 'session-1:exchange:1');
  assert.match(candidates[2].fullText, /第一条用户消息/);
  assert.match(candidates[2].fullText, /第一条回复/);
  assert.equal(candidates[2].exchange, true);
});



test('deriveSourceCandidates renders diagnostics and folds turn errors into their exchange with the locale-owned copy', () => {
  // Turn errors without a user prompt are not citable exchanges; the
  // diagnostics block still carries the session facts.
  const orphan = moduleExports.deriveSourceCandidates(openSnapshot([
    turnErrorNode(1, 'Provider request failed', { code: 'MISSING_CREDENTIAL' }),
    { kind: 'turn-max-tokens', seq: 2, time: 2000, turn: 1, step: 1 },
  ]), derivationContext());
  assert.equal(orphan.length, 0, 'orphaned errors are not citable sources');

  // With a user prompt, the errors fold into the exchange text.
  const zh = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('出发')]),
    turnErrorNode(2, 'Provider request failed', { code: 'MISSING_CREDENTIAL' }),
    { kind: 'turn-max-tokens', seq: 3, time: 3000, turn: 1, step: 1 },
  ]), derivationContext());
  const zhExchange = zh.find((c) => c.exchange === true);
  assert.match(zhExchange.fullText, /Provider request failed/);
  assert.match(zhExchange.fullText, /code: MISSING_CREDENTIAL/);
  assert.match(zhExchange.fullText, /该回合达到了输出 token 上限/);
  assert.equal(zhExchange.errorSource, 'turn');

  const en = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('a message')]),
  ]), derivationContext({ copy: enCopy() }));
  assert.match(en[0].fullText, /Title: 我的会话/);
  assert.match(en[0].fullText, /Session ID: session-1/);
});

test('deriveSourceCandidates extracts only text blocks and returns no candidates outside an open window', () => {
  const nodes = [
    userNode(1, [
      textBlock('可见文本'),
      { type: 'image', attachment: { id: 'img-1' } },
      { type: 'reasoning', text: '思维链不导出' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"rm -rf"}' },
    ]),
    { kind: 'model-retry', seq: 2, time: 2000, retryState: 'scheduled' },
    { kind: 'compaction', seq: 3, time: 3000, summary: '压缩摘要', summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null },
  ];
  const candidates = moduleExports.deriveSourceCandidates(openSnapshot(nodes), derivationContext());
  assert.equal(candidates.length, 2); // one exchange plus the session diagnostics block
  assert.match(candidates[1].fullText, /可见文本/);
  assert.doesNotMatch(candidates[1].fullText, /思维链|rm -rf/);

  assert.deepEqual(moduleExports.deriveSourceCandidates({ nodes, openState: 'loading' }, derivationContext()), []);
  assert.deepEqual(moduleExports.deriveSourceCandidates({ nodes: [], openState: 'open' }, derivationContext()), []);
});

test('applyRecommendations flags the latest exchange, defect-keyword content, error signals and the session block', () => {
  const candidates = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('普通的中段消息')]),
    userNode(2, [textBlock('我遇到一个 error 报错')]),
    toolResultNode(3, 'call-1', [textBlock('输出')], { isError: false }),
    turnErrorNode(4, 'Provider request failed'),
  ]), derivationContext());

  const recommended = moduleExports.applyRecommendations(candidates);
  const byId = Object.fromEntries(recommended.map((c) => [c.id, c]));

  // Session diagnostics is always recommended.
  assert.equal(byId['session-1:session:meta'].recommended, true);
  assert.equal(byId['session-1:session:meta'].recommendReason, 'session');
  // The latest exchange (user2 + tool + turn error) is the recent one.
  assert.equal(byId['session-1:exchange:2'].recommended, true);
  assert.equal(byId['session-1:exchange:2'].recommendReason, 'recent');
  // The older plain exchange stays unrecommended.
  assert.equal(byId['session-1:exchange:1'].recommended, false);
});

test('error-signal tool results are recommended with the tool-error reason on their exchange', () => {
  const candidates = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('先跑一次')]),
    toolResultNode(2, 'call-7', [textBlock('命令失败输出')], { isError: true }),
    userNode(3, [textBlock('继续')]),
    toolResultNode(4, 'call-8', [textBlock('正常输出')], { isError: false }),
  ]), derivationContext());
  const recommended = moduleExports.applyRecommendations(candidates);
  const byId = Object.fromEntries(recommended.map((c) => [c.id, c]));
  // The error exchange is not the latest, so its reason is the precise tool-error.
  assert.equal(byId['session-1:exchange:1'].recommended, true);
  assert.equal(byId['session-1:exchange:1'].recommendReason, 'tool-error');
  assert.equal(byId['session-1:exchange:1'].errorSource, 'tool');
  // The latest clean exchange is recommended for recency, not error.
  assert.equal(byId['session-1:exchange:3'].recommendReason, 'recent');
});

test('sensitive markers flag credential-like text advisory-only', () => {
  assert.equal(moduleExports.sensitiveMarkerHit('use sk-abcdef1234567890 to connect'), true);
  assert.equal(moduleExports.sensitiveMarkerHit('api_key = "hunter2"'), true);
  assert.equal(moduleExports.sensitiveMarkerHit('BEGIN RSA PRIVATE KEY'), true);
  assert.equal(moduleExports.sensitiveMarkerHit('普通的中文内容没有秘密'), false);

  const candidates = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('token: sk-abcdef1234567890')]),
    userNode(2, [textBlock('完全普通的内容')]),
  ]), derivationContext());
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
  assert.equal(byId['session-1:exchange:1'].sensitive, true);
  assert.equal(byId['session-1:exchange:2'].sensitive, false);
});

test('confirmSourceCandidate captures the reviewed exchange text snapshot with id, labels and advisory flags', () => {
  const candidates = moduleExports.deriveSourceCandidates(openSnapshot([
    userNode(1, [textBlock('SENTINEL_CONFIRMED 已审阅内容')]),
  ]), derivationContext());
  const record = moduleExports.confirmSourceCandidate(candidates[1], '2026-01-01T00:00:00.000Z', '完整交流');
  assert.deepEqual(record, {
    id: 'session-1:exchange:1',
    sessionId: 'session-1',
    kind: 'message',
    role: 'user',
    label: '完整交流',
    text: '用户消息:\nSENTINEL_CONFIRMED 已审阅内容',
    truncated: false,
    sensitive: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
});

test('captureSourceText truncates oversized text at the byte cap and marks it truncated', () => {
  const cap = moduleExports.SOURCE_CAPTURE_CAP;
  const short = moduleExports.captureSourceText('短的文本');
  assert.equal(short.truncated, false);
  assert.equal(short.text, '短的文本');

  const long = moduleExports.captureSourceText('x'.repeat(cap) + '多余部分');
  assert.equal(long.truncated, true);
  assert.equal(moduleExports.utf8ByteLength(long.text), cap);

  // Multi-byte text never splits a character and stays within the cap.
  const wide = moduleExports.captureSourceText('汉'.repeat(cap));
  assert.equal(wide.truncated, true);
  assert.ok(moduleExports.utf8ByteLength(wide.text) <= cap);
  assert.match(wide.text, /^汉+$/);
});

test('sourcePreview truncates the row preview at the preview cap', () => {
  const text = 'a'.repeat(moduleExports.SOURCE_PREVIEW_CHARS + 10);
  const preview = moduleExports.sourcePreview(text);
  assert.equal(preview.length, moduleExports.SOURCE_PREVIEW_CHARS + 1); // + ellipsis
  assert.match(preview, /…$/);
  assert.equal(moduleExports.sourcePreview('短'), '短');
});

test('removeSource drops the record by id and quoteSourceText returns the reviewed snapshot', () => {
  const a = { id: 's:1', sessionId: 'session-1', kind: 'message', role: 'user', label: 'l', text: 'AAA', truncated: false, sensitive: false, capturedAt: '2026-01-01T00:00:00.000Z' };
  const b = { ...a, id: 's:2', text: 'BBB' };
  assert.deepEqual(moduleExports.removeSource([a, b], 's:1'), [b]);
  assert.deepEqual(moduleExports.removeSource([a, b], 'missing'), [a, b]);
  assert.equal(moduleExports.quoteSourceText(b), 'BBB');
});

test('buildDraftMarkdown never serializes source records passed alongside the public fields', () => {
  const headings = { scenario: 'Scenario', gap: 'Gap', desired: 'Desired', context: 'Context' };
  const markdown = moduleExports.buildDraftMarkdown(
    {
      title: '标题',
      scenario: '公开场景',
      gap: '',
      desired: '',
      context: '',
      sources: [{ text: 'SENTINEL_SOURCE_LEAK', id: 'x' }],
    },
    headings,
  );
  assert.match(markdown, /# 标题/);
  assert.match(markdown, /公开场景/);
  assert.doesNotMatch(markdown, /SENTINEL_SOURCE_LEAK/);
});
