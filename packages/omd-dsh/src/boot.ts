import { runSync } from "./sync.js";

/**
 * @module @carljia/omd-dsh/boot
 *
 * omd-dsh bundle boot row: materialize the 7 OMD agent presets into the user
 * preset root (<DSH_HOME>/.agent-presets) when the profile boots, so
 * "dsh plugin add @carljia/omd-dsh" + a restart is the whole install — no
 * manual "omd-dsh sync" and no harness configuration needed.
 *
 * The sync is idempotent (hash-aware, conflict-protected) and reuses the same
 * core as the "omd-dsh sync" CLI. The vendored rows are self-contained
 * bundles (see scripts/postbuild.mjs), so the sync needs no harness tree
 * knowledge and cannot break on harness/profile layout differences.
 *
 * A sync failure is logged, not thrown: a broken omd-dsh should never brick
 * the host's boot.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "omd-dsh";
/** No service injection: this row only runs its idempotent install at mount. */
export const inject: string[] = [];

function log(ctx: any, level: "info" | "error", message: string): void {
  try {
    const logger = ctx?.logger;
    if (logger !== undefined && logger !== null) { logger[level](message); return; }
  } catch { /* fall through to console */ }
  (level === "error" ? console.error : console.log)(message);
}

export async function apply(ctx: any): Promise<void> {
  try {
    await runSync({ dryRun: false, verbose: false }, (message) => log(ctx, "info", message));
  } catch (error) {
    log(ctx, "error", "omd-dsh: preset sync failed: " + (error instanceof Error ? error.message : String(error)));
  }
}
