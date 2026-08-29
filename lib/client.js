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
    const dictionaries = {
      en: {
        nav: "DSH Feedback Bridge",
        title: "DSH Feedback Bridge",
        loading: "Loading status…",
        errorPrefix: "Status unavailable:",
        statusPrefix: "Status:",
      },
      zh: {
        nav: "DSH 社区反馈桥",
        title: "DSH 社区反馈桥",
        loading: "正在加载状态…",
        errorPrefix: "状态不可用：",
        statusPrefix: "状态：",
      },
    };

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
     * Client plugin entry point. The DSH Web shell provides `slots` and
     * `locale`; this registration adds one localized settings section without
     * touching Harness core.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-feedback-bridge: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        return ctx.slots.inject("settings.section", () => {
          const dispose = ctx.slots.register({
            name: "settings.section",
            id: "dsh-feedback-bridge",
            order: 90,
            label: () => t("nav"),
          }, (props) => React.createElement(StatusSection, { t, ...props }));
          return dispose;
        });
      }, "dsh-feedback-bridge: status section slot");
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
