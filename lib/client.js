window.__ModuleLoader__.load({
  id: "dsh-feedback-bridge",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const name = "dsh-feedback-bridge";
    const inject = ["slots", "locale"];
    const NS = "dsh-feedback-bridge";
    const STATUS_PATH = "/dsh-feedback-bridge/status";

    /**
     * Non-localized product-policy constant: the official DeepSeek Harness
     * GitHub Discussions destination for manual submission guidance. Kept out
     * of the locale dictionaries because the URL itself never translates.
     */
    const OFFICIAL_DISCUSSIONS_URL = "https://github.com/deepseek-ai/deepseek-harness/discussions";

    const dictionaries = {
      en: {
        nav: "社区反馈",
        "settings.label": "DSH Feedback Bridge",
        title: "DSH Feedback Bridge",
        loading: "Loading status…",
        errorPrefix: "Status unavailable:",
        statusPrefix: "Status:",
        "workspace.title": "Community Feedback",
        "workspace.type": "Custom feedback",
        "field.title": "Title",
        "field.scenario": "Scenario",
        "field.gap": "The problem or situation you encountered",
        "field.desired": "Desired result",
        "field.context": "Additional context",
        "field.titlePlaceholder": "A one-line summary of your feedback",
        "preview.title": "Preview (exact Markdown to export)",
        "action.copy": "Copy draft",
        "action.export": "Export draft",
        "action.cancel": "Cancel",
        "action.close": "Close",
        "status.copied": "Copied to clipboard",
        "status.exported": "Markdown file exported",
        "status.copyFailed": "Copy failed — select the preview text and copy manually",
        "status.needTitle": "Enter a title to copy or export",
        "guidance.title": "Manual submission instructions",
        "guidance.destination": "Official DSH Discussions destination:",
        "guidance.open": "Open official Discussions",
        "guidance.step1": "Copy the draft, or export the Markdown file to keep a copy.",
        "guidance.step2": "Open the official DSH Discussions and pick the most suitable category (for example Ideas, Q&A, or General).",
        "guidance.step3": "Paste the title and body into a new discussion and complete any diagnostic details.",
        "guidance.step4": "Before publishing, check for sensitive content and review existing discussions for overlap.",
      },
      zh: {
        nav: "社区反馈",
        "settings.label": "DSH 社区反馈桥",
        title: "DSH 社区反馈桥",
        loading: "正在加载状态…",
        errorPrefix: "状态不可用：",
        statusPrefix: "状态：",
        "workspace.title": "社区反馈",
        "workspace.type": "自定义反馈",
        "field.title": "标题",
        "field.scenario": "场景",
        "field.gap": "你碰到的问题或情况",
        "field.desired": "期望结果",
        "field.context": "补充上下文",
        "field.titlePlaceholder": "一句话概括你的反馈",
        "preview.title": "预览（将导出的精确 Markdown）",
        "action.copy": "复制草稿",
        "action.export": "导出草稿",
        "action.cancel": "取消",
        "action.close": "关闭",
        "status.copied": "已复制到剪贴板",
        "status.exported": "已导出 Markdown 文件",
        "status.copyFailed": "复制失败——请选中预览文本后手动复制",
        "status.needTitle": "请先填写标题",
        "guidance.title": "人工提交指引",
        "guidance.destination": "官方 DSH Discussions 目的地：",
        "guidance.open": "打开官方 Discussions",
        "guidance.step1": "复制草稿，或导出 Markdown 文件保留一份副本。",
        "guidance.step2": "打开官方 DSH Discussions，选择最合适的分类（例如 Ideas、Q&A 或 General）。",
        "guidance.step3": "将标题与正文粘贴到新讨论中，并按需补全诊断信息。",
        "guidance.step4": "发布前检查是否包含敏感内容，并查看是否存在相似讨论。",
      },
    };

    /** Map a workspace notice state to its locale dictionary key. */
    const NOTICE_STATUS = {
      copied: "status.copied",
      exported: "status.exported",
      copyFailed: "status.copyFailed",
    };

    /**
     * A fresh custom-feedback draft: five editable fields plus the fixed
     * custom-feedback session type. Nothing here is persisted.
     *
     * @returns the empty draft object.
     */
    function emptyFeedbackDraft() {
      return { type: "custom", title: "", scenario: "", gap: "", desired: "", context: "" };
    }

    /**
     * Stable filename for the exported draft Markdown file.
     *
     * @returns the exported file name.
     */
    function feedbackDraftFileName() {
      return "dsh-community-feedback-draft.md";
    }

    /**
     * Build the exact Markdown a draft exports: an optional H1 title plus one
     * section per non-empty field, headed by locale-owned labels. The review
     * card shows this exact string, and copy/export use it verbatim.
     *
     * @param draft - feedback draft fields.
     * @param headings - locale-owned section headings for scenario, gap,
     * desired, and context.
     * @returns the generated Markdown text.
     */
    function buildDraftMarkdown(draft, headings) {
      const sections = [];
      for (const [key, heading] of [["scenario", headings.scenario], ["gap", headings.gap], ["desired", headings.desired], ["context", headings.context]]) {
        const value = String(draft[key] ?? "").trim();
        if (value !== "") sections.push(`## ${heading}\n\n${value}`);
      }
      const title = String(draft.title ?? "").trim();
      const parts = [];
      if (title !== "") parts.push(`# ${title}`);
      parts.push(...sections);
      return parts.join("\n\n");
    }

    /**
     * In-memory feedback-session controller owned by the Client plugin
     * lifecycle. The sidebar trigger and the workspace share one instance;
     * disposing the plugin clears the draft. Nothing is written to storage.
     */
    function createFeedbackSessionController() {
      let draft = null;
      return {
        /** Resume the in-progress draft or create a fresh custom-feedback one. */
        openOrResume() {
          if (draft === null) draft = emptyFeedbackDraft();
          return draft;
        },
        /** Current draft, or null after cancel/dispose. */
        getDraft() {
          return draft;
        },
        /** Merge a field patch into the in-memory draft. */
        update(patch) {
          draft = { ...draft, ...patch };
        },
        /** Discard the in-memory draft (cancellation). */
        cancel() {
          draft = null;
        },
        /** Plugin-unload cleanup: drop the draft and any references. */
        dispose() {
          draft = null;
        },
      };
    }

    /**
     * Speech-bubble mark for the sidebar entry; renders at rail size when the
     * sidebar is collapsed.
     */
    function FeedbackIcon({ rail }) {
      return React.createElement(
        "svg",
        { className: "dsh-feedback-icon", width: rail ? 18 : 16, height: rail ? 18 : 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        React.createElement("path", {
          d: "M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v7A1.5 1.5 0 0 1 13.5 11H6l-3.6 3.1A.6.6 0 0 1 1.4 13.6V11H2.5A1.5 1.5 0 0 1 1 9.5z",
          fill: "currentColor",
        }),
      );
    }

    /**
     * Left-navigation entry: a sidebar footer-action row labeled 社区反馈 that
     * opens the community-feedback workspace. The label is pure Chinese in
     * every locale by product mandate, and the collapsed rail keeps the same
     * Chinese accessible name.
     */
    function FeedbackTrigger({ t, sessions, wide }) {
      const [open, setOpen] = React.useState(false);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-feedback-trigger" + (wide ? "" : " dsh-feedback-trigger-rail"),
            "data-testid": "dsh-feedback-trigger",
            "aria-label": t("nav"),
            title: t("nav"),
            onClick: () => setOpen(true),
          },
          React.createElement(FeedbackIcon, { rail: !wide }),
          wide ? React.createElement("span", { className: "dsh-feedback-trigger-label" }, t("nav")) : null,
        ),
        open ? React.createElement(FeedbackWorkspace, { t, sessions, onClose: () => setOpen(false) }) : null,
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
    function copyMarkdown(markdown) {
      const clipboard = window.navigator?.clipboard;
      if (clipboard?.writeText !== undefined) {
        return clipboard.writeText(markdown);
      }
      const textarea = window.document.createElement("textarea");
      textarea.value = markdown;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      window.document.body.appendChild(textarea);
      textarea.select();
      const copied = window.document.execCommand ? window.document.execCommand("copy") : false;
      window.document.body.removeChild(textarea);
      return copied ? Promise.resolve() : Promise.reject(new Error("copy failed"));
    }

    /**
     * Export the exact Markdown as a downloadable file. Creates a Blob object
     * URL, clicks a temporary download anchor, and revokes the URL once the
     * download handoff has started. Purely client-side: no network request.
     *
     * @param markdown - the exact draft Markdown.
     * @param fileName - the download file name.
     */
    function exportDraftMarkdown(markdown, fileName) {
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    }

    /**
     * Community-feedback workspace: the unified surface opened by the left-nav
     * entry. It edits a custom-feedback draft, shows the exact Markdown that
     * copy/export produce, copies or downloads it, and carries the manual
     * submission guidance for the official DSH Discussions. Closing keeps the
     * in-memory draft; cancel discards it. No action here performs a GitHub
     * write or any network request.
     */
    function FeedbackWorkspace({ t, sessions, onClose }) {
      const initial = sessions.openOrResume();
      const [fields, setFields] = React.useState({ ...initial });
      const [notice, setNotice] = React.useState(null);
      const headings = {
        scenario: t("field.scenario"),
        gap: t("field.gap"),
        desired: t("field.desired"),
        context: t("field.context"),
      };
      const markdown = buildDraftMarkdown(fields, headings);
      const canExport = String(fields.title ?? "").trim() !== "";

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        if (window.document?.addEventListener !== undefined) {
          window.document.addEventListener("keydown", onKey);
          return () => window.document.removeEventListener("keydown", onKey);
        }
        return undefined;
      }, [onClose]);

      const setField = (key) => (event) => {
        const value = event.target.value;
        const next = { ...fields, [key]: value };
        setFields(next);
        sessions.update({ [key]: value });
      };

      const handleCopy = () => {
        if (!canExport) return;
        copyMarkdown(markdown)
          .then(() => setNotice("copied"))
          .catch(() => setNotice("copyFailed"));
      };
      const handleExport = () => {
        if (!canExport) return;
        exportDraftMarkdown(markdown, feedbackDraftFileName());
        setNotice("exported");
      };
      const handleCancel = () => {
        sessions.cancel();
        onClose();
      };

      const renderField = (key, testid, type) => {
        const props = {
          "data-testid": testid,
          id: testid,
          value: fields[key],
          onChange: setField(key),
        };
        if (type === "textarea") {
          return React.createElement("textarea", { ...props, rows: 3 });
        }
        return React.createElement("input", { ...props, type: "text", placeholder: key === "title" ? t("field.titlePlaceholder") : undefined });
      };

      return React.createElement(
        "div",
        { className: "dsh-feedback-overlay", "data-testid": "dsh-feedback-workspace" },
        React.createElement("div", { className: "dsh-feedback-mask", onClick: onClose, "aria-hidden": "true" }),
        React.createElement(
          "div",
          { className: "dsh-feedback-panel", role: "dialog", "aria-modal": "true", "aria-label": t("workspace.title") },
          React.createElement(
            "header",
            { className: "dsh-feedback-header" },
            React.createElement(
              "div",
              { className: "dsh-feedback-header-titles" },
              React.createElement("h2", { className: "dsh-feedback-title" }, t("workspace.title")),
              React.createElement("span", { className: "dsh-feedback-type", "data-testid": "dsh-feedback-type" }, t("workspace.type")),
            ),
            React.createElement(
              "button",
              { type: "button", className: "dsh-feedback-close", "data-testid": "dsh-feedback-close", "aria-label": t("action.close"), onClick: onClose },
              "×",
            ),
          ),
          React.createElement(
            "div",
            { className: "dsh-feedback-body" },
            React.createElement(
              "form",
              { className: "dsh-feedback-form", onSubmit: (event) => event.preventDefault() },
              React.createElement("label", { className: "dsh-feedback-field", htmlFor: "dsh-feedback-title" },
                React.createElement("span", { className: "dsh-feedback-field-label" }, t("field.title")),
                renderField("title", "dsh-feedback-title"),
              ),
              React.createElement("label", { className: "dsh-feedback-field", htmlFor: "dsh-feedback-scenario" },
                React.createElement("span", { className: "dsh-feedback-field-label" }, t("field.scenario")),
                renderField("scenario", "dsh-feedback-scenario", "textarea"),
              ),
              React.createElement("label", { className: "dsh-feedback-field", htmlFor: "dsh-feedback-gap" },
                React.createElement("span", { className: "dsh-feedback-field-label" }, t("field.gap")),
                renderField("gap", "dsh-feedback-gap", "textarea"),
              ),
              React.createElement("label", { className: "dsh-feedback-field", htmlFor: "dsh-feedback-desired" },
                React.createElement("span", { className: "dsh-feedback-field-label" }, t("field.desired")),
                renderField("desired", "dsh-feedback-desired", "textarea"),
              ),
              React.createElement("label", { className: "dsh-feedback-field", htmlFor: "dsh-feedback-context" },
                React.createElement("span", { className: "dsh-feedback-field-label" }, t("field.context")),
                renderField("context", "dsh-feedback-context", "textarea"),
              ),
            ),
            React.createElement(
              "section",
              { className: "dsh-feedback-review", "aria-label": t("preview.title") },
              React.createElement("h3", { className: "dsh-feedback-section-title" }, t("preview.title")),
              React.createElement("pre", { className: "dsh-feedback-preview", "data-testid": "dsh-feedback-preview" }, markdown),
            ),
          ),
          React.createElement(
            "footer",
            { className: "dsh-feedback-footer" },
            React.createElement(
              "div",
              { className: "dsh-feedback-actions" },
              React.createElement(
                "button",
                { type: "button", className: "dsh-feedback-action", "data-testid": "dsh-feedback-copy", disabled: !canExport, onClick: handleCopy },
                t("action.copy"),
              ),
              React.createElement(
                "button",
                { type: "button", className: "dsh-feedback-action dsh-feedback-action-primary", "data-testid": "dsh-feedback-export", disabled: !canExport, onClick: handleExport },
                t("action.export"),
              ),
              React.createElement(
                "button",
                { type: "button", className: "dsh-feedback-action", "data-testid": "dsh-feedback-cancel", onClick: handleCancel },
                t("action.cancel"),
              ),
            ),
            notice !== null ? React.createElement(
              "p",
              { className: "dsh-feedback-notice", "data-testid": "dsh-feedback-notice", role: "status" },
              t(NOTICE_STATUS[notice] ?? "status.copyFailed"),
            ) : null,
            !canExport ? React.createElement("p", { className: "dsh-feedback-hint", "data-testid": "dsh-feedback-hint" }, t("status.needTitle")) : null,
            React.createElement(
              "section",
              { className: "dsh-feedback-guidance", "data-testid": "dsh-feedback-guidance" },
              React.createElement("h3", { className: "dsh-feedback-section-title" }, t("guidance.title")),
              React.createElement(
                "p",
                { className: "dsh-feedback-destination" },
                t("guidance.destination"),
                " ",
                React.createElement(
                  "a",
                  { className: "dsh-feedback-destination-link", href: OFFICIAL_DISCUSSIONS_URL, target: "_blank", rel: "noreferrer", "data-testid": "dsh-feedback-destination-link" },
                  t("guidance.open"),
                ),
              ),
              React.createElement(
                "ol",
                { className: "dsh-feedback-steps" },
                React.createElement("li", null, t("guidance.step1")),
                React.createElement("li", null, t("guidance.step2")),
                React.createElement("li", null, t("guidance.step3")),
                React.createElement("li", null, t("guidance.step4")),
              ),
            ),
          ),
        ),
      );
    }

    function statusUrl() {
      if (typeof document === "undefined") return STATUS_PATH;
      return new URL("dsh-feedback-bridge/status", document.baseURI).pathname;
    }

    /**
     * Settings section shown by the DSH Web GUI. The section is the
     * recognizable v0.1 status surface: it proves the Client half loaded and
     * reads the Host half through its documented `webServer` route.
     */
    function StatusSection({ t }) {
      const [state, setState] = React.useState({ phase: "loading", error: null, data: null });
      React.useEffect(() => {
        let cancelled = false;
        fetch(statusUrl())
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            if (!cancelled) setState({ phase: "ready", error: null, data });
          })
          .catch((error) => {
            if (!cancelled) setState({ phase: "error", error: error instanceof Error ? error.message : String(error), data: null });
          });
        return () => {
          cancelled = true;
        };
      }, []);

      return React.createElement(
        "section",
        { className: "dsh-feedback-bridge-status", "data-testid": "dsh-feedback-bridge-status" },
        React.createElement("h2", null, t("title")),
        state.phase === "loading" ? React.createElement("p", null, t("loading")) : null,
        state.phase === "error" ? React.createElement("p", null, t("errorPrefix") + " " + state.error) : null,
        state.phase === "ready" ? React.createElement("p", null, t("statusPrefix") + " " + state.data.status + " · v" + state.data.version) : null,
      );
    }

    /**
     * Theme-token styles for the sidebar entry and the feedback workspace.
     * Injected once through the same style-tag mechanism the DSH client
     * plugins use; the tag is keyed so re-application is idempotent.
     */
    const STYLES = [
      ".dsh-feedback-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:inline-flex;overflow:hidden}",
      ".dsh-feedback-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-feedback-trigger-rail{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;margin:0;padding:0}",
      ".dsh-feedback-trigger-label{white-space:nowrap;overflow:hidden}",
      ".dsh-feedback-icon{flex:none}",
      ".dsh-feedback-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}",
      ".dsh-feedback-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}",
      ".dsh-feedback-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:min(860px,calc(100vw - 48px));height:min(720px,calc(100vh - 48px));box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;flex-direction:column;display:flex;position:relative;overflow:hidden}",
      ".dsh-feedback-header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;min-height:56px;padding:14px 16px 10px;display:flex}",
      ".dsh-feedback-header-titles{align-items:baseline;gap:10px;min-width:0;display:inline-flex}",
      ".dsh-feedback-title{color:var(--dsw-alias-label-primary);margin:0;font-size:18px;font-weight:600;line-height:26px}",
      ".dsh-feedback-type{background:var(--dsw-alias-button-ghost-active-fill);height:22px;color:var(--dsw-alias-label-caption);border-radius:11px;flex:none;align-items:center;padding:0 10px;font-size:12px;line-height:22px;display:inline-flex}",
      ".dsh-feedback-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:14px;justify-content:center;align-items:center;padding:0;font-size:18px;display:inline-flex}",
      ".dsh-feedback-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-feedback-body{flex:1;min-height:0;gap:20px;padding:0 24px;overflow-y:auto;display:flex}",
      ".dsh-feedback-form{flex:1 1 46%;min-width:0;flex-direction:column;gap:12px;display:flex}",
      ".dsh-feedback-field{flex-direction:column;gap:4px;display:flex}",
      ".dsh-feedback-field-label{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}",
      ".dsh-feedback-field input,.dsh-feedback-field textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:10px;width:100%;padding:8px 10px;font-family:inherit;font-size:14px;line-height:20px}",
      ".dsh-feedback-field textarea{resize:vertical;min-height:64px}",
      ".dsh-feedback-field input:focus,.dsh-feedback-field textarea:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
      ".dsh-feedback-review{flex:1 1 54%;min-width:0;flex-direction:column;gap:8px;display:flex}",
      ".dsh-feedback-section-title{color:var(--dsw-alias-label-primary);flex:none;margin:0;font-size:13px;font-weight:500;line-height:20px}",
      ".dsh-feedback-preview{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:12px;flex:1;min-height:0;margin:0;padding:12px;overflow:auto}",
      ".dsh-feedback-footer{box-sizing:border-box;flex:none;gap:8px;padding:12px 24px 16px;display:flex;flex-direction:column}",
      ".dsh-feedback-actions{align-items:center;gap:8px;display:flex}",
      ".dsh-feedback-action{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border-radius:999px;padding:0 14px;font-family:inherit;font-size:13px;line-height:20px}",
      ".dsh-feedback-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-feedback-action:disabled{cursor:default;opacity:.4}",
      ".dsh-feedback-action-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
      ".dsh-feedback-notice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}",
      ".dsh-feedback-hint{color:var(--dsw-alias-label-caption);margin:0;font-size:12px;line-height:18px}",
      ".dsh-feedback-guidance{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding-top:10px;display:flex}",
      ".dsh-feedback-destination{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}",
      ".dsh-feedback-destination-link{color:var(--dsw-alias-state-business-primary)}",
      ".dsh-feedback-steps{color:var(--dsw-alias-label-secondary);margin:0;padding-left:20px;font-size:12px;line-height:20px}",
    ].join("\n");

    /**
     * Inject the plugin styles once and return a disposer that removes them.
     * Keyed by a data attribute so repeated application (or a second plugin
     * copy) does not duplicate the tag; unload removes the tag like any other
     * plugin-owned lifecycle resource.
     *
     * @param documentRef - the browser document.
     * @returns a disposer removing the injected style tag.
     */
    function injectStyles(documentRef) {
      const tagId = `${NS}-ui`;
      if (documentRef.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {};
      const style = documentRef.createElement("style");
      style.dataset.plugin = name;
      style.dataset.pluginCss = tagId;
      style.textContent = STYLES;
      documentRef.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * Client plugin entry point. The DSH Web shell provides `slots` and
     * `locale`; this registration adds one left-navigation entry plus the
     * settings status page without touching Harness core. The feedback-session
     * controller lives for the plugin's lifetime and is disposed on unload.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-feedback-bridge: dictionaries");
      if (typeof window !== "undefined" && window.document?.head !== undefined) {
        ctx.effect(() => injectStyles(window.document), "dsh-feedback-bridge: styles");
      }
      const t = ctx.locale.bind(NS);
      const sessions = createFeedbackSessionController();
      ctx.effect(() => {
        const disposers = [
          ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
            name: "sidebar.footer.action",
            id: "dsh-feedback-bridge",
            locale: NS,
          }, (props) => React.createElement(FeedbackTrigger, { t, sessions, ...props }))),
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "dsh-feedback-bridge",
            order: 90,
            label: () => t("settings.label"),
          }, (props) => React.createElement(StatusSection, { t, ...props }))),
        ];
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "dsh-feedback-bridge: UI slots");
      ctx.effect(() => () => sessions.dispose(), "dsh-feedback-bridge: session controller cleanup");
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.OFFICIAL_DISCUSSIONS_URL = OFFICIAL_DISCUSSIONS_URL;
    exports.dictionaries = dictionaries;
    exports.emptyFeedbackDraft = emptyFeedbackDraft;
    exports.feedbackDraftFileName = feedbackDraftFileName;
    exports.buildDraftMarkdown = buildDraftMarkdown;
    exports.createFeedbackSessionController = createFeedbackSessionController;
    exports.FeedbackTrigger = FeedbackTrigger;
    exports.FeedbackWorkspace = FeedbackWorkspace;
    return module.exports;
  }
});
