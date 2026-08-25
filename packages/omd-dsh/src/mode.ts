import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { scopeOf } from "@deepseek-ai/dsh-scope";

/**
 * @module @carljia/omd-dsh/mode
 *
 * omd-mode-switch: human-facing `/mode` command -- switch the CURRENT
 * session to another OMD agent preset, including mid-conversation.
 *
 * DSH's native `agentPreset.select` host API refuses to recompose a
 * session that has already started (its preset is fixed at the UI level),
 * and the AgentPresets.recompose method itself performs no history check
 * ("the CALLER owns that check"). This row deliberately performs the
 * in-session recompose, then keeps the log honest:
 *   - appends `agent-preset/selected`, so resume/fork rebuild the same
 *     composition ("model-visible <-> logged" rule);
 *   - appends `plan/mode { active: false }` when plan mode is still
 *     active, since the switch itself is a mode decision;
 *   - steers a notice message so the model knows the tool set changed.
 *
 * Mitigations for the swapped tool catalog: the omd-planner catalog is a
 * subset of omd-executor's (the executor preset also mounts the plan-mode
 * row), so logged planner tool calls stay renderable under the executor
 * composition. Switching between other omd presets follows the same rule
 * and the model simply receives the new catalog on the next request.
 */

/** Cordis plugin name. */
const name = "omd-mode-switch";
/**
 * No mount-time injection: the roster service is resolved at runtime so a
 * rosterless deployment fails only the /mode command, never the preset
 * mount itself.
 */
const inject = [];

/** The OMD presets /mode may switch to. */
const OMD_PRESET_IDS = [
  "omd-executor",
  "omd-ultraworker",
  "omd-planner",
  "omd-reviewer",
  "omd-explorer",
  "omd-librarian",
  "omd-chat",
];

/** Normalize the command input to a valid omd preset id, or undefined. */
function normalizeTarget(rawInput) {
  const trimmed = String(rawInput).trim().toLowerCase();
  if (trimmed === "") return undefined;
  const candidate = trimmed.startsWith("omd-") ? trimmed : "omd-" + trimmed;
  return OMD_PRESET_IDS.includes(candidate) ? candidate : undefined;
}

/** Fold the session's plan/mode events (last one wins). */
function planModeActive(events) {
  let active = false;
  for (const event of events ?? []) {
    if (event !== undefined && event.type === "plan/mode") {
      active = event.data !== undefined && event.data !== null && event.data.active === true;
    }
  }
  return active;
}

/** Execute one /mode invocation through the roster service. */
async function executeSwitch(ctx, invocation) {
  const agent = invocation.agent;
  const target = normalizeTarget(invocation.rawInput);
  if (target === undefined) {
    return {
      kind: "error",
      text: "Usage: /mode <preset> — valid: " + OMD_PRESET_IDS.join(", "),
    };
  }
  let presets;
  try {
    presets = ctx.get("agentPresets");
  } catch {
    presets = undefined;
  }
  if (presets === undefined || presets === null) {
    return {
      kind: "error",
      text: "/mode is unavailable: this deployment composes no agent presets.",
    };
  }
  let current;
  try {
    current = presets.composedPreset(agent.ctx);
  } catch {
    current = undefined;
  }
  if (current === target) {
    return { kind: "success", text: "Already running " + target + "." };
  }
  try {
    const preset = await presets.recompose(agent.ctx, target);
    agent.session.append("agent-preset/selected", { agentPreset: preset.id });
    if (planModeActive(agent.session.events)) {
      agent.session.append("plan/mode", { active: false });
    }
    agent.steer(
      createUserMessage({
        content: [
          {
            type: "text",
            text:
              "The session switched to the " +
              preset.id +
              " agent preset. Continue in this mode with its tool set, persona, and model routing.",
          },
        ],
        source: {
          kind: "plugin",
          plugin: "omd-mode-switch",
          form: "notice",
          summary: "Session mode switched to " + preset.id,
        },
      })
    );
    return {
      kind: "success",
      text: "Session preset switched to " + preset.id + " — the next turn runs with that mode's tools and model.",
    };
  } catch (error) {
    return {
      kind: "error",
      text: "/mode failed: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}

function apply(ctx) {
  if (scopeOf(ctx) === undefined) {
    throw new Error(
      "omd-mode-switch: refusing to mount outside a scoped context; mount this row inside an agent preset"
    );
  }
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "mode",
      description: "switch this session to another omd agent preset (tool set + model)",
      input: {
        hint: "<omd-* preset id>",
        images: false,
      },
      handler: (invocation) => executeSwitch(ctx, invocation),
    });
  });
}

export { apply, inject, name };
