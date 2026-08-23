#!/usr/bin/env node
import { promises as fs, existsSync, realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * omo-dsh sync: materialize the omo presets and vendored rows into the
 * DSH user preset root (<DSH_HOME>/.agent-presets).
 *
 * Distribution model (vendored + harness-anchored imports):
 * - presets/omo-* are copied into .agent-presets/ verbatim; their rows
 *   reference ../.omo-vendor/omo-mode.mjs / omo-task.mjs by relative path.
 * - the vendored row modules are copied into .agent-presets/.omo-vendor/
 *   (a dot-prefixed directory, invisible to preset discovery); every
 *   bare @deepseek-ai/* import inside them is rewritten to an absolute
 *   file:// URL pointing INTO the harness node_modules tree. This keeps
 *   module-local symbols (dsh-scope, cordis) single-instance with the
 *   harness -- the cross-tree duplicate-instance hazard that pnpm-style
 *   profile installs would otherwise introduce.
 *
 * Safety: only omo-* preset directories and .omo-vendor are ever touched;
 * every managed directory carries a .omo-meta.json (source version +
 * sha256 per file). A destination file whose content differs from BOTH
 * the current source and the previously synced source hash is treated as
 * locally modified and is never overwritten.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_SOURCES = ["omo-mode.mjs", "omo-task.mjs"];

function usage() {
  return [
    "omo-dsh sync [--harness <node_modules|any path under it>] [--dry-run] [--verbose]",
    "  --harness   node_modules directory of the DSH harness install (auto-detected via the dsh executable)",
    "  --dry-run   print what would be written without touching the filesystem",
    "  --verbose   print per-file detail",
  ].join("\n");
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ""
    ? resolve(process.env.DSH_HOME)
    : join(homedir(), ".dsh");
}

/** Walk up from a path until a directory named node_modules is found. */
function findNodeModules(start: string) {
  let current = resolve(start);
  for (;;) {
    if (basename(current) === "node_modules") return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Locate the harness node_modules via the dsh executable. */
function locateHarnessViaDsh() {
  const candidates: string[] = [];
  try {
    const probe = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(probe, ["dsh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      candidates.push(trimmed);
    }
  } catch {
    // dsh not on PATH
  }
  for (const candidate of candidates) {
    let real = candidate;
    try { real = realpathSync(candidate); } catch { /* keep as-is */ }
    const nm = findNodeModules(real);
    if (nm !== undefined && existsSync(join(nm, "@deepseek-ai", "dsh-scope", "package.json"))) return nm;
  }
  return undefined;
}

/** Resolve a bare @deepseek-ai/* specifier to an entry file inside the harness tree. */
function resolveHarnessModule(harnessNodeModules: string, specifier: string) {
  const segments = specifier.split("/");
  const scope = segments[0].startsWith("@") ? segments[0] + "/" + segments[1] : segments[0];
  const subpath = scope === specifier ? "" : specifier.slice(scope.length + 1);
  const pkgDir = join(harnessNodeModules, ...scope.split("/"));
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error("omo-dsh sync: cannot resolve \"" + specifier + "\" -- no package.json at " + manifestPath);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let entry: any;
  const exportsMap = manifest.exports;
  if (subpath === "" && exportsMap !== undefined && exportsMap["."] !== undefined) {
    const dot = exportsMap["."];
    if (typeof dot === "string") entry = dot;
    else if (typeof dot === "object" && dot !== null) {
      entry = dot.node ?? dot.import ?? dot.default;
      if (typeof entry === "object" && entry !== null) {
        entry = entry.node ?? entry.import ?? entry.default;
      }
    }
  }
  if (entry === undefined && subpath === "") entry = manifest.module ?? manifest.main;
  if (entry === undefined) {
    entry = subpath === "" ? "index.js" : subpath;
  } else if (subpath !== "") {
    entry = join(entry, subpath);
  }
  let resolvedPath = resolve(pkgDir, entry);
  try { resolvedPath = realpathSync(resolvedPath); } catch { /* keep */ }
  if (!existsSync(resolvedPath)) {
    throw new Error("omo-dsh sync: resolved entry \"" + entry + "\" for \"" + specifier + "\" does not exist at " + resolvedPath);
  }
  return pathToFileURL(resolvedPath).href;
}

/** Rewrite bare @deepseek-ai/* imports in vendored row sources to harness-anchored file URLs. */
function rewriteImports(sourceText: string, harnessNodeModules: string) {
  const specifierPattern = /@deepseek-ai\/[A-Za-z0-9@._/-]+/g;
  return sourceText
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trimStart().startsWith("import")) return line;
      return line.replace(specifierPattern, (specifier) => resolveHarnessModule(harnessNodeModules, specifier));
    })
    .join("\n");
}

function readMeta(dir: string) {
  const metaPath = join(dir, ".omo-meta.json");
  if (!existsSync(metaPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && parsed.files !== null && typeof parsed.files === "object") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
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

async function main() {
  const argv = process.argv.slice(2);
  const flags: { harness?: string; dryRun: boolean; verbose: boolean } = { dryRun: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--harness") flags.harness = argv[++i];
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--help" || arg === "-h") { console.log(usage()); return; }
    else if (arg === "sync") { /* subcommand position */ }
    else { console.error("unknown argument: " + arg + "\n\n" + usage()); process.exitCode = 2; return; }
  }

  let harnessNodeModules = flags.harness !== undefined ? findNodeModules(flags.harness) : locateHarnessViaDsh();
  if (harnessNodeModules === undefined || !existsSync(join(harnessNodeModules, "@deepseek-ai", "dsh-scope", "package.json"))) {
    console.error("omo-dsh sync: cannot locate the DSH harness node_modules.\n  - ensure the dsh executable is on PATH, or\n  - pass --harness <path to the harness node_modules directory>.\n\n" + usage());
    process.exitCode = 2;
    return;
  }
  harnessNodeModules = realpathSync(harnessNodeModules);

  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const sourceVersion = manifest.version;
  const presetsSourceDir = join(PACKAGE_ROOT, "presets");
  const vendorSourceDir = join(PACKAGE_ROOT, "lib", "vendor");
  const agentPresetsRoot = join(dshHome(), ".agent-presets");

  const presetNames = (await fs.readdir(presetsSourceDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const report: Record<string, string[]> = { synced: [], updated: [], conflicts: [], skipped: [], orphan: [] };
  const log = (kind: string, text: string) => report[kind].push(text);

  // ── presets ──
  for (const presetName of presetNames) {
    const sourceDir = join(presetsSourceDir, presetName);
    const targetDir = join(agentPresetsRoot, presetName);
    const sourceFiles = await collectSourceFiles(sourceDir);
    const existingMeta = existsSync(targetDir) ? readMeta(targetDir) : undefined;
    if (existsSync(targetDir) && existingMeta === undefined) {
      log("skipped", presetName + "/ (directory exists but is not managed by omo-dsh -- left untouched)");
      continue;
    }
    const nextFiles: Record<string, any> = {};
    for (const sourceFile of sourceFiles) {
      const rel = relative(sourceDir, sourceFile).split("\\").join("/");
      const sourceText = await fs.readFile(sourceFile, "utf8");
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
      if (action === "conflict") {
        log("conflicts", presetName + "/" + rel + " (locally modified -- keeping your version)");
        if (existingMeta?.files?.[rel]?.sha256 !== undefined) nextFiles[rel] = { sha256: existingMeta.files[rel].sha256 };
        continue;
      }
      if (action === "up-to-date") {
        log("skipped", presetName + "/" + rel + " (up to date)");
      } else {
        if (!flags.dryRun) {
          await fs.mkdir(dirname(destFile), { recursive: true });
          await fs.writeFile(destFile, sourceText, "utf8");
        }
        log(action === "synced" ? "synced" : "updated", presetName + "/" + rel + (flags.dryRun ? " (dry-run)" : ""));
      }
      nextFiles[rel] = { sha256: sourceHash };
    }
    if (!flags.dryRun) {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(join(targetDir, ".omo-meta.json"), JSON.stringify({
        source: "omo-dsh",
        sourceVersion,
        files: nextFiles,
      }, null, 2) + "\n", "utf8");
    }
  }

  // ── vendored row modules ──
  const vendorTargetDir = join(agentPresetsRoot, ".omo-vendor");
  const vendorMeta = existsSync(vendorTargetDir) ? readMeta(vendorTargetDir) : undefined;
  if (existsSync(vendorTargetDir) && vendorMeta === undefined) {
    log("skipped", ".omo-vendor/ (directory exists but is not managed by omo-dsh -- left untouched)");
  } else {
    const nextVendorFiles: Record<string, any> = {};
    for (const vendorName of VENDOR_SOURCES) {
      const sourceFile = join(vendorSourceDir, vendorName);
      if (!existsSync(sourceFile)) {
        console.error("omo-dsh sync: missing vendored source " + sourceFile + " -- run `npm run build` first");
        process.exitCode = 2;
        return;
      }
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
      if (action === "conflict") {
        log("conflicts", ".omo-vendor/" + vendorName + " (locally modified -- keeping your version)");
        if (vendorMeta?.files?.[vendorName]?.sha256 !== undefined) nextVendorFiles[vendorName] = { sha256: vendorMeta.files[vendorName].sha256 };
        continue;
      }
      if (action === "up-to-date") log("skipped", ".omo-vendor/" + vendorName + " (up to date)");
      else {
        if (!flags.dryRun) {
          await fs.mkdir(vendorTargetDir, { recursive: true });
          await fs.writeFile(destFile, sourceText, "utf8");
        }
        log(action === "synced" ? "synced" : "updated", ".omo-vendor/" + vendorName + (flags.dryRun ? " (dry-run)" : ""));
      }
      nextVendorFiles[vendorName] = { sha256: sourceHash };
    }
    if (!flags.dryRun && VENDOR_SOURCES.length > 0) {
      await fs.mkdir(vendorTargetDir, { recursive: true });
      await fs.writeFile(join(vendorTargetDir, ".omo-meta.json"), JSON.stringify({
        source: "omo-dsh",
        sourceVersion,
        harnessNodeModules,
        files: nextVendorFiles,
      }, null, 2) + "\n", "utf8");
    }
  }

  // ── orphan report (managed omo-* dirs that no longer ship with the package) ──
  if (existsSync(agentPresetsRoot)) {
    for (const entry of await fs.readdir(agentPresetsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("omo-")) continue;
      if (presetNames.includes(entry.name)) continue;
      if (readMeta(join(agentPresetsRoot, entry.name)) !== undefined) {
        log("orphan", entry.name + "/ (was installed by omo-dsh but no longer ships with v" + sourceVersion + " -- left untouched; delete it manually to remove the mode)");
      }
    }
  }

  console.log("omo-dsh sync: DSH_HOME=" + dshHome());
  console.log("omo-dsh sync: harness node_modules=" + harnessNodeModules);
  console.log("omo-dsh sync: source version=" + sourceVersion + (flags.dryRun ? " (dry-run)" : ""));
  for (const key of ["synced", "updated", "skipped", "conflicts", "orphan"]) {
    for (const line of report[key]) console.log("  [" + key + "] " + line);
  }
  const summary = ["synced", "updated", "conflicts", "orphan"].map((key) => report[key].length + " " + key).join(", ");
  console.log("omo-dsh sync: " + summary + (flags.dryRun ? " (dry-run)" : ""));
}

main().catch((error) => {
  console.error("omo-dsh sync failed: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

