import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/plan";

/** Mount the row against a fake ctx; returns the registered post-execute listener. */
function mountPlan() {
  let listener: any;
  const ctx: any = {
    __scope__: {},
    on(event: string, cb: any) {
      if (event === "tools/post-execute") listener = cb;
    },
  };
  apply(ctx);
  return { ctx, listener: () => listener };
}

const next = async () => ({ kind: "accept" });

function makeExec(overrides: any = {}) {
  return {
    name: "exit_plan_mode",
    arguments: { plan: "# My Plan\n\nStep one." },
    agent: { options: {}, session: { header: { cwd: undefined } } },
    ...overrides,
  };
}

const successResult = { isError: false, content: [{ type: "text", text: "Plan approved" }] };

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "omd-plan-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("omd-plan exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-plan");
    expect(inject).toEqual([]);
  });
});

describe("omd-plan post-execute", () => {
  it("passes non-exit tools through unchanged", async () => {
    const { listener } = mountPlan();
    const decision = { kind: "accept" };
    const out = await listener()(makeExec({ name: "read" }), successResult, async () => decision);
    expect(out).toBe(decision);
  });

  it("passes failed exit_plan_mode results through unchanged", async () => {
    const { listener } = mountPlan();
    const decision = { kind: "accept" };
    const out = await listener()(makeExec(), { isError: true, content: [{ type: "text", text: "nope" }] }, async () => decision);
    expect(out).toBe(decision);
  });

  it("ignores subagent executions", async () => {
    const { listener } = mountPlan();
    const decision = { kind: "accept" };
    const out = await listener()(
      makeExec({ agent: { options: { subagentDepth: 1 }, session: { header: { cwd: tmp } } } }),
      successResult,
      async () => decision
    );
    expect(out).toBe(decision);
    expect(existsSync(join(tmp, ".omd", "plans"))).toBe(false);
  });

  it("passes value-variant accept decisions through unchanged", async () => {
    const { listener } = mountPlan();
    const decision = { kind: "accept", value: { approved: true } };
    const out = await listener()(makeExec({ agent: { options: {}, session: { header: { cwd: tmp } } } }), successResult, async () => decision);
    expect(out).toBe(decision);
  });

  it("saves the approved plan into <cwd>/.omd/plans and enriches the result", async () => {
    const { listener } = mountPlan();
    const plan = "# My Plan\n\nStep one.";
    const out = await listener()(
      makeExec({ arguments: { plan }, agent: { options: {}, session: { header: { cwd: tmp } } } }),
      successResult,
      next
    );
    expect(out.kind).toBe("accept");
    expect(Array.isArray(out.content)).toBe(true);
    const text = out.content.map((b: any) => b.text ?? "").join("");
    expect(text).toContain(".omd/plans/");
    expect(text).toContain("/start-work");

    const dir = join(tmp, ".omd", "plans");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^my-plan-\d{8}-\d{6}\.md$/);
    expect(readFileSync(join(dir, files[0]), "utf8")).toBe(plan);
  });

  it("preserves the upstream content and additionalContexts when enriching", async () => {
    const { listener } = mountPlan();
    const decision = {
      kind: "accept",
      content: [{ type: "text", text: "upstream text" }],
      additionalContexts: [{ marker: true }],
    };
    const out = await listener()(
      makeExec({ agent: { options: {}, session: { header: { cwd: tmp } } } }),
      successResult,
      async () => decision
    );
    expect(out.content[0].text).toBe("upstream text");
    expect(out.additionalContexts).toEqual([{ marker: true }]);
  });

  it("warns instead of silently failing when the session has no workspace root", async () => {
    const { listener } = mountPlan();
    const out = await listener()(makeExec(), successResult, next);
    const text = out.content.map((b: any) => b.text ?? "").join("");
    expect(text).toContain("could NOT be saved");
    expect(text).not.toContain("/start-work");
  });

  it("warns when the write fails", async () => {
    const { listener } = mountPlan();
    const blocked = join(tmp, "blocked");
    mkdirSync(blocked);
    writeFileSync(join(blocked, ".omd"), "a file, not a directory");
    const out = await listener()(
      makeExec({ agent: { options: {}, session: { header: { cwd: blocked } } } }),
      successResult,
      next
    );
    const text = out.content.map((b: any) => b.text ?? "").join("");
    expect(text).toContain("could NOT be saved");
  });
});
