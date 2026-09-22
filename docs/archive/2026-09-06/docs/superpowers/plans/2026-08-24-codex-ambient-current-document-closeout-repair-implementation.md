---
title: Codex 环境当前文档误阻断终态收口修复实施合同
date: 2026-08-24
status: in_progress
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Codex 环境当前文档误阻断终态收口修复

## 1. 现场真值

- 现场 run `req-1787557117114-eidkec` 已在 `07:44:52` 收到原生 `turn/completed`，20 次工具调用全部成功，产物写入、导出与回读完成。
- 用户明确要求“不查看任何的本地文档”，但 Renderer 因文档工作面有打开页签而冻结了 current-document anchor。
- Main 无条件把该 ambient anchor 变成 `document_read_section` 地板，最终发布门以 `current_document_read_required` 拒绝已完成候选，导致任务保持 active 25 分钟以上。
- 用户停止时，产品收口与停止结算并发；持久化最终完成，但 IPC 错报 `persistence_failed`。

## 2. 机器可验证合同

1. 捕获 current-document anchor 只证明界面存在可定位文档，不等于本轮已授权或要求读取。
2. 只有用户明确指向当前文档，或本轮携带结构化 widget target 时，Main 才能激活捕获到的 current document；普通网页、附件、文件夹或新建文档任务，以及明确排除本地/当前文档访问的任务，必须把 ambient current document 保持 inactive：request envelope、resource additional context、当前文档资源授权均不得包含它。
3. inactive current document 不得签发该文档的读取权限，也不得产生 `current_document_read_required` 发布门；工作台通用工具即使在工具目录中可见，也不能被工具名误判成该资源已授权。文件夹目标的写入、导出、回读仍按原合同执行。
4. 用户明确要求读取/总结/修改当前文档时维持现有精确 anchor、先读后写、版本与 tab incarnation 约束，不得为修复无关任务而削弱当前文档安全边界。
5. 原生 engine 已终态、产品 closeout 待完成时，用户停止必须只产生一个持久终态，并返回与持久 readback 一致的成功结果；后台 observer 与停止动作不得互相抢写后让 IPC 错报失败。

## 3. 验收

- 行为测试证明“不查看任何本地文档”和未提及当前文档的文件夹任务都会停用 ambient current document；普通“总结当前文档”和当前文档写入仍保留读取地板。
- 原生发布测试证明 inactive ambient document 不需要读取回执，active current-document turn 仍必须持有精确读取回执。
- 停止竞态测试覆盖 engine terminal + closeout pending + observer 同时结算，结果幂等且 IPC 成功。
- 通过类型检查、Codex runtime、streaming、stability、native gates。
- 新 DMG 在隔离真实应用中打开一篇无关文档，执行“明确不读本地文档 + 输出到目标文件夹”；文件写入后任务自动结束，数据库为 completed/done，真实调用记录没有 `document_read_section`，无需手动停止。
