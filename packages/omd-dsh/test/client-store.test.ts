import { describe, it, expect } from "vitest";
import { OmdMatrixController, OMD_SETTINGS_NS } from "../lib/omd-matrix-controller.js";
import type { OmdSettingsApi, OmdScope, OmdScopeSnapshot } from "../lib/omd-matrix-controller.js";
import { readDefaultMatrix } from "../lib/sync.js";
import type { Matrix } from "../lib/sync.js";

/** Fake wire + scope faces; records every replace request. */
function makeFakes(initial: Matrix | undefined, writable = true) {
  const replaces: { ns: string; section: object; expectedRevision?: number }[] = [];
  let snapshot: OmdScopeSnapshot = {
    status: initial === undefined ? "loading" : "ready",
    value: initial,
    revision: 3,
    writable,
    mode: "host",
  };
  const listeners = new Set<() => void>();
  const api: OmdSettingsApi = {
    settings: {
      replace: async (request) => {
        replaces.push(request);
        if ((request.section as { modes?: Record<string, unknown> })?.modes?.REJECT !== undefined) {
          return { result: { ok: false, error: { message: "settings-rejected: namespace changed (expected 3, now 4)" } } };
        }
        return { result: { ok: true, value: { ns: OMD_SETTINGS_NS } } };
      },
    },
  };
  const scope: OmdScope = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  let loads = 0;
  const describe = {
    load: async () => { loads += 1; },
  };
  return {
    api, scope, describe,
    replaces,
    get loads() { return loads; },
    pushScope(next: Partial<OmdScopeSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("OmdMatrixController", () => {
  it("seeds the draft from the scope value and exposes canSave", () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    expect(controller.draft).not.toBeNull();
    expect(controller.draft!.modes.executor).toBeDefined();
    expect(controller.canSave).toBe(true);
    controller.dispose();
  });

  it("canSave is false when the namespace is not writable", () => {
    const fakes = makeFakes(readDefaultMatrix(), false);
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    expect(controller.writable).toBe(false);
    expect(controller.canSave).toBe(false);
    controller.dispose();
  });

  it("patchMode edits the draft; empty string removes the override", () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    controller.patchMode("chat", "model", "my-model");
    expect(controller.draft!.modes.chat.model).toBe("my-model");
    expect(controller.draft!.modes.chat.provider).toBeDefined();
    controller.patchMode("chat", "model", "");
    expect(controller.draft!.modes.chat.model).toBeUndefined();
    controller.dispose();
  });

  it("patchTier edits one tier without touching the others", () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    const beforeDeep = controller.draft!.modes.executor.tiers.deep.model;
    controller.patchTier("executor", "fast", "model", "tier-model");
    expect(controller.draft!.modes.executor.tiers.fast.model).toBe("tier-model");
    expect(controller.draft!.modes.executor.tiers.deep.model).toBe(beforeDeep);
    controller.dispose();
  });

  it("save replaces with the COMPLETE matrix and the current expectedRevision", async () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    controller.patchMode("reviewer", "model", "review-model");
    await controller.save();
    expect(fakes.replaces).toHaveLength(1);
    const request = fakes.replaces[0];
    expect(request.ns).toBe(OMD_SETTINGS_NS);
    expect(request.expectedRevision).toBe(3);
    const section = request.section as Matrix;
    expect(section.modes.reviewer.model).toBe("review-model");
    expect(section.modes.executor.tiers.fast.model).toBeDefined(); // full matrix, not a patch
    expect(controller.saved).toBe(true);
    expect(controller.error).toBeNull();
    controller.dispose();
  });

  it("a rejected save surfaces the error message and reloads the describe mirror", async () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    // plant a special section marker the fake rejects
    (controller as any).draft = { ...controller.draft!, modes: { REJECT: {} } } as Matrix;
    await controller.save();
    expect(controller.error).toContain("settings-rejected");
    expect(fakes.loads).toBeGreaterThanOrEqual(1);
    expect(controller.status).toBe("idle");
    controller.dispose();
  });

  it("a transport failure is folded into the error message", async () => {
    const fakes = makeFakes(readDefaultMatrix());
    const api: OmdSettingsApi = {
      settings: {
        replace: async () => { throw new Error("connection lost"); },
      },
    };
    const controller = new OmdMatrixController(api, fakes.scope, fakes.describe);
    await controller.save();
    expect(controller.error).toBe("connection lost");
    controller.dispose();
  });

  it("reset replaces with an EMPTY section (restore composition defaults)", async () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    await controller.reset();
    expect(fakes.replaces).toHaveLength(1);
    expect(fakes.replaces[0].section).toEqual({});
    expect(fakes.replaces[0].expectedRevision).toBe(3);
    controller.dispose();
  });

  it("rebuilds the draft when the scope value changes externally (conflict reload)", async () => {
    const fakes = makeFakes(readDefaultMatrix());
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    controller.patchMode("chat", "model", "my-draft");
    const fresh = readDefaultMatrix();
    fresh.modes.chat.model = "host-value";
    fakes.pushScope({ value: fresh, revision: 4 });
    expect(controller.draft!.modes.chat.model).toBe("host-value");
    controller.dispose();
  });

  it("omits expectedRevision while the scope has not seen a revision yet", async () => {
    const fakes = makeFakes(readDefaultMatrix());
    fakes.pushScope({ revision: undefined });
    const controller = new OmdMatrixController(fakes.api, fakes.scope, fakes.describe);
    await controller.save();
    expect(fakes.replaces[0]).not.toHaveProperty("expectedRevision");
    controller.dispose();
  });
});
