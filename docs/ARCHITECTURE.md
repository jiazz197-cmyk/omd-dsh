# 架构说明

## 总体结构

```
subagent_router/
└── packages/omd-dsh/                 # npm 插件包 @carljia/omd-dsh
    ├── src/host.ts                   # 宿主行（包根）：settings 命名空间 + 调和 + 渲染
    ├── src/index.ts                  # omd-mode 行：按模式固定模型路由
    ├── src/task.ts                   # omd-task 行：tier 差异化子代理委派
    ├── src/client.tsx                # 浏览器 half：设置页「omd模型分配」
    ├── src/omd-matrix-controller.ts  # 客户端编辑状态机（无 React，可单测）
    ├── src/cli.ts                    # omd-dsh sync/setup/models CLI
    ├── presets/omd-{7 模式}/          # agent.cordis.yml + preset.yml
    ├── lib/host.js                   # 宿主行构建产物
    ├── lib/client.js                 # 客户端 bundle（信封 + esbuild CJS，仅外部依赖 react）
    └── lib/vendor/omd-{mode,task}.mjs # 构建产物（esbuild 自包含 bundle，sync 原样落盘）
```

部署形态：

```
<DSH_HOME>/.agent-presets/           # DSH 用户 preset 根（includeUserRoot 默认开启）
├── omd-executor/ ... omd-chat/       # 7 个模式（含 .omd-meta.json）
└── .omd-vendor/                      # 点前缀目录，preset 发现会跳过
    ├── omd-mode.mjs                 # 自包含 bundle：无 @deepseek-ai 导入，与 harness 树无关
    ├── omd-task.mjs
    └── shared.js                    # 两行共享的按 agent 键控状态（WeakMap），无导入
```

## omd-mode：按模式配模型的机制

DSH 入口（web/headless）创建 agent 时通过 installModelSelection(agent.ctx, selection) 安装会话级模型选择：

- system-prompt/assemble waterfall：把 provider/model 写入提示词变量（persona 的 {{model}} 来源）；
- agent/request waterfall：在 next() 之后把 provider/model/reasoningEffort 覆盖进请求路由。

omd-mode 与此同构，但用组合配置里的固定值，并注册时带 prepend: true：

```
waterfall 展开顺序（最外层先执行）
  omd-mode(assemble) ──▶ installModelSelection(assemble) ──▶ 内层组装
  omd-mode(request)  ──▶ installModelSelection(request)  ──▶ 内层路由
```

omd-mode 的监听器在最外层：它先调用 next() 让入口监听器跑完，再决定是否把自己的 provider/model 覆盖上去。

**与 UI 模型切换的优先级（v0.1.3+）**：矩阵模型是模式的默认路由，但用户在 UI
显式切换模型后让路。判定基于瀑布流解析出的入口选择（installModelSelection
应用后的 resolved 值），规则：

1. 入口选择 == 矩阵模型 → 钉住（无操作）；
2. 会话 blank（无 request/header）且入口选择 == 挂载时快照的部署默认模型（d0）→
   视为「未选择」，钉住矩阵模型。d0 必须静态快照：session.selectModel 每次都会把
   用户选择写回全局默认（agentDefaultModel），动态读取会把用户选择误判为默认；
3. 会话已跑过请求且「agent-preset/selected 事件在最后一次 request/header 之后」
   （/mode 或 UI 切换刚发生，事件在 recompose 之后才入日志，因此必须每次实时计算）
   且入口选择 == 切换前的路由 → 新模式认领矩阵模型；
4. 其余情况（入口选择 ≠ 矩阵模型）→ 用户显式切换：请求与 persona 变量保持用户选择，
   并在共享状态（.omd-vendor/shared.js 的 WeakMap，键为顶层 agent 对象）上记录用户选择，
   omd-task 的 deep tier 沿用。注意不能往 cordis 作用域 ctx 上写自定义属性：
   ctx 是 Proxy，未声明属性赋值会抛 "cannot set property ... without provide"
   （曾导致全部 omd preset 挂载失败），且同一 preset 内各行 ctx 是兄弟节点、互不可见；
   因此共享状态必须走两个行模块共同 import 的共享模块。

