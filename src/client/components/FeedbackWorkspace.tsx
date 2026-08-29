import React from 'react';
import { OFFICIAL_DISCUSSIONS_URL } from '../constants.js';
import { buildDraftMarkdown, feedbackDraftFileName } from '../session.js';
import type {
  DraftPersistence,
  FeedbackDraft,
  FeedbackDraftFields,
  FeedbackFieldKey,
  FeedbackSessionController,
  T,
  WorkspaceNotice,
} from '../types.js';
import { NOTICE_STATUS } from '../types.js';

/** Debounce window before an edit triggers an autosave, in milliseconds. */
const AUTOSAVE_DELAY_MS = 600;

/** Props of the community-feedback workspace surface. */
export interface FeedbackWorkspaceProps {
  t: T;
  sessions: FeedbackSessionController;
  persistence: DraftPersistence;
  onClose: () => void;
}

/**
 * Community-feedback workspace: the unified surface opened by the left-nav
 * entry. It edits a custom-feedback draft, shows the exact Markdown that
 * copy/export produce, copies or downloads it, and carries the manual
 * submission guidance for the official DSH Discussions. The persisted
 * draft is restored on open, edits autosave to the Host, closing flushes
 * any pending save, and cancel asks for a confirmation before discarding.
 * No action here performs a GitHub write or any external network request.
 */
