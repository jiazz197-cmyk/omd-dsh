import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(pkgRoot, "lib", "cli.js");

/** Portable fake harness tree: enough package.json manifests for the import rewriter. */
const FAKE_PACKAGES = ["dsh-scope", "schemastery", "dsh-tools", "dsh-subagent", "dsh-llm"];

async function makeFakeHarness() {
  const root = mkdtempSync(join(tmpdir(), "omd-harness-"));
  for (const pkgName of FAKE_PACKAGES) {
    const dir = join(root, "node_modules", "@deepseek-ai", pkgName);
    await fs.mkdir(join(dir, "lib"), { recursive: true });
    await fs.writeFile(join(dir, "package.json"), JSON.stringify({
      name: "@deepseek-ai/" + pkgName,
      version: "0.1.1-rc.2",
      exports: { ".": { types: "./lib/types/index.d.ts", default: "./lib/index.js" } },
    }) + "\n", "utf8");
    await fs.writeFile(join(dir, "lib", "index.js"), "export {};\n", "utf8");
  }
  return join(root, "node_modules");
}

function runSync(args: string[], env: Record<string, string>) {
  return execFileSync(process.execPath, [cliPath, "sync", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: pkgRoot,
  });
}

describe("omd-dsh sync CLI", () => {
  let harness: string;
  let home: string;

  // The user matrix lives in DSH_HOME; hide any repo-root matrix so the sync
  // subprocess exercises the built-in-default generation path.
  const repoMatrix = join(pkgRoot, "omd-matrix.json");
  const repoMatrixBackup = repoMatrix + ".testbak";

  beforeAll(async () => {
    harness = await makeFakeHarness();
    try {
      await fs.rename(repoMatrix, repoMatrixBackup);
    } catch { /* no repo matrix present */ }
  });

  afterAll(async () => {
    try { await fs.rm(repoMatrix, { force: true }); } catch { /* ignore */ }
    try { await fs.rename(repoMatrixBackup, repoMatrix); } catch { /* nothing to restore */ }
  });

  const setup = async () => {
    home = mkdtempSync(join(tmpdir(), "omd-home-"));
    return home;
  };

  it("dry-run reports planned writes and touches nothing", async () => {
    const h = await setup();
    const out = runSync(["--harness", harness, "--dry-run"], { DSH_HOME: h });
    expect(out).toContain("(dry-run)");
    expect(out).toContain("[synced]");
    expect(out).toContain("omd-chat");
    expect(existsSync(join(h, ".agent-presets"))).toBe(false);
    expect(existsSync(join(h, "omd-matrix.json"))).toBe(false);
  });

  it("syncs presets and rewrites vendored imports to harness file URLs", async () => {
    const h = await setup();
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("[synced]");
    // all 7 presets materialised
    for (const preset of ["omd-executor", "omd-ultraworker", "omd-planner", "omd-reviewer", "omd-explorer", "omd-librarian", "omd-chat"]) {
      expect(existsSync(join(h, ".agent-presets", preset, "agent.cordis.yml"))).toBe(true);
      expect(existsSync(join(h, ".agent-presets", preset, "preset.yml"))).toBe(true);
      expect(existsSync(join(h, ".agent-presets", preset, ".omd-meta.json"))).toBe(true);
    }
    // vendored rows rewritten to file:// URLs anchored at the harness tree
    for (const vendor of ["omd-mode.mjs", "omd-task.mjs"]) {
      const text = await fs.readFile(join(h, ".agent-presets", ".omd-vendor", vendor), "utf8");
      const importLines = text.split(/\r?\n/).filter((l) => l.trimStart().startsWith("import"));
      expect(importLines.length).toBeGreaterThan(0);
      for (const line of importLines) {
        // the sibling shared.js import stays relative (resolves inside .omd-vendor)
        if (/from\s+["']\.\//.test(line)) continue;
        expect(line).toContain("file:///");
        expect(line).not.toMatch(/["']@deepseek-ai\//);
      }
    }
    // the shared per-agent state module ships next to the rows
    expect(existsSync(join(h, ".agent-presets", ".omd-vendor", "shared.js"))).toBe(true);
    // preset rows reference the vendored files relatively
    const chatYml = await fs.readFile(join(h, ".agent-presets", "omd-chat", "agent.cordis.yml"), "utf8");
    expect(chatYml).toContain("../.omd-vendor/omd-mode.mjs");
  });

  it("is idempotent on a second run", async () => {
    const h = await setup();
    runSync(["--harness", harness], { DSH_HOME: h });
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("(up to date)");
    expect(out).not.toContain("[conflicts]");
  });

  it("never overwrites locally modified files (conflict protection)", async () => {
    const h = await setup();
    runSync(["--harness", harness], { DSH_HOME: h });
    const target = join(h, ".agent-presets", "omd-chat", "agent.cordis.yml");
    await fs.writeFile(target, "# my local edit\n", "utf8");
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("[conflicts]");
    expect(await fs.readFile(target, "utf8")).toBe("# my local edit\n");
    // unmodified sibling files still update
    const chatYml = await fs.readFile(join(h, ".agent-presets", "omd-chat", "preset.yml"), "utf8");
    expect(chatYml).toContain("OMD · 对话");
  });

  it("leaves non-managed directories alone and reports orphans", async () => {
    const h = await setup();
    const customDir = join(h, ".agent-presets", "my-custom-preset");
    await fs.mkdir(customDir, { recursive: true });
    await fs.writeFile(join(customDir, "agent.cordis.yml"), "custom", "utf8");
    const orphanDir = join(h, ".agent-presets", "omd-legacy");
    await fs.mkdir(orphanDir, { recursive: true });
    await fs.writeFile(join(orphanDir, ".omd-meta.json"), JSON.stringify({ source: "omd-dsh", sourceVersion: "0.0.1", files: {} }), "utf8");
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(await fs.readFile(join(customDir, "agent.cordis.yml"), "utf8")).toBe("custom");
    expect(out).toContain("[orphan] omd-legacy");
  });

  const sha256hex = (text: string) => createHash("sha256").update(text).digest("hex");

  /** Plant a fake omd-dsh-managed omd-architect dir whose meta hashes match its files. */
  async function plantOldArchitect(h: string) {
    const oldDir = join(h, ".agent-presets", "omd-architect");
    await fs.mkdir(oldDir, { recursive: true });
    const composition = "# old composition\n";
    const metaText = "name: OMD · 架构构建\n";
    await fs.writeFile(join(oldDir, "agent.cordis.yml"), composition, "utf8");
    await fs.writeFile(join(oldDir, "preset.yml"), metaText, "utf8");
    await fs.writeFile(join(oldDir, ".omd-meta.json"), JSON.stringify({
      source: "omd-dsh",
      sourceVersion: "0.1.2",
      files: {
        "agent.cordis.yml": { sha256: sha256hex(composition) },
        "preset.yml": { sha256: sha256hex(metaText) },
      },
    }), "utf8");
    return oldDir;
  }

  it("removes an unmodified preset that was renamed (rename migration)", async () => {
    const h = await setup();
    runSync(["--harness", harness], { DSH_HOME: h });
    const oldDir = await plantOldArchitect(h);
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("[removed] omd-architect");
    expect(out).toContain("renamed to omd-ultraworker");
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(h, ".agent-presets", "omd-ultraworker", "agent.cordis.yml"))).toBe(true);
  });

  it("keeps a renamed preset the user modified locally", async () => {
    const h = await setup();
    runSync(["--harness", harness], { DSH_HOME: h });
    const oldDir = await plantOldArchitect(h);
    await fs.writeFile(join(oldDir, "agent.cordis.yml"), "# user edit\n", "utf8");
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("[conflicts] omd-architect");
    expect(out).toContain("keeping your version");
    expect(existsSync(oldDir)).toBe(true);
    expect(await fs.readFile(join(oldDir, "agent.cordis.yml"), "utf8")).toBe("# user edit\n");
  });

  it("generates a default matrix in DSH_HOME on first sync", async () => {
    const h = await setup();
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("generated");
    expect(out).toContain("omd-matrix.json");
    expect(out).toContain("omd-dsh setup");
    const matrixPath = join(h, "omd-matrix.json");
    expect(existsSync(matrixPath)).toBe(true);
    const matrix = JSON.parse(await fs.readFile(matrixPath, "utf8"));
    expect(matrix.modes.ultraworker).toBeDefined();
    expect(matrix.modes.executor.tiers.fast.model).toBe("deepseek-v4-flash");
  });

  it("migrates a legacy package-root matrix into DSH_HOME on first sync", async () => {
    const h = await setup();
    const sentinel = {
      version: 1,
      defaults: { provider: "deepseek-official" },
      modes: {
        executor: { provider: "deepseek-official", model: "sentinel-model" },
        ultraworker: {}, planner: {}, reviewer: {}, explorer: {}, librarian: {}, chat: {},
      },
    };
    await fs.writeFile(repoMatrix, JSON.stringify(sentinel, null, 2) + "\n", "utf8");
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("migrated");
    const matrix = JSON.parse(await fs.readFile(join(h, "omd-matrix.json"), "utf8"));
    expect(matrix.modes.executor.model).toBe("sentinel-model");
    await fs.rm(repoMatrix, { force: true });
  });

  it("fails with guidance when the harness cannot be located", async () => {
    const h = await setup();
    try {
      runSync(["--harness", join(h, "does-not-exist")], { DSH_HOME: h });
      expect.unreachable("should have failed");
    } catch (error: any) {
      const text = String(error.stderr ?? error.stdout ?? error.message);
      expect(text).toContain("--harness");
    }
  });
});
