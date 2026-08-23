import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assertSubagentMaxDepth } from "@deepseek-ai/dsh-subagent";
import { scopeOf } from "@deepseek-ai/dsh-scope";

/**
 * @module @carljia/omd-dsh/task
 *
 * omd-task: tiered subagent delegation tool (the DSH-native equivalent of
 * OMD task(category=...)).
 *
 * The shipped dsh-tool-subagent pins ONE model/persona/toolFilter per tool
 * instance, so a model cannot choose a model per call. DSH subagents
 * service DOES accept per-request agentOptions/persona/toolFilter, and this
 * row exposes that: the model passes a tier argument per call, and each
 * tier maps to a fixed worker profile (provider/model/maxTokens/persona/
 * toolFilter). Strong models stay at the top level while cheap tiers do
 * repetitive investigation work -- differentiated invocation inside one
 * mode, configured entirely in the preset YAML.
 */

/** Cordis plugin name. */
const name = "omd-task";
/** Services this row needs. */
const inject = ["tools", "subagents", "systemPrompt"];

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5;

const TierSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  hint: z.string(),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
});

/** Runtime schema for the omd-task row. */
const Config = z.object({
  provider: z.string().default("spawn"),
  toolName: z.string().default("omd_task"),
  backgroundMode: z.union(["continuable", "foreground"]).default("continuable"),
  tiers: z.dict(TierSchema).required(),
  defaultTier: z.string(),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(3),
});

const TIER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Render text blocks from a canonical JSON block array. */
function outputValueText(values) {
  return values
    .filter((value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "text" && typeof value.text === "string")
    .map((value) => value.text)
    .join("");
}

/** A non-completed stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case "completed": return;
    case "aborted": return "subagent run was cancelled";
    case "error": return "subagent run failed";
    case "max-tokens": return "subagent run hit its token limit before finishing";
    case "refusal": return "subagent declined the task";
    default: return "subagent run ended abnormally (" + String(result.stopReason) + ")";
  }
}

/** Append failure detail and the child preserved partial answer. */
function withDiagnosticAndPartialText(error, result) {
  const diagnostic = result.diagnostic === undefined ? "" : "\nDiagnostic: " + result.diagnostic;
  const text = result.output.filter((block) => block.type === "text").map((block) => block.text).join("");
  return error + diagnostic + (text.length === 0 ? "" : "\nPartial output before the run ended:\n" + text);
}

/** Collect and release one foreground run. */
async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result);
    if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result));
    return {
      kind: "foreground",
      runId: run.id,
      output: result.output,
    };
  })]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === "rejected") {
    if (disposal.status === "rejected") throw new AggregateError([execution.reason, disposal.reason], "subagent run failed: " + String(execution.reason) + "; dispose failed: " + String(disposal.reason));
    throw execution.reason;
  }
  if (disposal.status === "rejected") throw disposal.reason;
  return execution.value;
}

/** Validate row config beyond the schema. Returns an error string or undefined. */
function configError(config) {
  const tierNames = Object.keys(config.tiers);
  if (tierNames.length === 0) return "omd-task: `tiers` must define at least one tier";
  for (const tierName of tierNames) {
    if (!TIER_NAME_PATTERN.test(tierName)) {
      return "omd-task: invalid tier name \"" + tierName + "\" (must match [a-z0-9][a-z0-9_-]*): " + tierNames.join(", ");
    }
    const filter = config.tiers[tierName].toolFilter;
    if (filter !== undefined && filter.allow === undefined && filter.deny === undefined) {
      return "omd-task: tier \"" + tierName + "\" configures toolFilter but names neither allow nor deny";
    }
  }
  if (config.defaultTier !== undefined && config.tiers[config.defaultTier] === undefined) {
    return "omd-task: defaultTier \"" + config.defaultTier + "\" is not one of the tiers: " + tierNames.join(", ");
  }
  return undefined;
}

/** Human-readable enumeration of the tiers for the tool description. */
function tierCatalog(tiers) {
  const lines: string[] = [];
  for (const tierName of Object.keys(tiers)) {
    const tier = tiers[tierName];
    const hint = tier.hint === undefined ? "no hint configured" : tier.hint;
    lines.push("- tier \"" + tierName + "\": " + hint + " [model: " + tier.provider + "/" + tier.model + "]");
  }
  return lines.join("\n");
}

/** Resolve which tier one call uses. Throws with a helpful message when ambiguous. */
function resolveTier(config, requested) {
  const tierNames = Object.keys(config.tiers);
  if (requested !== undefined) {
    if (config.tiers[requested] === undefined) {
      throw new Error("omd_task: unknown tier \"" + requested + "\" -- valid tiers: " + tierNames.join(", "));
    }
    return requested;
  }
  if (config.defaultTier !== undefined) return config.defaultTier;
  if (tierNames.length === 1) return tierNames[0];
  throw new Error("omd_task: choose a tier for this task -- valid tiers: " + tierNames.join(", "));
}

