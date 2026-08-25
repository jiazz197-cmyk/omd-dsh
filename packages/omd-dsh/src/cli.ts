#!/usr/bin/env node
import { promises as fs, existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

/**
 * omd-dsh CLI
 *
 *   omd-dsh sync    materialize presets into <DSH_HOME>/.agent-presets,
 *                   rendering each preset's omd-mode / omd-task rows from the
 *                   user's model matrix at <DSH_HOME>/omd-matrix.json. On
 *                   first run the shipped deepseek default matrix
 *                   (omd-matrix.default.json) is copied there; personal
 *                   model settings stay on the user's machine and are never
 *                   shipped or uploaded.
 *   omd-dsh setup   interactive wizard: discover the models DSH already has,
 *                   then guide per-mode and per-tier model selection.
 *   omd-dsh models  print the discovered model catalog (non-interactive).
 *
 * Distribution model (vendored + harness-anchored imports) is unchanged from
 * the original omd-dsh sync: presets/omd-* are copied into .agent-presets/;
 * their omd-mode / omd-task / omd-plan / omd-start-work / omd-mode-switch
 * rows reference ../.omd-vendor/*.mjs by relative path; the vendored modules
 * are copied into .agent-presets/.omd-vendor/ with bare @deepseek-ai/*
 * imports rewritten to absolute file:// URLs into the harness node_modules
 * tree.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_SOURCES = ["omd-mode.mjs", "omd-task.mjs", "omd-ulw.mjs", "omd-plan.mjs", "omd-start-work.mjs", "omd-mode-switch.mjs"];
/** User-owned model matrix: lives under DSH_HOME, never inside the package or the repo. */
const MATRIX_PATH = join(dshHome(), "omd-matrix.json");
/** Pre-migration location (package root) — migrated to MATRIX_PATH once when present. */
const LEGACY_MATRIX_PATH = join(PACKAGE_ROOT, "omd-matrix.json");
const MODE_FENCE = { start: "# [omd-dsh:mode:start]", end: "# [omd-dsh:mode:end]" };
const TASK_FENCE = { start: "# [omd-dsh:task:start]", end: "# [omd-dsh:task:end]" };
/** Presets that were renamed: old directory name -> new preset name. */
const RENAMED_FROM: Record<string, string> = { "omd-architect": "omd-ultraworker" };

type Flags = { harness?: string; dryRun: boolean; verbose: boolean };
interface TierConfig { provider: string; model: string; hint?: string; persona?: string; maxTokens?: number; toolFilter?: { allow?: string[]; deny?: string[]; denyShell?: boolean } }
interface ModeConfig { provider?: string; model?: string; reasoningEffort?: string; tiers?: Record<string, TierConfig> }
interface Matrix { version: number; defaults?: { provider?: string }; modes: Record<string, ModeConfig> }

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

function sha256(text: string) { return createHash("sha256").update(text).digest("hex"); }
function dshHome() { return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== "" ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh"); }

function findNodeModules(start: string) {
  let current = resolve(start);
  for (;;) {
    if (basename(current) === "node_modules") return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
function harnessCachePath() { return join(dshHome(), "omd-dsh-harness.json"); }

/** Read the cached harness node_modules, ignoring a stale/missing entry. */
function readCachedHarness() {
  try {
    const p = harnessCachePath();
    if (!existsSync(p)) return undefined;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const nm = parsed && typeof parsed === "object" ? parsed.harnessNodeModules : undefined;
    if (typeof nm !== "string" || nm === "") return undefined;
    if (!existsSync(join(nm, "@deepseek-ai", "dsh-scope", "package.json"))) return undefined;
    return nm;
  } catch { return undefined; }
}

/** Persist the resolved harness node_modules for later runs (best-effort). */
function writeCachedHarness(harnessNodeModules: string) {
  try {
    writeFileSync(harnessCachePath(), JSON.stringify({ harnessNodeModules }, null, 2) + "\n", "utf8");
  } catch { /* best-effort */ }
}

/**
 * Resolve the DSH harness node_modules:
 *   1. --harness flag (and cache it for later);
 *   2. auto-detect via the dsh executable on PATH;
 *   3. fall back to the locally cached value.
 */
function resolveHarness(flags: Flags) {
  let nm: string | undefined;
  if (flags.harness !== undefined) {
    nm = findNodeModules(flags.harness);
    if (nm !== undefined) {
      try {
        nm = realpathSync(nm);
        writeCachedHarness(nm);
      } catch { /* keep nm as-is */ }
    }
    return nm;
  }
  nm = locateHarnessViaDsh() ?? locateHarnessViaNpxCache() ?? readCachedHarness();
  if (nm !== undefined) {
    try { nm = realpathSync(nm); } catch { /* keep */ }
  }
  return nm;
}

function locateHarnessViaDsh() {
  const candidates: string[] = [];
  try {
    const probe = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(probe, ["dsh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) { const t = line.trim(); if (t !== "") candidates.push(t); }
  } catch { /* dsh not on PATH */ }
  for (const candidate of candidates) {
    let real = candidate;
    try { real = realpathSync(candidate); } catch { /* keep */ }
    const nm = findNodeModules(real);
    if (nm !== undefined && existsSync(join(nm, "@deepseek-ai", "dsh-scope", "package.json"))) return nm;
  }
  return undefined;
}
/** Candidate npx cache roots where a non-global DSH install may live. */
function npxCacheRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) roots.push(join(localAppData, "npm-cache", "_npx"));
    const appData = process.env.APPDATA;
    if (appData) roots.push(join(appData, "npm-cache", "_npx"));
  } else {
    roots.push(join(homedir(), ".npm", "_npx"));
  }
  return roots;
}

/**
 * Best-effort scan of the npx cache for a DSH install whose node_modules
 * carries @deepseek-ai/dsh-scope. Picks the most recently touched one.
 */
function locateHarnessViaNpxCache() {
  const matches: { nm: string; mtime: number }[] = [];
  for (const root of npxCacheRoots()) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const nm = join(root, entry, "node_modules");
      if (!existsSync(join(nm, "@deepseek-ai", "dsh-scope", "package.json"))) continue;
      let mtime = 0;
      try { mtime = statSync(join(root, entry)).mtimeMs; } catch { /* keep 0 */ }
      matches.push({ nm, mtime });
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.length > 0 ? matches[0].nm : undefined;
}

function resolveHarnessModule(harnessNodeModules: string, specifier: string) {
  const segments = specifier.split("/");
  const scope = segments[0].startsWith("@") ? segments[0] + "/" + segments[1] : segments[0];
  const subpath = scope === specifier ? "" : specifier.slice(scope.length + 1);
  const pkgDir = join(harnessNodeModules, ...scope.split("/"));
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) throw new Error("omd-dsh: cannot resolve \"" + specifier + "\" -- no package.json at " + manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let entry: any;
  const exportsMap = manifest.exports;
  if (subpath === "" && exportsMap !== undefined && exportsMap["."] !== undefined) {
    const dot = exportsMap["."];
    if (typeof dot === "string") entry = dot;
    else if (typeof dot === "object" && dot !== null) { entry = dot.node ?? dot.import ?? dot.default; if (typeof entry === "object" && entry !== null) entry = entry.node ?? entry.import ?? entry.default; }
  }
  if (entry === undefined && subpath === "") entry = manifest.module ?? manifest.main;
  if (entry === undefined) entry = subpath === "" ? "index.js" : subpath;
  else if (subpath !== "") entry = join(entry, subpath);
  let resolvedPath = resolve(pkgDir, entry);
  try { resolvedPath = realpathSync(resolvedPath); } catch { /* keep */ }
  if (!existsSync(resolvedPath)) throw new Error("omd-dsh: resolved entry \"" + entry + "\" for \"" + specifier + "\" does not exist at " + resolvedPath);
  return pathToFileURL(resolvedPath).href;
}
function rewriteImports(sourceText: string, harnessNodeModules: string) {
  const specifierPattern = /@deepseek-ai\/[A-Za-z0-9@._/-]+/g;
  return sourceText.split(/\r?\n/).map((line) => {
    if (!line.trimStart().startsWith("import")) return line;
    return line.replace(specifierPattern, (s) => resolveHarnessModule(harnessNodeModules, s));
  }).join("\n");
}
function readMeta(dir: string) {
  const metaPath = join(dir, ".omd-meta.json");
  if (!existsSync(metaPath)) return undefined;
  try { const p = JSON.parse(readFileSync(metaPath, "utf8")); if (p !== null && typeof p === "object" && p.files !== null && typeof p.files === "object") return p; return undefined; }
  catch { return undefined; }
}
async function collectSourceFiles(rootDir: string) {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(rootDir);
  return out;
}

// ── matrix ──
/**
 * The shipped default matrix (deepseek models) copied to
 * <DSH_HOME>/omd-matrix.json on first run. The repo and the npm package
 * ship ONLY this defaults file — personal model settings live exclusively
 * in the user's <DSH_HOME>/omd-matrix.json and are never uploaded.
 */
const DEFAULT_MATRIX_PATH = join(PACKAGE_ROOT, "omd-matrix.default.json");

/** Parse matrix text; undefined when it is not a usable matrix document. */
function parseMatrix(text: string): Matrix | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && parsed.modes !== null && typeof parsed.modes === "object") return parsed as Matrix;
  } catch { /* fall through */ }
  return undefined;
}

