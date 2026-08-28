/**
 * @module @carljia/omd-dsh/shared
 *
 * Per-agent transient state shared between the omd-mode and omd-task rows.
 *
 * Why this module exists: cordis scoped contexts are proxies — assigning an
 * undeclared property throws ("cannot set property ... without provide"), and
 * two rows in one preset are sibling contexts that cannot see each other's
 * declared properties either. Both rows therefore import this module, and the
 * sync ships it next to them (`.omd-vendor/shared.js`), so the two vendored
 * rows resolve the SAME module instance and share one WeakMap. The override is
 * keyed by the top-level agent object (stable across a session's turns; a
 * resumed session mints a new agent and starts clean; subagents are distinct
 * objects and simply miss the map, which is exactly the documented passthrough
 * semantics).
 */

/** One user model pick, recorded when omd-mode yields to it. */
export interface ModeOverride {
  provider: string;
  model: string;
}

const modeOverrides = new WeakMap<object, ModeOverride>();

/** Record (or clear, with `undefined`) the user's model pick for one agent. */
export function setModeOverride(agent: object, override: ModeOverride | undefined): void {
  if (override === undefined) modeOverrides.delete(agent);
  else modeOverrides.set(agent, override);
}

/** The user's recorded model pick for one agent, or undefined. */
export function modeOverrideFor(agent: object): ModeOverride | undefined {
  return modeOverrides.get(agent);
}
