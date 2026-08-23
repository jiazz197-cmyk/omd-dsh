# OMD — DeepSeek Harness 多模式智能体插件

把「多模式智能体」理念以 **DeepSeek Harness（DSH）原生插件**形式落地：每个模式是一个 agent preset（定能力边界 + 定模型），`omd_task` 工具按 tier 把重复/深度工作委派给不同档位的子代理。设计理念源自 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)，为独立重实现（MIT，见 ATTRIBUTION.md）。

## 功能

**7 个开箱即用的模式**（每个模式 = 一套固定工具边界 + 一个模型路由）：

| 模式 | 定位 | 顶层模型 | 能力边界 | omd_task tiers |
|---|---|---|---|---|
| omd-executor | 全自主执行 | deepseek-v4-pro | 完整工具集 + goal/ralph/workflow/委派 | fast(flash) / deep(pro) |
| omd-architect | 深度构建 | deepseek-v4-pro | 完整工具集 + goal/workflow/委派 | fast / deep |
| omd-planner | 规划访谈（DSH 原生 plan-mode） | deepseek-v4-pro | 只读 + 委派 | investigate(flash) / review(pro) |
| omd-reviewer | 评审 | deepseek-v4-flash | 只读 | — |
| omd-explorer | 代码侦察 | deepseek-v4-flash | 只读 | — |
| omd-librarian | 文献研究 | deepseek-v4-flash | 只读 | — |
| omd-chat | 纯对话 | deepseek-v4-flash | 无 fs/shell | — |

- **按模式配模型**：每个模式的 provider/model 集中在一个 `omd-matrix.json`，改一处、`omd-dsh sync` 全同步。
- **tier 差异化子代理**：`omd_task` 工具把重复调查/机械活派给便宜模型（fast），深度推理派给强模型（deep）——「强模型顶层 + 性价比模型做重复工作」。
- **终端引导配置**：`omd-dsh setup` 先读 DSH 已有模型，再逐模式/逐 tier 引导你选模型。

## 安装

要求：已装 DSH（`dsh` 命令在 PATH）、Node.js ≥ 20。

```bash
# 从 GitHub 安装（当前）
git clone https://github.com/jiazz197-cmyk/omd-dsh.git && cd omd-dsh
npm install     # 装依赖 + 触发 build
npm link        # 全局 omd-dsh 命令
```

发布到 npm 后，也可以直接 `npm i -g @subagent-router/omd-dsh`。

## 使用

```bash
omd-dsh setup                                    # 交互：读 DSH 已有模型 → 逐模式/tier 选模型 → 写矩阵 → 同步
omd-dsh sync --harness "<DSH 的 node_modules 路径>"   # 或直接按 omd-matrix.json 同步
```

`sync` 把 7 个 preset 写入 `<DSH_HOME>/.agent-presets/`（默认 `~/.dsh`），vendored 行模块写入 `.agent-presets/.omd-vendor/`。之后启动 `dsh web`，preset 选择器里出现 7 个 OMD 模式，新建会话即用。

**改模型**：跑 `omd-dsh setup`，或直接编辑 `omd-matrix.json` 后 `omd-dsh sync`。preset 里 `# [omd-dsh:mode:start]` … 之间的区域是自动生成的，不要手改。

## 文档与许可

- [packages/omd-dsh/README.md](./packages/omd-dsh/README.md)：omd-mode / omd-task 行配置参考
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：工作原理与 vendored 分发

MIT（见 LICENSE）。
