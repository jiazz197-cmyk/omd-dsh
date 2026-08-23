import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  beforeAll(async () => {
    harness = await makeFakeHarness();
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
  });

  it("syncs presets and rewrites vendored imports to harness file URLs", async () => {
    const h = await setup();
    const out = runSync(["--harness", harness], { DSH_HOME: h });
    expect(out).toContain("[synced]");
    // all 7 presets materialised
    for (const preset of ["omd-executor", "omd-architect", "omd-planner", "omd-reviewer", "omd-explorer", "omd-librarian", "omd-chat"]) {
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
        expect(line).toContain("file:///");
        expect(line).not.toMatch(/["']@deepseek-ai\//);
      }
    }
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
