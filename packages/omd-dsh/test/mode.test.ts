import { describe, it, expect } from "vitest";
import { apply, name, inject } from "../src/mode";

interface FakePresets {
  composedPreset: (agentCtx: any) => string | undefined;
  recompose: (agentCtx: any, id: string) => Promise<{ id: string }>;
}

/** Mount the row against a fake ctx; returns the registered command definition. */
function mountMode(presets: FakePresets | undefined) {
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
    get(_name: string) {
      return presets;
    },
  };
  apply(ctx);
  return { ctx, command: () => registered };
}

/** An agent recording session appends and steered messages. */
function makeAgent(events: any[] = []) {
  const appends: { type: string; data: any }[] = [];
  const steered: any[] = [];
  const agent: any = {
    id: "agent-1",
    ctx: { __ctx__: true },
    session: {
      events,
      append(type: string, data: any) {
        appends.push({ type, data });
      },
    },
    steer(message: any) {
      steered.push(message);
    },
  };
  return { agent, appends, steered };
}

const run = (command: any, rawInput: string, agent: any) => command().handler({ rawInput, agent });

describe("omd-mode-switch exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-mode-switch");
    expect(inject).toEqual([]);
  });
});

describe("omd-mode-switch apply", () => {
  it("registers a /mode command", () => {
    const { command } = mountMode({ composedPreset: () => undefined, recompose: async (_c, id) => ({ id }) });
    const def = command();
    expect(def).toBeDefined();
    expect(def.name).toBe("mode");
  });

  it("errors on empty or unknown targets and lists the valid presets", async () => {
    const { command } = mountMode({ composedPreset: () => undefined, recompose: async (_c, id) => ({ id }) });
    const { agent } = makeAgent();
    for (const bad of ["", "nope", "omd-unknown"]) {
      const result = await run(command, bad, agent);
      expect(result.kind).toBe("error");
      expect(result.text).toContain("omd-executor");
    }
  });

  it("recomposes the session, logs the selection, steers a notice, and reports success", async () => {
    const calls: any[] = [];
    const { command } = mountMode({
      composedPreset: () => undefined,
      recompose: async (agentCtx, id) => {
        calls.push({ agentCtx, id });
        return { id };
      },
    });
    const { agent, appends, steered } = makeAgent();
    const result = await run(command, "omd-executor", agent);
    expect(result.kind).toBe("success");
    expect(result.text).toContain("omd-executor");
    expect(calls).toEqual([{ agentCtx: agent.ctx, id: "omd-executor" }]);
    expect(appends).toContainEqual({ type: "agent-preset/selected", data: { agentPreset: "omd-executor" } });
    expect(steered).toHaveLength(1);
    expect(steered[0].content[0].text).toContain("omd-executor");
  });

  it("accepts a bare mode name (executor -> omd-executor)", async () => {
    const calls: any[] = [];
    const { command } = mountMode({
      composedPreset: () => undefined,
      recompose: async (_c, id) => {
        calls.push(id);
        return { id };
      },
    });
    const { agent } = makeAgent();
    expect((await run(command, "EXECUTOR", agent)).kind).toBe("success");
    expect(calls).toEqual(["omd-executor"]);
  });

  it("turns plan mode off when it is still active", async () => {
    const { command } = mountMode({ composedPreset: () => undefined, recompose: async (_c, id) => ({ id }) });
    const { agent, appends } = makeAgent([
      { type: "plan/mode", data: { active: true } },
      { type: "plan/mode", data: { active: false } },
      { type: "plan/mode", data: { active: true } },
    ]);
    await run(command, "omd-executor", agent);
    expect(appends).toContainEqual({ type: "plan/mode", data: { active: false } });
  });

  it("leaves plan mode alone when it is already inactive", async () => {
    const { command } = mountMode({ composedPreset: () => undefined, recompose: async (_c, id) => ({ id }) });
    const { agent, appends } = makeAgent([{ type: "plan/mode", data: { active: false } }]);
    await run(command, "omd-executor", agent);
    expect(appends.some((a) => a.type === "plan/mode")).toBe(false);
  });

  it("is a no-op when the session already runs the target preset", async () => {
    let recomposed = 0;
    const { command } = mountMode({
      composedPreset: () => "omd-executor",
      recompose: async () => {
        recomposed += 1;
        return { id: "omd-executor" };
      },
    });
    const { agent } = makeAgent();
    const result = await run(command, "omd-executor", agent);
    expect(result.kind).toBe("success");
    expect(result.text).toContain("Already running");
    expect(recomposed).toBe(0);
  });

  it("errors gracefully when the deployment composes no agent presets", async () => {
    const { command } = mountMode(undefined);
    const { agent } = makeAgent();
    const result = await run(command, "omd-executor", agent);
    expect(result.kind).toBe("error");
    expect(result.text).toContain("no agent presets");
  });

  it("returns an error when recompose throws", async () => {
    const { command } = mountMode({
      composedPreset: () => undefined,
      recompose: async () => {
        throw new Error("boom");
      },
    });
    const { agent } = makeAgent();
    const result = await run(command, "omd-executor", agent);
    expect(result.kind).toBe("error");
    expect(result.text).toContain("boom");
  });
});
