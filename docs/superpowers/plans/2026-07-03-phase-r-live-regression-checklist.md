---
title: Phase R — 真机回归关账清单（用户执行版）
date: 2026-07-03
status: ready
enforce: false
parent: 2026-07-03-agent-mainline-p3-route.md
purpose: >
  P1 浏览器可靠性的验收从未实战（三个 XHS 回归、transaction_unconfirmed
  机制 0 次生产触发）。本清单给出每项的操作步骤、预期结果、证据采集命令
  与通过/失败判据。跑完把"结果记录"栏填上（或截图+贴日志行）即关账。
---

# 准备（一次性）

1. `git log --oneline -1` 记下 commit（V0 纪律：现源可追溯）。
2. `npm run dev` 重启现源；确认小红书已登录（浏览器面板里打开 xiaohongshu.com 能看到你的头像）。
3. 日志位置（macOS）：`ls $TMPDIR/ready-*.log`；下述命令里 `$T` 指该目录。

---

# R1 — XHS 发布全链（最重要：transaction 机制首次实战）

**操作**：对 agent 说：
> 帮我发一条小红书长文笔记，标题「Ready 真机测试 0703」，正文写三段关于"今天天气不错"的闲聊。发布前把编辑器截图给我看一眼。

**预期行为链**：
1. 意图命中 browser_workflow（工具面 ≥90 个，含 browser_*）——不是 26 个工具的 local_chat 面；
2. 按站点卡流程：先切「写长文」tab → 先填标题 → 再填正文 → 找右上角发布按钮；disabled 时用 read_page_map 查缺项，而不是反复截图盲滚；
3. 终态四选一（E2）：
   - 发布成功 → 任务卡 done，且 proof 里有 transaction 确认（发布成功页信号）；
   - 停在编辑器等你确认 → checkpoint/暂停 + 可续按钮；
   - 中途失败 → blocked/degraded + 明确原因 + 下一步建议；
   - **不允许**：泛化失败卡（"任务失败"无原因）或声称成功但无确认。

**证据命令**：
```bash
grep 'run_close' $T/ready-agent-metrics.log | tail -3          # terminalReason/taskType
grep 'browser_transaction_unconfirmed\|transaction_confirmed' $T/ready-agent-metrics.log | tail -5
grep 'tool_capability.*final_tools' $T/ready-tools.log | tail -1 | grep -o 'toolCount=[0-9]*'
```

**判据**：终态与实际一致（成功=confirmed proof；未成功≠done）。`browser_transaction_unconfirmed` 只在"宣称成功但无信号"时出现——出现于真实成功 = 误报（记录）；成功却没 confirmed proof = 漏铸（记录）。
**失败时记录**：停在哪一步（截图）+ 上面三条命令输出。

**结果记录**：（待填）

---

# R2 — 拖拽出视觉分析

**操作**：从访达拖一张截图/照片进会话输入区，说「这张图里有什么，适合发小红书吗」。

**预期**：附件进入资源层（不自动触发）→ 你发出指令后，走视觉分析（前后端同源 `canAttemptVisualAnalysis`）；当前模型无 vision 能力时应**明确说明降级原因**，而不是装看过。

**证据**：`grep -i 'vision\|visual' $T/ready-tools.log | tail -5`
**判据**：有真实的图像内容描述（或明确降级说明）；不出现"我看不到图但假装分析"的文本。
**结果记录**：（待填）

---

# R3 — 账号页采集冻结

**操作**：让浏览器面板停在你的小红书个人主页，说「采集我最近 10 篇笔记的标题和链接」。

**预期**：
1. `browser_visible_collect` 逐屏冻结**真实笔记**（非骨架屏/推荐位）；
2. 不足 10 篇或翻页中断 → 部分完成 + 断点（E3：62/69 型呈现），任务卡出现「继续」/「确认部分采集」（你截图里那套）；
3. **0 条永不 completed**（判决唯一来自 resolveCollectionVerdict）。

