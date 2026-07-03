# ready-debug

Ready 应用故障诊断技能（EP1-T5），面向**外部编码代理**。

## 谁用、怎么用

- **Claude Code**：在本仓库内自动发现 `.claude/skills/ready-debug/SKILL.md`，按症状触发。
- **Codex / Cursor / 其他代理**：不自动发现技能。把 `SKILL.md` 全文复制粘贴给代理，并附上用户的症状描述即可。

## 范围

v1 仅覆盖**开发/排障场景**（可读源码与日志）。最终用户的应用内自诊断（设置页"诊断报告"、纯诊断不改码）属 v2，不在本技能内。

## 核心纪律

数据类症状（设置丢失 / 历史空白 / scope not found）**先查 `ready-database.log` 的 ABI/迁移错误，再怀疑前端状态**——原生依赖 ABI 不匹配最容易被误判成前端问题。详见 SKILL.md 表 1 与表 4。