子代理（subagentDepth > 0）仍一律透传（见下节），不参与判定、不更新 omdModeOverride。
未配置 provider/model 时两个监听器完全透传（退化横幅展示），因此该行可安全挂进任何 preset。

scope-only 守卫：无作用域挂载会钉死进程内所有 agent 的模型，直接拒绝（仿 dsh-persona 的先例）。

## omd-task：tier 差异化委派的机制

内置 dsh-tool-subagent 的 Config 里 agentOptions/persona/toolFilter 是每实例固定的（README 明示：换模型/换 persona 需要另一个名字不同的工具实例），模型无法按次选模型。

但 dsh-subagent 服务本身支持 per-request 的 agentOptions/persona/toolFilter（resolveChildAgentOptions 显式覆盖父级继承）。omd-task 把这个能力暴露给模型：

```
模型调用 omd_task { prompt, tier: "investigate", run_in_background? }
        │
        ├─ tier → { provider, model, maxTokens }  → request.agentOptions
        ├─ tier → persona                        → request.persona（子代理 persona）
        ├─ tier → toolFilter                     → request.toolFilter（子代理全局工具限制）
        └─ run_in_background ≠ false ── startContinuable → { kind: "continuable", subagentId }
           run_in_background = false  ── start + settleForegroundRun → { kind: "foreground", output }
```

tier 解析顺序：显式 tier → defaultTier → 单 tier 自动选择 → 报错并列出合法 tier（模型自纠）。工具描述与 tier 参数描述里枚举全部 tier 的 hint 与模型，模型据此选型。

## vendored 分发与自包含 bundle（v0.1.8+）

行模块以相对路径挂在 preset 里（`../.omd-vendor/*.mjs`），与 package 解耦。**关键设计：行模块是
自包含 bundle**——`scripts/postbuild.mjs` 用 esbuild 把 schemastery（Config）、dsh-tools
（defineTool）、dsh-llm（createUserMessage）、dsh-subagent（assertSubagentMaxDepth）全部打进
模块，行模块不含任何 `@deepseek-ai/*` 导入，因此 sync **不需要知道 harness 树**，也不存在
"导入指向的树与运行进程不一致"的问题。为什么可以这样打：

- loader 用行模块自带的 `Config` 校验配置（schemastery schema 自包含，跨实例安全）；
- `ctx.tools.register` 对 defineTool 的返回对象只做结构校验（name/output.schema/timeoutMs），
  无 instanceof/symbol 依赖；
- `createUserMessage` / `assertSubagentMaxDepth` 是纯函数/纯对象构造；
- 行模块用到的其余能力（ctx.on / ctx.inject / ctx.get、tools/subagents/systemPrompt/commands
  等服务）都是 harness 侧的 ctx 方法与服务，与行模块导入无关。

**唯一例外：shared.js**。omd-mode 与 omd-task 共享的按 agent 键控状态（WeakMap）必须同一模块
实例，因此它作为相对兄弟模块（`./shared.js`）原样落盘，两个 bundle 解析到同一 URL。

**为什么移除了 scope 守卫**（index/task/mode/plan/startwork 各行的 `scopeOf(ctx)` 检查）：
bundle 内自带的 dsh-scope 副本永远读不到 harness 实例写入的 kScope Symbol，守卫在跨实例场景
必然误报——v0.1.4~v0.1.7 时代它曾两次导致全部 omd preset 挂载失败。事件路由不受影响：
作用域过滤（scopeTarget）在 harness 自己的 dsh-scope 实例里运行，行监听器注册在带标签的 ctx
上即可收到事件。代价是失去"误挂全局组合"的编译期拦截——该场景后果（进程级钉模型）立即可见，
且 preset 组合由 sync 模板保证。裸包名行（如 `@deepseek-ai/dsh-persona`）由 harness loader
在运行时按宿主 base 解析，天然与宿主同实例。

