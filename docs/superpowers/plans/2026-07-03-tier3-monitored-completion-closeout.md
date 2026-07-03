---
title: 梯队三收尾（用户在场监控会话）— D5 UI / emergence feed 通电 / D2 事中自检
date: 2026-07-03
status: done
enforce: false
parent: 2026-07-03-HANDOFF-agent-module-rework.md
purpose: >
  用户在场后完成梯队三剩余：D5 评分控件 UI + registry 翻面、emergence feed
  全链通电（gate-flip 出 UNWIRED）、D2 criteria 事中自检 reminder。D4 与
  LLM 维护回合经勘察维持缓办（D4/D7 工单）。本文含真机验证清单。
---

# 1. D5 完成（评分控件 + gate-flip）

- `RunFeedbackStars.tsx`：终态任务卡（非 compact、非 detached）尾部 1-5 星控件；挂载按 taskId 回读最近反馈恢复状态；提交只带 taskId，**权威 runId 由 main 从 task projection 解析**（`resolveRunIdForTask`，重试后反馈落最新 run），失败显示"评分未保存，点击重试"不静默。
- group 扩展：`run_or_task_required` / `run_not_found` 校验语义；`run_feedback_submitted` 账本（live-required 可观测）。
- registry gate-flip：RunFeedbackRepository dark-defect → **live-required**（wiring 证据=ipc-handler 注册 + preload 通道 + renderer 调用点；fired=run_feedback_submitted）+ 双负例（调用点消失/账本消失即红）。
- 测试：group 7/7、stars tsx 4/4、gate 测试含翻面负例。
- 注意：`chat-panel-baseline.test.ts` 在 HEAD 就因 vertical-tabs 的 CSS 进 tsx import 图崩（`workbench-sliders.css`，ERR_UNKNOWN_FILE_EXTENSION）——base 既有，与本次无关（git stash 对照验证）。

# 2. Emergence feed 通电（gate-flip 迁移全套）

- **gate-flip**：emergence-cards.ts 出 `UNWIRED_MAINTENANCE_FILES`、去标记、unwired gate 测试负例改钉 candidate-maintenance；registry 条目 deferred→live-required（wiring=ipc-handler 注册 + group 调 assembleEmergenceFeed + renderer feed 面；fired=emergence_feed_assembled）+ 陈旧标记回归负例。
- **producer**：`emergence-feed-group.ts`（`agent:emergence:feed`，拉取式——打开/刷新即组装，信号即时读无失效缓存）。信号三路：跨 scope 最近投影（新增 `runtime.listRecentTaskProjections`，复用 preroute 仓储入口）→ resume/follow_up；belief 卡全量（staged aspire + 疑似重复）→ crystallize；**复用 derivation 的 `listDerivationCandidates`**（stage=candidate + 证据≥3）→ agent-candidate。scopeId 富化：任务类卡带宿主 scope，知识类卡为 null（出口在设置面）。
- **UI**：`EmergenceFeedSection.tsx` 挂 TaskPanel 顶部（240px 紧凑卡：标题+首条证据+行动按钮；空 feed/无 API 整段隐藏）。出口落地：resume/adjudicate/supply → `setCurrentScope`；adopt/review → `navigate('/settings')`（涌现卡永不一键采纳，组件零直接写入——合同 CLAUDE.md §2）。
- **范围界定**：7 类卡接通 4 类（信号源今天存在的）；prepare/harvest/forming 需要新数据采集（日历联动/产物打开跟踪/文件聚类），提取器保留出口，emergence-cards 头注释已注明。harvest 的 R-E2 intent-feed 解锁旗仍未定义，`buildHarvestIntentProjection` 维持 deferred 行为。
- 测试：feed group 4/4（scopeId 富化/知识卡 null/限流穿透/dispose 对称）、section tsx 2/2、unwired gate 测试 22/22。

# 3. D2 完成（criteria 事中自检）+ D4 维持缓办

