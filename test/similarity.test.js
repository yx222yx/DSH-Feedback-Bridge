import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SIMILARITY_CONFIG,
  extractTerms,
  matchTerms,
  normalizeSimilarityConfig,
  parseAtomFeed,
  parseNpmSearch,
  rawToBlobUrl,
  runSimilarity,
} from '../lib/similarity.js';

/** A GitHub-like atom feed with two entries; the first matches intent terms. */
const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Recent discussions in deepseek-ai/deepseek-harness</title>
  <entry>
    <id>tag:github.com,2008:10645963</id>
    <link type="text/html" rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/discussions/3383"/>
    <title>Plugin directory &amp; export drafts</title>
    <published>2026-08-19T10:33:10+00:00</published>
    <updated>2026-08-30T07:16:44+00:00</updated>
    <author><name>someone</name></author>
    <content type="html">&lt;p&gt;How do I &lt;b&gt;export a draft&lt;/b&gt; from a plugin?&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:10645964</id>
    <link type="text/html" rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/discussions/3384"/>
    <title>Token caps in long turns</title>
    <updated>2026-08-29T12:00:00+00:00</updated>
    <content type="html">&lt;p&gt;Nothing about exports here.&lt;/p&gt;</content>
  </entry>
</feed>`;

/** A npm-registry-shaped search payload: two resolvable official packages, one without a link. */
const NPM_SEARCH = {
  objects: [
    {
      package: {
        name: '@deepseek-ai/dsh-skill',
        description: 'Agent skill provider registry for the DeepSeek Harness',
        links: { repository: 'https://github.com/deepseek-ai/deepseek-harness', npm: 'https://www.npmjs.com/package/@deepseek-ai/dsh-skill' },
      },
    },
    {
      package: {
        name: '@deepseek-ai/dsh-llm',
        description: 'LLM capability seam',
        links: { homepage: 'https://example.com/llm' },
      },
    },
    { package: { name: 'no-links-pkg', description: 'no links at all' } },
  ],
};

/** A documentation markdown body whose H1 and text match the intent terms. */
const DOC_MARKDOWN = `# Architecture

