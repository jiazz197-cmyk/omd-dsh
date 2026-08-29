import * as React from "react";
import { OmdMatrixController, OMD_SETTINGS_NS } from "./omd-matrix-controller.js";
import type { OmdScope } from "./omd-matrix-controller.js";
import type { Matrix } from "./sync.js";

/**
 * @module @carljia/omd-dsh/client
 *
 * Browser half of the omd-dsh plugin: the "omd模型分配" settings section
 * (settings.section slot). Binds the `omd-model-allocation` settings
 * namespace and renders an editable model matrix — 7 modes with their
 * top-level provider/model (plus optional reasoningEffort) and per-tier
 * provider/model with the tier hint shown read-only.
 *
 * Saving replaces the whole namespace section with the draft matrix, fencing
 * the write with the namespace revision (`expectedRevision`): a concurrent
 * change is refused (`settings-rejected`) and the page reloads the host
 * state instead of silently overwriting. New sessions route with the saved
 * matrix; running sessions keep the combination they started with.
 *
 * Bundle notes: only `react` is required externally; everything else comes
 * from cordis services (slots / locale / connection / settingsScope), so the
 * bundle stays within the client bundle purity gate (scripts/postbuild.mjs
 * wraps this module in the DSH client bundle envelope).
 */

const NS = "settings.omd";

/** Fixed display order of the 7 modes (mirrors `omd-dsh setup`). */
const MODE_ORDER = ["executor", "ultraworker", "planner", "reviewer", "explorer", "librarian", "chat"];

const en = {
  nav: "OMD model allocation",
  title: "OMD model allocation",
  intro: "Model routes for the 7 OMD agent presets. Changes apply to sessions you start from now on — running sessions keep the models they began with.",
  loading: "Loading the model matrix…",
  unavailable: "The model matrix is not available from this browser (settings are process-local for remote connections).",
  readOnly: "The settings document is read-only here; the current matrix is shown for reference.",
  mode: "Mode",
  provider: "Provider",
  model: "Model",
  reasoningEffort: "Reasoning effort",
  reasoningEffortHint: "Optional; leave empty to let the provider decide.",
  tiers: "Tiers",
  tier: "Tier",
  hint: "Purpose",
  save: "Save",
  saving: "Saving…",
  reset: "Restore defaults",
  saved: "Saved — new sessions will use the new matrix.",
  errorPrefix: "Save failed:",
  renderError: "The model matrix form could not be rendered:",
  conflict: "The matrix changed on the host; the form was reloaded with the latest values.",
  executor: "Executor",
  ultraworker: "Ultraworker",
  planner: "Planner",
  reviewer: "Reviewer",
  explorer: "Explorer",
  librarian: "Librarian",
  chat: "Chat",
};

const zh = {
  nav: "omd模型分配",
  title: "omd 模型分配",
  intro: "7 个 OMD agent 预设的模型路由。保存后对之后新建的会话生效——运行中的会话保持它开始时的模型。",
  loading: "正在加载模型矩阵…",
  unavailable: "当前浏览器无法访问模型矩阵（远程连接时设置仅在本机进程内有效）。",
  readOnly: "设置文档当前只读；以下展示现有矩阵，仅供参考。",
  mode: "模式",
  provider: "Provider",
  model: "Model",
  reasoningEffort: "推理强度",
  reasoningEffortHint: "可选；留空交给 provider 默认。",
  tiers: "档位（Tiers）",
  tier: "档位",
  hint: "用途",
  save: "保存",
  saving: "保存中…",
  reset: "恢复默认",
  saved: "已保存——新会话将按新矩阵路由模型。",
  errorPrefix: "保存失败：",
  renderError: "模型矩阵表单渲染失败：",
  conflict: "矩阵已在宿主侧变更，表单已按最新值重新加载。",
  executor: "执行者",
  ultraworker: "超能工作者",
  planner: "规划者",
  reviewer: "评审者",
  explorer: "探索者",
  librarian: "图书管理员",
  chat: "对话",
};

