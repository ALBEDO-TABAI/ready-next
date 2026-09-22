---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 浏览器采集、任务卡与回答交付闭环实施计划

> 日期: 2026-07-15
> 状态: implementation
> enforce: true
> 范围: 浏览器账号分析与显式采集的意图区分、后台采集任务身份/取消/结果位置、聊天答案幂等交付、固定任务卡交互。

## 1. 事故事实

- 用户只要求分析当前小红书账号并给出选题。系统先运行 `visible_collect` 冻结 34 条目标；随后一次 `browser_get_task(source)` 又创建了 `card_loop` 保存任务。
- `browser_cancel_task(source)` 命中已经完成的 source，真正运行的 child 继续到 34/34；Agent 回答在 08:30:25 结束，child 到 08:33:55 才结束。
- 保存结果实际位于 `/Users/user/Documents/Ready采集/profile`，但任务投影没有产物入口，聊天区看不到目录、报告和 manifest。
- 正文已通过 56 次流式增量显示；终态却因过期的工具失败标记和错误的浏览器采集判据被写成 `proof_gap`。无送达回执的“未显示答案恢复”随后把 `run_meta.last_message_text` 的 2000 字预览追加到同一条消息，形成永久重复。
- 任务卡边界被组件样式和液态主题覆盖共同主动移除；完成态又被固定后台区域过滤。卡片没有独立的“停止采集”和“只清除卡片”动作。

## 2. 设计决策

1. **查询与命令分离**：`browser_get_task` 只读且幂等；`browser_resume_task` 只恢复同一 paused 任务；从冻结清单开始逐篇保存只能显式调用 `browser_collect_notes`。
2. **稳定任务身份**：source 是用户可见的稳定任务，child 是一次执行。查询 source 可返回紧凑 child 摘要但不得切换身份或启动 child；取消 source 或 child 都要命中当前 active child。
3. **普通分析不等于采集**：平台名、账号名和当前页面引用只开放观察工具；只有用户明确要求采集、保存、下载或归档时才开放持久采集工具并启用 collection criteria。
4. **后台任务有归属**：浏览器任务持久化发起 Agent、父 run/task 与 execution binding；显式采集可以在回答后继续，普通分析不产生 detached 保存任务。
5. **交付与验收正交**：`proof_gap` 不能推断“答案未显示”。没有正向送达回执前禁用正文重放；Renderer 对后端补充文字只允许填充空占位，不得追加到已有正文。
6. **终态只看未解决事实**：未知/瞬时工具失败不再默认留下粘性 `proof_gap`；最终 criteria 与成功 proof 决定结果。浏览器 collection overlay 只应用于明确采集轮。
7. **任务卡保留到清除**：显式长任务的运行、暂停和终态卡片固定保留；右上角关闭与右滑只隐藏卡片，不停止任务、不删除账本；“停止采集”单独执行 source-aware cancel。
8. **保存位置是一等结果**：运行时显示并可打开输出目录；终态继续提供报告和 manifest。状态查询返回紧凑摘要，禁止反复回传整份候选清单与采集正文。

## 3. 机器可验证合同

- C1: completed source 连续 `get` 不创建 child；completed source `resume` 不跨阶段启动保存。
- C2: 只有显式 `browser_collect_notes` 创建保存 child；source-aware cancel 立即取消 active child，重复取消幂等。
- C3: 普通“分析这个账号并给选题”工具面不包含 `browser_visible_collect/browser_collect_notes`；明确“采集并保存”仍包含。
- C4: 非采集 browser run 不叠加 `collection_verdict`；明确采集 run 仍保留完整 browser criteria。
- C5: 可选读取失败后有成功工具 proof 时，不因历史失败强制变成 `proof_gap`。
- C6: 已有流式正文时，任何后端 `responseText` 都不得追加；空占位仍可被填充。同轮结束不再启发式重放 `lastMessageText`。
- C7: 浏览器采集投影含稳定 source、child run、owner、parent task、execution binding、输出目录/报告/manifest。
- C8: 运行和终态采集卡均留在固定区域；普通和液态主题都有可见边界；关闭与右滑只 dismiss，“停止采集”才 cancel。
- C9: `browser_get_task/cancel_task/resume_task` 对采集任务返回紧凑状态，不包含完整候选/正文数组。
- C10: `status=completed` 且 `failed=0` 的结构化工具结果能生成成功 proof。

## 4. 验证入口

- 浏览器采集、工具面、criteria、proof、Renderer store 与任务卡的焦点行为测试。
- `npm run typecheck`
- `npm run verify:stability`
- `npm run verify:native`
- 真实 Electron：普通账号分析不产生保存 child；显式采集可停止、可清除卡片、可打开真实输出目录，聊天正文只出现一次。
