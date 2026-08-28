import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mappings = [
  ["index.js", "omd-mode.mjs"],
  ["task.js", "omd-task.mjs"],
  ["ulw.js", "omd-ulw.mjs"],
  ["plan.js", "omd-plan.mjs"],
  ["startwork.js", "omd-start-work.mjs"],
  ["mode.js", "omd-mode-switch.mjs"],
  // Shared per-agent state imported by omd-mode / omd-task; must land next to
  // the row modules so both vendored rows resolve the SAME module instance.
  ["shared.js", "shared.js"],
];
const outDir = join(root, "lib", "vendor");
await fs.mkdir(outDir, { recursive: true });
for (const [src, dest] of mappings) {
  const text = await fs.readFile(join(root, "lib", src), "utf8");
  await fs.writeFile(join(outDir, dest), text, "utf8");
}
console.log("postbuild: vendored copies written to lib/vendor/ (omd-mode.mjs, omd-task.mjs, omd-ulw.mjs, omd-plan.mjs, omd-start-work.mjs, omd-mode-switch.mjs, shared.js)");
