import { describe, it, expect, beforeEach } from "vitest";
import z from "@deepseek-ai/schemastery";
import { Config, apply, name, inject } from "../src/index";
import { modeOverrideFor } from "../src/shared";

interface Listener { cb: (payload: any, ctx: any, next: () => Promise<any>) => Promise<any>; opts: any }

/** Header event factory: { provider, model } -> request/header event data. */
function headerEvent(seq: number, provider: string, model: string) {
  return { type: "request/header", seq, data: { header: { config: { provider, model } }, reason: "initial" } };
}
function switchEvent(seq: number) {
  return { type: "agent-preset/selected", seq, data: { agentPreset: "omd-chat" } };
}

/** A fake agent carrying a session whose requestHeader folds request/header events. */
function fakeAgent(events: any[] = [], options: any = {}) {
  const log = [...events];
  const session = {
    events: log,
    requestHeader() {
      let header;
      for (const event of log) if (event.type === "request/header") header = event.data.header;
      return header;
    },
  };
  return { agent: { options, session }, log };
}

function fakeCtx(scope: any = { key: "preset-test" }, opts: any = {}) {
  const listeners: Record<string, Listener[]> = {};
  const ctx: any = {
    __scope__: scope,
    on(event: string, cb: any, listenerOpts?: any) {
      (listeners[event] ??= []).push({ cb, opts: listenerOpts });
      return () => {};
    },
    get(name: string) {
      if (opts.defaultModel === undefined) throw new Error("no service: " + name);
      if (name === "agentDefaultModel") {
        return { currentSelection: () => ({ provider: opts.defaultModel.provider, model: opts.defaultModel.model }) };
      }
      throw new Error("no service: " + name);
    },
  };
  return { ctx, listeners };
}

/** Simulate cordis waterfall: listeners run outermost-first; each receives next(). */
async function simulate(listeners: Listener[], payload: any, inner: (payload: any) => Promise<any>, arity = 1) {
  const cbs = [...listeners];
  const args: any[] = arity === 1 ? [payload] : [payload, {}];
  const next: any = () => {
    const hook = cbs.shift();
    const fn = hook !== undefined ? hook.cb : inner;
    return fn(...args);
  };
  args.push(next);
  return next();
}

const validConfig = { mode: "planner", provider: "deepseek-official", model: "deepseek-v4-pro" };
const ENTRY_PICK = { provider: "deepseek-official", model: "deepseek-v4-flash" };

describe("omd-mode Config schema", () => {
  it("accepts a valid config and fills defaults", () => {
    const [out] = z.resolve(validConfig, Config) as any;
    expect(out.mode).toBe("planner");
    expect(out.provider).toBe("deepseek-official");
  });
  it("rejects a config missing mode", () => {
    expect(() => z.resolve({ provider: "x", model: "y" }, Config)).toThrow();
  });
  it("accepts provider/model absent (passthrough mode)", () => {
    const [out] = z.resolve({ mode: "chat" }, Config) as any;
    expect(out.provider).toBeUndefined();
  });
});

describe("omd-mode apply", () => {
  it("rejects mounting outside a scoped context", () => {
    const { ctx } = fakeCtx();
    ctx.__scope__ = undefined;
    expect(() => apply(ctx, validConfig as any)).toThrow(/scoped context/);
  });

  it("registers both waterfall listeners with prepend", () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    expect(Object.keys(listeners).sort()).toEqual(["agent/request", "system-prompt/assemble"]);
    for (const list of Object.values(listeners)) {
      expect(list.length).toBe(1);
      expect(list[0].opts).toEqual({ prepend: true });
    }
  });

  it("mounts without recording any override", () => {
    const { ctx } = fakeCtx();
    apply(ctx, validConfig as any);
    expect(modeOverrideFor({ key: "probe" } as any)).toBeUndefined();
  });

  it("snapshots the deployment default for the blank-session decision", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent();
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-flash" }));
    expect(result.model).toBe("deepseek-v4-pro");
  });
});

describe("omd-mode assemble", () => {
  it("injects the matrix model when the entry selection matches it", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const assembleListener = listeners["system-prompt/assemble"][0];
    const context = { agent: fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro")]).agent };
    const assembly = { variables: { provider: "deepseek-official", model: "deepseek-v4-pro", cwd: "/x" } };
    const result = await assembleListener.cb(assembly, context, async () => assembly);
    expect(result.variables.provider).toBe("deepseek-official");
    expect(result.variables.model).toBe("deepseek-v4-pro");
    expect(result.variables.cwd).toBe("/x");
  });

  it("claims the matrix model when the entry provides no selection", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const assembleListener = listeners["system-prompt/assemble"][0];
    const assembly = { variables: { cwd: "/x" } };
    const result = await assembleListener.cb(assembly, {}, async () => assembly);
    expect(result.variables.provider).toBe("deepseek-official");
    expect(result.variables.model).toBe("deepseek-v4-pro");
  });

  it("yields to the entry selection when the user picked a different model (persona shows the pick)", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const assembleListener = listeners["system-prompt/assemble"][0];
    const context = { agent: fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro")]).agent };
    const assembly = { variables: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
    const result = await assembleListener.cb(assembly, context, async () => assembly);
    expect(result.variables.model).toBe("deepseek-v4-flash");
  });

  it("injects the matrix model on a blank session whose entry selection is the deployment default", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, validConfig as any);
    const assembleListener = listeners["system-prompt/assemble"][0];
    const assembly = { variables: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
    const result = await assembleListener.cb(assembly, {}, async () => assembly);
    expect(result.variables.model).toBe("deepseek-v4-pro");
  });

  it("passes through in assemble for subagents (variables stay agent-owned)", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const assembleListener = listeners["system-prompt/assemble"][0];
    const context = { agent: { options: { subagentDepth: 1 }, session: { requestHeader: () => undefined } } };
    const result = await assembleListener.cb({ variables: { model: "tier-model" } }, context, async () => ({ variables: { model: "tier-model" } }));
    expect(result.variables.model).toBe("tier-model");
  });
});