/** Read the shipped default matrix, failing loud when the package is broken. */
function readDefaultMatrix(): Matrix {
  if (!existsSync(DEFAULT_MATRIX_PATH)) throw new Error("omd-dsh: missing default matrix file " + DEFAULT_MATRIX_PATH + " (broken package — reinstall @carljia/omd-dsh)");
  const parsed = parseMatrix(readFileSync(DEFAULT_MATRIX_PATH, "utf8"));
  if (parsed === undefined) throw new Error("omd-dsh: malformed default matrix file " + DEFAULT_MATRIX_PATH + " (broken package — reinstall @carljia/omd-dsh)");
  return parsed;
}

/** Write a matrix file, creating its parent directory when needed. */
function writeMatrixFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/**
 * Load the user's model matrix from <DSH_HOME>/omd-matrix.json, creating it
 * on first run: a still-valid package-root matrix (previous versions) is
 * migrated over, otherwise the shipped deepseek default matrix is written.
 * Dry runs never touch the filesystem and use the shipped defaults in memory.
 */
function loadMatrix(flags: Flags): Matrix {
  if (!existsSync(MATRIX_PATH)) {
    if (flags.dryRun) return JSON.parse(JSON.stringify(readDefaultMatrix())) as Matrix;
    const legacyText = existsSync(LEGACY_MATRIX_PATH) ? readFileSync(LEGACY_MATRIX_PATH, "utf8") : undefined;
    if (legacyText !== undefined && parseMatrix(legacyText) !== undefined) {
      writeMatrixFile(MATRIX_PATH, legacyText);
      console.log("omd-dsh: migrated omd-matrix.json: " + LEGACY_MATRIX_PATH + " -> " + MATRIX_PATH);
      console.log("omd-dsh: customize the model matrix any time with `omd-dsh setup`.");
    } else {
      const defaults = readDefaultMatrix();
      writeMatrixFile(MATRIX_PATH, JSON.stringify(defaults, null, 2) + "\n");
      console.log("omd-dsh: generated " + MATRIX_PATH + " from the shipped deepseek default matrix; customize it any time with `omd-dsh setup`.");
    }
  }
  const text = readFileSync(MATRIX_PATH, "utf8");
  const parsed = parseMatrix(text);
  if (parsed === undefined) throw new Error("omd-dsh: malformed " + MATRIX_PATH + " (restore it, or delete it and run omd-dsh setup)");
  return parsed;
}
function saveMatrix(m: Matrix) { writeMatrixFile(MATRIX_PATH, JSON.stringify(m, null, 2) + "\n"); }

