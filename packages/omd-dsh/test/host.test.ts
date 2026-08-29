import { describe, it, expect } from "vitest";
import { shouldImportFile } from "../lib/host.js";
import { readDefaultMatrix } from "../lib/sync.js";

describe("host reconcile decision (shouldImportFile)", () => {
  it("does not import when no file matrix exists", () => {
    expect(shouldImportFile(undefined, readDefaultMatrix())).toBe(false);
  });

  it("does not import when the file matrix equals the resolved namespace value", () => {
    const matrix = readDefaultMatrix();
    expect(shouldImportFile(matrix, matrix)).toBe(false);
  });

  it("imports when the file matrix differs from the resolved value (CLI edit picked up on restart)", () => {
    const resolved = readDefaultMatrix();
    const fileMatrix = readDefaultMatrix();
    fileMatrix.modes.chat = { provider: "deepseek-official", model: "deepseek-v4-pro" };
    expect(shouldImportFile(fileMatrix, resolved)).toBe(true);
  });

  it("imports a file matrix carrying legacy/custom fields (e.g. Qwen tier model)", () => {
    const resolved = readDefaultMatrix();
    const fileMatrix = readDefaultMatrix();
    fileMatrix.modes.executor.tiers.fast.model = "Qwen/Qwen3.8-27B-FP8";
    expect(shouldImportFile(fileMatrix, resolved)).toBe(true);
  });
});
