import React from 'react';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import { statusUrl } from '../env.js';
import type { HostStatusPayload, T } from '../types.js';

/** Status-section fetch state as a discriminated union for narrowing. */
type StatusState =
  | { phase: 'loading'; error: null; data: null }
  | { phase: 'error'; error: string; data: null }
  | { phase: 'ready'; error: null; data: HostStatusPayload };

/**
 * Settings section shown by the DSH Web GUI. The section is the
 * recognizable v0.1 status surface: it proves the Client half loaded and
 * reads the Host half through its documented `webServer` route.
 */
/** Full props of the settings status section: owner share plus the plugin's own t. */
export interface StatusSectionProps extends SettingsSectionOwnerProps {
  t: T;
}

export function StatusSection({ t }: StatusSectionProps): React.ReactElement {
  const [state, setState] = React.useState<StatusState>({ phase: 'loading', error: null, data: null });
  React.useEffect(() => {
    let cancelled = false;
    fetch(statusUrl())
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => {
        if (!cancelled) setState({ phase: 'ready', error: null, data: data as HostStatusPayload });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: 'error', error: error instanceof Error ? error.message : String(error), data: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="dsh-feedback-bridge-status" data-testid="dsh-feedback-bridge-status">
      <h2>{t('title')}</h2>
      {state.phase === 'loading' ? <p>{t('loading')}</p> : null}
      {state.phase === 'error' ? <p>{t('errorPrefix')} {state.error}</p> : null}
      {state.phase === 'ready' ? <p>{t('statusPrefix')} {state.data.status} · v{state.data.version}</p> : null}
    </section>
  );
}
