import React from 'react';
import type { DiscussionCategory, GitHubSubmissionFailureCode, OfficialDestination } from '../../host/github.js';
import type { DraftLanguage, FeedbackBridgeKey, T } from '../types.js';

/** Locale-owned explanation key per definite failure class (unknown has its own phase). */
const FAILURE_KEYS: Record<Exclude<GitHubSubmissionFailureCode, 'unknown'>, FeedbackBridgeKey> = {
  'authorization-required': 'submission.failed.authorization-required',
  'permission-denied': 'submission.failed.permission-denied',
  'validation-rejected': 'submission.failed.validation-rejected',
  'category-unavailable': 'submission.failed.category-unavailable',
  'rate-limited': 'submission.failed.rate-limited',
  network: 'submission.failed.network',
};

/** Final-confirmation panel state machine owned by the workspace. */
export type SubmissionPanelState =
  | { phase: 'preparing' }
  | {
    phase: 'ready';
    preparedId: string;
    identity: { login: string };
    categories: DiscussionCategory[];
    destination: OfficialDestination;
  }
  | { phase: 'confirming' }
  | { phase: 'created'; url: string }
  | { phase: 'failed'; code: Exclude<GitHubSubmissionFailureCode, 'unknown'> }
  | { phase: 'unknown' };

/** Props of the final-confirmation panel. */
export interface SubmitPanelProps {
  t: T;
  state: SubmissionPanelState;
  /** The exact reviewed title; shown read-only. */
  title: string;
  /** The exact reviewed Markdown body; shown read-only. */
  body: string;
  /** The effective submission language; shown read-only. */
  language: DraftLanguage;
  /** Currently selected category id; the select is controlled by the workspace. */
  categoryId: string;
  onCategoryChange(id: string): void;
  /** The distinct final confirmation action; the only way a mutation starts. */
  onConfirm(): void;
  /** Leave the panel without any mutation. */
  onBack(): void;
  /** Draft-export fallback, available in every state. */
  onExport(): void;
}

/**
 * Final-confirmation panel: shows the exact title, Markdown body, Discussion
 * category, language, official destination, and submission account supplied
 * by the authorization boundary, and performs the one authorized mutation
 * only through the distinct confirm action. Definite failures and unknown
 * results each render distinct localized outcomes that preserve draft export;
 * an unknown result never offers a retry.
 */
export function SubmitPanel({ t, state, title, body, language, categoryId, onCategoryChange, onConfirm, onBack, onExport }: SubmitPanelProps): React.ReactElement {
  return (
    <section className="dsh-feedback-submission" data-testid="dsh-feedback-submission">
      <h3 className="dsh-feedback-section-title">{t('submission.title')}</h3>
      {state.phase === 'preparing' || state.phase === 'confirming' ? (
        <p className="dsh-feedback-hint" data-testid={'dsh-feedback-submission-' + state.phase}>{t('submission.submitting')}</p>
      ) : null}
      {state.phase === 'ready' ? renderReady(t, state, title, body, language, categoryId, onCategoryChange, onConfirm, onBack, onExport) : null}
      {state.phase === 'created' ? renderCreated(t, state.url, onBack, onExport) : null}
      {state.phase === 'failed' ? renderFailed(t, state.code, onBack, onExport) : null}
      {state.phase === 'unknown' ? renderUnknown(t, onBack, onExport) : null}
    </section>
  );
}

