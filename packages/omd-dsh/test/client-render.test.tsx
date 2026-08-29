import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { OmdModelAllocationSection } from "../src/client.tsx";
import { OmdMatrixController, OMD_SETTINGS_NS } from "../src/omd-matrix-controller.js";
import type { OmdScope, OmdScopeSnapshot, OmdSettingsApi } from "../src/omd-matrix-controller.js";
import { readDefaultMatrix } from "../lib/sync.js";
import type { Matrix } from "../lib/sync.js";

/** Controllable fake of the settings scope. */
function fakeScope(snapshot: OmdScopeSnapshot): { scope: OmdScope; set(s: OmdScopeSnapshot): void } {
  let current = snapshot;
  const listeners = new Set<() => void>();
  return {
    scope: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    set: (next) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const noopApi: OmdSettingsApi = {
  settings: {
    replace: async () => ({ result: { ok: true, value: { ns: OMD_SETTINGS_NS } } }),
  },
};
const noopDescribe = { load: async () => undefined };

const t = (key: string) => key;

describe("OmdModelAllocationSection rendering (regression: blank page)", () => {
  it("renders the full editable form when the scope is ready", () => {
    const matrix = readDefaultMatrix();
    const { scope } = fakeScope({
      status: "ready",
      value: matrix,
      revision: 1,
      writable: true,
      mode: "host",
    });
    const controller = new OmdMatrixController(noopApi, scope, noopDescribe);
    const html = renderToStaticMarkup(
      React.createElement(OmdModelAllocationSection, { scope, controller, t }),
    );
    // 7 mode cards + both editable inputs + tier hints + save/reset controls
    expect(html).toContain("executor");
    expect(html).toContain("chat");
    expect(html).toContain('value="deepseek-v4-pro"');
    expect(html).toContain("cheap and fast");
    expect(html).toContain("save");
    expect(html).toContain("reset");
    // no loading/unavailable text
    expect(html).not.toContain("loading");
    controller.dispose();
  });

  it("renders the Qwen custom tier model from the user matrix", () => {
    const matrix = readDefaultMatrix();
    matrix.modes.executor.tiers.fast.model = "Qwen/Qwen3.8-27B-FP8";
    const { scope } = fakeScope({
      status: "ready",
      value: matrix,
      revision: 1,
      writable: true,
      mode: "host",
    });
    const controller = new OmdMatrixController(noopApi, scope, noopDescribe);
    const html = renderToStaticMarkup(
      React.createElement(OmdModelAllocationSection, { scope, controller, t }),
    );
    expect(html).toContain("Qwen/Qwen3.8-27B-FP8");
    controller.dispose();
  });

  it("renders the loading message before the scope resolves", () => {
    const { scope } = fakeScope({
      status: "loading",
      value: undefined,
      revision: undefined,
      writable: true,
      mode: "host",
    });
    const controller = new OmdMatrixController(noopApi, scope, noopDescribe);
    const html = renderToStaticMarkup(
      React.createElement(OmdModelAllocationSection, { scope, controller, t }),
    );
    expect(html).toContain("loading");
    controller.dispose();
  });

  it("renders the availability message for remote (memory-mode) browsers", () => {
    const { scope } = fakeScope({
      status: "unavailable",
      value: undefined,
      revision: undefined,
      writable: false,
      mode: "memory",
    });
    const controller = new OmdMatrixController(noopApi, scope, noopDescribe);
    const html = renderToStaticMarkup(
      React.createElement(OmdModelAllocationSection, { scope, controller, t }),
    );
    expect(html).toContain("unavailable");
    controller.dispose();
  });

  it("disables inputs and omits save/reset when the namespace is read-only", () => {
    const { scope } = fakeScope({
      status: "ready",
      value: readDefaultMatrix(),
      revision: 1,
      writable: false,
      mode: "host",
    });
    const controller = new OmdMatrixController(noopApi, scope, noopDescribe);
    const html = renderToStaticMarkup(
      React.createElement(OmdModelAllocationSection, { scope, controller, t }),
    );
    expect(html).toContain('disabled=""');
    expect(html).not.toContain(">save<");
    expect(html).not.toContain(">reset<");
    controller.dispose();
  });
});

describe("uSES contract of the controller", () => {
  it("getSnapshot returns the SAME reference between changes (no 'getSnapshot should be cached' crash)", () => {
    const { scope } = fakeScope({
      status: "ready",
      value: readDefaultMatrix(),
      revision: 1,
      writable: true,
      mode: "host",
    });
    const controller = new OmdMatrixController(noopApi, scope, noopDescribe);
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
    controller.patchMode("chat", "model", "x");
    const after = controller.getSnapshot();
    expect(after).toBe(controller.getSnapshot());
    expect(after.draft!.modes.chat.model).toBe("x");
    controller.dispose();
  });
});
