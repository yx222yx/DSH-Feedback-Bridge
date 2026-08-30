/**
 * Client OAuth transport over the plugin's same-origin oauth routes: status
 * polling, attempt start (returning the browser authorize URL), cancel, and
 * disconnect. The payloads carry only client-safe facts — never a token,
 * authorization code, or PKCE secret.
 */

import type { FetchLike } from './types.js';

/** Client-visible OAuth flow failure classes. */
export type OAuthFailureCode = 'denied' | 'state-expired' | 'exchange-failed' | 'user-failed' | 'network';

/** Client-visible OAuth status; supported:false when the host has no oauth provider. */
export type OAuthStatus =
  | { supported: false }
  | { supported: true; status: 'idle' | 'running' | 'cancelled' }
  | { supported: true; status: 'authorized'; identity: { login: string } }
  | { supported: true; status: 'failed'; code: OAuthFailureCode };

/** The client surface of the plugin-owned OAuth flow. */
export interface OAuthTransport {
  status(): Promise<OAuthStatus>;
  start(): Promise<{ status: 'running'; url: string }>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Create the OAuth transport over the same-origin routes.
 *
 * @param options - the oauth route URLs and an optional fetch-like function.
 * @returns the transport handle.
 */
export function createOAuthTransport({
  statusUrl,
  startUrl,
  cancelUrl,
  disconnectUrl,
  fetchImpl = (typeof fetch === 'function' ? fetch : undefined) as unknown as FetchLike,
}: {
  statusUrl: string;
  startUrl: string;
  cancelUrl: string;
  disconnectUrl: string;
  fetchImpl?: FetchLike;
}): OAuthTransport {
  const post = (url: string): Promise<unknown> => fetchImpl(url, { method: 'POST' })
    .then((response) => {
      if (!response.ok) throw new Error('oauth request failed: HTTP ' + response.status);
      return response.json();
    });
  return {
    status() {
      return fetchImpl(statusUrl, { method: 'GET' })
        .then((response) => {
          if (!response.ok) throw new Error('oauth status failed: HTTP ' + response.status);
          return response.json();
        })
        .then((data) => data as OAuthStatus);
    },
    start() {
      return post(startUrl) as Promise<{ status: 'running'; url: string }>;
    },
    async cancel() {
      await post(cancelUrl);
    },
    async disconnect() {
      await post(disconnectUrl);
    },
  };
}
