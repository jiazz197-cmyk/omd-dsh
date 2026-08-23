# omd-dsh — DeepSeek Harness 多模式智能体插件

给 DeepSeek Harness（DSH）加 7 个开箱即用的智能体模式：每个模式固定一套工具边界 + 一个模型，`omd_task` 工具按 tier 把重复/深度工作委派给不同档位的子代理。

## 7 个模式

| 模式 | 定位 | 能力边界 |
|---|---|---|
| omd-executor | 全自主执行 | 完整工具集 + goal/ralph/workflow/委派 |
| omd-architect | 深度构建 | 完整工具集 + goal/workflow/委派 |
| omd-planner | 规划访谈（DSH 原生 plan-mode） | 只读 + 委派 |
| omd-reviewer | 评审 | 只读 |
| omd-explorer | 代码侦察 | 只读 |
| omd-librarian | 文献研究 | 只读 |
| omd-chat | 纯对话 | 无 fs/shell |

各模式的模型都集中在一个 `omd-matrix.json` 里，可用 `omd-dsh setup` 逐项改。

## 安装

要求：已装 DSH（`dsh` 命令在 PATH）、Node.js ≥ 20。

### 方式一：npm（推荐）

```bash
npm i -g @carljia/omd-dsh
```

### 方式二：从源码（GitHub clone）

```bash
git clone https://github.com/jiazz197-cmyk/omd-dsh.git
cd omd-dsh
npm install     # 装依赖 + 触发 build
npm link        # 全局 omd-dsh 命令
```

## 使用

```bash
omd-dsh sync    # 把 7 个模式写入 ~/.dsh/.agent-presets，立即生效
omd-dsh setup   # 交互式：逐模式/tier 选模型，再同步
omd-dsh models  # 列出发现的模型
```

如果 `sync` 报「找不到 DSH harness」（`dsh` 不在 PATH 时），用 `--harness` 指定：

```bash
omd-dsh sync --harness "<DSH 的 node_modules 路径>"
```

同步后启动 `dsh web`，preset 选择器里就会出现 7 个 OMD 模式，新建会话即可用。

## 改模型

跑 `omd-dsh setup`，或直接编辑 `omd-matrix.json` 后 `omd-dsh sync`。preset 里 `# [omd-dsh:mode:start]` … 之间的区域是自动生成的，不要手改。

## License

MIT
