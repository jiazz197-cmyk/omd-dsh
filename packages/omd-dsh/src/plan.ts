import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { scopeOf } from "@deepseek-ai/dsh-scope";

/**
 * @module @carljia/omd-dsh/plan
 *
 * omd-plan: plan persistence + plan-mode activation + write scope for the OMD
 * planner mode. Three jobs, all scoped to the planner preset:
 *   1. auto-activate plan mode for the top-level agent, so the plan:policy
 *      section renders and exit_plan_mode works (DSH leaves plan state
 *      inactive until /plan or a programmatic set);
 *   2. enforce a .md-only write guard so the planner stays read-only except
 *      for markdown files;
 *   3. wrap `tools/post-execute` and intercept a successful `exit_plan_mode`
 *      approval: the approved plan text is written into the workspace's plan
 *      directory (a fixed, code-level convention -- never mentioned in any
 *      persona/prompt text), and the tool result content is enriched with the
 *      saved file name so the planner's fixed Start Work final step can hand
 *      it to the user.
 *
 * Plan directory convention (hardcoded here and in omd-start-work only):
 *   <session cwd>/.omd/plans/<slug>-<timestamp>.md
 * The slug derives from the plan's first markdown heading; a timestamp
 * suffix keeps repeated interviews from overwriting each other.
 */

/** Cordis plugin name. */
const name = "omd-plan";
/** No service injection: this row only registers scoped event listeners. */
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

/** Fold the session's plan/mode events (last one wins); mirror mode.ts. */
function planModeActive(events) {
  let active = false;
  for (const event of events ?? []) {
    if (event !== undefined && event.type === "plan/mode") {
      active = event.data !== undefined && event.data !== null && event.data.active === true;
    }
  }
  return active;
}

function apply(ctx) {
  if (scopeOf(ctx) === undefined) {
    throw new Error(
      "omd-plan: refusing to mount outside a scoped context; mount this row inside an agent preset"
    );
  }

  // Scoped .md-only write guard: the planner may write/edit only markdown
  // files, keeping it read-only for every other path. The plan file itself is
  // written by this row via node:fs (not through the model's write/edit tools),
  // so plan persistence is unaffected by the guard. Implemented on the
  // tools/pre-execute gate (the row's existing ctx.on style) so no service
  // injection is required.
  ctx.on("tools/pre-execute", async (exec, next) => {
    const toolName = exec !== undefined && exec !== null ? exec.name : undefined;
    if (toolName !== "write" && toolName !== "edit") return await next();
    const filePath =
      exec.arguments !== undefined &&
      exec.arguments !== null &&
      typeof exec.arguments.file_path === "string"
        ? exec.arguments.file_path
        : undefined;
    if (filePath !== undefined && filePath.toLowerCase().endsWith(".md")) return await next();
    return {
      kind: "deny",
      reason:
        "omd-plan: the planner preset may write or edit only .md files (refusing " +
        toolName +
        " on a non-.md path)",
    };
  });

  // Auto-activate plan mode for the top-level planner agent. DSH leaves plan
  // state inactive until /plan or a programmatic set, so without this the
  // plan:policy section never renders and exit_plan_mode fails with "only
  // available in plan mode". Mirror mode.ts's direct log append (no narration)
  // so the planner session is in plan mode from its first request onward.
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    if (agent !== undefined && agent !== null && !isSubagent(agent) && agent.session !== undefined && agent.session !== null) {
      if (!planModeActive(agent.session.events)) {
        agent.session.append("plan/mode", { active: true });
      }
    }
    return await next();
  });

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
