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

> **2026-07-05 已完成（f034778f）**：createTab 在 background===true 时经
> host.buildTabPayload 补发 browser:tabOpened + activate:false；renderer
> onTabOpened 在 activate===false 时只 addTab/updateTab 即返回不抢焦点。
> 行为测试 ×2 + renderer 门控结构合同 ×1；真机焦点视觉验证在回测清单。
> 以下为历史记录。

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

> **2026-07-05 已仲裁完成（a2fa0666）**：三个失败实为三根因——①闸对 fixture
> 错（承诺文案改完成陈述）；②闸让位文档道自动保存兜底（newDocumentNeedsSave
> 时不拦，义务由 runtime 确定性兑现）；③upload workflow 曝光 content_tasks 是
> 6e99f0e6 有意策略（唯一裁决点），fixture 断言翻真值。verify:evolution-p6o
> 全链回绿。以下为历史记录。

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

# D13 — map 双端尾部偏置：主行动按钮死在 DOM 尾部（真机第六轮实锚，2026-07-04 午后，已完成）

**实锚**：第六轮 38 工具/7 分 20 秒，行为全对（切 tab/一键排版/Power 探测/填充/读回全走通），最后卡在"找不到发布按钮"——而截图里页面底部红色「发布」赫然在目。两个尾部偏置叠加：①XHS 按钮是 `div.btn-wrapper`（pointer 收集级），文档序 cap 40 被超长设置页前部的 pointer 行吃光，DOM 尾部的「发布」进不了目标列表；②map 文本砍尾式截断（model 传 max_bytes:12000），主 CTA 在页面底部=DOM 尾部=第一个牺牲品。

**已完成**：①pointer 收集 cap 40→120 扫描上限内全收，超 40 时保头 28+尾 12（头部导航/tab 与底部 CTA 双端都在，规则确定性保 probe/act 重枚举索引一致）；②buildPageMap 改中段截断（头 ~75%+尾 ~20% 预算，`… (truncated middle) …` 标记，行边界切割），纯测试钉住"尾部 CTA 活过截断"。

**遗留观察**：13:03 起挂到 16:33 的"等待确认——确认后中断 Agent 浏览器控制"横幅从未过期——接管确认卡缺 TTL/上下文结束自动撤（并入 D8 等待呈现语义）。

**D13-b（第七轮实锚，2026-07-04 傍晚，已完成）**：D13 构建下 20KB map ×3 仍不见「发布」，模型 power_eval 连环自查（含 querySelectorAll('button')+disabled 检查）后仍无果被用户手停。排除法定根因：非原生 button（模型自己的 button 枚举已排除）、非尾部截断（D13 已修）→ **pointer 收集的"祖先已覆盖"跳过用了整张语义选择器表（含 `[role]`）——微前端设置页通篇 role=main/region/dialog 容器，全部 pointer 按钮被误杀**。修复：新增 READY_INTERACTIVE_ANCESTOR_SELECTOR（仅真可交互祖先：a[href]/button/input/…/role=button|link|tab 等），预登录页回归对照零丢失。站点卡补逃生口："map 找不到明确看到过的按钮→直接 browser_click_text 精确文本点击（自带 pointer-owner+跨帧回退），不要多轮 Power eval 自查"。mimo 定性：轨迹已全对（等待→map→click_text→map），45s/6 工具诚实收口——纪律/知识/感知已工程兜底，剩余是模型续航（多步坚持度），无工程杠杆可再卸。

# D14 — Web Component 失明：发布按钮是 <xhs-publish-btn> 自定义元素（真机第八轮实锚，2026-07-04 晚，已完成）

**实锚**：dev 修复后 R1 重测（无视觉模型驱动），行为全对（进发布页/填标题/贴正文全成，targets=39 truncated=false——D13 双端修复实证生效），随后 4 分钟“找发布按钮”挣扎：7 连发 power_eval 枚举、analyze_viewport 撞 no_vision 结构化失败、最终模型自己发现 `document.querySelector('xhs-publish-btn')`——**「发布」是 Web Component，真实按钮藏在 shadow root 里**。三层全盲：语义选择器不认自定义标签、pointer 扫描清单（div/span/li/p/img/svg）不含它、cursor 信号在影子内侧。次级观察：模型全程未用站点卡逃生口 browser_click_text（知识采纳缺口）；用户 11:17 手停。

