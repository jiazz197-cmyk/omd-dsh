/** Test stub: records depth assertions and passes runs through. */
export const depthAssertions: Array<number | string> = [];
export function assertSubagentMaxDepth(maxDepth: number | string): void {
  depthAssertions.push(maxDepth);
}
export function resetDepthAssertions() { depthAssertions.length = 0; }
export async function settleRun(run: any): Promise<any> { return run; }
