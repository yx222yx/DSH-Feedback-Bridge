import React from 'react';
import { OFFICIAL_DISCUSSIONS_URL } from '../constants.js';
import { statusUrl } from '../env.js';
import { buildDraftMarkdown, feedbackDraftFileName } from '../session.js';
import { revalidateRepairText } from '../assist.js';
import { scanPrivacy } from '../privacy.js';
import {
  applyRecommendations,
  confirmSourceCandidate,
  deriveSourceCandidates,
  quoteSourceText,
  removeSource,
} from '../sources.js';
import type { ConfirmedSourceRecord, FeedbackSourceCandidate } from '../sources.js';
import type { ConversationRead, ConversationSource } from '../conversation.js';
import type {
  AssistSuggestion,
  AssistTransport,
  DraftLanguage,
  FeedbackDraft,
  FeedbackDraftFields,
  FeedbackFieldKey,
  FeedbackSessionController,
  FeedbackType,
  PrivacyFinding,
  T,
  WorkspaceNotice,
} from '../types.js';
import { NOTICE_STATUS } from '../types.js';
import { ROLE_LABEL_KEYS, SourcePanel } from './SourcePanel.js';
import type { SourceCopy } from '../sources.js';

/** Debounce window before an edit triggers an autosave, in milliseconds. */
const AUTOSAVE_DELAY_MS = 600;

/** The four feedback types in render order, matching the type selector. */
const TYPE_OPTIONS: FeedbackType[] = ['plugin-request', 'harness-feature', 'harness-defect', 'custom'];

/** The five public draft field keys in render order. */
const FIELD_KEYS: FeedbackFieldKey[] = ['title', 'scenario', 'gap', 'desired', 'context'];

/** Props of the community-feedback workspace surface. */
export interface FeedbackWorkspaceProps {
  t: T;
  sessions: FeedbackSessionController;
  persistence: import('../types.js').DraftPersistence;
  assistTransport: AssistTransport;
  /** Current-conversation source from `ctx.sessions`; null without a session service. */
  conversation: ConversationSource | null;
  onClose: () => void;
}

/**
 * Read the current conversation through the injected source. The initial
 * render uses the server snapshot so SSR-safe DOM tests see candidates
 * without running effects; the browser subscribes and updates on change.
 *
 * @param source - the conversation source, or null outside a session.
 * @returns the current read, or undefined when no session is open.
 */
function useConversationRead(source: ConversationSource | null | undefined): ConversationRead | undefined {
  const [read, setRead] = React.useState<ConversationRead | undefined>(() => (
    source === null || source === undefined ? undefined : source.getServerSnapshot()
  ));
  React.useEffect(() => {
    if (source === null || source === undefined) return undefined;
    const update = () => setRead(source.getSnapshot());
    update();
    return source.subscribe(update);
  }, [source]);
  return read;
}

/**
 * Community-feedback workspace: the unified surface opened by the left-nav
 * entry. It edits a feedback draft (four types, Chinese/English), shows the
 * exact Markdown that copy/export produce, copies or downloads it, carries
 * the manual submission guidance, and offers model-assisted suggestions,
 * repair, and advisory privacy review. Model output is never auto-applied:
 * applying a suggestion is an explicit per-field action, and a suggestion
 * that would overwrite a newer edit asks first. No action here performs a
 * GitHub write or any external network request.
 */