- `criteria-self-check-reminder.ts`：与终态裁决**同一模板源**（resolveCriteria）；只对结果型任务注入（multi_step/research/media/browser_transaction），direct_answer/short_task/continuation 跳过；module 保守映射（browser_transaction→browser 吃 transaction 模板，余者 system 基线——orchestrator 无 module 信号，叠加层缺失只少自检项，终态裁决仍用完整 facts.module）；括号尾注截断（维护者注记不进模型面）。
- 接线：`agent-sdk-turn-orchestrator` 每次模型调用前的 reminder 组装缝（与 active-plan-step 同点，priority 70 低于其 80）；taskType=`liveTaskBudgetRuntime?.taskType || inferredSdkTaskType`。
- topic `criteria-self-check` 进 ReminderTopic 诚实词表。
- 测试 5/5（含"自检文案必须含裁决同源条目主句"与脱敏断言）。
- **D4 勘察结论**：注入是 main→model 单向；回传通道仍不存在（steps 走 projectionPatch，无模型 plan 工具），真实工作=新建模型可见工具面或受控协议 + merge + 漂移监控 → 维持缓办（D4 工单已更）。

# 4. LLM 维护回合（D7）— 评估后专门会话做

**已具备**：runMaintenanceLlmRound 完整实现 + EP2-C2 确定性门控（skip=零 LLM 调用）+ 容器钉死 runSubAgent + 强制 staged 写 + 用户画像 CAS + 状态面（settings llmRound"未接入驱动"）。

**接线还差**：①生产驱动决策（crystallize tick 捎带 vs 独立节奏）；②LLM 花费预算帽与归账命名空间；③**符号级禁令 gate-flip**——check-unwired 对 `runMaintenanceLlmRound` 是全仓符号禁令（比文件表更深的 flip）；④staged 写监控窗口（先人工节奏观察 BeliefCardsPanel 再自动化）；⑤kill switch 与知识系统总开关的关系确认。

**为何本轮不做**：真实 LLM 花费作用于活体信念数据 + 符号禁令翻面，值得独立会话带全新验证预算；今晚 diff 已横跨三个特性面。→ D7 工单。

# 5. 验证证据（全部真实退出码）

- `npm run typecheck`（node+web）EXIT=0
- `verify:stability` EXIT=0；`verify:evolution-p3` EXIT=0（unwired+mandated 两 gate 改后全链，含 native）；`verify:evolution-p4` EXIT=0
- `verify:evolution-p6o` EXIT=1，失败=**精确 D6 三项**（102/106），无新增
- `check-ipc-contract` EXIT=1，违规集合与 base 26 条逐条一致（emergence/runFeedback 新通道双侧配对零新增违规）
- 焦点：D5 group 7/7 + stars tsx 4/4；emergence group 4/4 + section tsx 2/2 + unwired gate 测试 22/22 + mandated gate 测试 13/13；D2 5/5 + system-reminder-registry 7/7

**D2 自纠记录（真实退出码纪律再次见效）**：初版 D2 按 active-plan 模式每次模型调用注入，p6o 立刻多出 2 个新红——text-bridge fixture 在第二次模型调用断言输入正则，reminder prepend 把字符串输入改成 items 数组。根因修正：criteria 是 run 级静态清单 → **每 run 首个模型调用注入一次**（`criteriaSelfCheckInjected` run 级闸），语义更对、token 更省、后续迭代输入形状不变。修后 p6o 回到精确 D6 三项。附带补了 conflicts 表的新 topic 条目（typecheck 抓到）。

# 6. 真机验证清单（用户在场执行）