历史（v0.1.7 及以前）：曾用"把行模块的 @deepseek-ai/* 导入改写为指向 harness 树的绝对
file:// URL"来保证单实例，并配套 `--harness` 参数/自动检测。实测教训（2026-08-29）：dsh web
的 bin 位于 npx 缓存树，但 agent/preset 机制（dsh-base / dsh-web-app bundles）可能从 profile
树（profiles/node_modules，含全局 npm 安装的 junction）加载——改写目标若与运行进程实际加载
的树不一致，kScope 符号失配，所有 omd 行挂载时报 "refusing to mount outside a scoped
context"。自 v0.1.8 起该机制整体移除。

## sync 的写入安全

- 只写 omd-* 与 .omd-vendor 目录；每目录 .omd-meta.json 记录来源版本与逐文件 sha256。
- 目标文件 hash == 当前源 → up-to-date 跳过；== 上次源 → 覆盖升级；否则视为本地修改 → conflict 不覆盖。
- 包内已移除的模式目录 → 报告 orphan，绝不自动删除。

## preset 发现与行解析（DSH 原生机制）

- dsh-agent-presets 默认 includeUserRoot：扫描 <DSH_HOME>/.agent-presets；目录名不合 [a-z0-9][a-z0-9-]* 的（如 .omd-vendor）被跳过。
- 行名是相对路径时从 preset 目录解析（../.omd-vendor/omd-mode.mjs）；是裸包名时从宿主 base（profile 目录）解析；是绝对路径时保留。
- running 会话按代际继续使用已挂载组合；编辑 preset 文件只影响之后创建的会话。改坏 YAML 的 preset 会被列为 broken 并显示原因。

## Team Mode 映射（v1 未实现，文档方向）

OMD 的 team mode（lead + members、共享任务表、mailbox）在 DSH 的对应物：

- 并行多成员 = workflow 工具（multi-agent fan-out，structured results）；
- 长期单一目标 = goal 工具（round-driven 自动续跑）；
- 新上下文迭代 = ralph 工具（fresh-agent rounds）；
- 共享工作区 = 子代理会话与文件系统。

v2 方向：/omd 切换命令（host 层 commands registry，需要 bundle patch）。设置页 live 编辑模式模型（settings namespace）已在 v0.1.9 实现，见下节。

## settings 命名空间数据流（「omd模型分配」设置页）

**权威存储**：`settings.yaml` 的命名空间 `omd-model-allocation`（宿主行 `lib/host.js` 注册，`base` = 随包默认矩阵 `omd-matrix.default.json`，`applies: "live"`——保存后新会话即生效）。`omd-matrix.json` 降级为**导出镜像 + CLI 兼容面**（`omd-dsh setup`/`sync` 继续读写它）。

```
启动（宿主行 apply）
  settings.register(NS, MatrixSchema, { base: 默认矩阵, applies: "live" })
    └─ 调和（一次）：readMatrixFileIfExists() 与 scope.get() 不同 → scope.replace(file)
       （CLI/旧版自定义导入命名空间；CLI 手改在下次重启被采纳）
  resolved = scope.get() → saveMatrix(resolved)（镜像）→ runSyncWithMatrix(resolved)
  scope.watch(next => saveMatrix(next) + runSyncWithMatrix(next))   ← UI 每次保存触发

UI 保存（浏览器 half lib/client.js）
  api.settings.replace({ ns, section: 完整矩阵 draft, expectedRevision: scope.revision })
    ├─ ok           → mirror 经 settings/document-updated 自动重载；宿主 watch 重渲染 presets
    └─ settings-rejected（冲突/校验失败）→ 展示错误 + describe.load() 重载最新值
```

关键点：