The DeepSeek Harness plugin architecture supports exporting a draft from a plugin session.
`;

/** Fake fetch dispatcher keyed by exact URL; records every call. */
function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    impl(url, init) {
      calls.push({ url: String(url), signal: init?.signal });
      const route = routes[String(url)];
      if (route === undefined) {
        return Promise.reject(new Error('unexpected fetch: ' + url));
      }
      return Promise.resolve(route());
    },
  };
}

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function okText(text) {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => {
      throw new Error('not json');
    },
  };
}

function failing(status) {
  return {
    ok: false,
    status,
    text: async () => '',
    json: async () => {
      throw new Error('not json');
    },
  };
}

function intent(overrides = {}) {
  return {
    scenario: 'Export a plugin draft',
    gap: 'Export a plugin draft',
    desired: 'Export a plugin draft',
    type: 'plugin-request',
    language: null,
    ...overrides,
  };
}

test('extractTerms normalizes latin terms, filters stopwords, and emits CJK bigrams', () => {
  assert.deepEqual(extractTerms('I want a plugin that exports a draft'), ['plugin', 'exports', 'draft']);
  assert.deepEqual(extractTerms('想把对话整理成反馈'), ['想把', '把对', '对话', '话整', '整理', '理成', '成反', '反馈']);
  assert.deepEqual(extractTerms('the and or for with'), []);
});

test('matchTerms returns the terms present in title or body, title hits first', () => {
  assert.deepEqual(matchTerms('Export plugin drafts', 'no body', ['export', 'draft', 'plugin']), ['export', 'draft', 'plugin']);
  assert.deepEqual(matchTerms('unrelated', 'the body mentions export', ['export', 'missing']), ['export']);
  assert.deepEqual(matchTerms('none', 'none', ['missing']), []);
});

test('parseAtomFeed decodes entities, strips html, and tolerates a missing published date', () => {
  const entries = parseAtomFeed(ATOM_FEED);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'Plugin directory & export drafts');
  assert.equal(entries[0].url, 'https://github.com/deepseek-ai/deepseek-harness/discussions/3383');
  assert.equal(entries[0].updated, '2026-08-30T07:16:44+00:00');
  assert.equal(entries[0].summary, 'How do I export a draft from a plugin?');
  assert.equal(entries[1].title, 'Token caps in long turns');
  assert.equal(entries[1].updated, '2026-08-29T12:00:00+00:00');
});

test('parseAtomFeed rejects non-XML input as a parse failure', () => {
  assert.throws(() => parseAtomFeed('this is not xml'), /parse/i);
});

test('parseNpmSearch resolves package links with the documented fallback chain and skips linkless entries', () => {
  const hits = parseNpmSearch(NPM_SEARCH);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].name, '@deepseek-ai/dsh-skill');
  assert.equal(hits[0].url, 'https://github.com/deepseek-ai/deepseek-harness');
  assert.equal(hits[1].url, 'https://example.com/llm');
});

test('parseNpmSearch rejects a non-object payload', () => {
  assert.throws(() => parseNpmSearch('nope'), /parse/i);
});

test('rawToBlobUrl derives the GitHub blob URL from a raw markdown URL and leaves others unchanged', () => {
  assert.equal(
    rawToBlobUrl('https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md'),
    'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md',
  );
  assert.equal(rawToBlobUrl('http://127.0.0.1:8123/docs/a.md'), 'http://127.0.0.1:8123/docs/a.md');
});

test('normalizeSimilarityConfig applies documented defaults for an absent config', () => {
  assert.deepEqual(normalizeSimilarityConfig(undefined), DEFAULT_SIMILARITY_CONFIG);
});

test('normalizeSimilarityConfig merges partial overrides over the defaults and fails loud on invalid values', () => {
  const merged = normalizeSimilarityConfig({
    timeoutMs: 100,
    sources: { discussions: { url: 'http://127.0.0.1:8123/atom' } },
  });
  assert.equal(merged.timeoutMs, 100);
  assert.equal(merged.sources.discussions.url, 'http://127.0.0.1:8123/atom');
  assert.equal(merged.sources.plugins.url, DEFAULT_SIMILARITY_CONFIG.sources.plugins.url);

  assert.throws(() => normalizeSimilarityConfig({ timeoutMs: 'abc' }), /timeoutMs/);
  assert.throws(() => normalizeSimilarityConfig({ maxResultsPerSource: 0 }), /maxResultsPerSource/);
  assert.throws(() => normalizeSimilarityConfig({ maxIntentFieldChars: -1 }), /maxIntentFieldChars/);
  assert.throws(() => normalizeSimilarityConfig({ sources: { mystery: {} } }), /sources/);
  assert.throws(() => normalizeSimilarityConfig({ sources: { documentation: { urls: 'nope' } } }), /urls/);
});

test('runSimilarity searches every approved source read-only and returns combined results with per-source states', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    sources: {
      discussions: { enabled: true, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: true, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: true, urls: ['http://127.0.0.1:8123/docs/architecture.md'] },
    },
  };
  const fake = fakeFetch({
    'http://127.0.0.1:8123/atom': () => okText(ATOM_FEED),
    'http://127.0.0.1:8123/npm?text=scope%3A%40deepseek-ai+export+plugin+draft&size=15': () => okJson(NPM_SEARCH),
    'http://127.0.0.1:8123/docs/architecture.md': () => okText(DOC_MARKDOWN),
  });
  const outcome = await runSimilarity(config, intent(), { fetchImpl: fake.impl });

  assert.equal(outcome.status, 'ok');
  assert.equal(fake.calls.length, 3);
  const urls = fake.calls.map((call) => call.url);
  assert.ok(urls.includes('http://127.0.0.1:8123/atom'));
  assert.ok(urls.some((url) => url.startsWith('http://127.0.0.1:8123/npm?text=')));
  assert.ok(urls.includes('http://127.0.0.1:8123/docs/architecture.md'));

  const bySource = outcome.sourceStates.map((state) => state.source);
  assert.deepEqual(bySource, ['discussion', 'plugin', 'documentation']);
  assert.ok(outcome.sourceStates.every((state) => state.status === 'ok'));

  const discussion = outcome.results.find((result) => result.source === 'discussion');
  assert.ok(discussion);
  assert.equal(discussion.title, 'Plugin directory & export drafts');
  assert.equal(discussion.url, 'https://github.com/deepseek-ai/deepseek-harness/discussions/3383');
  assert.deepEqual(discussion.matchedTerms, ['export', 'plugin', 'draft']);
  assert.equal(discussion.updatedAt, '2026-08-30T07:16:44+00:00');

  const documentation = outcome.results.find((result) => result.source === 'documentation');
  assert.ok(documentation);
  assert.equal(documentation.title, 'Architecture');
  assert.equal(documentation.url, 'http://127.0.0.1:8123/docs/architecture.md');
  assert.ok(documentation.matchedTerms.includes('export'));

  assert.ok(outcome.results.some((result) => result.source === 'plugin'));
});

test('runSimilarity explains a partial source failure without blocking the other sources', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    sources: {
      discussions: { enabled: true, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: true, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: true, urls: ['http://127.0.0.1:8123/docs/architecture.md'] },
    },
  };
  const fake = fakeFetch({
    'http://127.0.0.1:8123/atom': () => Promise.reject(new Error('ECONNREFUSED')),
    'http://127.0.0.1:8123/npm?text=scope%3A%40deepseek-ai+export+plugin+draft&size=15': () => okJson(NPM_SEARCH),
    'http://127.0.0.1:8123/docs/architecture.md': () => okText(DOC_MARKDOWN),
  });
  const outcome = await runSimilarity(config, intent(), { fetchImpl: fake.impl });

  assert.equal(outcome.status, 'ok');
  const discussion = outcome.sourceStates.find((state) => state.source === 'discussion');
  assert.deepEqual(discussion, { source: 'discussion', status: 'failed', code: 'network' });
  assert.ok(outcome.results.some((result) => result.source === 'plugin'));
  assert.ok(outcome.results.some((result) => result.source === 'documentation'));
});

test('runSimilarity maps HTTP 429 and fetch timeouts to distinct per-source failures', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    timeoutMs: 50,
    sources: {
      discussions: { enabled: true, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: true, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: true, urls: ['http://127.0.0.1:8123/docs/architecture.md'] },
    },
  };
  const fake = fakeFetch({
    'http://127.0.0.1:8123/atom': () => failing(429),
    'http://127.0.0.1:8123/npm?text=scope%3A%40deepseek-ai+export+plugin+draft&size=15': () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    },
    'http://127.0.0.1:8123/docs/architecture.md': () => okText(DOC_MARKDOWN),
  });
  const outcome = await runSimilarity(config, intent(), { fetchImpl: fake.impl });

  const states = Object.fromEntries(outcome.sourceStates.map((state) => [state.source, state]));
  assert.equal(states.discussion.status, 'failed');
  assert.equal(states.discussion.code, 'rate-limited');
  assert.equal(states.plugin.status, 'failed');
  assert.equal(states.plugin.code, 'timeout');
  assert.equal(states.documentation.status, 'ok');
});

test('runSimilarity reports parse failures for unreadable source payloads', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    sources: {
      discussions: { enabled: true, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: true, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: true, urls: ['http://127.0.0.1:8123/docs/architecture.md'] },
    },
  };
  const fake = fakeFetch({
    'http://127.0.0.1:8123/atom': () => okText('not xml at all'),
    'http://127.0.0.1:8123/npm?text=scope%3A%40deepseek-ai+export+plugin+draft&size=15': () => okJson('not an object'),
    'http://127.0.0.1:8123/docs/architecture.md': () => okText(DOC_MARKDOWN),
  });
  const outcome = await runSimilarity(config, intent(), { fetchImpl: fake.impl });

  const states = Object.fromEntries(outcome.sourceStates.map((state) => [state.source, state]));
  assert.equal(states.discussion.status, 'failed');
  assert.equal(states.discussion.code, 'parse');
  assert.equal(states.plugin.status, 'failed');
  assert.equal(states.plugin.code, 'parse');
  assert.equal(states.documentation.status, 'ok');
});

test('runSimilarity returns an empty state without any network call when no terms can be extracted', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    sources: {
      discussions: { enabled: true, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: true, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: true, urls: ['http://127.0.0.1:8123/docs/architecture.md'] },
    },
  };
  let calls = 0;
  const outcome = await runSimilarity(config, intent({ scenario: 'the and or', gap: 'with for', desired: 'that this' }), {
    fetchImpl() {
      calls += 1;
      return Promise.resolve(okText(''));
    },
  });
  assert.equal(calls, 0);
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.results, []);
  assert.ok(outcome.sourceStates.every((state) => state.status === 'empty'));
});

test('runSimilarity skips disabled sources without fetching them', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    sources: {
      discussions: { enabled: false, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: false, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: false, urls: ['http://127.0.0.1:8123/docs/architecture.md'] },
    },
  };
  let calls = 0;
  const outcome = await runSimilarity(config, intent(), {
    fetchImpl() {
      calls += 1;
      return Promise.resolve(okText(''));
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(outcome.sourceStates, [
    { source: 'discussion', status: 'disabled' },
    { source: 'plugin', status: 'disabled' },
    { source: 'documentation', status: 'disabled' },
  ]);
});

test('runSimilarity caps results per source and returns an empty state when nothing matches', async () => {
  const config = {
    ...DEFAULT_SIMILARITY_CONFIG,
    maxResultsPerSource: 1,
    sources: {
      discussions: { enabled: true, url: 'http://127.0.0.1:8123/atom' },
      plugins: { enabled: false, url: 'http://127.0.0.1:8123/npm' },
      documentation: { enabled: false, urls: [] },
    },
  };
  const fake = fakeFetch({
    'http://127.0.0.1:8123/atom': () => okText(ATOM_FEED),
  });
  const outcome = await runSimilarity(config, intent(), { fetchImpl: fake.impl });
  const discussionResults = outcome.results.filter((result) => result.source === 'discussion');
  assert.equal(discussionResults.length, 1);
  assert.equal(discussionResults[0].title, 'Plugin directory & export drafts');

  const noMatch = await runSimilarity(config, intent({ scenario: 'zzz', gap: 'qqq', desired: 'vvv' }), { fetchImpl: fake.impl });
  assert.deepEqual(noMatch.results, []);
  assert.equal(noMatch.sourceStates.find((state) => state.source === 'discussion').status, 'empty');
});