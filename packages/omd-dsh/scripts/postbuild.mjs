import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundle each row into a SELF-CONTAINED vendored module.
 *
 * The vendored rows live in <DSH_HOME>/.agent-presets/.omd-vendor/, far from
 * any node_modules, so bare imports cannot resolve there. Earlier versions
 * rewrote @deepseek-ai/* imports to absolute file:// URLs into a hardcoded
 * harness tree — but the harness's agent machinery can load from a different
 * tree than the one recorded at sync time (npx cache vs. profile bundles vs.
 * global npm install), and a mismatch breaks the dsh-scope kScope symbol and
 * bricks every preset mount.
 *
 * The fix: bundle every dependency INTO the row (schemastery for Config,
 * dsh-tools defineTool, dsh-llm createUserMessage, dsh-subagent asserts are
 * all instance-agnostic in how the harness consumes them), so the row has
 * ZERO @deepseek-ai imports and no tree knowledge is needed at sync time.
 * The one exception is shared.js — the per-agent override WeakMap — which
 * must stay a separate sibling module so omd-mode and omd-task share ONE
 * module instance; it is copied verbatim next to the bundles.
 *
 * dsh-scope is NOT bundled-in for the scope guard: a bundled copy can never
 * see the harness's kScope symbol, so the guards were removed from the rows
 * (see src/index.ts). Event routing still works because scope filtering runs
 * inside the harness's own dsh-scope instance.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = [
  ["index.js", "omd-mode.mjs"],
  ["task.js", "omd-task.mjs"],
  ["ulw.js", "omd-ulw.mjs"],
  ["plan.js", "omd-plan.mjs"],
  ["startwork.js", "omd-start-work.mjs"],
  ["mode.js", "omd-mode-switch.mjs"],
];

/**
 * esbuild cannot bundle dsh-llm's top-level `createRequire(import.meta.url)
 * ("../package.json")` — the require is emitted as-is and would resolve
 * against the vendored bundle's location at runtime. The version string only
 * feeds provider-request attribution headers, which the rows never send, so a
 * placeholder keeps the module loadable. The plugin fails the build if the
 * pattern moves, so a dsh-llm upgrade cannot regress silently.
 */
const patchDshLlmAttribution = {
  name: "patch-dsh-llm-attribution",
  setup(build) {
    build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async (args) => {
      const text = await fs.readFile(args.path, "utf8");
      const pattern = 'createRequire(import.meta.url)("../package.json")';
      if (!text.includes(pattern)) {
        throw new Error("postbuild: dsh-llm attribution pattern changed at " + args.path + " -- update scripts/postbuild.mjs");
      }
      return { contents: text.replaceAll(pattern, '({ version: "0.0.0" })'), loader: "js" };
    });
  },
};

const outDir = join(root, "lib", "vendor");
await fs.mkdir(outDir, { recursive: true });
for (const [src, dest] of rows) {
  await build({
    entryPoints: [join(root, "lib", src)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: join(outDir, dest),
    external: ["./shared.js"],
    plugins: [patchDshLlmAttribution],
    logLevel: "silent",
  });
}
// Shared per-agent state imported by omd-mode / omd-task; copied verbatim so
// both bundles resolve the SAME module instance (same file URL).
await fs.copyFile(join(root, "lib", "shared.js"), join(outDir, "shared.js"));
console.log("postbuild: self-contained bundles written to lib/vendor/ (omd-mode.mjs, omd-task.mjs, omd-ulw.mjs, omd-plan.mjs, omd-start-work.mjs, omd-mode-switch.mjs, shared.js)");

// ── client bundle (lib/client.js) ──
// The browser half is a CJS bundle that ONLY requires "react" externally;
// everything else comes from cordis services injected at runtime (slots /
// locale / connection / settingsScope). The bundle is wrapped in the DSH
// client bundle envelope so `window.__ModuleLoader__.load` registers it
// under the package name (the entry id dsh-client-modules composes).
const clientOut = join(root, "lib", ".client-bundle.js");
await build({
  entryPoints: [join(root, "src", "client.tsx")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  external: ["react"],
  outfile: clientOut,
  logLevel: "silent",
});
const bundleText = await fs.readFile(clientOut, "utf8");
const envelope = [
  "window.__ModuleLoader__.load({",
  "\tid: \"@carljia/omd-dsh\",",
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
  "\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });",
  bundleText,
  "\t\treturn module.exports;",
  "\t}",
  "});",
  "",
].join("\n");
await fs.writeFile(join(root, "lib", "client.js"), envelope, "utf8");
await fs.rm(clientOut, { force: true });
console.log("postbuild: client bundle written to lib/client.js (envelope id @carljia/omd-dsh, external: react)");
