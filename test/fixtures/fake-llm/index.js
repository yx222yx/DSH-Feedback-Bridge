import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

/**
 * Test-only fake LLM stream interceptor. It listens on the official
 * llm/stream waterfall and answers hand-built (non-agent-loop) model calls
 * with deterministic chunks read from <DSH_HOME>/dsh-feedback-bridge-test/
 * fake-llm/{mode,response.txt}, so acceptance tests control model behavior
 * without a live provider. Loop requests pass through next() untouched, so
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

function fakeChunks(mode, text) {
  if (mode === 'fail') {
    return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fake rate limited', code: 'RATE_LIMIT' } } }];
  }
  if (mode === 'empty') {
    return [{ type: 'finish', reason: { kind: 'stop' } }];
  }
  const deltas = text === ''
    ? []
    : [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ];
  return [...deltas, { type: 'finish', reason: { kind: 'stop' } }];
}

function apply(ctx) {
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
  ctx.on('llm/stream', (options, next) => {
    if (isAgentLoopRequest(options)) return next();
    const { mode, text } = readFixture(dshHome);
    return fakeChunks(mode, text);
  });
}

export { name, inject, apply };
