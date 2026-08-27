# 验收 Runbook 与证据记录

本文档给出七类验收项的操作步骤与证据格式；实跑记录填入下方「证据记录」。

## 准备

```bash
npm install && npm test          # 静态验收：36 个测试全绿
node packages/omd-dsh/lib/cli.js sync --dry-run   # 预览
node packages/omd-dsh/lib/cli.js sync             # 安装到 <DSH_HOME>/.agent-presets
dsh --dump-config --profile web   # 确认 agent-presets 用户根存在（includeUserRoot）
```

独立测试实例（不影响正在运行的 GUI）：

```bash
# 新 profile + 独立端口 + 后台 job；端口冲突时换 3099
dsh --profile web --port 3099
```

## 验收 1：可见性

- 测试实例的 agent preset 选择器列出 7 个 omd 模式及其中文名/描述。
- 证据：选择器截图或 list 输出。

## 验收 2：能力边界核对

- 每模式起一个会话，导出 session log（dsh-session-log-export 或 UI 导出），grep 首轮系统提示中的工具 schema 名。
- 期望：omd-chat 无 read/write/edit/glob/grep/pwsh/bash；omd-planner 无 write/edit/pwsh/bash/str_replace_editor；omd-executor 全量 + omd_task。
- 行为学佐证：在 omd-chat 会话要求「调用 pwsh 执行 whoami」，模型应明确回答没有该工具。

## 验收 3：按模式配模型（负向证明）

1. 把 <DSH_HOME>/.agent-presets/omd-chat/agent.cordis.yml 中 omd-mode 行的 model 改为 deepseek-official/__nonexistent__。
2. 新建 omd-chat 会话发消息；首轮模型错误信息中必须出现 __nonexistent__（证明路由确实生效）。
3. 观察 persona 声明（{{model}} 渲染值）随之变为 __nonexistent__。
4. 恢复原值，重跑 sync 对比（不覆盖恢复后的值）。

## 验收 4：差异化子代理调用（负向证明）

1. omd-planner 会话（自身 v4-pro）调用 omd_task(tier="investigate")；把该 tier 的 model 临时改为占位 id A。
2. 子代理报错必须含占位 id A；把 tier="review" 的 model 改为占位 id B，再调用，报错必须含 B —— 证明同一工具不同 tier 路由到不同模型，且顶层规划仍在 planner 自身模型。
3. omd-executor 同理验证 fast/deep 两档。
4. 恢复配置。

## 验收 5：与 DSH 自带模式兼容

1. 安装后 standard（标准）/ minimal（极简）/ code（PTC）/ cordis 四个随附 preset 均正常列出且可挂载（broken 列表为空；各起一个会话正常应答）。
2. 配方验证：复制 standard 为 std-pinned 并追加 omd-mode 行（见根 README），负向证明该模式被固定到所配模型。
3. sync 重跑前后对 .agent-presets 下非 omd-* 目录做 hash 对比：必须无任何改动。

## 验收 7：UI 模型切换覆盖（v0.1.3+）

1. omd-executor 会话先发一条消息（矩阵顶层 v4-pro 生效），随后在 UI 模型座切换到 deepseek-v4-flash。
2. 再发一条消息：request/header 记录的 provider/model 必须变为 flash（路由跟随用户选择），persona {{model}} 同步为 flash。
3. 在 flash 路由下调用 omd_task(tier="deep")：子代理 header 必须为 flash（deep tier 沿用用户选择）；tier="fast" 仍为矩阵配置的 fast 模型。
4. 切换回矩阵顶层模型（v4-pro）：路由回到 v4-pro，omd_task(tier="deep") 子代理回到矩阵 deep 模型。
5. 反向：新开 omd-executor 会话不发消息、不切模型（部署默认 ≠ v4-pro 时）：首轮 request/header 仍为 v4-pro（矩阵认领），persona {{model}} 为 v4-pro。

## 合规

- git remote -v 为空；git log 全部为本仓库历史；ATTRIBUTION.md / LICENSE 齐全；grep 无 OMD 原文照抄。

## 证据记录

| 日期 | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 2026-08-23 | 静态（npm test） | ✅ 39/39 通过 | packages/omd-dsh，vitest（omd-mode 12 / omd-task 20 / sync CLI 7） |
| 2026-08-23 | 可见性（7 模式列出） | ✅ 全部列出、无 broken | agentPreset.list：omd-executor/ultraworker/planner/reviewer/explorer/librarian/chat（user 信任）与 standard/code(PTC)/minimal/cordis 并列 |
| 2026-08-23 | 能力边界（工具矩阵核对） | ✅ 与组合一致 | omd-chat 会话 request/header 工具清单恰为 ask_user_question/todo_write/web_search（无 pwsh/read/write/edit）；omd-executor 为全量 24 工具含 omd_task |
| 2026-08-23 | 按模式配模型（负向证明） | ✅ 路由生效 | omd-chat 模型 pin 为 __omo_accept_nonexistent__ 后：request/header 记录该模型、persona {{model}} 渲染同名、DeepSeek API 报错点名该 id；恢复配置 |
| 2026-08-23 | 差异化 tier 路由（负向证明） | ✅ 两档独立路由 | planner（顶层 v4-pro）内：tier=investigate 子代理 header=__omo_tier_investigate__ 且报错点名；tier=review 子代理 header=__omo_tier_review__ 且报错点名；executor 的 omd_task 描述枚举 fast(v4-flash)/deep(v4-pro) |
| 2026-08-23 | 自带模式兼容 | ✅ 不受影响 | standard 会话正常完成（1+1=2），其模型为会话选择（v4-pro/max）；四随附 preset 无 broken；sync 对非管理目录零操作（hash 对比 + conflict 保护实测） |
| 2026-08-23 | 合规 | ✅ | git remote -v 为空；git log 均为本仓库提交；ATTRIBUTION/LICENSE 齐全；persona 文本原创 |
| | | | |

