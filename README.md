# SubAgent Router — omo-dsh

把 **Oh My OpenAgent（OmO）** 的多模式智能体理念，以 **DeepSeek Harness（DSH）原生插件**形式迁移过来。

聚焦三件事：

1. **模式能力边界** —— 每个模式是一套 agent preset，工具行组合即确定性边界（只读模式根本没有 shell/edit 工具，模型看不见也调不了）。
2. **按模式配模型** —— 每个模式通过 omo-mode 行固定自己的 provider/model；改 YAML 即换模型，零代码。
3. **同模式差异化子代理调用** —— omo-task 工具按 tier 路由子代理：强模型做顶层规划与深度推理，性价比模型做内容调查与重复工作。

不搬 OmO 的行为限制长提示：plan / plan-executor / ultraworker 的编排直接复用 DSH 原生机制（dsh-plan-mode、goal、ralph、workflow、compaction）。

> 合规：本仓库为独立重实现，**不向 OmO 上游提交任何 PR**（见 [ATTRIBUTION.md](./ATTRIBUTION.md)）。

## OmO → DSH 概念映射

| OmO | DSH (本插件) |
|---|---|
| mode / agent（sisyphus、hephaestus、prometheus、oracle、explore、librarian…） | agent preset：omo-executor / omo-architect / omo-planner / omo-reviewer / omo-explorer / omo-librarian / omo-chat |
| 每个 agent 的 prompt | 每 preset 的 persona 行（简短横幅 + 定位 + 模型声明，不写行为长文） |
| 每个 agent 的 model / fallback 链 | omo-mode 行（provider/model/reasoningEffort） |
| agent 的 tools / permission | 工具行组合（挂什么有什么；不挂就看不见） |
| task(category=…) / call_omo_agent(subagent_type=…) | omo-task 工具 + tiers（每 tier = 固定模型 + persona + toolFilter） |
| omo.jsonc | <DSH_HOME>/.agent-presets/omo-*/agent.cordis.yml |
| plan 模式提示限制 | DSH 原生 dsh-plan-mode 行（不自定义） |
| ultrawork / plan-executor | DSH 原生 goal / ralph / workflow / compaction |
| team mode | 文档映射：preset 委派 + ralph + workflow（见 docs/ARCHITECTURE.md） |
| hooks | cordis waterfall 事件（agent/request、system-prompt/assemble） |

## 模式 × 模型 × 能力边界

| preset | 定位 | 默认模型 (deepseek-official) | 能力边界（工具组合） | omo-task tiers |
|---|---|---|---|---|
| omo-executor | 全自主执行 | deepseek-v4-pro | 完整工具集 + goal + ralph + workflow + 委派 | fast(v4-flash, 禁 edit/pwsh/bash/str_replace_editor) / deep(v4-pro) |
| omo-architect | 深度构建 | deepseek-v4-pro | 完整工具集 + goal + workflow + 委派（无 ralph） | fast / deep |
| omo-planner | 规划访谈（DSH 原生 plan-mode） | deepseek-v4-pro | 只读（read/grep/glob/web/ask-user/todo）+ omo-task；无 shell/edit | investigate(v4-flash 调查员) / review(v4-pro 评审员) |
| omo-reviewer | 评审 | deepseek-v4-flash | 只读（fs + fs-search + web） | — |
| omo-explorer | 代码侦察 | deepseek-v4-flash | 只读（fs + fs-search） | — |
| omo-librarian | 文献研究 | deepseek-v4-flash | 只读（fs + web） | — |
| omo-chat | 纯对话 | deepseek-v4-flash | web + ask-user + todo（无 fs/shell） | — |

「强模型顶层 + 性价比模型重复工作」的默认配置：planner/executor/architect 自身用 v4-pro；内容调查与机械工作委派给 v4-flash 的 tier。所有模型都可在 YAML 里换成任意已注册 provider/model（如 GLM 等，经 DSH 模型页注册的 pi-ai 提供方）。

## 安装

要求：可用的 DSH 安装（dsh 命令在 PATH 上）、Node.js ≥ 20。

```bash
git clone <本仓库> omo-dsh-repo && cd omo-dsh-repo
npm install                 # 安装 devDependencies 并触发 build
npm test                    # 36 个测试全绿
node packages/omo-dsh/lib/cli.js sync
# 或安装后全局使用：
npm install -g ./packages/omo-dsh
omo-dsh sync [--harness <harness node_modules 路径>] [--dry-run]
```

sync 把 7 个 preset 写入 <DSH_HOME>/.agent-presets/（DSH_HOME 未设置时为 ~/.dsh），并把两行 vendored 模块写入 .agent-presets/.omo-vendor/（点前缀目录不参与 preset 发现），其中的 @deepseek-ai/* 导入被改写为指向 harness 树的绝对 file:// 路径。

然后正常启动 DSH：`dsh web`。agent preset 选择器里出现 7 个 OMO 模式，空白会话可随时切换。

改模型 = 编辑 <DSH_HOME>/.agent-presets/omo-*/agent.cordis.yml 中 omo-mode 行的 provider/model（tiers 同理），下一会话生效。sync 重跑不会覆盖你的本地修改（hash 保护），会报告 conflict。

## 与 DSH 自带模式的兼容性

- **命名隔离**：omo- 前缀 id 与随附 standard（标准模式）/ minimal（极简模式）/ code（PTC 模式）/ cordis 零冲突，不遮蔽。
- **同步边界**：sync 只写自己管理的 omo-*/ .omo-vendor 目录（.omo-meta.json 标记），其它目录零操作。
- **行级不泄漏**：omo-mode / omo-task 都带 scope 守卫，只作用于挂载它的 preset；不写宿主 patch、不加 bundle、不改 dsh.profile。
- **行级可组合**：两行都是通用行，可加进任意 preset（含自带模式的用户副本）。

**配方：给标准模式固定模型 + 差异化委派**（PTC/极简同理）：

```bash
# 复制随附 standard preset（路径见 dsh 安装目录；或直接在 UI 里复制 preset）
cp -r <dsh 安装目录>/config/agent-presets/standard <DSH_HOME>/.agent-presets/std-pinned
# 编辑 std-pinned/agent.cordis.yml，在 persona 行后追加：
```

```yaml
- id: omo-mode
  name: ../.omo-vendor/omo-mode.mjs
  config:
    mode: std-pinned
    provider: deepseek-official
    model: deepseek-v4-pro
```

完整示例见 examples/pin-standard-mode.example.yml。

## 二开指南

新增模式：复制 packages/omo-dsh/presets/omo-chat 为 omo-<新id>，改 persona / omo-mode / 工具行（详见 CONTRIBUTING.md），重跑 build + sync。

## 安全说明

<DSH_HOME>/.agent-presets 是 DSH 的 user 信任根：一个 preset 就是一份可执行组合，其权限等同于 shell 用户。本插件的 sync 只写入受 .omo-meta.json 标记的目录，但请只安装你信任来源的 preset。

## 文档

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：omo-mode / omo-task 工作原理、vendored 分发与跨树符号风险、preset 发现机制。
- [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md)：验收 runbook 与证据记录。
- [packages/omo-dsh/README.md](./packages/omo-dsh/README.md)：两个 cordis 行的配置参考。

## 版本历史

- v0.1.0 — 7 个模式 preset、omo-mode / omo-task 行、vendored 同步 CLI、36 个测试。

## 许可与出处

MIT（见 LICENSE）。设计理念源自 [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（SUL-1.0），本项目为独立重实现，未复制其代码或提示词，且不向上游提交 PR（见 ATTRIBUTION.md）。

