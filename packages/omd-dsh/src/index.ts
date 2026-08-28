import z from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { setModeOverride } from "./shared.js";

/**
 * @module @carljia/omd-dsh
 *
 * omd-mode: per-mode (agent preset) model routing row for DeepSeek Harness.
 *
 * Structurally identical to the harness built-in installModelSelection
 * (dsh-agent): it listens on the system-prompt/assemble event to inject
 * the provider/model prompt variables (so a persona can render the
 * model and provider template variables), and overrides provider/model
 * on the agent/request waterfall after next(), dropping any inherited
 * reasoningEffort. Both listeners register with prepend: true so this
 * row sits OUTSIDE the entry point per-session selection listener.
 *
 * Precedence vs. the UI model switch: the matrix model is the preset's
 * DEFAULT route, but an explicit user selection wins for the task.
 * The entry selection (installModelSelection) is invisible to this row
 * (it is owned by the host entry point), so the decision is derived
 * from what the waterfall actually resolved:
 *
 *   - entry selection == matrix model            -> pin (no-op);
 *   - entry selection missing                    -> pin (claim the mode);
 *   - session still blank (no request/header)
 *     and entry selection == the deployment
 *     default captured at mount                  -> pin (fallback, no pick);
 *   - a preset switch (agent-preset/selected)
 *     happened after the last request/header and
 *     entry selection == the route the session
 *     was running before the switch              -> pin (new mode claims);
 *   - otherwise the user explicitly picked a
 *     different model                            -> yield: the request and
 *       the persona variables keep the user's selection, and the row
 *       records it (shared.ts, keyed by the agent) so the omd-task row can
 *       route the "deep" tier to the user's model.
 *
 * When provider/model are not configured the row passes everything
 * through and only serves the persona banner variables (inheriting the
 * entry/session selection), so it is safe to mount into any preset.
 */

/** Cordis plugin name. */
const name = "omd-mode";
/** No service injection: this row only registers scoped event listeners. */
const inject = [];