**已完成**：①map 采集新增 readyCustomElementHosts 收集级（light DOM 可枚举的自定义元素 host：可见/短文本/非交互祖先覆盖，cap 16），readyRoleFor 对带 '-' 标签直接判 'clickable'——「发布」以 clickable 进图；②act click 分支升级：elementFromPoint 逐层穿透 open shadow root，事件派发到命中节点（composed:true 冒泡回 host），命中不属于目标时保持原行为；③click_text/locate 的 pointer-owner 爬升跨 shadow 边界跳 host（这两个定位器本就穿透 open shadow root 枚举）；④站点卡记录 `<xhs-publish-btn>` 事实 + 升级链（act 无变化→browser_click_at 按 box 中心可信坐标）。行为测试：browser-probe-collect.test.ts 在 node:vm 执行真实注入 JS 断言采集合同（收录/降噪/顺序确定）。顺手清偿：D12 落地时未同步的 4 个罐头 map 测试（<5 目标误触发 settle 重采）按新合同补齐 ≥5 目标夹具，browser-tools 套件回绿。

**残留**：closed shadow root 下合成事件仍到不了内部监听器（升级链=click_at 可信坐标，已写进站点卡）；「模型不采纳站点卡逃生口」是知识注入呈现问题（候选：把逃生口写进 map 的 nextSuggestedAction 而非只在站点卡），并入后续观察。接管确认横幅无 TTL 本轮再现（并 D8）。

**D14-b（同晚追加）**：用户实际选的是 gpt-5.5（有视觉），被判无视觉的机制=openai-compatible 中转的 S5 保守默认（红线刻意行为，设置页「网页视觉」三态开关可覆盖且卡片描述已显示判定结果）——真缺口是失败时刻零引导：模型只拿到裸 reason 码，原地挣扎、用户不知有开关。已修：`analyzeViewportWithVision` 拒绝时携带 `remediation` 指引（区分显式关闭 vs 中转保守默认，指明设置路径 + 「改用非视觉通道、不要重试」），`browser_analyze_viewport` 载荷透传；行为测试 browser-vision-remediation.test.ts 钉两分支。

**D14-c（第九轮实锚，2026-07-04 深夜，已完成）**：用户开启视觉+重启 dev 后重测，模型走得更远（空白恢复标签自愈导航、一键排版坐标点击进最终发布页 target=article），但最后 39 目标 map 仍无「发布」——**D14 首版 readyCustomElementHosts 的 `scanned>=6000` 文档序扫描配额在 publish 页前部烧光，尾部 host 永远轮不到，复犯 D13 尾部偏置定律**；vm 测试假页面只有几个元素测不出配额问题。修：便宜 dash 标签判断走完整棵树、贵检查只对 custom 候选做（>200 头尾各 100）、产出 >16 保头 10+尾 6；空文本 host 不再淘汰（closed shadow 读不到渲染文本），readyLabelFor 给自定义标签 tagName 名字回退。回归钉：7000 填充元素尾部 host 存活测试 + 头尾配额测试 + tagName 回退测试。教训：**任何新的文档序扫描/配额代码默认自带尾部保护；行为测试的假页面必须大到能触发配额**。本轮另证：前三张 targets=2 的 map 是恢复期空白渲染器（沙箱偶发失败残留），模型重导航自愈，非采集器回归。

# D15 — 主进程 fd 耗尽：chokidar v5 在 macOS 每文件一个 kqueue fd（真机第十轮实锚，2026-07-04 深夜，已完成）

