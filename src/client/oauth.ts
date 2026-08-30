/**
 * Client OAuth transport over the plugin's same-origin device flow routes:
 * status polling, attempt start (returning GitHub's verification URI and the
 * user code), cancel, and disconnect. The payloads carry only client-safe
 * facts — the user code and verification URI — never a device code or token.
 */

import type { FetchLike } from './types.js';

/** Client-visible device flow failure classes. */
export type OAuthFailureCode = 'denied' | 'expired' | 'insufficient-scope' | 'exchange-failed' | 'network';

/** Client-visible device flow status; supported:false when the host has no oauth provider. */
export type OAuthStatus =
  | { supported: false }
  | { supported: true; status: 'idle' | 'cancelled' }
  | { supported: true; status: 'running'; userCode: string; verificationUri: string }
  | { supported: true; status: 'authorized'; identity: { login: string } }
  | { supported: true; status: 'failed'; code: OAuthFailureCode };

/** The client surface of the plugin-owned device flow. */
export interface OAuthTransport {
  status(): Promise<OAuthStatus>;
  start(): Promise<{ status: 'running'; userCode: string; verificationUri: string }>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Create the device flow transport over the same-origin routes.
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
      return post(startUrl) as Promise<{ status: 'running'; userCode: string; verificationUri: string }>;
    },
    async cancel() {
      await post(cancelUrl);
    },
    async disconnect() {
      await post(disconnectUrl);
    },
  };
}
