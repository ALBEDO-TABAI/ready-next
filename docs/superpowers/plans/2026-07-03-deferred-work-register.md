---
title: 暂缓工作登记（P1-b / P2-2 前置 / P2-6 decay）—— 有意暂缓，精确修法已定
date: 2026-07-03
status: register
enforce: false
note: >
  这三项在 2026-07-03 夜间自主推进中被有意暂缓（renderer/中枢/删除类高危，
  无人值守不宜动），非遗漏。根因均已确认、修法已定，留待可监控会话按此实施。
---

# D1 — 标签不显示（P1-b）

**现象**：agent 新建的浏览器标签不进标签条，要切换/新建才出现。

**根因（已用探针 + 代码确认）**：
- 可见性本身正常（`scripts/probe-agent-tab-visibility.cjs` 证：离屏/detached WebContentsView 仍 `visibilityState=visible`，渲染/采集不受影响）。这是纯 UI 呈现问题。
- `browser:tabOpened` 事件**只在 popup 路径发**：`src/main/modules/browser-engine/ipc-handler.ts:653`。
- 通用 `tab-lifecycle-service.ts` 的 `createTab`（`ensureAgentTab` 建 agent tab 走这条）**从不发 tabOpened**。
- renderer 侧用户自建 tab 走 `openWebpageInBrowser.ts:34` 客户端直接更新 store；agent/main 建的 tab 无 renderer 通知 → 不进标签条，直到 `switchTab` 触发 getTabList 刷新。

**修法（已定，未实施）**：
1. `tab-lifecycle-service.createTab` 建 agent/background tab 后发 `browser:tabOpened`，payload 带 `activate:false`（新增字段）。
2. renderer `useBrowserRuntimeEffects.ts:275`（现无条件 `setActiveTabId`）在 `activate===false` 时只 `addTab/updateTab`，**不抢占 active**。

**为何暂缓**：含"不抢焦点"门控，做错会变成更糟的抢焦点回归；renderer 焦点行为 headless 无法验证，需真机。无人值守不宜动浏览器 UI 焦点。

**验证方式**：真机建 agent tab → 应立即出现在标签条且不抢当前 active tab。

---

# D2 — criteria 前置注入模型面（P2-2 剩余半）

> **2026-07-03 已完成（梯队三，可监控会话）**：走方案 B——`system-reminders/criteria-self-check-reminder.ts` 注册 `criteria-self-check` topic，`agent-sdk-turn-orchestrator` 每次模型调用前注入（与 active-plan-step/browser-action-session 同一组装缝）。只对结果型任务注入（multi_step/research/media/browser_transaction）；taskType 取 `liveTaskBudgetRuntime?.taskType || inferredSdkTaskType`；module 保守映射（browser_transaction→browser，余者 system 基线）；括号尾注截断脱内部术语。测试 `criteria-self-check-reminder.test.ts` 5/5（含与终态裁决同源断言）。以下为历史记录。

**已完成的半**：criteria 落库——finalizer 已把解析后的验收 criteria（items + satisfied/total）写入 projection（`run-finalizer.ts` 的 terminal `store.update`）。数据侧就绪，daily-task-index criteriaProgress 有数据源。

**未完成的半**：把 criteria 注入模型可见面，让 agent **事中自检**（"裁决从事后打回变事中自检"）。

**根因/障碍（已确认）**：
- criteria 依赖 `taskType`（`resolveCriteria(taskType, module)`，`criteria-templates.ts:108`）。
- `prompt-assembly.ts` **无 taskType**（grep 确认无匹配）——不能直接在系统提示里加 criteria 段。
- live-path reminder 是散点 steer（`agent-sdk-turn-orchestrator.ts` 里 `createSystemReminderRegistry()` 按事件临时建），**无单一 per-turn 注入点**。
- taskType 在 live path 可得：`agent-sdk-turn-orchestrator.ts:1211` `liveTaskBudgetRuntime?.taskType`。

