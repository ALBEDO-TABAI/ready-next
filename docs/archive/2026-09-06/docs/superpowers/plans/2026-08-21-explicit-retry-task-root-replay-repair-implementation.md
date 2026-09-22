---
title: 显式重试与原始任务重放修复实施合同
date: 2026-08-21
status: complete
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 显式重试与原始任务重放修复

## 1. 现场真值

- 安装应用 `app.asar` 与最新 DMG 的 SHA-256 相同，不是旧包。
- 用户输入“重试”产生了 `attempt_kind=user_ingress`、`predecessor_run_id=null`，最终错误回答“阿白”。
- 相同 scope 的最近失败 run 已有 `ProductTurnReceipt.failure` 和 `presentationDigest`，系统可以机械绑定精确前驱，无需模型猜测。
- 失败 run 的 Codex thread 已因 `publication_diverged` 退役；现有 `explicit_retry` 输入只有当前“再试一次”和前驱摘要，没有原始 task root 内容。

## 2. 机器可验证合同

1. 只有无附件、严格匹配重试/继续短语，且同 scope 最近可见终态消息确实是失败时，Renderer 才可把本次用户输入转为 `explicitRetry`。
2. Renderer 只从 Main 读取前驱 `ProductTurnReceipt` 和 `presentationDigest`；Main 继续校验 scope、digest、lineage、资源身份与已确认/不确定 effect，Renderer 不猜测任务真值。
3. 最近终态是成功、无可读失败 receipt、scope 不同、存在附件或输入含新任务内容时，不得自动转为重试。
4. `explicit_retry` 必须冻结 task-root 的原始 `canonicalCurrentInputRef.input` 及其 digest；Codex 新 thread 的模型输入必须以该 root input 为任务目标，当前“重试”只是用户重试授权。
5. 重试仍是新 run，不恢复退役 thread，不派生通用续跑按钮，不重放已确认副作用；不确定副作用先读回。

## 3. 验收

- 回归重现必须先证明“重试”仍是普通 `user_ingress` 且新 thread 看不到 root task，再证明修复后 `attempt_kind=explicit_retry`、`predecessor_run_id` 精确。
- 模型端可观测输入必须包含原始“总结当前小红书内容”，不得只有“重试/再试一次”。
- 成功终态不会被重试短语误绑定；附件或新指令不会被吞掉。
- 通过专项测试、类型检查、`verify:native`、Codex Runtime gate、真实 Electron 与新 DMG 同场景验收。

## 4. 真机验收发现并闭合的第二层缺口

- 第一版修复在源码与专项测试中通过，但安装态第一次重试仍被 Main 以 `invalid_product_ingress` 拒绝。
- 根因是任务输入 digest 直接依赖 JSON key 顺序：同一 task root 经持久化读取和 schema 解析后，字段顺序可变化，内容相同却得到不同身份。
- 现已由共享 `digestCodexUserInput` 先把所有输入规范化到稳定 shape，再统一计算 digest；preparer、input builder、production composition 和持久化 readback 共用同一权威。
- 回归 fixture 刻意使用重排 key 的持久化 JSON，证明内容相同的 task root 不再因序列化顺序失配。

## 5. 完成读回

- 专项回归、`npm run typecheck`、`npm run verify:stability`、`npm run verify:native`、`npm run verify:streaming` 与 `npm run verify:codex-runtime-source` 全部通过；原生 SQLite 验收为 117 项通过、0 跳过。
- 最终 arm64 DMG 为 `Packer/output/Ready-0.8.0-arm64.dmg`，大小 `335726688` 字节，SHA-256 为 `a2812665f3e3cc144c84a7352ceea89f2334f84011610095b412467274d0c5f4`，权限为 `0600`，版本 `0.8.0`，Codex `0.149.0`，AI seed 为空。
- 隔离安装态先证明两轮普通对话共用同一 thread 并能读取上一轮；随后让原始网页总结任务故意失败，用户只输入“重试”。最终 run 为 `explicit_retry`，精确指向失败 run，在新 generation 中完成，且 provider 实际收到原始网页总结任务。
- 最终报告：`outputs/codex-context-continuity-installed/a2812665f3e3cc144c84a7352ceea89f2334f84011610095b412467274d0c5f4/78f7727e98b459494577aba33cadc2e9/installed-proof.json`，状态为 `INSTALLED_CONTEXT_AND_EXPLICIT_RETRY_PASS`。