/** Render the ready state: every field of the final preview plus the three actions. */
function renderReady(
  t: T,
  state: Extract<SubmissionPanelState, { phase: 'ready' }>,
  title: string,
  body: string,
  language: DraftLanguage,
  categoryId: string,
  onCategoryChange: (id: string) => void,
  onConfirm: () => void,
  onBack: () => void,
  onExport: () => void,
): React.ReactElement {
  return (
    <div className="dsh-feedback-submission-ready" data-testid="dsh-feedback-submission-ready">
      <dl className="dsh-feedback-submission-facts">
        <div className="dsh-feedback-submission-fact">
          <dt>{t('submission.title')}</dt>
          <dd data-testid="dsh-feedback-submission-title">{title}</dd>
        </div>
        <div className="dsh-feedback-submission-fact">
          <dt>{t('preview.title')}</dt>
          <dd><pre className="dsh-feedback-preview" data-testid="dsh-feedback-submission-body">{body}</pre></dd>
        </div>
        <div className="dsh-feedback-submission-fact">
          <dt>{t('submission.category')}</dt>
          <dd>
            <select
              className="dsh-feedback-submission-category"
              data-testid="dsh-feedback-submission-category"
              aria-label={t('submission.category')}
              value={categoryId}
              onChange={(event) => onCategoryChange(event.target.value)}
            >
              {state.categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </dd>
        </div>
        <div className="dsh-feedback-submission-fact">
          <dt>{t('submission.language')}</dt>
          <dd data-testid="dsh-feedback-submission-language">{t(('language.' + language) as FeedbackBridgeKey)}</dd>
        </div>
        <div className="dsh-feedback-submission-fact">
          <dt>{t('submission.destination')}</dt>
          <dd data-testid="dsh-feedback-submission-destination">
            {state.destination.owner}/{state.destination.repo}{' '}
            <a className="dsh-feedback-destination-link" href={state.destination.url} target="_blank" rel="noreferrer">
              {t('guidance.open')}
            </a>
          </dd>
        </div>
        <div className="dsh-feedback-submission-fact">
          <dt>{t('submission.account')}</dt>
          <dd data-testid="dsh-feedback-submission-account">{state.identity.login}</dd>
        </div>
      </dl>
      <div className="dsh-feedback-submission-actions">
        <button type="button" className="dsh-feedback-action dsh-feedback-action-primary" data-testid="dsh-feedback-submission-confirm" onClick={onConfirm}>
          {t('submission.confirm')}
        </button>
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-back" onClick={onBack}>
          {t('submission.back')}
        </button>
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-export" onClick={onExport}>
          {t('submission.export')}
        </button>
      </div>
    </div>
  );
}

/** Render the created state with the permanent Discussion link. */
function renderCreated(t: T, url: string, onBack: () => void, onExport: () => void): React.ReactElement {
  return (
    <div className="dsh-feedback-submission-created" data-testid="dsh-feedback-submission-created">
      <p>{t('submission.created')}</p>
      <p>
        <a className="dsh-feedback-submission-link" href={url} target="_blank" rel="noreferrer" data-testid="dsh-feedback-submission-created-link">
          {t('submission.open')}
        </a>
      </p>
      <div className="dsh-feedback-submission-actions">
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-back" onClick={onBack}>
          {t('submission.back')}
        </button>
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-export" onClick={onExport}>
          {t('submission.export')}
        </button>
      </div>
    </div>
  );
}

/** Render a definite failure class with its localized explanation and the export fallback. */
function renderFailed(t: T, code: Exclude<GitHubSubmissionFailureCode, 'unknown'>, onBack: () => void, onExport: () => void): React.ReactElement {
  return (
    <div className="dsh-feedback-submission-failed" data-testid="dsh-feedback-submission-failed">
      <p className="dsh-feedback-submission-error" data-testid="dsh-feedback-submission-failed-code">{t(FAILURE_KEYS[code])}</p>
      <div className="dsh-feedback-submission-actions">
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-back" onClick={onBack}>
          {t('submission.back')}
        </button>
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-export" onClick={onExport}>
          {t('submission.export')}
        </button>
      </div>
    </div>
  );
}

/** Render the unknown-result state: no retry, manual verification guidance, export fallback. */
function renderUnknown(t: T, onBack: () => void, onExport: () => void): React.ReactElement {
  return (
    <div className="dsh-feedback-submission-unknown" data-testid="dsh-feedback-submission-unknown">
      <p className="dsh-feedback-submission-error">{t('submission.unknown')}</p>
      <p className="dsh-feedback-submission-guidance" data-testid="dsh-feedback-submission-unknown-guidance">{t('submission.unknown.guidance')}</p>
      <div className="dsh-feedback-submission-actions">
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-back" onClick={onBack}>
          {t('submission.back')}
        </button>
        <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-submission-export" onClick={onExport}>
          {t('submission.export')}
        </button>
      </div>
    </div>
  );
}