**修法（两选一，未实施）**：
- A) 把 `taskType/module` 穿到 `prompt-assembly` deps，加一个"本轮完成标准（自检）"段，渲染 `resolveCriteria(taskType, module).items` 的 `text`。
- B) 在 turn-orchestrator 首轮注册一个 `criteria-self-check` reminder（新 `ReminderTopic`），文本由 `resolveCriteria` 渲染。
- criteria `text` 已是模型可读中文散文（如"至少一个产物或状态变更 proof"），适合直接注入；注意部分含内部术语（如"assistant_response digest"），注入前可只取括号前主句。

**为何暂缓**：两条路都改中枢文件（prompt-assembly / turn-orchestrator），无人值守高危。

**验证方式**：多步任务运行时，模型上下文应出现本轮验收标准；agent 宣告 done 前自检是否满足。

---

# D3 — belief-decay 生产接线（P2-6 剩余半）

> **2026-07-03 已完成**（P5d 确定性迁移）：decay 轮已接进 `runtime.runCrystallizeRoundOnce`，带 `belief_decay_round_fired` 账本 + 正向 gate 覆盖（现由 `check-mandated-capability-is-live.cjs` 的 live-required 条目守护）。以下为历史记录。

**已完成的半**：archiveOldL2 定时雷已拆——`memory-lifecycle.ts:archiveOldL2Memories` 按 `category='belief'` 排除信念卡镜像（防 90 天静默归档）。真正的"丢卡"风险已消除。

**未完成的半**：把确定性衰减轮 `runBeliefDecayRound` 接进生产，让信念卡按龄/使用度**优雅衰减**（H→M→L→mark_decayed→delete）。

**现状（已确认）**：
- `belief-decay.ts` 全套确定性纯函数已存在：`decideBeliefDecay`、`runBeliefDecayRound(cards, effectors, now)`、`BeliefDecayEffectors{setConfidence,markDecayed,deleteCard}`。
- `collectBeliefDecaySignals(store, readMirror, now)`（`maintenance-llm-round.ts:242`）已存在，`readMirror` 需返回 `{accessCount, wasUsefulCount}`。
- **仅在 `maintenance-llm-round.ts` 内被调用**（LLM 维护轮，需注入 deps），生产是否真跑取决于该轮是否被调用并传 decay deps——未接。

**修法（未实施）**：
1. 建 `BeliefDecayEffectors`：`setConfidence/markDecayed` = `store.readCard` 改 frontmatter.confidence/source 后 `store.writeCard`；`deleteCard` = 复用 crystallize effectors 的 deleteCard。
2. `readMirror`：从 belief 镜像读 `access_count`（P2-4 已在注入时递增）；`was_useful_count` 镜像尚无该列——先按 0，或加列（另开）。
3. 把 `runBeliefDecayRound(collectBeliefDecaySignals(store, readMirror, now), effectors, now)` 接进 **确定性 crystallize 轮**（`runtime.runCrystallizeRoundOnce` 内，P2-1 已接线的那个），而非依赖 LLM 轮。

**为何暂缓**：
- decay 会 **demote/delete 信念卡**——无人值守下误降/误删高危。
- P2-4 使用计数刚接通，`access_count` 需时间积累才有意义；此刻按龄衰减会误降"有用但计数未积累"的卡。
- `was_useful_count` 镜像列缺失，信号不全。

**前置条件**：P2-4 数据积累一段时间 + 可监控会话。

**验证方式**：构造老龄+零访问的 staged/low 卡 → decay 轮应按阈值 demote/mark；高访问卡应 keep/promote。务必先在测试里跑 `decideBeliefDecay` 阈值矩阵再上生产。

---

# D4 — appendModelCriteria 接裁决（梯队二复验后缓办，2026-07-03）

**现状（本轮复验确认）**：`appendModelCriteria`（`criteria-templates.ts:179`）纯函数已存在（模板项后追加模型声明标准，m1/m2 命名空间，不可覆盖模板），零调用者。裁决 live 路径 = `run-finalizer.ts:623 resolveCriteria → adjudicateTerminalOutcome`，criteria 已落库（P2-2 前半）。

