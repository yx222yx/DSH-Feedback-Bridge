# GUI GitHub OAuth Device Flow behind the existing submission boundary

Issue #10 reworked the primary novice authorization experience to GitHub OAuth
Device Flow (RFC 8628). This replaces the earlier authorization-code + PKCE
design, which required a local callback route and shipped the risk surface of
a distributed client secret.

## Context

- ADR 0001 committed v0.1 to a GUI OAuth path for novice users with grants
  stored through the DSH credentials service. The first Issue #10
  implementation used authorization-code + PKCE: it needed a callback route
  and, on GitHub, an OAuth App whose redirect URI matched the running server.
- The project does not operate an OAuth callback backend, and the published
  plugin must not distribute a client secret. Device Flow needs neither: the
  human authorizes on GitHub's official device page with a short user code,
  and the Host polls GitHub's token endpoint with only the public client ID.

## Decision

- **Device Flow is the official GUI authorization scheme.** The plugin ships
  only the maintainer-registered OAuth App's public client ID
  (`github.oauth.clientId`); it requires, configures, and distributes no
  client secret. The config schema rejects the old PKCE keys
  (`clientSecret`, `authorizeEndpoint`, `redirectBaseUrl`,
  `stateTtlMs`) so a stale production config cannot silently retain a
  secret-carrying path, and there is no callback route or project OAuth
  backend.
- **Host-owned device flow.** New flow logic in `src/host/oauth.ts` requests
  a device code from GitHub (`POST /login/device/code` with
  `client_id` + `scope: public_repo`), holds the device code entirely on
  the Host, and polls the token endpoint
  (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) at GitHub's
  interval, adding five seconds on `slow_down` per RFC 8628. Outcomes are
  distinct: `authorization_pending` keeps polling, `expired_token` and the
  device expiry deadline settle as `expired`, `access_denied` settles as
  `denied`, a missing `public_repo` scope settles as
  `insufficient-scope`, and transport/other failures settle as
  `exchange-failed`/`network`.
- **Credential storage and boundary reuse.** On success the grant
  (access token, granted scopes, resolved login, optional expiry) is written
  through `credentials.modifyRecord` under
  `credentialKey('dsh-feedback-bridge', 'github-oauth')`; the submission
  provider reads it back and drives the same Issue #8 `GitHubService`
  boundary — same pinned destination, same one-shot nonce, same single
  `createDiscussion` mutation. No second submission implementation.
- **Client surface.** The Client only ever sees the verification URI, the user
  code (shown only in the active authorization dialog, with a copy action),
  the flow status, and the resolved public login. Tokens and device codes are
  never serialized into Client payloads, model input, drafts, displayable
  events, or logs; the user code is the only credential-adjacent value allowed
  in the authorization UI.
- **Scope.** The flow requests `public_repo` (configurable via
  `github.oauth.scopes`), the scope needed to create a Discussion in the
  public `deepseek-ai/deepseek-harness` repository, and verifies the granted
  scope set before committing.
- **No real mutations in tests.** Fake Device Flow and GitHub services drive
  success, pending, slow-down, denial, expiry, cancellation, insufficient
  scope, and failures; the WSL2 browser acceptance intercepts the handoff to
  the device authorization page without contacting real GitHub.
- The advanced GitHub CLI path from #9 is unchanged and remains available.
- **Dual provider (`provider: both`).** A deployment can enable both methods:
  the submission route then returns `auth-method-required` (with whether a
  local gh account exists) until the user explicitly picks Device Flow or the
  GitHub CLI path (`?method=oauth` / `?method=gh`). An existing oauth grant
  is reused automatically; the mutation routes to the provider owning the
  confirmed identity (an oauth grant whose login matches goes through oauth,
  otherwise through gh). The v0.1 release ships `provider: both` in the
  bundle patch with the official maintainer-registered OAuth App's public
  client ID, so authorized submission is usable out of the box; deployments
  override the provider or client ID in their own profile patch layer.

## Consequences

- `src/host/oauth.ts` is rewritten: no PKCE/state/authorize-URL code; device
  code request, interval polling, scope check, and grant persistence instead.
  `src/host/index.ts` drops the callback route; `/oauth/start` returns
  `{verificationUri, userCode}`. The oauth submission provider is unchanged
  apart from the config shape.
- Client transport, the authorizing panel phase (user code + copy + official
  link + cancel), the failure copy (denied/expired/insufficient-scope/
  exchange-failed/network), and the credentials-provider disclosure are all in
  typed dictionaries.
- Tests cover the Device Flow outcomes at unit, route, and acceptance levels,
  prove no client secret is ever sent, prove tokens/device codes never reach
  the Client, and assert #8/#9/draft-export behavior does not regress.