**实锚**："任何页面都载入不了"（全部 ERR_FAILED -2）+ render_process_gone crashed exitCode:6 每次 spawn 必死。判别链：崩溃签名=同一 renderer 存根 seatbelt abort → 同一时刻同一二进制 mini 探针全绿（机器/二进制清白）→ 单实例 → **lsof 实测主进程 10572 个 fd，全是笔记库文件读句柄** → ready-search.log 九个 watcher 根（lib-a 5836 文件 + Google Drive 云目录等）→ chokidar v5 源码裸 `fs_watch(path)`（v4 起弃 fsevents，macOS 退化为每文件一 kqueue fd）。**对照实验定罪：同一棵 lib-a 树，chokidar v5 fd 增量=5836（与文件数分毫不差），原生 recursive fs.watch 增量=0。** 机制：B7（4/25）埋雷，库随采集增长，Jul 1 首次越线发病；fd 爬坡期偶发 spawn 失败（=今天全天"偶发沙箱失败"的高概率真身，含引爆 primer CHECK 崩溃的初始 renderer 死亡），满限后全灭。

**已修**：file-watcher.ts 增 `createDarwinRecursiveWatcher`（原生 `fs.watch(root, {recursive:true})`，libuv 走 FSEvents 每根 1 fd；'rename' 按存在性判 add/unlink、目录事件过滤、错误/ready 语义对齐 ChokidarLike），darwin 默认工厂切换，linux/win 仍走 chokidar；注入缝 chokidarFactory 保留。行为测试：真实 fs 的 add/change/unlink 全链 + 目录过滤（file-watcher 套件 19/19）。

**残留观察**：本机今天更早的"偶发沙箱失败"归因 fd 爬坡为高置信假设（当前 100% 失败=fd 耗尽是实测结论）；D15 后若偶发仍现再开环境线。fd 余量可观测（boot 打点）暂未加，若复发补。

# D16 — agent 点击触发原生文件选择器悬挂工具环（真机第十一轮实锚，2026-07-04 深夜，已完成）

**实锚**：D15 修复后 R1 重测，链路史上最远——`xhs-publish-btn` 以尾部保留位 #40 进图（D14-c 实证）、act 点击 ok:true（3.5s 内含行动确认闸"风险请求"用户点允许=**发布类外发动作过闸按合同工作**）、进入长文最终 composer（文章渲染成图片卡）、坐标点底部「发布」后预算耗尽 unconfirmed 收口。期间 agent 某次点击命中「+ 添加图片」瓦片，**弹出原生文件选择器**：主进程模态对话框，工具环无法感知/关闭，只能人工取消——任何带上传控件的站点都可能让 agent 死等。

**设计**：agent 持租约的 tab 经 CDP `Page.setInterceptFileChooserDialog(enabled:true)` 拦截（cdp-session-service 已有会话面）；chooser 打开且无 pending 的 `browser_upload_scope_attachment` 时自动取消 + 给模型结构化回执（`file_chooser_intercepted`，提示走 upload 工具链：list_upload_targets → upload_scope_attachment）；有 pending 上传时按现有 upload 合同喂 `DOM.setFileInputFiles`。租约释放时关拦截，用户手动操作不受影响。

**顺带观察**：本轮模型三次重填标题、两次重贴正文（read_back 纠偏在工作，未误报成功）；「发布」点击后 25s 思考间隙疑似 chooser 弹出时刻之一。成功证据读取（发布成功信号→proof）仍是 R1 关账的最后一环（并 D9 proof 铸造）。

**实施（2026-07-04 深夜，c8f182a4）**：BrowserFileChooserGuard（electron-free，注入 BrowserCdpSessionService）；武装点=tool-executor 浏览器写动作过写租约闸后 best-effort（读工具不武装，防纯阅读会话把用户选择器永久打死）；`Page.fileChooserOpened` → `file_chooser_intercepted` 注记随下一次浏览器动作输出交付（与 D18 权限注记同队列）；解除点=写租约离开 held 时引擎统一 disarmAll。行为测试：真 CDP 会话服务 + 假 debugger 宿主四合同。与设计的差异：未做"自动取消"（CDP 拦截下站点只是等待文件，模型按注记走 upload 工具链注入即可继续，无需取消语义）。