**为何缓办（比 handoff 预估重）**：**捕获通道不存在**——全仓无任何字段/工具入参/解析点承载"模型规划期声明的验收标准"（grep acceptanceCriteria/modelCriteria/declaredCriteria 零命中；steps/packet 均非验收标准语义，混用会造成裁决漂移）。接线的真实工作 = 设计模型可见的声明通道（规划工具 schema 加字段或 D2 的 reminder 方案捎带）+ 落库 + finalizer merge + 裁决漂移监控。改模型可见面 + 动裁决脊柱，无人值守不宜。

**修法（未实施）**：与 D2 合并设计最佳——D2 把 criteria 注入模型面做"事中自检"时，同一通道天然是模型声明补充标准的回传口；届时 `appendModelCriteria` 在 `resolveCriteria` 后调用并随 P2-2 落库。

**2026-07-03 梯队三补充勘察**：D2 已实施（注入=main→model 单向），但回传通道仍缺——projection steps 由 `projectionPatch`（域适配器/frame patch）产生，**不存在模型可见的 plan 工具**可加 `acceptanceCriteria` 字段。真实工作量=新建模型可见工具面（schema/registry/gateway/policy/authorization）或设计受控回传协议，再 + finalizer merge + 漂移监控。维持缓办。

**前置**：声明通道设计决策（新工具 vs 协议）；实施时把 `check-mandated-capability-is-live.cjs` 的 dark-defect 条目翻成 live-required。

---

# D5 — RunFeedbackRepository 全栈接线（梯队三，登记于 2026-07-03）

**后端切片已完成（2026-07-03 梯队三无人值守部分）**：`run-feedback-group.ts`
（`agent:runFeedback:submit/list`，代码侧校验：rating 1-5 整数 / signal≤120 /
comment≤2000 / 空反馈拒绝 / 缺省反馈槽 `fb_<runId>` upsert 复交）+ ipc-handler
注册（repository 按需从 rawDb 构造，SQLite 不可用回 `sqlite_unavailable`）+
preload `runFeedback` API + electron.d.ts 类型 + 行为测试
`run-feedback-group.test.ts`（6 用例）。顺修 repo 构造器类型对齐项目惯例
（`Database.Database` → `DatabaseConnection`，dark 期间遗留的未暴露失配）。

**仅剩待做**：renderer 评分控件（任务卡/质量面板挂 `window.electronAPI.runFeedback`）
+ 真机回归。完成前能力仍非 live（无用户入口），
`check-mandated-capability-is-live.cjs` 条目保持 dark-defect；UI 落地时翻条目。

**前置**：可监控会话（renderer UI 白屏高危 + 真机验证）。

---

# D6 — agent-sdk-runtime 三测试与行动宣告闸的合同碰撞（已知红，登记于 2026-07-03）

**现象**：`verify:evolution-p6o` 红，`agent-sdk-runtime.test.ts` 三个用例失败：keeps browser tools hidden for local document attachment tasks / repairs new document turns that mutate without saving / exposes upload browser tools for upload workflow intent。

**根因（已确认）**：行动宣告闸（CLAUDE.md §2"零工具的行动宣告不得直接判 done——先转向、再 checkpoint"）把零工具宣告轮的最终文本包装成 `我准备执行"…"但未能启动，已保存断点…`，而这三个用例仍期望模型原文（如 `我会按文档处理。`）。闸与测试都是前序会话的未提交改动（两文件均 M），碰撞属 base 自带，非梯队一/二引入（本两轮零 sdk/文档道改动）。

**待做**：语义仲裁——这三个场景里宣告闸是否应触发（fixture 是否该带工具调用/是否属"宣告"），按结论改测试 fixture 或闸的豁免条件。涉及文档道/浏览器道行为设计，非机械修复。

**前置**：可监控会话。修复前 `verify:evolution-p6o` 的红以本条为已知原因。

---

# D8 — browser_transaction_unconfirmed 的 checkpoint 语义（R1 呈现的结构修，登记于 2026-07-03 夜）

**现状**：finalizer 对交易类 done→degraded 一律 `effectiveStatus='error'`（run-finalizer.ts:469-471），**不检查 continuation 可续性**（非交易分支 :472 有 canResumeAsUserPoint→checkpoint）。R1 修复已把 error 文案改为可读+下一步（run-collector userFacingTerminalErrorText），但语义上"停在编辑器可继续"的 run 更应是 checkpoint（部分进展+断点）。

