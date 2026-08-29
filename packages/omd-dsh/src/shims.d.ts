// 构建期类型 shim：本包不随源码安装 @deepseek-ai/* 依赖（peerDependencies），
// 类型仅用于编译检查；行模块运行时被打包进自包含 bundle（scripts/postbuild.mjs），
// 不再从 harness 树解析任何 @deepseek-ai 模块。
declare module "@deepseek-ai/schemastery" {
  const z: any;
  export default z;
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