// ── row rendering (relative indents; the splice prepends the fence indent) ──
function q(s: string) { return JSON.stringify(s); }

function renderModeRow(modeId: string, cfg: ModeConfig): string[] {
  const out = ["- id: omd-mode", "  name: '../.omd-vendor/omd-mode.mjs'", "  config:", "    mode: " + modeId];
  if (cfg.provider !== undefined) out.push("    provider: " + cfg.provider);
  if (cfg.model !== undefined) out.push("    model: " + cfg.model);
  if (cfg.reasoningEffort !== undefined) out.push("    reasoningEffort: " + cfg.reasoningEffort);
  return out;
}

function renderToolFilter(tf: NonNullable<TierConfig["toolFilter"]>): string[] {
  const deny = tf.deny ?? [];
  const allow = tf.allow ?? [];
  const out: string[] = [];
  if (tf.denyShell === true) {
    const arr = (names: string[]) => "[" + names.map((n) => "'" + n + "'").join(", ") + "]";
    const expr = "(process.platform === 'win32') ? " + arr([...deny, "pwsh"]) + " : " + arr([...deny, "bash"]);
    out.push("toolFilter:", "  deny: !!js " + q(expr));
  } else {
    if (allow.length > 0) out.push("toolFilter:", "  allow: [" + allow.join(", ") + "]");
    if (deny.length > 0) { if (out.length === 0) out.push("toolFilter:"); out.push("  deny: [" + deny.join(", ") + "]"); }
  }
  return out;
}

