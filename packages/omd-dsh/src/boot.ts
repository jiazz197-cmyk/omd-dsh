import { runSync, resolveHarnessFromSelf, resolveHarness } from "./sync.js";

/**
 * @module @carljia/omd-dsh/boot
 *
 * omd-dsh bundle boot row: materialize the 7 OMD agent presets into the user
 * preset root (<DSH_HOME>/.agent-presets) when the profile boots, so
 * "dsh plugin add @carljia/omd-dsh" + a restart is the whole install — no
 * manual "omd-dsh sync" needed.
 *
 * The sync is idempotent (hash-aware, conflict-protected) and reuses the same
 * core as the "omd-dsh sync" CLI. The harness node_modules is located from
 * this module's own resolution path first (the profile exposes the harness
 * tree via its flat module fallback), then through the CLI's detection chain.
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
    const harness = resolveHarnessFromSelf() ?? resolveHarness({ harness: undefined, dryRun: false, verbose: false });
    if (harness === undefined) {
      log(ctx, "error", "omd-dsh: cannot locate the DSH harness node_modules — presets were not synced. Run `omd-dsh sync --harness <path>` once to point it at the harness, then restart.");
      return;
    }
    await runSync({ harness: undefined, dryRun: false, verbose: false }, harness, (message) => log(ctx, "info", message));
  } catch (error) {
    log(ctx, "error", "omd-dsh: preset sync failed: " + (error instanceof Error ? error.message : String(error)));
  }
}
