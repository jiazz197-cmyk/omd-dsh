/** Test stub: captures tool definitions registered via defineTool. */
export const definedTools: any[] = [];
export function defineTool(def: any) {
  definedTools.push(def);
  return { __toolDef: def };
}
export function resetDefinedTools() { definedTools.length = 0; }
