---
title: 浏览器 Agent 真实驱动、单一真值与通用调度闭环实施计划
date: 2026-07-18
status: approved-for-implementation
enforce: true
owner: 白
author: Codex
implementation_gate: passed_thirteenth_final_adversarial_review_after_text_bridge_observation_synthesis_fix
scope: 浏览器原生输入、动作结果、页面引用、通用工具循环、持久任务、父子终态、续跑交接、人工接管与真实运行验收
supersedes:
  - 本文同日 approved-for-implementation 版本
  - docs/superpowers/plans/2026-07-17-browser-agent-site-research-and-tool-contract-repair-implementation.md 中与站点专用搜索、详情直达和旧研究 runner 有关的实现路径
related:
  - docs/superpowers/plans/2026-07-17-browser-agent-site-research-and-tool-contract-repair-implementation.md
  - docs/superpowers/plans/2026-07-17-browser-tool-surface-and-hardening-implementation.md
  - docs/architecture/current-runtime-contracts.md §4、§5、§6
note: >
  原计划虽已完成大量代码，但 2026-07-18 受控 Electron 运行仍出现输入未送达、
  搜索假成功、静态 URL 假交易证明、父任务完成而浏览器子任务暂停、522 后无法续跑等
  决定性失败。本版撤回原实施放行，依据现场数据重新收束根因、删除重复真值和词表驱动路径。
  前两轮独立复审发现写前持久登记、输入焦点竞态、父子 join 与事件归属仍未闭合；
  第三轮进一步证明计划引用了并不存在的 per-action SDK checkpoint 和不可变 Outcome 资源层，
  且 TaskProjection 没有可承载 dependency CAS 的 revision。第四轮又发现 workflow 缺少唯一封口者、
  非 Browser 上下文仍存在 route 鸡生蛋、通知事件被错误地当成续跑第二把钥匙，以及物理 target
  代际和事务后通知没有闭合。第四轮复审与简化审查继续发现 completion proof 时序、旧 owner
  迟到写、stale terminal patch、退出跨表原子性和 Phase 启用顺序仍有缺口，并证明 use_browser
  可直接复用现有 same-run latent tool 机制，无需额外 continuation。本版收束为一个真实
  BrowserCapabilityTask action journal、Parent 单一续跑/终态权威和少数原子转换。第五轮
  复审继续发现终稿先展示、两阶段封口竞态、dispatching 退出、首轮 owner 代际、遗漏的
  checkpoint 原因、outbox 冲突、use_browser 纪律、cutover 双权威和跨进程 target 身份缺口。
  本版据此删除 finalizationRef/intent/startup finalizer，改成一次原子 closeout 并提交第六轮
  独立对抗性审查。第六轮确认单事务方向可落地且不过度复杂，但继续发现
  dispatching 时可能重入模型、fresh owner 缺少 pending→active 启动握手、run_meta 无 winner
  CAS、终态枚举未确定映射、本地终稿 readback/伴随索引、delivery_incomplete 候选泄露、
  foreground fence 与旧 pending event 消费者分流缺口；随后代码回读又确认生产写 running、
  startup 却只清 working 的活跃 run 恢复漂移。本版只补这些已证实边界，必须通过第七轮
  独立对抗性审查才恢复实现。第七轮继续确认普通多步骤任务缺少语义目标覆盖地板、
  content-task-runner 仍可在工具返回后脱离 owner 写页面，并发现 operation 级 binding、
  takeover wake、checkpoint 完整性、SQLite writer 竞争、Parent 全量 writer、cutover 顺序和
  结果型验收等缺口。第八轮又通过真实代码证明语义 goal 没有模型可写的生产入口、原始请求
  没有 durable anchor、detached writer 与 takeover complete 入口仍未列全；同时发现新 verifier
  与 Dynamic Delivery 重复且会在 DB closeout 前污染 session，checkpoint 自动/显式恢复死锁、
  临时目录并不 durable、两个 outbox sink 共用状态、既有 effectProfile 语义冲突、use_browser
  会覆盖 skill activation，以及部分采集确认、未知 SPA 搜索、per-frame ref 和性能 gate 仍有缺口。
  本版随后又接受一次专门的简化审查：删除强制 plan admission、文件 checkpoint、
  adoption_pending 两阶段握手和本地 workflow outbox，缩成可选语义计划、同库 checkpoint、
  单事务 resume 与核心 closeout。第九轮确认核心架构已收敛，但继续发现普通追问被先
  kill、暂停结果落库前崩溃、二次恢复 lineage、unstable ref 死循环、遗漏 stale
  finalizer、通用 SPA 后验效果和技能授权恢复七个边界。本版不新增状态机，只将它们收入
  现有 ingress、journal、checkpoint、resume 与 cutover 合同。第十轮确认主架构无需再推翻，
  但又发现 settled 动作尚未进入 session 的崩溃窗、Main beginRun 二次抢占、live skill identity
  与 floor 漂移、独占技能工具面、无生产者 observation wake、专项 gate 和 checkpoint 空间上界。
  本版删除无生产者 wake，不新增后台 Browser owner；用 journal 差值恢复事实、live prepared
  skill identity、结构化 surface composition 和固定数量 checkpoint 收口。必须通过第十一轮定向
  独立对抗性审查才恢复实现。第十一轮定向审查确认上述七项均已关闭，但又指出普通 steering
  receipt 尚未真正进入 live owner 的 model input，以及 exclusive skill 没有可验证的退出生产者。
  本版把 canonical steering 在 clean boundary 与 checkpoint 同事务注入/消费，并用 skill capability
  层持有的 typed terminal/owner-bound scope 结束 exclusivity；不新增文本分类器或 exit_skill 工具。
  后续定向 recheck 又证明 SDK filtered input 会经共享 MemorySession 在外层 Runner 之间形成第二真值，
  而 latent Browser 若在 Runner 末尾才激活，完全取消 session 又会丢失激活前历史。本版据此只保留
  owner-local 非共享 working view 承接激活前上下文；Browser 激活后的首个 clean boundary 固化完整
  checkpoint，此后它是唯一 durable 输入真值，各 Runner 只从它重建临时 cache。正式 MemorySession
  只在核心 closeout commit 后合并。必须通过同一独立审查者的定向 recheck 才放行。
---

# 浏览器 Agent 真实驱动、单一真值与通用调度闭环实施计划

> 目标是让 Ready 中的主 Agent 面对未知网站、不同语言和多步骤需求时，能够自己观察、
> 选择动作、验证结果并持续推进。代码只负责可机械证明的事实，不替 Agent 猜站点语义、
> 不把命令发出冒充页面成功，也不再用多套状态机分别宣布任务完成。

## 0. 当前裁决

### 0.1 开发闸门

1. 当前实现不得提交，也不得继续按旧计划增量补丁。
2. 本文记录新一轮现场深审的证据、根因图、删除项和机器可验证合同。
3. 本文完成后必须由一个未参与改动的 agent 对抗性审查。审查存在 P0/P1 缺口时继续修订文档，不进入开发。
4. 只有 frontmatter 改为 approved-for-implementation 且 implementation_gate 为 passed_eleventh_targeted_recheck 后，才恢复代码修改。

### 0.2 本轮假设

1. 受控 Layout A、Layout B 与 SQLite、tool trace、provider trace 是当前事实基线；模型最终文字不是完成证据。
2. Layout A 的 HTTP 522 是外部 provider 故障；Layout B 的 Enter、click 和 submit 不生效是独立浏览器驱动故障，两者不得混为一谈。
3. 只默认保留已被真实行为证明可靠的底座：CDP/WebContents transport、BrowserWriteLease、BrowserSnapshotService、SQLite 与 AgentSdk 主循环。BrowserActionExecutor、BrowserCapabilityTask/TaskProjection repository 可按新合同重构；旧 planner、runner、session、event/continuation glue 不因“已经存在”而保留。
4. 不新建 Browser action/task ledger；模型第一次调用 observe/mutate Browser 工具时，在实际执行前原子绑定一个现有 browser_tasks 记录作为唯一 action journal。仅因用户正处于 Browser 工作台而未使用 Browser 工具时，不创建空 child。只新增一个同库 agent_session_checkpoints 表承载 Agent session blob；pending_task_events 保持 legacy 用途，不新增第二个后台 runner、双写或条件回退。
5. 站点、域名、语言、按钮文案、查询内容和固定工具顺序均不得决定生产执行路径或完成真值。
6. 本轮终稿无丢失/去重合同以 Ready 本地 conversation 为验收范围；远程渠道仍验证任务状态不会先于 Browser child 伪完成，但外部网络投递的 exactly-once 需要独立 outbox 项目，不塞进本次 Browser 根因修复。
7. 本轮以结果架构最简为目标，允许在 Browser orchestration scope 内整段替换旧控制层；不以 diff 最小或兼容旧内部 API 为目标。Renderer/Preload 对外产品能力保持，内部旧入口在一次 cutover 中删除，不留 wrapper、双写、feature flag 或 legacy fallback。

### 0.3 完成标准

以下条件必须同时成立：

1. Browser 工作台/页面资源在当前工具面不是 exclusive 时直接开放完整低风险工具闭包；其他非 exclusive 上下文始终有一个轻量 `use_browser` 结构化入口，由模型选择后在同一 run 的下一次模型迭代开放 latent Browser 闭包，不新建 continuation 或 owner。Browser activation 使用独立 `activatedCapabilityGroups`，不覆盖当前 skill identity、skill floor 或 authorization。实际可见工具面服从 skill capability 层给出的通用 `additive | exclusive` composition：普通技能可与 Browser 相加；exclusive profile 必须由 skill capability 层给出 `exclusiveScopeRef`，绑定现有 typed skill/child terminal receipt，或在没有 durable terminal producer 时明确绑定当前 owner。匹配 terminal receipt 后的下一 model iteration 重新计算 surface；owner-bound scope 只能随现有 exitOwner/resumeOwner 交接结束，不能在同 owner 手动清除。两者都只压住 Browser surface而不删除 Browser activation，合法结束后恢复；Browser 调度层不得比较具体 skillId。工具面不再因用户是否说出“下拉、悬停、拖拽、弹窗”或使用何种语言而缺失。
2. click、key、wheel、drag、select、direct text 和结构化 form submit 分别使用 Phase 0 证明的动态 readiness 谓词与可靠 transport；矩阵用于验证谓词，不生成永久的布局/窗口组合白名单。direct text 只在稳定 ref 重解析到精确可编辑节点、该节点取得焦点且存在同一 physical target 时可在 hidden/parked/detached host 投递；绑定同一表单的 requestSubmit 同理可用。定向 CDP 键盘事件只要 physical target 和页面当前 DOM 焦点所有者仍成立，不要求 host 可见、活动或 Ready 前台；detached/hidden target 在单次 guarded dispatch 内临时 offscreen park 并在结束后恢复。指针、滚轮和拖拽仍必须要求可见、活动、前台 host。所有写动作复用现有唯一 BrowserWriteLease，并把真实用户活动 generation 与 dispatch 原子绑定，不新增第二把租约，也不调用 app/BrowserWindow/WebContents focus 抢任何原生焦点。
3. 模型一旦以首个 observe/mutate Browser operation 选择 Browser route，工具 admission 自动绑定同一个 browser_workflow task，不要求先调用计划工具。唯一穷尽 BrowserCapabilityRegistry 只保存 typed operationId、`control | observe | mutate` mode 与既有 power effects；child binding、写租约和确认从这三项机械派生，不按工具名或文本兜底。其 action journal 是写动作唯一持久权威，mutate 动作只经历 `in_flight → settled`；崩溃看到 in_flight 一律按 effect unknown/mayHaveCommitted，绝不自动重放。
4. browser_search 分开“提交已送达”和“搜索效果已观察”。未知 SPA 即使未导航、没有预先存在的结果区，只要 submit delivery 成立也返回 `submitted + effect_unknown + needsObservation`，不冒充 search success，也不把真实提交误报成 dispatch failure，更不自动重发。结果、空结果和内容质量必须由随后绑定 searchActionId、queryDigest 与 post-submit frame identity 的 grounded observation 结算后才能推进 research。同一 action-linked post observation 机制适用于全部 mutate，不因未知页面在动作后才新建 toast/结果区而强制人工介入。
5. 参数、确认、目标、租约和 generation 全部通过后才 CAS 写 in_flight，CAS 返回到 transport dispatch 之间不得 await；未结算即 effect unknown/mayHaveCommitted，不得因粗略页面差异不足或进程重启自动重放。这个极小窗口宁可保守记 unknown，也不新增 prepared 第三状态。任何已 settled 且尚无因果 observation receipt 的动作，无论其 actionSeq 是否已进入 checkpoint cursor，均只从 child journal 派生同一 observation-required barrier；内存 pending set、checkpoint 差值或候选文本都不是第二真值。barrier 存在时 executor 只允许 registry 解析后的 observe operation，严禁 mutate/control 及重放；正确绑定 actionId/actionSeq、successor document identity 的 fresh observation 才能清除。崩溃恢复同样只重算这个 journal 派生视图，不伪造无配对 function result。
6. 工具返回的 fresh page map 在返回时确实可用；稳定 ref 必须来自真实 CDP backend node/等价身份，不再把枚举序号伪装成 backendDOMNodeId。ref 绑定 physicalTargetToken + frameId + frameDocumentToken：子 iframe 重载只让该 frame 子树 stale，主文档导航才使全部后代 stale；普通无关 DOM mutation 不让全页引用失效。无稳定句柄的 unstable ref 可在它产生的精确 capture revision 内单次使用，但跨 publish/mutation/revision 必须 stale；执行前对具体目标做同 frame 文档、身份/指纹、唯一性、可见性、可用性和几何实时复核，不得形成“每次都新鲜、每次都禁止”的死循环。
7. 观察到的真实 href 可以带来源引用用于导航；禁止合成站点 URL，但不再强迫所有详情只能通过坐标点击。
8. 静态 URL、路径长度、标题或正文关键词、只读 snapshot/read、历史 action session 都不能产生 transaction_confirmed。外部效果证明必须绑定同一动作的前态、提交候选动作和后态因果信号；动作前能预知的 expected_effect 直接机械结算，动作后才出现的新区域由绑定 actionId/前态/post-capture 的 observation 结算。后者不能为动作授权、不能允许自动重放，也不能只凭模型文字或单独网络请求成立。
9. Main 在 Browser route 首次绑定的同一事务内从持久 ingress 自动固化 immutable requestAnchor，模型不能提供或改写原请求。现有 `declare_completion_criteria` 只扩展为可选的稳定 goals/delivery declarations，以及引用稳定 goalId 的通用 `upsert | supersede` mutation；供模型在读到用户补充后更新同一 Parent 的任务合同，不新建 Browser 专用计划工具。它不是 Browser admission gate，也不在本项目全局改名。后续用户 steering/回答/确认先形成带 id/digest 的 immutable mutation source receipt；是否再写结构化 goal mutation 由模型读到内容后决定，代码不按文本猜。统一现有 Dynamic Delivery CompletionVerifier 在 closeout 前回读 initial anchor、全部 mutation sources、可选 goals 与全部 evidence 组成 sealed bundle；没有显式 plan 时也必须直接对原请求和全部补充内容做完整覆盖判断，三目标只完成 1/3 必须拒绝。accept 后才构造 completionReceipt 和 next-state；来源/证据不可回读或 verifier 不可用都不能完成。
10. 用户停止、人工接管、provider 瞬时失败、模型自然结束但工作未完、预算/steering/background/foreground checkpoint、结构化反问/确认、错误与正常完成必须进入不同通用 ExitClass；不得统一写 owner_run_closed。活跃 Parent 收到的普通自然语言消息一律先持久化 canonical user message 和未消费 steering receipt，不在 ingress 用文本判断“继续/新任务”。Renderer 发送前不得先 kill；`runConfirmed/runCoordinator/AgentSdkRunLifecycle.beginRun` 前只做 Parent receipt CAS，Main 不得递增 generation、取消 pending tool、abort 旧 owner 或为同一 Parent 启动第二 owner。凡 fresh turn 的初始工具面包含直接或 latent Browser capability，都在 `use_browser` 可能激活前先从 committed MemorySession 只读创建 owner-local SDK Session，并加入本轮 canonical input；checkpoint 尚不存在时，同一 owner 的外层 host/text Runner复用这个非共享 working view，正式 session 从第一轮起零写。Browser 激活后的首个 clean model boundary 必须从 owner-local view 组装完整 effective input，压缩后按消息序原样追加 canonical steering content 与可信 receipt digest；checkpoint 直接保存这份最终待发 input 和当时 SDK source cursor，并与 receipt consumedByOwnerRunId/checkpointId 同一事务提交，事务失败则消息仍未消费。此后 checkpoint final effective input 是 active Browser owner 唯一 durable 输入真值，owner-local Session 只是可重建缓存：同一 Runner 内后续 boundary 从最新 checkpoint 合并 cursor 后新增的 SDK assistant/tool suffix；每个外层 Runner 结束后丢弃其 cache，下一 Runner 从最新 checkpoint final input 重建 owner-local Session，再把明确的 nextInput/tool-result suffix作为本轮新 input。first filter 只验证这个 base 前缀并合并 suffix，不读取上个 Runner 的临时写入。receipt 只消费一次。进程重启或 owner 交接同样只从 checkpoint 重建。若当前响应先形成 terminal candidate，closeCandidate 因存在未消费 steering receipt 必须拒绝收口，走现有 checkpoint_steered exitOwner→resumeOwner，再由同一 receipt 唤醒新 owner。模型实际读到消息后，可继续当前合同，或通过扩展后的 `declare_completion_criteria` 提交 typed goal mutation；普通消息始终留在同一 Parent，不触发 run preempt。只有用户明确点击“停止”才产生 user_stop；不同 conversation 的消息按既有独立 ingress 创建自己的 Parent，不占用当前 Parent 的 steering 路径。sealed verifier bundle、最新 checkpoint 与后续 provider wire input 都必须保留实际消费的 message digest和语义；共享 MemorySession 只在核心 closeout commit 后合并接受的 delta。Browser 只额外处理 action_in_flight、foreground_required、human_takeover 与 provider_transfer，不复制整套 Agent 终态状态机。
11. 可重试网关故障按类别判定：408/425/429、Retry-After 和默认瞬时 5xx（包括 520–524）在无工具进度时可原请求有限重试；501/505、明确协议/能力不支持、语义 4xx 和其他具名永久例外不重试。已有工具进度时不得重放旧动作。`prepareAgentSdkTurn` 在 fresh turn 只解析一次并持有 live `SkillTurnIdentity + SkillToolAuthorization + surfaceComposition + exclusiveScopeRef?`；same-run `use_skill` 同步更新这组 prepared truth。暂停时把 versioned session checkpoint 存进同一个 ready.db，同时固化 identity mode/skillId/stable activation source/request-or-resource anchor digest、当时精确授权的 typed action/primitive 集合、排序后的 requiredFloorToolNames/source/digest、surfaceComposition/exclusiveScopeRef 和 activated capability groups。恢复只调用纯 `revalidateSavedSkillAuthorization()`，禁止重新读取用户自然语言、临时 reference hint 或产生 hint 副作用；有效技能授权是“保存集合 ∩ 当前 ownership/visibility/registry/policy/consent 合法集合”，且本轮沿用现有 floor 语义——保存时所有已授权 skill tools 都是 required，任一缺失即进入 capability/config waiting，新增 tool 不自动开放，不在本项目另造 optional 子集。自定义技能声明的 `allowed_tools` 仍不构成授权真值。exclusiveScopeRef 只由匹配的 durable skill/child terminal receipt 结束；没有该生产者时绑定 ownerRunId，只能随既有 owner transition 结束，绝不增加 `exit_skill`、模型文字或手动 clear。随后一个 `resumeOwner()` 事务 CAS 消费 wake、绑定新 owner、写 child/Parent/run_meta=running，commit 后才允许 provider/model/tool。每个 resume 事务同时把已验证 session 固化为新 owner 的 base checkpoint，使紧接 commit 的 owner_crash 可以再次恢复而不借用旧 owner 身份。每个 Parent 只保留当前 owner 最新未引用 clean base、当前被 continuation 引用的 suspension checkpoint 和刚提交的新 owner base；插入新行、切换引用与删除被替代的未引用行同一事务完成，bindRoute 不长期复制同一 blob，存储随 turn 数保持 O(1) 行、随最新有效 input 保持 O(n) 而非 O(n²)。删除 adoption_pending、activateOwner/failPendingActivation、文件 checkpoint 与目录 GC；commit 前崩溃数据库不变，commit 后崩溃统一按普通 owner_crash 恢复。
12. 人工接管工具先同步建立 `human_takeover` scoped write fence 和 durable suspension intent，并返回 `suspendAfterToolResult`；Orchestrator 在标准 tool result 已进入 session 后才写同库 checkpoint并原子 exitOwner，commit 后展示准确 tab。若在 fence/intent 已提交但 result 未进 session 时崩溃，startup 从最后已提交的 base checkpoint 恢复，保留 fence 与“暂停结果未进 session”事实，不伪造 tool result、不解除 fence、不重发页面动作；由通用 suspension recovery 结算为等待状态。question、confirmation、foreground 与 takeover 全部复用这一边界。模型可调用的 takeover complete、普通消息和旧 confirmed task 入口全部删除；只有 TaskPanel typed UI 事件 `{taskId,takeoverId}` 可触发，Main 内部回读当前 fence/tab/target 并 CAS 消费一次。target 重建只使旧 ref stale并要求 fresh snapshot，不要求 Renderer 回传 token，也不要求用户先产生网页输入。
13. research 进度只消费权威动作结果和显式证据引用；search 只有后续结果/空结果证据成立才推进，不根据 browser_search/browser_click 等工具名猜步骤，也不把固定的 title/url/author 等字段写死为全部网页研究语义。普通读取、部分采集和从已有证据选择子集不弹额外确认；全量目标未齐就保持 goal 未完成，只有真实高影响外部动作走现有行动确认。
14. 生产代码不按站点、语言、查询词或固定步骤选择下一动作；模型负责页面语义和下一步，代码负责结构路由、状态、权限、预算、重试、证据绑定和可重复转换。
15. 受控 Electron 输入矩阵、Layout A/B、provider 522 交接、stop/takeover/restart、父子终态、SQLite readback、真实小红书 18 查询和最终文件 readback全部通过；未知结构、多语言、多步骤结果集还必须证明零假完成、零重复 dispatch、零工具返回后页面写。Phase 0 冻结成功场景的目标正确率、owner provider 请求数、工具调用、累计上下文、无进展重试和用户打断基线；端到端、owner 与 verifier 的 P50/P95 分段报告，但不同外部 provider 时间窗且 verifier 拓扑不同的 wall clock 不再伪装成可比较的硬门槛。任一可由 Ready 本地架构决定的实质回退不得 cutover。
16. UI 去外框作为独立交付不参与 Browser 各阶段设计裁决，但必须通过最终真实截图并阻塞最终提交；计时器、工具历史/任务历史和后台任务卡不得回退出外框、底色或额外玻璃框。
17. 预算只决定容量，不决定任务语义或验收模板；最终裁决读取 Parent 当前 revision 的 taskType/module、required dependency 和结构化交付义务。纯浏览器多步骤状态变更以 completion receipt/task_event 验收，只有用户确实要求文件或文档时才要求 artifact/readback。
18. 模型最后一段 terminal candidate 在核心 closeout 成功前不得进入 committed MemorySession、scope snapshot、Renderer、远程渠道或 chat_messages。统一 verifier 只返回 sealed candidate/session delta；核心事务只原子写 child terminal receipt、Parent dependency/terminal、current run_meta、canonical chat message 与必要 conversation 外键/时间。commit 后才合并 MemorySession、写 snapshot、显示文字并幂等修复 FTS/recall/reference hint；派生索引失败不得回滚真实完成，startup 可从核心行 read-repair。provider 已返回、事务前硬崩时精确措辞可丢，但 Parent 不伪 done且动作不重放。
19. 专项 gate、native gate、typecheck、全量测试、build、真实 Electron 和最终独立对抗性审查全部通过；随后提交应提交的全部工作并把工作区清洁到零。
20. content-task-runner/browser collect/note/card loop 和 browser sub-agent 不得在工具公开返回后继续发起归属于该工具/worker 的 BrowserView 读写。所有 Agent 页面 dispatch 都绑定当前 ownerRunId、registry operation 与 workflow journal；detached worker 只做无 Browser 工具的文件/网络后处理。正常页面渲染、用户接管输入和之后合法新 owner 的动作不计入旧工具的后置写。
21. 任何 bound Parent writer 都必须用 revision CAS 和字段所有权合并；generic sync/terminal patch 不能整组覆盖 steps_json、runId、executionBinding、continuation、status、child receipt 或 proof。
22. BrowserWorkflowStore 只提供同一 raw connection 上的 Unit of Work、CAS 和同库 checkpoint，不承载语义裁决；纯 resolver 留在 AgentSdkTurnOrchestrator/CompletionVerifier。核心事务内无 await、无嵌套事务；只对 SQLITE_BUSY/LOCKED 在事务外短时异步退避并重读 CAS。Renderer 通知直接来自 post-commit push，丢失时读 Parent/message；pending_task_events 保持原有 legacy reminder 职责，不升级成本地 workflow outbox。

