# 架构说明

## 总体结构

```
subagent_router/
└── packages/omo-dsh/                 # npm 插件包 @subagent-router/omo-dsh
    ├── src/index.ts                  # omo-mode 行：按模式固定模型路由
    ├── src/task.ts                   # omo-task 行：tier 差异化子代理委派
    ├── src/cli.ts                    # omo-dsh sync：vendored 分发 + harness 锚定
    ├── presets/omo-{7 模式}/          # agent.cordis.yml + preset.yml
    └── lib/vendor/omo-{mode,task}.mjs # 构建产物（sync 改写导入后落盘）
```

部署形态：

```
<DSH_HOME>/.agent-presets/           # DSH 用户 preset 根（includeUserRoot 默认开启）
├── omo-executor/ ... omo-chat/       # 7 个模式（含 .omo-meta.json）
└── .omo-vendor/                      # 点前缀目录，preset 发现会跳过
    ├── omo-mode.mjs                 # 导入已改写为 harness 树 file:// URL
    └── omo-task.mjs
```

## omo-mode：按模式配模型的机制

DSH 入口（web/headless）创建 agent 时通过 installModelSelection(agent.ctx, selection) 安装会话级模型选择：

- system-prompt/assemble waterfall：把 provider/model 写入提示词变量（persona 的 {{model}} 来源）；
- agent/request waterfall：在 next() 之后把 provider/model/reasoningEffort 覆盖进请求路由。

omo-mode 与此同构，但用组合配置里的固定值，并注册时带 prepend: true：

```
waterfall 展开顺序（最外层先执行）
  omo-mode(assemble) ──▶ installModelSelection(assemble) ──▶ 内层组装
  omo-mode(request)  ──▶ installModelSelection(request)  ──▶ 内层路由
```

omo-mode 的监听器在最外层：它先调用 next() 让入口监听器跑完，再把自己的 provider/model 覆盖上去——所以模式配置永远赢过会话选择，这正是「每个模式配自己的模型」。未配置 provider/model 时两个监听器完全透传（退化横幅展示），因此该行可安全挂进任何 preset。

scope-only 守卫：无作用域挂载会钉死进程内所有 agent 的模型，直接拒绝（仿 dsh-persona 的先例）。

## omo-task：tier 差异化委派的机制

内置 dsh-tool-subagent 的 Config 里 agentOptions/persona/toolFilter 是每实例固定的（README 明示：换模型/换 persona 需要另一个名字不同的工具实例），模型无法按次选模型。

但 dsh-subagent 服务本身支持 per-request 的 agentOptions/persona/toolFilter（resolveChildAgentOptions 显式覆盖父级继承）。omo-task 把这个能力暴露给模型：

```
模型调用 omo_task { prompt, tier: "investigate", run_in_background? }
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

1. 行模块以相对路径挂在 preset 里（../.omo-vendor/*.mjs），与 package 解耦；
2. sync 把行模块中所有裸 @deepseek-ai/* 导入改写为指向 harness node_modules 的绝对 file:// URL（harness 根 = dsh 可执行文件定位，--harness 可覆盖）；
3. 于是行模块与 harness 共享同一实例的 dsh-scope / cordis / schemastery / dsh-tools / dsh-subagent，符号单实例。

裸包名安装（dsh plugin --profile web add <tgz>，preset 行写包名）仍可用，但需注意 profile node_modules 与 harness 树是两个实例；文档默认推荐 vendored 路径。

## sync 的写入安全

- 只写 omo-* 与 .omo-vendor 目录；每目录 .omo-meta.json 记录来源版本与逐文件 sha256。
- 目标文件 hash == 当前源 → up-to-date 跳过；== 上次源 → 覆盖升级；否则视为本地修改 → conflict 不覆盖。
- 包内已移除的模式目录 → 报告 orphan，绝不自动删除。

## preset 发现与行解析（DSH 原生机制）

- dsh-agent-presets 默认 includeUserRoot：扫描 <DSH_HOME>/.agent-presets；目录名不合 [a-z0-9][a-z0-9-]* 的（如 .omo-vendor）被跳过。
- 行名是相对路径时从 preset 目录解析（../.omo-vendor/omo-mode.mjs）；是裸包名时从宿主 base（profile 目录）解析；是绝对路径时保留。
- running 会话按代际继续使用已挂载组合；编辑 preset 文件只影响之后创建的会话。改坏 YAML 的 preset 会被列为 broken 并显示原因。

## Team Mode 映射（v1 未实现，文档方向）

OmO 的 team mode（lead + members、共享任务表、mailbox）在 DSH 的对应物：

- 并行多成员 = workflow 工具（multi-agent fan-out，structured results）；
- 长期单一目标 = goal 工具（round-driven 自动续跑）；
- 新上下文迭代 = ralph 工具（fresh-agent rounds）；
- 共享工作区 = 子代理会话与文件系统。

v2 方向：/omo 切换命令（host 层 commands registry，需要 bundle patch）、Settings 页 live 编辑模式模型（settings namespace）。

