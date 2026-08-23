import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@deepseek-ai/dsh-scope": fileURLToPath(new URL("./test/stubs/dsh-scope.ts", import.meta.url)),
      "@deepseek-ai/dsh-tools": fileURLToPath(new URL("./test/stubs/dsh-tools.ts", import.meta.url)),
      "@deepseek-ai/dsh-subagent": fileURLToPath(new URL("./test/stubs/dsh-subagent.ts", import.meta.url)),
    },
  },
  test: { environment: "node", testTimeout: 60000 },
});
