import type { Matrix } from "./sync.js";

/**
 * Client-side edit state machine for the omd model matrix — deliberately free
 * of React and DOM so it can be unit-tested against fake wire faces
 * (test/client-store.test.ts).
 *
 * The controller mirrors one settings namespace scope (`ctx.settingsScope`
 * bind) and writes through `api.settings.replace` with the scope's revision
 * as `expectedRevision` — a stale editor is refused rather than silently
 * overwriting a concurrent change (`settings-rejected` on the wire).
 */

/** Settings namespace the host row registers (src/host.ts) — must stay in step. */
export const OMD_SETTINGS_NS = "omd-model-allocation";

/** Client-side sync state of one settings namespace (wire-contract subset). */
export interface OmdScopeSnapshot {
  status: "loading" | "ready" | "unavailable";
  value: Matrix | undefined;
  revision: number | undefined;
  writable: boolean;
  mode: "host" | "memory";
}

/** The `settings.replace` wire face this controller needs. */
export interface OmdSettingsApi {
  settings: {
    replace(request: {
      ns: string;
      section: object;
      expectedRevision?: number;
    }): Promise<
      { result: { ok: true; value: unknown } } |
      { result: { ok: false; error: { message: string } } }
    >;
  };
}

/** The shared describe mirror face (used to reload Host state after a rejected write). */
export interface OmdDescribeFace {
  load(): Promise<unknown>;
}

/** The bound scope as the controller consumes it. */
export interface OmdScope {
  getSnapshot(): OmdScopeSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface OmdControllerSnapshot {
  draft: Matrix | null;
  status: "idle" | "saving";
  error: string | null;
  saved: boolean;
}

type ModeField = "provider" | "model" | "reasoningEffort";

function cloneMatrix(value: Matrix | undefined): Matrix | null {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Matrix;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OmdMatrixController {
  draft: Matrix | null;
  status: "idle" | "saving" = "idle";
  error: string | null = null;
  saved = false;

  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeScope: () => void;
  /**
   * Cached snapshot handed to `useSyncExternalStore`. React requires
   * `getSnapshot()` to return the SAME reference between changes — a fresh
   * object per call throws "The result of getSnapshot should be cached" and
   * crashes the whole settings entry (blank page). Rebuilt only in `emit()`.
   */
  private snapshot: OmdControllerSnapshot;

  constructor(
    private readonly api: OmdSettingsApi,
    private readonly scope: OmdScope,
    private readonly describe: OmdDescribeFace,
  ) {
    this.draft = cloneMatrix(scope.getSnapshot().value);
    this.snapshot = { draft: this.draft, status: this.status, error: this.error, saved: this.saved };
    this.unsubscribeScope = scope.subscribe(() => this.onScopeChange());
  }

  /** Release the scope subscription (plugin fiber teardown). */
  dispose(): void {
    this.unsubscribeScope();
    this.listeners.clear();
  }

  /** Stable snapshot reference (uSES-safe): the SAME object until state changes. */
  getSnapshot(): OmdControllerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    this.snapshot = { draft: this.draft, status: this.status, error: this.error, saved: this.saved };
    for (const listener of [...this.listeners]) listener();
  }

  /** External change (mirror reload after a rejected write, another window):
   *  rebuild the draft from the fresh value, unless a save is in flight. */
  private onScopeChange(): void {
    if (this.status === "saving") return;
    this.refreshDraft();
    this.emit();
  }

  private refreshDraft(): void {
    const value = this.scope.getSnapshot().value;
    if (value !== undefined) this.draft = cloneMatrix(value);
  }

  /** Whether the Save / Reset controls may run. */
  get canSave(): boolean {
    const snap = this.scope.getSnapshot();
    return snap.status === "ready" && snap.writable && this.status !== "saving" && this.draft !== null;
  }

  /** Whether the namespace accepts writes at all (read-only provider / memory mode). */
  get writable(): boolean {
    return this.scope.getSnapshot().writable;
  }

  /** Edit one mode's top-level field; an empty string removes the override
   *  (the field re-inherits the composition base / schema default). */
  patchMode(modeId: string, field: ModeField, value: string): void {
    const draft = this.draft;
    if (draft === null) return;
    const modes = { ...draft.modes };
    const cfg: Record<string, unknown> = { ...(modes[modeId] ?? {}) };
    if (value === "") delete cfg[field];
    else cfg[field] = value;
    modes[modeId] = cfg as Matrix["modes"][string];
    this.draft = { ...draft, modes };
    this.saved = false;
    this.emit();
  }

  /** Edit one tier's provider/model; an empty string removes the override. */
  patchTier(modeId: string, tier: string, field: "provider" | "model", value: string): void {
    const draft = this.draft;
    if (draft === null) return;
    const modes = { ...draft.modes };
    const cfg: Record<string, unknown> = { ...(modes[modeId] ?? {}) };
    const tiers: Record<string, unknown> = { ...((cfg.tiers as Record<string, unknown> | undefined) ?? {}) };
    const tierCfg: Record<string, unknown> = { ...((tiers[tier] as Record<string, unknown> | undefined) ?? {}) };
    if (value === "") delete tierCfg[field];
    else tierCfg[field] = value;
    tiers[tier] = tierCfg;
    cfg.tiers = tiers;
    modes[modeId] = cfg as Matrix["modes"][string];
    this.draft = { ...draft, modes };
    this.saved = false;
    this.emit();
  }

  /**
   * Persist the whole draft matrix through `settings.replace` (wholesale
   * section replacement — the removal/reset path merge cannot express). The
   * revision fence makes a stale editor fail loudly instead of overwriting.
   * @returns once the write settled and the snapshot reflects the outcome.
   */
  async save(): Promise<void> {
    if (!this.canSave || this.draft === null) return;
    const snap = this.scope.getSnapshot();
    this.status = "saving";
    this.error = null;
    this.emit();
    const response = await this.replace({ section: this.draft, revision: snap.revision });
    if (response.ok) this.saved = true;
    else {
      this.error = response.message;
      await this.describe.load();
    }
    this.refreshDraft();
    this.status = "idle";
    this.emit();
  }

  /** Restore the shipped default matrix: replace with an empty section. */
  async reset(): Promise<void> {
    if (!this.canSave) return;
    const snap = this.scope.getSnapshot();
    this.status = "saving";
    this.error = null;
    this.emit();
    const response = await this.replace({ section: {}, revision: snap.revision });
    if (response.ok) this.saved = true;
    else this.error = response.message;
    await this.describe.load();
    this.refreshDraft();
    this.status = "idle";
    this.emit();
  }

  private async replace(request: { section: object; revision: number | undefined }): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const response = await this.api.settings.replace({
        ns: OMD_SETTINGS_NS,
        section: request.section,
        ...(request.revision === undefined ? {} : { expectedRevision: request.revision }),
      });
      if (response.result.ok) return { ok: true };
      return { ok: false, message: response.result.error.message };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }
}
