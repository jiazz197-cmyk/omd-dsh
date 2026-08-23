# 二开规范（Contributing）

## 红线

- **禁止向上游提 PR**：本项目不向 code-yeongyu/oh-my-openagent 提交任何 Pull
  Request，不设置上游 remote。
- **禁止复制上游文本**：persona 文本、工具描述、文档一律原创；借鉴概念而非文字。

## 新增一个模式（preset）

1. 复制 packages/omo-dsh/presets/omo-chat 目录为 omo-<新id>（id 必须匹配
   [a-z0-9][a-z0-9-]*，且以 omo- 前缀避免与 DSH 自带 preset 冲突）。
2. 编辑 agent.cordis.yml：
   - persona 行：模式横幅 + 一句话定位 + {{model}} 路由声明（保持简短，
     不要写行为限制长文——能力边界由工具行组合决定）。
   - omo-mode 行：配置该模式的 provider/model。
   - 按需增删工具行（参考 DSH 自带 standard preset 的行写法）。
   - 需要差异化委派时挂 omo-task 行并配置 tiers。
3. 编辑 preset.yml：中文展示名、描述、order。
4. 重跑 npm run build && node lib/cli.js sync。
5. 提交前运行 npm test。

## 给某个模式换模型

编辑 <DSH_HOME>/.agent-presets/omo-<id>/agent.cordis.yml 中 omo-mode 行的
config.provider / config.model（或 tiers 内各 tier 的 provider/model），
下一会话生效。改坏 YAML 会导致该 preset 被 DSH 列为 broken 并显示原因。

## 提交规范

- 分阶段小提交，见根 README 的版本历史。
- 代码 + 测试一起提交；npm test 必须全绿。
