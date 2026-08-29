import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * @module @carljia/omd-dsh/startwork
 *
 * omd-start-work: human-facing `/start-work` command -- the "start work"
 * trigger at the end of the OMD planning workflow. It resolves the named
 * plan file inside the workspace's plan directory (a fixed, code-level
 * convention -- never mentioned in any persona/prompt text), arms a goal
 * whose objective references the plan's absolute path, and goal
 * auto-continuation then drives the agent to execute the plan without
 * further input.
 */

/** Cordis plugin name. */
const name = "omd-start-work";
/** The goal domain is already required by tool-goal in the same preset. */
const inject = ["goals"];

/** Plan directory segments relative to the session workspace root (cwd). */
const PLAN_DIR_SEGMENTS = [".omd", "plans"];
/** The prefix accepted when a user pastes the full relative plan path. */
const PLAN_DIR_PREFIX = ".omd/plans/";

/** Plan directory for one workspace root. */
function plansDir(cwd) {
  return join(cwd, ...PLAN_DIR_SEGMENTS);
}

/**
 * Resolve the user's file-name input to a candidate path inside the plan
 * directory. Accepts a bare file name ("foo.md" / "foo") or the full
 * relative path (".omd/plans/foo.md"); rejects absolute paths and anything
 * that would escape the plan directory.
 */
function resolveCandidate(cwd, input) {
  const trimmed = String(input).trim().replace(/\\/g, "/");
  if (trimmed === "" || isAbsolute(trimmed)) return undefined;
  let name = trimmed.replace(/^\.\//, "");
  if (name.includes("/")) {
    if (!name.startsWith(PLAN_DIR_PREFIX)) return undefined;
    name = name.slice(PLAN_DIR_PREFIX.length);
  }
  if (name === "" || name.includes("/") || name === "." || name === "..") return undefined;
  if (name.startsWith(".")) return undefined; // no hidden-file tricks
  return join(plansDir(cwd), name);
}

/** One /start-work invocation through the goal domain. */
async function executeStartWork(ctx, invocation) {
  const agent = invocation.agent;
  const cwd =
    agent !== undefined &&
    agent.session !== undefined &&
    agent.session.header !== undefined &&
    typeof agent.session.header.cwd === "string"
      ? agent.session.header.cwd
      : "";
  if (cwd === "") {
    return {
      kind: "error",
      text: "This session has no workspace directory; /start-work needs one to find the plan file.",
    };
  }
  const candidate = resolveCandidate(cwd, invocation.rawInput);
  if (candidate === undefined) {
    return {
      kind: "error",
      text: "Usage: /start-work <plan file name> — the file must live inside " + PLAN_DIR_SEGMENTS.join("/") + "/.",
    };
  }
  let file = candidate;
  const usable = async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await usable(file)) && !file.endsWith(".md") && (await usable(file + ".md"))) {
    file = file + ".md";
  } else if (!(await usable(file))) {
    return {
      kind: "error",
      text: "Plan file not found: " + PLAN_DIR_SEGMENTS.join("/") + "/" + file.slice(plansDir(cwd).length + 1),
    };
  }
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      kind: "error",
      text: "Cannot read the plan file: " + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (text.trim() === "") {
    return { kind: "error", text: "The plan file is empty." };
  }
  try {
    const current = ctx.goals.get(agent);
    if (current !== undefined && current.phase !== "complete") {
      return {
        kind: "error",
        text: `A goal is already ${current.phase}. Run /goal clear first, then /start-work <plan file name>.`,
      };
    }
    ctx.goals.create(agent, {
      objective:
        "Execute the approved plan file at " +
        file +
        ". Read the file in full, then carry out every step autonomously: implement, verify, and iterate until the plan's goal and success criteria are met. Work through goal continuation rounds until done.",
    });
    return {
      kind: "success",
      text:
        "Start work armed — executing the plan to completion.\nPlan: " +
        PLAN_DIR_SEGMENTS.join("/") +
        "/" +
        file.slice(plansDir(cwd).length + 1),
    };
  } catch (error) {
    return {
      kind: "error",
      text: "start-work failed: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}

function apply(ctx) {
  // 无 scope 守卫：见 src/index.ts 的说明（自包含 bundle 无法读取 harness 的 kScope）。
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "start-work",
      description: "start work: arm a goal that executes the named plan file to completion",
      input: {
        hint: "<plan file name>",
        images: false,
      },
      handler: (invocation) => executeStartWork(ctx, invocation),
    });
  });
}

export { apply, inject, name };