/** Runtime schema for the omd-mode row. */
const Config = z.object({
  mode: z.string().required(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
});

/**
 * 子代理（subagentDepth > 0）透传：omd-task 的 tier 模型通过显式 agentOptions
 * 落到子代理的 AgentOptions 上，本行若再覆盖会压回模式模型、破坏差异化委派。
 * 无显式 agentOptions 的子代理按 DSH 原生语义继承父级入口选择。
 */
function isSubagent(agent) {
  return agent !== undefined && agent !== null && agent.options !== undefined && agent.options !== null
    && typeof agent.options.subagentDepth === "number" && agent.options.subagentDepth > 0;
}

/**
 * 最近一次 request/header 之后是否发生过 agent-preset/selected（UI 预设选择或 /mode 切换）。
 * 切换事件由 api-proxy 与 omd-mode-switch 在 recompose 完成之后追加，因此必须每次实时计算——
 * 本行挂载时事件尚未入日志，挂载时快照会漏判。
 */
function presetSwitchedAfterLastRequest(session) {
  const events = session === undefined || session === null ? undefined : session.events;
  if (events === undefined) return false;
  let lastHeader = -1;
  let lastSwitch = -1;
  for (const event of events) {
    if (event === undefined || event === null || typeof event.seq !== "number") continue;
    if (event.type === "request/header") lastHeader = event.seq;
    else if (event.type === "agent-preset/selected") lastSwitch = event.seq;
  }
  return lastSwitch > lastHeader;
}

function apply(ctx, config) {
  if (scopeOf(ctx) === undefined) {
    throw new Error(
      "omd-mode: refusing to mount outside a scoped context (mode '" + config.mode + "'). " +
      "Mount this row inside an agent preset; a global mount would pin the model for every agent in the process."
    );
  }
  const pinned: any = config.provider !== undefined && config.model !== undefined
    ? {
        provider: config.provider,
        model: config.model,
      }
    : undefined;
  if (config.reasoningEffort !== undefined && pinned !== undefined) {
    pinned.reasoningEffort = config.reasoningEffort;
  }

  // 挂载时快照部署默认模型（d0）。blank 会话的入口选择 == d0 视为「未显式选择」。
  // 必须静态快照：session.selectModel 每次都会把用户选择写回全局默认，动态读取会把
  // 用户选择误判为默认值。
  let d0;
  try {
    const def = ctx.get("agentDefaultModel");
    const current = def !== undefined && def !== null ? def.currentSelection() : undefined;
    if (current !== undefined && current !== null && typeof current.provider === "string" && typeof current.model === "string") {
      d0 = { provider: current.provider, model: current.model };
    }
  } catch { /* 读不到默认时退化为仅 entry == pinned 判定 */ }

  // 供同 preset 内的 omd-task 行读取：用户显式切换模型后（本行让路），deep tier 沿用用户选择。
  // 注意：不能直接往 cordis 作用域 ctx 上写属性（Proxy 会抛 "without provide"，且行间
  // ctx 互不可见），因此共享状态放在 shared.ts 的 WeakMap 里，按顶层 agent 对象为键。

  /**
   * 判定一次入口选择是否应钉到模式模型（true），还是让路给用户选择（false）。
   * @param agent - 顶层 agent（子代理已由调用方过滤）。
   * @param entry - 入口选择 { provider, model }；provider/model 缺失 = 无入口选择。
   */
  function shouldPin(agent, entry) {
    if (pinned === undefined) return false;
    if (entry === undefined || entry.provider === undefined || entry.model === undefined) return true;
    if (entry.provider === pinned.provider && entry.model === pinned.model) return true;
    const session = agent !== undefined && agent !== null ? agent.session : undefined;
    const logged = session === undefined ? undefined : session.requestHeader();
    if (logged === undefined) {
      // 会话尚无任何请求：入口选择要么是部署默认（未选择），要么是首请求前的显式选择。
      // 只有默认值视为「未选择」；其余一律视为用户选择。
      if (d0 !== undefined && entry.provider === d0.provider && entry.model === d0.model) return true;
      return false;
    }
    // 会话已跑过请求：刚切换 preset（/mode 或 UI 选择）时，切换前的路由（logged）是
    // 新模式认领矩阵模型的基线；否则入口选择与模式模型不同 = 用户显式切换，让路。
    if (presetSwitchedAfterLastRequest(session)
      && logged.config !== undefined && logged.config !== null
      && entry.provider === logged.config.provider && entry.model === logged.config.model) {
      return true;
    }
    return false;
  }

  ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
    const assembled = await next();
    const agent = _context && _context.agent;
    if (pinned === undefined || isSubagent(agent)) return assembled;
    const variables = assembled.variables ?? {};
    if (shouldPin(agent, { provider: variables.provider, model: variables.model })) {
      return {
        ...assembled,
        variables: {
          ...variables,
          provider: pinned.provider,
          model: pinned.model,
        },
      };
    }
    // 让路：保留入口（用户）选择注入的变量，persona 展示实际路由的模型。
    return assembled;
  }, { prepend: true });

  ctx.on("agent/request", async (_payload, next) => {
    const resolved = await next();
    const agent = _payload && _payload.agent;
    if (pinned === undefined || isSubagent(agent)) return resolved;
    if (shouldPin(agent, { provider: resolved.provider, model: resolved.model })) {
      setModeOverride(agent, undefined);
      const stripped = { ...resolved };
      delete stripped.reasoningEffort;
      const out = {
        ...stripped,
        provider: pinned.provider,
        model: pinned.model,
      };
      if (pinned.reasoningEffort !== undefined) {
        out.reasoningEffort = pinned.reasoningEffort;
      }
      return out;
    }
    // 用户显式选择了别的模型：本次任务顶层路由用用户选择；deep tier 同步（omd-task 读取）。
    setModeOverride(agent, { provider: resolved.provider, model: resolved.model });
    return resolved;
  }, { prepend: true });
}

export { Config, apply, inject, name };
