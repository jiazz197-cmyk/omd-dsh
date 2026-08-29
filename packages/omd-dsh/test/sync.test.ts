import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MATRIX_PATH is evaluated at module load (join(dshHome(), ...)), so every
// DSH_HOME-dependent test re-imports lib/sync.js with a fresh module scope
// AFTER pointing DSH_HOME at a throwaway temp home — the real user matrix at
// ~/.dsh must never be touched by tests.
type SyncModule = typeof import("../lib/sync.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "omd-sync-test-"));
}

async function loadSync(home: string): Promise<SyncModule> {
  process.env.DSH_HOME = home;
  vi.resetModules();
  return await import("../lib/sync.js");
}

afterEach(() => {
  delete process.env.DSH_HOME;
  vi.resetModules();
});

describe("matrix helpers", () => {
  it("loads the shipped default matrix with all 7 modes", async () => {
    const sync = await loadSync(tempHome());
    const matrix = sync.readDefaultMatrix();
    expect(matrix.version).toBe(1);
    for (const mode of ["executor", "ultraworker", "planner", "reviewer", "explorer", "librarian", "chat"]) {
      expect(matrix.modes[mode]).toBeDefined();
    }
    expect(matrix.modes.executor.tiers.fast.model).toBeDefined();
  });

  it("matrixEquals is structural (stringify equality) and order-sensitive", async () => {
    const sync = await loadSync(tempHome());
    const a = sync.readDefaultMatrix();
    const b = sync.readDefaultMatrix();
    expect(sync.matrixEquals(a, b)).toBe(true);
    const changed = { ...a, modes: { ...a.modes, chat: { provider: "x", model: "y" } } };
    expect(sync.matrixEquals(a, changed)).toBe(false);
  });

  it("readMatrixFileIfExists returns undefined for a missing file and never generates one", async () => {
    const home = tempHome();
    const sync = await loadSync(home);
    expect(sync.readMatrixFileIfExists()).toBeUndefined();
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("readMatrixFileIfExists returns undefined for a malformed file", async () => {
    const home = tempHome();
    const sync = await loadSync(home);
    await fs.writeFile(join(home, "omd-matrix.json"), "not json {", "utf8");
    expect(sync.readMatrixFileIfExists()).toBeUndefined();
  });

  it("readMatrixFileIfExists parses a valid user file", async () => {
    const home = tempHome();
    const sync = await loadSync(home);
    const matrix = sync.readDefaultMatrix();
    matrix.modes.chat = { provider: "custom", model: "custom-model" };
    await fs.writeFile(join(home, "omd-matrix.json"), JSON.stringify(matrix), "utf8");
    const parsed = sync.readMatrixFileIfExists();
    expect(parsed).toBeDefined();
    expect(parsed!.modes.chat.model).toBe("custom-model");
  });

  it("saveMatrix writes the mirror file under DSH_HOME", async () => {
    const home = tempHome();
    const sync = await loadSync(home);
    const matrix = sync.readDefaultMatrix();
    matrix.modes.reviewer = { provider: "p", model: "m" };
    sync.saveMatrix(matrix);
    expect(sync.MATRIX_PATH).toBe(join(home, "omd-matrix.json"));
    const written = JSON.parse(await fs.readFile(sync.MATRIX_PATH, "utf8"));
    expect(written.modes.reviewer.model).toBe("m");
  });
});

describe("runSyncWithMatrix", () => {
  it("renders presets from the INJECTED matrix (custom provider/model into the fences)", async () => {
    const home = tempHome();
    const sync = await loadSync(home);
    const matrix = sync.readDefaultMatrix();
    matrix.modes.executor.provider = "custom-provider";
    matrix.modes.executor.model = "custom-model";
    matrix.modes.executor.tiers.fast.model = "custom-tier-model";
    const lines: string[] = [];
    await sync.runSyncWithMatrix(matrix, { dryRun: false, verbose: false }, (msg) => lines.push(msg));

    const executorYml = await fs.readFile(join(home, ".agent-presets", "omd-executor", "agent.cordis.yml"), "utf8");
    expect(executorYml).toContain("provider: custom-provider");
    expect(executorYml).toContain("model: custom-model");
    expect(executorYml).toContain("model: custom-tier-model");
    // fence regions were rewritten; preset metadata untouched
    expect(executorYml).toContain("# [omd-dsh:mode:start]");
    expect(executorYml).toContain("# [omd-dsh:task:end]");
    // all 7 presets materialised
    for (const preset of ["omd-executor", "omd-ultraworker", "omd-planner", "omd-reviewer", "omd-explorer", "omd-librarian", "omd-chat"]) {
      expect(await fs.readFile(join(home, ".agent-presets", preset, "preset.yml"), "utf8")).toBeTruthy();
    }
    // runSyncWithMatrix never writes the matrix file itself (the caller owns the mirror)
    expect(await fs.readFile(join(home, "omd-matrix.json"), "utf8").then(() => true).catch(() => false)).toBe(false);
    expect(lines.some((l) => l.includes("[synced]"))).toBe(true);
  });

  it("is idempotent with the same injected matrix", async () => {
    const home = tempHome();
    const sync = await loadSync(home);
    const matrix = sync.readDefaultMatrix();
    await sync.runSyncWithMatrix(matrix, { dryRun: false, verbose: false }, () => {});
    const out: string[] = [];
    await sync.runSyncWithMatrix(matrix, { dryRun: false, verbose: false }, (msg) => out.push(msg));
    expect(out.join("\n")).toContain("(up to date)");
  });
});
