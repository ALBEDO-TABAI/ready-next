---
name: github-deep-research
description: GitHub 项目调研方法论：仓库 / issue / 贡献者 / 依赖图
when-to-use: 用户要求调研某 GitHub 项目、对比开源方案、分析仓库活跃度等
---

# GitHub Deep Research

## 方法论
1. **概览**：仓库 README / star / fork / issue 数 / 最近 commit / release 节奏
2. **架构**：目录结构 / 关键模块 / 测试覆盖 / CI 配置
3. **issue 分析**：top 10 closed issue / open issue 热点 / RFC 类讨论
4. **贡献者**：core team / outside contributor 分布 / 流失率
5. **依赖**：直接依赖 / transitive 风险 / supply chain
6. **生态**：fork / 衍生项目 / 集成案例

工具优先 web_fetch 抓 github.com 页面，必要时配合 web_search 找衍生项目。
