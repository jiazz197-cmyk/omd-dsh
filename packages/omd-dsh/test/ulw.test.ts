import { describe, it, expect } from "vitest";
import { apply, name, inject } from "../src/ulw";

interface FakeGoals {
  get: (agent: any) => any;
  create: (agent: any, opts: { objective: string }) => any;
}

/** Mount the row against a fake ctx; returns the registered command definition. */
function mountUlw(goals: FakeGoals) {
  let registered: any;
  const commandCtx = {
    commands: {
      register(def: any) {
        registered = def;
      },
    },
  };
  const ctx: any = {
    inject(_keys: string[], cb: any) {
      cb(commandCtx);
    },
    goals,
  };
  apply(ctx);
  return { ctx, command: () => registered };
}

const agent = { id: "agent-1" };

describe("omd-ulw exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-ulw");
    expect(inject).toEqual(["goals"]);
  });
});

describe("omd-ulw apply", () => {
  it("registers a /ulw command", () => {
    const { command } = mountUlw({ get: () => undefined, create: () => ({ phase: "active" }) });
    const def = command();
    expect(def).toBeDefined();
    expect(def.name).toBe("ulw");
    expect(def.description).toContain("ultrawork");
  });

  it("errors on empty input", () => {
    const { command } = mountUlw({ get: () => undefined, create: () => ({}) });
    const result = command().handler({ rawInput: "   ", agent });
    expect(result.kind).toBe("error");
    expect(result.text).toContain("Usage");
  });

  it("arms a goal and reports success for a task", () => {
    const created: any[] = [];
    const { command } = mountUlw({
      get: () => undefined,
      create: (a: any, opts: any) => {
        created.push({ agent: a, opts });
        return { phase: "active" };
      },
    });
    const result = command().handler({ rawInput: "build the thing", agent });
    expect(result.kind).toBe("success");
    expect(result.text).toContain("build the thing");
    expect(created).toHaveLength(1);
    expect(created[0].agent).toBe(agent);
    expect(created[0].opts.objective).toBe("build the thing");
  });

  it("refuses to replace an unfinished goal", () => {
    const { command } = mountUlw({
      get: () => ({ phase: "active" }),
      create: () => {
        throw new Error("should not be called");
      },
    });
    const result = command().handler({ rawInput: "another task", agent });
    expect(result.kind).toBe("error");
    expect(result.text).toContain("already active");
  });

  it("replaces a completed goal", () => {
    let created = 0;
    const { command } = mountUlw({
      get: () => ({ phase: "complete" }),
      create: () => {
        created += 1;
        return { phase: "active" };
      },
    });
    const result = command().handler({ rawInput: "fresh task", agent });
    expect(result.kind).toBe("success");
    expect(created).toBe(1);
  });

  it("returns an error when goal creation throws", () => {
    const { command } = mountUlw({
      get: () => undefined,
      create: () => {
        throw new Error("boom");
      },
    });
    const result = command().handler({ rawInput: "task", agent });
    expect(result.kind).toBe("error");
    expect(result.text).toContain("boom");
  });
});
