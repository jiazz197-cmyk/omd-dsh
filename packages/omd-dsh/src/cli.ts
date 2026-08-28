#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  runSync, resolveHarness, loadMatrix, saveMatrix, dshHome, MATRIX_PATH,
  type SyncFlags, type Matrix,
} from "./sync.js";

/**
 * omd-dsh CLI
 *
 *   omd-dsh sync    materialize presets into <DSH_HOME>/.agent-presets,
 *                   rendering each preset's omd-mode / omd-task rows from the
 *                   user's model matrix at <DSH_HOME>/omd-matrix.json.
 *   omd-dsh setup   interactive wizard: discover DSH models, then guide
 *                   per-mode and per-tier model selection.
 *   omd-dsh models  print the discovered model catalog (non-interactive).
 *
 * The sync core lives in ./sync.js and is also invoked automatically by the
 * bundle boot row (lib/boot.js), so `dsh plugin add @carljia/omd-dsh` + restart
 * installs the presets without this CLI.
 */

function usage() {
  return [
    "omd-dsh <command> [options]",
    "  commands:",
    "    sync     materialize presets into <DSH_HOME>/.agent-presets (renders omd-mode/omd-task from omd-matrix.json)",
    "    setup    interactive: discover DSH models, then guide per-mode/tier model selection",
    "    models   print the discovered DSH model catalog",
    "  options:",
    "    --harness <path>  node_modules dir of the DSH harness install (saved locally after first use; otherwise auto-detected)",
    "    --dry-run         (sync) print planned writes without touching the filesystem",
    "    --verbose         (sync) print per-file detail",
  ].join("\n");
}

