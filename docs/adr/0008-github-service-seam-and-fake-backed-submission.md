# Expose final preview and authorized submission behind a replaceable Host GitHub service

Issue #8 adds the final-confirmation and one-mutation submission slice behind a
replaceable Host-side GitHub service whose behavior is verified with a
controllable fake before any real authentication is connected.

## Context

- v0.1 ships without real GitHub authentication (ADR 0001 defers OAuth to a
  later slice). The submission slice must still be complete and verifiable:
  the official destination, the exact mutation count, every failure class,
  and unknown-result safety all need deterministic proof now.
- The existing Host pattern (ADR 0007) validates endpoint URLs as Config
  fields and points the acceptance profile at a local fake via its profile
  patch. The GitHub slice follows the same seam: a validated
  `github` Config block, an injected fetch seam, and a profile patch for
  the fake server.

## Decision

- **Replaceable service, fake-first.** New face-neutral module
  `src/host/github.ts` exposes `prepare()` (read-only identity + repository
  id + Discussion categories for the pinned `deepseek-ai/deepseek-harness`
  repository) and `createDiscussion()` (the only mutation). All network
  access goes through an injected `fetchImpl` seam. The authorization
  boundary is selected by validated config: `none` (shipped default,
  reports no identity) or `fake` with a configured identity (acceptance
  only). A later OAuth slice replaces the provider behind the same seam.
- **Official destination is pinned in code, not config.** The owner/repo
  `deepseek-ai/deepseek-harness` are module constants; the read query and
  the `createDiscussion` mutation reference only that repository. No Issues
  mutation or endpoint exists anywhere in the module. Tests assert the fake
  server never received an `issues`-shaped request.
- **One mutation per confirmation, never retried.** The Host route
  `GET /dsh-feedback-bridge/submission` resolves the read-only snapshot and
  issues a one-shot nonce. `POST /dsh-feedback-bridge/submission` consumes
  the nonce before the single mutation runs (a second use returns 409), and
  the service performs exactly one fetch with no retry. A request that was
  dispatched but got no definitive response (timeout/abort) is reported as
  `unknown`; nothing resubmits automatically.
- **Distinct localized outcomes.** authorization-required, permission-denied,
  validation-rejected, category-unavailable, rate-limited, network, and
  unknown are separate user-facing states with locale-owned copy. Every
  failure and the unknown state preserve the reviewed Markdown and the
  export fallback.
- **Config shape.** `github: { graphqlEndpoint, timeoutMs, auth }` where
  `auth` is `{provider: 'none'}` or `{provider: 'fake', identity: {login}}`.
  The default endpoint is `https://api.github.com/graphql`; misconfigured
  values fail loud at load.
- **Known v0.1 limits.** The nonce store is in-memory (no durable submission
  records in this ticket); a reload requires re-preparing, which is read-only.
  The GraphQL error classifier keys on documented error types; real GitHub
  response variance is validated by the later OAuth slice, not by live tests
  against the official repository.

## Consequences

- New Host modules `src/host/github.ts` and `src/host/submission.ts`; one
  same-origin route with GET (prepare) and POST (confirm) semantics.
- New Client transport `src/client/submission.ts`, the final-confirmation
  panel `src/client/components/SubmitPanel.tsx`, and locale-owned
  `submission.*` dictionary keys in every shipped locale.
- The workspace footer gains a submit control only when a transport is
  wired; copy/export/cancel remain available in every state.
- Fake-backed route, service, client, DOM, and acceptance tests pin the
  official destination, zero mutation before confirmation, exactly one
  mutation per confirmation, every failure class, and the no-retry unknown
  result.
