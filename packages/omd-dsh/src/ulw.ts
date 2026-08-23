/**
 * @module @carljia/omd-dsh/ulw
 *
 * omd-ulw: human-facing `/ulw` command — the "ultrawork" trigger. It arms a
 * goal for the task; goal auto-continuation then drives the agent to
 * completion without further input.
 */

/** Cordis plugin name. */
const name = "omd-ulw";
/** The goal domain is already required by tool-goal in the same preset. */
const inject = ["goals"];

/** Execute one /ulw invocation through the goal domain. */
function executeUlw(ctx, invocation) {
  const task = invocation.rawInput.trim();
  if (task.length === 0) {
    return {
      kind: "error",
      text: "Usage: /ulw <task> — arm a goal and work on it autonomously until done.",
    };
  }
  try {
    const current = ctx.goals.get(invocation.agent);
    if (current !== undefined && current.phase !== "complete") {
      return {
        kind: "error",
        text: `A goal is already ${current.phase}. Run /goal clear first, then /ulw <task>.`,
      };
    }
    ctx.goals.create(invocation.agent, { objective: task });
    return {
      kind: "success",
      text: `Ultrawork armed — working to completion.\nObjective: ${task}`,
    };
  } catch (error) {
    return {
      kind: "error",
      text: `ulw failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function apply(ctx) {
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "ulw",
      description: "ultrawork: arm a goal for a task and work on it autonomously until done",
      input: {
        hint: "<task>",
        images: false,
      },
      handler: (invocation) => executeUlw(ctx, invocation),
    });
  });
}

export { apply, inject, name };
