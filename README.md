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
| 只读/无 shell 边界 | DSH 原生 preset 工具组合（非自研沙箱） |
| 技能 / MCP / 终端 | DSH 原生 skills / mcp-client / bash·pwsh |

## 7 个模式

| 模式 | 定位 | 能力边界 |
|---|---|---|
| `omd-executor` | 全自主执行 | 完整工具集 + goal / ralph / workflow / 委派 |
| `omd-architect` | 深度构建 | 完整工具集 + goal / workflow / 委派 |
| `omd-planner` | 规划访谈 | 只读 + 委派（DSH 原生 plan-mode） |
| `omd-reviewer` | 评审 | 只读 |
| `omd-explorer` | 代码侦察 | 只读 |
| `omd-librarian` | 文献研究 | 只读 |
| `omd-chat` | 纯对话 | 无 fs / shell |

各模式的模型集中在一个 `omd-matrix.json` 里，可用 `omd-dsh setup` 逐项改。

## 安装

**前置要求**：已装 DeepSeek Harness（`dsh`）、Node.js ≥ 20。

### 方式一：npm（推荐）

```bash
npm i -g @carljia/omd-dsh
```

装完 `omd-dsh` 命令直接可用，无需其它步骤。

### 方式二：从源码（GitHub clone）

```bash
git clone https://github.com/jiazz197-cmyk/omd-dsh.git
cd omd-dsh
npm install     # 装依赖 + 触发 build
npm link        # 全局 omd-dsh 命令
```

## 使用

> ⚠️ **先同步，再使用**：安装只给你 `omd-dsh` 命令本身。必须跑一次 `omd-dsh sync`（或 `omd-dsh setup`）把 7 个 preset 写入 `~/.dsh/.agent-presets`，然后**重启 `dsh web`**——preset 选择器里才会出现这些模式、才能正常用。没同步之前，模式是「看不见也选不到」的。

```bash
omd-dsh sync    # 把 7 个模式写入 ~/.dsh/.agent-presets
omd-dsh setup   # 交互式：逐模式 / 逐 tier 选模型，再同步
omd-dsh models  # 列出发现的模型
```

### 定位 DSH harness（什么时候用 `--harness`）

`sync` / `setup` 需要找到 DSH 的 node_modules，会先尝试自动探测（`where dsh`）。**当你看到下面这个错误，就说明自动探测失败、该用 `--harness` 了：**

```
omd-dsh sync: cannot locate the DSH harness node_modules.
```

`--harness` 要传的是 **DSH 的 node_modules 目录**，这样找：

1. 先定位 `dsh` 可执行文件在哪：
   - Windows PowerShell：`Get-Command dsh`（或 `where dsh`）
   - macOS / Linux：`which dsh`
2. 从 `dsh` 所在路径往上一级级找，找到 `node_modules` 目录（里面应能看到 `@deepseek-ai\dsh-scope`）——这个目录就是 `--harness` 的值。

常见位置：

| DSH 安装方式 | node_modules 大概在哪 |
|---|---|
| 全局 `npm i -g` | 直接跑 `npm root -g`，它打印出来的就是 |
| `npx` 装的 | Windows：`%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules` |

用法：

```bash
omd-dsh sync --harness "<上面的 node_modules 路径>"
```

举例（Windows + npx）：

```bash
omd-dsh sync --harness "C:\Users\you\AppData\Local\npm-cache\_npx\xxxx\node_modules"
```

同步后启动 `dsh web`，preset 选择器里就会出现 7 个 OMD 模式，新建会话即可用。

## `/ulw` — 一键 ultrawork

在 **omd-executor** 会话里输入：

```
/ulw <任务>
```

会为这个任务挂一个 goal 并自动续跑，直到完成——**一键触发，不干完不罢休**。它等价于「executor 模式 + goal 自动续跑」的组合。

## 改模型

模型集中在 `omd-matrix.json`：跑 `omd-dsh setup` 逐项改，或直接编辑后 `omd-dsh sync`。

> ⚠️ preset 里 `# [omd-dsh:mode:start]` … `# [omd-dsh:mode:end]` 之间的区域是自动生成的，**不要手改**——改模型请改矩阵后跑 sync。

## License

[MIT](LICENSE)
