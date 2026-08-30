import React from 'react';
import type {
  FeedbackBridgeKey,
  SimilarityFailureCode,
  SimilarityOutcome,
  SimilarityPanelState,
  SimilaritySourceKind,
  T,
} from '../types.js';

/** Locale-owned label key per source kind. */
const SOURCE_LABEL_KEYS: Record<SimilaritySourceKind, FeedbackBridgeKey> = {
  discussion: 'similarity.source.discussion',
  plugin: 'similarity.source.plugin',
  documentation: 'similarity.source.documentation',
};

/** Locale-owned explanation key per failure code. */
const FAILURE_KEYS: Record<SimilarityFailureCode, FeedbackBridgeKey> = {
  'rate-limited': 'similarity.failed.rate-limited',
  timeout: 'similarity.failed.timeout',
  network: 'similarity.failed.network',
  parse: 'similarity.failed.parse',
};

/** Props of the advisory similarity-results panel. */
export interface SimilarityPanelProps {
  t: T;
  state: SimilarityPanelState;
  onRetry: () => void;
}

/**
 * Advisory similarity-results panel: shows the check's per-source states and
 * result links without ever declaring a duplicate or blocking the workflow.
 * All copy is locale-owned; results carry their public link, source badge,
 * and a concise matched-terms reason.
 */
export function SimilarityPanel({ t, state, onRetry }: SimilarityPanelProps): React.ReactElement {
  return (
    <section className="dsh-feedback-similarity" data-testid="dsh-feedback-similarity">
      <h3 className="dsh-feedback-section-title">{t('similarity.title')}</h3>
      {state.phase === 'idle' ? (
        <p className="dsh-feedback-hint" data-testid="dsh-feedback-similarity-idle">{t('similarity.idleHint')}</p>
      ) : null}
      {state.phase === 'checking' ? (
        <p data-testid="dsh-feedback-similarity-checking">{t('similarity.checking')}</p>
      ) : null}
      {state.phase === 'failed' ? (
        <div className="dsh-feedback-similarity-error" data-testid="dsh-feedback-similarity-failed">
          <p>{t('similarity.failed')}</p>
          <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-similarity-retry" onClick={onRetry}>
            {t('similarity.retry')}
          </button>
        </div>
      ) : null}
      {state.phase === 'done' ? renderDone(t, state.outcome, onRetry) : null}
    </section>
  );
}

/** Render the done phase: per-source failure explanations plus results or the no-results state. */
function renderDone(t: T, outcome: SimilarityOutcome, onRetry: () => void): React.ReactElement {
  const failed = outcome.sourceStates.filter((state) => state.status === 'failed');
  const visible = outcome.sourceStates.filter((state) => state.status !== 'disabled');
  const noneCompleted = visible.every((state) => state.status === 'failed');
  return (
    <>
      {failed.length > 0 ? (
        <div className="dsh-feedback-similarity-partial" data-testid="dsh-feedback-similarity-partial">
          <p>{t('similarity.partial')}</p>
          <ul className="dsh-feedback-similarity-failures">
            {failed.map((state) => (
              <li key={state.source} data-testid="dsh-feedback-similarity-failure">
                {t(SOURCE_LABEL_KEYS[state.source])}: {t(FAILURE_KEYS[state.code])}
              </li>
            ))}
          </ul>
          <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-similarity-retry" onClick={onRetry}>
            {t('similarity.retry')}
          </button>
        </div>
      ) : null}
      {outcome.results.length > 0 ? (
        <ul className="dsh-feedback-similarity-list" data-testid="dsh-feedback-similarity-list">
          {outcome.results.map((result) => (
            <li key={result.id} className={'dsh-feedback-similarity-item dsh-feedback-similarity-' + result.source} data-testid="dsh-feedback-similarity-result">
              <a
                className="dsh-feedback-similarity-link"
                href={result.url}
                target="_blank"
                rel="noreferrer"
                data-testid="dsh-feedback-similarity-link"
              >
                {result.title}
              </a>
              <span className="dsh-feedback-similarity-badge">{t(SOURCE_LABEL_KEYS[result.source])}</span>
              {result.matchedTerms.length > 0 ? (
                <span className="dsh-feedback-similarity-reason" data-testid="dsh-feedback-similarity-reason">
                  {t('similarity.matches')}: {result.matchedTerms.join(', ')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : !noneCompleted ? (
        <p className="dsh-feedback-hint" data-testid="dsh-feedback-similarity-none">{t('similarity.noResults')}</p>
      ) : null}
    </>
  );
}
