import React from 'react';
import type { ConfirmedSourceRecord, FeedbackSourceCandidate, SourceRole } from '../sources.js';
import { sourcePreview } from '../sources.js';
import type { FeedbackBridgeKey, FeedbackFieldKey, T } from '../types.js';

/** Locale-owned role label keys for candidate rows and captured records. */
export const ROLE_LABEL_KEYS: Record<SourceRole, FeedbackBridgeKey> = {
  user: 'sources.role.user',
  assistant: 'sources.role.assistant',
  steering: 'sources.role.steering',
  context: 'sources.role.context',
  tool: 'sources.role.tool',
  error: 'sources.role.error',
  session: 'sources.role.session',
};

/** Locale-owned recommendation reason keys. */
const REASON_LABEL_KEYS: Record<NonNullable<FeedbackSourceCandidate['recommendReason']>, FeedbackBridgeKey> = {
  recent: 'sources.reason.recent',
  error: 'sources.reason.error',
  'tool-error': 'sources.reason.tool-error',
  'turn-error': 'sources.reason.turn-error',
  session: 'sources.reason.session',
};

/** Public field options for the quote-to-field control. */
const QUOTE_FIELDS: FeedbackFieldKey[] = ['scenario', 'gap', 'desired', 'context'];

/** Props of the feedback-sources panel. */
export interface SourcePanelProps {
  t: T;
  candidates: FeedbackSourceCandidate[];
  confirmed: ConfirmedSourceRecord[];
  expanded: ReadonlySet<string>;
  noSession: boolean;
  currentSessionId: string | null;
  onToggleExpand: (id: string) => void;
  onConfirm: (candidate: FeedbackSourceCandidate) => void;
  onRemove: (id: string) => void;
  onQuote: (id: string, field: FeedbackFieldKey) => void;
}

/**
 * Feedback-sources panel: derived candidate rows (recommendations are
 * visibly badges, never selections) beside the user-confirmed records.
 * Confirming moves a candidate into the confirmed set; removing a confirmed
 * record immediately ends its availability for draft preparation. Nothing
 * here ever serializes into the exported Markdown: the quote action copies
 * the reviewed snapshot into a public field, and the review card owns the
 * final text.
 */
