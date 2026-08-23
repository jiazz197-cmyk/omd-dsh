# @subagent-router/omo-dsh

OmO 理念的 DSH 插件：两个 cordis 行 + 7 个模式 preset + 同步 CLI。总览、模式矩阵与安装见仓库根 [README.md](../../README.md)。

## 行：omo-mode

按模式（agent preset）固定模型路由。仅限 preset 作用域内挂载（无作用域挂载直接报错）。

| 配置字段 | 含义 |
|---|---|
| mode | 模式标识（横幅/诊断语义；不影响路由），必填 |
| provider | 该模式的 provider；与 model 同时缺省时不固定路由（透传） |
| model | 该模式的模型；与 provider 同时缺省时不固定路由（透传） |
| reasoningEffort | 可选推理强度；缺省时清除继承值，交由 provider 默认 |

机制：监听 system-prompt/assemble（注入 {{provider}}/{{model}} 提示词变量）与 agent/request（next() 后覆盖路由），两处均 prepend，保证覆盖入口的会话级选择。

模型体验：persona 文本每次请求固定携带该模式模型声明；模式模型路由在 agent 生命周期内稳定（KV 前缀稳定）。

## 行：omo-task

tier 差异化子代理委派（等价 OmO 的 task(category=…)）。仅限 preset 作用域内挂载。

| 配置字段 | 默认 | 含义 |
|---|---|---|
| provider | spawn | 子代理提供方 |
| toolName | omo_task | 模型可见工具名（同 preset 内唯一） |
| backgroundMode | continuable | continuable（默认后台，run_in_background:false 转前台）或 foreground |
| tiers | 必填 | tier 名 → { provider(必), model(必), hint?, persona?, toolFilter?: {allow?, deny?}, maxTokens? }；tier 名匹配 [a-z0-9][a-z0-9_-]* |
| defaultTier | 无 | 模型未传 tier 时的默认档（单 tier 时自动） |
| maxDepth | 3 | 委派深度上限；provider-managed 表示交提供方 |

模型可见参数：description（展示名）、prompt、tier（枚举见工具描述）、run_in_background（仅 continuable 模式）。工具描述枚举各 tier 的 hint 与模型，模型据此选型。

## CLI：omo-dsh sync

```
omo-dsh sync [--harness <路径>] [--dry-run]
```

把 presets/ 与 vendored 行模块同步到 <DSH_HOME>/.agent-presets/（hash 保护、orphan 报告、非管理目录零操作）。细节见 docs/ARCHITECTURE.md 的「vendored 分发与跨树符号风险」。

## 开发

```bash
npm install     # 触发 build（tsc + postbuild）
npm test        # vitest，36 个测试
npm pack        # prepack 自动重建，产出 tgz
```

测试桩在 test/stubs/（dsh-scope/dsh-tools/dsh-subagent 的轻量替身），不依赖真实 harness。

