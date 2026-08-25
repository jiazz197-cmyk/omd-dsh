import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/startwork";

interface FakeGoals {
  get: (agent: any) => any;
  create: (agent: any, opts: { objective: string }) => any;
}

/** Mount the row against a fake ctx; returns the registered command definition. */
function mountStartWork(goals: FakeGoals) {
  let registered: any;
  const commandCtx = {
    commands: {
      register(def: any) {
        registered = def;
      },
    },
  };
  const ctx: any = {
    __scope__: {},
    inject(_keys: string[], cb: any) {
      cb(commandCtx);
    },
    goals,
  };
  apply(ctx);
  return { ctx, command: () => registered };
}

const agent = (cwd: string | undefined) => ({
  id: "agent-1",
  session: { header: { cwd } },
});

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "omd-startwork-test-"));
  mkdirSync(join(tmp, ".omd", "plans"), { recursive: true });
  writeFileSync(join(tmp, ".omd", "plans", "demo.md"), "# Demo plan\n\nDo the thing.", "utf8");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const run = async (command: any, rawInput: string, cwd = tmp) =>
  command().handler({ rawInput, agent: agent(cwd) });

describe("omd-start-work exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-start-work");
    expect(inject).toEqual(["goals"]);
  });
});

describe("omd-start-work apply", () => {
  it("registers a /start-work command", () => {
    const { command } = mountStartWork({ get: () => undefined, create: () => ({ phase: "active" }) });
    const def = command();
    expect(def).toBeDefined();
    expect(def.name).toBe("start-work");
    expect(def.description).toContain("plan");
  });

  it("errors on empty input", async () => {
    const { command } = mountStartWork({ get: () => undefined, create: () => ({}) });
    const result = await run(command, "   ");
    expect(result.kind).toBe("error");
    expect(result.text).toContain("Usage");
  });

  it("errors when the plan file is missing", async () => {
    const { command } = mountStartWork({ get: () => undefined, create: () => ({}) });
    const result = await run(command, "nope.md");
    expect(result.kind).toBe("error");
    expect(result.text).toContain("not found");
  });

  it("arms a goal whose objective references the plan's absolute path", async () => {
    const created: any[] = [];
    const { command } = mountStartWork({
      get: () => undefined,
      create: (a: any, opts: any) => {
        created.push({ agent: a, opts });
        return { phase: "active" };
      },
    });
    const result = await run(command, "demo.md");
    expect(result.kind).toBe("success");
    expect(result.text).toContain("demo.md");
    expect(created).toHaveLength(1);
    expect(created[0].agent.id).toBe("agent-1");
    expect(created[0].opts.objective).toContain(join(tmp, ".omd", "plans", "demo.md"));
    expect(created[0].opts.objective).toContain("Execute");
  });

  it("accepts a bare name without extension and the full relative path", async () => {
    let created = 0;
    const { command } = mountStartWork({
      get: () => undefined,
      create: () => {
        created += 1;
        return { phase: "active" };
      },
    });
    expect((await run(command, "demo")).kind).toBe("success");
    expect((await run(command, ".omd/plans/demo.md")).kind).toBe("success");
    expect(created).toBe(2);
  });

  it("rejects traversal and absolute paths", async () => {
    const { command } = mountStartWork({
      get: () => undefined,
      create: () => {
        throw new Error("should not be called");
      },
    });
    for (const bad of ["../x.md", "a/b.md", "/etc/passwd", "..", ".hidden.md"]) {
      const result = await run(command, bad);
      expect(result.kind).toBe("error");
    }
  });

  it("refuses to replace an unfinished goal", async () => {
    const { command } = mountStartWork({
      get: () => ({ phase: "active" }),
      create: () => {
        throw new Error("should not be called");
      },
    });
    const result = await run(command, "demo.md");
    expect(result.kind).toBe("error");
    expect(result.text).toContain("already active");
  });

  it("replaces a completed goal", async () => {
    let created = 0;
    const { command } = mountStartWork({
      get: () => ({ phase: "complete" }),
      create: () => {
        created += 1;
        return { phase: "active" };
      },
    });
    expect((await run(command, "demo.md")).kind).toBe("success");
    expect(created).toBe(1);
  });

  it("errors when the session has no workspace root", async () => {
    const { command } = mountStartWork({ get: () => undefined, create: () => ({}) });
    const result = await command().handler({ rawInput: "demo.md", agent: agent(undefined) });
    expect(result.kind).toBe("error");
    expect(result.text).toContain("workspace directory");
  });

  it("returns an error when goal creation throws", async () => {
    const { command } = mountStartWork({
      get: () => undefined,
      create: () => {
        throw new Error("boom");
      },
    });
    const result = await run(command, "demo.md");
    expect(result.kind).toBe("error");
    expect(result.text).toContain("boom");
  });
});
