# GUI OAuth authorization-code + PKCE behind the existing submission boundary

Issue #10 adds the primary novice authorization experience: a GUI-started
GitHub OAuth authorization-code flow with PKCE whose grant is stored through
the DSH credentials service and whose submission reuses the Issue #8
boundary.

## Context

- ADR 0001 committed v0.1 to GitHub OAuth authorization-code with PKCE as the
  primary path, with grants stored through the DSH credentials service and the
  UI disclosing that the local credentials provider is not an operating-system
  security boundary. ADR 0008 delivered the replaceable GitHub service; ADR
  0009 added the gh-CLI provider.
- In the tested DSH version (0.1.1-rc.2) the web profile composes
  `credentials` (`dsh-credentials-local`) but does not compose the
  `ctx.authorization` seam. The plugin therefore owns the complete OAuth
  flow and stores the grant through `ctx.credentials`, which the profile does
  provide.

## Decision

- **Plugin-owned flow, credentials-service storage.** New Host module
  `src/host/oauth.ts` owns PKCE verifier/challenge generation (RFC 7636 S256),
  one-shot state with a TTL, the authorize URL, callback validation, the token
  exchange, identity resolution, and grant persistence. The grant is written
  through `credentials.modifyRecord` under
  `credentialKey('dsh-feedback-bridge', 'github-oauth')` as an opaque
  `GrantRecord` payload and read back with `readRecord`; disconnect calls
  `deleteRecord`. The plugin may adopt the `ctx.authorization` seam once a
  future DSH profile composes it.
- **Same submission boundary.** `github.auth` gains the `oauth` provider.
  The provider implements the same `GitHubService` interface and the same
  `createDiscussion` mutation with the same pinned official destination and
  one-shot nonce; there is no second submission implementation. The grant's
  token is attached only as the Host-to-GitHub Authorization header and is
  never serialized into a route response, model input, draft, event, or log.
- **Redirect URI from the running server.** The callback path is
  `/dsh-feedback-bridge/oauth/callback`; the redirect base defaults to the
  webServer's actual listening port (`ctx.webServer.port`) and can be
  overridden by `github.oauth.redirectBaseUrl` for deployments behind a fixed
  port.
- **Explicit failure taxonomy.** The flow settles as `denied` (callback
  `error=access_denied`), `state-expired` (TTL), `exchange-failed`
  (token exchange), `user-failed` (identity resolution), `network`, or
  `cancelled`. A spurious or replayed callback is refused with a fixed error
  page and leaves the running attempt untouched; the authorization code is
  consumed once and never echoed.
- **Disconnect and disclosure.** The final confirmation offers a disconnect
  action that deletes the grant and returns to draft export. The authorize
  step and the ready panel show the fixed disclosure that the DSH local
  credentials provider is not an operating-system security boundary.

## Consequences

- New Host module `src/host/oauth.ts`; `src/host/github.ts` gains the
  `oauth` provider union and shared query/parse exports; `src/host/index.ts`
  injects `credentials` and registers the oauth routes
  (status/start/callback/cancel/disconnect).
- New Client transport `src/client/oauth.ts`, three panel phases
  (authorize/authorizing/oauth-failed), a disconnect action, and locale-owned
  copy in every shipped dictionary.
- Contract tests cover PKCE, state validation, exchange/user failures, the
  never-returned-token invariant, and the flow outcomes; route tests cover the
  full start→callback→authorized→submit path with fake services; the WSL2
  acceptance tests drive the real browser handoff through a fake OAuth server
  (approve and deny paths, disconnect, zero mutation before confirmation).
- Token refresh is deferred: an expired grant resolves to
  `authorization-expired` and the user re-authorizes; refresh rotation can
  later reuse the `modifyRecord` read-decision-replace path.