/** Cordis services this browser plugin requires (fiber service waiting). */
export const inject = ["slots", "locale", "connection", "settingsScope"];

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "omd-dsh: settings section dictionaries");
  const { api } = ctx.get("connection");
  const describe = ctx.settingsScope.describe();
  const scope = ctx.settingsScope.bind({ namespace: OMD_SETTINGS_NS }) as OmdScope;
  const controller = new OmdMatrixController(api, scope, describe);
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "omd-model-allocation",
    order: 30, // after Models (10) and Agent presets (20)
    label: () => t("nav"),
    locale: NS,
    inject: () => ({ scope, controller, t }),
  }, OmdModelAllocationSection));
}

// ── view ──

const styles: Record<string, React.CSSProperties> = {
  section: { maxWidth: 720, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 12 },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  intro: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13, lineHeight: "20px" },
  notice: { color: "var(--dsw-alias-state-warn-label)", margin: 0, fontSize: 12, lineHeight: "18px" },
  savedNotice: { color: "var(--dsw-alias-state-success-primary)", margin: 0, fontSize: 12, lineHeight: "18px" },
  error: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 12, lineHeight: "18px" },
  card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
  cardHead: { display: "flex", alignItems: "baseline", gap: 8 },
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  cardRoute: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, fontWeight: 500, lineHeight: "18px" },
  input: { boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", width: "100%", height: 32, font: "inherit", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 10px", fontSize: 14, lineHeight: "22px" },
  inputDisabled: { opacity: 0.6, cursor: "default" },
  tierRow: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 },
  tierHead: { display: "flex", alignItems: "baseline", gap: 8 },
  tierName: { margin: 0, fontSize: 13, fontWeight: 600 },
  tierHint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px", flex: 1, overflowWrap: "anywhere" },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 },
  actions: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },
  primaryButton: { boxSizing: "border-box", height: 36, font: "inherit", cursor: "pointer", border: "none", borderRadius: 18, padding: "0 14px", fontSize: 14, lineHeight: "22px", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" },
  secondaryButton: { boxSizing: "border-box", height: 36, font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)", borderRadius: 18, padding: "0 14px", fontSize: 14, lineHeight: "22px" },
  buttonDisabled: { opacity: 0.4, cursor: "default" },
};

/** Render-error boundary: a broken form must say so instead of blanking the page. */
interface OmdBoundaryState { error: unknown }
class OmdRenderBoundary extends React.Component<{ t: (key: string) => string; children?: React.ReactNode }, OmdBoundaryState> {
  state: OmdBoundaryState = { error: null };
  static getDerivedStateFromError(error: unknown): OmdBoundaryState { return { error }; }
  render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div style={styles.section}>
          <h2 style={styles.title}>{this.props.t("nav")}</h2>
          <p style={styles.error} role="alert">{this.props.t("renderError")} {this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}</p>
        </div>
      );
    }
    return this.props.children ?? null;
  }
}

export function OmdModelAllocationSection(props: { scope: OmdScope; controller: OmdMatrixController; t: (key: string) => string }): React.ReactElement {
  return (
    <OmdRenderBoundary t={props.t}>
      <OmdModelAllocationBody {...props} />
    </OmdRenderBoundary>
  );
}