### 0.4 实施中性能合同校正（2026-07-19）

原 Phase 0 把不同时间窗的外部 provider wall clock 与本地编排非劣门槛混成了一个数字，并用不含 CompletionVerifier 的旧拓扑要求新增 verifier 后端到端最多增加 1 秒/15%。20 次真实运行证明这个合同本身不可同时满足，必须先修计划而不是放宽单个数字：

- 旧稳定子集 20 次真实运行的 owner provider 请求恒为 2；按全部请求重算后的累计输入上下文 P50/P95 为 41,281/42,806，runtime P50/P95 为 6,433/9,720ms；旧拓扑没有 verifier。
- 新拓扑 20 次真实运行正确率 100%，重复 dispatch、后置页面写、无故中断均为 0；owner provider 请求仍恒为 2，新增且仅新增 1 次零工具 verifier；累计输入上下文 P50/P95 为 43,352/43,388，仍在旧基线 110% 内。
- 新拓扑 owner provider window P50/P95 为 9,060/15,980ms，verifier 为 2,861/4,334ms，runtime 为 12,022/19,120ms。owner 输入量没有同比增长，owner 自身却比八小时前的旧 provider 时间窗更慢，说明跨时间窗 wall clock 同时包含不可由本地代码控制的外部波动。
- 旧 live proof 的 `durationMs` 还从测试驱动点击前开始，到证据查询后才结束；连续建会话时会额外混入最多约 3 秒的发送按钮等待。实时抓包确认正式 canonical done 在核心 closeout 后约 30ms 到达 Renderer，不存在终态通知断链。

据此，性能 gate 改为两层，禁止事后选择性解释：

1. 硬 gate 只裁决本地可决定的结构与数量：正确率 100%；假完成、重复 dispatch、后置页面写、无进展自动重试、非必要中断为 0；owner provider 请求 P50/P95 不高于旧基线；Browser 工具调用不增加；累计输入上下文 P50/P95 不超过 110%；verifier 每个成功 closeout 恰好 1 次、工具面为空，且不得产生 Browser dispatch。
2. canonical request→canonical terminal、Main runtime、owner provider window 与 verifier provider window 的 P50/P95 必须分别记录。跨外部 provider 时间窗或 verifier 拓扑不同的旧/新报告只作诊断，旧 115%/120% 公式继续显示 pass/fail 事实但不决定 cutover。只有同一 provider 时间窗、同一 verifier 拓扑的成对基线才可把 wall clock 重新升级为硬 gate。
3. 不得为通过性能 gate 跳过简单读取的 verifier、按站点/语言/请求词选择快路径、切换硬编码模型，或重新缩窄 Browser 能力面。优化必须减少真实请求轮数、重复上下文或本地等待，同时保持 36 次正确性合同。

### 0.5 实施中观察收口与累计验证校正（2026-07-19）

完整 36 次正确性与 20 次性能基线已经用于发现稀有失败，但对每个局部修正都从零重跑同一矩阵已出现明显边际递减。本轮改为累计证据裁决：已通过且代码路径未受影响的样本不重跑；新修正只重现原失败、它直接影响的风险变体和必要的全量 gate。不得把“再多跑一轮”当成根因分析。

风险抽样 `it-spa-triple` 已证明页面三个目标均按预期执行且无重复 dispatch/后置写，但最后一个 `browser_type` 动作产生 `needsObservation=true` 后模型立即返回 terminal candidate。当前成功 seal 只会在 completion 阶段抛 `core_closeout_browser_observation_required`，error closeout 又复用同一 strict seal，最终使 run_meta、Parent 和 Browser child 都残留 running。这不是站点或模型策略问题，而是 observation-required 未成为候选发布前的显式生命周期。

第十二轮定向对抗审查通过以下修订：

1. mutate settle 后立即从 durable journal 派生 observation barrier，不新增 pending 真值；恢复也不再以 `actionSeq > checkpoint cursor` 作为遗漏筛选。
2. native 与 text bridge 的 terminal 分支在候选文本 emit 前共用一个 guard。若 barrier 存在，丢弃未发布候选，保持同 owner/run/task/child，进入最多一次显式 observation-closure phase。代码只限制先 observe、禁止重放；模型从 registry 中自选具体只读观察工具，不硬编码 snapshot、站点、语言、查询词或步骤。
3. observation phase 结束后必须重读 journal；receipt 未清 barrier 则持久化暂停且不发布候选，不得将预期中间状态伪装成 runtime error。
4. strict closeout reader 改为单次 typed inspection：`absent | action_in_flight | observation_required | research_incomplete | sealable`。completion 只消费这份快照；done 事务内再检查 seal/CAS，error/cancel/interrupted 不再经过成功 seal，仍以 child revision/binding 一次原子收口。
5. 无 barrier 的路径增量 provider/tool 调用必须为 0；有 barrier 最多增加 1 个 owner observation phase，verifier 仍恰好 1 次。原生工具协议可在一个有界调用内完成“观察→最终候选”；文本工具桥的一次 phase 由一轮观察工具响应和一轮无工具结果合成组成，不能因普通轮次预算已经用完而截断，也不能在合成轮继续调用工具。

实现后的定向 Electron 风险样本已通过：`it-spa-triple` 的三个目标各只提交一次，前两个详情各只加载一次，第三个正确判定为无结果；重复 dispatch、工具返回后页面写和非必要中断均为 0，Parent、Browser child 与 run 全部收口，候选答案只发布一次。最后一个写动作后新增的一次观察由模型从公开只读工具面自行选择，生产代码没有固定 `browser_snapshot`。完整 `npm run verify` 与 `npm run build` 随后通过；未再机械重跑未受影响的 36+20 基线。

### 0.6 最终对抗审查的文本工具桥缺口（2026-07-19）

最终独立审查发现：当文本工具桥恰好在普通轮次上限才产生 terminal candidate 时，原实现只额外放行一轮。这一轮会被“选择观察工具并执行”占用，工具结果虽然进入 `nextInput`，循环却立即退出，模型没有机会读取它并形成最终答复。原生路径测试直接在第二次 provider 调用前把 evidence 标成已解决，因此没有覆盖真实的“观察调用→工具结果→最终候选”往返。

修正后 observation closure 是一个有界而非可重试的协议阶段：观察轮只允许 registry 解析后的 observe operation；同一响应中首个读取清掉 durable barrier 后，run-local admission latch 仍阻止后续 mutate/control；若 receipt 未清 barrier，立即保存现场。文本工具桥在 receipt 成立后只增加一轮无工具 synthesis，把标准 tool result 交给同一模型形成最终候选；该轮不受已耗尽的普通 model-loop budget 截断。轮次上限回归同时断言原请求不重复、候选不提前发布、观察结果真实进入第三次输入、synthesis 工具面为空、普通 budget checkpoint 不抢断。

审查同时记录一个非阻断性能信号：当前 delivered mutation 即使已有可靠的动作内效果回读，仍可能因 `mayHaveCommitted` 再要求独立 observation。三目标风险样本共 35 次工具调用、约 74.4 万输入 token、149 秒，不能证明全部成本都来自此处，但足以要求后续用同一 action identity 的可靠 post-readback 直接铸因果 receipt，只把 effect unknown 或身份不完整的动作留给独立观察。该优化不得通过站点、语言、操作名快路或降低 verifier 规避证据合同，也不作为本轮重新扩大验证矩阵的理由。

修正后的同一独立审查者完成复核并给出 `VERDICT: PASS`：文本工具桥的轮次上限闭环、未清 barrier 的持久暂停、空答复/再次调用工具的暂停、同一观察响应后续写入阻断均已成立；没有发现新的 P0/P1。上述额外观察开销维持为非阻断 P2，不改变本轮正确性与可提交结论。

### 0.7 实测长任务提前失败的合同校正（2026-07-19）

真实小红书 18 查询在 normal 与用户所称 Boost 场景中都出现“已推进、随后本轮失败”。两次同形运行的现场真值为：Parent、Browser child 与 `run_meta` 仍处于 active；研究分别只完成 2/18 与 0/2；运行仍沿用 bootstrap `short_task` 的 24/24 容量；模型在 70%/90% 阈值收到“优先收敛、必要时请用户确认继续”的文字提醒；terminal candidate 被 `research_incomplete` 拒绝后，error closeout 又因 `terminalQualityPatch` 没有成功 workflow seal 抛出 `core_closeout_quality_patch_requires_browser_workflow`。因此这不是 normal/Boost 模式差异，也不是单一额度不足，而是容量、候选发布和非成功收口三个生命周期缺口叠加。

本轮采用以下机器可验证合同，不把某个站点、关键词数量或任务文案写进生产分支：

1. bootstrap 预算只是假设，不能成为浏览器长工作流的意外硬上限。最终工具面含 Browser 能力时，bootstrap 获得 220 次的高额应急容量；持久 `browser_research` 状态出现后，运行时按结构真值重绑为 `research`，保留已用量并同步 Parent 投影。normal 与 thorough/Boost 共用这一条路径。
2. 70%/90% 只保留诊断和 UI 水位，不再把“收敛、总结、请用户确认继续”注入模型。健康长任务靠滚动无进展窗口、上下文压缩和持久检查点继续同一 owner；220 只作为循环、持续伪进展或异常成本的最后熔断，不作为正常分段目标。真正耗尽时才暂停并保留可续跑现场。
3. terminal candidate 发布前除 observation barrier 外还要读取同一 typed workflow inspection。`research_incomplete` 时丢弃候选、保留同 owner/run/task/child，并把缺失工作项作为系统事实回给模型继续。只要 required work item 覆盖或其绑定证据增加，继续机会随真实进展刷新；无关动作、观察和未绑定资源不刷新窗口。连续候选没有任何持久进展时才进入 `checkpoint_incomplete`，明确表示“已保存且已暂停”，不得冒充后台仍在运行、报失败或循环到 220。
4. 模型负责把用户独立要求的目标声明成独立 required work item；通用 Browser discipline 明确“一目标一项、不可用一个汇总项替代多个独立目标、一个证据只证明其真实覆盖内容”。代码不解析站点、语言、关键词列表或固定字段来代替语义判断；原始请求覆盖仍由 fresh CompletionVerifier 复核。
5. completion 边界再次读到 `research_incomplete`，或 fresh verifier 发现还需新的 Browser 证据时，必须保存为可续跑 checkpoint，不得转成 `blocked_tool_error`。verifier 的结构化 summary/gaps 与被拒候选 digest 必须随 suspension checkpoint 进入下一 Owner 输入，不能丢成一条泛化暂停文案；最终接受后从公共会话提交中移除，不能成为后续新任务的陈旧指令。这条竞态兜底不替代同轮继续，只保证任何残余缺口都不会再产生“本轮失败 + 三本账仍 running”或无信息重复暂停。
6. `terminalQualityPatch` 是 Parent 质量账，不是 Browser 成功 seal；error/cancel/interrupted 可以在没有 success seal 时随核心事务原子写入。只有 `done` Browser closeout 仍必须同时持有 seal、fresh verifier accept receipt 和匹配 digest。非成功路径必须一次结束 Parent、child 与 run，不能递归进入同一个失败 guard。
7. 验收使用累计证据：新增预算/候选/核心事务单测；同形多目标研究用 3 个独立目标验证 normal 与 thorough 共路、候选不提前发布、进度后继续、无进展才 checkpoint；再跑受影响 browser orchestration、stability、dynamic delivery、native、typecheck 与真实 Electron。已通过且未受影响的 36+20 矩阵不重数。
8. 启动恢复必须先处理仍绑定 Browser workflow 且持有当前 clean checkpoint 的遗留 Owner，再做通用 stale-run 清扫：`working | running` 统一识别为上次进程遗留，三本账原子转为 owner-crash 可续跑暂停；没有有效 clean checkpoint 的剩余行才进入通用 interrupted/rerun 兜底。迁移把 `working` 归一为 `running` 后，reconciler 不得继续只查旧词汇，也不得把有检查点的 Parent 标成不可继续。

### 0.8 实测填字、回车与人工暂停校正（2026-07-20）

小红书实测中页面已出现新文字，URL 和结果区却没有更新；随后的大写 `ENTER` 返回未送达，Agent 又进入人工接管，Main 已写 `manual_suspend` 而 Renderer 仍显示“思考中”。进程和原任务并未消失；这是输入、提交回执和暂停投影三个缺口叠加后呈现出的“像进程中断”。

对照 `web-access` 与 `browser-use` 的操作纪律后，本轮固定以下通用合同，不加站点、关键词或固定步骤分支：

