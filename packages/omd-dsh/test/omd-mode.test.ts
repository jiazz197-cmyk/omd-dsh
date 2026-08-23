import { describe, it, expect, beforeEach } from "vitest";
import z from "@deepseek-ai/schemastery";
import { Config, apply, name, inject } from "../src/index";

interface Listener { cb: (payload: any, ctx: any, next: () => Promise<any>) => Promise<any>; opts: any }

function fakeCtx(scope: any = { key: "preset-test" }) {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    ctx: {
      __scope__: scope,
      on(event: string, cb: any, opts?: any) {
        (listeners[event] ??= []).push({ cb, opts });
        return () => {};
      },
    },
  };
}

/** Simulate cordis waterfall: listeners run outermost-first; each receives next(). */
async function simulate(listeners: Listener[], payload: any, inner: (payload: any) => Promise<any>, arity = 1) {
  const cbs = [...listeners];
  // 真实事件声明参数个数：agent/request = 1 (payload)；system-prompt/assemble = 2 (assembly, context)
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

  it("overrides prompt variables even when a later (entry) listener sets them", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const entryAssemble = async (assembly: any, _c: any, next: any) => {
      const a = await next();
      return { ...a, variables: { ...a.variables, provider: "session-provider", model: "session-model" } };
    };
    const composed = [...listeners["system-prompt/assemble"], { cb: entryAssemble, opts: {} }];
    const result = await simulate(composed, { variables: { cwd: "/x" } }, async (a) => a, 2);
    expect(result.variables.provider).toBe("deepseek-official");
    expect(result.variables.model).toBe("deepseek-v4-pro");
    expect(result.variables.cwd).toBe("/x");
  });

  it("overrides provider/model on agent/request and clears inherited reasoningEffort", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const entryRequest = async (payload: any, next: any) => {
      const r = await next();
      return { ...r, provider: "session-provider", model: "session-model", reasoningEffort: "high" };
    };
    const composed = [...listeners["agent/request"], { cb: entryRequest, opts: {} }];
    const result = await simulate(composed, {}, async () => ({ maxTokens: 128 }));
    expect(result.provider).toBe("deepseek-official");
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.reasoningEffort).toBeUndefined();
    expect(result.maxTokens).toBe(128);
  });

  it("keeps a configured reasoningEffort", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { ...validConfig, reasoningEffort: "max" } as any);
    const composed = [...listeners["agent/request"], { cb: async (p: any, next: any) => (await next()), opts: {} }];
    const result = await simulate(composed, {}, async () => ({ provider: "p", model: "m", reasoningEffort: "low" }));
    expect(result.reasoningEffort).toBe("max");
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

  it("passes through in assemble for subagents (variables stay agent-owned)", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const assembleListener = listeners["system-prompt/assemble"][0];
    const context = { agent: { options: { subagentDepth: 1 } } };
    const result = await assembleListener.cb({ variables: { model: "tier-model" } }, context, async () => ({ variables: { model: "tier-model" } }));
    expect(result.variables.model).toBe("tier-model");
  });

  it("still overrides for top-level agents (subagentDepth absent)", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, validConfig as any);
    const requestListener = listeners["agent/request"][0];
    const payload = { agent: { options: {} }, turn: 1, step: 1, signal: undefined };
    const result = await requestListener.cb(payload, async () => ({ provider: "entry", model: "entry-model" }));
    expect(result.model).toBe("deepseek-v4-pro");
  });

  it("passes everything through when provider/model are not configured", async () => {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { mode: "chat" } as any);
    const composed = [...listeners["agent/request"], { cb: async (p: any, next: any) => (await next()), opts: {} }];
    const result = await simulate(composed, {}, async () => ({ provider: "session-provider", model: "session-model", reasoningEffort: "high" }));
    expect(result.provider).toBe("session-provider");
    expect(result.model).toBe("session-model");
    expect(result.reasoningEffort).toBe("high");
  });
});

describe("omd-mode exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-mode");
    expect(inject).toEqual([]);
  });
});
