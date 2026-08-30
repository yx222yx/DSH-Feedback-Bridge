# Run an early read-only similarity check against approved public sources

Issue #7 surfaces advisory similarity results as soon as the minimum feedback
intent exists. The check queries only the v0.1 approved public sources, is
read-only and ephemeral, and never declares a duplicate or blocks the session.

## Context

- v0.1 targets the DSH `web` profile. Issue #6 established the Host-side
  model seam and the confirmed-source privacy boundary (ADR 0005/0006); the
  similarity check must work *before* sources are confirmed, so it can rely
  only on the minimal feedback intent fields.
- Empirically verified unauthenticated access: GitHub's REST search does not
  cover Discussions, its GraphQL search requires a token, and unauthenticated
  API calls are IP-rate-limited. The public
  `https://github.com/deepseek-ai/deepseek-harness/discussions.atom` feed is
  readable without auth but carries only recent entries. The official docs
  live in-repo (`deepseek-ai/deepseek-harness` default branch `master`),
  readable via `raw.githubusercontent.com`; there is no published docs site
  yet. npm registry search works unauthenticated and can be scoped to the
  official `@deepseek-ai` scope.
- Parent-spec boundaries: similarity evidence is limited to official DSH
  Discussions, known plugin listings or repositories, and official
  documentation; results are advisory (never a duplicate verdict); the user
  can always continue creating a new Discussion.

## Decision

- **Approved v0.1 sources and their read-only access:** (1) official
  Discussions via the public atom feed (recent entries only — full-corpus
  search is deferred to the GitHub-authorization slice); (2) known official
  plugins via npm registry search restricted to the `@deepseek-ai` scope
  (no third-party repository search); (3) official documentation via a curated
  allowlist of raw markdown docs under the harness repo's `master`, displayed
  as GitHub blob links. All three are unauthenticated read-only GET requests.
- **Endpoint URLs are validated Config fields** (cordis.yml), not hardcoded
  tunables; defaults point at the real public endpoints, and the acceptance
  profile points them at a local fake server via its `cordis.patch.yml`.
- **Matching is deterministic term overlap, not model output.** Latin words
  (stopwords removed) plus CJK bigrams are extracted from the intent; hits are
  scored title-double, sorted deterministically, capped per source, and
  surfaced with a locale-owned `matched terms` reason. No model call, no
  prompt, no session event: the intent text is draft content and never enters
  logs (ADR 0003), and no model-visible input exists to record.
- **Minimal intent only.** The Client posts `{scenario, gap, desired, type,
  language}` to a new same-origin `/dsh-feedback-bridge/similarity` route;
  confirmed sources, conversation content, diagnostics, and logs are never
  transmitted. Each field is capped at the wire and again at the config cap
  before term extraction.
- **Trigger, debounce, cancellation, dedupe.** The Client runs the check when
  scenario, gap, and desired are all non-empty, debounced 800 ms after the
  last intent edit; an intent change aborts the in-flight request, a response
  sequence guard drops stale results, and an unchanged intent signature skips
  a redundant search. Results live in memory only; resuming a draft re-checks
  automatically.
- **Failure handling is per-source.** Each source returns ok / empty /
  disabled / failed{rate-limited, timeout, network, parse}; partial failure
  is explained in the panel without blocking the session, and retry is
  user-initiated only. HTTP 429/403 map to rate-limited, abort-timeouts to
  timeout, JSON/XML parse errors to parse, everything else to network.
- **Read-only is asserted, not assumed.** Source adapters only ever issue
  GETs; the acceptance fake server records requests and the suite asserts only
  GET reached it, that no GitHub or external request was observed, and that
  export still completes.

## Consequences

- New Host route `POST /dsh-feedback-bridge/similarity`; the plugin Host
  `apply` gains an optional config argument (similarity settings). No new
  inject entries: the route uses the global fetch.
- New face-neutral Host module `src/host/similarity.ts` (shared by the
  Client bundle), a Client transport/panel, and locale-owned dictionary keys
  for every new string.
- The check never requires confirmed sources and never requires a model
  context, so it works on a fresh draft immediately.
- Known v0.1 limitations: the Discussions source covers only the recent atom
  feed; npm results are limited to the official scope; documentation coverage
  is the curated allowlist. Rate limits and network failures degrade to
  per-source explanations.