- **包根注入名**：`cordis.patch.yml` 注入的行名是 `@carljia/omd-dsh`（包根）而不是 `/boot` 子路径——`dsh-client-modules` 按 loader entry `options.name` == 包名发现客户端插件（读 `dsh.client.platform === "web"` 与 `exports["./client"]`），浏览器 half 由此被加载。客户端 bundle（`lib/client.js`）是 `window.__ModuleLoader__.load({ id: 包名, factory })` 信封 + esbuild CJS（仅外部依赖 `react`，其余全部来自 cordis 服务注入：slots/locale/connection/settingsScope——客户端 bundle 纯度门禁禁止跨插件值导入）。
- **schema**：`MatrixSchema`（schemastery，与 `omd-matrix.json` 对齐）所有字段可选，`base` 补齐；未知键透传（schemastery object 非 strict）。settings.yaml 段损坏 → register 抛错 → 宿主 catch 回退纯文件 sync（老 boot 行为），不阻断启动。
- **客户端校验**：`settingsScope.bind({ namespace })` 无 decode 时用 wire schema（`settings.describe` 下发的 `schema.toJSON()`）校验解析值，校验失败则 status 停在 loading（页面显示加载中，不渲染半截数据）。
- **并发**：客户端带 `expectedRevision`，冲突时宿主 `SettingsConflictError`（code `SETTINGS_CONFLICT`，wire 映射为 `settings-rejected`）拒绝写入；UI 提示并重载。镜像写回失败只记日志——下次启动会从 settings.yaml 重新渲染并重建镜像。
- **运行中会话**：保存后仅新会话按新矩阵（preset 组合在会话创建时挂载，与现有语义一致）。远程浏览器（非 loopback）settings RPC 仅进程内 → 设置页显示不可用/只读。
- **宿主行与 boot 行的关系**：`lib/boot.js`（`/boot` 子路径）保留为无 settings 场景的手动回退行；`lib/host.js` 是包根默认行（`main`），两者共用 `runSync` / `runSyncWithMatrix` 内核。


## omd-mode 与子代理的优先级（差异化委派的关键）

子代理通过 composeFrom 加入父级 preset 的同一份常驻组合，因此 omd-mode 的
agent/request 监听器同样会作用于子代理。若不设防，模式模型会压回子代理的
tier 模型（实测复现：tier 子代理的 header 显示父模式模型）。

规则：**omd-mode 对 subagentDepth > 0 的子代理一律透传**。于是：

- omd-task 的 tier 通过显式 agentOptions 落到子代理的 AgentOptions，成为其
  路由（tier 模型 > 模式模型，实测证明）；
- 无显式 agentOptions 的子代理按 DSH 原生语义继承父级入口选择；
- 顶层 agent（subagentDepth 缺省/0）默认被本行钉到模式模型；用户显式切换
  模型后顶层跟随用户选择，且 deep tier 同步为用户选择的模型（omd-task
  在 execute 时读取 shared.ts 的 WeakMap（键为调用 agent 对象）上的用户选择，
  仅替换名为 `deep` 的 tier 的 provider/model，其余 tier 保持矩阵配置）。

已知边界（DSH 架构决定，服务端无法区分）：
- 入口选择（`selection.current`）由 api-proxy 持有（WeakMap 闭包），preset
  内插件不可见，只能观察瀑布流 resolved 值与会话日志；
- 因此「blank 会话 + 用户恰好选择了挂载时的部署默认模型」与「未选择」不可区分：
  该次请求会钉到矩阵模型，下一请求起跟随用户选择；
- 新会话在首次请求前，UI 模型座显示部署默认模型而非矩阵模型（显示层由入口
  持有，服务端无法改写）；首次请求后显示与实际路由一致。

## 已知约束

- **toolFilter 只能点名子代理工具层中真实存在的工具**：deny/allow 中出现
  未知工具名时，子代理创建会以工具层错误拒绝（实测复现：planner 的 tiers
  deny 了其组合中不存在的 pwsh/bash 导致调用失败）。因此只读模式的 tiers
  不配 toolFilter——只读边界由组合本身决定；全量模式的 tiers 才 deny
  write/edit/pwsh/bash。
- 运行中的进程按 ESM URL 缓存 vendored 行模块：升级 omd-dsh 后需重启
  harness 进程，新版本才会被 preset 挂载加载。

