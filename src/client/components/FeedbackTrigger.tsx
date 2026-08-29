import React from 'react';
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { FeedbackIcon } from './FeedbackIcon.js';
import { FeedbackWorkspace } from './FeedbackWorkspace.js';
import type { DraftPersistence, FeedbackSessionController, T } from '../types.js';

/** Full props of the sidebar footer action: owner state plus the plugin's own share. */
export interface FeedbackTriggerProps extends SidebarFooterActionOwnerProps {
  t: T;
  sessions: FeedbackSessionController;
  persistence: DraftPersistence;
}

/**
 * Left-navigation entry: a sidebar footer-action row labeled 社区反馈 that
 * opens the community-feedback workspace. The label is pure Chinese in
 * every locale by product mandate, and the collapsed rail keeps the same
 * Chinese accessible name.
 */
export function FeedbackTrigger({ t, sessions, persistence, wide }: FeedbackTriggerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className={'dsh-feedback-trigger' + (wide ? '' : ' dsh-feedback-trigger-rail')}
        data-testid="dsh-feedback-trigger"
        aria-label={t('nav')}
        title={t('nav')}
        onClick={() => setOpen(true)}
      >
        <FeedbackIcon rail={!wide} />
        {wide ? <span className="dsh-feedback-trigger-label">{t('nav')}</span> : null}
      </button>
      {open ? (
        <FeedbackWorkspace t={t} sessions={sessions} persistence={persistence} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
