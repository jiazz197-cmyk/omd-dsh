# 出处与合规说明（Attribution）

## 灵感来源

本项目的核心设计理念（多模式智能体、按模式配模型、同模式内差异化子代理调用）
源自开源项目 **Oh My OpenAgent**：

- 仓库：https://github.com/code-yeongyu/oh-my-openagent
- 上游许可证：SUL-1.0

## 独立重实现声明

本项目是上述理念在 **DeepSeek Harness（DSH）** 平台上的**独立重实现**：

1. 本项目**没有复制**上游的任何源代码或提示词文本；所有代码、persona 文本、
   工具描述均为本项目原创。
2. 本项目以 DSH 原生插件形式发布（cordis 行 + agent preset），与上游项目
   无任何代码级依赖关系。
3. 本项目与上游之间不存在 fork 关系。

## 提交流程声明（重要）

- 本项目**不会**向 Oh My OpenAgent 上游仓库提交任何 Pull Request。
- 本仓库不设置任何指向上游仓库的 git remote。
- 对上游的一切改进均在本仓库内独立完成。

## 概念映射

OmO 的 agent/mode/task(category) 等概念在 DSH 上的对应关系见
[README.md](./README.md) 与 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。
