import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

/**
 * Test-only fake LLM stream interceptor. It listens on the official
 * llm/stream waterfall and answers hand-built (non-agent-loop) model calls
 * with deterministic chunks read from <DSH_HOME>/dsh-feedback-bridge-test/
 * fake-llm/{mode,response.txt}, so acceptance tests control model behavior
 * without a live provider. Mode "echo" composes a response from the request's
 * confirmed source text, so a demo shows the suggestion following what the
 * user actually confirmed. Loop requests pass through next() untouched, so
 * ordinary conversation turns keep their real (credentialless) behavior.
 */
const name = 'dsh-feedback-bridge-test-fake-llm';
const inject = ['llm'];

function readFixture(dshHome) {
  const dir = join(dshHome, 'dsh-feedback-bridge-test', 'fake-llm');
  try {
    const mode = readFileSync(join(dir, 'mode'), 'utf8').trim();
    const text = readFileSync(join(dir, 'response.txt'), 'utf8');
    return { mode, text };
  } catch (error) {
    // Missing or unreadable fixture files mean no scenario was staged; fall
    // back to the default response. The acceptance test writes the files
    // before each generation.
    void error;
    return { mode: 'ok', text: '' };
  }
}

/**
 * Compose an echo response from the request's confirmed source text.
 * Extracts the text after the per-source headers ([1] (role) lines).
 *
 * @param options - the full model request.
 * @returns the composed response text.
 */
function composeEcho(options) {
  const userMessage = (options.messages ?? []).find((message) => message.role === 'user');
  const raw = userMessage?.content?.[0]?.type === 'text' ? userMessage.content[0].text : '';
  const lines = raw.split('\n').filter((line) => line.trim() !== '' && line.trim() !== 'Feedback sources:' && !/^\[\d+\]/.test(line.trim()));
  const snippet = lines.join(' ').slice(0, 300) || '（没有可用的来源内容）';
  return JSON.stringify({
    type: 'custom',
    typeReason: '这是演示环境中的模拟建议：内容来自你确认的反馈来源。',
    missingInfo: [],
    draft: {
      title: '演示建议（基于已确认来源）',
      scenario: snippet,
      gap: '',
      desired: '',
      context: '来源文本预览：' + snippet,
    },
    privacyFindings: [],
  });
}

function fakeChunks(mode, text, options) {
  if (mode === 'fail') {
    return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fake rate limited', code: 'RATE_LIMIT' } } }];
  }
  if (mode === 'empty') {
    return [{ type: 'finish', reason: { kind: 'stop' } }];
  }
  const payload = mode === 'echo' ? composeEcho(options) : text;
  const deltas = payload === ''
    ? []
    : [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: payload },
      { type: 'block-end', index: 0, block: { type: 'text', text: payload } },
    ];
  return [...deltas, { type: 'finish', reason: { kind: 'stop' } }];
}

function apply(ctx) {
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
  ctx.on('llm/stream', (options, next) => {
    if (isAgentLoopRequest(options)) return next();
    const { mode, text } = readFixture(dshHome);
    return fakeChunks(mode, text, options);
  });
}

export { name, inject, apply };
