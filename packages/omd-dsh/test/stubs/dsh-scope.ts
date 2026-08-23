/** Test stub: scopeOf reads a plain __scope__ property so tests control it. */
export function scopeOf(ctx: any): any {
  return ctx === undefined || ctx === null ? undefined : ctx.__scope__;
}
export function createScope(_ctx: any, _key: any, _options?: any): any { return {}; }
export function scopeTarget(base: any, _key: any): any { return base; }