export function FeedbackWorkspace({ t, sessions, persistence, onClose }: FeedbackWorkspaceProps): React.ReactElement {
  const [fields, setFields] = React.useState<FeedbackDraft>(() => ({ ...sessions.openOrResume() }));
  const [notice, setNotice] = React.useState<WorkspaceNotice | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const savedRef = React.useRef<string | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const fieldsRef = React.useRef(fields);
  fieldsRef.current = fields;
  const headings = {
    scenario: t('field.scenario'),
    gap: t('field.gap'),
    desired: t('field.desired'),
    context: t('field.context'),
  };
  const markdown = buildDraftMarkdown(fields, headings);
  const canExport = String(fields.title ?? '').trim() !== '';

  /** Record the fields that are known to be persisted. */
  const markSaved = (draftFields: FeedbackDraftFields) => {
    savedRef.current = JSON.stringify(draftFields);
  };
  /** Whether the current fields differ from the last persisted snapshot. */
  const isDirty = () => JSON.stringify(fields) !== savedRef.current;

  // Restore the persisted draft once on mount; a fresh workspace keeps the
  // in-memory draft as its baseline.
  React.useEffect(() => {
    let cancelled = false;
    persistence.load()
      .then((persisted) => {
        if (cancelled) return;
        if (persisted !== null) {
          const resumed: FeedbackDraft = {
            type: 'custom',
            title: persisted.title ?? '',
            scenario: persisted.scenario ?? '',
            gap: persisted.gap ?? '',
            desired: persisted.desired ?? '',
            context: persisted.context ?? '',
          };
          setFields(resumed);
          sessions.restore(resumed);
          markSaved(resumed);
          setNotice('restored');
        } else {
          markSaved(fieldsRef.current);
        }
      })
      .catch(() => {
        if (!cancelled) setNotice('loadFailed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Debounced autosave; a failed save surfaces the failure notice. */
  const scheduleAutosave = (nextFields: FeedbackDraft) => {
    if (timerRef.current !== null && window.clearTimeout !== undefined) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      persistence.save(nextFields)
        .then((saved) => {
          if (saved) {
            markSaved(nextFields);
            setNotice((current) => (current === 'autosaveFailed' ? null : current));
          }
        })
        .catch(() => setNotice('autosaveFailed'));
    }, AUTOSAVE_DELAY_MS);
  };

  /** Close only after a pending save settles; a failed save keeps the
   * workspace open so the user is never told a draft was kept when it was
   * not. */
  const flushAndClose = () => {
    if (!isDirty()) {
      onClose();
      return;
    }
    if (timerRef.current !== null && window.clearTimeout !== undefined) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = null;
    persistence.save(fields)
      .then(() => onClose())
      .catch(() => setNotice('autosaveFailed'));
  };
  const flushRef = React.useRef(flushAndClose);
  flushRef.current = flushAndClose;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (confirmDiscard) setConfirmDiscard(false);
        else flushRef.current();
      }
    };
    if (window.document?.addEventListener !== undefined) {
      window.document.addEventListener('keydown', onKey);
      return () => window.document.removeEventListener('keydown', onKey);
    }
    return undefined;
  }, [confirmDiscard]);

  // Best-effort unload fallback: the keepalive carries no success
  // semantics and only fires while a draft is open.
  React.useEffect(() => {
    const onUnload = () => {
      if (fieldsRef.current !== null) persistence.keepalive(fieldsRef.current);
    };
    if (window.addEventListener !== undefined) {
      window.addEventListener('beforeunload', onUnload);
      return () => window.removeEventListener('beforeunload', onUnload);
    }
    return undefined;
  }, []);

  const setField = (key: FeedbackFieldKey) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.target.value;
    const next = { ...fields, [key]: value };
    setFields(next);
    sessions.update({ [key]: value });
    scheduleAutosave(next);
  };

  const handleCopy = () => {
    if (!canExport) return;
    copyMarkdown(markdown)
      .then(() => setNotice('copied'))
      .catch(() => setNotice('copyFailed'));
  };
  const handleExport = () => {
    if (!canExport) return;
    exportDraftMarkdown(markdown, feedbackDraftFileName());
    setNotice('exported');
  };
  const handleCancel = () => {
    setConfirmDiscard(true);
  };
  const confirmDiscardNow = () => {
    // Cancel any pending autosave so a late timer can never resurrect the
    // draft after the removal; the generation token covers saves already
    // queued before the discard.
    if (timerRef.current !== null && window.clearTimeout !== undefined) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = null;
    persistence.remove()
      .then(() => {
        sessions.cancel();
        onClose();
      })
      .catch(() => {
        setConfirmDiscard(false);
        setNotice('removeFailed');
      });
  };
  const keepEditing = () => {
    setConfirmDiscard(false);
  };
  /** Mask click dismisses an open discard confirmation, otherwise closes. */
  const onMaskClick = () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else flushAndClose();
  };

  const renderField = (key: FeedbackFieldKey, testid: string, type?: 'textarea') => {
    const props = {
      'data-testid': testid,
      id: testid,
      value: fields[key],
      onChange: setField(key),
    };
    if (type === 'textarea') {
      return <textarea {...props} rows={3} />;
    }
    return (
      <input
        {...props}
        type="text"
        placeholder={key === 'title' ? t('field.titlePlaceholder') : undefined}
      />
    );
  };

  return (
    <div className="dsh-feedback-overlay" data-testid="dsh-feedback-workspace">
      <div className="dsh-feedback-mask" onClick={onMaskClick} aria-hidden="true" />
      <div className="dsh-feedback-panel" role="dialog" aria-modal="true" aria-label={t('workspace.title')}>
        <header className="dsh-feedback-header">
          <div className="dsh-feedback-header-titles">
            <h2 className="dsh-feedback-title">{t('workspace.title')}</h2>
            <span className="dsh-feedback-type" data-testid="dsh-feedback-type">{t('workspace.type')}</span>
            <span className="dsh-feedback-type" data-testid="dsh-feedback-draft-label">{t('workspace.draftLabel')}</span>
          </div>
          <button
            type="button"
            className="dsh-feedback-close"
            data-testid="dsh-feedback-close"
            aria-label={t('action.close')}
            onClick={flushAndClose}
          >
            ×
          </button>
        </header>
        <div className="dsh-feedback-body">
          <form className="dsh-feedback-form" onSubmit={(event) => event.preventDefault()}>
            <label className="dsh-feedback-field" htmlFor="dsh-feedback-title">
              <span className="dsh-feedback-field-label">{t('field.title')}</span>
              {renderField('title', 'dsh-feedback-title')}
            </label>
            <label className="dsh-feedback-field" htmlFor="dsh-feedback-scenario">
              <span className="dsh-feedback-field-label">{t('field.scenario')}</span>
              {renderField('scenario', 'dsh-feedback-scenario', 'textarea')}
            </label>
            <label className="dsh-feedback-field" htmlFor="dsh-feedback-gap">
              <span className="dsh-feedback-field-label">{t('field.gap')}</span>
              {renderField('gap', 'dsh-feedback-gap', 'textarea')}
            </label>
            <label className="dsh-feedback-field" htmlFor="dsh-feedback-desired">
              <span className="dsh-feedback-field-label">{t('field.desired')}</span>
              {renderField('desired', 'dsh-feedback-desired', 'textarea')}
            </label>
            <label className="dsh-feedback-field" htmlFor="dsh-feedback-context">
              <span className="dsh-feedback-field-label">{t('field.context')}</span>
              {renderField('context', 'dsh-feedback-context', 'textarea')}
            </label>
          </form>
          <section className="dsh-feedback-review" aria-label={t('preview.title')}>
            <h3 className="dsh-feedback-section-title">{t('preview.title')}</h3>
            <pre className="dsh-feedback-preview" data-testid="dsh-feedback-preview">{markdown}</pre>
          </section>
        </div>
        <footer className="dsh-feedback-footer">
          <div className="dsh-feedback-actions">
            <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-copy" disabled={!canExport} onClick={handleCopy}>
              {t('action.copy')}
            </button>
            <button type="button" className="dsh-feedback-action dsh-feedback-action-primary" data-testid="dsh-feedback-export" disabled={!canExport} onClick={handleExport}>
              {t('action.export')}
            </button>
            <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-cancel" onClick={handleCancel}>
              {t('action.cancel')}
            </button>
          </div>
          {notice !== null ? (
            <p className="dsh-feedback-notice" data-testid="dsh-feedback-notice" role="status">
              {t(NOTICE_STATUS[notice] ?? 'status.copyFailed')}
            </p>
          ) : null}
          {!canExport ? (
            <p className="dsh-feedback-hint" data-testid="dsh-feedback-hint">{t('status.needTitle')}</p>
          ) : null}
          <section className="dsh-feedback-guidance" data-testid="dsh-feedback-guidance">
            <h3 className="dsh-feedback-section-title">{t('guidance.title')}</h3>
            <p className="dsh-feedback-destination">
              {t('guidance.destination')}{' '}
              <a
                className="dsh-feedback-destination-link"
                href={OFFICIAL_DISCUSSIONS_URL}
                target="_blank"
                rel="noreferrer"
                data-testid="dsh-feedback-destination-link"
              >
                {t('guidance.open')}
              </a>
            </p>
            <ol className="dsh-feedback-steps">
              <li>{t('guidance.step1')}</li>
              <li>{t('guidance.step2')}</li>
              <li>{t('guidance.step3')}</li>
              <li>{t('guidance.step4')}</li>
            </ol>
          </section>
        </footer>
        {confirmDiscard ? (
          <div className="dsh-feedback-confirm" data-testid="dsh-feedback-discard-confirm" role="alertdialog" aria-modal="true" aria-label={t('discard.title')}>
            <p className="dsh-feedback-confirm-title">{t('discard.title')}</p>
            <p className="dsh-feedback-confirm-body">{t('discard.body')}</p>
            <div className="dsh-feedback-confirm-actions">
              <button type="button" className="dsh-feedback-action dsh-feedback-action-danger" data-testid="dsh-feedback-discard-confirm-action" onClick={confirmDiscardNow}>
                {t('discard.confirm')}
              </button>
              <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-discard-keep" onClick={keepEditing}>
                {t('discard.keep')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Copy the exact Markdown to the system clipboard. Prefers the async
 * Clipboard API and falls back to a hidden textarea for non-secure
 * contexts; neither path touches the network.
 *
 * @param markdown - the exact draft Markdown.
 * @returns a promise resolving when the copy is done.
 */
function copyMarkdown(markdown: string): Promise<void> {
  const clipboard = window.navigator?.clipboard;
  if (clipboard?.writeText !== undefined) {
    return clipboard.writeText(markdown);
  }
  const textarea = window.document.createElement('textarea');
  textarea.value = markdown;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  window.document.body.appendChild(textarea);
  textarea.select();
  const copied = window.document.execCommand ? window.document.execCommand('copy') : false;
  window.document.body.removeChild(textarea);
  return copied ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

/**
 * Export the exact Markdown as a downloadable file. Creates a Blob object
 * URL, clicks a temporary download anchor, and revokes the URL once the
 * download handoff has started. Purely client-side: no network request.
 *
 * @param markdown - the exact draft Markdown.
 * @param fileName - the download file name.
 */
function exportDraftMarkdown(markdown: string, fileName: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}