function renderTaskRow(cfg: ModeConfig): string[] {
  const tiers = cfg.tiers ?? {};
  if (Object.keys(tiers).length === 0) return [];
  const out = ["- id: omd-task", "  name: '../.omd-vendor/omd-task.mjs'", "  config:", "    provider: spawn", "    toolName: omd_task", "    backgroundMode: continuable", "    tiers:"];
  for (const [name, t] of Object.entries(tiers)) {
    out.push("      " + name + ":");
    out.push("        provider: " + t.provider);
    out.push("        model: " + t.model);
    if (t.hint !== undefined) out.push("        hint: " + q(t.hint));
    if (t.persona !== undefined) out.push("        persona: " + q(t.persona));
    if (t.maxTokens !== undefined) out.push("        maxTokens: " + t.maxTokens);
    if (t.toolFilter !== undefined) for (const l of renderToolFilter(t.toolFilter)) out.push("        " + l);
  }
  return out;
}

function spliceFence(lines: string[], fence: { start: string; end: string }, rendered: string[]): void {
  const start = lines.findIndex((l) => l.trim() === fence.start);
  const end = lines.findIndex((l) => l.trim() === fence.end);
  if (start === -1 || end === -1 || end < start) throw new Error("omd-dsh: preset is missing the " + fence.start + " / " + fence.end + " markers; regenerate the preset from source");
  const indent = (lines[start].match(/^ */) || [""])[0];
  const renderedIndented = rendered.map((l) => indent + l);
  lines.splice(start, end - start + 1, indent + fence.start, ...renderedIndented, indent + fence.end);
}

