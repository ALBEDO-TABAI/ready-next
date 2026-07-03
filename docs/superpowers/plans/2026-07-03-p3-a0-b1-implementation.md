---
title: P3 启动批 — A0 turn-engine 退役盘点（证据定稿）+ B1 browser-tools 媒体下载簇拆分
date: 2026-07-03
status: done
enforce: true
parent: 2026-07-03-agent-mainline-p3-route.md
result: >
  A0：17 导出全 prod=0 证据表定稿（本文 §A0），HCD 随 Phase A 同死。
  A1：六组全部 dead-with-engine（本文 §A1 表），A2 测试手术图定稿，三个
  live 缺口观察记录。B1：browser-media-download.ts（468 行）纯移动，
  browser-tools 8053→7615。B2：browser-input-actions.ts（603 行，含
  waitForReady/计时常量随簇走）纯移动，browser-tools 7615→7049。
  验证（真实退出码）：typecheck=0、焦点 137+72+88/0 fail、
  verify:stability=0、verify:browser-reliability 113/0、silent-catch
  浏览器违规 23→18 持平（搬移 catch 按 silent-catch: 约定补注释）。
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

**A1 核验结果（2026-07-03 深夜，同批完成）——六组全部 dead-with-engine，无一需抽取**：

| 组 | live 等价核验 | 判决 |
|---|---|---|
| tool-loop 四件（countToolRepetitions 等） | `toolLoopRepetitionDetected` 全仓零 live 发射者——live SDK 无循环重复检测 | 随引擎死；metric 注册表死值 A2 一并清 + registry 测试同步 |
| buildBudgetWarningMessage | live 有自有文案 `buildBudgetWarningSteering`（agent-sdk-utils:511-519，两级通用文案） | 死重复。⚠️ 观察：live 版缺长技能"保持推进"分支（Phase 3.3 防 VEA 自杀细腻度未迁移） |
| statusFromTerminalReason | live 等价 `sdkStatusFromTerminalReason`（agent-sdk-utils:2121） | 死重复 |
| computeChildContinuationDecision | e2e 测试 T5 块自述"engine 专属纯 helper"；live 续跑由 child-loop-terminal-funnel/SDK 测试覆盖 | 随引擎死；A2 只摘 e2e 文件的 T5 块（文件其余是 live 覆盖，不整删） |
| applyChildResumeFreshContractFields | live 的 `freshContractFields` 三处全 `: null`（skill-child-runner），从不填充 | 随引擎死。⚠️ 观察：fresh-contract-on-resume 在 live 未实现（若合同仍被期望属 live 缺口） |
| detectAllowedPreferredMismatch / shouldResumeContinuationForTurn | `turn_frame_summary` 零 live 发射者 | 随引擎死（dormant 专属诊断） |

**A2 测试手术图（据 A1 定稿）**：整删 turn-engine-route(5117 行)/turn-engine-projection/turn-engine-force-tool-dispatch/tool-loop-dedup/turn-frame-summary-log/resume-fresh-contract-fields；外科修剪 skill-child-run-end-to-end（仅 T5 块）与 phase-3-output-safety-net（仅 buildBudgetWarningMessage 部分，其余 live 守卫保留）；A3 转型 turn-engine-contract + host-contract 253 断言（在场）。metric 死值清理：toolLoopRepetitionDetected（+registry 测试）。
**三个 live 缺口观察**（不阻塞退役，已记 route 伴随线候选）：循环重复检测缺失、预算文案长技能分支缺失、freshContractFields 恒 null。

# B1 — browser-tools 媒体下载簇拆分（纯移动）

**簇边界（实测）**：browser-tools.ts 1511-1958（expandHomePath → downloadUrlsToDirectory 尾），18 个函数 + 1 接口 + 1 常量，~448 行。内聚性：文件名/落盘/pinimg 归一/下载执行一条链，外部依赖仅 node fs/path、BrowserController、BrowserResourceKind、tool-result-types、broadcastDirectoryChanged。

**完成标准（机器可验证）**：
1. 新模块 `src/main/modules/tools/browser-media-download.ts` 承载全簇，逐字搬移（唯一允许的非移动改动：为搬移的裸 catch 补一行原因注释，防 silent-catch 基线键漂移产生新违规）。
2. browser-tools.ts 删除该区间，回接 import 仅限仍被使用的 7 名（expandHomePath/sanitizeFilename/safeHostname/normalizeDownloadTargets/imageBoardHarvestUrlCount/normalizeResourceKinds/downloadUrlsToDirectory），并保留门面 `export { pinimgOriginalsUrl, normalizeDownloadTargets }`（外部消费者零改动）。
3. 行数：browser-tools.ts ≤ 7650（8053 − ~430+）。
4. 验证（真实退出码）：`npm run typecheck` =0；浏览器焦点测试（下载/采集相关 + browser-tools 引用测试）全绿；`check-silent-catch` 违规数不高于改动前基数；`verify:stability` =0。
5. 独立提交。
