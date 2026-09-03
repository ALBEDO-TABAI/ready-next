---
title: Browser 观察收口与宠物实时旁白修复实施合同
date: 2026-08-21
status: complete
enforce: true
---

# Browser 观察收口与宠物实时旁白修复

## 1. 现场事实

- 失败任务 `req-1787306875763-ov65bz` 在 Browser 工作面读取当前小红书页面，却按 `direct_answer` 获得 8 次普通工具调用。
- 第 8 次调用是 `browser_press_key`。执行回执明确标记 `needsObservation=true`，但普通预算已经耗尽，因而没有后续页面观察。
- canonical closeout 正确拒绝了未核对的成功候选，并落成 `codex_browser_workflow_observation_required`；缺口是准入没有按冻结页面事实配置 Browser 容量，也没有保留只读收口调用。
- 宠物只轮询 `task_projections`。Browser workflow 绑定父投影后，实时 commentary 不再写回该行；canonical Browser 终态又在数据库事务内静默提交，没有触发 repository 实例事件，所以宠物既丢最新旁白，也可能停在旧的 running 状态。
- Ready 还在 Codex 终态收集器中设置了 5 分钟静默截止，并在 Main 运行登记中默认设置 15 分钟无进度取消。两者都不是本机 ChatGPT Runtime 的运行合同：Runtime 等待 `turn/completed`，只在显式 `turn/interrupt`、真实连接失败或上游失败时结束；长工具调用和数十分钟任务不应因经过时间被中止。

## 2. 机器可验证合同

1. 本轮具备精确 `browserPageRef` 且冻结工具面含 Browser 工具时，任务事实归入 Browser 模块；容量按 Browser 结构事实决定，不依赖自然语言分类是否命中。
2. 本机 ChatGPT Runtime 默认不以低工具次数终止任务，而是在模型仍需继续时循环并在上下文边界压缩；Codex 生产轮次因此不再按 direct/browser/research 等任务猜测分配 8/40/220 次额度。现有序列化合同仍要求安全整数，使用留有 delivery/final 余量的 `Number.MAX_SAFE_INTEGER` 哨兵表达“普通工作由 Runtime 管理”；Browser 另保留 1 个只读观察收口位。最后一位只开放全操作均为 observe 的 Browser 工具，但正常用户任务不会实际触达该哨兵。
3. 即使上游响应使用旧工具列表，持久化准入也拒绝在保留位执行非观察调用；代码不得自动调用 snapshot，也不得把未核对候选改成成功。
4. 宠物终态和优先级继续只读取 canonical `task_projections`；实时旁白只作为 exact `scopeId + taskId + runId` 的运行中显示覆盖，不改数据库任务真值。
5. 后续通用工具活动不得覆盖同一 run 最近的 commentary/reasoning summary。身份不匹配、旧 run 或终态后的旁白不得显示。
6. committed terminal `scopeRunEvent` 到达时，宠物必须重新读取 canonical 投影；不能依赖实例内 repository change 事件。
7. ingress 提交后也触发一次 canonical 刷新，使静默事务创建的 running 投影能及时进入宠物队列。
8. Codex 生产轮次不设置总时长或静默时长截止；collector 等待 Runtime 的 canonical `turn/completed`。只有本机 Runtime 连接真实关闭时，才把未终止轮次收成连接失败。
9. Main 默认不启动基于经过时间的 no-progress cancel。显式测试或已证明的短任务仍可传入局部 watchdog，但 Codex 用户任务不传入。Renderer 可周期性询问 Main 是否仍 active；Main 回答 active 时只能续查，不能终止。

## 3. 验收

- 结构上绑定当前 Browser 页面、但语义分类为 general 的任务，获得 Browser facts 与 Runtime-managed 普通容量，并额外保留 1 次观察；普通问答、技能、研究和网页任务都不再由任务分类决定可运行多久。
- 剩余最后一个 Browser 普通调用位时，gateway 只返回 observe-only Browser 工具；mutation 的旧响应被准入拒绝，observation 可通过。
- exact live narration 能更新宠物气泡；后续无旁白的工具事件不覆盖它；错误 run 不影响当前宠物。
- terminal event 后宠物从数据库重新读取并切到 blocked/ready/idle 的真实状态。
- 超过 5 分钟、10 分钟或数十分钟的 active Codex 轮次不会因计时器被终止；真实连接关闭仍会立即形成可读失败，而不是永久卡住。
- 专项测试、Codex runtime gate、`verify:native`、类型检查、构建、真实 Electron 回归和 DMG 核验全部通过。

## 4. 完成读回

- 128 项直接风险测试通过；`npm run typecheck`、`npm run verify:native`、`npm run verify:codex-runtime-source`、`npm run verify:stability`、`npm run verify:streaming` 与 `npm run verify:browser-orchestration` 通过。
- 真实 Electron 宠物活动验收返回 `PET_ACTIVITY_LIVE_PASS`：新任务运行、失败、完成及打开后已读状态均从持久真值正确切换。
- 当前精简 arm64 成品为 `Packer/output/Ready-0.8.0-arm64.dmg`，大小 `335726688` 字节，SHA-256 为 `a2812665f3e3cc144c84a7352ceea89f2334f84011610095b412467274d0c5f4`；DMG 校验、只读挂载、签名、arm64、`0.8.0`、空 AI seed、无内置 `skill-runtime` 和 `/Applications` 入口全部通过。
- 新包在隔离配置下完成两轮真实应用会话，两轮共用同一 Codex thread，第二轮正确读到第一轮的“广州花都、9 月 27 日”，返回 `INSTALLED_CONTEXT_CONTINUITY_PASS`。
- Packer 临时 seed/备份残留为 0，`Packer/exports` 内包体或敏感配置残留为 0，开发 seed 已恢复为空且仅当前用户可读写。

## 5. 2026-08-21 真实安装态重开

- 19:07 安装态读回证明新包与上述 hash 一致，且新 run 已获得 Runtime-managed 容量；截图中的 8 次工具是保留的旧失败卡，不是新额度回归。
- 用户输入“重试”被当成全新 `user_ingress`，没有绑定旧失败 run；新 run 搜索一次历史后错误发布“阿白”为成功答案。
- 既有显式重试入口只在消息悬停图标中；更深的缺口是失败后 `publication_diverged` 会退役原 Codex thread，而 `explicit_retry` 只向新 thread 交付校验摘要，没有重放 task root 的原始用户输入。
- 严格重试语句精确路由、新 thread 重放原始任务及真实安装态同场景验收均已通过；最终报告状态为 `INSTALLED_CONTEXT_AND_EXPLICIT_RETRY_PASS`。
