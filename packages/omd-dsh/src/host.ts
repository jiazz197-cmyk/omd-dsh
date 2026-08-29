import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import {
  readDefaultMatrix, readMatrixFileIfExists, matrixEquals,
  runSyncWithMatrix, runSync, saveMatrix, MatrixSchema, MATRIX_PATH,
} from "./sync.js";
import type { Matrix, SyncFlags } from "./sync.js";

/**
 * @module @carljia/omd-dsh
 *
 * omd-dsh host row (package root entry, injected by cordis.patch.yml):
 *
 *  1. registers the `omd-model-allocation` settings namespace (base = the
 *     shipped default matrix, `applies: "live"`), making the settings
 *     document (<DSH_HOME>/settings.yaml) the authoritative "online edit"
 *     store for the model matrix;
 *  2. reconciles once at startup: if <DSH_HOME>/omd-matrix.json exists and
 *     differs from the namespace's resolved value, its content is imported
 *     into the namespace (`replace`) — CLI edits and pre-settings installs
 *     survive the migration, and CLI edits are picked up on the next restart;
 *  3. renders the 7 presets from the namespace's resolved matrix and mirrors
 *     that matrix back to omd-matrix.json (the export mirror + CLI face);
 *  4. watches the namespace: every UI save re-renders the presets and
 *     re-mirrors the file. New sessions route with the new matrix; running
 *     sessions keep the combination they started with.
 *
 * The browser half (lib/client.js) binds the same namespace and renders the
 * "omd模型分配" settings section (see src/client.tsx). Because the client
 * plugin discovery (dsh-client-modules) matches loader entries by package
 * name, the bundle patch injects THIS row under the bare package name
 * `@carljia/omd-dsh` — not a `/boot` subpath.
 *
 * Failure policy: a broken settings document / namespace must never brick the
 * host's boot — any failure here falls back to the plain file sync (the old
 * boot behavior) and is logged.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "omd-dsh";
/** Requires the settings service (provided by dsh-base → dsh-settings-file in every profile). */
export const inject = ["settings"];

const NS = settingsNamespace("omd-model-allocation");

/**
 * Startup reconciliation decision (pure, unit-tested): the file matrix is
 * imported into the settings namespace exactly when it exists AND differs
 * from the namespace's currently resolved value. Equal values need no write;
 * a missing file leaves the namespace (defaults / user section) authoritative.
 */
export function shouldImportFile(fileMatrix: Matrix | undefined, resolved: Matrix): boolean {
  return fileMatrix !== undefined && !matrixEquals(fileMatrix, resolved);
}

function makeLog(ctx: any) {
  return {
    info: (message: string) => { try { ctx?.logger?.info?.(message); } catch { console.log(message); } },
    error: (message: string) => { try { ctx?.logger?.error?.(message); } catch { console.error(message); } },
  };
}

export async function apply(ctx: any): Promise<void> {
  const log = makeLog(ctx);
  const flags: SyncFlags = { dryRun: false, verbose: false };
  try {
    const settings = ctx.settings; // SettingsProvider (dsh-base provides it in every profile)
    const scope = settings.register(NS, MatrixSchema, {
      base: readDefaultMatrix(),
      applies: "live",
    });

    // 启动期调和：文件 → 命名空间（幂等；导入 CLI/旧版自定义，CLI 手改在下次重启被采纳）
    const fileMatrix = readMatrixFileIfExists();
    if (shouldImportFile(fileMatrix, scope.get())) {
      log.info("omd-dsh: importing " + MATRIX_PATH + " into settings namespace " + NS);
      await scope.replace(fileMatrix!);
    }

    // 用命名空间解析出的完整矩阵渲染 presets，并把该矩阵写回镜像文件
    const resolved = scope.get();
    saveMatrix(resolved);
    await runSyncWithMatrix(resolved, flags, log.info);

    // 后续 UI 编辑：重渲染 + 更新镜像（watch 仅在解析值真正变化时触发）
    scope.watch((next: Matrix) => {
      log.info("omd-dsh: matrix changed via settings — re-syncing presets and mirroring omd-matrix.json");
      try {
        saveMatrix(next);
      } catch (error) {
        log.error("omd-dsh: failed to mirror " + MATRIX_PATH + ": " + (error instanceof Error ? error.message : String(error)));
      }
      runSyncWithMatrix(next, flags, log.info).catch((error) =>
        log.error("omd-dsh re-sync failed: " + (error instanceof Error ? error.message : String(error))));
    });
  } catch (error) {
    // settings 不可用 / 命名空间已损坏时退回纯文件 sync（保持老 boot 行为）
    log.error("omd-dsh: settings namespace failed, falling back to file sync: " + (error instanceof Error ? error.message : String(error)));
    try {
      await runSync(flags, log.info);
    } catch (fallbackError) {
      log.error("omd-dsh: file sync fallback failed: " + (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)));
    }
  }
}
