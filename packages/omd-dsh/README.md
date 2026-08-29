# @carljia/omd-dsh

OMD 理念的 DSH 插件：host 行 + 客户端设置页 + 7 个模式 preset + 同步 CLI。以 `dsh.bundle` 形式分发——`dsh plugin add @carljia/omd-dsh` 安装后重启即自动同步预设，并在设置面板出现「omd模型分配」页；也可全局安装后用 `omd-dsh sync`。总览、模式矩阵与安装见仓库根 [README.md](../../README.md)。

## 分发：bundle + host 行 + 客户端插件

包声明 `dsh.bundle.patch` → `cordis.patch.yml`，后者注入宿主行 `@carljia/omd-dsh`（包根，`lib/host.js`）。该行在 profile 启动时执行与 `omd-dsh sync` 相同的内核（`lib/sync.js`）并额外注册 settings 命名空间（见下节「设置页与数据流」）。**注入名必须是包根而不是 `/boot` 子路径**：`dsh-client-modules` 按 loader entry 的 `options.name` == 包名来发现客户端插件（读取 `dsh.client` 与 `exports["./client"]`），浏览器 half（`lib/client.js`，见下）由此被发现。`lib/boot.js` 保留为无 settings 场景的手动回退行，仍可通过 `@carljia/omd-dsh/boot` 挂载。

`.omd-vendor/` 里的行模块是**自包含 bundle**（`scripts/postbuild.mjs` 用 esbuild 把 schemastery / dsh-tools / dsh-llm / dsh-subagent 全部打进模块，唯一的例外是 `shared.js`——omd-mode 与 omd-task 共享的按 agent 键控状态，作为相对兄弟模块保持单一实例）。行模块不含任何 `@deepseek-ai/*` 导入，因此 sync **不需要知道 harness 装在哪里**，也不会出现"导入指向的树与运行进程不一致"导致的挂载失败——无论 DSH 从 npx 缓存、全局 npm 还是 profile bundles 加载 agent 机制都能工作。preset 组合里其余裸包名行（如 `@deepseek-ai/dsh-persona`）由 harness 的 loader 在运行时按宿主 base 解析。

## 设置页「omd模型分配」与数据流

设置 → 左侧导航 →「omd模型分配」（en: OMD model allocation）可视化编辑 7 个模式的模型矩阵（顶层 provider/model + 可选 reasoningEffort；有 tier 的模式逐档展示 provider/model，tier 的 `hint` 只读展示便于理解档位用途）。保存后**新会话**按新矩阵路由模型，运行中的会话保持创建时的组合。

数据流：

- `settings.yaml` 的命名空间 `omd-model-allocation` 是**在线编辑的权威存储**（宿主行注册，`base` = 随包默认矩阵 `omd-matrix.default.json`，`applies: "live"`）。
- 启动时宿主行**调和一次**：若 `<DSH_HOME>/omd-matrix.json` 存在且与命名空间解析值不同，把文件内容 `replace` 进命名空间——旧版/CLI 的自定义不丢，CLI 手改在下次重启被采纳。
- 用命名空间解析出的完整矩阵渲染 presets，并写回 `omd-matrix.json`（**导出镜像 + CLI 兼容面**）。
- 监听命名空间：UI 每次保存 → 重新渲染 presets + 更新镜像文件。保存走 `settings.replace`，携带 `expectedRevision`，冲突（`settings-rejected`）时拒绝并重载最新值。
- `omd-dsh setup` / `omd-dsh sync` CLI 保持不变（读写 `omd-matrix.json`）；宿主运行中直接改文件不会实时生效，与「运行中会话不变、新会话重新 sync」的既有语义一致。
- 边界：settings.yaml 中该段损坏 → 宿主回退纯文件 sync（老 boot 行为），不阻断启动；`omd-matrix.json` 缺失/损坏 → 用命名空间（默认矩阵）渲染并重建镜像；远程浏览器（非 loopback）→ 设置页只读/不可用；settings 只读 → 客户端禁用保存、宿主仍按解析值渲染。

## 行：omd-mode

按模式（agent preset）固定模型路由。行模块是自包含 bundle，不再做 scope 守卫（bundle 内自带的 dsh-scope 副本读不到 harness 实例写入的 kScope Symbol，守卫会误报）；请按 preset 组合挂载，误挂到全局组合会导致进程级钉模型。

| 配置字段 | 含义 |
|---|---|
| mode | 模式标识（横幅/诊断语义；不影响路由），必填 |
| provider | 该模式的 provider；与 model 同时缺省时不固定路由（透传） |
| model | 该模式的模型；与 provider 同时缺省时不固定路由（透传） |
| reasoningEffort | 可选推理强度；缺省时清除继承值，交由 provider 默认 |

机制：监听 system-prompt/assemble（注入 {{provider}}/{{model}} 提示词变量）与 agent/request（next() 后覆盖路由），两处均 prepend，保证覆盖入口的会话级选择。

**与 UI 模型切换的优先级**：矩阵模型是模式的默认路由，但用户在 UI 显式切换模型后，本次任务的顶层路由（与 persona 展示）跟随用户选择。判定规则（依据请求瀑布流解析出的入口选择）：

1. 入口选择 == 矩阵模型 → 钉住矩阵模型（无操作）；
2. 会话尚无任何请求（blank）且入口选择 == 挂载时的部署默认模型 → 视为未选择，钉住矩阵模型；
3. 会话已跑过请求且刚发生 preset 切换（/mode 或 UI 选择，日志中 agent-preset/selected 在最后一次 request/header 之后）且入口选择 == 切换前的路由 → 新模式认领矩阵模型；
4. 其余情况 → 入口选择与矩阵模型不同 = 用户显式切换：请求与 persona 变量均保持用户选择，本行在共享状态 `shared.js`（按顶层 agent 对象为键的 WeakMap）上记录用户选择，omd-task 行据此把 deep tier 路由到用户选择的模型。