**证据**：
```bash
grep 'collection\|frozen\|discoveryStatus' $T/ready-browser.log | tail -8
grep 'run_close' $T/ready-agent-metrics.log | tail -1
```
**判据**：冻结条数与页面真实可见一致；部分进展未清零；重试只补缺。
**结果记录**：（待填）

---

# R4 — E1-E5 体验基线（命令直接出数）

跑完 R1-R3 后执行，把数字记下来作为基线：

```bash
# E1 首 token 延迟（应 <2000ms 常态）
grep 'provider_stream_first_delta' $T/ready-agent-metrics.log | tail -5
# E2 proof_gap 当日占比（应低且可解释）
grep 'run_close' $T/ready-agent-metrics.log | grep -c 'proof_gap'; grep -c 'run_close' $T/ready-agent-metrics.log
# E5 同页连续 read_page 次数（≥3 连读=回执缺陷线索）
grep -o 'executeBrowserTool: browser_read_page ' $T/ready-tools.log | wc -l
grep -c 'executeBrowserTool: browser_capture_viewport' $T/ready-tools.log
# D2 事中自检已注入（结果型任务后应 >0）
grep -c 'criteria_self_check_injected' $T/ready-agent-metrics.log
```

**结果记录**：（待填五个数）

---

# R5 — 新件与依赖确认（顺手）

1. **ct-punc 模型包**：设置页 → 模型包下载管理 → 下载「标点恢复 · ct-punc (中文)」（缺 paraformer 一起装）→ 重跑一次 video-expert-analyzer（随便一条短视频链接）。预期：转写+标点跑通；仍失败则贴新错误（不再是"没有标点"类即算此项修复确认）。
2. **ReadyMode 涌现段**：路由到 `#/ready`，左侧应出现「涌现」段（此刻应有你那两张可续跑采集卡去重后的一张）；点「继续」应切到对应会话。
3. 设置页 BeliefCardsPanel 的 llmRound 仍显示「未接入驱动」（这是真实状态，D7 未接）。

**结果记录**：（待填）

---

# 第一轮结果与根因（2026-07-03 夜，日志实锚诊断）

- **R2 ✅**；R4/R5 未跑。
- **R1 ❌（13.5s，run uzzrkn）根因三连锁，已修前两环+呈现**：
  1. 发布页 `read_page_map` 无默认体量预算（单次 ~27k token）→ 已修：`DEFAULT_AGENT_PAGE_MAP_MAX_BYTES=32KB`（read_page_map 与 act_on_target read_back=map 两处）；
  2. presend 压缩把 >16k 的工具结果**无条件**换占位符（59k≪160k 软线也砍，truncatedToolResults=2）→ 模型在点击后信息真空、盲宣告完成 → 已修：截断只在越过 0.8 软线后发生（compact-agent-input + 回归测试）；
  3. 裁决器正确拦截（degraded→unconfirmed，**机制工作**✅），但 renderer 收到泛化 "Agent execution failed" → 已修：error 终态带 reason 专属可读文案（run-collector `userFacingTerminalErrorText`，unconfirmed/proof_gap/no_artifact）；
  4. 结构层（可续时应 checkpoint 而非 error）→ **D8 工单**（牵 p6d/funnel 合同，在场做）。
- **R3 ❌ 根因=同 scope 任务混线，非"老任务劫持"**：R1 发布上下文残留同一会话，模型在采集等待间隙跳回发布流程（15:04 navigate 发布页；15:06 采集启动后 click "写长文"抢走采集 tab）；且两个采集任务零终态痕迹（可观测缺口）→ **D9 工单**（tab 写保护闸 + 任务终态账本 + 任务锚定）。**复测建议：R1 与 R3 用不同会话跑。**

# 关账动作

五项结果记录填完 → 回贴给我。我会：把结果写进本文件与 route 文档、判定分支分叉时机（R 全绿=合并信心）、失败项按"站点变化→分类器规则更新，机制缺陷→立 slice"分流。
