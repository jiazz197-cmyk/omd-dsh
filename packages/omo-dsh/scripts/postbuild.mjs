import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mappings = [["index.js", "omo-mode.mjs"], ["task.js", "omo-task.mjs"]];
const outDir = join(root, "lib", "vendor");
await fs.mkdir(outDir, { recursive: true });
for (const [src, dest] of mappings) {
  const text = await fs.readFile(join(root, "lib", src), "utf8");
  await fs.writeFile(join(outDir, dest), text, "utf8");
}
console.log("postbuild: vendored copies written to lib/vendor/ (omo-mode.mjs, omo-task.mjs)");
