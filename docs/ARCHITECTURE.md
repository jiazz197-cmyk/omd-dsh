# 架构说明

## 总体结构

```
subagent_router/
└── packages/omd-dsh/                 # npm 插件包 @carljia/omd-dsh
    ├── src/index.ts                  # omd-mode 行：按模式固定模型路由
    ├── src/task.ts                   # omd-task 行：tier 差异化子代理委派
    ├── src/cli.ts                    # omd-dsh sync：vendored 分发 + harness 锚定
    ├── presets/omd-{7 模式}/          # agent.cordis.yml + preset.yml
    └── lib/vendor/omd-{mode,task}.mjs # 构建产物（sync 改写导入后落盘）
```

部署形态：

```
<DSH_HOME>/.agent-presets/           # DSH 用户 preset 根（includeUserRoot 默认开启）
├── omd-executor/ ... omd-chat/       # 7 个模式（含 .omd-meta.json）
└── .omd-vendor/                      # 点前缀目录，preset 发现会跳过
    ├── omd-mode.mjs                 # 导入已改写为 harness 树 file:// URL
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

## vendored 分发与跨树符号风险

关键事实：dsh-scope 的 kScope 是模块局部 Symbol（cordis 的 Context 符号同理）。如果插件包被 pnpm/npm 装进 profile node_modules（与 harness 树不同实例），插件的 scopeOf 读取不到 harness 写入的标签——scope 守卫会误报、作用域监听器会失聪。

对策（sync 的默认路径）：

1. 行模块以相对路径挂在 preset 里（../.omd-vendor/*.mjs），与 package 解耦；
2. sync 把行模块中所有裸 @deepseek-ai/* 导入改写为指向 harness node_modules 的绝对 file:// URL（harness 根 = dsh 可执行文件定位，--harness 可覆盖）；
3. 于是行模块与 harness 共享同一实例的 dsh-scope / cordis / schemastery / dsh-tools / dsh-subagent，符号单实例。

裸包名安装（dsh plugin --profile web add <tgz>，preset 行写包名）仍可用，但需注意 profile node_modules 与 harness 树是两个实例；文档默认推荐 vendored 路径。

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

v2 方向：/omd 切换命令（host 层 commands registry，需要 bundle patch）、Settings 页 live 编辑模式模型（settings namespace）。


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