export function SourcePanel({
  t,
  candidates,
  confirmed,
  expanded,
  noSession,
  currentSessionId,
  onToggleExpand,
  onConfirm,
  onRemove,
  onQuote,
}: SourcePanelProps): React.ReactElement {
  const confirmedIds = new Set(confirmed.map((record) => record.id));
  const isEmpty = candidates.length === 0 && confirmed.length === 0;
  return (
    <section className="dsh-feedback-sources">
      {isEmpty ? (
        <p className="dsh-feedback-sources-empty" data-testid="dsh-feedback-sources-empty">
          {noSession ? t('sources.noSession') : t('sources.empty')}
        </p>
      ) : (
        <div className="dsh-feedback-sources-cols">
          <div className="dsh-feedback-sources-candidates">
            <h4 className="dsh-feedback-sources-col-title">{t('sources.candidates')}</h4>
            {candidates.length === 0 ? (
              <p className="dsh-feedback-sources-empty">{t('sources.empty')}</p>
            ) : (
              <ul className="dsh-feedback-source-list">
                {candidates.map((candidate) => {
                  const isConfirmed = confirmedIds.has(candidate.id);
                  const rowClass = 'dsh-feedback-source-row'
                    + (isConfirmed ? ' dsh-feedback-source-row-confirmed' : '')
                    + (candidate.recommended && !isConfirmed ? ' dsh-feedback-source-row-recommended' : '');
                  const text = expanded.has(candidate.id) ? candidate.fullText : candidate.preview;
                  return (
                    <li key={candidate.id} className={rowClass} data-testid={'dsh-feedback-source-' + candidate.id}>
                      <div className="dsh-feedback-source-head">
                        <span className="dsh-feedback-source-role">{candidate.exchange === true ? t('sources.exchange') : t(ROLE_LABEL_KEYS[candidate.role])}</span>
                        {candidate.recommended && !isConfirmed ? (
                          <span className="dsh-feedback-source-badge dsh-feedback-source-badge-recommended" data-testid="dsh-feedback-source-recommended">
                            {t('sources.recommended')} · {t(REASON_LABEL_KEYS[candidate.recommendReason ?? 'error'])}
                          </span>
                        ) : null}
                        {candidate.sensitive ? (
                          <span className="dsh-feedback-source-badge dsh-feedback-source-badge-sensitive" data-testid="dsh-feedback-source-sensitive">
                            {t('sources.sensitive')}
                          </span>
                        ) : null}
                        {isConfirmed ? (
                          <span className="dsh-feedback-source-state" data-testid="dsh-feedback-source-state">{t('sources.confirmedState')}</span>
                        ) : null}
                      </div>
                      <p className="dsh-feedback-source-text">{text}</p>
                      <div className="dsh-feedback-source-actions">
                        <button type="button" className="dsh-feedback-source-action" onClick={() => onToggleExpand(candidate.id)}>
                          {expanded.has(candidate.id) ? t('sources.collapse') : t('sources.expand')}
                        </button>
                        {isConfirmed ? (
                          <button type="button" className="dsh-feedback-source-action" data-testid="dsh-feedback-source-remove" onClick={() => onRemove(candidate.id)}>
                            {t('sources.remove')}
                          </button>
                        ) : (
                          <button type="button" className="dsh-feedback-source-action dsh-feedback-source-action-primary" data-testid="dsh-feedback-source-confirm" onClick={() => onConfirm(candidate)}>
                            {t('sources.confirm')}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="dsh-feedback-sources-confirmed">
            <h4 className="dsh-feedback-sources-col-title">{t('sources.confirmed')}</h4>
            {confirmed.length === 0 ? (
              <p className="dsh-feedback-sources-empty">{t('sources.noneConfirmed')}</p>
            ) : (
              <ul className="dsh-feedback-source-list">
                {confirmed.map((record) => (
                  <li key={record.id} className="dsh-feedback-source-row dsh-feedback-source-row-confirmed" data-testid={'dsh-feedback-confirmed-' + record.id}>
                    <div className="dsh-feedback-source-head">
                      <span className="dsh-feedback-source-role">{record.label}</span>
                      {record.sessionId !== currentSessionId ? (
                        <span className="dsh-feedback-source-badge" data-testid="dsh-feedback-source-other-session">{t('sources.otherSession')}</span>
                      ) : null}
                      {record.sensitive ? (
                        <span className="dsh-feedback-source-badge dsh-feedback-source-badge-sensitive">{t('sources.sensitive')}</span>
                      ) : null}
                    </div>
                    <p className="dsh-feedback-source-text">
                      {expanded.has(record.id) ? record.text : sourcePreview(record.text)}
                      {record.truncated ? <span className="dsh-feedback-source-truncated">{t('sources.truncated')}</span> : null}
                    </p>
                    <div className="dsh-feedback-source-actions">
                      <button type="button" className="dsh-feedback-source-action" onClick={() => onToggleExpand(record.id)}>
                        {expanded.has(record.id) ? t('sources.collapse') : t('sources.expand')}
                      </button>
                      <select
                        className="dsh-feedback-source-quote"
                        data-testid="dsh-feedback-source-quote"
                        value=""
                        aria-label={t('sources.confirm')}
                        onChange={(event) => {
                          const field = event.target.value;
                          if (field !== '') onQuote(record.id, field as FeedbackFieldKey);
                        }}
                      >
                        <option value="" disabled>{t('sources.quotePlaceholder')}</option>
                        {QUOTE_FIELDS.map((field) => (
                          <option key={field} value={field}>{t(('field.' + field) as FeedbackBridgeKey)}</option>
                        ))}
                      </select>
                      <button type="button" className="dsh-feedback-source-action" data-testid="dsh-feedback-source-remove" onClick={() => onRemove(record.id)}>
                        {t('sources.remove')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
