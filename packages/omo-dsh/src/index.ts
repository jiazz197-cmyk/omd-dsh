import z from "@deepseek-ai/schemastery";
import { scopeOf } from "@deepseek-ai/dsh-scope";

/**
 * @module @subagent-router/omo-dsh
 *
 * omo-mode: per-mode (agent preset) model routing row for DeepSeek Harness.
 *
 * Structurally identical to the harness built-in installModelSelection
 * (dsh-agent): it listens on the system-prompt/assemble event to inject
 * the provider/model prompt variables (so a persona can render the
 * model and provider template variables), and overrides provider/model
 * on the agent/request waterfall after next(), dropping any inherited
 * reasoningEffort. Both listeners register with prepend: true so this
 * row sits OUTSIDE the entry point per-session selection listener and
 * its override wins deterministically -- that is the mechanism behind
 * "each mode pins its own model".
 *
 * When provider/model are not configured the row passes everything
 * through and only serves the persona banner variables (inheriting the
 * entry/session selection), so it is safe to mount into any preset.
 */

/** Cordis plugin name. */
const name = "omo-mode";
/** No service injection: this row only registers scoped event listeners. */
const inject = [];

/** Runtime schema for the omo-mode row. */
const Config = z.object({
  mode: z.string().required(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
});

function apply(ctx, config) {
  if (scopeOf(ctx) === undefined) {
    throw new Error(
      "omo-mode: refusing to mount outside a scoped context (mode '" + config.mode + "'). " +
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

  ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
    const assembled = await next();
    if (pinned === undefined) return assembled;
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: pinned.provider,
        model: pinned.model,
      },
    };
  }, { prepend: true });

  ctx.on("agent/request", async (_payload, _context, next) => {
    const resolved = await next();
    if (pinned === undefined) return resolved;
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
  }, { prepend: true });
}

export { Config, apply, inject, name };