**待做**：交易分支同样尊重 canResumeAsUserPoint → checkpoint；牵动 p6d（run_meta 终态谓词/status alias）、check-run-finalize-funnel、sdkStatusFromTerminalReason 映射与 renderer 卡呈现，需合同先行 + 在场。

# D9 — R3 采集期间的同 scope 任务混线与 tab 保护（登记于 2026-07-03 夜）

**实锚（metrics/tools.log）**：R1/R3 在同一会话连跑；15:04 run 采集中途 `navigate creator.xiaohongshu.com/publish/publish`，15:06 run `visible_collect` 启动后模型在同 tab `click_text "写长文"`——历史发布任务的上下文让模型在采集等待间隙"续做"发布，夺走采集页面。且两个 visible_collect 任务（54ebcae8/6563f6e2）在 browser.log 与 metrics **零运行/终态痕迹**（可观测缺口）。

**待做（三件，独立 slice）**：
1. **采集 tab 写保护闸**：活跃 visible-collect 任务绑定的 tab 上，click/type/navigate 等写动作返回结构化 busy（附 wait/get_task/cancel_task 出口）——代码闸，需任务注册表按 tab 查询面；
2. **browser task 终态可观测**：visible_collect 任务 start/close 进 metrics 账本（fired 文化对齐）；
3. **同 scope 任务锚定**（行为层，最后）：上一 run 非终局（unconfirmed/checkpoint）时新指令的任务边界提醒，防上下文串味。

**前置**：可监控会话；1/2 可先行。

# D10 — 创作页 iframe 穿透 + staged 站点卡不生效（R 第二轮实锚，2026-07-04）

**实锚**：R1 76s/20 工具全耗在"写长文"tab（iframe 内，click_text/eval/CDP/坐标四路全无效，模型自查 frame tree）；启动日志 `site_card_user_override_skipped: www.xiaohongshu.com-selector_missing`×2——**学习系统已产出修正站点卡但 staged 未确认被跳过注入**，agent 带着学到的知识原地重摔（E4 反例）。

**待做**：①click/act 工具链 frame 感知（遍历 frames 或 CDP DOM.querySelector 跨 frame）；②staged 站点卡的确认可见性——会话内提示"已学到 X 待确认"或设置页角标，打通 E4"不进 Settings 也能确认"路径。

**已完成（2026-07-04，用户在场）**：
- ① frame 穿透：automation-service 增 `listContentFrames`/`executeJSInFrame`（frameKey='0' 主帧、子帧 `pid-rid`，WebFrameMain.framesInSubtree）；`read_page_map` 逐子帧补采、目标打 frameKey（targetId 的 frameId 槽位首次填真值，图上出现 `- iframe "url"` 分组 + evidence.frames）；`act_on_target` 的 probe 与 act 按 frameKey 路由回同一帧（act 靠帧内元素重枚举定位，跨帧索引不通用），帧消失收 `stale_page_map`；`browser_click_text`（工具 case + workflow step）主帧 miss 后逐子帧 JS click（子帧坐标系与顶层视口不同构，不走坐标路径），miss 文案标注已搜帧数。行为测试 `browser-frame-penetration.test.ts`。
- ② staged 卡可见性：确认链路本已存在（BeliefCardsPanel + `agent:beliefCards:transition`），缺口只是可发现性。`extractCrystallizeCards` 增分支：status=staged 且 source 命中站点卡学习三种前缀（failure-learning:/possible-update-of:/possible-risk-update-of:）→ crystallize 待确认卡（adopt_candidate→"去确认"跳 Settings，requiresExplicitConfirm=true）；其他 staged 信念卡不投影。
- 残余（不阻塞复测）：feed"去确认"跳 Settings 页但未锚定到信念卡面板；子帧内坐标类动作仍主帧限定。

