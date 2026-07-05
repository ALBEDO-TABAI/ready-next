---
title: 用户回测清单 — P3 backlog 关账后的真机验证（一次跑完勾选）
date: 2026-07-05
status: checklist
enforce: false
source:
  - docs/superpowers/plans/2026-07-03-agent-mainline-p3-route.md §6.1（真机欠账原始清单）
  - docs/superpowers/plans/2026-07-05-p3-backlog-closeout-implementation.md（本会话新件合同）
---

# 使用说明

全部剩余工单的代码侧已关账（`npm run test` 0 fail、五 gate 绿）。本清单是**唯一遗留**：需要真机/在场的验证项。建议 `npm run dev` 起一个会话一次跑完；每项给了触发方式和「算过」判据。失败不用修，记录现象即可（哪一步、什么表现、日志见 `<系统临时目录>/ready-directchat.log` / `ready-tools.log` / `ready-browser.log`）。

# A. 本会话新件（2026-07-05 落地，首次真机）

## A1. D1 — agent 后台建标签立即可见且不抢焦点
- **触发**：让 agent 做任意浏览器任务（如「打开 example.com 看看标题」），你同时停留在自己手动开的另一个标签页上。
- **算过**：agent 的标签**立即**出现在竖向标签栏（不用切换后才冒出来）；且你当前浏览的标签**没有被抢焦点**、地址栏没被改写。
- 代码侧已证：行为测试×2 + 门控次序合同；真机项=视觉确认。

## A2. D7 — LLM 维护回合首轮观察
- **触发**：正常使用（维护轮挂在 crystallize 6h tick 上，启动后 ~90s 有一次首查）。需至少一张 staged 信念卡存在才会烧真轮（空信号跳过）。
- **算过**（看两处）：
  1. 设置页 → 信念卡/知识面板 → llmRound 状态从「未接入驱动」变为真实快照（skip 或 run + 时间戳）。
  2. `ready-agent-metrics.log`（系统临时目录）出现 `maintenance_audit` 行：`decision:"skip"`（reason=switch_off/no_signals/quiet_within_interval 均正常）或 `decision:"run", llmCalls:1`。
- **预算安全阀**：`maintenance.llmRound.enabled` settings 行设 'false' 可一键关停；6h durable 节奏窗口重启不重置。
- **红旗**：单日 `decision:"run"` 超过 4 次、或出现非 staged 的新卡（LLM 铸出 active 卡=合同违规，立报）。

## A3. D19 — 事件/活动类实时问题进浏览器工作流
- **触发**：问 agent「这周末有什么演出」或「查一下故宫的开放时间」。
- **算过**：走浏览器/网页查询工作流（可见浏览器动作），而不是凭记忆直答。
- **反向**：说「帮我写一篇演唱会回顾文档」——应走文档流，浏览器不启动。

## A4. D4 — 模型声明验收标准（弱观察项）
- **触发**：给一个多步/研究型任务（如「调研 X 并把结论写成文档」）。
- **算过**：不要求模型一定调用；若 metrics log 出现 `model_criteria_declared` / 终态出现 `model_criteria_merged`，说明通道通了。任务卡裁决正常即可。

## A5. D6 — 文档任务自动保存兜底（回归确认）
- **触发**：让 agent「新建一份笔记写三行内容」，观察它未显式保存时的收尾。
- **算过**：终态消息含保存路径（自动保存兜底生效），不出现「我准备执行…但未能启动」的误包装。

# B. Route §6.1 真机欠账（此前会话码净待验，本会话未改动其代码）

## B1. R1 — 小红书发布全链（R18 三盲区收口后）
- **触发**：重启现源（记录 commit：当前 HEAD），走一次图文发布全链。
- **算过**：「发布」点击落地 → 成功证据铸造一次通过；`browser_transaction_unconfirmed` 如实触发/不误触发。
- 顺带：XHS 拖拽出视觉分析、账号页采集冻结真实笔记（R4/R5）各试一次；失败定位为站点/登录态问题也算关账（登记现象）。

## B2. Phase I P0 — 微信远程确认往返
- **触发**：真微信给绑定线程发一个需要确认的任务（如高危动作）。
- **算过**：确认卡 → 微信 → 答复 → 卡收口，一次闭环；失败路径有可读播报（不是静默）。

## B3. Phase M — server-filesystem stdio MCP
- **触发**：设置页配一个 stdio server（官方 server-filesystem），跑一条跨 server 组合任务。
- **算过**：全程工具日志/授权/预算可观测；工具失败转结构化结果不炸 run。

## B4. MCP 本地二进制（Pencil.app 型）
- **触发**：让 agent 代装一个本地二进制 MCP server。
- **算过**：两阶段确认卡跑通、装成功、工具可见。

## B5. 飞书 CLI 安装（run_setup_command）
- **触发**：让 agent 执行 `npx @larksuite/cli@latest install` 类安装。
- **算过**：经确认卡跑通（两阶段：解析→confirmAck 执行）。

# C. 本会话大规模重锚的抽查（低成本走查）

## C1. 浏览器 UI 抽查（vertical-tabs 合同重锚背书）
- 打开浏览器模式：竖栏 52px 图标栏正常、TopBar 地址栏正常、启动/主题切换过渡遮罩不盖住竖栏（遮罩从竖栏右缘起）。

## C2. 设置页抽查（合同重锚背书）
- 设置页各区块标题 20px、区块间距正常；AI 设置面板：模型列表 ↔ 二级编辑器切换正常（1120/760 宽度切换）。

## C3. RSS 抽查
- RSS 模式：源下拉与任务菜单浮层为液态玻璃面板样式、可正常开合。

## C4. 浏览器纪律片段（discipline 资产压缩背书）
- 任一浏览器任务运行时无异常即可；若发现 agent 在表单页乱赋值/盲点按钮，报出来（纪律片段语义在压缩中丢失的信号——代码侧已尽力保全全部机械事实）。

# D. 关账方式

跑完把结果（通过/失败+现象）回给下个会话即可；失败项会按「站点/登录态问题登记」或「真回归修复」分流。route §6.1 表格与本清单同步收账。