1. 填字和提交是两个独立动作。公开 `browser_type` 只填字和回读；搜索优先使用自身分步结算的 `browser_search`，其他输入再用显式后续提交。文字落入不得被写成“已提交”。
2. direct text 可以把文字送到精确的 editable；后续键盘动作由 CDP 定向送到同一 physical target 的当前 DOM 焦点所有者。detached/hidden target 会在该次发键的写栅栏内临时 offscreen park，配合 CDP focus emulation 投递，再按原状态恢复。全程不依赖 DOM `document.hasFocus()`、WebContents 焦点或 OS 前台，也不调用 app/BrowserWindow/WebContents focus。这样只靠 Enter 提交的页面不需人工接管，暂停或接管后也不会先抢原生焦点再被写栅栏拒绝。
3. 键名先做大小写无关的标准化，同一标准 key/code 用于 CDP 发送和页面事件回执。`ENTER`、`Enter` 与 `enter` 不得因文本形式不同而得到不同结果。
4. 若文字已落入而后续 Enter 被阻断，工具必须返回 partial commit 与 fresh-observation 指引，不用异常吞掉填字事实，不原样重发，不把普通可恢复输入失败升级为人工接管。
5. 人工接管的 call-to-action、补充说明和超时与 takeover intent/checkpoint 同步持久化，任务投影立即进入可继续/可取消的等待态。Renderer 把 `manual_suspend` 当作真实终态解锁，不虚构 Agent 回复，也不继续显示活跃运行。
6. write admission 在每次真实输入投递的同一调用栈内重读。填字与 Enter 之间若发生暂停或接管，Enter 不发送，也不产生聚焦副作用；已落入的文字仍按 partial commit 保留。
7. 验收只重跑输入/提交、暂停投影、Browser orchestration 与一次当前源码 Electron 复现；不重数已通过且未受影响的全景矩阵。
8. 最终 Electron 证据把唯一 keyboard-only 案例直接放在 Document mode：填字、Enter submit 与详情载入各 1 次，duplicate dispatch 和终态后写入均为 0，Parent/child/run 全部正常完成；4 次持久 snapshot 的 host presentation 都回读为原始 detached 状态。

## 1. 第二轮现场证据与根因图

### 1.1 输入链根因

Layout B 是普通原生 form。真实回读显示：

- 初始探针里输入框值已变为 gamma evidence，但 document.hasFocus 为 false；
- 后续把 Agent view 附着到主窗口可见区域并执行 bringToFront 后，webContents.isFocused 与 document.hasFocus 都为 true，主 BrowserWindow 却仍未成为 macOS 活动窗口；
- Input.insertText 能触发 beforeinput/input 并改值；
- 同一状态下 Input.dispatchKeyEvent 仍没有 keydown、keypress、keyup 或 submit；
- URL、正文和结果区均未变化。

已确定的根因：当前代码把 CDP 命令无报错、DOM focus 或非零 viewport 当成了可靠投递，而真实页面事件为零。尚待 Phase 0 确定的是：不同动作究竟需要主窗口活动、view 附着、WebContents/document focus 中的哪组最小条件；在矩阵给出充分必要条件前，不把某个焦点信号硬编码成通用答案。

2026-07-20 的最终实机校正已收口这个待定项：单独放宽前台条件或单独开启 CDP focus emulation 仍然无事件；只有在受保护的发键内将 detached/hidden view 临时 offscreen park，再定向发键并恢复，才实测产生一次 keydown/submit。这个结论只属于 keyboard transport，不扩大到指针、滚轮或拖拽。

### 1.2 动作结果根因

同一 Layout B 操作同时出现：

- browser_search 返回 ok:true；
- 页面变化为 false；
- transaction_confirmed 已产生；
- browser child 仍为 0/2 且 paused。

根因：命令接纳、页面事件、页面效果、研究进度、交易确认和父任务完成由不同模块各自猜测，没有共同结果合同。

### 1.3 fresh ref 立即 stale 的确定根因

browser_search 内部在动作后捕获 fresh revision 并返回；外层 browser tool finish 又无条件 markDirty。刚返回的 target ref 因此在下一调用前已被本工具自己作废。这是 100% 可复现的生命周期顺序错误。

### 1.4 target identity 伪稳定的确定根因

当前 browser-probe 把每次页面枚举的 `index + 1` 写成 backendDOMNodeId，动作解析时又重新枚举并用该序号取元素。它不是 CDP backend node identity；目标前方插入一个无关 DOM 节点就可能让同一 ref 指向另一个元素。

根因：当前 ref 的“stable”标志基于枚举序号，不具备跨 mutation 身份。实现目标级 ref 之前必须先用真实 CDP backendDOMNodeId/等价稳定句柄替换；无法取得稳定句柄的目标标为 unstable，只在同一 capture revision 内经完整指纹/几何/唯一性复核后单次使用，不允许跨 revision 默认重绑。

### 1.5 假交易证明的确定根因

Layout B 的静态路径段 layout-b 恰好满足 8 字符启发式，页面在任何提交动作前就由只读 snapshot 产生 public_resource_url。BrowserActionSession 又把该 confirmation 粘到后续工具。点击和 Enter 即使 changed:false 仍携带同一证明。

根因：交易完成由 URL 形态和历史会话猜测，而不是由同一提交动作的因果前后态证明。

### 1.6 父子终态根因

数据库显示：

- parent projection 和 run_meta 为 completed/done；
- browser child 随 cleanup 转 paused/owner_run_closed；
- child 查询进度为 0/2，正文和互动量证据均为 0；
- parent criteria 只凭错误 transaction_confirmed 达到 1/1。

根因：

1. finalizer 不读取 required child 的最终状态；
2. 启动时 budget task type 可覆盖 browser_research 返回的 research 事实；
3. BrowserActionSession proof 可绕过 research 完成地板；
4. cleanup 在 parent finalize 后无条件暂停 child。

### 1.7 provider 续跑根因

Layout A 第二个查询已提交后遇到 HTTP 522。现有路径在已有文字或工具进度时正确拒绝原请求重放，但没有 fresh-owner continuation；run 只能 blocked_external，child 又被 cleanup 暂停。

同时，5xx 判定散落多处并枚举少数状态，522 未被统一视作 transient。

根因：系统只有“同请求重试”与“失败退出”，缺少“保留已提交进度并转移给新 owner run”的中间合同。

### 1.8 硬编码与路径膨胀根因

当前生产路径同时存在：

- 大段中英文词表决定 browser observe、collection、transaction、publish、upload、submit、form；
- BrowserTaskPlanner 的具名站点、创作站、固定上传和提交步骤；
- BrowserDomainOrchestrator 按工具名和关键词猜步骤完成；
- BrowserActionSession 再次解释交易和 target；
- site_research checkpoint 再按工具名解释 search/click/read；
- TaskProjection 和 run finalizer 又各自解释完成。

Layout B 仅因提示中出现“提交页面”就被分成 browser_transaction。Layout A 又受 recall 影响成为 multi_step_task。相同业务因此得到不同完成合同。

根因不是安全不足，而是语义判断被复制到多处词表和状态层。路径越多，越容易互相绕过。

### 1.9 验收脚本根因

现有 controlled proof 把期望 marker 写进提示，再用最终文字 includes(marker) 验收。“无法提供 MARKER”也会被算命中；脚本只看工具名，不看 browser child completed、evidence binding 和最终产物 readback。

根因：验收测了模型是否复述固定脚本，而不是页面动作和持久结果。

### 1.10 live run 恢复状态漂移

当前生产 `persistRunBinding()` 创建 run_meta 时写 `status='running'`，受控数据库也存在仍为 running 的活跃行；startup reconciler 却只把 `status='working'` 的行收成 interrupted。重启因此会漏掉真实活跃 owner，而计划若继续沿用 working 还会把新旧路径再次分叉。

根因：活跃 run 状态没有单一合同。实现统一使用现有生产值 running；迁移把存量 working 一次性改成 running，startup、close/exit/resume 与测试只认 running，不新增 adoption_pending 或长期双值兼容。

### 1.11 普通多步骤目标覆盖缺口

现有 bindRoute 只会建立一个机械 browser_workflow step；completion floor 又只检查“已经声明的 work item”。若用户要求完成 A/B/C，而模型只做 A 且没有先声明 B/C，required work item 为空或只有 A，一次 observation 就可能被误判完成。

根因：动作证据地板已存在，但没有原始请求覆盖裁决。代码不能靠站点/语言词表补语义，也不能强制 Agent 先调用计划工具；Main 自动固化 requestAnchor，模型可选声明稳定 goals，现有唯一 CompletionVerifier 无论有无 plan 都比较原始请求与全部证据。

### 1.12 工具返回后的脱离 owner 写入

content-task-runner 当前可在工具先返回后异步调度 runTask；browser collect/note/card loop 还会在后台自行获取 lease、滚动或操作 BrowserView，并存在与 chat turn 解耦的 browser sub-agent。它绕开 ownerRunId、统一 action journal、stop/takeover 与 adoption fence。

根因：长任务持久化被错误等同于后台继续持有浏览器写权。浏览器动作必须留在当前 owner 的当前工具调用内；工具公开返回只允许已结算结果或 typed checkpoint，detached worker 永远不得接触 BrowserView。

### 1.13 SQLite 第二写连接竞争

Browser/Parent/run/chat 位于同一 ready.db，核心单事务可行；但搜索 reindex worker 另开同库写连接并分批持有写事务，Main 连接没有事务取得策略。直接 BEGIN IMMEDIATE 会瞬时 SQLITE_BUSY/LOCKED；给 Main 长同步 busy timeout 又会冻结界面。

根因：原计划只证明“同库可原子提交”，没有覆盖多连接 writer admission。BrowserWorkflowStore 需要在事务外做短时、有界、异步重试，每次重读并重新 CAS；FTS/recall 等派生索引放到核心 commit 后，不能把它们的锁或失败升级成任务失败。

### 1.14 结构化目标与原始请求没有生产真值

现有模型只能声明 completion criteria，不能声明或修订 Parent plan/goal；TaskStep 也没有 required capability，现有 planner 仍按代码分类生成固定三步。Parent 没有 immutable request anchor，run_meta 的 firstMessageText 还会截断。若 bindRoute 要求 goal，生产链会卡死；若自动把请求当单目标，又会恢复假完成。

根因：计划定义了消费者，却没有给 verifier 可回读的 sealed request/evidence 真值。修复不是再强制一个工具顺序，而是在 Parent 首次 Browser 绑定时自动固化 requestAnchor，扩展现有 criteria 为可选 goals，并让 verifier 在无 plan 时仍直接按原请求判定覆盖。

### 1.15 verifier 与 session closeout 次序错误

现有 Dynamic Delivery 已有隔离、零工具 verifier，但其 accept 会先把 terminal item 合并进 committed MemorySession，DB finalizer 和 scope snapshot 在后。若再串一个 Browser verifier，既重复语义判断，又会在 SQL rollback 后留下内存终稿或 snapshot。

根因：verification、session merge 与 durable closeout 的提交顺序倒置。Browser 与 Dynamic Delivery 必须共用一个 verifier：先生成只读 candidate/session delta，accept 后才构造 completion receipt；DB commit 后才合并 MemorySession、写 scope snapshot 和显示终稿。

### 1.16 continuation 模式与 checkpoint durable 性缺口

旧草案把 autoResumeAttempt 同时放进 Parent continuation 和 checkpoint，adopt 递增后又要求 checkpoint 精确相等；同时 explicit_user_message 允许 checkpoint=null，activateOwner 却无条件要求 checkpoint。现有 run state/scope snapshot 还位于 os.tmpdir，不是重启可靠存储。

根因：恢复被拆成过多状态和非 durable 文件。最终只保留同库不可变 session checkpoint 与一个 resumeOwner：事务外验证，单事务消费 typed receipt并绑定 running owner，commit 后才调用 provider；无有效 checkpoint 时只有新的持久用户类 receipt 可以从 requestAnchor/evidence 构造 replacement checkpoint。

### 1.17 takeover 仍有模型绕过

当前 schema 允许模型调用 browser_request_takeover(action=complete)，执行器无需 takeoverId/target/generation 即返回成功；任务卡“我已完成”仍发送普通文字。重启后 physicalTargetToken 必变化，旧 wake 若要求严格匹配旧 token 又永远不可达。

根因：接管完成没有可信 UI→Main 事件边界。模型 complete、普通消息和旧 confirmed task 入口必须删除；TaskPanel 只发送 taskId+takeoverId，Main 回读当前 fence/tab/target并消费一次。target token 负责让旧 ref stale，不成为用户继续操作的额外门槛。

### 1.18 采集确认、搜索与引用过度收紧

普通网页采集若结果不完整会被独立 consent store 强制要求用户确认并阻止模型选择已有子集；未知 SPA 搜索若生成全新结果区却不导航、又没有预先指定 result target，会被当成 dispatch 失败；单一 documentEpoch 还会因无关 iframe 重载让整页 ref stale。

根因：产品语义被硬编码成额外交互，机械未知又被当成失败。普通读/子集采集不确认，目标是否完成交给 goal/evidence；搜索允许 submitted + effect unknown 后续观察，绝不自动重发；引用按 frameId + frameDocumentToken 精确失效。

### 1.19 UI 独立交付

用户要求去掉计时器、工具历史/任务历史和后台任务卡的多余外框。该改动与浏览器架构解耦，已在真实 Electron 截图中验证；后续重构不得回退，也不得借机扩张其他 UI 视觉改造。

### 1.20 动作级输入条件的最终实证

2026-07-19 的受控 Chromium/Electron 复验把原先混在一起的“页面能不能写”拆成了不同 transport 的最小条件：

- 只要稳定目标重解析到同一 rendered editable、精确 `focus()` 后的 activeElement 仍是该节点，且 Main 仍持有对应 physical target，`Input.insertText` 在 Browser host 处于 hidden、parked 或 detached 时仍会产生真实 `beforeinput/input` 并可严格回读；`document.hasFocus` 不是这条通道的必要条件。
- 直接文本填写的 `clear_first` 不再依赖键盘全选；只对已聚焦的精确 input/textarea/contenteditable 建立 selection，然后用同一次 direct text 替换，不修改其他节点。
- 若精确输入目标绑定真实 form，`requestSubmit()` 在 host 不可见时仍会产生真实 submit 事件；它不需要猜按钮文案，也不需要模拟 Enter。
- `Input.dispatchKeyEvent` 定向绑定的 CDP target；detached/hidden host 在受保护的发键期间临时 offscreen park 并开启 CDP focus emulation，因此能保留页面 DOM 焦点所有者并产生真实 keydown/submit，又不需要把 Ready 或 WebContents 抢到前台。指针、滚轮和拖拽仍只在可见、活动、前台的物理 surface 上开放。
- Agent 面板可以让 Browser host 对 Renderer 呈现为 detached，但底层 WebContents/CDP target 仍存在。readiness 因此必须同时报告 host presentation 和物理 target，不能把 `detached` 一律等于“所有输入禁用”。

这些证据排除了两个极端：既不再把“有非零 viewport”当成全部输入都可用，也不再因 host 被覆盖就把已证明可靠的精确文本/表单通道全部关闭。

## 2. 目标架构：两份持久真值、两类机械读源

### 2.1 权威边界

1. BrowserCapabilityTask 是浏览器动作与证据的唯一持久真值：保存可选 Parent goal/work item 映射、单一 action journal、Outcome/observation receipt 与进度；首个 observe/mutate Browser operation 在执行前自动创建或绑定唯一 kind=browser_workflow 的 task，browser_research 只向同一 task 增加 query/field work item，不另起 site_research 状态机。
2. Parent TaskProjection 是用户任务的唯一持久真值：保存 immutable requestAnchor、可选结构化 goals/delivery declarations、required child dependency、当前唯一 ownerRunId/binding、单一 continuation ownership 和最终交付状态，并以单调 revision 提供 CAS。Browser workflow 的 run_meta.continuation_ref_json 始终为 NULL；已有 reader/writer 对 Browser kind 改读 Parent，冲突时只认 Parent。

Browser input readiness 与 BrowserSnapshotService 只是机械读源：前者回答当前 tab 能否接收某类真实输入，后者提供页面结构、physicalTargetToken 与 per-frame document identity。BrowserActionOutcome/observation receipt 由 Executor 产生后直接结算进 BrowserCapabilityTask，不成为第三个状态 owner。

除此之外的模块可以展示或投影这些事实，但不得重新推断动作成功、交易确认、研究进度或父任务完成。

BrowserSnapshotService 的页面结构不被 Outcome 或 TaskProjection 复制；任务层只保存绑定其 identity/digest 的紧凑引用。

不新增强制 plan 工具，也不在 Browser 项目中全局改名已有 `declare_completion_criteria`。只把它的现有结构扩展为可选 goals、delivery obligations/expected outputs 与补充验收标准。每个 goal 只含稳定 goalId、语义 requirement、required capability groups、通用 outcomeKind（information/browser_state/external_effect/artifact）、required、revision 与可选 supersedesGoalId；代码只解释 required、revision、capability group 和 supersession，不解释 requirement、站点、语言或工具顺序。模型可在多目标、长任务或 verifier 返回缺口后以 declare/add/supersede 提交；已有 goal 不原地改写。每次 mutation 由 runtime 绑定当前可信 sourceRef（initial request、持久 user/steering message、question answer 或 confirmation/card receipt）的 kind/id/digest，模型不能自报正文；mutationId 由 parentTaskId + toolCallId + sourceRef digest + argsDigest 确定性生成，同 id/同 digest 幂等，同 id/异 digest 整笔回滚。

requestAnchor 由 Main 在 bindRoute() 创建 Parent/browser child 的同一事务，从当前 RequestEnvelope 的可信 ingress sourceRef 回读并只写一次，因此无 plan 的简单动作也有原始请求真值且 Browser dispatch 尚未发生。它包含 sourceMessageId、canonical request snapshot/digest，以及每个附件/资源的 resourceId、version、contentDigest、provenanceDigest；任何 tool schema 都不接收 request snapshot。snapshot 使用现有用户消息 ingress 的完整长度上限，不再截成 run_meta.firstMessageText；资源正文仍在资源层。后续每次 plan mutation 只追加不可变 source receipt，不改 initial anchor。closeout 在 verifier 前按 anchor 和 mutation receipts 回读初始 source message、所有已接受的 steering/answer/confirmation 内容、资源内容与 Browser evidence，逐项核对 digest 后组装 sealed bundle，实际内容随只读 bundle 进入 verifier，不能只传裸 ref/hash；缺失或不一致即 proof_gap。

显式 Browser goal 复用 BrowserCapabilityTask 现有 work item 集合，不新增第二个 goal 表或进度状态机；没有 plan 时 receipt 仍按 requestAnchor 归属于同一 child，不伪造 goal。模型若提供 parentGoalIds，settle 只更新这些显式 work items；不得自动挂全部 goal。现有 Dynamic Delivery verifier 扩展为唯一 CompletionVerifier：与 owner session 隔离、零 Browser/外部工具，只接收 sealed bundle 与候选 session delta，输出固定 accept/missing/supersession schema。它不能写 Parent/child、制造证据或合并 session；没有显式 goal 时直接按原始请求逐项裁决。语义 accept/missing 对同一 candidate 不重跑；只有 verifier transport unavailable/invalid 才可在现有 verifier retry budget 内对同一 sealed candidate 重试一次并写 attempt receipt，Browser dispatch 为 0。

