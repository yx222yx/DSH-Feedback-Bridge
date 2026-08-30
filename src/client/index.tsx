import React from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { NS, OFFICIAL_DISCUSSIONS_URL } from './constants.js';
import { createConversationSource } from './conversation.js';
import type { ConversationSource } from './conversation.js';
import { dictionaries } from './dictionaries.js';
import { draftUrl } from './env.js';
import { injectStyles } from './styles.js';
import { createFeedbackSessionController } from './session.js';
import { createDraftPersistence } from './persistence.js';
import {
  applyRecommendations,
  captureSourceText,
  confirmSourceCandidate,
  deriveSourceCandidates,
  quoteSourceText,
  removeSource,
  sensitiveMarkerHit,
  sourcePreview,
  utf8ByteLength,
  MAX_CANDIDATES,
  SOURCE_CAPTURE_CAP,
  SOURCE_PREVIEW_CHARS,
} from './sources.js';
import { FeedbackTrigger } from './components/FeedbackTrigger.js';
import { StatusSection } from './components/StatusSection.js';

const name = 'dsh-feedback-bridge';
const inject = ['slots', 'locale', 'sessions'];
export { name, inject };
export { OFFICIAL_DISCUSSIONS_URL } from './constants.js';
export { dictionaries } from './dictionaries.js';
export {
  buildDraftMarkdown,
  createFeedbackSessionController,
  emptyFeedbackDraft,
  feedbackDraftFileName,
} from './session.js';
export { createDraftPersistence } from './persistence.js';
export { FeedbackTrigger } from './components/FeedbackTrigger.js';
export { FeedbackWorkspace } from './components/FeedbackWorkspace.js';
export {
  applyRecommendations,
  captureSourceText,
  confirmSourceCandidate,
  deriveSourceCandidates,
  quoteSourceText,
  removeSource,
  sensitiveMarkerHit,
  sourcePreview,
  utf8ByteLength,
  MAX_CANDIDATES,
  SOURCE_CAPTURE_CAP,
  SOURCE_PREVIEW_CHARS,
} from './sources.js';
export type {
  ConfirmedSourceRecord,
  FeedbackSourceCandidate,
  SourceCopy,
  SourceDerivationContext,
  SourceKind,
  SourceRole,
} from './sources.js';

/**
 * Client plugin entry point. The DSH Web shell provides `slots` and
 * `locale`; this registration adds one left-navigation entry plus the
 * settings status page without touching Harness core. The feedback-session
 * controller lives for the plugin's lifetime and is disposed on unload.
 *
 * @param ctx - client cordis context carrying slots and locale.
 * @returns void.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-feedback-bridge: dictionaries');
  if (typeof window !== 'undefined' && window.document?.head !== undefined) {
    ctx.effect(() => injectStyles(window.document), 'dsh-feedback-bridge: styles');
  }
  const t = ctx.locale.bind(NS);
  const sessions = createFeedbackSessionController();
  const persistence = createDraftPersistence({ draftUrl: draftUrl() });
  // The current-conversation read rides the official `ctx.sessions` face;
  // the `sessions` entry in the inject list above makes it always present.
  const conversation: ConversationSource = createConversationSource(ctx.sessions);
  ctx.effect(() => {
    const disposers = [
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-feedback-bridge',
        locale: NS,
      }, (props) => (
        <FeedbackTrigger {...props} t={t} sessions={sessions} persistence={persistence} conversation={conversation} />
      ))),
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-feedback-bridge',
        order: 90,
        label: () => t('settings.label'),
      }, (props) => (
        <StatusSection t={t} {...props} />
      ))),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-feedback-bridge: UI slots');
  ctx.effect(() => () => sessions.dispose(), 'dsh-feedback-bridge: session controller cleanup');
}
