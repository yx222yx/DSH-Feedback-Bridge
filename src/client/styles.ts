import { NS } from './constants.js';

/**
 * Theme-token styles for the sidebar entry and the feedback workspace.
 * Injected once through the same style-tag mechanism the DSH client
 * plugins use; the tag is keyed so re-application is idempotent.
 */
const STYLES = [
  '.dsh-feedback-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:inline-flex;overflow:hidden}',
  '.dsh-feedback-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-feedback-trigger-rail{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;margin:0;padding:0}',
  '.dsh-feedback-trigger-label{white-space:nowrap;overflow:hidden}',
  '.dsh-feedback-icon{flex:none}',
  '.dsh-feedback-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}',
  '.dsh-feedback-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}',
  '.dsh-feedback-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:min(860px,calc(100vw - 48px));height:min(720px,calc(100vh - 48px));box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;flex-direction:column;display:flex;position:relative;overflow:hidden}',
  '.dsh-feedback-header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;min-height:56px;padding:14px 16px 10px;display:flex}',
  '.dsh-feedback-header-titles{align-items:baseline;gap:10px;min-width:0;display:inline-flex}',
  '.dsh-feedback-title{color:var(--dsw-alias-label-primary);margin:0;font-size:18px;font-weight:600;line-height:26px}',
  '.dsh-feedback-type{background:var(--dsw-alias-button-ghost-active-fill);height:22px;color:var(--dsw-alias-label-caption);border-radius:11px;flex:none;align-items:center;padding:0 10px;font-size:12px;line-height:22px;display:inline-flex}',
  '.dsh-feedback-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:14px;justify-content:center;align-items:center;padding:0;font-size:18px;display:inline-flex}',
  '.dsh-feedback-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-feedback-body{flex:1;min-height:0;gap:20px;padding:0 24px;overflow-y:auto;display:flex}',
  '.dsh-feedback-form{flex:1 1 46%;min-width:0;flex-direction:column;gap:12px;display:flex}',
  '.dsh-feedback-field{flex-direction:column;gap:4px;display:flex}',
  '.dsh-feedback-field-label{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}',
  '.dsh-feedback-field input,.dsh-feedback-field textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:10px;width:100%;padding:8px 10px;font-family:inherit;font-size:14px;line-height:20px}',
  '.dsh-feedback-field textarea{resize:vertical;min-height:64px}',
  '.dsh-feedback-field input:focus,.dsh-feedback-field textarea:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
  '.dsh-feedback-review{flex:1 1 54%;min-width:0;flex-direction:column;gap:8px;display:flex}',
  '.dsh-feedback-section-title{color:var(--dsw-alias-label-primary);flex:none;margin:0;font-size:13px;font-weight:500;line-height:20px}',
  '.dsh-feedback-preview{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:12px;flex:1;min-height:0;margin:0;padding:12px;overflow:auto}',
  '.dsh-feedback-footer{box-sizing:border-box;flex:none;gap:8px;padding:12px 24px 16px;display:flex;flex-direction:column}',
  '.dsh-feedback-actions{align-items:center;gap:8px;display:flex}',
  '.dsh-feedback-action{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border-radius:999px;padding:0 14px;font-family:inherit;font-size:13px;line-height:20px}',
  '.dsh-feedback-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-feedback-action:disabled{cursor:default;opacity:.4}',
  '.dsh-feedback-action-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}',
  '.dsh-feedback-notice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}',
  '.dsh-feedback-hint{color:var(--dsw-alias-label-caption);margin:0;font-size:12px;line-height:18px}',
  '.dsh-feedback-confirm{position:absolute;inset:0;z-index:2;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);justify-content:center;align-items:center;gap:10px;padding:24px;text-align:center;display:flex;flex-direction:column}',
  '.dsh-feedback-confirm-title{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:22px}',
  '.dsh-feedback-confirm-body{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}',
  '.dsh-feedback-confirm-actions{align-items:center;gap:8px;display:flex}',
  '.dsh-feedback-action-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}',
  '.dsh-feedback-guidance{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding-top:10px;display:flex}',
  '.dsh-feedback-destination{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}',
  '.dsh-feedback-destination-link{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-feedback-steps{color:var(--dsw-alias-label-secondary);margin:0;padding-left:20px;font-size:12px;line-height:20px}',
].join('\n');

/**
 * Inject the plugin styles once and return a disposer that removes them.
 * Keyed by a data attribute so repeated application (or a second plugin
 * copy) does not duplicate the tag; unload removes the tag like any other
 * plugin-owned lifecycle resource.
 *
 * @param documentRef - the browser document.
 * @returns a disposer removing the injected style tag.
 */
export function injectStyles(documentRef: Document): () => void {
  const tagId = `${NS}-ui`;
  if (documentRef.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {};
  const style = documentRef.createElement('style');
  style.dataset.plugin = NS;
  style.dataset.pluginCss = tagId;
  style.textContent = STYLES;
  documentRef.head.appendChild(style);
  return () => {
    style.remove();
  };
}