### 2.2 明确删除或降级的路径

1. 删除 BrowserActionSession 的 transaction confirmation、历史 confirmation 粘连、target 继承和 final proof 权威；UI 若需要进度，直接投影最新 BrowserActionOutcome。
2. 删除 browser-tool-shared 中基于静态 URL、路径长度、标题和正文词语的交易完成猜测。
3. 删除 browser tool executor 在每次工具调用时重新解析用户原句并改写 taskType/module 的路径。
4. BrowserTaskPlanner、BrowserDomainOrchestrator 和 BrowserAgentRunner 不再在 live SDK 路径生成具名站点或固定动作计划，也不再按工具名猜步骤。如果移除 live 引用后没有其他真实调用方，整体删除；若仍有独立职责，只保留无语义的薄适配。
5. site_research 不再是第二个 task/action checkpoint。browser_research 只向当前 browser_workflow task 写查询、字段和 evidence work item；同一 action journal 保存 Outcome。
6. browser_workflow 的 child/parent 状态由同一事务直接写入；TaskEventBridge 只发送已提交事实的提醒，不再投影权威状态，也不再启动一个只负责叙述结果、却能独立宣布完成的平行 run。
7. 删除 current-site URL 合成、站点 selector、语言词表、目标少于固定数量就等待、no-change 后自动第二次点击等执行分支。
8. content-task-runner、browser collect/note/card loop 与 browser sub-agent 中所有脱离 chat owner 的 BrowserView 读写路径必须删除或改为当前工具调用内的 owner-bound 执行；工具返回 typed checkpoint 后归属于该工具/worker 的页面读写严格为零。detached worker 只保留文件、解析或网络后处理，永远无 Browser 工具/lease；用户输入和之后合法新 owner 的动作按各自 generation/owner 单独记账。
9. 删除 browser_request_takeover(action=complete) 的 schema、invocation resolver 和 browser-act-tools 执行分支；TaskPanel“我已完成”普通文字路径改为 Main 签发的 typed UI completion IPC。模型、普通聊天、旧 `confirmed + browser-task-*` 事件均不能解除 takeover fence。
10. 删除普通“部分采集确认”路径：browser-collection-tools 的 incomplete/较大冻结列表确认、browser-collection-consent store/IPC，以及其旧全量 projection writer。普通读取或已有子集永不因数量不足要求用户确认；若无其他真实高影响调用方，整个 consent 模块删除，不保留 Browser legacy 分支。
11. 保留并扩展现有 `declare_completion_criteria` 的一个 Parent CAS writer：现有 criteria/expected outputs 继续可用，新增稳定 goalId 的 `upsert | supersede` mutation 并只追加 immutable source receipt，删除旧整组覆盖路径；Browser 简单操作不依赖它，Tag Forge/skill 等既有 floor 不受本项目破坏。

Phase 5 一次性 cutover 必须按下表逐个断开真实 caller，不能把“再搜调用方”留到实施时：

| 旧入口 | 当前生产链 | cutover 后唯一结果 |
|---|---|---|
| background page lease handoff | `browser-surface-binding.ts` 的 background handoff → `tool-executor.ts` | 删除 page-capable handoff；detached 只保留纯文件/网络 |
| 模型启动采集 | `browser-collection-tools.ts` 的 start/collect/note/card → `contentTaskRunner.startTask` | 当前 owner 的当前工具调用内执行，或返回 Parent typed continuation |
| Controller/IPC start | `ipc-handler.ts` 的 start/schedule handlers → `contentTaskRunner.startTask/scheduleTask` | 页面任务禁止直启 runner，统一 bindRoute/owner journal |
| 模型 resume | `browser-collection-tools.ts` 的 resume → `contentTaskRunner.resumeTask` | 消费 Parent continuation，禁止按 taskId 直接 resume |
| UI“继续采集” | `use-task-interaction-handlers.ts` → `preload/index.ts` → `ipc-handler.ts` → runner | 发送 typed Parent wake，不直达 content runner |
| 确认交互恢复 | `runtime.ts` → `task-event-bridge.ts` 的 task-id/prefix resume | 只消费精确 question/confirmation/takeover wake |
| startup recovery | `ipc-handler.ts` startup → `content-task-runner.ts` resume | 只按 Parent continuation 调用单一 resumeOwner |
| worker timer 自续跑 | `content-task-runner.ts` 的 `setTimeout(resumeTask)` | 删除；无 owner 时页面 dispatch 为 0 |
| 实际后台页面循环/sub-agent | `content-task-runner.ts` 的 runTask/scroll/operate/sub-agent 与 Browser lease 获取 | 页面能力收回当前 owner；工具返回后归属旧 worker 的页面读写为 0 |
| takeover model complete | `browser-tool-schemas.ts` → `browser-tool-invocation.ts` → `browser-act-tools.ts` | 删除；只接受 Main 签发 UI event |
| takeover 普通文字完成 | `TaskPanel.tsx` → 普通 composer message | 改为 `{taskId,takeoverId}` typed UI IPC；普通消息无效 |
| 普通追问预先 kill | `useAgent.ts` 在 `sendScoped` 持久化前调 `agent.kill` | 删除预发送 kill；Main 只持久化 canonical message/未消费 steering，不在 ingress 判定 continuation/new task；模型实际读到消息后才可更新同一 Parent 的 goal contract，只有明确停止按钮发 user_stop |
| Main 新 run 抢占 | `runConfirmed/runCoordinator` → `AgentSdkRunLifecycle.beginRun` 取消 pending tool、递增 generation、abort 旧 run | 活跃 Parent 的普通消息先存 canonical steering receipt，不在 ingress 分类，也不进入第二个 beginRun；下一 clean boundary 与 checkpoint 同事务注入/标记内容已消费，terminal candidate 遇未消费 receipt 必须 checkpoint_steered；同一 Parent 的普通消息 preempt 恒为 0，不同 conversation 才按既有 ingress 建独立 Parent |
| partial collection consent | `browser-collection-tools.ts` → `browser-collection-consent.ts`/IPC/全量 projection writer | 删除普通采集确认与整行 writer；完成度走 goal/evidence |
| 旧 confirmed resume | `runtime.ts` 的 `confirmed + browser-task-*` → `task-event-bridge.ts` | 删除 prefix bridge；只消费 typed receipt |
| 文本/正则 route 与 inline fast path | `browser-workflow-intent.ts`/`browser-work-intent.ts` → tool executor/turn route | 从 live route 删除；Browser context 或 use_browser 是唯一入口 |
| 固定计划与重复权威 | BrowserTaskPlanner/BrowserDomainOrchestrator/BrowserAgentRunner/BrowserActionSession | 删除 live 调用；无独立职责则删文件 |
| stale projection 封口 | `runtime.ts` 每次 send 后调 `stale-projection-finalizer.ts` 直接写 terminal patch | Browser Parent 不得走旧封口；要么排除 Browser kind，要么只经通用 ExitClass + Parent revision CAS 进入唯一 closeout |
| 旧 completion/progress writers | research runner、projection sync、cleanup、Renderer/task reminder | 只投影 committed Outcome/Parent，不能关闭 workflow |

Phase 0 先用运行时计数器和调用图测试冻结上述入口的精确函数清单，并对所有直接 SQL/repository `task_projections` writer 建立字段所有权静态 gate；Phase 5 必须逐项真实触发，证明每个旧 start/resume/schedule/page-dispatch/terminal-writer 入口计数为 0、每个合法入口只产生一次 owner-bound dispatch。纯源码搜索只辅助发现未知 caller，不能代替真实调用 gate；静态 writer gate 不得被“30 分钟才触发”类定时路径绕过。

### 2.3 保留的必要安全边界

- 同 profile/session 与 task/tab 绑定；
- 单写者租约和用户输入优先；
- 凭据/OTP 与不可逆或高影响外部动作继续使用现有明确授权；确认只读结构化 action intent/manifest 风险类，不读站点、按钮文案或用户关键词；普通搜索、导航、筛选、展开、选择、草稿填写和只读表单不弹确认；
- 目标存在、同文档、唯一、可见、可用、几何合理的实时复核；
- 明确的页面遮挡、浏览器错误、权限拒绝和权威网络限流；
- stop/takeover 后零新写；
- 敏感输入和 token URL 脱敏；
- 已 dispatch 的未知副作用动作绝不自动重放。

不再保留的过度防控：

- 任意 DOM mutation 让全页 ref 失效；
- 页面真实 href 也必须坐标点击；
- 多个输入候选就形成死路；
- 普通登录/验证字样触发全局冻结；
- terminal/paused browser task 封住所有普通 primitives；
- 用户接管前再弹一次确认；
- 用站点或语言词表决定安全和完成。

## 3. 机器可验证合同

### 3.1 BrowserInputReadiness

Phase 0 分别为 click、key、wheel、drag、select、contenteditable 和 submit 证明可执行的动态谓词。除 physical target、frame/document、目标可见/可用、Ready 前后台、WebContents/document focus 外，还必须比较持久 CDP session/target、CDP Input、webContents.sendInputEvent 和现有可信输入路径；不先假定某个 transport 或焦点组合对所有动作都必要。生产代码只读这些当前事实，不保存 layout/站点/语言/测试组合 allowlist；停放页面始终可观察。

所有动作只复用现有 BrowserWriteLease，不增加 driver lease 或第二套 ownership：

- 写前校验 tab、profile/session/task claim、目标 WebContents 与唯一写租约；
- 同一 BrowserTurnLease 同时只能绑定一个物理 surface/tab；从 user-view 切到 agent-view 或反向切换时，在同一 transition 中先释放旧绑定再获取新绑定，禁止一个 turn 同时持有两边写权；
- focusGeneration 来自主 BrowserWindow focus/blur、active view/tab 变化；userActivityGeneration 只来自具备真实用户 provenance 的 keyboard/mouse/wheel/touch 与用户 tab selection。BrowserActionExecutor 为本次合成输入和程序化 tab 切换绑定 activeDispatchToken，观察器按 WebContents/event identity 排除本 lease 的合成事件，Agent 自己的 CDP/sendInputEvent 不得递增 user generation；真实用户并发输入必须递增并让 dispatch 前检查失败；
- 在同一租约中记录两种 generation，准备准确 view 后再次校验；最后一次 generation/fence 复核与底层 transport 调用之间不得出现 await；
- 激活到 dispatch 之间只要用户输入、tab、窗口焦点、takeover/stop fence 或 lease generation 变化，就在 dispatch 前取消；
- 动作后只有 generation 未变时才恢复原焦点，绝不把用户后来选择的焦点切走；
- readiness 只表示允许尝试，不表示页面已经收到事件；真实送达仍由 BrowserActionOutcome 证明。

Ready 不是当前活动应用时禁止调用 app.focus、BrowserWindow.focus、系统自动化或等价方式抢前台。若某类输入经矩阵证明只能在前台工作，统一走 `exitOwner(foreground_required)` 原子暂停 child/Parent/run，Renderer 显示一次“回到 Ready 继续”；inactive 期间不得循环创建 owner。只有 Main 验证 Ready 重新前台后才采用一个新 owner 继续，并进入连续的可见 agent-driving 状态，期间复用同一 view/lease，不逐动作切换焦点。Ready 再次失去前台立即建立 scope fence 并暂停。

durable fence 以 browserTaskId + profile/session + tab + physicalTargetToken 为作用域，不得因一个 paused/waiting_human task 冻结其他无关 tab 或普通 Browser primitives。应用启动恢复顺序固定为：先读取并重建全部已持久 fence 类型，至少覆盖 user_stop、human_takeover、foreground_required 与 action_in_flight，再恢复该作用域的 browser task 和 Agent admission；该作用域 fence 尚未恢复时，其 browser write lease 获取失败，其他作用域不受牵连。foreground_required 只能在 Main 重新确认 Ready 确为前台且物理 target 未变后解除，不能靠 Renderer focus 声明、定时器或重启自动清除。

### 3.2 BrowserActionOutcome 与 observation receipt

`in_flight → settled` 只覆盖会写页面、改变导航/标签或可能产生副作用的 mutate operation；snapshot、find、read、status、wait 等纯观察不伪装成 action。它们在返回前把一次 observation receipt 直接 CAS 到 workflow task，绑定当前页面身份与资源摘要。

最小字段：

- actionId、ownerRunId、taskId、可选 parentGoalIds/workItemIds、actionSeq 与 write-lease generation；
- tab、physicalTargetToken、frameId、frameDocumentToken、目标 ref、backend node 与目标指纹；
- phase=in_flight/settled、dispatchAccepted，deliveryObserved 为 true、false 或 unknown；
- effectObserved 为 true、false 或 unknown；
- mayHaveCommitted；
- before/after page identity；
- event、navigation、popup、dialog、download、network、value readback 等结构化 effect signals；
- errorKind 与 durable receiptId/hash。

一个 actionId 只对应一次底层逻辑 dispatch；drag 等由同一 transport 调用产生的事件序列仍算一次，browser_search 的 fill 与 submit 则是两个独立 actionId，由一个 searchActionId 关联。动作成立只允许两条机械证据路径：deliveryObserved=true，或出现可与本 actionId 因果绑定的 navigation/popup/dialog/download/value 等效果。两者都不可观察时是 unknown；探针明确事件未送达时才是 false。unknown 不能自动重放，但已有明确效果时不能因事件探针不可见而误判失败。

通用 tool wrapper 的 `ok` 只表示调用被正确执行并返回结构化结果，不代表页面目标或用户目标完成：

- browser_type：输入动作成立；回读值、页面规范化后的值和比较结果单独返回，只有调用方显式声明 exactValue 才要求严格一致；
- browser_press_key/browser_click：事件送达或出现可因果绑定的效果；页面效果仍单独报告；
- browser_search：必须返回 `phase=not_submitted | submitted_needs_observation | effect_observed`、fill/submit action ids、submitted、effectObserved 与 needsObservation；`submitted_needs_observation` 可以 ok=true，但绝不生成 search/result evidence 或 work-item progress；
- browser_read：不产生 BrowserActionOutcome；读取内容非空且 observation receipt 已绑定当前文档/目标并完成 task CAS 后才返回 ok。

observe/mutate operation 可用共享 envelope 携带稳定 `parentGoalIds[]`；语义选择由模型负责。Main 只验证 goal 属于当前 Parent/revision、含 browser capability 且尚未 superseded，并机械解析为同一 child 的 workItemIds；Outcome/observation settle 只更新本次显式绑定的 work items。一个 receipt 可以绑定多个 goal，一个 goal 也可以积累多个 receipt；代码不得自动挂全部 goal。没有显式 plan 或本动作未绑定 goal 时，receipt 仍按 requestAnchor 归属 child 并进入 closeout sealed bundle，不因此拒绝页面操作。

所有 task、projection、proof 和 UI 只能消费 BrowserActionOutcome 或 observation receipt，不再解析工具文字。

#### 3.2.1 单一能力 registry 与持久落点

现有 `effectProfile` 保留其 power-effects 语义。将 browser-tool-surface、invocation、write classification 与 catalog 的重复表合并为唯一穷尽 `BrowserCapabilityRegistry`；canonical resolver 必须返回 closed `BrowserOperationId`，不再返回任意 string：

```ts
interface BrowserCapabilityEntry {
  operationId: BrowserOperationId
  mode: 'control' | 'observe' | 'mutate'
  effects: BrowserToolEffectProfile
}
```

child binding 从 mode!=control 派生；write lease/readiness 从 mode=mutate 派生；确认只从 effects/结构化 action intent 派生。mutate 由 child.activeAction CAS 串行，observe 只读当前 identity，因此不再另存 serializationKey 或每 operation version。registry 只有一个不兼容变更才递增的 major；恢复只核对 serializer/safety/registry major 与本 checkpoint 用到的 required operation 仍存在，新增只读 operation、描述或 additive minor 不阻断。

AgentSdk tool executor 在首个 observe/mutate operation 前进入 BrowserWorkflowStore.bindRoute()：同一事务从可信 RequestEnvelope 创建/复用 Parent、requestAnchor、唯一 `BrowserCapabilityTask(kind=browser_workflow)` 与一个 mechanical browser_execution dependency step。显式 goals 存在时只建立 id 映射；没有 plan 时不制造语义 goal。事务冲突整个绑定回滚，操作不执行；control operation 不创建 child，已有 Browser continuation 复用原 task。

site research、普通动作和同一 run 的后续 Browser operation 都使用该 task 的 checkpoint/goal items，不写 per-action SDK run_state 或临时 JSON 文件。

action journal 最小结构：

- `nextActionSeq`；
- `activeAction`：actionId、可选 actionGroupId/searchActionId、parentGoalIds/workItemIds、actionSeq、phase=in_flight、ownerRunId/binding digest、target fingerprint、argsDigest、expectedEffect/hash、confirmationGrant/hash、startedAt；
- `settledOutcomes`：按确定性 receiptId 保存紧凑 Outcome；
- `observationEvidence`：snapshot/read 工具在返回前以 child revision CAS 保存的 parentGoalIds/workItemIds、当前 physicalTargetToken、frameId、frameDocumentToken、page/region digest 与资源引用；
- `workItemEvidence`：workItemId 到不可截断 receipt/evidence hash 的引用；
- `completionReceipt`：taskId、完成 revision、requestAnchor、全部 required work item 与 verifier-accepted evidence hash 的摘要。

actionId/receiptId 由 taskId + actionSeq + argsDigest 确定性寻址，Outcome 与 journal 指针在同一次 browser task revision CAS 中结算，不存在“Outcome 已写但 pointer 未写”的第二存储。诊断历史可截断；workItemEvidence 和 completionReceipt 在任务关闭前不得截断。

生命周期只有两次持久转换：

1. `in_flight`：参数、目标、confirmation、fence、lease 与 generation 通过后，CAS 写 activeAction 并回读；CAS 返回到 transport 调用之间不得 await。若恰在这个极小窗口崩溃，也保守按 unknown 处理。
2. `settled`：把 Outcome、hash、显式 work-item evidence 更新和 activeAction 清空放在同一次 child CAS；回读 revision/receipt/hash 后才返回工具结果。

owner 退出或进程重启看到 in_flight 时，先建立对应 scoped write fence，再把同一 actionId 结算为 settled/unknown/mayHaveCommitted、清空 activeAction 并要求 fresh observation；底层 promise 的迟到结果直接忽略，不增加 refine 状态。fresh owner 必须先观察，不得自动重放。stop/takeover/foreground fence 后严格禁止新 dispatch。

普通动作还有一个不新增 journal 状态的恢复边界：每次 resume/startup 都从 child journal 读取全部尚无因果 observation receipt 的 settled action，并据此派生 observe-only barrier；checkpoint cursor 不能过滤这份未解决集合。若某个 actionSeq 又高于 checkpoint.lastEffectiveBrowserActionSeq，说明标准 tool result 尚未进入 checkpoint input，恢复才额外从同一 journal 生成 `{actionId, operationId, actionSeq, outcome/effect, mayHaveCommitted, requiresFreshObservation:true}` 结构化 recovery fact，作为 system-owned input 交给新 owner，不伪造没有匹配 tool call 的 function result。严格晚于对应 action 的 grounded observation receipt 出现后，barrier 自然解除。它既覆盖 settle 后/result 前，也覆盖 action 已进入 checkpoint 但仍未观察，以及同一 assistant 多 tool call 中前一项已完成的崩溃，不引入 suspension intent、第三 action phase或第二恢复状态机。