1. `npm run dev` 起应用。
2. **D5**：跑一个会产生终态任务卡的任务 → 卡片底部"评价本次运行"5 星 → 点选后变"已评分"→ 重开会话回读仍在 → 复点修改。
3. **Emergence**：**workbench 聊天面板顶部**出现"涌现"段（有 blocked/待裁决任务或 staged 候选卡时；自限高 220px 内滚）→ resume 卡点"继续"切会话；候选卡"去确认"跳设置页；无卡整段隐藏。ReadyMode 的 TaskPanel 同段保留。
4. **D2**：发起多步/研究/浏览器交易任务 → `ready-agent-metrics.log` 出现 `criteria_self_check_injected`。
5. 设置页 BeliefCardsPanel 照常（llmRound 仍"未接入驱动"——D7 未接是真实状态）。

# 7. 真机反馈处理记录（2026-07-03 第一轮）

用户实测：D5 通过（metrics 实锤 `run_feedback_submitted` 3→4 星 upsert）；涌现段未出现；D2 无法确认；另报两次异常。

1. **涌现段未出现 = 落点错误（已修）**：初版只挂 `/ready` 路由的 TaskPanel，用户在 workbench（`emergence_feed_assembled` 账本 0 次实锤 UI 从未拉取）。已改为**主挂载 ChatPanel body 顶部**（MotionLayer body 是 flex 列、ChatPanelBody 自带 flex:1 minHeight:0，直插兄弟节点零包装；组件自限高 220 内滚；空 feed 渲染 null 不改变现有树）。设置跳转走 HashRouter hash。
2. **D2 无法确认 = 缺可观测账本（已补）**：注入原无日志痕迹；现 `registerCriteriaSelfCheckReminder` 注入成功打 `criteria_self_check_injected`（metrics log）。当日三 run 的 taskType=short_task/direct_answer/browser_transaction——前两个按设计跳过，第三个（用户评分的那个，15 工具成功）应已注入且 run 正常，与设计一致。
3. **"agent 拿不到浏览器工具"（14:00 run）= 既有意图门控行为，非本次回归**：`tool_capability` 显示该轮被分类 short_task/local_chat，browser 组被能力裁决抑制（26 工具）；同会话 14:07 消息命中 browser_workflow 后 96 工具全量暴露。本次 diff 零触碰 execution-intent-resolver / run-capability-controller / tool_capability 路径。属"实时信息应进浏览器工作流"的意图分类漏判类既有问题（CLAUDE.md §4 方向），建议后续专项。
4. **video-expert-analyzer 中途失败 = ct-punc 标点模型包未下载（第二轮用户补充"没有标点"提示后定位）**：`model-pack-registry.ts` 的"标点恢复 · ct-punc (中文)"是瘦装包按需下载模型（readyguy pre-release 设计），本机未装 → 技能在标点恢复步骤失败。**与本次 diff 无关**；修复=设置页模型包管理下载 ct-punc（必要时含 paraformer ASR）。14:01 的应用重启是伴随现象非根因。

# 8. 真机反馈处理记录（第二轮：产品方向修正）

用户核心反馈：**能力涌现的主体应是后台自动积累知识/经验，而非前台占空间的按钮面**——"前台 feed 让 agent 显得需要人工代劳"。且截图暴露同名任务重复卡、resume 功能与任务卡自带按钮重复。

处置（同日完成）：
1. **feed 从 ChatPanel 撤出**，唯一前台面=ReadyMode 仪表盘 TaskPanel（不占聊天空间）；registry wiring 增加 TaskPanel 挂载断言（幸存面消失=gate 红，防回黑）。
2. **同名重试去重**：`dedupeByTypeAndTitle`（保留最近投影），group 测试补断言。
3. **方向确认**：后台积累链路本就是 live 主体（crystallize 轮/belief 衰减/learningRefs/站点卡学习全自动，staged 卡设置页静默待确认）；feed 只是可选检视窗。下一块真正的后台成长件=D7 LLM 维护回合（专门会话）。resume/follow_up 类卡与任务卡功能重叠的问题记录在案——若后续验证 ReadyMode 面也无价值，收敛为"知识类卡只进设置页 + 任务类卡退场"是合法方向（届时按 gate-flip 更新 registry 证据）。
