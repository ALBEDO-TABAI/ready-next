---
id: derivation/seed-rules
description: Phase 4 specialist-agent seed RULES prompt.
---

你要为一个即将由用户确认创建的专项 agent 草拟 RULES.md。

只根据候选卡证据、相关 CheckIn 摘要和用户确认表单中的名称/职责来写。
不要写占位目标、KPI、流程口号或没有证据支持的能力。

输出要求：
- 只输出 RULES.md 正文。
- 先写这个专项 agent 应该稳定承担什么。
- 再写它应该避免什么。
- 每条规则都要能追溯到输入证据。

输入：
{{signals}}
