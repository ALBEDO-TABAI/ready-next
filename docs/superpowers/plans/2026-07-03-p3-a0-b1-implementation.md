---
title: P3 启动批 — A0 turn-engine 退役盘点（证据定稿）+ B1 browser-tools 媒体下载簇拆分
date: 2026-07-03
status: done
enforce: true
parent: 2026-07-03-agent-mainline-p3-route.md
result: >
  A0：17 导出全 prod=0 证据表定稿（本文 §A0），HCD 随 Phase A 同死；A1 核查
  清单排定。B1：browser-media-download.ts（468 行）纯移动落地，browser-tools
  8053→7615；typecheck=0、焦点 137+72/0 fail、verify:stability=0、
  verify:browser-reliability 113/0、silent-catch 浏览器违规 23→18（搬移
  catch 按 silent-catch: 约定补注释，主文件既有漂移 18 条不属本批）。
---

# A0 — turn-engine 全导出引用判定（非破坏，本文即产出）

**方法**：每个导出 grep 全仓（prod=src/main|preload|renderer 排除自身；tests=src/__tests__），零采信记忆。

**总判决：全部 17 个导出 prod=0。** turn-engine.ts 4827 行整体 dormant 确证（与 P3 审查一致）。

| 导出 | prod | 测试引用 | A2 处置 |
|---|---|---|---|
| countToolRepetitions / computeBudgetWarningThreshold / shouldInjectBudgetWarning / isLongTypedSkillActionName | 0 | tool-loop-dedup.test.ts | A1 查 live 等价（toolLoopRepetitionDetected metric 的 live 发射者）后删/重指 |
| detectAllowedPreferredMismatch / shouldResumeContinuationForTurn | 0 | turn-frame-summary-log.test.ts | A1 查 turn_frame_summary 的 live 发射路径 |
| buildBudgetWarningMessage | 0 | turn-engine-route + phase-3-output-safety-net | A1 查 live SDK 预算文案等价 |
| statusFromTerminalReason | 0 | turn-engine-route.test.ts | A1 查 run-projection/finalizer 等价 |
| computeChildContinuationDecision | 0 | skill-child-run-end-to-end.test.ts | 仅此定义仅测试引用，疑纯死；A1 确认 child-run-retry-policy 覆盖后随类删 |
| applyChildResumeFreshContractFields | 0 | resume-fresh-contract-fields.test.ts | A1 查 live 续跑 fresh-contract 写点（2026-06-16 文档：live=AgentSdkRuntime） |
| renderChildCommandOutcome | 0 | turn-engine-route.test.ts | 随引擎专属测试删 |
| ChildContinuationDecision / ChildCommandOutcome / ChildCommandKind 类型 | 0 | 0 | 纯死，直接删 |
| :56-64 re-export 块（tool-call-text-guard 三件） | — | — | 纯转发，真身 live，随文件删 |
| class TurnEngine | 0（4 处 prod 提及全是注释） | 9 个测试文件直接 import | A2 删类；测试三分：引擎专属删（route/projection/force-tool-dispatch）、守卫转 gate（turn-engine-contract + host-contract 摘除）、行为组按 A1 verdict 重指 |

**HostCapabilityDispatcher 归宿**：构造者仅 `host-capability-dispatcher.test.ts`；turn-engine 经结构化 `HostCapabilityDispatcherLike` 使用（不 import）；其余引用=domain-adapters barrel 再导出 + 边界 gate 禁令。**随 Phase A 同死**（删类+专属测试+barrel 行，boundary gate 断言同步转型）。

**A1（下一批，无人值守可做）**：上表 6 项"查 live 等价"逐一核验：live 有等价实现→测试删/重指 live；无等价且行为需保→抽 `agent-control/shared/` 窄模块。A1 全绿后 A2/A3（契约外科）留在场会话。

# B1 — browser-tools 媒体下载簇拆分（纯移动）

**簇边界（实测）**：browser-tools.ts 1511-1958（expandHomePath → downloadUrlsToDirectory 尾），18 个函数 + 1 接口 + 1 常量，~448 行。内聚性：文件名/落盘/pinimg 归一/下载执行一条链，外部依赖仅 node fs/path、BrowserController、BrowserResourceKind、tool-result-types、broadcastDirectoryChanged。

**完成标准（机器可验证）**：
1. 新模块 `src/main/modules/tools/browser-media-download.ts` 承载全簇，逐字搬移（唯一允许的非移动改动：为搬移的裸 catch 补一行原因注释，防 silent-catch 基线键漂移产生新违规）。
2. browser-tools.ts 删除该区间，回接 import 仅限仍被使用的 7 名（expandHomePath/sanitizeFilename/safeHostname/normalizeDownloadTargets/imageBoardHarvestUrlCount/normalizeResourceKinds/downloadUrlsToDirectory），并保留门面 `export { pinimgOriginalsUrl, normalizeDownloadTargets }`（外部消费者零改动）。
3. 行数：browser-tools.ts ≤ 7650（8053 − ~430+）。
4. 验证（真实退出码）：`npm run typecheck` =0；浏览器焦点测试（下载/采集相关 + browser-tools 引用测试）全绿；`check-silent-catch` 违规数不高于改动前基数；`verify:stability` =0。
5. 独立提交。