BrowserWorkflowStore 只实现 bind/action/close/exit/resume 的 Unit of Work 与 CAS，不解释语义、不过滤站点，也不拥有第二状态机。事务内 silent write，commit 后直接 push Renderer/TaskEventBridge；通知失败不改变已提交结果，Renderer/startup 按 Parent/message readback 收敛，不新增 workflow outbox。

### 3.3 引用与动作原子性

- Main 每次启动生成加密随机 bootIncarnationId；只有底层 WebContents/CDP target、renderer 或 tab 对应的物理页面实例真正建立/替换时才递增本进程 targetSequence，组合成不可复用的 `physicalTargetToken={bootIncarnationId,targetSequence}`。同一物理 target 的 hide/show、bounds 调整、park/unpark、surface 重新附着或 user-view/agent-view 展示切换不得轮换 token。tabId 即使在同进程或重启后被复用也不能复用旧 token；pageRef、page map、action journal 与 Outcome 全部绑定该 token。不得使用进程重启会归零的裸整数。
- 每个 frame 的文档身份是 `frameId + frameDocumentToken`。frameDocumentToken 由 Main 在该 frame document/execution context 建立时生成且同一 physicalTargetToken 内不复用；子 frame reload/replacement 只轮换该 frame 及其后代 token，主 frame navigation 轮换主 frame 及全部后代。底层 renderer/WebContents/CDP target 真正替换则直接轮换 physicalTargetToken 并废弃整个旧 frame tree。
- 普通 mutation 可以提示 page map 可能漂移，但不全局废弃 ref。
- page map 捕获时通过真实 CDP DOM/AX 身份取得 backendDOMNodeId 或等价稳定句柄；browser-probe 的 `index + 1` 序号字段删除。无法取得真实句柄的结构路径目标标记 unstable。
- 执行时先要求 tab、physicalTargetToken、frameId、frameDocumentToken 全部一致，再用稳定句柄重新 describe/resolve，并复核 role、关键状态、几何，以及按目标适用的 accessible name、href、input type、form/ancestor context；虚拟列表复用同一节点但指纹变化时必须 stale，普通无关 mutation或无关 iframe reload 不影响它。
- 稳定句柄已失效、身份指纹改变或不再唯一才返回 stale。unstable ref 只能在产生它的同一 physicalTargetToken/frameDocumentToken/captureRevision 内单次使用；中间无任何 publish、mutation 或 navigation 时，Executor 可依捕获时结构路径重新解析，但必须重验完整指纹、几何和唯一性；任一不匹配就 stale，不能按新序号静默重绑。这使 closed-shadow/AX-only 目标可以立即执行，又不会跨版本误点。
- 动作若生成 after page map，该 map 是工具结束前最后一次 publish；外层 finish 不得再次 markDirty。
- 动作未生成 after map 时明确返回 needsSnapshot，不伪造 fresh refs。

### 3.4 搜索与通用多步骤动作

- browser_search 接受可选 input_target_id、submit_target_id、result_target_id 与 empty_target_id。
- 多个候选时返回结构化候选，由 Agent 选择 ref 后重试；代码不读控件名称猜用途。
- search fill 必须回读输入控件的当前值，并在 Unicode NFC、换行和首尾空白规范化后与 query 一致；不一致就停在 fill 阶段。该严格规则只属于 browser_search，不扩大到普通 browser_type。
- 提交优先复用精确输入目标所属的真实 form，由结构化 `requestSubmit()` 产生并计数 submit/invalid 事件；只在没有可绑定 form 时，才使用已显式选定的 action target 或绑定 physical target 的 CDP 键盘 Enter。三条路径都必须先通过自己的 input readiness 和事件探针；fillActionId 与 submitActionId 分别持久化，Outcome 带 queryDigest 与共同的 searchActionId。
- immediate mechanical search effect 只接受：与 submit 绑定的 loader/navigation identity；调用方指定 result/empty region 的 digest 变化；或目标 frame 在 submit 后开始的 response 与 page identity/指定 region 变化的组合。单独网络请求、轮询、分析请求和广告请求永不证明 search effect。
- 若 submit delivery 成立但上述 effect 均不可观察，返回 submitted_needs_observation；这不是失败、成功或自动重试信号。Agent 随后用 fresh grounded snapshot/read 检查已有或新出现的任意区域；该 observation receipt 必须绑定 searchActionId、queryDigest、physicalTargetToken、frameId/frameDocumentToken 与 post-submit capture sequence，才能由模型/唯一 verifier 判断结果或空结果。
- search 的 ok/submitted 单独都不能推进 research；只有 effect_observed 或上述后续结果/空结果 evidence 可以推进，且不消费 toolName。
- 普通多步骤需求由主模型循环自行组合 snapshot/find/read/click/type/select/hover/scroll/press/drag/dialog/wait/tabs；代码不生成固定步骤。

### 3.5 交易与外部副作用

expected_effect 是有限的通用机械谓词 union，只允许：`navigation_identity`、`target_value`、`target_state`、`popup`、`dialog`、`download`、`region_digest`、`target_frame_response`。每项只含目标 ref/frame、before 值/hash 与可机械比较的 after 条件，不接收自然语言成功描述。target_frame_response 只可参与 search 的 response+页面变化组合，不能单独证明外部提交或交易完成。

- expected_effect 是可选的动作前机械预期，不是未知网页的 admission gate。browser_search 或普通 mutate 若在 dispatch 前已有可引用的目标/区域/导航预期，就绑定 expected_effect；若页面只会在动作后新建 toast、结果区或状态组件，允许省略并返回 `delivered_needs_observation`。高影响 commit 仍必须在 dispatch 前有结构化 intent 和匹配 confirmation/grant；效果不可预知不等于免授权。
- actionId、commit intent、动作前 target/frame identity、before digest/capture sequence、可选 expected_effect/hash 与 confirmation/grant 必须在 dispatch 前一起持久化；动作后不得补写或更换预期条件。代码不从自然语言按钮文案推断。
- 预绑定 expected_effect 在同一 BrowserActionOutcome 中匹配非 network-only 信号时，可机械产生 transaction_confirmed。无预绑定效果时，随后 snapshot/read/wait 可产生 action-linked observation receipt：必须引用同一 actionId、before identity/digest、physicalTargetToken、frameId/frameDocumentToken 和严格晚于 dispatch 的 capture sequence；它只证明可回读的后态，由唯一 CompletionVerifier 结合用户目标判定是否满足外部效果，不伪造机械 transaction_confirmed。
- 单独网络请求、模型文字、静态 URL、旧 action 的 confirmation 或未绑定 actionId 的普通读取都不能证明效果。
- effect unknown 时不得确认，也不得自动重发；Agent 先重新观察再决定下一步。

### 3.6 Browser child、Parent 与核心 closeout

- task_projections 增加单调 revision 与字段所有权 CAS；generic sync/terminal patch 不能覆盖 requestAnchor/goals、child dependency、runId/executionBinding、continuation、终态或 proof。browser_tasks 增加 parent_step_id，required child 的 completion receipt 必须回钉 Parent 当前 dependency generation。
- proof-ready 只要求 activeAction 为空、requestAnchor/资源/evidence 可回读、存在本 child 绑定后的 Outcome/observation；若显式 plan 存在，每个 required goal/work item 还必须有证据，required=false 的辅助项不阻塞。没有 plan 不自动生成 goal，由 CompletionVerifier 直接核对原请求。
- 工具 executor、research、runner、reminder、projection 和 Renderer 都不能关闭 workflow。只有统一 finalizeRunOutcome() 在无工具 terminal candidate 后调用 closeCandidate()；末轮文字在核心 commit 前只存在 isolated candidate-session fork。
- closeCandidate() 在事务外读取 Parent/child/run_meta、requestAnchor、全部 steering receipts/plan mutations、resources 与 evidence，构造 sealed bundle；存在尚未 content-checkpointed 的 steering receipt 时直接拒绝 terminal candidate并进入 checkpoint_steered，不运行 verifier。已消费 receipt 的 canonical message digest 必须同时存在于 checkpoint effective input 和 sealed bundle。现有唯一 CompletionVerifier 只返回 verdict/session delta。accept 前不得 merge MemorySession、写 scope snapshot、chat row 或用户终态。missing 只有在真实 plan/evidence/交付 revision 前进后才能形成新 candidate；transport unavailable/invalid 对同一 sealed candidate 最多重试一次且 Browser dispatch=0。
- accept 后纯 resolver 构造 completionReceipt 与 Parent next-state。一个 BEGIN IMMEDIATE 核心事务只做：CAS child receipt/terminal、CAS Parent dependency/terminal/continuation、CAS current run_meta、以确定性 messageId 写 canonical chat_messages，并更新必要 conversation 外键/updated_at。Browser 齐但文件/文档交付未齐时 child 可 completed，Parent 保持 delivery_incomplete 且不写“已完成”终稿。
- FTS、recall、reference hint、学习副作用、scope snapshot 与 Renderer/TaskEventBridge push 全在核心 commit 后幂等执行；失败不回滚真实完成。canonical message metadata 固化派生修复所需的 digest/hint snapshot，startup/read path 可由 Parent/message 重建索引与 UI。pending_task_events 不承担 Browser owner、完成或本地通知可靠性。
- Dynamic Delivery 的 candidate-session-fork 只产生 sealed delta；核心 DB commit 后才 commitAccepted/merge MemorySession。任一核心 SQL fault 或 verifier rejection 后，committed MemorySession、scope snapshot、chat row 与 Renderer 中 terminal candidate 均为 0；commit 后内存 merge 失败从 canonical row 重建。
- 核心 transaction context 使用 Main 同一 raw connection，体内无 await/嵌套事务。SQLITE_BUSY/LOCKED 只在事务外按 Phase 0 短预算重试；每次重读 CAS/fence，stop/takeover 可先赢。派生索引故障不得走 persistence_failed。
- stop/takeover/closeout 竞争同一 Parent revision、owner binding 和 run_meta running CAS：只有一个赢家。失去 owner 的 finalizer不能改 Parent/child/message；run_meta 已终态时零写 no-op。用户改变目标只以 Parent CAS 写 goal/dependency supersession，旧 receipt 不能复活。
- completed commit 后才发 text/done，payload 含 messageId/digest；Renderer 缺正文时按 id 回读 canonical row，不再自行随机 id 或走第二条 chat:saveMessage。

### 3.7 单一 continuation 与一次 resume

Parent 的 revision + runId + executionBinding + continuationRef 是唯一 ownership/continuation 真值；run_meta.continuation_ref_json 对 Browser 始终 NULL，只作每个 run 的审计状态。ownerRunId 由 Main 生成且永不复用。

新增一个小型 `agent_session_checkpoints` 表，与 Parent/child/chat 同处 ready.db。checkpoint payload 一经写入不可变：checkpointId、role=`clean_base | suspension`、parentTaskId、可空 browserTaskId（首个 Browser operation 绑定前）、ownerRunId、可选 ancestorOwnerRunId/digest、schema/serializer/registry/safety major、encoded final effective model input/hash、`sdkSourceItemCount + sdkSourcePrefixDigest` cursor、lastEffectiveBrowserActionSeq（compaction 前已存在于 final effective input 的最高连续 Browser actionSeq，后续 checkpoint 单调不回退）、累计已注入的 steeringReceiptIds/digests、required operations、resource refs、live SkillTurnIdentity 的 mode/skillId/stable activation source/request-or-resource anchor digest、排序后的 authorizedTypedActions/authorizedPrimitives 及 digest、排序后的 requiredFloorToolNames/source/digest、surfaceComposition/exclusiveScopeRef、activatedCapabilityGroups、createdAt。不持久密钥、动态 grant 正文、用户自然语言解析缓存或 reference hint。fresh turn 的 `prepareAgentSdkTurn` 产出这份 live prepared truth；same-run use_skill 更新它。恢复只调用纯 `revalidateSavedSkillAuthorization()`，不重新做语义选择、不读或写 hint：实际技能许可取保存 allow-set 与当前 ownership/visibility/registry/policy/consent 合法集合的交集；按现有 floor 合同，保存 allow-set 全部在 requiredFloorToolNames 中，任何旧项缺失都进入 capability/config waiting，新增加的 skill tool 不开放。exclusiveScopeRef 若绑定 typed skill/child receipt，只在匹配 terminal revision 后失效；若绑定 ownerRunId，只在 owner transition 后失效。解码还必须证明 tool call/result 成对、pending calls 为空、terminal candidate 为空；新增无关 Browser 只读 operation、描述或 additive minor 不阻断，serializer/registry/safety major 不兼容、required operation/floor 消失或 identity/授权不可重建才拒绝。

凡 fresh turn 的 prepared surface 含直接 Browser closure 或 latent `use_browser`，`prepareAgentSdkTurn` 先只读 committed MemorySession 一次，以其历史快照创建 owner-local MemorySession，再把本轮 canonical input作为新 input交给 Runner；整个 owner 生命周期都禁止写共享 session。checkpoint 尚未存在时，同一 owner 的外层 `host.runAgent`/text bridge Runner 复用这个 owner-local view，让 SDK 正常保存前序 assistant/tool call/result；若 Browser 从未激活，正常通用 closeout仍在核心 commit 后只合并 accepted delta，不改变用户可见会话。

Browser 闭包直接开放或 `use_browser` 激活后，首个干净 model boundary（前一批标准 tool result 全部成对、下一次 SDK model iteration 还未调用 provider）以当前 owner-local normalized source 为 base，写出第一份 checkpoint；从此 checkpoint final effective input 是 active Browser owner 的唯一 durable 输入真值。每个外层 Runner 结束后丢弃该 Runner 的 owner-local cache；下一 Runner 重新用最新 checkpoint final input初始化一个 owner-local MemorySession，并把 Orchestrator 明确形成的 nextInput/tool-result message作为新 input。其 first filter 验证 SDK source 的 base prefix hash等于 seed checkpoint hash，只把 seed 后 suffix拼到 checkpoint final input，并重置本 Runner cursor。只有同一个 Runner 内的后续 model iteration，才验证 SDK 当前 source input 的前 `sdkSourceItemCount` 项仍与 `sdkSourcePrefixDigest` 一致，取 cursor 后新增的 assistant/function call/result suffix。prefix/seed 不匹配时不得猜 diff、重复注入或调用 provider；直接以 `persistence_failed_input_divergence` 结束当前 owner并保留最后可信 checkpoint/Parent 未完成状态，不进入需要 wake 的 waiting，也不自动循环恢复。随后推进单调 lastEffectiveBrowserActionSeq，compact 这份合并 input，再把本轮仍未 content-checkpointed 的 canonical message 与可信 receipt digest 按 message sequence 原样追加到 callback result，形成真正交给 provider 的 final effective input；已消费 steering 已在 base 内继续存在，不依赖再次读取 pending receipt。checkpoint 直接序列化 final items，同时把本轮完整 SDK source item count/prefix digest 写成下一 cursor；不能从共享 MemorySession.getItems() 重读，也不能退回原始 turn input。

一个 BEGIN IMMEDIATE 事务 CAS Parent revision/receipt pending 状态，insert/rotate checkpoint，并只对本轮新 receipt 写 `contentCheckpointId + consumedByOwnerRunId`；readback 成功后才返回 final items 给 provider，冲突则整笔零写并重新构造。steering receipt 只是 canonical ingress 的一次性消费标记，不承载通知、后台队列或第二 continuation。新 receipt 若在该事务后到达，保持 pending，由下一 iteration 注入；若当前响应先到 terminal candidate，closeCandidate 回读到 pending receipt 必须拒绝终稿，走 checkpoint_steered exit/resume。下一 model iteration 即使没有 pending receipt，也必须继续走“最新 final effective input + 新 SDK suffix”合并，因此已消费消息和 digest 不会消失。该 hook 对应每次 SDK model iteration，不声称覆盖 provider 内部 HTTP retry，也不能只在外层 turn loop 保存。首个 Browser operation 前 clean base 可以 browserTaskId=NULL；bindRoute 在创建 child 的同一事务中写 child-bound base并删除已被替代且未引用的 pre-bind row，不长期复制同一 blob。`resumeOwner()` 绑定新 owner时用同一 final effective input 初始化下一 Runner source，并在同一事务写匹配的新 base，再删除不再被 continuation 引用的旧 base/suspension；Runner-local first-filter cursor只在内存 closure 中重置，不新增持久状态。任何时刻每个 Parent 最多保留当前 owner clean base、当前 suspension 与事务刚写入的新 owner base；指针切换、insert 和 delete 原子，ancestor 只保留 digest审计，不要求历史 payload 常驻。Parent 完成删除全部 checkpoint，startup 只清终态孤儿；100-turn 合成 gate 要求行数为常数、总字节不超过固定行数乘最新有效 input 大小。因此首个 Browser 工具或 resume commit 后立即崩溃都有干净 base，又不会 O(n²) 累积。这仍是同一 checkpoint 机制，不是 per-action run_state、消息分类器、文件 GC 或第二 continuation。共享 MemorySession 只在 closeCandidate accept 的核心 DB commit 成功后接收 sealed delta；reject、suspend、provider error 或 owner failure 均不写它。

continuation 只保存 `{kind:'browser_workflow_v1', browserTaskId, pausedOwnerRunId, committedActionSeq, checkpointId, checkpointDigest, reason, waitFor:{kind,basisRevisionOrDigest}}`。`waitFor` 是对未来 wake 的类型和最小新鲜度要求，不伪造尚未发生的 receiptId。真正 resume 时传入新持久 wake receipt，CAS 验证其 kind、id/digest、未消费、产生时间/修订晚于 basis。空 id、空 digest、内存 timer、单纯 focus 回调或任意 JSON 都不可恢复。

同一 steering receipt 的“唤醒占用”和“内容已进入 checkpoint”是两个机械字段：resumeOwner 可先 CAS `wakeClaimedByRunId` 防止重复 owner，但只有 clean-boundary 事务写入 `contentCheckpointId` 才算模型已接收。commit 后/provider 前崩溃时，新 owner 从 checkpoint 读到内容；resume commit 后/boundary 前崩溃时，content 仍 pending，owner_crash 后再次注入，不会丢消息或重复创建 owner。

所有工具触发的暂停共用 post-tool-result 边界：工具先原子建立对应 scoped fence 和 durable suspension intent，再返回 suspendAfterToolResult；Orchestrator 等标准 tool result 已写入 session 后，才在同一 DB transaction 写 checkpoint、child paused/waiting、Parent continuation、旧 run_meta terminal。fence 后不再 dispatch。若在 intent 已提交、result 未进 session 时崩溃，startup 只用最后干净 base checkpoint + intent 结算等待态：保留 fence，不把未配对 call 塞入 session，不伪造 result，不解锁或重发。覆盖 intent 后/result 前、result 后/exit 前、exit commit 后三个崩溃窗口。