describe("omd-mode request routing", () => {
  it("pins the matrix model when the entry selection matches it, stripping inherited effort", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro")]);
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high", maxTokens: 128 }));
    expect(result).toEqual({ provider: "deepseek-official", model: "deepseek-v4-pro", maxTokens: 128 });
    expect(modeOverrideFor(agent)).toBeUndefined();
  });

  it("keeps a configured reasoningEffort when pinning", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { ...validConfig, reasoningEffort: "max" } as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro")]);
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "low" }));
    expect(result.reasoningEffort).toBe("max");
  });

  it("yields to the user's pick on a session that already ran (routing follows the UI switch)", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro")]);
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "low" }));
    expect(result).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "low" });
    expect(modeOverrideFor(agent)).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
  });

  it("pins the matrix model on a blank session whose entry selection is the deployment default", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent();
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-flash" }));
    expect(result.model).toBe("deepseek-v4-pro");
    expect(modeOverrideFor(agent)).toBeUndefined();
  });

  it("yields to a pre-first-request pick on a blank session (differs from the default)", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent();
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "Qwen/Qwen3.8-27B-FP8" }));
    expect(result.model).toBe("Qwen/Qwen3.8-27B-FP8");
    expect(modeOverrideFor(agent)).toEqual({ provider: "deepseek-official", model: "Qwen/Qwen3.8-27B-FP8" });
  });

  it("claims the matrix model after a /mode switch while the session still resolves the pre-switch route", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, { mode: "chat", provider: "deepseek-official", model: "deepseek-v4-flash" } as any);
    const requestListener = listeners["agent/request"][0];
    // executor ran deepseek-v4-pro, then /mode switched to omd-chat (flash).
    const { agent } = fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro"), switchEvent(1)]);
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-pro" }));
    expect(result.model).toBe("deepseek-v4-flash");
    expect(modeOverrideFor(agent)).toBeUndefined();
  });

  it("yields to a user pick made after a /mode switch", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, { mode: "chat", provider: "deepseek-official", model: "deepseek-v4-flash" } as any);
    const requestListener = listeners["agent/request"][0];
    const { agent } = fakeAgent([headerEvent(0, "deepseek-official", "deepseek-v4-pro"), switchEvent(1)]);
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "Qwen/Qwen3.8-27B-FP8" }));
    expect(result.model).toBe("Qwen/Qwen3.8-27B-FP8");
    expect(modeOverrideFor(agent)).toEqual({ provider: "deepseek-official", model: "Qwen/Qwen3.8-27B-FP8" });
  });

  it("does not treat a stale switch as fresh (resume: the switch precedes the last request)", async () => {
    const { ctx, listeners } = fakeCtx({}, { defaultModel: ENTRY_PICK });
    apply(ctx, { mode: "chat", provider: "deepseek-official", model: "deepseek-v4-flash" } as any);
    const requestListener = listeners["agent/request"][0];
    // switched to chat, then a request ran (flash), then resumed; the user's pick Qwen is in the log.
    const { agent } = fakeAgent([
      headerEvent(0, "deepseek-official", "deepseek-v4-pro"),
      switchEvent(1),
      headerEvent(2, "deepseek-official", "deepseek-v4-flash"),
    ]);
    const result = await requestListener.cb({ agent }, async () => ({ provider: "deepseek-official", model: "deepseek-v4-flash" }));
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("passes through for subagents so omd-task tier models win", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const payload = { agent: { options: { subagentDepth: 1, provider: "deepseek-official", model: "tier-model" } }, turn: 1, step: 1, signal: undefined };
    const result = await requestListener.cb(payload, async () => ({ provider: "deepseek-official", model: "tier-model", maxTokens: 64 }));
    expect(result.provider).toBe("deepseek-official");
    expect(result.model).toBe("tier-model");
  });

  it("passes everything through when provider/model are not configured", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { mode: "chat" } as any);
    const composed = [...listeners["agent/request"], { cb: async (p: any, next: any) => (await next()), opts: {} }];
    const result = await simulate(composed, {}, async () => ({ provider: "session-provider", model: "session-model", reasoningEffort: "high" }));
    expect(result.provider).toBe("session-provider");
    expect(result.model).toBe("session-model");
    expect(result.reasoningEffort).toBe("high");
    expect(modeOverrideFor({ key: "probe" } as any)).toBeUndefined();
  });
});

describe("omd-mode exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-mode");
    expect(inject).toEqual([]);
  });
});