function OmdModelAllocationBody(props: { scope: OmdScope; controller: OmdMatrixController; t: (key: string) => string }): React.ReactElement | null {
  const { scope, controller, t } = props;
  const scopeSnapshot = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => scope.subscribe(listener), [scope]),
    React.useCallback(() => scope.getSnapshot(), [scope]),
    React.useCallback(() => scope.getSnapshot(), [scope]), // SSR/test renderers; no-op in the browser
  );
  const ui = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    React.useCallback(() => controller.getSnapshot(), [controller]),
    React.useCallback(() => controller.getSnapshot(), [controller]),
  );

  if (scopeSnapshot.status === "unavailable") {
    return (
      <div style={styles.section}>
        <h2 style={styles.title}>{t("nav")}</h2>
        <p style={styles.intro}>{t("unavailable")}</p>
      </div>
    );
  }
  if (scopeSnapshot.status !== "ready" || ui.draft === null) {
    return (
      <div style={styles.section}>
        <h2 style={styles.title}>{t("nav")}</h2>
        <p style={styles.intro}>{t("loading")}</p>
      </div>
    );
  }

  const matrix = ui.draft as Matrix;
  const readOnly = !controller.writable;

  return (
    <div style={styles.section}>
      <h2 style={styles.title}>{t("nav")}</h2>
      <p style={styles.intro}>{t("intro")}</p>
      {readOnly ? <p style={styles.notice}>{t("readOnly")}</p> : null}
      {ui.saved ? <p style={styles.savedNotice} role="status">{t("saved")}</p> : null}
      {ui.error !== null
        ? <p style={styles.error} role="alert">{t("errorPrefix")} {ui.error}{ui.error.toLowerCase().includes("revision") || ui.error.toLowerCase().includes("changed") ? ` ${t("conflict")}` : ""}</p>
        : null}
      {MODE_ORDER.map((modeId) => {
        const cfg = matrix.modes[modeId] ?? {};
        const route = cfg.provider !== undefined || cfg.model !== undefined
          ? `${cfg.provider ?? "?"}/${cfg.model ?? "?"}`
          : "";
        const modeName = t(modeId) ?? modeId;
        return (
          <div key={modeId} style={styles.card}>
            <div style={styles.cardHead}>
              <h3 style={styles.cardTitle}>{modeName}</h3>
              <span style={styles.cardRoute}>{modeId}{route !== "" ? ` · ${route}` : ""}</span>
            </div>
            <div style={styles.grid2}>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>{t("provider")}</span>
                <input
                  style={{ ...styles.input, ...(readOnly ? styles.inputDisabled : {}) }}
                  value={cfg.provider ?? ""}
                  disabled={readOnly || ui.status === "saving"}
                  spellCheck={false}
                  placeholder="deepseek-official"
                  onChange={(event) => controller.patchMode(modeId, "provider", event.target.value)}
                />
              </label>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>{t("model")}</span>
                <input
                  style={{ ...styles.input, ...(readOnly ? styles.inputDisabled : {}) }}
                  value={cfg.model ?? ""}
                  disabled={readOnly || ui.status === "saving"}
                  spellCheck={false}
                  placeholder="deepseek-v4-pro"
                  onChange={(event) => controller.patchMode(modeId, "model", event.target.value)}
                />
              </label>
            </div>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>{t("reasoningEffort")}</span>
              <input
                style={{ ...styles.input, ...(readOnly ? styles.inputDisabled : {}) }}
                value={cfg.reasoningEffort ?? ""}
                disabled={readOnly || ui.status === "saving"}
                spellCheck={false}
                placeholder=""
                title={t("reasoningEffortHint")}
                onChange={(event) => controller.patchMode(modeId, "reasoningEffort", event.target.value)}
              />
            </label>
            {cfg.tiers !== undefined && Object.keys(cfg.tiers).length > 0
              ? <div style={styles.tierRow}>
                  <span style={styles.fieldLabel}>{t("tiers")}</span>
                  {Object.entries(cfg.tiers).map(([tierName, tier]) => (
                    <div key={tierName} style={styles.tierRow}>
                      <div style={styles.tierHead}>
                        <h4 style={styles.tierName}>{tierName}</h4>
                        <span style={styles.tierHint}>{tier.hint ?? ""}</span>
                      </div>
                      <div style={styles.grid2}>
                        <label style={styles.field}>
                          <span style={styles.fieldLabel}>{t("provider")}</span>
                          <input
                            style={{ ...styles.input, ...(readOnly ? styles.inputDisabled : {}) }}
                            value={tier.provider ?? ""}
                            disabled={readOnly || ui.status === "saving"}
                            spellCheck={false}
                            onChange={(event) => controller.patchTier(modeId, tierName, "provider", event.target.value)}
                          />
                        </label>
                        <label style={styles.field}>
                          <span style={styles.fieldLabel}>{t("model")}</span>
                          <input
                            style={{ ...styles.input, ...(readOnly ? styles.inputDisabled : {}) }}
                            value={tier.model ?? ""}
                            disabled={readOnly || ui.status === "saving"}
                            spellCheck={false}
                            onChange={(event) => controller.patchTier(modeId, tierName, "model", event.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              : null}
          </div>
        );
      })}
      {!readOnly ? (
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.primaryButton, ...(!controller.canSave ? styles.buttonDisabled : {}) }}
            disabled={!controller.canSave}
            onClick={() => { controller.save(); }}
          >
            {ui.status === "saving" ? t("saving") : t("save")}
          </button>
          <button
            type="button"
            style={{ ...styles.secondaryButton, ...(!controller.canSave ? styles.buttonDisabled : {}) }}
            disabled={!controller.canSave}
            onClick={() => { controller.reset(); }}
          >
            {t("reset")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