export function FeedbackWorkspace({ t, sessions, persistence, assistTransport, conversation, onClose }: FeedbackWorkspaceProps): React.ReactElement {
  const [fields, setFields] = React.useState<FeedbackDraft>(() => ({ ...sessions.openOrResume() }));
  const [sources, setSources] = React.useState<ConfirmedSourceRecord[]>(() => sessions.getSources());
  const [notice, setNotice] = React.useState<WorkspaceNotice | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [dshVersion, setDshVersion] = React.useState<string | null>(null);
  const [assistBusy, setAssistBusy] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<AssistSuggestion | null>(null);
  const [repair, setRepair] = React.useState<{ rawText: string; errors: string[] } | null>(null);
  const [repairText, setRepairText] = React.useState('');
  const [modelError, setModelError] = React.useState<{ code: string; message: string } | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = React.useState<FeedbackFieldKey | null>(null);
  const userInteractedRef = React.useRef(false);
  const savedRef = React.useRef<string | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const fieldsRef = React.useRef(fields);
  fieldsRef.current = fields;
  const sourcesRef = React.useRef(sources);
  sourcesRef.current = sources;
  // Field-version snapshot taken when a suggestion request is INITIATED
  // (not when it resolves): applying a suggestion must not silently overwrite
  // content the user established during or after the request, or content that
  // pre-existed the request and differs from the suggestion.
  const fieldsAtRequestRef = React.useRef<FeedbackDraftFields>({ title: '', scenario: '', gap: '', desired: '', context: '' });
  const conversationRead = useConversationRead(conversation);
  const sourceCopy: SourceCopy = {
    diagTitle: t('sources.diag.title'),
    diagCwd: t('sources.diag.cwd'),
    diagPreset: t('sources.diag.preset'),
    diagVersion: t('sources.diag.version'),
    diagSession: t('sources.diag.session'),
    turnMaxTokens: t('sources.diag.turnMaxTokens'),
    errorCode: t('sources.diag.errorCode'),
  };
  const candidates: FeedbackSourceCandidate[] = conversationRead === undefined
    ? []
    : applyRecommendations(deriveSourceCandidates(conversationRead.snapshot, {
        sessionId: conversationRead.sessionId,
        title: conversationRead.meta.title,
        cwd: conversationRead.meta.cwd,
        agentPreset: conversationRead.meta.agentPreset,
        dshVersion,
        copy: sourceCopy,
      }));
  const headings = {
    scenario: t('field.scenario'),
    gap: t('field.gap'),
    desired: t('field.desired'),
    context: t('field.context'),
  };
  const markdown = buildDraftMarkdown(fields, headings);
  const canExport = String(fields.title ?? '').trim() !== '';
  const publicFields: FeedbackDraftFields = {
    title: fields.title,
    scenario: fields.scenario,
    gap: fields.gap,
    desired: fields.desired,
    context: fields.context,
  };
  const privacyFindings: PrivacyFinding[] = scanPrivacy(publicFields, sources);
  const modelFindings: PrivacyFinding[] = (suggestion?.privacyFindings ?? []).map((finding, index) => ({
    id: 'privacy:model:' + index,
    severity: finding.severity,
    kind: finding.kind,
    location: 'source',
    excerpt: finding.quote + (finding.reason !== '' ? ' — ' + finding.reason : ''),
  }));
  const allFindings = [...privacyFindings, ...modelFindings];
  const canAssist = conversationRead !== undefined && sources.length > 0 && !assistBusy;

  /** Record the fields that are known to be persisted. */
  const markSaved = (draftFields: FeedbackDraft) => {
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
        // A user action before the load settled wins: the restore must not
        // clobber edits or source changes made in this open workspace.
        if (userInteractedRef.current) return;
        if (persisted !== null) {
          const resumed: FeedbackDraft = {
            type: persisted.type ?? 'custom',
            ...(persisted.language !== undefined ? { language: persisted.language } : {}),
            title: persisted.fields.title ?? '',
            scenario: persisted.fields.scenario ?? '',
            gap: persisted.fields.gap ?? '',
            desired: persisted.fields.desired ?? '',
            context: persisted.fields.context ?? '',
          };
          setFields(resumed);
          setSources(persisted.sources);
          sessions.restore(resumed);
          sessions.setSources(persisted.sources);
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

  // Read the host DSH version once for the diagnostics candidate; the
  // status route is same-origin and never carries draft content. The fetch
  // failure is swallowed on purpose: the version is optional diagnostics
  // copy and the workspace still opens with the remaining candidate content.
  React.useEffect(() => {
    let cancelled = false;
    fetch(statusUrl())
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('status ' + response.status))))
      .then((data) => {
        if (!cancelled && typeof (data as { dshVersion?: unknown }).dshVersion === 'string') {
          setDshVersion((data as { dshVersion: string }).dshVersion);
        }
      })
      .catch(() => {
        // Swallows only the best-effort status read; the workspace stays usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Toggle one source row between preview and full text. */
  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Confirm a candidate: capture the reviewed snapshot and persist it. */
  const handleConfirm = (candidate: FeedbackSourceCandidate) => {
    userInteractedRef.current = true;
    const record = confirmSourceCandidate(candidate, new Date().toISOString(), t(ROLE_LABEL_KEYS[candidate.role]));
    const next = [...sourcesRef.current, record];
    setSources(next);
    sessions.setSources(next);
    scheduleAutosave(fieldsRef.current);
  };

  /** Remove a confirmed source; it immediately stops feeding draft prep. */
  const handleRemove = (id: string) => {
    userInteractedRef.current = true;
    const next = removeSource(sourcesRef.current, id);
    setSources(next);
    sessions.setSources(next);
    scheduleAutosave(fieldsRef.current);
  };

  /** Quote a confirmed source's reviewed snapshot into one public field. */
  const handleQuote = (id: string, fieldKey: FeedbackFieldKey) => {
    userInteractedRef.current = true;
    const record = sourcesRef.current.find((source) => source.id === id);
    if (record === undefined) return;
    const quoted = quoteSourceText(record).trim();
    if (quoted === '') return;
    const current = String(fieldsRef.current[fieldKey] ?? '').trim();
    const separator = current === '' ? '' : '\n\n';
    const next = { ...fieldsRef.current, [fieldKey]: current + separator + quoted };
    setFields(next);
    sessions.update({ [fieldKey]: next[fieldKey] });
    scheduleAutosave(next);
  };

  /** Debounced autosave; a failed save surfaces the failure notice. */
  const scheduleAutosave = (nextFields: FeedbackDraft) => {
    if (timerRef.current !== null && window.clearTimeout !== undefined) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      persistence.save(nextFields, sourcesRef.current)
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
    persistence.save(fields, sourcesRef.current)
      .then(() => onClose())
      .catch(() => setNotice('autosaveFailed'));
  };
  const flushRef = React.useRef(flushAndClose);
  flushRef.current = flushAndClose;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (confirmDiscard) setConfirmDiscard(false);
        else if (confirmOverwrite !== null) setConfirmOverwrite(null);
        else flushRef.current();
      }
    };
    if (window.document?.addEventListener !== undefined) {
      window.document.addEventListener('keydown', onKey);
      return () => window.document.removeEventListener('keydown', onKey);
    }
    return undefined;
  }, [confirmDiscard, confirmOverwrite]);

  // Best-effort unload fallback: the keepalive carries no success
  // semantics and only fires while a draft is open.
  React.useEffect(() => {
    const onUnload = () => {
      if (fieldsRef.current !== null) persistence.keepalive(fieldsRef.current, sourcesRef.current);
    };
    if (window.addEventListener !== undefined) {
      window.addEventListener('beforeunload', onUnload);
      return () => window.removeEventListener('beforeunload', onUnload);
    }
    return undefined;
  }, []);

  const setField = (key: FeedbackFieldKey) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    userInteractedRef.current = true;
    const value = event.target.value;
    const next = { ...fields, [key]: value };
    setFields(next);
    sessions.update({ [key]: value });
    scheduleAutosave(next);
  };

  /** User-selected feedback type; the model recommendation never sets this directly. */
  const handleTypeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    userInteractedRef.current = true;
    const next = event.target.value as FeedbackType;
    const nextFields = { ...fields, type: next };
    setFields(nextFields);
    sessions.setType(next);
    scheduleAutosave(nextFields);
  };

  /** User-selected submission language; '' clears the selection (English default). */
  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    userInteractedRef.current = true;
    const raw = event.target.value;
    const nextLanguage: DraftLanguage | undefined = raw === 'zh' || raw === 'en' ? raw : undefined;
    const nextFields = { ...fields, ...(nextLanguage === undefined ? { language: undefined } : { language: nextLanguage }) };
    setFields(nextFields);
    sessions.setLanguage(nextLanguage);
    scheduleAutosave(nextFields);
  };

  /** Run one feedback-assist call; model output is staged, never auto-applied. */
  const handleAssist = () => {
    if (conversationRead === undefined || sourcesRef.current.length === 0 || assistBusy) return;
    // Snapshot the public fields BEFORE the async request starts: edits made
    // while it is in flight must be confirmed before a suggestion overwrites
    // them, and pre-existing field content is compared against the suggestion.
    fieldsAtRequestRef.current = { title: fieldsRef.current.title, scenario: fieldsRef.current.scenario, gap: fieldsRef.current.gap, desired: fieldsRef.current.desired, context: fieldsRef.current.context };
    setAssistBusy(true);
    setModelError(null);
    setRepair(null);
    setSuggestion(null);
    assistTransport.run({
      sessionId: conversationRead.sessionId,
      language: fieldsRef.current.language ?? null,
      currentType: fieldsRef.current.type,
      sources: sourcesRef.current,
    })
      .then((outcome) => {
        setAssistBusy(false);
        if (outcome.status === 'ok') {
          setSuggestion(outcome.result);
        } else if (outcome.status === 'repair-needed') {
          setRepair({ rawText: outcome.rawText, errors: outcome.errors });
          setRepairText(outcome.rawText);
        } else if (outcome.status === 'model-failed') {
          setModelError({ code: outcome.code, message: outcome.message });
        } else {
          setNotice('noModelContext');
        }
      })
      .catch(() => {
        setAssistBusy(false);
        setNotice('assistFailed');
      });
  };

  /** Apply one suggested field, guarding against overwriting a newer edit. */
  const applySuggestion = (key: FeedbackFieldKey) => {
    if (suggestion === null) return;
    const snapshot = fieldsAtRequestRef.current;
    const current = fieldsRef.current[key];
    const suggested = suggestion.draft[key];
    const changedSinceRequest = current !== snapshot[key];
    const preExistingDiffers = snapshot[key] !== '' && suggested !== snapshot[key];
    if (changedSinceRequest || preExistingDiffers) {
      setConfirmOverwrite(key);
      return;
    }
    applySuggestionNow(key);
  };

  /** Apply one suggested field without further confirmation. */
  const applySuggestionNow = (key: FeedbackFieldKey) => {
    if (suggestion === null) return;
    userInteractedRef.current = true;
    const value = suggestion.draft[key];
    const next = { ...fields, [key]: value };
    setFields(next);
    sessions.update({ [key]: value });
    scheduleAutosave(next);
    setConfirmOverwrite(null);
  };

  /** Re-validate a repaired raw response locally; no model call is made. */
  const handleRevalidate = () => {
    const outcome = revalidateRepairText(repairText);
    if (outcome.status === 'ok') {
      setSuggestion(outcome.result);
      setRepair(null);
      // A locally re-validated response is staged now; snapshot the fields so
      // the overwrite guard compares against this moment.
      fieldsAtRequestRef.current = { title: fieldsRef.current.title, scenario: fieldsRef.current.scenario, gap: fieldsRef.current.gap, desired: fieldsRef.current.desired, context: fieldsRef.current.context };
    } else {
      setRepair({ rawText: repairText, errors: outcome.errors });
    }
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
  /** Mask click dismisses an open confirmation, otherwise closes. */
  const onMaskClick = () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else if (confirmOverwrite !== null) setConfirmOverwrite(null);
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
            <select
              className="dsh-feedback-type"
              data-testid="dsh-feedback-type-select"
              aria-label={t('field.type')}
              value={fields.type}
              onChange={handleTypeChange}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>{t(('type.' + option) as import('../types.js').FeedbackBridgeKey)}</option>
              ))}
            </select>
            {suggestion !== null && suggestion.type !== fields.type ? (
              <span className="dsh-feedback-type-badge" data-testid="dsh-feedback-type-recommendation">
                {t('assist.recommendedType')}: {t(('type.' + suggestion.type) as import('../types.js').FeedbackBridgeKey)}
              </span>
            ) : null}
            <select
              className="dsh-feedback-language"
              data-testid="dsh-feedback-language-select"
              aria-label={t('language.label')}
              value={fields.language ?? ''}
              onChange={handleLanguageChange}
            >
              <option value="">{t('language.default')}</option>
              <option value="zh">{t('language.zh')}</option>
              <option value="en">{t('language.en')}</option>
            </select>
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
          <SourcePanel
            t={t}
            candidates={candidates}
            confirmed={sources}
            expanded={expanded}
            noSession={conversationRead === undefined}
            currentSessionId={conversationRead?.sessionId ?? null}
            onToggleExpand={toggleExpand}
            onConfirm={handleConfirm}
            onRemove={handleRemove}
            onQuote={handleQuote}
          />
          <section className="dsh-feedback-assist" data-testid="dsh-feedback-assist">
            <h3 className="dsh-feedback-section-title">{t('assist.title')}</h3>
            <div className="dsh-feedback-assist-actions">
              <button
                type="button"
                className="dsh-feedback-action dsh-feedback-action-primary"
                data-testid="dsh-feedback-assist-run"
                disabled={!canAssist}
                onClick={handleAssist}
              >
                {assistBusy ? t('assist.generating') : t('assist.generate')}
              </button>
              {!canAssist && !assistBusy ? (
                <p className="dsh-feedback-hint" data-testid="dsh-feedback-assist-hint">{t('assist.noSourcesOrSession')}</p>
              ) : null}
            </div>
            {modelError !== null ? (
              <div className="dsh-feedback-assist-error" data-testid="dsh-feedback-assist-error">
                <p>{t('assist.modelFailed')}</p>
                <p className="dsh-feedback-assist-error-detail">{t('assist.errorCode')}: {modelError.code}</p>
                <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-assist-retry" onClick={handleAssist}>
                  {t('assist.retry')}
                </button>
              </div>
            ) : null}
            {suggestion !== null ? (
              <div className="dsh-feedback-assist-result" data-testid="dsh-feedback-assist-result">
                <div className="dsh-feedback-assist-recommendation" data-testid="dsh-feedback-assist-recommendation">
                  <p><strong>{t('assist.recommendedType')}:</strong> {t(('type.' + suggestion.type) as import('../types.js').FeedbackBridgeKey)}</p>
                  <p className="dsh-feedback-assist-reason">{t('assist.typeReason')}: {suggestion.typeReason}</p>
                  {suggestion.type !== fields.type ? (
                    <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-assist-apply-type" onClick={() => handleTypeChange({ target: { value: suggestion.type } } as React.ChangeEvent<HTMLSelectElement>)}>
                      {t('assist.useRecommendedType')}
                    </button>
                  ) : null}
                </div>
                {suggestion.missingInfo.length > 0 ? (
                  <ul className="dsh-feedback-assist-missing" data-testid="dsh-feedback-assist-missing">
                    {suggestion.missingInfo.map((item, index) => (
                      <li key={index}>
                        <span className={'dsh-feedback-assist-importance dsh-feedback-assist-importance-' + item.importance}>
                          {t(('assist.importance.' + item.importance) as import('../types.js').FeedbackBridgeKey)}
                        </span>
                        {item.field}: {item.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="dsh-feedback-assist-draft" data-testid="dsh-feedback-assist-draft">
                  {FIELD_KEYS.map((key) => (
                    <div key={key} className="dsh-feedback-assist-field">
                      <span className="dsh-feedback-assist-field-label">{t(('field.' + key) as import('../types.js').FeedbackBridgeKey)}</span>
                      <span className="dsh-feedback-assist-suggested" data-testid={'dsh-feedback-assist-suggested-' + key}>{suggestion.draft[key]}</span>
                      <button
                        type="button"
                        className="dsh-feedback-action"
                        data-testid={'dsh-feedback-assist-apply-' + key}
                        onClick={() => applySuggestion(key)}
                      >
                        {t('assist.apply')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {repair !== null ? (
              <div className="dsh-feedback-assist-repair" data-testid="dsh-feedback-assist-repair">
                <p>{t('assist.repairTitle')}</p>
                <ul className="dsh-feedback-assist-repair-errors">
                  {repair.errors.map((error, index) => <li key={index}>{t(error as import('../types.js').FeedbackBridgeKey)}</li>)}
                </ul>
                <textarea data-testid="dsh-feedback-assist-repair-text" rows={6} value={repairText} onChange={(event) => setRepairText(event.target.value)} />
                <div className="dsh-feedback-assist-actions">
                  <button type="button" className="dsh-feedback-action dsh-feedback-action-primary" data-testid="dsh-feedback-assist-revalidate" onClick={handleRevalidate}>
                    {t('assist.revalidate')}
                  </button>
                  <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-assist-repair-discard" onClick={() => setRepair(null)}>
                    {t('assist.discardRepair')}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
          {allFindings.length > 0 ? (
            <section className="dsh-feedback-privacy" data-testid="dsh-feedback-privacy">
              <h3 className="dsh-feedback-section-title">{t('privacy.title')}</h3>
              <ul className="dsh-feedback-privacy-list">
                {allFindings.map((finding) => (
                  <li key={finding.id} className={'dsh-feedback-privacy-' + finding.severity} data-testid="dsh-feedback-privacy-finding">
                    <span className="dsh-feedback-privacy-severity">{t(('privacy.severity.' + finding.severity) as import('../types.js').FeedbackBridgeKey)}</span>
                    {t(('privacy.kind.' + finding.kind) as import('../types.js').FeedbackBridgeKey)} — {finding.excerpt}{finding.reasonKey !== undefined ? ' ' + t(finding.reasonKey) : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="dsh-feedback-edit-row">
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
        {confirmOverwrite !== null ? (
          <div className="dsh-feedback-confirm" data-testid="dsh-feedback-overwrite-confirm" role="alertdialog" aria-modal="true" aria-label={t('assist.overwriteTitle')}>
            <p className="dsh-feedback-confirm-title">{t('assist.overwriteTitle')}</p>
            <p className="dsh-feedback-confirm-body">{t('assist.overwriteBody')}</p>
            <div className="dsh-feedback-confirm-actions">
              <button type="button" className="dsh-feedback-action dsh-feedback-action-primary" data-testid="dsh-feedback-overwrite-confirm-action" onClick={() => applySuggestionNow(confirmOverwrite)}>
                {t('assist.replace')}
              </button>
              <button type="button" className="dsh-feedback-action" data-testid="dsh-feedback-overwrite-keep" onClick={() => setConfirmOverwrite(null)}>
                {t('assist.keepEdit')}
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
