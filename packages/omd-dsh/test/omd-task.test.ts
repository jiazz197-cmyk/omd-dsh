import { describe, it, expect, beforeEach } from "vitest";
import z from "@deepseek-ai/schemastery";
import { Config, apply, name, inject } from "../src/task";
import { setModeOverride } from "../src/shared";
import { definedTools, resetDefinedTools } from "./stubs/dsh-tools";
import { depthAssertions, resetDepthAssertions } from "./stubs/dsh-subagent";

const fastDeepTiers = {
  fast: { provider: "deepseek-official", model: "deepseek-v4-flash", hint: "cheap", persona: "FAST worker" },
  deep: { provider: "deepseek-official", model: "deepseek-v4-pro", hint: "strong", persona: "DEEP worker" },
};

interface SubagentFake {
  startCalls: any[];
  continuableCalls: any[];
  start: (name: string, request: any) => Promise<any>;
  startContinuable: (spec: any) => Promise<any>;
}

function fakeCtx(tiers: any, extra: any = {}) {
  const subagents: SubagentFake = {
    startCalls: [],
    continuableCalls: [],
    start: async (name, request) => {
      subagents.startCalls.push({ name, request });
      return {
        id: "run-1",
        result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "done" }] }),
        dispose: async () => {},
      };
    },
    startContinuable: async (spec) => {
      subagents.continuableCalls.push(spec);
      return { childId: "child-1" };
    },
  };
  const sections: any[] = [];
  const provider = { name: "spawn", capabilities: { depthLimit: true }, prepareContinuable: async () => {} };
  return {
    subagents,
    sections,
    ctx: {
      __scope__: { key: "preset-test" },
      tools: {
        register: (def: any) => { return () => {}; },
        get: () => ({}),
      },
      subagents: {
        getProvider: () => provider,
        start: subagents.start,
        startContinuable: subagents.startContinuable,
      },
      systemPrompt: { section: (s: any) => { sections.push(s); } },
      logger: { info: () => {} },
      on: () => () => {},
    },
  };
}

function resolved(raw: any) {
  const [out] = z.resolve(raw, Config) as any;
  return out;
}

function mount(tiers: any, extra: any = {}) {
  const { ctx, subagents, sections } = fakeCtx(tiers, extra);
  apply(ctx, resolved({ provider: "spawn", toolName: "omd_task", backgroundMode: "continuable", tiers, ...extra }));
  const tool = definedTools[definedTools.length - 1];
  return { ctx, tool, subagents, sections };
}

beforeEach(() => {
  resetDefinedTools();
  resetDepthAssertions();
});

describe("omd-task Config schema", () => {
  it("accepts valid tiers with defaults", () => {
    const [out] = z.resolve({ tiers: fastDeepTiers }, Config) as any;
    expect(out.provider).toBe("spawn");
    expect(out.toolName).toBe("omd_task");
    expect(out.backgroundMode).toBe("continuable");
    expect(out.maxDepth).toBe(3);
  });
  it("rejects a tier without a model", () => {
    expect(() => z.resolve({ tiers: { fast: { provider: "x" } } }, Config)).toThrow();
  });
});

describe("omd-task apply validation", () => {
  it("rejects an empty tiers map", () => {
    const { ctx } = fakeCtx({});
    expect(() => apply(ctx, { tiers: {} } as any)).toThrow(/at least one tier/);
  });
  it("rejects an invalid tier name", () => {
    const { ctx } = fakeCtx({ "Bad Name": { provider: "p", model: "m" } });
    expect(() => apply(ctx, { tiers: { "Bad Name": { provider: "p", model: "m" } } } as any)).toThrow(/invalid tier name/);
  });
  it("rejects a defaultTier that is not a tier", () => {
    const { ctx } = fakeCtx(fastDeepTiers);
    expect(() => apply(ctx, { tiers: fastDeepTiers, defaultTier: "nope" } as any)).toThrow(/defaultTier/);
  });
  it("rejects an empty toolFilter", () => {
    const { ctx } = fakeCtx({ fast: { provider: "p", model: "m", toolFilter: {} } });
    expect(() => apply(ctx, { tiers: { fast: { provider: "p", model: "m", toolFilter: {} } } } as any)).toThrow(/toolFilter/);
  });
  it("asserts maxDepth when numeric", () => {
    const { ctx } = fakeCtx(fastDeepTiers);
    apply(ctx, { tiers: fastDeepTiers, maxDepth: 2 } as any);
    expect(depthAssertions).toEqual([2]);
  });
});

describe("omd-task tool definition", () => {
  it("registers the tool with tier enumeration in the description", () => {
    const { tool } = mount(fastDeepTiers);
    expect(tool.name).toBe("omd_task");
    expect(tool.description).toContain("fast");
    expect(tool.description).toContain("deep");
    expect(tool.description).toContain("deepseek-v4-flash");
    expect(tool.description).toContain("deepseek-v4-pro");
  });

  it("exposes tier and run_in_background parameters in continuable mode", () => {
    const { tool } = mount(fastDeepTiers);
    expect(tool.parameters.description.required).toBe(true);
    expect(tool.parameters.prompt.required).toBe(true);
    expect(tool.parameters.tier.type).toBe("string");
    expect(tool.parameters.run_in_background.type).toBe("boolean");
  });

  it("hides run_in_background in foreground mode", () => {
    const { tool } = mount(fastDeepTiers, { backgroundMode: "foreground" });
    expect(tool.parameters.run_in_background).toBeUndefined();
  });

  it("adds a system-prompt section in continuable mode", () => {
    const { sections } = mount(fastDeepTiers);
    expect(sections.length).toBe(1);
    expect(sections[0].name).toBe("tool:omd_task");
  });
});