function apply(ctx, config) {
  if (scopeOf(ctx) === undefined) {
    throw new Error("omd-task: refusing to mount outside a scoped context; mount this row inside an agent preset");
  }
  const invalid = configError(config);
  if (invalid !== undefined) throw new Error(invalid);
  if (config.maxDepth !== "provider-managed") assertSubagentMaxDepth(config.maxDepth);

  const continuable = config.backgroundMode === "continuable";
  const toolName = config.toolName;
  let disposeTool;

  const description =
    "Delegate a task to a tiered subagent. Every tier is a fixed worker profile (model + persona + tool boundary); choose the tier that fits the work and give the task a complete, standalone prompt. Available tiers:\n" +
    tierCatalog(config.tiers) + "\n\n" +
    "Use cheaper tiers for repeated investigation, searching, summarising and mechanical work; use stronger tiers for top-level planning, deep reasoning and hard problems. The subagent returns its result, not its intermediate steps." +
    (continuable ? " This tool runs in the background by default and immediately returns a durable subagent id; the runtime sends you a notice when that run settles. Set run_in_background: false only when your next action depends on receiving the result." : " This call waits for the subagent and returns its result.");

  const mount = (provider) => {
    if (typeof config.maxDepth === "number" && !provider.capabilities.depthLimit) {
      throw new Error("omd-task: provider \"" + provider.name + "\" cannot enforce maxDepth (no depthLimit capability) -- set maxDepth: provider-managed");
    }
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error("omd-task: provider \"" + provider.name + "\" does not support backgroundMode: continuable");
    }
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description,
      parameters: {
        description: {
          type: "string",
          required: true,
          description: "A short (3-5 word) description of the delegated task, for display.",
        },
        prompt: {
          type: "string",
          required: true,
          description: "The complete, self-contained task for the subagent. It does not share this conversation\u2019s context, so include everything it needs.",
        },
        tier: {
          type: "string",
          description: "Which worker tier to use. " + tierCatalog(config.tiers) + (config.defaultTier !== undefined ? " Leave empty to use the default tier (\"" + config.defaultTier + "\")." : " Required when more than one tier exists."),
        },
        ...(continuable ? { run_in_background: {
          type: "boolean",
          description: "Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.",
        } } : {}),
      },
      output: {
        schema: { oneOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "continuable" },
              subagentId: { type: "string", required: true },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "foreground" },
              runId: { type: "string", required: true },
              output: { type: "array", required: true, items: { type: "json" } },
            },
          },
        ] },
        render: (_args, value) => [{
          type: "text",
          text: value.kind === "continuable" ? "started subagent " + value.subagentId : outputValueText(value.output),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent;
        if (!parent) throw new Error("omd_task requires a calling agent (exec.agent was undefined)");
        const tierName = resolveTier(config, args.tier);
        const tier = config.tiers[tierName];
        const maxDepth = typeof config.maxDepth === "number" ? config.maxDepth : undefined;
        const request = {
          label: args.description,
          prompt: [{ type: "text", text: args.prompt }],
          parent,
          agentOptions: {
            provider: tier.provider,
            model: tier.model,
            ...(tier.maxTokens !== undefined ? { maxTokens: tier.maxTokens } : {}),
          },
          ...(tier.persona !== undefined ? { persona: tier.persona } : {}),
          ...(tier.toolFilter !== undefined ? { toolFilter: tier.toolFilter } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
        };
        if (continuable && args.run_in_background !== false) {
          return {
            kind: "continuable",
            subagentId: (await ctx.subagents.startContinuable({
              provider: config.provider,
              label: args.description,
              request,
              signal: exec.signal,
            })).childId,
          };
        }
        return settleForegroundRun(await ctx.subagents.start(config.provider, {
          ...request,
          signal: exec.signal,
        }));
      },
    }));
  };

  ctx.on("subagent/provider-added", (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider);
  });
  ctx.on("subagent/provider-removed", (providerName) => {
    if (providerName !== config.provider || disposeTool === undefined) return;
    disposeTool();
    disposeTool = undefined;
  });
  const present = ctx.subagents.getProvider(config.provider);
  if (present !== undefined) mount(present);
  else ctx.logger.info("omd-task: subagent provider \"" + config.provider + "\" not registered yet; the \"" + toolName + "\" tool will register when it appears");

  if (continuable) ctx.systemPrompt.section({
    name: "tool:" + toolName,
    order: SUBAGENT_SECTION_ORDER,
    text: (context) => disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined ? "" :
      "Use " + toolName + " in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set run_in_background: false only when your next action depends on that subagent result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.",
  });
}

export { Config, apply, inject, name };

