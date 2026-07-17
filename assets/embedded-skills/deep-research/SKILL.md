---
name: deep-research
description: 系统化多源研究方法论：维度拆解、多查询、全文 fetch、引用追踪
when-to-use: 用户要求"研究 X / 调研 Y / 综述 Z / 对比 A 与 B"等需要系统化网络调研的场景
---

# Deep Research

## 工具合同

<tools-contract>
本 skill 使用的工具按 capability profile 分流：
- browser-mode：需要当前登录会话时优先 `browser_research`；普通公开网页调研使用 `web_search` / `web_fetch`
- non-browser-mode：优先 `web_search` + `web_fetch`（多查询并行 + 全文 fetch）；使用 AnySearch 垂直领域前先调用 `web_search_domains`
两套工具不冲突：`browser_research` 在 BrowserView 当前登录会话内运行；`web_search` / `web_fetch` 负责普通公开网页调研。
</tools-contract>

## 方法论

1. **拆维度**：先把研究目标拆成 5-10 个独立维度（不是 query）
2. **生 queries**：每维度 3-4 个 query 形态（中文 + 英文双语）
3. **执行**：每 query 调 web_search → 选 top-3 结果 → web_fetch 取全文；金融、学术、法律、健康等垂直查询先用 web_search_domains 取得真实参数合同
4. **综合**：按维度合并 → 给出引用追踪的输出
5. **检查**：覆盖度自检（每维度至少 2 个高质量来源）

预算：60 iterations / 60 tool calls（与 media_task 同档）。
