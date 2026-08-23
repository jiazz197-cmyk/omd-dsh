import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mappings = [["index.js", "omd-mode.mjs"], ["task.js", "omd-task.mjs"], ["ulw.js", "omd-ulw.mjs"]];
const outDir = join(root, "lib", "vendor");
await fs.mkdir(outDir, { recursive: true });
for (const [src, dest] of mappings) {
  const text = await fs.readFile(join(root, "lib", src), "utf8");
  await fs.writeFile(join(outDir, dest), text, "utf8");
}
console.log("postbuild: vendored copies written to lib/vendor/ (omd-mode.mjs, omd-task.mjs, omd-ulw.mjs)");
