import { promises as fs, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/**
 * omd-dsh sync core — materialize the OMD presets into <DSH_HOME>/.agent-presets.
 *
 * Shared by the CLI (`omd-dsh sync`), the bundle boot row (`dsh plugin add`
 * + restart), and the host settings row (lib/host.js): render each preset's
 * omd-mode / omd-task rows from the model matrix, and copy the presets plus
 * the vendored row modules into .agent-presets.
 *
 * The matrix has two faces: `runSync` reads/writes the CLI face
 * (<DSH_HOME>/omd-matrix.json, the `omd-dsh setup` target), while the host
 * settings row resolves the matrix from the settings namespace
 * (`omd-model-allocation` in settings.yaml) and feeds it to
 * `runSyncWithMatrix` — the file becomes an exported mirror of the namespace
 * plus the CLI compatibility face (see src/host.ts).
 *
 * The vendored rows are SELF-CONTAINED bundles (see scripts/postbuild.mjs):
 * every dependency is bundled in and they carry no @deepseek-ai imports, so
 * the sync needs NO harness tree knowledge — the rows work regardless of
 * whether the harness's agent machinery loads from an npx cache, a profile,
 * or a global npm install, and no `--harness` configuration is ever needed.
 * Bare package rows in the preset compositions (e.g. @deepseek-ai/dsh-persona)
 * are resolved by the harness's own loader at runtime against the host base.
 */

export type SyncFlags = { dryRun: boolean; verbose: boolean };
export interface TierConfig { provider: string; model: string; hint?: string; persona?: string; maxTokens?: number; toolFilter?: { allow?: string[]; deny?: string[]; denyShell?: boolean } }
export interface ModeConfig { provider?: string; model?: string; reasoningEffort?: string; tiers?: Record<string, TierConfig> }
export interface Matrix { version: number; defaults?: { provider?: string }; modes: Record<string, ModeConfig> }

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR_SOURCES = ["omd-mode.mjs", "omd-task.mjs", "omd-ulw.mjs", "omd-plan.mjs", "omd-start-work.mjs", "omd-mode-switch.mjs", "shared.js"];
/** User-owned model matrix: lives under DSH_HOME, never inside the package or the repo. */
export const MATRIX_PATH = join(dshHome(), "omd-matrix.json");
/** Pre-migration location (package root) — migrated to MATRIX_PATH once when present. */
const LEGACY_MATRIX_PATH = join(PACKAGE_ROOT, "omd-matrix.json");
const MODE_FENCE = { start: "# [omd-dsh:mode:start]", end: "# [omd-dsh:mode:end]" };
const TASK_FENCE = { start: "# [omd-dsh:task:start]", end: "# [omd-dsh:task:end]" };
/** Presets that were renamed: old directory name -> new preset name. */
const RENAMED_FROM: Record<string, string> = { "omd-architect": "omd-ultraworker" };

function sha256(text: string) { return createHash("sha256").update(text).digest("hex"); }
export function dshHome() { return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== "" ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh"); }

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
const DEFAULT_MATRIX_PATH = join(PACKAGE_ROOT, "omd-matrix.default.json");

/** Settings-namespace schema for the model matrix (see plan §5). Every field
 *  is optional: `base` (the shipped default matrix) fills whatever the user
 *  document omits, and extra keys (future fields) pass through untouched. */
const TierSchema = z.object({
  provider: z.string(),
  model: z.string(),
  hint: z.string(),
  persona: z.string(),
  maxTokens: z.number(),
  toolFilter: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    denyShell: z.boolean(),
  }),
});
const ModeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  tiers: z.dict(TierSchema),
});
export const MatrixSchema = z.object({
  version: z.number(),
  defaults: z.object({ provider: z.string() }),
  modes: z.dict(ModeSchema),
});

function parseMatrix(text: string): Matrix | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && parsed.modes !== null && typeof parsed.modes === "object") return parsed as Matrix;
  } catch { /* fall through */ }
  return undefined;
}

export function readDefaultMatrix(): Matrix {
  if (!existsSync(DEFAULT_MATRIX_PATH)) throw new Error("omd-dsh: missing default matrix file " + DEFAULT_MATRIX_PATH + " (broken package — reinstall @carljia/omd-dsh)");
  const parsed = parseMatrix(readFileSync(DEFAULT_MATRIX_PATH, "utf8"));
  if (parsed === undefined) throw new Error("omd-dsh: malformed default matrix file " + DEFAULT_MATRIX_PATH + " (broken package — reinstall @carljia/omd-dsh)");
  return parsed;
}