// ── model discovery ──
function discoverModels(): { models: { provider: string; model: string }[]; currentDefault?: { provider: string; model: string } } {
  const models: { provider: string; model: string }[] = [];
  const seen = new Set<string>();
  const add = (provider: string, model: string) => { if (model && !seen.has(provider + "/" + model)) { seen.add(provider + "/" + model); models.push({ provider, model }); } };

  // DSH official DeepSeek defaults (dsh-llm-deepseek)
  add("deepseek-official", "deepseek-v4-flash");
  add("deepseek-official", "deepseek-v4-pro");
  add("deepseek-official", "deepseek-v4-flash-vision-exp");

  // best-effort: scan settings.yaml for additional model ids
  const settingsPath = join(dshHome(), "settings.yaml");
  let currentDefault: { provider: string; model: string } | undefined;
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, "utf8");
    const blocklist = new Set(["spawn", "fork", "continuable", "foreground", "deepseek-official", "openai-completions", "anthropic-messages", "enabled", "disabled", "high", "low", "max"]);
    for (const m of text.matchAll(/(?<![-A-Za-z0-9])model:\s*['"]?([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) {
      const id = m[1];
      if (!blocklist.has(id) && /[0-9]/.test(id)) add("deepseek-official", id);
    }
    for (const m of text.matchAll(/^\s*-\s+id:\s*['"]?([A-Za-z0-9][A-Za-z0-9._/-]*)/gm)) {
      const id = m[1];
      if (!blocklist.has(id) && /[0-9]/.test(id)) add("deepseek-official", id);
    }
    const dm = text.match(/agent-default-model:\s*\n\s*provider:\s*['"]?([A-Za-z0-9._/-]+)['"]?\s*\n\s*model:\s*['"]?([A-Za-z0-9._/-]+)['"]?/);
    if (dm) currentDefault = { provider: dm[1], model: dm[2] };
  }
  return { models, currentDefault };
}

// ── setup (interactive) ──
function splitModel(answer: string): { provider: string; model: string } {
  const a = answer.trim();
  if (a.includes("/")) { const i = a.indexOf("/"); return { provider: a.slice(0, i).trim(), model: a.slice(i + 1).trim() }; }
  return { provider: "deepseek-official", model: a };
}

async function runSetup(flags: SyncFlags, harnessNodeModules: string | undefined) {
  const matrix = loadMatrix(flags);
  const { models, currentDefault } = discoverModels();
  console.log("omd-dsh setup: 发现 DSH 已有模型：");
  for (const m of models) console.log("  - " + m.provider + "/" + m.model);
  if (currentDefault) console.log("omd-dsh setup: 当前全局默认 = " + currentDefault.provider + "/" + currentDefault.model);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string) => (await rl.question(question)).trim();

  const modeOrder = ["executor", "ultraworker", "planner", "reviewer", "explorer", "librarian", "chat"];
  for (const modeId of modeOrder) {
    const cfg = matrix.modes[modeId] ?? {};
    const cur = cfg.provider && cfg.model ? cfg.provider + "/" + cfg.model : "";
    const ans = await ask("模式 " + modeId + " 顶层模型" + (cur ? " [" + cur + "]" : "") + " (回车保留，格式 provider/model): ");
    if (ans !== "") { const r = splitModel(ans); cfg.provider = r.provider; cfg.model = r.model; }
    if (cfg.tiers && Object.keys(cfg.tiers).length > 0) {
      for (const [tierName, tier] of Object.entries(cfg.tiers)) {
        const tcur = tier.provider + "/" + tier.model;
        const tans = await ask("  " + modeId + " tier \"" + tierName + "\" 模型 [" + tcur + "] (回车保留): ");
        if (tans !== "") { const r = splitModel(tans); tier.provider = r.provider; tier.model = r.model; }
      }
    }
    matrix.modes[modeId] = cfg;
  }

  saveMatrix(matrix);
  console.log("omd-dsh setup: 已写入 " + MATRIX_PATH);
  const syncNow = await ask("是否立即同步到 " + join(dshHome(), ".agent-presets") + "? [Y/n] ");
  rl.close();
  if (syncNow === "" || /^y/i.test(syncNow)) {
    if (harnessNodeModules === undefined) {
      console.error("omd-dsh setup: 无法定位 DSH harness node_modules，跳过同步。首次请运行 `omd-dsh sync --harness <路径>`（之后会自动缓存，无需重复指定）。");
    } else {
      await runSync(flags, harnessNodeModules);
    }
  } else {
    console.log("omd-dsh setup: 已跳过同步；稍后运行 `omd-dsh sync` 生效。");
  }
}

// ── main ──
async function main() {
  const argv = process.argv.slice(2);
  const flags: SyncFlags = { dryRun: false, verbose: false };
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--harness") flags.harness = argv[++i];
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--help" || arg === "-h") { console.log(usage()); return; }
    else if (arg === "sync" || arg === "setup" || arg === "models") command = arg;
    else { console.error("unknown argument: " + arg + "\n\n" + usage()); process.exitCode = 2; return; }
  }
  if (command === "") { console.error("missing command\n\n" + usage()); process.exitCode = 2; return; }

  if (command === "models") {
    const { models, currentDefault } = discoverModels();
    console.log("omd-dsh models: DSH_HOME=" + dshHome());
    if (currentDefault) console.log("omd-dsh models: 当前全局默认 = " + currentDefault.provider + "/" + currentDefault.model);
    for (const m of models) console.log("  " + m.provider + "/" + m.model);
    return;
  }

  if (command === "setup") {
    await runSetup(flags, resolveHarness(flags));
    return;
  }

  const harnessNodeModules = resolveHarness(flags);
  if (harnessNodeModules === undefined || !existsSync(join(harnessNodeModules, "@deepseek-ai", "dsh-scope", "package.json"))) {
    console.error("omd-dsh sync: cannot locate the DSH harness node_modules.\n  - ensure the dsh executable is on PATH, or\n  - pass --harness <path to the harness node_modules directory> (saved for later runs).\n\n" + usage());
    process.exitCode = 2;
    return;
  }
  await runSync(flags, harnessNodeModules);
}

main().catch((error) => {
  console.error("omd-dsh failed: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
