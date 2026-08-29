# omd-dsh

> DeepSeek Harness（DSH）的多模式智能体插件 —— 7 个开箱即用的模式，每个模式固定一套能力边界 + 一个模型，`omd_task` 按 tier 把重复/深度工作委派给不同档位的子代理。

[![npm version](https://img.shields.io/npm/v/@carljia/omd-dsh)](https://www.npmjs.com/package/@carljia/omd-dsh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 这是什么

omd-dsh 给 DSH 增加 7 个「模式」（agent preset）。每个模式 = 一套固定的工具边界 + 一个模型路由；同一模式内，`omd_task` 把重复调查/机械活派给便宜模型（fast），把深度推理派给强模型（deep）——「强模型顶层 + 性价比模型做重复工作」。

## 能力来自 DSH 原生

omd-dsh **不重复造轮子**，它是一层很薄的「接线 + 组织」：核心能力大多指向 DSH 原生机制，本插件只负责决定「每个模式用哪些原生能力、配哪个模型」。

| omd 特性 | 指向的 DSH 原生能力 |
|---|---|
| 自动续跑 / `/ulw` | DSH 原生 `goal` + goal-round-driver |
| 多智能体 fan-out | DSH 原生 `workflow` |
| fresh-agent 迭代 | DSH 原生 `ralph` |
| tier 子代理委派 | DSH 原生 `subagent`（`omd_task` 只是暴露 per-request 模型/persona 选择） |
| 规划访谈 | DSH 原生 `plan-mode` + `exit_plan_mode` |
| PTC（Code Mode） | DSH 原生 `dsh-agent-tool-presentation`（mode: code）+ 宿主 `dsh-code-runtime` |
| 只读/无 shell 边界 | DSH 原生 preset 工具组合（非自研沙箱） |
| 技能 / MCP / 终端 | DSH 原生 skills / mcp-client / bash·pwsh |

## 7 个模式

| 模式 | 定位 | 能力边界 |
|---|---|---|
| `omd-executor` | 全自主执行 | 完整工具集 + goal / ralph / workflow / 委派 |
| `omd-ultraworker` | 超能工作者 | 完整工具集 + goal / workflow / 委派 + PTC（Code Mode） |
| `omd-planner` | 规划访谈 | 只读 + 委派（DSH 原生 plan-mode） |
| `omd-reviewer` | 评审 | 只读 |
| `omd-explorer` | 代码侦察 | 只读 |
| `omd-librarian` | 文献研究 | 只读 |
| `omd-chat` | 纯对话 | 无 fs / shell |

各模式的模型集中在 **`~/.dsh/omd-matrix.json`**（首次 `omd-dsh sync` 自动从随包的 deepseek 默认矩阵生成），可用 `omd-dsh setup` 逐项改。

## 安装

**前置要求**：已装 DeepSeek Harness（`dsh`）、Node.js ≥ 20。

### 方式一：dsh plugin（推荐，一键）

```bash
dsh plugin --profile web add @carljia/omd-dsh
```

装完**重启 `dsh web`**：插件在启动时自动把 7 个模式写入 `~/.dsh/.agent-presets` 并生成模型矩阵，preset 选择器里直接就能选，无需再手动 `omd-dsh sync`。

> `dsh plugin` 本质是转发给 pnpm（即从 npm 装包）。本插件声明了 `dsh.bundle`，因此会被自动登记为 profile 层并在启动时生效（boot 行做幂等同步；行模块是自包含 bundle，不依赖任何 harness 路径）。

### 方式二：npm 全局安装

```bash
npm i -g @carljia/omd-dsh
omd-dsh sync   # 手动把 7 个模式写入 ~/.dsh/.agent-presets（bundle 安装时这一步自动完成）
```

### 方式三：从源码（GitHub clone）

```bash
git clone https://github.com/jiazz197-cmyk/omd-dsh.git
cd omd-dsh
npm install     # 装依赖 + 触发 build
npm link        # 全局 omd-dsh 命令
```

## 使用

> **安装后即可用**：`dsh plugin add` 装完重启，7 个模式会自动出现（启动时已同步）。用 `npm i -g` 安装的，先跑一次 `omd-dsh sync` 再重启 `dsh web`。改模型用 `omd-dsh setup`。

```bash
omd-dsh sync    # 手动把 7 个模式写入 ~/.dsh/.agent-presets（bundle 安装时启动已自动执行）
omd-dsh setup   # 交互式：逐模式 / 逐 tier 选模型，再同步
omd-dsh models  # 列出发现的模型
```

### 为什么不需要配置 harness 路径

`sync` / `setup` 不需要知道 DSH 装在哪里：`.omd-vendor/` 里的行模块是**自包含 bundle**（构建时把 schemastery / dsh-tools / dsh-llm / dsh-subagent 全部打进模块，见 `scripts/postbuild.mjs`），不含任何 `@deepseek-ai/*` 导入，因此不存在"导入指向的 harness 树与运行进程不一致"的问题——无论 DSH 从 npx 缓存、全局 npm 还是 profile bundles 加载 agent 机制，行模块都能挂载。preset 组合里其余的裸包名行（如 `@deepseek-ai/dsh-persona`）由 harness 自己的 loader 在运行时按宿主 base 解析，天然正确。

（旧版曾有 `--harness` 参数与"定位 DSH harness"逻辑，用于把行模块导入改写为 harness 树的绝对 URL；自 0.1.8 起改为自包含 bundle 后已移除，再也不用配置。）

同步后启动 `dsh web`，preset 选择器里就会出现 7 个 OMD 模式，新建会话即可用。

## `/ulw` — 一键 ultrawork

在 **omd-executor** 会话里输入：

```
/ulw <任务>
```

会为这个任务挂一个 goal 并自动续跑，直到完成——**一键触发，不干完不罢休**。它等价于「executor 模式 + goal 自动续跑」的组合。

## 规划 → 执行闭环（planner → start work）

规划访谈（`omd-planner`）批准计划后，工作流自动收尾：

1. 计划批准时，**计划文件自动落盘**到项目根目录的 `/.omd/plans/`（目录约定由插件代码写死，不出现在任何提示词里）；
2. planner 的最终回复以**定死的 Start Work 收尾**，给出计划文件名和两种启动方式；
3. 启动执行二选一：
   - **新开会话**：在 omd-executor（或 omd-ultraworker）会话运行 `/start-work <计划文件名>`，自动挂 goal 并续跑执行；
   - **同一会话**：直接运行 `/mode omd-executor` 切换模式后继续。

## `/start-work` — 按计划文件开工

在 **omd-executor / omd-ultraworker** 会话里输入：

```
/start-work <计划文件名>
```

解析 `/.omd/plans/` 下的计划文件（裸文件名、`.md`、完整相对路径均可），挂一个 goal 自动续跑，直到计划执行完成。与 `/ulw` 同一机制，只是任务文本换成「执行某个计划文件」。

## `/mode` — 同一对话内切换模式

所有 7 个模式都注册了 `/mode`：

```
/mode omd-executor      # 或 /mode executor
```

它把**当前会话**重新 compose 到目标 omd preset——包括已经开始对话的会话（工具集、persona、模型路由全部切换，并记录切换事件保证 resume/fork 一致；若计划模式仍开启会自动关闭）。

> ⚠️ 说明：DSH 官方 API 只允许空会话切换 preset；`/mode` 在插件层做的是会话内 recompose，并已用「planner 工具目录 ⊆ executor 工具目录」等设计缓解历史渲染问题。切换只允许在 7 个 omd 模式之间进行。

## 改模型

模型矩阵保存在 **`~/.dsh/omd-matrix.json`**（DSH_HOME 下）：首次 `omd-dsh sync` 会把随包发布的 **deepseek 默认矩阵**（`omd-matrix.default.json`）自动复制为你的默认配置（个人模型配置只留在本机，不进 git/npm）；此后跑 `omd-dsh setup` 逐项改，或直接编辑该文件后 `omd-dsh sync`。每次 sync 输出都会提醒可用 `omd-dsh setup` 自定义模型矩阵。

> ⚠️ preset 里 `# [omd-dsh:mode:start]` … `# [omd-dsh:mode:end]` 之间的区域是自动生成的，**不要手改**——改模型请改矩阵后跑 sync。

## License

[MIT](LICENSE)