function applyMatrix(text: string, modeId: string, cfg: ModeConfig): string {
  const lines = text.split("\n");
  spliceFence(lines, MODE_FENCE, renderModeRow(modeId, cfg));
  const taskRendered = renderTaskRow(cfg);
  const hasTaskFence = lines.some((l) => l.trim() === TASK_FENCE.start);
  if (taskRendered.length > 0 && !hasTaskFence) {
    throw new Error("omd-dsh: mode \"" + modeId + "\" has tiers in omd-matrix.json but its preset is missing the task fence");
  }
  if (hasTaskFence) spliceFence(lines, TASK_FENCE, taskRendered);
  return lines.join("\n");
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

// ── sync ──
async function runSync(flags: Flags, harnessNodeModules: string) {
  const matrix = loadMatrix(flags);
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const sourceVersion = manifest.version;
  const presetsSourceDir = join(PACKAGE_ROOT, "presets");
  const vendorSourceDir = join(PACKAGE_ROOT, "lib", "vendor");
  const agentPresetsRoot = join(dshHome(), ".agent-presets");

  const presetNames = (await fs.readdir(presetsSourceDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const report: Record<string, string[]> = { synced: [], updated: [], conflicts: [], skipped: [], orphan: [], removed: [] };
  const log = (kind: string, text: string) => report[kind].push(text);

  for (const presetName of presetNames) {
    const modeId = presetName.replace(/^omd-/, "");
    const cfg = matrix.modes[modeId];
    if (cfg === undefined) throw new Error("omd-dsh sync: omd-matrix.json has no entry for mode \"" + modeId + "\" (preset " + presetName + ")");
    const sourceDir = join(presetsSourceDir, presetName);
    const targetDir = join(agentPresetsRoot, presetName);
    const sourceFiles = await collectSourceFiles(sourceDir);
    const existingMeta = existsSync(targetDir) ? readMeta(targetDir) : undefined;
    if (existsSync(targetDir) && existingMeta === undefined) { log("skipped", presetName + "/ (directory exists but is not managed by omd-dsh -- left untouched)"); continue; }
    const nextFiles: Record<string, any> = {};
    for (const sourceFile of sourceFiles) {
      const rel = relative(sourceDir, sourceFile).split("\\").join("/");
      let sourceText = await fs.readFile(sourceFile, "utf8");
      if (rel === "agent.cordis.yml") sourceText = applyMatrix(sourceText, modeId, cfg);
      const sourceHash = sha256(sourceText);
      const destFile = join(targetDir, rel);
      let action = "synced";
      if (existsSync(destFile)) {
        const destHash = sha256(await fs.readFile(destFile, "utf8"));
        const prevHash = existingMeta?.files?.[rel]?.sha256;
        if (destHash === sourceHash) action = "up-to-date";
        else if (prevHash !== undefined && destHash === prevHash) action = "updated";
        else action = "conflict";
      }
      if (action === "conflict") { log("conflicts", presetName + "/" + rel + " (locally modified -- keeping your version)"); if (existingMeta?.files?.[rel]?.sha256 !== undefined) nextFiles[rel] = { sha256: existingMeta.files[rel].sha256 }; continue; }
      if (action === "up-to-date") log("skipped", presetName + "/" + rel + " (up to date)");
      else { if (!flags.dryRun) { await fs.mkdir(dirname(destFile), { recursive: true }); await fs.writeFile(destFile, sourceText, "utf8"); } log(action === "synced" ? "synced" : "updated", presetName + "/" + rel + (flags.dryRun ? " (dry-run)" : "")); }
      nextFiles[rel] = { sha256: sourceHash };
    }
    if (!flags.dryRun) {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(join(targetDir, ".omd-meta.json"), JSON.stringify({ source: "omd-dsh", sourceVersion, files: nextFiles }, null, 2) + "\n", "utf8");
    }
  }

  const vendorTargetDir = join(agentPresetsRoot, ".omd-vendor");
  const vendorMeta = existsSync(vendorTargetDir) ? readMeta(vendorTargetDir) : undefined;
  if (existsSync(vendorTargetDir) && vendorMeta === undefined) {
    log("skipped", ".omd-vendor/ (directory exists but is not managed by omd-dsh -- left untouched)");
  } else {
    const nextVendorFiles: Record<string, any> = {};
    for (const vendorName of VENDOR_SOURCES) {
      const sourceFile = join(vendorSourceDir, vendorName);
      if (!existsSync(sourceFile)) { throw new Error("omd-dsh sync: missing vendored source " + sourceFile + " -- run `npm run build` first"); }
      let sourceText = await fs.readFile(sourceFile, "utf8");
      sourceText = rewriteImports(sourceText, harnessNodeModules);
      const sourceHash = sha256(sourceText);
      const destFile = join(vendorTargetDir, vendorName);
      let action = "synced";
      if (existsSync(destFile)) {
        const destHash = sha256(await fs.readFile(destFile, "utf8"));
        const prevHash = vendorMeta?.files?.[vendorName]?.sha256;
        if (destHash === sourceHash) action = "up-to-date";
        else if (prevHash !== undefined && destHash === prevHash) action = "updated";
        else action = "conflict";
      }
      if (action === "conflict") { log("conflicts", ".omd-vendor/" + vendorName + " (locally modified -- keeping your version)"); if (vendorMeta?.files?.[vendorName]?.sha256 !== undefined) nextVendorFiles[vendorName] = { sha256: vendorMeta.files[vendorName].sha256 }; continue; }
      if (action === "up-to-date") log("skipped", ".omd-vendor/" + vendorName + " (up to date)");
      else { if (!flags.dryRun) { await fs.mkdir(vendorTargetDir, { recursive: true }); await fs.writeFile(destFile, sourceText, "utf8"); } log(action === "synced" ? "synced" : "updated", ".omd-vendor/" + vendorName + (flags.dryRun ? " (dry-run)" : "")); }
      nextVendorFiles[vendorName] = { sha256: sourceHash };
    }
    if (!flags.dryRun && VENDOR_SOURCES.length > 0) {
      await fs.mkdir(vendorTargetDir, { recursive: true });
      await fs.writeFile(join(vendorTargetDir, ".omd-meta.json"), JSON.stringify({ source: "omd-dsh", sourceVersion, harnessNodeModules, files: nextVendorFiles }, null, 2) + "\n", "utf8");
    }
  }

  if (existsSync(agentPresetsRoot)) {
    for (const entry of await fs.readdir(agentPresetsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("omd-")) continue;
      if (presetNames.includes(entry.name)) continue;
      const orphanDir = join(agentPresetsRoot, entry.name);
      const meta = readMeta(orphanDir);
      if (meta === undefined) continue;
      const renamedTo = RENAMED_FROM[entry.name];
      if (renamedTo !== undefined && presetNames.includes(renamedTo)) {
        const dirty = await locallyModified(orphanDir, meta);
        if (dirty === undefined) {
          if (!flags.dryRun) await fs.rm(orphanDir, { recursive: true, force: true });
          log("removed", entry.name + "/ (renamed to " + renamedTo + " and unmodified -- removed" + (flags.dryRun ? ", dry-run" : "") + ")");
        } else {
          log("conflicts", entry.name + "/ (renamed to " + renamedTo + " but locally modified -- keeping your version: " + dirty + ")");
        }
      } else {
        log("orphan", entry.name + "/ (was installed by omd-dsh but no longer ships with v" + sourceVersion + " -- left untouched)");
      }
    }
  }

  console.log("omd-dsh sync: DSH_HOME=" + dshHome());
  console.log("omd-dsh sync: matrix=" + MATRIX_PATH + " (customize the model matrix any time with `omd-dsh setup`)");
  console.log("omd-dsh sync: harness node_modules=" + harnessNodeModules);
  console.log("omd-dsh sync: source version=" + sourceVersion + (flags.dryRun ? " (dry-run)" : ""));
  for (const key of ["synced", "updated", "skipped", "conflicts", "orphan", "removed"]) for (const line of report[key]) console.log("  [" + key + "] " + line);
  const summary = ["synced", "updated", "conflicts", "orphan", "removed"].map((key) => report[key].length + " " + key).join(", ");
  console.log("omd-dsh sync: " + summary + (flags.dryRun ? " (dry-run)" : ""));
}

/**
 * Whether one omd-dsh-managed preset directory differs from the hashes its
 * .omd-meta.json recorded. Returns a description of the first discrepancy,
 * or undefined when every recorded file is present and unmodified and no
 * extra files exist.
 */
async function locallyModified(dir: string, meta: { files?: Record<string, any> }) {
  const recorded = meta.files ?? {};
  const current: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== ".omd-meta.json") {
        const rel = relative(dir, full).split("\\").join("/");
        current[rel] = sha256(await fs.readFile(full, "utf8"));
      }
    }
  };
  await walk(dir);
  for (const rel of new Set([...Object.keys(recorded), ...Object.keys(current)])) {
    if (current[rel] === undefined) return "missing file " + rel;
    const recordedHash = recorded[rel] !== undefined && typeof recorded[rel] === "object" && recorded[rel] !== null ? recorded[rel].sha256 : undefined;
    if (typeof recordedHash !== "string" || recordedHash !== current[rel]) return "modified file " + rel;
  }
  return undefined;
}

// ── setup (interactive) ──
function splitModel(answer: string): { provider: string; model: string } {
  const a = answer.trim();
  if (a.includes("/")) { const i = a.indexOf("/"); return { provider: a.slice(0, i).trim(), model: a.slice(i + 1).trim() }; }
  return { provider: "deepseek-official", model: a };
}

async function runSetup(flags: Flags, harnessNodeModules: string | undefined) {
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
  const flags: Flags = { dryRun: false, verbose: false };
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