**D10-c 根因修正（2026-07-04 第四轮，Chrome 真实页面实证）**：第四轮复测新构建仍卡——上真实 creator 页取证发现**"写长文"根本不在 iframe**（页面唯一 iframe 是空 src 隐藏辅助帧；round-2"在 iframe"是模型叙事，被误采信）。真根因=**定位启发式与现代 React 站点形态不匹配**：创作页语义元素仅 2 个，整页控件是零标记 span/div（无 role/onclick/非 button，React 根委托监听），click_text 的 isClickable、map 的 READY_AGENT_TARGET_SELECTOR、act 的裸 el.click() 三层全部失明/失效。修复（原则：cursor:pointer 视觉可点击=可点击）：①readyRoleFor 增 'clickable' 角色 + readyPointerClickableElements 收集级（pointer 边界收敛/可见/短文本/cap 40）→ map 首次看见委托型控件（真实页实证收到 9 个含全部 tab）；②buildClickByTextJs/buildLocateTextTargetJs 文本叶子→cursor:pointer owner 回退（locate 返回 owner 坐标走可信坐标点击）；③act click 分支升级 pointerdown→mousedown→pointerup→mouseup→el.click() 序列（真实页实证触发 from=tab_switch）；④TARGET_ROLES 收 'clickable'。frame 穿透保留（架构正确，另一半根因）。 — 工具回执 nextSuggestedAction 被投影成任务卡步骤/判据（2026-07-04）

**实锚**：卡面"read map again on tab tab-1 · 0/1 0%"与"finish with transaction proof · 1/1 100%"实为 act_on_target 回执的 nextSuggestedAction 文案（browser-tools :3318/:3055），经 browserActionSessionPatch 流入 projection 后被任务卡渲染成步骤/判据进度——呈现语义伪装，且"假判据 100%"严重误导。**待做**：回执建议只进 narration/meta，不得进 steps/criteria 形状的投影字段；补投影形状测试。

# D12 — read_page_map settle 重试 + 站点流程知识（真机第五轮实锚，2026-07-04 午，已完成）

**实锚**：D10-c 新构建下双模型复测——mimo 19s/30s 快败：navigate 后 0 等待立即 map（SPA 未渲染完→图近乎空→放弃）；gpt-5.5 走通切 tab/填标题/填正文（新定位链实证生效），但在"找发布/发送按钮"上兜转——**XHS 长文编辑器没有直接发布按钮，必须先点「一键排版」进预览才有「发送」**（站点流程知识缺口，非感知/智力缺口）。另：13:03 的 lease_required 是用户操作浏览器触发 user_signal 接管的**正确让位**，非缺陷（等待呈现粗糙并入 D8/D11）。

**已完成**：①read_page_map 目标数 <5 时工具层 waitForReady(3s)+重采一次（返回最新 generation 捕获防 stale 合同破坏，evidence.settleRetried 可观测）——把"先等再读"纪律从模型素养下沉为工具合同；②bundled 站点卡改写：④ 步骤改为「一键排版→预览→发送」真实流程、删除"转 Power CDP 读 frame tree"坏建议（正是把模型带进被拒 power 通道的推手）、补"目标少=未渲染完先等"指引；③read_page_map 的 nextSuggestedAction 铲掉 power_cdp 引导文案（D11 假步骤源头之一）。

# 汇总
| 项 | 已完成 | 待做 | 高危点 | 前置 |
|----|--------|------|--------|------|
| D1 P1-b | 根因确认 | 发 tabOpened(activate:false)+renderer 不抢焦点 | renderer 焦点回归 | 可监控会话 |
| D2 P2-2 | **全部完成（梯队三）**：criteria 落库 + criteria-self-check reminder | — | — | — |
| D3 P2-6 | **全部完成（P5d）** | — | — | — |
| D4 appendModelCriteria | 复验+挂号+通道勘察 | 声明通道设计（新工具 vs 协议）+ finalizer merge | 模型可见面 + 裁决漂移 | 通道设计决策 |
| D5 RunFeedbackRepository | **全部完成（梯队三）**：后端+评分控件+registry live-required | 真机回归确认 | — | — |
| D6 sdk 三测试 vs 宣告闸 | 根因确认 | 语义仲裁后改 fixture 或闸豁免 | 文档/浏览器道语义 | 可监控会话 |
| D7 LLM 维护回合 | 评估完成（见 tier3 closeout §4） | 生产驱动决策+LLM 预算+staged 写监控+符号禁令 gate-flip | 真实 LLM 花费 + 维护写卡 | 专门监控会话 |