wake 来源必须穷尽，新类型无表项即编译/合同 gate 失败：

| reason / waitFor | durable wake source | 触发和 CAS basis |
|---|---|---|
| steering/question/card/confirmation | 先落库的 user message、answer/card/confirmation receipt | 用户触发；wake 尚未 claim、id/digest 晚于 paused revision；steering 内容是否已 checkpoint 另行校验 |
| human_takeover | TaskPanel `{taskId,takeoverId}` receipt | 用户触发；takeoverId 匹配当前 fence 且只消费一次 |
| background_result | required child task-event receipt | 自动；child/dependency revision 严格前进 |
| foreground_required | Main 仅在 Parent 正等待前台时签发的 foreground-ready receipt | 自动；focusGeneration + physical target 晚于 basis，普通 focus callback 无效 |
| capability/config | 持久 capability/settings revision receipt | 自动；只有解除当前 blocker 的 revision 前进 |
| provider_transfer | 持久 provider-error receipt + classifier digest | 自动；必须已有工具进度、checkpoint readback 成功且 retry basis 未消费 |
| owner_crash | startup 为当前 running owner 签发的 crash receipt | 自动；runId + boot incarnation 唯一，只能引用该 owner 最新 base checkpoint |
| budget/background checkpoint 继续 | 持久 continue UI/message receipt | 用户触发；不用 timer 伪造继续 |

恢复只有一个 resumeOwner()：

1. 事务外回读并验证 checkpoint、wake receipt、Parent/child/current target，构造有效 input；从 journal 全量未解决动作派生 observe-only barrier，只在 actionSeq 高于 lastEffectiveBrowserActionSeq 时额外加入 recovery fact；此阶段 provider/model/tool 调用为 0，也不伪造 function result。
2. 一个事务 CAS Parent paused revision/continuation digest、child revision/无 activeAction、paused owner run_meta terminal 与未 claim wake，生成新 runId/binding，写 Parent/child running 和新 run_meta=running，写 wakeClaimedByRunId，并把已验证 input 写成新 owner 的 base checkpoint。steering receipt 的 contentCheckpointId 只有在内容真正进入 effective input 的 clean-boundary 事务才写；冲突整笔零写。
3. commit 后才调用 provider。commit 前崩溃 DB 不变；commit 后崩溃由 startup 为新 owner 写唯一 owner_crash receipt，引用第 2 步已提交的新 base checkpoint，不回退到旧 owner、不引入 pending candidate。

自动 resume 每个唯一 basis（新 child/delivery revision 或新 typed wake receipt digest）最多一次并受总预算约束；provider_transfer 还必须已有真实进度。有效 checkpoint 存在时只接受上表对应 typed wake；checkpoint 无效时，只有新的持久 user/steering/card/confirmation/takeover receipt 可从 requestAnchor+durable evidence 构造 replacement checkpoint，timer/普通 focus/config callback 不能。用户 stop 清 continuation，后续要求创建新任务。

`delivered_needs_observation` 或普通 unfinished effect 不创建 continuation，也不是 wake 类型：原 owner 在同一 SDK loop 继续调用 observe。若进程崩溃，由 owner_crash receipt 恢复后执行首个受约束 observation；若因 question/foreground/provider 等真实原因暂停，则只由对应表项 wake。禁止为了制造 observation receipt 恢复 detached Browser worker或第二观察 owner。

通用 AgentSdkTurnOrchestrator 用一个 `satisfies Record<TurnTerminalReason, ExitClass>` 把全部共享 reason 穷尽归为 completed、auto_resumable、waiting_input、cancelled、failed；新增 reason 无映射即编译失败。Browser reducer只覆盖 action_in_flight、foreground_required、human_takeover、provider_transfer 四个结构化差异，不复制 provider/skill/artifact 全表。cleanup 只撤销 owner/监听/租约，不改 child。

### 3.8 provider 交接

- provider 错误分类只有一个共享入口：408/425/429、有效 Retry-After 和默认瞬时 5xx 可重试，覆盖 520–524 而不再逐号码补丁；501/505、明确协议/能力不支持与语义 4xx 是具名永久例外，不重试。
- 无工具/可见进度时，同一 model request 可有限重试；已有进度时不重放 request或页面动作。
- 旧 owner 在最后 committed tool result 后写同库 checkpoint并 exitOwner(provider_transfer)；只有 transition 与 checkpoint readback 成功后 Orchestrator 才可调用 resumeOwner()。fresh run 复用 Parent/browserTaskId，从 committedActionSeq 后继续；旧 receipt CAS 拒绝重复。
- stop/takeover/completion 与 522 竞争相同 Parent/child/run_meta CAS，只有一个结局；自动 basis/总预算耗尽后进入 blocked_external。

### 3.9 takeover

browser_request_takeover 只保留 request operation：同步原子建立 `human_takeover` scoped write fence、takeoverId 和 durable suspension intent，并返回 suspendAfterToolResult。Orchestrator 在 tool result 成对提交后写 checkpoint并 exitOwner(human_takeover)，同一核心事务把 child/Parent 写 waiting_human、持久 takeover request receipt 和旧 run_meta terminal；commit 后撤销租约并展示绑定的准确 tab。若 intent 后/result 前崩溃，startup 依 §3.7 保留 fence/waiting 并引用最后干净 base checkpoint；展示失败同样保持 fence/waiting，startup 只补展示。

模型 complete schema/resolver/executor、TaskPanel 普通文字“我已完成”和旧 confirmed prefix bridge全部删除。只有 TaskPanel typed UI event `{taskId,takeoverId}` 可继续；Main 自己回读当前 human_takeover fence、Parent revision、logical tab 与当前 physical target，并 CAS 消费一次 receipt。target 重建时保持 fence、重新绑定和 fresh snapshot；physical token 只用于废弃旧 ref，不由 Renderer 回传，也不要求 userActivityGeneration 增长。普通聊天、timer、focus、迟到或错误 takeoverId 均无效。

### 3.10 Browser route 的真实入口

- RequestEnvelope 增加代码生成的 `environmentHints.workbenchMode` 与可选 `browserPageRef(tabId/profile/physicalTargetToken/mainFrameId/mainFrameDocumentToken)`；只从 Renderer 的 environment_hint provenance 和 Main 的 tab binding 生成，用户正文里的同名文本不能伪造。
- 当前 workbenchMode=browser、存在 browserPageRef，或 continuationRef 已绑定 browserTaskId 时，在 effective surface 非 exclusive 的前提下直接开放完整低风险 Browser 闭包。模型首个 observe/mutate browser tool call 是 route 的结构化选择；BrowserWorkflowStore.bindRoute() 在该工具执行前自动固化 requestAnchor并绑定 workflow task。模型不调用 Browser 工具就不产生 browser child。
- 所有生产 turn 在 Browser capability 可用且 effective surface 非 exclusive 时始终常驻一个小型通用 control-plane tool：`use_browser`，其 registry mode=control，只表达激活 Browser group，不包含站点、语言、查询或固定步骤语义，也不创建 browser child/action journal。现有 declare_completion_criteria 在完整 Agent control-plane 中按原有可见性存在，Browser 不强制调用。
- 不复用会改写 skill authorization 的 `sameRunActivatedSkillId`。RuntimeContext 新增独立 `activatedCapabilityGroups` 与 generic latent definition groups；use_browser 只记录 browser group，绝不替换当前 live SkillTurnIdentity、SkillToolAuthorization 或显式 skill floor。RunCapabilityController 用 skill capability 层提供的通用 `surfaceComposition + exclusiveScopeRef?` 计算 effective surface：additive profile 才把 Browser definitions 加入 allowedToolNames/definitionByName；exclusive profile 期间结构性 suppress Browser但保留 activation 状态。scopeRef 绑定 typed skill/child terminal receipt 时，下一 model boundary 回读匹配 terminal revision 后恢复；没有 durable terminal producer 时绑定 ownerRunId，同 owner 内不得恢复，只能经已有 exitOwner/resumeOwner 后重新计算。Browser 代码不比较 Tag Forge 或任何具体 skillId，也不提供 exit_skill/manual clear。下一次模型迭代看到允许的闭包，不创建额外 continuation 或 owner，也不要求用户再次发言。
- 激活结果必须一次性携带 Main 生成的可信当前页事实（workbenchMode、tab/profile、physicalTargetToken、mainFrameId/mainFrameDocumentToken、observed URL/title 或明确 no-current-page）、同一个 BrowserDisciplineBuilder 生成的紧凑纪律文本及 major/digest、完整 activated tool names。初始 Browser context 与 use_browser 共用该 builder，禁止两份漂移纪律；用户正文不能伪造页面事实。
- 原生 SDK 依靠已安装 latent definitions + 动态 isEnabled 在下一迭代提供真实 schemas。text bridge 的同一标准 tool result 必须携带全部 activated definitions 的完整可解析 schema/description；删除现有 12,000 字符静默截断，不允许半个 schema 或“目录有名字、执行器无定义”。manifest 采用紧凑机械描述并在构建 gate 中证明完整体积落入保留的 provider context budget；超限是 gate 失败，不能在生产静默缩水能力。
- use_browser、declare_completion_criteria、use_skill 与同一 assistant message 中的其他 tool calls 都先走标准 call/result 配对；激活只影响下一次模型迭代，不中断或丢弃同批其他结果。重复 use_browser 只返回 `{alreadyActive:true, disciplineMajor, pageIdentityDigest}`，不重复注入纪律或 schemas。普通 additive skill 的 use_browser→use_skill 与反向顺序都保留双方授权。exclusive 的 Browser→skill 顺序在 scopeRef 生效后压住 Browser；skill→Browser 顺序下 use_browser 在匹配 typed terminal receipt 前不可见，terminal 后下一 iteration 才出现；owner-bound scope 则必须先走现有 owner transition。已有 Browser activation 在合法 scope 结束后恢复。进程在激活后、首个真实 Browser tool 前崩溃时没有页面副作用或 browser child，按普通 run 恢复即可。
- 删除自然语言/正则提前开放 Browser route 的优化，不保留第二条能力入口。结构化 Browser context 在非 exclusive surface 直接开放；其他非 exclusive context 只通过 use_browser 激活。完全陌生语言、非 Browser 工作台且没有 pageRef 的请求仍可由模型在同一 run 调用 use_browser，无需用户再次发言；exclusive scope 退出后恢复同一规则。
- 非 Browser 工作台且尚未激活 route 时，latent definitions 不进入 provider 的实际工具 schema，避免所有 Ready 对话永久承担完整 Browser schema；除结构化 exclusive profile 外不得隐藏 use_browser。

### 3.11 token 与证据负担

- 模型循环只接收紧凑 outcome、必要候选和资源引用；完整 page map、正文和证据存资源层，按需读取。
- full low-risk closure 保持可用，但 schema 说明压缩为机械合同，不注入站点和固定工作流长文。
- 记录每轮工具 schema、runtime instruction、page map 与累计输入大小；大任务不得每一步重复整份 map。
- controlled runtime 使用独立日志目录和隔离 userData；请求相关日志、截图、DB 与 continuation 带同一 runId/taskId，启动等无请求日志不强制补关联字段，不得再从共享临时日志中按时间猜证据归属。

## 4. 实施阶段

### Phase 0：只加失败探针与持久观测，不改终态裁决

1. 新增不依赖外部 provider 的 Electron 输入矩阵，记录：
   - view attached/parked/hidden；
   - on-screen/off-screen/0×0 与主 BrowserWindow active/inactive；
   - webContents、document focus、focusGeneration 与 userActivityGeneration；
   - 持久/临时 CDP target、CDP Input、webContents.sendInputEvent 与现有可信输入 transport；
   - input/search/contenteditable；
   - 主文档/iframe；
   - click、key、wheel、drag、select 分别测试；
   - keydown、keypress、keyup、click、submit、navigation、popup、download 计数。
2. 对 Layout A/B 在同一 Electron 进程复现 focus 前后差异。
3. 固定 fresh ref 自我失效、no-change 双击、静态 /layout-b 假交易证明、parent done/child paused、takeover 后仍可写五个反转测试。
4. 在第 N 个已提交工具结果后确定性注入 522，固定旧 receipt 不重放和 fresh-owner 续跑预期。
5. 重写 controlled proof：marker 由 fixture 运行时随机生成且不进入提示；验收读取结构化页面结果、DB child 和最终文件，不检查模型文字 includes。
6. 给 TaskEventBridge 增加只记录不改变裁决的观测，核对 parentRevision、ownerRunId、parent/step、taskRevision；证明通知丢失不会阻断 Parent continuation，Renderer/startup 可直接从 Parent/message 恢复，不新增可靠通知表。
7. 增加 Ready 非前台且另一应用持续输入的 fixture，记录是否抢焦点、是否 dispatch、generation 是否变化；分别证明 Agent synthetic input/程序化 tab 不递增 user generation、真实用户输入必递增；增加 takeover 后重启且 admission 尚未恢复的写租约测试。
8. 固定无关 navigation/DOM/network 不满足 expected_effect、child completion 与 finalizer 并发、通知丢失但 Parent continuation 仍可恢复、522/stop/takeover/completion 同时到达四组竞态。
9. 做 target identity spike：目标前插入无关 DOM 后仍命中原节点；虚拟列表复用节点、iframe replacement、真实节点销毁和同 tabId 下 webContents/CDP target 重建必须 stale；应用重启并复用同 tabId 时 bootIncarnationId 必变、旧 ref 必 stale；枚举序号不得出现在稳定 ref。
10. 固定 run_meta live-status 漂移测试：生产入口创建 running 行后模拟重启，旧 reconciler 确实漏收；迁移目标只把历史 working 归一为 running，Browser continuation 冲突时始终只服从 Parent。
11. 用 search reindex 的第二个真实 SQLite writer 和最小测试连接分别持有 ready.db 写锁，量出不会卡住 Electron Main 的短重试总预算；记录锁在预算内释放、超过预算、等待期间 stop/takeover 抢先三种事实，禁止先拍脑袋设置 timeout。
12. 对 §2.2 cutover matrix 建立运行时 caller census：逐个触发 background handoff、模型/Controller/UI/startup/确认 resume、timer、自续跑、takeover complete、partial consent、文本 route、固定 planner/runner/session、Renderer 普通追问预先 kill、Main `runConfirmed/runCoordinator/AgentSdkRunLifecycle.beginRun` 抢占、stale-projection-finalizer 与旧 completion/progress writer，记录真实 start/resume/schedule/preempt/page-dispatch/terminal-write 计数和 owner 归属；另对全部直接 `task_projections` SQL/repository writer 做字段所有权清单，未列明 caller 先补表，不进入实现。
13. 固定语义真值失败：陌生语言单目标、三目标、资源附件和超过 2,000 字请求分别证明旧 Parent 没有可回读 request anchor/goal producer，三目标只完成 1/3 仍会假收口；同时记录 source message/resource 当前可回读边界。
14. 固定 closeout/恢复失败：Dynamic Delivery accept 后在核心 DB SQL 边界注错，证明旧 committed MemorySession/scope snapshot 会泄露候选；复现旧 continuation/checkpoint 死锁、takeover 工具返回前 checkpoint 造成未配对 tool call、普通 mutate settled 后/result 前与同一 assistant 多 tool 第一项完成后的崩溃、临时目录 checkpoint 丢失、模型 complete 绕过，以及 FTS/recall/hint 故障错误回滚核心完成。新增普通追问的 kill 后/message 前及 persist 后/beginRun 前崩溃、suspension intent 后/result 前崩溃、resume commit 后/provider 前崩溃和第二次 owner_crash 确定性注错。
15. 固定过度防控与未知页面失败：普通部分采集会被要求确认；未知 SPA search 和普通保存/发送已送达却无预先 result target 时被误判失败；永远没有 backendDOMNodeId 的 closed-shadow/AX-only 目标每次 fresh 仍无法执行；子 iframe 单独 reload 会让主 frame ref stale。四者均形成反转测试。
16. 固定 wake/授权/steering 恢复：对表中每个 wake 类型生成真实 durable receipt，验证无 receipt、旧 digest、重复 wake claim、不匹配 kind 全部拒绝；steering 另验证 canonical message 按序实际进入 provider input 与 checkpoint 后才写 contentCheckpointId，terminal candidate 遇 pending receipt 必须 checkpoint_steered，禁止词表分类。连续运行三次 model iteration：第 N 轮注入 steering，N 与 N+1 都调用工具；验证 N+1/N+2 以最新 final effective input 加 SDK suffix 继续，provider input、最新 checkpoint 与 sealed bundle仍含同一语义/digest，receipt 只消费一次且 preempt=0。再让 text bridge 的首个 Runner 先调用普通工具、在该 Runner 最后一次 filter 后才调用 `use_browser`，验证第二、第三个外层 Runner 均从同一 owner-local 非共享 working view 收到原请求、前序 assistant call 和 tool result；共享 MemorySession 写计数为0，激活后的首个 clean boundary只生成一份完整 checkpoint。checkpoint 建立后再跨连续 `host.runAgent` 与 text-bridge Runner，验证每个新 Runner 从最新 checkpoint seed 重建 owner-local cache，同 Runner 只合并 cursor 后 suffix，无 prefix mismatch、重复消息或第二 durable 真值。篡改同 Runner source prefix 或新 Runner seed 必须在 provider 前以明确 failed exit结束，不能进入 waiting。证明 fresh_observation 没有 detached producer也不是 wake。普通 additive skill 的 `use_skill→use_browser` 和反向流程分别在 522 与重启后恢复，live identity/floor 既不丢失也不扩权；exclusive skill 用真实 skill/child terminal receipt覆盖 Browser→skill 后压住、skill→Browser 在 terminal 前不可用、terminal 后下一 iteration 恢复，测试不得直接 clear 状态。无 durable terminal producer 的 fixture 只能通过 owner-bound exitOwner/resumeOwner 恢复。checkpoint 后给当前 skill manifest 新增 action/primitive时恢复面不扩张，删除任一保存的 required tool 时必须 capability/config waiting。另在 Browser 激活后首个工具前及 SDK 内部第二次 model iteration 前杀进程，证明 post-compaction effective input 已 readback；100-turn 合成任务证明 checkpoint 常数行与 O(n) 总字节；Kimi/通用 serializer roundtrip 保留 assistant、function call/result、providerData、thinking/signature 与多媒体 data URL。用 520–524、501/505、Retry-After 和语义 4xx 固定 provider 分类反转测试。
17. 在旧实现仍可成功的稳定性能子集先热身，再每场景至少 20 次冻结基线。正确性 fixture manifest 明确列出 12 个结构—语言变体，整体覆盖至少 4 种语言，每个变体重复 3 次，由 manifest 自动计算为 36 次；不再在多处手写矛盾乘法。记录成功目标数、首次有效页面进展、canonical/runtime/owner/verifier 分段 P50/P95、owner provider 请求数、总工具调用、累计输入上下文 P50/P95、无进展重试和非必要用户中断。Phase 5 非劣阈值按 §0.4 固定：正确性仍 100%，假完成/重复 dispatch/后置页面写/无进展自动重试/非必要中断均为 0；首次有效进展最多多 1 次模型迭代；Browser 工作台总调用不超过 baseline+0，非 Browser latent route 只允许 use_browser 带来的 baseline+1；owner provider 请求不增加；累计输入上下文 P50/P95 不超过 110%；verifier 恰好一次且零工具。跨 provider 时间窗的旧 115%/120% wall clock 只保留诊断结果，不决定 cutover。

