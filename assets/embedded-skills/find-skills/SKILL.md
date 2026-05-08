---
name: find-skills
description: 技能搜索方法论：description matching + when-to-use 反向 lookup
when-to-use: 用户问"有没有什么技能能做 X / 帮我做 Y"，需要在已安装 skill 集合中匹配最合适的
---

# Find Skills

## 方法论
1. **目标解析**：把用户描述拆成"动作 + 客体 + 约束"三元组
2. **关键词抽取**：从 description / when-to-use 字段做反向 lookup
3. **多候选评分**：覆盖度 / 专业度 / 历史使用频次三维加权
4. **降级方案**：若无 skill 命中，提示用户用 generic agent + 推荐方法论

注意：本 skill 是方法论，不是 tool；不直接调用 skill 注册表，由 advice 形式给出建议。