模型体验：persona 文本每次请求固定携带实际路由模型的声明；模式模型路由在 agent 生命周期内稳定（KV 前缀稳定）。

## 行：omd-task

tier 差异化子代理委派（等价 OMD 的 task(category=…)）。仅限 preset 作用域内挂载。

| 配置字段 | 默认 | 含义 |
|---|---|---|
| provider | spawn | 子代理提供方 |
| toolName | omd_task | 模型可见工具名（同 preset 内唯一） |
| backgroundMode | continuable | continuable（默认后台，run_in_background:false 转前台）或 foreground |
| tiers | 必填 | tier 名 → { provider(必), model(必), hint?, persona?, toolFilter?: {allow?, deny?}, maxTokens? }；tier 名匹配 [a-z0-9][a-z0-9_-]* |
| defaultTier | 无 | 模型未传 tier 时的默认档（单 tier 时自动） |
| maxDepth | 3 | 委派深度上限；provider-managed 表示交提供方 |

模型可见参数：description（展示名）、prompt、tier（枚举见工具描述）、run_in_background（仅 continuable 模式）。工具描述枚举各 tier 的 hint 与模型，模型据此选型。

**deep tier 与用户模型覆盖**：用户在 UI 显式切换模型后（omd-mode 让路并在 `shared.js` 里记录用户选择），名为 `deep` 的 tier 改用用户选择的模型（provider/model 整体替换），其余 tier 保持矩阵配置。

## CLI：omd-dsh

```
omd-dsh <command> [--dry-run]
```

- `omd-dsh sync` — 把 presets/ 与 vendored 行模块同步到 `<DSH_HOME>/.agent-presets/`（hash 保护、orphan 报告、非管理目录零操作）。每个 preset 的 omd-mode / omd-task 行由用户矩阵 `<DSH_HOME>/omd-matrix.json` 渲染。不需要任何 harness 路径配置。
- `omd-dsh setup` — 交互式向导：先读取 DSH 已有模型，再引导逐模式/逐 tier 选择模型，写回 `<DSH_HOME>/omd-matrix.json` 并可选立即同步。
- `omd-dsh models` — 打印发现的 DSH 模型目录（非交互）。

自包含 bundle 的构建细节见仓库根 README「为什么不需要配置 harness 路径」。

## 集中配置：<DSH_HOME>/omd-matrix.json 与 settings.yaml 命名空间

所有模式的模型路由（provider/model/reasoningEffort）与 omd_task 各 tier 的模型集中在用户矩阵里。两种入口，同一份数据：

- **在线编辑（推荐）**：设置 →「omd模型分配」。保存写入 `settings.yaml` 的 `omd-model-allocation` 命名空间，宿主立即重渲染 presets 并把矩阵镜像回 `<DSH_HOME>/omd-matrix.json`。
- **CLI**：`omd-dsh setup`（交互向导）/ 手改 `omd-matrix.json` 后 `omd-dsh sync`。宿主运行中直接改文件不会实时生效；下次重启时宿主把文件导入命名空间（与「新会话重新 sync」语义一致）。

`omd-dsh sync` 首次运行把随包的 deepseek 默认矩阵 `omd-matrix.default.json` 复制为默认配置（或从旧版本包内位置迁移一次）。仓库与 npm 包只携带默认矩阵文件，**不含任何个人模型配置**——个人模型配置只留在本机（`~/.dsh/settings.yaml` 或 `~/.dsh/omd-matrix.json`）。preset 里 `# [omd-dsh:mode:start] / [omd-dsh:mode:end]` 与 `# [omd-dsh:task:start] / [omd-dsh:task:end]` 之间的区域是自动生成的——改模型请走设置页或矩阵后跑 sync，不要手改 fence 之间的内容。

## 开发

```bash
npm install     # 触发 build（tsc + esbuild 打包自包含 bundle + 客户端 bundle）
npm test        # vitest 全量测试
npm pack        # prepack 自动重建，产出 tgz
```

构建产出：`lib/host.js`（宿主行）、`lib/client.js`（客户端 bundle，`window.__ModuleLoader__.load` 信封 + esbuild CJS，仅外部依赖 react）、`lib/vendor/*.mjs`（自包含行 bundle）。测试桩在 test/stubs/（dsh-tools/dsh-subagent 的轻量替身），不依赖真实 harness；`test/sync.test.ts` / `test/host.test.ts` / `test/client-store.test.ts` 覆盖矩阵注入渲染、启动调和判定与客户端保存状态机。


### 子代理透传语义

omd-mode 对 subagentDepth > 0 的子代理一律透传（不覆盖 provider/model/变量）：
omd-task 的 tier 模型通过显式 agentOptions 生效；顶层 agent 才被钉到模式模型
（除非用户显式切换模型——此时顶层跟随用户选择，deep tier 通过 `shared.js` 里
按 agent 记录的覆盖值同步）。
这保证「强模型顶层 + tier 差异化子代理」的优先级正确。

### toolFilter 注意

tiers 里的 toolFilter.deny/allow 只能点名该 preset 工具层中真实存在的工具名，
否则子代理创建会被 DSH 以工具层错误拒绝。只读模式的 tiers 建议不配 toolFilter。