/**
 * Read the user's matrix file (<DSH_HOME>/omd-matrix.json) without touching
 * the filesystem beyond the read: missing or malformed returns undefined and
 * NEVER auto-generates — the caller decides what to fall back to (settings
 * namespace resolved value / default matrix). This is the host row's
 * "import CLI / legacy edits into the settings namespace" read.
 */
export function readMatrixFileIfExists(): Matrix | undefined {
  if (!existsSync(MATRIX_PATH)) return undefined;
  try {
    return parseMatrix(readFileSync(MATRIX_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

/** Structural equality over the small JSON matrix (stringify equality suffices). */
export function matrixEquals(a: Matrix, b: Matrix): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function writeMatrixFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function loadMatrix(flags: SyncFlags, log: (msg: string) => void = console.log): Matrix {
  if (!existsSync(MATRIX_PATH)) {
    if (flags.dryRun) return JSON.parse(JSON.stringify(readDefaultMatrix())) as Matrix;
    const legacyText = existsSync(LEGACY_MATRIX_PATH) ? readFileSync(LEGACY_MATRIX_PATH, "utf8") : undefined;
    if (legacyText !== undefined && parseMatrix(legacyText) !== undefined) {
      writeMatrixFile(MATRIX_PATH, legacyText);
      log("omd-dsh: migrated omd-matrix.json: " + LEGACY_MATRIX_PATH + " -> " + MATRIX_PATH);
      log("omd-dsh: customize the model matrix any time with \`omd-dsh setup\`.");
    } else {
      const defaults = readDefaultMatrix();
      writeMatrixFile(MATRIX_PATH, JSON.stringify(defaults, null, 2) + "\n");
      log("omd-dsh: generated " + MATRIX_PATH + " from the shipped deepseek default matrix; customize it any time with \`omd-dsh setup\`.");
    }
  }
  const text = readFileSync(MATRIX_PATH, "utf8");
  const parsed = parseMatrix(text);
  if (parsed === undefined) throw new Error("omd-dsh: malformed " + MATRIX_PATH + " (restore it, or delete it and run omd-dsh setup)");
  return parsed;
}
export function saveMatrix(m: Matrix) { writeMatrixFile(MATRIX_PATH, JSON.stringify(m, null, 2) + "\n"); }

// ── row rendering ──
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

/**
 * Whether one omd-dsh-managed preset directory differs from the hashes its
 * .omd-meta.json recorded. Returns a description of the first discrepancy,
 * or undefined when every recorded file is present and unmodified.
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

/**
 * Render and materialize the presets from an ALREADY-RESOLVED matrix. This is
 * the shared core between the CLI file path (`runSync`) and the settings
 * namespace path (host row): the matrix comes from the caller, everything
 * after `loadMatrix(...)` is here.
 */
export async function runSyncWithMatrix(matrix: Matrix, flags: SyncFlags, log: (msg: string) => void = console.log): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const sourceVersion = manifest.version;
  const presetsSourceDir = join(PACKAGE_ROOT, "presets");
  const vendorSourceDir = join(PACKAGE_ROOT, "lib", "vendor");
  const agentPresetsRoot = join(dshHome(), ".agent-presets");

  const presetNames = (await fs.readdir(presetsSourceDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const report: Record<string, string[]> = { synced: [], updated: [], conflicts: [], skipped: [], orphan: [], removed: [] };
  const record = (kind: string, text: string) => report[kind].push(text);

  for (const presetName of presetNames) {
    const modeId = presetName.replace(/^omd-/, "");
    const cfg = matrix.modes[modeId];
    if (cfg === undefined) throw new Error("omd-dsh sync: omd-matrix.json has no entry for mode \"" + modeId + "\" (preset " + presetName + ")");
    const sourceDir = join(presetsSourceDir, presetName);
    const targetDir = join(agentPresetsRoot, presetName);
    const sourceFiles = await collectSourceFiles(sourceDir);
    const existingMeta = existsSync(targetDir) ? readMeta(targetDir) : undefined;
    if (existsSync(targetDir) && existingMeta === undefined) { record("skipped", presetName + "/ (directory exists but is not managed by omd-dsh -- left untouched)"); continue; }
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
      if (action === "conflict") { record("conflicts", presetName + "/" + rel + " (locally modified -- keeping your version)"); if (existingMeta?.files?.[rel]?.sha256 !== undefined) nextFiles[rel] = { sha256: existingMeta.files[rel].sha256 }; continue; }
      if (action === "up-to-date") record("skipped", presetName + "/" + rel + " (up to date)");
      else { if (!flags.dryRun) { await fs.mkdir(dirname(destFile), { recursive: true }); await fs.writeFile(destFile, sourceText, "utf8"); } record(action === "synced" ? "synced" : "updated", presetName + "/" + rel + (flags.dryRun ? " (dry-run)" : "")); }
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
    record("skipped", ".omd-vendor/ (directory exists but is not managed by omd-dsh -- left untouched)");
  } else {
    const nextVendorFiles: Record<string, any> = {};
    for (const vendorName of VENDOR_SOURCES) {
      const sourceFile = join(vendorSourceDir, vendorName);
      if (!existsSync(sourceFile)) { throw new Error("omd-dsh sync: missing vendored source " + sourceFile + " -- run \`npm run build\` first"); }
      // Self-contained bundles: copied verbatim, no import rewriting, no
      // harness tree knowledge (see the module doc comment).
      const sourceText = await fs.readFile(sourceFile, "utf8");
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
      if (action === "conflict") { record("conflicts", ".omd-vendor/" + vendorName + " (locally modified -- keeping your version)"); if (vendorMeta?.files?.[vendorName]?.sha256 !== undefined) nextVendorFiles[vendorName] = { sha256: vendorMeta.files[vendorName].sha256 }; continue; }
      if (action === "up-to-date") record("skipped", ".omd-vendor/" + vendorName + " (up to date)");
      else { if (!flags.dryRun) { await fs.mkdir(vendorTargetDir, { recursive: true }); await fs.writeFile(destFile, sourceText, "utf8"); } record(action === "synced" ? "synced" : "updated", ".omd-vendor/" + vendorName + (flags.dryRun ? " (dry-run)" : "")); }
      nextVendorFiles[vendorName] = { sha256: sourceHash };
    }
    if (!flags.dryRun && VENDOR_SOURCES.length > 0) {
      await fs.mkdir(vendorTargetDir, { recursive: true });
      await fs.writeFile(join(vendorTargetDir, ".omd-meta.json"), JSON.stringify({ source: "omd-dsh", sourceVersion, files: nextVendorFiles }, null, 2) + "\n", "utf8");
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
          record("removed", entry.name + "/ (renamed to " + renamedTo + " and unmodified -- removed" + (flags.dryRun ? ", dry-run" : "") + ")");
        } else {
          record("conflicts", entry.name + "/ (renamed to " + renamedTo + " but locally modified -- keeping your version: " + dirty + ")");
        }
      } else {
        record("orphan", entry.name + "/ (was installed by omd-dsh but no longer ships with v" + sourceVersion + " -- left untouched)");
      }
    }
  }

  log("omd-dsh sync: DSH_HOME=" + dshHome());
  log("omd-dsh sync: matrix=" + MATRIX_PATH + " (customize the model matrix any time with \`omd-dsh setup\`)");
  log("omd-dsh sync: vendored rows are self-contained bundles (no harness tree dependency)");
  log("omd-dsh sync: source version=" + sourceVersion + (flags.dryRun ? " (dry-run)" : ""));
  for (const key of ["synced", "updated", "skipped", "conflicts", "orphan", "removed"]) for (const line of report[key]) log("  [" + key + "] " + line);
  const summary = ["synced", "updated", "conflicts", "orphan", "removed"].map((key) => report[key].length + " " + key).join(", ");
  log("omd-dsh sync: " + summary + (flags.dryRun ? " (dry-run)" : ""));
}

/** CLI / manual-fallback path: load the matrix from <DSH_HOME>/omd-matrix.json (generating/migrating it on first run), then render. */
export async function runSync(flags: SyncFlags, log: (msg: string) => void = console.log): Promise<void> {
  await runSyncWithMatrix(loadMatrix(flags, log), flags, log);
}
