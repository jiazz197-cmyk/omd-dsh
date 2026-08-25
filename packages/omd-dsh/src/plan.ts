import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { scopeOf } from "@deepseek-ai/dsh-scope";

/**
 * @module @carljia/omd-dsh/plan
 *
 * omd-plan: plan persistence for the OMD planner mode. It wraps the
 * `tools/post-execute` waterfall and intercepts a successful
 * `exit_plan_mode` approval: the approved plan text is written into the
 * workspace's plan directory (a fixed, code-level convention -- never
 * mentioned in any persona/prompt text), and the tool result content is
 * enriched with the saved file name so the planner's fixed Start Work
 * final step can hand it to the user.
 *
 * Plan directory convention (hardcoded here and in omd-start-work only):
 *   <session cwd>/.omd/plans/<slug>-<timestamp>.md
 * The slug derives from the plan's first markdown heading; a timestamp
 * suffix keeps repeated interviews from overwriting each other.
 */

/** Cordis plugin name. */
const name = "omd-plan";
/** No service injection: this row only registers a scoped event listener. */
const inject = [];

/** Plan directory segments relative to the session workspace root (cwd). */
const PLAN_DIR_SEGMENTS = [".omd", "plans"];

/** The exit tool whose approved plan we persist. */
const EXIT_PLAN_MODE = "exit_plan_mode";

/** Maximum slug length (characters). */
const SLUG_MAX = 48;

/** The plan's first markdown heading (any level), or undefined when it has none. */
function firstHeading(plan) {
  for (const line of plan.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Derive a filesystem-safe slug from the plan title. */
function slugify(title) {
  const slug = String(title)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return slug === "" ? "plan" : slug;
}

/** Compact local-ish UTC timestamp for the file name: YYYYMMDD-HHmmss. */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/** Write the plan into <cwd>/.omd/plans/ and return the absolute file path. */
async function savePlan(cwd, plan) {
  const dir = join(cwd, ...PLAN_DIR_SEGMENTS);
  await mkdir(dir, { recursive: true });
  const file = join(dir, slugify(firstHeading(plan) ?? "") + "-" + timestamp() + ".md");
  await writeFile(file, plan, "utf8");
  return file;
}

/** Display path used in result enrichment and messages (forward slashes). */
function displayPath(saved) {
  return PLAN_DIR_SEGMENTS.join("/") + "/" + basename(saved);
}

/** Subagents never own the plan review -- only the top-level planner does. */
function isSubagent(agent) {
  return (
    agent !== undefined &&
    agent !== null &&
    agent.options !== undefined &&
    agent.options !== null &&
    typeof agent.options.subagentDepth === "number" &&
    agent.options.subagentDepth > 0
  );
}

function apply(ctx) {
  if (scopeOf(ctx) === undefined) {
    throw new Error(
      "omd-plan: refusing to mount outside a scoped context; mount this row inside an agent preset"
    );
  }
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== "accept" || decision.value !== undefined) return decision;
    if (exec === undefined || exec.name !== EXIT_PLAN_MODE) return decision;
    if (result.isError) return decision;
    const agent = exec.agent;
    if (agent === undefined || isSubagent(agent)) return decision;
    const args = exec.arguments;
    const plan = args !== undefined && args !== null && typeof args.plan === "string" ? args.plan : undefined;
    if (plan === undefined) return decision;
    const cwd =
      agent.session !== undefined &&
      agent.session.header !== undefined &&
      typeof agent.session.header.cwd === "string"
        ? agent.session.header.cwd
        : "";
    if (cwd === "") {
      // No workspace root to save into: fail closed but tell the model, so
      // the planner does not promise a file name it never produced.
      return withNotice(decision, result, {
        type: "text",
        text: "The approved plan could NOT be saved automatically: this session has no workspace directory. Ask the user how to proceed.",
      });
    }
    try {
      const saved = await savePlan(cwd, plan);
      return withNotice(decision, result, {
        type: "text",
        text:
          "Plan saved to " +
          displayPath(saved) +
          ". Start work: run /start-work " +
          basename(saved) +
          " in an omd-executor session, or switch this session with /mode omd-executor and continue here.",
      });
    } catch (error) {
      return withNotice(decision, result, {
        type: "text",
        text:
          "The approved plan could NOT be saved automatically: " +
          (error instanceof Error ? error.message : String(error)) +
          ". Ask the user how to proceed.",
      });
    }
  });
}

/** Keep the accepted decision, appending one text block to its content. */
function withNotice(decision, result, block) {
  const base = Array.isArray(decision.content) ? decision.content : result.content ?? [];
  return {
    kind: "accept",
    content: [...base, block],
    ...(decision.additionalContexts !== undefined
      ? { additionalContexts: decision.additionalContexts }
      : {}),
  };
}

export { apply, inject, name };