describe("omd-task execute", () => {
  it("routes a foreground call through the selected tier (agentOptions/persona/toolFilter)", async () => {
    const { tool, subagents } = mount(fastDeepTiers);
    const result = await tool.execute({ description: "scout auth", prompt: "find auth code", tier: "fast", run_in_background: false }, { agent: { id: "parent-1" }, signal: undefined });
    expect(result.kind).toBe("foreground");
    expect(result.output).toEqual([{ type: "text", text: "done" }]);
    const { name, request } = subagents.startCalls[0];
    expect(name).toBe("spawn");
    expect(request.label).toBe("scout auth");
    expect(request.parent.id).toBe("parent-1");
    expect(request.agentOptions).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
    expect(request.persona).toBe("FAST worker");
    expect(request.maxDepth).toBe(3);
  });

  it("defaults to the continuable route and returns a durable subagent id", async () => {
    const { tool, subagents } = mount(fastDeepTiers);
    const result = await tool.execute({ description: "deep think", prompt: "design X", tier: "deep" }, { agent: { id: "parent-1" }, signal: undefined });
    expect(result).toEqual({ kind: "continuable", subagentId: "child-1" });
    expect(subagents.startCalls.length).toBe(0);
    const spec = subagents.continuableCalls[0];
    expect(spec.provider).toBe("spawn");
    expect(spec.request.agentOptions.model).toBe("deepseek-v4-pro");
    expect(spec.request.persona).toBe("DEEP worker");
  });

  it("routes the deep tier to the user's model when omd-mode recorded an override", async () => {
    const { tool, subagents } = mount(fastDeepTiers);
    const agent = { id: "parent-1" };
    setModeOverride(agent, { provider: "deepseek-official", model: "deepseek-v4-flash" });
    await tool.execute({ description: "deep think", prompt: "design X", tier: "deep", run_in_background: false }, { agent, signal: undefined });
    const { request } = subagents.startCalls[0];
    expect(request.agentOptions).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
    expect(request.persona).toBe("DEEP worker");
  });

  it("leaves non-deep tiers on their matrix model when an override is recorded", async () => {
    const { tool, subagents } = mount(fastDeepTiers);
    const agent = { id: "parent-1" };
    setModeOverride(agent, { provider: "deepseek-official", model: "deepseek-v4-pro" });
    await tool.execute({ description: "scout", prompt: "find x", tier: "fast", run_in_background: false }, { agent, signal: undefined });
    expect(subagents.startCalls[0].request.agentOptions).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
  });

  it("applies the override when the deep tier is the defaultTier", async () => {
    const { tool, subagents } = mount(fastDeepTiers, { defaultTier: "deep" });
    const agent = { id: "p" };
    setModeOverride(agent, { provider: "other-provider", model: "user-model" });
    await tool.execute({ description: "deep", prompt: "x", run_in_background: false }, { agent, signal: undefined });
    expect(subagents.startCalls[0].request.agentOptions).toEqual({ provider: "other-provider", model: "user-model" });
  });

  it("keeps the configured deep model when no override is recorded", async () => {
    const { tool, subagents } = mount(fastDeepTiers);
    await tool.execute({ description: "deep think", prompt: "design X", tier: "deep", run_in_background: false }, { agent: { id: "parent-1" }, signal: undefined });
    expect(subagents.startCalls[0].request.agentOptions).toEqual({ provider: "deepseek-official", model: "deepseek-v4-pro" });
  });

  it("falls back to defaultTier when tier is omitted", async () => {
    const { tool, subagents } = mount(fastDeepTiers, { defaultTier: "deep" });
    await tool.execute({ description: "x", prompt: "y", run_in_background: false }, { agent: { id: "p" }, signal: undefined });
    expect(subagents.startCalls[0].request.agentOptions.model).toBe("deepseek-v4-pro");
  });

  it("auto-picks the only tier", async () => {
    const { tool, subagents } = mount({ solo: { provider: "p", model: "m" } });
    await tool.execute({ description: "x", prompt: "y", run_in_background: false }, { agent: { id: "p" }, signal: undefined });
    expect(subagents.startCalls[0].request.agentOptions.model).toBe("m");
  });

  it("errors with the valid tier list when tier is missing and ambiguous", async () => {
    const { tool } = mount(fastDeepTiers);
    await expect(tool.execute({ description: "x", prompt: "y", run_in_background: false }, { agent: { id: "p" }, signal: undefined })).rejects.toThrow(/fast, deep/);
  });

  it("errors on an unknown tier", async () => {
    const { tool } = mount(fastDeepTiers);
    await expect(tool.execute({ description: "x", prompt: "y", tier: "nope", run_in_background: false }, { agent: { id: "p" }, signal: undefined })).rejects.toThrow(/unknown tier/);
  });

  it("errors with a helpful message when there is no calling agent", async () => {
    const { tool } = mount(fastDeepTiers);
    await expect(tool.execute({ description: "x", prompt: "y", tier: "fast" }, { agent: undefined, signal: undefined })).rejects.toThrow(/calling agent/);
  });
});

describe("omd-task exports", () => {
  it("exports the cordis row contract", () => {
    expect(name).toBe("omd-task");
    expect(inject).toEqual(["tools", "subagents", "systemPrompt"]);
  });
});