**D16-b（同晚伴生修复，已完成）**：用户实证"agent 操作过的 tab 里发布按钮人点也无反应，新开 tab 手动全流程可发"——tab 级页面状态被写坏。头号根因=React 受控输入失同步：act fill / buildTypeJs / type_smart setText 三处直接 `el.value=` 赋值被 React 实例上的 valueTracker 吞掉，DOM 有字、框架状态为空，表单校验静默失败。修=三处全部改原型链原生 setter（`Object.getOwnPropertyDescriptor(HTML*Element.prototype,'value').set.call(el, v)`）再派发 input/change。

# D17 — 外发动作预授权：用户原话即授权（设计定稿待实施，2026-07-04）

**动机（用户定向）**：无人值守场景（"帮我发小红书，我出门了"）不能卡在发布点击的行动确认闸上。当前行为：发布类外发点击每次弹"风险请求"等人点允许——有人在场是安全带，没人在场是死锁。

**设计（先合同后代码）**：
- 授权源=用户逐字请求（最小传话铁律的 userRequestVerbatim）：run 启动时若用户原话明确命令外发动作（发布/发送/投递语义，经意图分类非提示词注入），为该 run 铸造 **scoped transaction grant**（作用域=本 run + 目标站点 + 该动作语义类；落审计账本 grant_minted）。
- act/click 命中发布类 live target 时先查 grant：命中→放行并审计 grant_consumed；未命中→照旧弹闸。
- **永不预授权**：支付/转账/改凭据/访问控制/删除类（browser-power.ts 破坏性枚举），无论原话怎么说都过闸。
- 闸弹出且无人响应时不得无限挂：超时（如 10min）按 checkpoint 收口（可续跑），不算失败——并入 D8 等待语义。
- 设置页暴露总开关（默认开启原话预授权；用户可改回"每次都问"）。

**验收**：R1 无人值守全链（含发布点击）零人工介入跑通；支付类模拟目标仍被闸拦；grant 账本可查。

**2026-07-04 第十二轮 rescope**：用户两轮看到的「风险请求」弹窗经截图核实是**站点定位权限 modal**（`creator.xiaohongshu.com 想要使用定位`），不是行动确认闸——该类闸已由 D18 的 agent 驾驶期自动拒绝根治。第十二轮 act 发布点击全程无行动闸停顿（破坏性清单只有支付/改凭据/验证码，发布不在内）。D17 的 grant 机制暂缓实施：待下一次真机出现 `denied_pending_confirmation` / 确认卡真实拦住无人值守发布的证据再启动（先合同后代码，不为幻影前提建机制）。

# D18 — act 点击可信指针升级 + 站点权限 agent 自动拒绝（真机第十二轮实锚，2026-07-04 深夜，已完成）

**实锚**：D16-b 后重启复测，两轮 run 全部止步最终发布设置页：act 连点「发布」目标 ok:true 但按钮从未激活，run 以 browser_transaction_unconfirmed 诚实收口。三层根因：① closed shadow root 内部监听器对合成事件不可达（事件不向 shadow 内传播，host.click() 点不到内部按钮），且模型不采站点卡的 click_at 逃生口；② `readBack='map'` 时 `changed` 恒真（动作前 delta 对比整张 map，形状必不同）——模型拿不到「点击无效」信号；③ 发布设置页弹站点定位权限 modal sheet（无超时、无日志、挡住整个窗口），无人值守必挂。

**修复（9a3993b3）**：① act JS 回传点击坐标，工具层判无效果（前后 delta 未变且未开新 tab）时同一次调用内自动升级可信指针点击（与 browser_click_at 同 dispatchMouse 通道、破坏性闸门同构、grant_required 保持响亮），payload 带 `escalation` 审计；② changed 改用独立前后 delta 比较；③ 权限判决核心抽 electron-free `browser-permission-policy.ts`（纯函数），agent 持写租约期间需人工批准的权限自动拒绝（不弹窗、不缓存、注记随下一次工具输出交付），用户在场的运行期判决优先，权限请求/判决全量落 ready-browser.log。伴生（66d6f501）：AgentTabControlGate pending_confirm 45s 惰性 TTL——用户擦碰 agent 页后走开不再永久冻结 agent 写入+横幅常驻（真接管有租约级 takeover 兜底）。

