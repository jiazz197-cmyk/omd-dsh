// 构建期类型 shim：本包不随源码安装 @deepseek-ai/* 依赖（peerDependencies），
// 类型仅用于编译检查；运行时由 harness 树解析（vendored 分发由 sync 改写为
// 指向 harness 的绝对 file:// 导入）。
declare module "@deepseek-ai/schemastery" {
  const z: any;
  export default z;
}

declare module "@deepseek-ai/dsh-scope" {
  export function scopeOf(ctx: any): any;
  export function createScope(ctx: any, key: any, options?: any): any;
  export function scopeTarget(base: any, key: any): any;
}

declare module "@deepseek-ai/dsh-tools" {
  export function defineTool(def: any): any;
}

declare module "@deepseek-ai/dsh-subagent" {
  export function assertSubagentMaxDepth(maxDepth: number | string): void;
  export function settleRun(run: any): Promise<any>;
}

declare module "@deepseek-ai/dsh-llm" {
  export function createUserMessage(input: any): any;
}