Gate：旧实现按预期失败；每个根因都有独立、稳定、可重复的证据；形成按动作类型的 transport/前台条件表、完整 production caller matrix、request/resource 回读边界与已冻结性能阈值。任何入口、基线或产品裁决未完成都不得进入 Phase 1。

### Phase 1：单一 workflow/CAS 基座与原生输入

1. 给 TaskProjection 增加单调 revision、requestAnchor/可选 goal declarations 与字段所有权 CAS；把外部 requestId 与不可复用 ownerRunId 分开；存量 run_meta working 归一为 running；browser_tasks 增加 parent_step_id 与准确 required dependency。扩展现有 `declare_completion_criteria` 的唯一 Parent writer，以稳定 goalId 追加 `upsert | supersede` mutation receipt，禁止整组覆盖。迁移所有 Parent writer，generic writer 对 anchor/goals、owner、continuation、dependency、终态和 proof 越权写必须拒绝。
2. 增加 browser_workflow kind、BrowserGoalItem 可选映射与 BrowserWorkflowStore transaction context。bindRoute() 在无 plan、steps=[] 的短 read 也可从可信 RequestEnvelope 原子创建 requestAnchor、mechanical step 和 child；有显式 goals 时只映射 id，绝不制造语义 goal。
3. 合并唯一 BrowserCapabilityRegistry；canonical resolver 返回 closed operationId/mode/effects，未知 operation 或任一旧工具名分类兜底使 gate 失败。
4. 在 child 建立 actionJournal/observationEvidence 与 in_flight/settled CAS；fake transport 覆盖 CAS 前、CAS 后 dispatch 前、dispatch 中、settle 后崩溃，后三者不重放。
5. 增加同库 agent_session_checkpoints 表，以及 inactive closeCandidate()/exitOwner()/resumeOwner() Unit of Work；fresh `prepareAgentSdkTurn` 产出 live SkillTurnIdentity/authorization/composition/exclusiveScopeRef。任何 prepared surface 含直接/latent Browser 的 turn 都先从 committed MemorySession 只读创建 owner-local 非共享 SDK Session，并在 checkpoint 建立前供同一 owner 的全部外层 Runner 复用；共享 session 从第一轮起零写。Browser 激活后的首个 clean boundary 把这份完整 working view 固化为 checkpoint，包含 final effective input、SDK source cursor、steering receipt digests、owner base、精确授权 allow-set/digest、全部 requiredFloorToolNames/source/digest 与 activated groups，纯 revalidator 恢复。checkpoint 建立后，每个新 Runner 丢弃旧 cache并用最新 final input seed 重建 owner-local Session，在 first filter 校验 seed prefix并重置本地 cursor；同 Runner clean boundary用最新 committed final input + cursor 后 SDK suffix，compact 后原样追加本轮 pending steering，final provider input 的 checkpoint rotate 与 receipt 消费同事务，且只保留当前 base/suspension/新 owner base；resume 事务为新 owner固化 seed/base；核心 closeout 只写 child/Parent/run_meta/message/conversation，派生索引和 accepted session delta merge 放 post-commit。
6. 从输入矩阵产出动态 BrowserInputReadiness predicates；BrowserActionExecutor 只复用现有 BrowserWriteLease，区分 agentDispatchToken 与真实 user generation，不创建第二租约、不主动激活非前台 Ready。
7. 注入页面事件探针，区分 dispatchAccepted、deliveryObserved、effectObserved；删除 no-change 自动第二次 click/press 与所有 post-dispatch 重放。
8. takeover/stop/foreground fence 在 readiness 和 dispatch 前均检查；startup 先恢复 scoped fence 再开放 admission。
9. Store 固定使用 Main 同一 raw connection；SQLITE_BUSY/LOCKED 只在事务外按 Phase 0 预算重试并重读 CAS/fence，Main 不设置长同步 busy timeout。

Gate：bind/close/exit/resume 的 CAS、rollback、owner/run_meta expected status、短/长写锁和 stop 竞争全部通过；listener/派生索引失败不反写核心结果；in_flight 崩溃为 unknown且不重放，settled/result gap 只产生 journal recovery fact + observe-only barrier；steering 的 wake claim/content checkpoint 分离且消息不丢不重，连续三次 model iteration仍从最新 final input 合并新 SDK suffix；latent Browser 在前一 Runner 最后 filter 后激活时，后两 Runner 仍从 owner-local working view 获得原请求和完整 call/result，激活后恰好产生一份完整 checkpoint；此后跨 host/text Runner 只从 checkpoint seed 重建 cache，active owner 共享 MemorySession 写入始终为0；cursor/seed 漂移在 provider 前进入明确 failed exit而非 waiting；synthetic Agent 输入不增 user generation、真实用户输入必增；单动作无 plan 可执行并在 closeout按 requestAnchor核验，显式三目标可映射且只完成1/3不能收口；长请求/资源 anchor 可回读，run_meta 2,000 字快照不参与裁决。production factory 仍未接新 route。

### Phase 2：单一动作结果与原子 ref

1. browser_research 只向已绑定 workflow task 增加 work item，删除普通动作与 site research 的双 checkpoint。
2. 把所有页面写/导航/标签副作用接入 in_flight→settled journal；owner 丢失后的 in_flight 一律 unknown、只允许 fresh observation，不允许重放。任一 settled action 尚无因果 observation receipt 时都禁止 mutate；只有其 actionSeq 高于 checkpoint.lastEffectiveBrowserActionSeq 时才额外注入 recovery fact。snapshot/find/read 直接写 observation receipt。
3. 以现有 browser-action-receipt 探针为输入扩展 BrowserActionOutcome；Outcome 与 receipt/hash 直接结算进同一 task revision，不引用不存在的资源层或 SDK per-action checkpoint。browser_search 的 fill/submit 使用两个 actionId 和同一 searchActionId。
4. executeBrowserTool、BrowserActionExecutor、act/observe/collection 只返回 Outcome 或 observation receipt，并在 task/receipt 回读成功后才对外返回。
5. 用真实 CDP backend node/等价句柄替换枚举序号，加入 bootIncarnationId + targetSequence 的 physicalTargetToken，修正 page map publish/dirty 顺序；普通 mutation 改为带完整身份指纹的目标级实时复核。
6. Grounded research receipt 改为 outcome/observation id 引用，work item 完成证据不随诊断历史截断，删除重复 before/after/toolName 解释。
7. browser_search 分成 exact fill、submit、mechanical effect 与后续 result evidence；同一 action-linked post observation 泛化给全部 mutate，允许绑定动作后才出现的 toast/新区域，但不允许重放或单独 network-only 证明效果；失败返回精确阶段。
8. 将现有唯一 CompletionVerifier 和 closeCandidate() 接入 test-injected route：末轮文字缓冲；核心事务写 child+Parent+run_meta+canonical message/conversation，commit 后显示并修复 FTS/recall/reference hint；done 缺 text 时 Renderer 按 id/digest readback。
9. 落地 ownerRunId/binding fence、通用 ExitClass 穷尽映射与 Browser 四个差异 reducer；旧 owner terminal patch、迟到 action result 和 cleanup 状态覆盖全部拒绝。
10. 修正 resolveEffectiveTaskFacts/turn closeout：Parent taskType/module 胜出，budget 只供容量；criteria 按 delivery obligations 区分 Browser state change 与真实 artifact。
11. 收回 content-task-runner、browser collect/note/card loop 与 browser sub-agent 的页面所有权：会调用 Browser 工具、获取 BrowserWriteLease、滚动、导航或操作 BrowserView 的逻辑只能留在当前 owner 的当前工具调用内，并在返回前结算 Outcome/observation 或写 typed checkpoint；公开工具结果一旦返回，归属于该已结束工具/worker 的后续 BrowserView 读写计数必须永远为 0。detached worker 只保留无 Browser 工具/lease 的文件解析、网络下载或资源后处理；需要继续页面步骤时由 Parent continuation 采用新 owner，不让后台 worker 自行续跑。
12. 扩展现有 Dynamic Delivery CompletionVerifier：输入回读后的 requestAnchor、plan mutation sources、可选 goals、全部 Browser evidence、delivery obligations 与 isolated session delta；无 plan 时直接对原请求核验。verifier 不写状态/证据，同一语义 verdict 不重跑，只有 transport invalid/unavailable 可在预算内重试一次。
13. 重排 Dynamic Delivery accept 路径：`candidate-session-fork` 只产生 sealed delta，`commitAccepted()`/committed MemorySession merge、scope snapshot 与 reference hint 内存更新全部移到 workflow DB commit 后；任一 SQL fault、verifier missing/unavailable 或候选 revision 失效时，committed MemorySession、model checkpoint、scope snapshot、chat row 与 Renderer 中 terminal candidate 均为 0。commit 后内存 merge 失败只从 canonical DB row 重建，不创建第二终稿。

Gate：mutate 在 dispatch 前已有 in_flight，observe 返回前已有 receipt；settle 后/result 前和同批第一项完成后崩溃均零重放、零伪造 function result，且只在 fresh observation 后解除 barrier；steps=[] 无 plan 短 read 可在同一 run 被 verifier按 requestAnchor接受；三目标只完成1/3、verifier自写证据、第二 verifier 串联均拒绝。工具返回/stop/takeover 后旧工具/worker页面写为0。核心 SQL fault 全 rollback且 MemorySession/snapshot/Renderer 无候选；FTS/recall/hint post-commit fault 不回滚核心完成并可 read-repair。IPC丢失/重启仍按同一 messageId恢复；fresh ref、per-frame reload、unknown-SPA search、transaction、scoped fence全部通过。production route仍未切换。

### Phase 3：删除词表调度与重复完成权威

1. 在只供测试注入的 inactive route 中实现 RequestEnvelope 的 workbenchMode/browserPageRef/browser continuation 直接开放低风险闭包；其他 turn 常驻小型 use_browser activator并安装 latent definitions。只复用通用 latent plumbing，不改写 sameRunActivatedSkillId；独立 activatedCapabilityGroups 记录激活，RunCapabilityController 按 skill capability 层的 additive/exclusive composition 与 typed-terminal/owner-bound exclusiveScopeRef 计算下一模型迭代的有效闭包，首个 observe/mutate operation 才自动绑定 workflow task。
2. 在新 route 中删除 tool executor、turn execution、finalizer 的自然语言重复分类、工具名推断 taskType 与 budget taskType 语义覆盖，并列出所有旧生产 writer/reader 的唯一 cutover 清单；此阶段旧生产 route 仍保持原样，不和新 route 双写同一个真实任务。
3. 将 BrowserTaskPlanner 具名站点/固定 upload-submit 计划、BrowserDomainOrchestrator 工具名进度、BrowserAgentRunner deterministic path 与 BrowserActionSession confirmation/target/proof/reminder 的调用方逐一迁到新 contract 的测试替身，证明 cutover 后可直接删除，不先让两套权威同时在线。
4. challenge 新路径只认结构遮挡、浏览器错误、权限/网络权威信号；语义页面由模型观察后决定 takeover。
5. site_research fields 与进度在新路径改为任务字段和 evidence refs，不再限定固定字段枚举或固定工具序列。
6. 构建穷尽 BrowserCapabilityRegistry、use_browser 独立 capability activation 和统一 Browser discipline；resolver、binding、readiness/lease 与确认从 operation mode/effects 派生，Phase 5 前新 route 只从测试 factory 注入，不新增 feature flag、用户配置或运行时回退。

Gate：日语、意大利语、中文、英文和无文本控件使用同一路径；陌生语言/非Browser工作台/无pageRef仍可调用use_browser并在下一迭代获得闭包，且该 turn 从第一次 provider 调用起共享 MemorySession 写计数即为0；激活前的 owner-local view 能跨外层 Runner 保留完整历史，激活后只由 checkpoint 持久接续。三条SDK provider与text bridge call/result成对，同批工具不丢，重复激活不重复纪律/schema；普通 additive skill 的 use_browser/use_skill 双顺序保留双方授权；exclusive 双顺序在真实 typed terminal receipt 前只暴露独占面、terminal 后下一 iteration 恢复既有 Browser activation，无 terminal producer 时只有真实 owner transition 可恢复，测试不得手动清状态，Browser/Orchestrator 无具体 skillId 分支。text manifest不截断；每个typed operation在registry恰有一项且无工具名兜底；旧production caller matrix无未知入口。源码审计只辅助证明无站点/语言/查询词分支。

### Phase 4：父子终态、续跑和 provider 交接

1. 落地 Parent superseded dependency、通用 ExitClass 穷尽映射和 Browser四差异 reducer；Renderer status不参与裁决。
2. provider classifier收为单一入口；只有具备同库checkpoint、required child与真实进展的Browser workflow可自动交接，且只由AgentSdkTurnOrchestrator调用resumeOwner。
3. 实现agent_session_checkpoints schema/serializer/readback；fresh `prepareAgentSdkTurn` 生产并持有 live SkillTurnIdentity/SkillToolAuthorization/surfaceComposition/exclusiveScopeRef，same-run use_skill 同步更新；恢复只走纯 `revalidateSavedSkillAuthorization`。prepared surface 含直接/latent Browser 时，SDK Runner 从第一轮起不传可写共享 MemorySession，而是从 committed snapshot 创建并在同一 owner 的外层 Runner 间复用 owner-local 非共享 Session；即使 `use_browser` 在某个 Runner 最后一次 filter 后才激活，下一 Runner 也能看到激活前的完整 assistant/tool 历史。Browser 激活后的首个 clean boundary 恰好写一份完整 checkpoint；此后每个外层新 Runner 以当前 checkpoint final effective input为显式 seed重建 owner-local cache，first filter校验 seed hash并重置 runner-local cursor；同 Runner 后续 `callModelInputFilter` 回读当前 owner 最新 final input，验证 source cursor并只合并新增 suffix，compact 后把按序 pending canonical steering 原样追加到 callback result，直接序列化 final provider items与下一 cursor；checkpoint rotate 与 contentCheckpointId 同事务，不从共享 MemorySession 重读。seed/source mismatch进入明确 failed ExitClass，provider=0，不产生 waiting。验证call/result成对、pending/terminal candidate为空、required operation存在、精确 authorization allow-set 与全部 requiredFloorToolNames 可按当前 registry/policy/consent 复核且serializer/registry/safety major兼容。新增 skill tool 不扩权，任一保存 floor tool 消失则 waiting；exclusive 只由匹配 terminal receipt或owner transition结束；additive minor、描述和新增 Browser 只读operation不阻断。resume 必须在同一事务写匹配下一 Runner seed 的 owner base并 rotate 掉未引用旧 row。
4. 实现post-tool-result suspend边界和durable suspension intent，question/confirmation/foreground/takeover共用；每种intent/result/exit崩溃窗口恢复一致，intent 后/result 前只恢复最后干净 base 与 waiting fence，不伪造 tool result。
5. startup先恢复user_stop/human_takeover/foreground/action_in_flight scoped fence，再处理running owner_crash与Parent continuation；run_meta continuation始终NULL，pending_task_events保持legacy用途。
6. 按 §3.7 穷尽 wake-source 表实现 resumeOwner：事务外验证、单事务消费 receipt/绑定 running owner/写新 owner base checkpoint、commit后调用provider；无adoption_pending、activate/failPendingActivation、文件checkpoint或第二恢复状态机。
7. 全部新路径仍只挂test factory；Gate通过前不切production。

Gate：全部TurnTerminalReason有通用ExitClass且Browser仅四个差异；cancelled_user不可恢复；同一wake/basis至多resume一次；表中每个wake都有durable source，无receipt/错kind/旧digest均拒绝，fresh_observation 不在表且无 detached producer；steering receipt 的 wake claim 与 content checkpoint 分离，第 N 轮注入且 N/N+1 有工具调用后，N+1/N+2 provider input、最新 checkpoint、sealed bundle 仍保留语义/digest，receipt 只消费一次；Browser 激活前跨连续 host/text Runner 的 owner-local view 保留原请求和成对 call/result，激活后首个 clean boundary只生成一份完整 checkpoint；此后跨 Runner 的 first/subsequent filter 从 checkpoint seed 单次接续，共享 MemorySession写入始终为0；source/seed漂移在 provider 前明确失败且不等待；522无通知也从Parent恢复；checkpoint截断/未配对/major不兼容/任一授权floor tool无法重建拒绝，新 skill tool 不扩权，additive Browser registry变化可恢复；exclusive 只由真实 terminal receipt或owner transition结束；Browser 激活后首工具前和 SDK 内部连续两次 model iteration 前都有 effective-input readback base；Kimi/function/providerData/thinking/multimedia roundtrip 完整；100-turn checkpoint 为常数行且总字节 O(n)；resume commit前崩溃DB不变，commit后崩溃只用新owner base走owner_crash，第二次resume不借旧owner且不重放；任何resume commit前provider/model/tool=0；takeover普通文字/模型complete无效，typed `{taskId,takeoverId}`只消费一次，target重建后fresh snapshot；stop/takeover/completion/522仅一赢家。production route仍未切换。

### Phase 5：通用任务、人工接管与紧凑上下文

1. 只有Phase0–4全过后，按§2.2 matrix一次切换production factory：启用use_browser/结构化context、独立activatedCapabilityGroups、registry与自动bindRoute；同时断开background handoff、collection/controller/UI/confirmation/startup/timer直达runner、content-task-runner/sub-agent页面循环、模型/普通文字takeover complete、Renderer 普通追问预先 kill、Main beginRun 对未裁决消息的抢占、stale-projection-finalizer 直接封口、partial consent/full-row writer、文本route/inline fast path、BrowserActionSession、固定planner/domain runner与旧completion/progress writer。保留扩展后的现有declare_completion_criteria，不强制简单Browser调用。不得双写、legacy fallback、feature flag或第二owner。
2. 低风险浏览器闭包在 browser route 下稳定暴露；advanced/credential/destructive 能力仍按结构事实授权。
3. 多输入、多 frame、shadow DOM、SPA、popup/new-tab、dialog、select、hover、drag、download 使用同一 outcome/readiness 合同。
4. observed href 导航带 source target provenance；禁止合成站点 URL，不强制坐标点击。
5. takeover 完成持久状态、准确 tab 展示、重启恢复和 fresh re-ground。
6. page map/正文转资源引用，压缩工具 schema 与重复 reminder。
7. 正确性由 fixture manifest 列出 12 个结构—语言变体（整体至少 4 语言），完整基线为每个 3 次、总数 36；性能子集基线热身后每场景≥20次。基线已完成后，局部修正按 §0.5 只补原失败与直接风险变体，不机械从零重跑 36+20。所有样本只断言用户目标/持久结果，不断言工具顺序；按 Phase 0、§0.4 与 §0.5 的分层合同裁决，不事后移动阈值。