**D9 证据链核验（无代码）**：transactionConfirmed → proof-collector → adjudicator t1 → run-finalizer 全链已建成，R1 此前拿不到成功证据纯因点击未落地；真机复测即验证。

**残项**：escalation 只处理主帧（iframe rect 坐标系不同构，stale_page_map 引导重读）；readBack='none' 不升级（无信号）。

# D19 — 意图门控漏判：事件/活动类实时问题判 local_chat（分析定稿待实施，2026-07-04）

> **2026-07-05 已实施（dc1ccf73 + 38d2a5ab）**：①EVENT_PATTERNS 主题类 +
> FRESHNESS 周末/今晚/这周/下周；②intent_gating_miss 漏判账本（tool-executor
> restricted 分支，按注册表 domain 判浏览器域，带 allowedBrowserToolCount 与
> 纯文本摘要）；③fixture 矩阵六用例（事件正例/一词多域负例/既有主题不变/
> 账本三态）。以下为历史记录。

**实锚**：真机 14:00 事件类消息应进浏览器工作流被判 local_chat → browser 组被抑制（audit 记录）。

**分析（2026-07-04）**：`live-info-intent.ts` 主题词表覆盖 weather/air/news/finance/sports/transport 六类；**事件/活动/场所类缺席**（演出、展览、活动、演唱会、门票、开售、场次、预约、排队、营业时间）——该类查询若再缺 LOOKUP 动词或 FRESHNESS 词，needsLiveInfo=false 直接落 local_chat。上游输入面已在第二轮修复（resolvePureUserTextForClassification 用纯用户话语判定，注入污染已排除），本项是词表覆盖缺口而非输入面缺口。

**提案（改判定需评估漂移，专门会话）**：① 增补 EVENT_PATTERNS 主题类 + 对应 fixture 矩阵（防已修案例回归）；② 漏判账本：run 被判 local_chat 但模型随后请求 browser 组/明确要开网页时发 `intent_gating_miss` metric 带纯文本摘要，让词表从证据演化而不是拍脑袋；③ 词表变更跑意图分类 fixture 全量 + 采集/发布误判回归（第二轮的教训：一词多域）。

# 汇总
| 项 | 已完成 | 待做 | 高危点 | 前置 |
|----|--------|------|--------|------|
| D1 P1-b | 根因确认 | 发 tabOpened(activate:false)+renderer 不抢焦点 | renderer 焦点回归 | 可监控会话 |
| D2 P2-2 | **全部完成（梯队三）**：criteria 落库 + criteria-self-check reminder | — | — | — |
| D3 P2-6 | **全部完成（P5d）** | — | — | — |
| D4 appendModelCriteria | 复验+挂号+通道勘察 | 声明通道设计（新工具 vs 协议）+ finalizer merge | 模型可见面 + 裁决漂移 | 通道设计决策 |
| D5 RunFeedbackRepository | **全部完成（梯队三）**：后端+评分控件+registry live-required | 真机回归确认 | — | — |
| D6 sdk 三测试 vs 宣告闸 | 根因确认 | 语义仲裁后改 fixture 或闸豁免 | 文档/浏览器道语义 | 可监控会话 |
| D7 LLM 维护回合 | **全部完成（2026-07-05 fb4b1b98）**：crystallize tick 捎带驱动 + 三层预算闸（专项开关/durable lastRunAt 进 EP2-C2/空信号跳过）+ 双 gate 翻面（live-required + 旁路直调禁令）；合同见 2026-07-05-p3-backlog-closeout §2 | 真机观察首轮 staged 产卡（回测清单） | — | — |
