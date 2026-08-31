import React from 'react';
import type { SubmissionRecord } from '../records.js';
import type { T } from '../types.js';

/** Props of the submission-records panel. */
export interface RecordsPanelProps {
  t: T;
  records: SubmissionRecord[];
}

/**
 * Submission-records panel: lists the immutable local records of confirmed
 * successful submissions, kept separate from any in-progress draft. Each
 * record links to the stored public Discussion URL and the panel states
 * that v0.1 does not monitor replies, edits, resolution, or other remote
 * status of submitted discussions.
 */
export function RecordsPanel({ t, records }: RecordsPanelProps): React.ReactElement {
  return (
    <section className="dsh-feedback-records">
      {records.length === 0 ? (
        <p className="dsh-feedback-hint" data-testid="dsh-feedback-records-empty">{t('records.empty')}</p>
      ) : (
        <ul className="dsh-feedback-records-list" data-testid="dsh-feedback-records-list">
          {records.map((record) => (
            <li key={record.id} className="dsh-feedback-record" data-testid={'dsh-feedback-record-' + record.id}>
              <a
                className="dsh-feedback-record-link"
                href={record.url}
                target="_blank"
                rel="noreferrer"
                data-testid={'dsh-feedback-record-link-' + record.id}
                aria-label={t('records.open')}
              >
                {record.title}
              </a>
              <span className="dsh-feedback-record-facts" data-testid={'dsh-feedback-record-facts-' + record.id}>
                {t('records.account')}: {record.account} · {t('records.time')}: {new Date(record.submittedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="dsh-feedback-hint" data-testid="dsh-feedback-records-notracking">{t('records.noTracking')}</p>
    </section>
  );
}