Gate：matrix每个旧route/writer真实计数为0；任何任务只有一个Parent owner、一个child journal和一个CompletionVerifier。累计 36 次正确性基线与后续定向风险样本均 100% 达标，假完成/重复dispatch/后置页面写/无进展自动重试/非必要中断为0；无plan简单动作成功，三目标1/3拒绝；takeover后Agent零写、重启仍等待、typed UI后同task续跑，普通文字/模型complete无效；性能子集满足首次进展、Browser工作台+0调用、latent route+1调用、owner provider请求不增加、上下文110%、verifier一次且零工具，并完整报告 §0.4 四段 wall clock。外部站点变化可记录，但Ready不得假成功、重复动作或owner分叉。

### Phase 6：真实验收、文档和关闭

依次运行：

1. npm run verify:browser-orchestration
2. npm run verify:browser-surface
3. npm run verify:browser-lane
4. npm run verify:browser-reliability
5. npm run verify:browser-native-lock
6. npm run verify:native
7. npm run verify:stability
8. npm run verify:streaming
9. npm run verify:dynamic-delivery
10. npm run verify:tag-forge
11. npm run typecheck
12. npm run test
13. npm run build
14. npm run verify
15. git diff --check

真实 Electron 必须完成：

- Layout A/B 输入、提交、结果、ref 和 DB 终态；
- 未知 SPA 的 submit delivery 先落为 needsObservation，再由绑定 searchActionId/queryDigest/frame identity 的新结果或空结果 evidence 结算；全程不自动重发；
- 未知 SPA 的普通保存/发送在动作前没有结果区时也可 dispatch；随后新建 toast/状态区的 observation 必须绑定 actionId、before digest、frame 与 post-capture sequence，能被 verifier 采信但不伪造预绑定 transaction_confirmed、不允许重发；
- 没有 backendDOMNodeId 的 closed-shadow/AX-only 目标在同 capture revision 可单次执行，跨 publish/mutation/revision 立即 stale；指纹或唯一性不匹配不得静默重绑；
- 子 iframe 单独 reload 只使该 frame 子树 ref stale，主 frame ref 仍可用；主文档导航和 physical target replacement 分别按合同失效；
- 陌生语言单目标、三目标、超过 2,000 字原请求与带附件/资源任务均可从 Parent requestAnchor/可选 goals/readback bundle 完整核验；1/3 目标不得收口；
- 第 N 个动作后 522 自动交接，browserTaskId 不变、receipt 零重复；
- 同位置用户 stop，fence 后页面写严格为 0；
- stop-vs-closeout、exit-vs-late-result 两种顺序都只有一个赢家，in_flight action 结算 unknown 且不重复；
- 普通 mutate settled 后、标准 tool result 入 effective input 前杀进程，以及同一 assistant 多 tool 第一项已完成时杀进程；恢复只注入 journal recovery fact、零伪造 function result、零 mutate 重放，并在 fresh observation 前保持 observe-only；
- 同一 target 的 hide/show、bounds、park/unpark 与 surface 重新附着保持 physicalTargetToken 不变；source tab replacement、底层 WebContents/CDP target replacement、agent tab recreation、应用重启并复用同 tabId 后旧 token 必 stale，同一任务按新 token 续跑；
- 多输入框、iframe、SPA、popup、dialog、download、不同语言页面；
- Phase 5 manifest 的 12 个未知结构—语言变体（整体至少 4 种语言）与稳定性能子集保留已完成的 36+20 累计基线；本轮只重跑 `it-spa-triple` 原失败、observation-closure 的 native/text/restart 风险变体与受影响全量 gate；不得以固定工具序列替代目标验收；
- 小红书原始 18 查询、目标账号评价、浏览器 evidence、最终目标文档写入与 readback；
- challenge 时真实 waiting_human、准确 tab 可见、接管后恢复；
- takeover 后杀进程并重建 physical target：human_takeover fence 先恢复、准确 tab 重展示；typed `{taskId,takeoverId}` 由 Main 回读当前 target并只消费一次，模型 complete、普通文字、错误/迟到 takeoverId 均无效，恢复后先 fresh snapshot；
- 普通只读/部分采集与从现有证据选择子集不出现 consent 卡；全量目标证据不足时只保持 goal 未完成；
- 普通 additive skill 的 use_browser→use_skill、use_skill→use_browser、重复激活、同批多工具与三条 provider/text bridge 都保留双方授权且 schemas 完整；同一 Parent 同时需要 exclusive skill 与 Browser 时，两种顺序都用真实 skill/child terminal receipt 结束 scope：terminal 前只见独占面，terminal 后下一 iteration 恢复已有 Browser activation或显示 use_browser；无 terminal producer 的 fixture 只能经真实 owner transition 恢复，测试不得直接 clear，Browser/Orchestrator 全程不比较具体 skillId；
- additive、typed-terminal exclusive 与 owner-bound exclusive 序列分别在第 N 个动作后注入 522 和应用重启；恢复后 live SkillTurnIdentity、精确 floor、composition/exclusiveScopeRef 不漂移，skill allow-set 不超过保存集合与当前 registry/policy/consent 的交集，新增加的 action/primitive 不会自动开放，任一旧 floor tool 缺失进入 capability/config waiting；
- 任一 Browser 工具公开返回、stop 或 takeover 后继续观察一个完整测试窗口，归属于已结束 Agent 工具/worker/旧 owner 的 BrowserView 读写计数均为 0；用户接管和之后合法新 owner 单独记账，detached 文件/网络后处理仍可正常完成；
- 在 closeout commit 后、IPC 前杀进程，以及收到 done 后立即杀 Renderer；重开仍只显示同一 canonical final message，重复 done 不新增第二行；
- 在 resumeOwner 事务外验证前、commit 前、commit 后/provider 前三个位置分别杀进程；前两者 DB 不变，后者只用新 owner base checkpoint 走 owner_crash；再完成第二次 resume 并再次注入 owner_crash，全程不借旧 owner 授权、不重放已提交 Browser 动作；
- 在 question/confirmation/foreground/takeover 各自的 suspension intent 提交后、标准 tool result 入 session 前杀进程；重启只从最后干净 base checkpoint 恢复 waiting/fence，不伪造 result、不解锁、不重发页面动作；
- 在 active Browser run 中发送普通补充、问题答案、目标替换和明确停止；前三者必须先持久 canonical message/steering receipt，在 runConfirmed/runCoordinator/beginRun 前完成 Parent CAS且不做语义分类，generation/pending-tool/preempt 计数均为 0；下一 clean boundary 必须从最新 committed final input 合并同 Runner 的 SDK cursor suffix、compact，再把新消息与 digest 原样追加到 provider wire input，checkpoint 与 sealed bundle出现同一 digest并同事务写 contentCheckpointId。连续三次 model iteration 中让 N/N+1 都调用工具，N+1/N+2 仍保留消息语义/digest且 receipt 只消费一次。另让 latent Browser 在首个 Runner 最后 filter 后激活，验证第二、第三个 host.runAgent/text-bridge Runner 从同一 owner-local view获得原请求和前序 call/result，激活时恰好生成一个完整 checkpoint；激活后再验证每个新 Runner 从最新 checkpoint显式重建 cache，共享 MemorySession写入为0、无重复或 mismatch。cursor prefix/seed 被篡改时 provider调用为0且 current owner明确 failed、不等待。当前响应先 terminal 时必须 checkpoint_steered/resume 后交给新 owner；模型读到目标替换后可用稳定 goalId 的 typed mutation 更新同一 Parent，但不能启动第二 owner，只有停止按钮取消；覆盖 ingress 后/CAS 前、CAS 后/boundary 前、checkpoint commit 后/provider 前和 terminal 竞态；
- 丢弃 Renderer/TaskEventBridge push 并重启，旧 narration runner 启动数仍为 0，Parent/message readback 恢复同一 owner/终稿；
- checkpoint_budget、checkpoint_steered、checkpoint_incomplete、checkpoint_background、foreground_required、owner_crash 和共享 terminal reason 其余成员逐一走唯一 exit transition；
- 第二 SQLite writer 分别在重试预算内、预算外持锁，并在等待中触发 stop/takeover；验证 Main 不长时间阻塞、短锁只提交一次、长锁零部分写、停止可抢先；
- canonical core message rollback、同 id/digest 重试和 post-commit FTS/recall/reference-hint 失败/重试分别验证：核心失败无消息/终态，派生失败不回滚且 startup/read-repair 后可回读；
- Dynamic Delivery accept 后在每个核心 closeout SQL 边界注错：committed MemorySession、scope snapshot、chat row 与 Renderer均无terminal candidate；成功commit后才merge，内存merge失败由canonical row重建；
- checkpoint 位于同一 ready.db，验证 schema/hash/readback、call/result成对、required operation/major兼容、live SkillTurnIdentity/精确 allow-set/requiredFloorToolNames/composition/exclusiveScopeRef 的纯恢复、active owner 无共享 MemorySession写入；checkpoint 建立前同一 owner-local 非共享 Session 跨 Runner 保留完整上下文，激活后的首个 clean boundary只写一份完整 checkpoint；此后每个新 Runner 以最新 final input重建 owner-local cache并重置本地 cursor，同 Runner 后续只合并校验后的 SDK source suffix、compact 后按序追加 pending steering并直接序列化 final provider items/cursor、wakeClaim/contentCheckpoint 分离、resume 新 owner base、Parent唯一引用、完成后清理与run_meta冲突只服从Parent；100-turn 保持常数行和 O(n) 总字节，Kimi providerData/thinking/signature/function/multimedia roundtrip 完整；
- §3.7 每个 wake 来源逐项验证有效、无 receipt、旧 digest、错 kind 和重复消费；fresh_observation 无表项且无 detached producer，unfinished observation 同 owner继续或由其他真实 wake 后首个 observe；520–524、501/505、Retry-After 和语义 4xx 均走预期分类；
- §2.2 matrix 每个旧入口在 production factory 下真实触发计数为 0；合法新入口恰有一个 owner/journal dispatch，未裁决普通消息进入 AgentSdkRunLifecycle.beginRun 的 preempt 计数为 0、provider input 实际消费计数为 1；全部直接 `task_projections` SQL/repository writer 通过字段所有权静态 gate，stale-projection-finalizer 无法绕过 Parent revision/ExitClass 关闭 Browser Parent；
- 结果型基准满足 Phase 0 与 §0.4 已冻结的正确性、首次进展、owner 请求数、工具调用、上下文和分段性能合同；
- SQLite quick_check、parent/run_meta/child/checkpoint/continuation/chat_messages 一致；
- 所有净增代码文件检查总行数；超过1000行按危险/一般/健康更新 large-file-health-log，危险项未处理不得提交；
- 独立 UI 回归：计时器、工具历史/任务历史和后台任务卡的外层框已消失，交互按钮和进度仍可用；该项不替代Browser架构 gate，但必须阻塞最终提交。

完成后才同步 docs/architecture/current-runtime-contracts.md §6、相关 prompt 和 skill 指引。实现未通过前不得把目标合同写成现状。

## 5. 文件与删除边界

必须检查并按真实调用链最小修改：

| 文件 / 模块 | 目标 |
|---|---|
| host-layout-service、browser-surface-binding、ipc-handler、BrowserMode | 输入 transport 矩阵、非前台策略、可见 agent-driving、takeover |
| BrowserWriteLease/turn lease、automation-service、cdp-session-service、browser-input-actions | generation 来源、readiness、无 await 边界与单次 dispatch |
| browser-action-executor、browser-action-receipt、browser-tools、browser-act-tools、browser-input-actions | in_flight/settled、单一 outcome、搜索分段、无自动重放；删除 takeover complete executor |
| browser-snapshot-service、agent-browser-page-map、browser-probe/capture、CDP frame lifecycle | physicalTargetToken、per-frame document token、真实 backend node、原子 publish、目标级实时复核、observed href provenance |
| browser-tool-invocation/catalog/surface、write-classification、confirmation resolver | 合并为穷尽 BrowserCapabilityRegistry；mode/effects 单源派生 binding/lease/确认，无工具名兜底 |
| capability-types、task-persistence-service、browser-site-research-task、content-task-runner、browser-collection/note/card tools、browser sub-agent | browser_workflow、parent_step_id、goal/action/observation evidence；删除 site_research 第二状态机与全部 detached 页面 writer；公开返回/stop/takeover 后 BrowserView 读写为零，detached worker 永无 Browser 工具/lease |
| browser-collection-consent、collection IPC/projection writer | 删除普通部分采集确认、store/IPC 与旧整行 Parent writer；只保留现有高影响行动确认 |
| migrations、TaskProjection contracts/repository、run-meta、run-finalizer、projection sync/reconciler、stale-projection-finalizer、startup | requestAnchor/optional goals、revision/CAS、BrowserGoalItem、字段所有权、dependency、纯 closeout candidate、superseded；Browser Parent 不得被 stale finalizer 直接封口；所有 Parent writer禁止旧全量覆盖 |
| declare_completion_criteria schema/executor | 保留现有工具并扩展可选 stable goals，以及按 goalId 追加的 `upsert | supersede` mutation receipts；删除旧整组覆盖，不作为 Browser admission gate |
| BrowserWorkflowStore、database raw connection、search reindex worker | Main单connection Unit of Work、SQLITE_BUSY/LOCKED外部有界重试、第二writer竞态；语义resolver留在Orchestrator |
| AgentSdk provider runner `callModelInputFilter`、host.runAgent/text bridge、session serializer、agent_session_checkpoints/steering receipt migration/repository、startup | prepared surface含直接/latent Browser时，fresh turn先只读committed session创建owner-local非共享SDK Session，checkpoint前由同一owner的外层Runner复用，Runner从首次provider起不向共享MemorySession写filtered input；Browser激活后首个clean boundary固化完整checkpoint，此后每个新Runner从最新checkpoint final input重建owner-local cache并在first filter重置本地cursor，同Runner后续从最新committed final input合并经cursor校验的SDK source suffix，compact后按序原样追加未消费canonical steering并直接保存最终provider items与下一cursor；checkpoint rotate/contentCheckpointId同事务，wake claim分离；同库versioned blob/hash/readback、常数行原子rotate、owner base/ancestor digest、tool call/result成对、required operation、live SkillTurnIdentity/精确authorization allow-set/requiredFloorToolNames/composition/exclusiveScopeRef/activated groups 与registry/safety major、terminal candidate为空；accepted delta只在核心commit后合并共享session；删除文件checkpoint/run_state continuation |
| Dynamic Delivery coordinator/verifier、candidate-session-fork、scope-session-snapshot | 复用唯一 CompletionVerifier；只返回 sealed delta，DB commit 后才 merge/snapshot，rollback 零候选泄露 |
| chat repository、FTS/recall/conversation metadata、reference-hint-service | 核心事务只写canonical message/conversation；FTS/recall/hint post-commit幂等修复与startup read-repair |
| ipc stream payload、preload types、renderer runtimeDriver | Main canonical messageId/digest、commit 后显示、重复 done/重启去重，不再由 Renderer 随机生成终稿 id |
| task-event-bridge、pending-task-event/reminder、narration continuation | pending表保持legacy；通知只post-commit，删除projection/owner claim与平行完成权威 |
| provider error classifier、model loop、AgentSdkTurnOrchestrator、turn closeout、cleanup registry | 通用ExitClass、post-tool suspend、522分类、单一resumeOwner、旧owner fence |
| RequestEnvelope、Renderer `useAgent`/Main sendScoped message ingress、runConfirmed/runCoordinator/AgentSdkRunLifecycle.beginRun、resource readback、messageComposer、RuntimeContext/latent activation、browser-workflow-intent、task-type-resolver、agent-sdk-tool-executor | 普通追问先持久为未消费 steering，不在ingress分类；clean boundary注入，terminal pending走checkpoint_steered；删除Renderer预发送kill与Main未裁决抢占；Main固化requestAnchor、结构化workbenchMode/browserPageRef、独立activatedCapabilityGroups、latent use_browser；删除词表route与budget语义覆盖 |
| prepareAgentSdkTurn、SkillTurnIdentity/SkillToolAuthorization、capability-floors、same-run-skill-activation、skill terminal/child receipt、RunCapabilityController | fresh turn 单次产出live identity/authorization/composition/exclusiveScopeRef；恢复纯复核saved truth；all-saved-tools required floor；exclusive只由匹配terminal receipt或owner transition结束，additive/exclusive组合不在Browser层硬编码skillId |
| BrowserTaskPlanner、BrowserDomainOrchestrator、BrowserAgentRunner | 移除 live 固定计划；无剩余调用方则删除 |
| BrowserActionSession、对应 reminder/renderer parser | 删除交易、target、proof 权威，改读 outcome |
| browser takeover schema/invocation/act tools、TaskPanel、preload/IPC | 删除模型/普通文字complete；`{taskId,takeoverId}` typed UI，Main回读当前target并CAS消费 |
| controlled live proof、result benchmark 与 focused tests | 隐藏 marker、DB/evidence/readback、manifest 中 12 个结构—语言变体 × 3 repeats = 36、1/3 goal rejection 与页面后置写计数 |
| runtime log path / correlation | 隔离日志目录与请求级 runId/taskId 关联 |
| RunDurationMeter、TaskToolSnapshot、TaskCard | 保留已验证的无外框样式，只做相关回归 |

不扩张到：

- 历史/书签产品入口；
- 凭据管理器和自动填写密码/OTP；
- per-tab/per-origin 并行 lease；
- 跨任务长期站点学习；
- native 视觉重做；
- 新 Browser action/task 表或 legacy 兼容分支；允许唯一的同库 Agent session checkpoint 表。

## 6. 对旧计划的最终裁决

继续保留：

- 主 Agent 读取真实页面并自行决定下一步；
- 完整低风险工具闭包；
- 单写者、用户优先、stop fence、敏感操作确认；
- 持久 browser child、重启续跑、证据与最终产物 readback；
- 禁止站点 URL 合成和站点 selector runner。

明确替换：

- parked full viewport 可写；
- 任意 mutation 全页 ref stale；
- 详情只能 click、observed href 也不能导航；
- type 成功等于 search 成功；
- no-change 自动再点一次；
- 静态 URL/关键词等于交易完成；
- BrowserActionSession 持有交易真值；
- toolName 驱动 research/plan 进度；
- user text regex 在多个层反复决定 task type；
- parent 与 browser child 可独立结束；
- 任意 owner close 都暂停 child；
- provider 有进度后只能失败、不能 fresh owner 续跑；
- 提示内 marker 与最终文字包含关系作为 runtime proof；
- planner、domain orchestrator、runner、session、task ledger 和 finalizer 多层同时解释动作成功。

第十一轮独立审查者的定向 recheck 已通过，implementation_gate 保持 `passed_eleventh_targeted_recheck`。实现期间任何真实数据推翻合同，仍先停工、补证据、修计划，再继续。全部实现、真实验收和最终独立审查通过后，才提交并清洁工作区。
