---
title: 浏览器 Agent 工具面重组与可靠性强化实施计划
date: 2026-07-17
status: completed
enforce: false
owner: 白
original_author: Claude (Fable 5)
review_author: Codex
scope: agent 浏览器工具目录、执行链、长任务、下载、Power、BrowserView 控制反馈与验收
follow_up:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-18-browser-agent-grounded-orchestration-and-capability-closure-implementation.md
note: >
  本文件已经用户批准并完成实施，现为浏览器 Agent 工具面、执行链、恢复、原生指针与控制提示的强制合同。
  实施采用原子切换，未保留 legacy 工具名称兼容分支；软件交付证据与需要外部测试账号的发布前验收在文末分开记录。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 浏览器 Agent 工具面重组与可靠性强化实施计划

> **2026-07-18 运行纠偏：** 本文件保留为 2026-07-17 已完成实施记录。后续真实任务证明，新增的
> `browser_research` 专用链路绕开了本文件要求的通用执行权威，并且“低频工具只按用户原始文字追加”
> 无法覆盖运行中才显现的页面需求。因此 §3.4 的暴露策略、§8.2 的站内研究验收口径及 §15 对整体
> 浏览器能力已闭环的表述，不再单独作为现行完备性依据。通用调度、能力动态升级、站内研究、登录、
> 标签生命周期和新增验收由 follow_up 计划统一裁决；本文件其余已验证的基础能力继续有效。

## 0. 本轮边界、假设与完成标准

### 0.1 实施状态

- 2026-07-17 用户已确认并要求完整实施；Phase 0–7 对应的合同、实现、迁移和专项门禁已落入当前工作树。
- 模型可见工具已原子切换为 31 个语义工具；阅读核心固定 8 个，常见交互面固定 15 个，select/hover/drag 等低频能力按当前主指令追加。
- 浏览器原生可见性已在真实 Electron 中验证：指针跟随真实可信输入，BrowserView hide/show、标签切换、边界变化、租约终止和任务终态都会清理指针与提示。
- 已完成且只完成一次独立反向审查；16 项有效发现全部修复并以专项门禁、真实 SDK 路径和真实 Electron 证明回归。

### 0.2 已采用的产品假设

1. Ready 的目标不是做一个受限的网页阅读器，而是让 Agent 在用户授权的浏览器身份里，尽量无感地完成阅读、搜索、填写、上传、发布、下载、采集、研究和长任务。
2. 用户当前指令已经明确要求的普通浏览器动作，不重复弹确认。例如：登录既有账号、上传用户指定的文件、发布用户明确要求发布的内容、下载、采集、评论或发送用户明确要求发送的内容。
3. 只有不可逆、明显扩大权限或可能暴露秘密的动作才额外确认；验证码、滑块、Passkey、生物识别和安全拦截不由 Agent 绕过，改为用户接管后原任务续跑。
4. “完美避免平台风控”不能作为可证明承诺。可交付目标是：消除机器式爆发、重复提交、错误重试、跨标签串写等自造风险；使用真实浏览器会话和可信输入；识别限流或验证后及时降速、暂停和恢复。不得用伪造指纹或绕过访问控制来换取表面成功。
5. 工具全集可以丰富，但单个回合只暴露当前任务需要的工具。总工具数不是目标，模型每轮看到的噪声、完成回合数和真实成功率才是目标。

### 0.3 本轮实施收口条件

- 当前 54 个 Agent 浏览器工具全部有明确去向，没有遗漏项。
- 原计划的每个关键结论都被判定为“成立、部分成立、错误或需要改写”。
- 正常动作与真正高风险动作的边界明确，不靠模型自报效果，不靠域名一刀切。
- 小红书等高风控平台有真实任务验收矩阵，不以“加固定等待”冒充防风控。
- 可视鼠标指针和“Agent 正在控制”悬浮提示有完整状态、关闭、自动消失和真机验证合同。
- 阶段顺序、依赖、现有 gate 的扩展方式、真实 Electron 验收和失败回退标准明确。
- 不把需要专用外部测试账号的发布、评论、消息发送冒充为已完成验收；实现门禁和发布前外部验收分层管理。

## 1. 修订后的总判断

原计划找到了不少真实缺口，但把“安全”过多等同于“禁止”，也把“工具数量减少”误当成首要优化目标。修订后的结论是：

1. 54 个工具这一计数成立；真正问题是同一语义有多条模型可见路径、按描述文字自选主路、过时工具仍可暴露，而不是工具总数本身。
2. 目标不再是机械地从 54 个压到约 26 个。目标是保留 31 个完整语义能力，同时让普通阅读回合只见 8 个工具，普通交互回合只见 15 个工具，采集、诊断、Power 工具按当前主指令追加，且互不全量同开。
3. 不采用一个巨大的 browser_act 工具吞并点击、输入、拖拽、上传等所有动作。每个用户语义保留一个清晰工具，定位方式和底层兜底收进工具内部。
4. 小红书、抖音等平台不再因域名被永久禁止脚本或高级能力。站点域名只可作为初始风险信号，最终由真实页面状态、响应、验证墙、429、动作结果和站点经验共同决定策略。
5. 不采用全站固定随机抖动、全程逐字慢打或所有点击都故意变慢。最优方案是可信输入、单写者、页面就绪驱动、按动作类型和现场反馈自适应节奏；需要逐键事件的输入框才逐键，普通输入优先快速完成。
6. 正常 Power 观察和诊断不应因为审计存储短暂失败而全部失效。只有付款、远程删除、账号或凭据修改、秘密导出等高风险动作需要执行前的持久凭据和失败即拒绝。
7. “Agent 正在控制”悬浮提示确有生命周期缺口：当前窗口主动忽略鼠标，用户无法点击关闭；冻结或接管状态又可能在任务、租约已经结束后继续让提示存在。
8. 当前没有可视的 Agent 鼠标指针。它不应做成一个让模型调用的新工具，而应由真实动作执行器自动产生，确保用户看到的是 Agent 真正点击、拖拽和聚焦的位置。

## 2. 对原计划关键结论的逐项裁决

| 原结论 | 裁决 | 修订 |
|---|---|---|
| 54 个工具、重复簇过多 | 成立 | 逐个迁移，但按“一个语义一个工具”收口；不以总数为唯一 KPI |
| deprecated 工具仍可能暴露 | 成立 | browser_execute_js 与 browser_run_workflow 从模型目录和执行分支同时删除，不保留名称兼容层 |
| screenshot 返回的 image_id 主模型读不到 | 成立 | 改成真实图像结果；无视觉能力的模型走内部视觉分析，不再返回假可用 ID |
| page map 体积大、重复全扫 | 成立 | 建统一快照服务、文档 epoch、缓存、查找和一次内部刷新 |
| 所有写入都应逐字加随机抖动 | 方向错误 | 改成可信输入和自适应节奏；只在组件确实依赖按键事件时逐键 |
| 高风控域名应禁止所有脚本和 Power | 错误且与现合同冲突 | 删除域名硬禁；按代码推导的动作效果、当前任务范围和现场风险控制 |
| Power 依赖 expected_effects 自证 | 成立 | 从模型输入移除 expected_effects；效果由工具、CDP 方法、实时目标和输出通道共同推导 |
| 所有 Power 审计失败都应 fail-closed | 过度保守 | 普通观察、诊断记审计但不因审计故障阻断；真正高风险动作执行前必须有持久凭据 |
| 下载存在主进程 fetch、内存整包、任意目录等风险 | 成立 | 统一走浏览器 session 的流式下载；按 URL 来源和跳转链判断，不粗暴封死用户明确要求的 localhost 或内网站点 |
| 采集同意可被模型伪造 | 成立 | 移除 browser_confirm_collection_consent；用户应答只由真实 UI/问答卡进入状态机 |
| high_control_url_batch_downgrade 需要用户确认 | 不合理 | card_loop 或 url_batch 是内部实现选择，不应打断用户；系统自行择优并根据现场证据切换 |
| turn lease 过期后会卡死 | 成立 | 失效后原子清理并重取一次；所有 Agent 写入口都必须经过同一租约地板 |
| Power eval 没有单次超时 | 错误 | Power eval 已有单次超时；真实缺口是普通 executeJavaScript、工具总 deadline 和底层中止/恢复未统一 |
| page-map generation 能证明页面没变 | 错误 | 当前 generation 主要随读取递增；改成 tab + document epoch + snapshot revision，由导航和页面生命周期驱动 |
| 没有任何 dialog 处理 | 部分错误 | 文件选择器和站点权限已有处理；缺的是 alert、confirm、prompt、beforeunload 等完整对话框状态机 |
| 没有 cookie/session 管理 | 部分错误 | Settings 已有隐私清理能力；缺的是受控的 Agent 会话状态工具，不应直接把原始 cookie 当普通工具暴露 |
| 需要新增 verify:browser-surface | 错误 | package.json 已有该 gate；扩展现有 gate，不创建同名重复入口 |
| 缺标签页、前进、刷新、拖拽、归档 | 成立 | 纳入目标工具面和阶段验收 |
| browser_query_gemini 应泛化 | 成立 | 退出通用浏览器工具面，改为站点 skill 或内部策略 |
| 可视鼠标与悬浮提示问题 | 原计划遗漏 | 新增为 P1 产品闭环，必须做真实 BrowserView 叠层验证 |

主要代码证据：

- 工具目录：src/main/modules/tools/browser-tool-catalog.ts
- 暴露与 metadata：src/main/modules/agent-control/tools-runtime/tool-registry.ts
- 统一分发：src/main/modules/tools/browser-tools.ts
- 页面快照：src/main/modules/tools/browser-observe-tools.ts、src/main/modules/browser-engine/agent-browser-page-map.ts
- 租约：src/main/modules/browser-engine/agent-browser-turn-lease.ts、browser-write-lease.ts
- Power：src/main/modules/tools/browser-power-policy.ts、browser-power-tools.ts
- 下载：src/main/modules/browser-engine/browser-media-download.ts、download-service.ts
- 采集同意：src/main/modules/browser-engine/browser-collection-consent.ts、src/main/modules/tools/browser-collection-tools.ts
- 悬浮提示：src/main/modules/browser-engine/browser-lock-overlay-window.ts、src/renderer/pages/modes/BrowserMode.tsx、src/renderer/modules/browser/browserOwnershipStatus.ts
- 小红书历史真机问题：docs/superpowers/plans/2026-07-03-deferred-work-register.md

## 3. 目标架构合同

### 3.1 一个执行权威

所有模型工具、站点 skill、后台采集和恢复任务都必须经过同一个 BrowserActionExecutor。它依次完成：

1. 绑定当前 run、task、tab、surface 和文档 epoch。
2. 根据工具和实时目标推导动作效果。
3. 检查任务范围；仅真正高风险动作进入确认。
4. 获取或续租写租约；只读不抢写租约。
5. 在统一 deadline 和 AbortSignal 下执行。
6. 产出动作回执：执行前后 URL、目标身份、文档版本、页面结果、是否可能已提交。
7. 发布可视指针和悬浮状态事件。
8. 根据结果更新节奏、站点经验和恢复建议。

任何工具不得绕过该执行器直接对页面写入。Power 不是旁路，只是这个执行器的一组高级能力。

### 3.2 一个页面真值

建立 BrowserSnapshotService，取代各工具各扫一遍页面：

- 身份键为 tabId + documentEpoch；documentEpoch 在主文档导航、页内路由替换、标签销毁或重建时失效。
- 每次快照有 snapshotRevision；轻微 DOM 变化只标脏，不立刻全量重扫。
- target ref 绑定 tab、documentEpoch、frame、节点和可见语义；旧文档 ref 永远不能命中新页面。
- browser_find 在当前快照上查找，不为了筛一个目标重新扫描整页。
- 动作前验证 ref；若仅快照过期，内部刷新并重解析一次。唯一匹配则继续，仍歧义才返回候选，不让模型多绕一轮。
- iframe、开放/封闭 shadow host、React 委托点击、原生文件选择器和自定义元素都由同一解析器给出能力标记与升级路径。
- 默认返回紧凑的可访问结构和 refs，不再同时重复大段 text 与无上限 targets 数组。
- ToolExecutionOutput 扩成可携带文本、结构数据、图像和本地 artifact 的明确结果合同；各 provider 能否直接消费图像由共享能力层判断，不能再用一个只有缓存知道的 image_id 假装模型已看到图片。

### 3.3 一个可信动作通道

- 点击、双击、右键、悬停、滚轮、键盘、拖拽优先走 CDP Input 或等价的浏览器可信输入通道。
- 页面内脚本只负责观察、解析和必要的框架值同步，不用 isTrusted=false 的自造事件冒充用户动作。
- browser_type 支持 fast-fill 和 key-by-key 两种内部模式。普通输入先快填；富文本、快捷键、搜索联想或失败回退才逐键。
- 一次外部提交必须有提交前后回执。结果不确定时先核验，不自动重发，避免重复发布、重复评论或重复下单。
- 前台写动作按 origin 串行；只读可以在独立标签并行；后台长任务按任务预算和站点反馈调度。

### 3.4 分层暴露，而不是删能力

暴露层由当前用户意图、页面引用、附件、长任务状态和显式高级需求决定：

| 层 | 目标工具 | 暴露规则 |
|---|---|---|
| 阅读核心 | browser_tabs、browser_navigate、browser_search、browser_snapshot、browser_find、browser_read、browser_screenshot、browser_wait | 浏览器阅读任务常开，通常 8 个 |
| 交互核心 | browser_click、browser_type、browser_fill_form、browser_select、browser_hover、browser_scroll、browser_press_key、browser_drag、browser_upload、browser_dialog、browser_request_takeover | 只按任务需要追加；上传工具只在有附件/文件目标时出现 |
| 长任务 | browser_collect、browser_download、browser_archive、browser_task | 采集、下载、归档或已有可续跑任务时出现 |
| 诊断与高级 | browser_status、browser_console、browser_network、browser_resources、browser_eval、browser_cdp、browser_session、browser_permission | 明确诊断、复杂站点或恢复需要时出现；普通阅读不广告 |

工具数量是设计参考，不是强制固定值。强约束是：

- 层级、效果、所需附件、是否长任务、是否高级等标签只在 catalog 维护；observation、collection、batch 等暴露集合从 metadata 生成，不再手写多份工具名数组。
- 动态暴露修改 Codex 准入前的 Ready tool snapshot 与执行授权主链；不得只改 dormant SDK parity resolver，也不得复活 `AgentSdkRuntime`、direct-chat 或旧 turn engine。
- 常见阅读回合模型可见浏览器工具不超过 10 个。
- 常见单页交互回合为 15 个；低频交互、长任务和高级能力只按当前主指令追加。
- 不同时把采集全集、诊断全集和 Power 全集暴露给模型。
- 能力全集不能因压缩表面而丢失。

## 4. 现有 54 个工具的逐项去向

以下是原目录全覆盖映射。实施时必须由测试从 catalog 自动生成比对，防止人工表与代码再次漂移。

| 现有工具 | 目标去向 | 说明 |
|---|---|---|
| browser_navigate、browser_go_back | browser_navigate | action 支持 open、back、forward、reload；同属导航语义 |
| browser_search | browser_search | 保留高频复合能力，结果仍回到统一快照 |
| browser_get_tabs | browser_tabs | 支持 list、open、switch、close，并返回 opener 与绑定任务 |
| browser_read_page | browser_read | 读取正文、选区、目标或指定区域 |
| browser_read_page_map | browser_snapshot | 成为统一页面快照主入口 |
| browser_probe_readonly | 内部快照探针 | 不再单独广告；由 browser_snapshot、status、find 复用 |
| browser_click、browser_click_text、browser_act_on_target、browser_click_at | browser_click | 一个点击语义；locator 支持 ref、role/name、text、selector、coordinate；坐标只作最后兜底 |
| browser_type、browser_type_smart、browser_compose_message、browser_type_at | browser_type | 一个输入语义；内部选择快填、逐键、富文本和 submit |
| browser_send_keys | browser_press_key | 明确键盘/组合键语义 |
| browser_scroll_at | browser_scroll | 支持目标、容器、坐标与方向，内部判断是否滚动生效 |
| browser_capture_viewport、browser_analyze_viewport | browser_screenshot | 返回真实图像；需要时内部视觉分析，不再产生 write-only image_id |
| browser_probe_workflow_state | browser_status 或动作后内部回执 | 常规动作自动核验；诊断时才单独暴露 |
| browser_locate_action_targets、browser_locate_input_targets、browser_list_upload_targets | browser_find | 在统一快照上按用途查找，不再三套扫描 |
| browser_upload_scope_attachment | browser_upload | 支持单/多文件、文件夹、file chooser 和 drop zone |
| browser_collect_images、browser_extract_structured、browser_scroll_collect、browser_visible_collect、browser_collect_notes | browser_collect | 发现、冻结、深采、结构提取是同一长任务的内部阶段 |
| browser_download_urls、browser_download_collected_media、browser_download_gallery、browser_resolve_video、browser_media_download_advanced | browser_download | URL、当前页资源、采集结果和媒体解析由一个下载能力内部编排 |
| browser_inspect_resources、browser_power_resource_forensics | browser_resources | 普通资源概览与高级取证按参数和权限分级 |
| browser_wait、browser_wait_for_condition | browser_wait | 支持时间、页面状态、文本、URL、网络安静和自定义只读条件 |
| browser_start_task、browser_research_topic | 内部长任务规划器 | 不让模型手写 kind/payload；由 browser_collect、download、archive 启动 |
| browser_get_task、browser_resume_task、browser_cancel_task、browser_aggregate_results | browser_task | action 支持 get、resume、cancel、result；任务状态仍由持久层权威决定 |
| browser_ask_user_takeover | browser_request_takeover | 保留但绑定当前 task/tab/document，接管后可续跑 |
| browser_query_gemini | 站点 skill / 内部策略 | 退出通用工具目录，通用浏览器不能内置单站特例 |
| browser_run_workflow、browser_execute_js | 删除模型工具与旧名称执行分支 | 不保留兼容别名；复杂语义动作由执行器编排，必要脚本走 browser_eval |
| browser_power_eval | browser_eval | 按当前 tab、world、代码推导效果和结果出口执行 |
| browser_power_cdp | browser_cdp | 按 CDP 方法表推导效果；敏感方法不能靠 expected_effects 自证 |
| browser_power_network_trace | browser_network | 网络列表、详情、时间线与 trace 统一 |
| browser_power_script_run | 内部动作编排器 | 不让模型再拥有第二套 workflow DSL |
| browser_stage_site_strategy | 内部站点经验暂存 | verifier 接受前不得进入 active 站点策略 |
| browser_confirm_collection_consent | 删除模型工具 | 真实 UI 应答进入状态机；内部策略切换不再向用户索要“同意” |

新补的语义能力：

- browser_fill_form：一次填多个明确字段，减少多回合和重复快照。
- browser_select、browser_hover、browser_drag：覆盖下拉、悬停菜单、排序和画布交互。
- browser_dialog：处理 alert、confirm、prompt、beforeunload；文件选择器沿用已有专用链。
- browser_archive：保存 PDF、MHTML、HTML 或正文 Markdown。
- browser_console、browser_network：补齐现代网页诊断所必需的 console 与 network 可见性。
- browser_session：只按需提供当前 origin 登录态概况、清理站点数据、选择用户创建的浏览器 profile；原始 cookie/令牌导出不是普通读操作。
- browser_permission：处理当前 origin 的位置、通知、剪贴板等权限；摄像头、麦克风、屏幕共享、Passkey 等需用户在场的能力走接管。

## 5. 最小打断的授权与安全边界

### 5.1 默认直接执行

只要当前用户指令已经包含该目标，下列动作不再额外确认：

- 打开、搜索、阅读、滚动、点击、填写普通表单。
- 使用 Ready 浏览器现有登录态；填写用户本轮明确提供或选取的账号信息。
- 上传用户点名的附件或文件。
- 下载、采集、保存和归档用户要求的内容。
- 发布、评论、发消息、提交普通表单，只要“执行提交”就是用户当前任务，而不是仅让 Agent 写草稿。
- Cookie 同意、无害 alert、为当前明确导航处理 beforeunload。
- 为完成当前任务调用只读 eval、DOM/AX 观察、console、network、资源诊断。

“是否提交”首先是任务语义问题，不应靠按钮文字正则猜测。用户说“帮我发出去”就直接发并核验；用户说“帮我写一版”则停在草稿。

### 5.2 只在真正需要时确认或接管

| 动作 | 处理 |
|---|---|
| 付款、下单最终确认、转账 | 新鲜确认；需要硬件/银行验证时用户接管 |
| 删除云端数据、删除账号 | 新鲜确认并绑定具体对象 |
| 修改密码、恢复方式、权限成员 | 新鲜确认并绑定账号/对象 |
| 导出 cookie、令牌、密码或其他秘密 | 用户必须明确提出，二次确认，限定目标与保存位置 |
| 清除站点数据或切换会话身份 | 用户明确提出则执行；否则不自动做 |
| 图形验证码、滑块、人机验证、安全拦截 | 不绕过；立即暂停该 origin 写动作，用户接管，完成后同一任务续跑 |
| 用户提供的短信/邮箱验证码 | 可在明确登录流程中填写；它不等同于绕过 CAPTCHA |
| 摄像头、麦克风、屏幕共享、Passkey、生物识别 | 用户在场接管 |

### 5.3 代码拥有权限，模型只做语义判断

- 工具参数中删除 expected_effects 和 confirmed_via 一类自证字段。
- 效果由工具名、动作、实时目标、CDP 方法、网络出口和文件目标共同计算。
- 用户意图形成绑定当前消息、资源、对象和 run 的 BrowserTaskEnvelope；模型可做语义分类，但不能在后续工具参数里自行扩大范围。
- 页面文字、网页脚本或第三方 prompt 永远不能扩大 BrowserTaskEnvelope。
- Power setting 表示允许高级能力被按需选用，不表示所有高级动作全回合无条件放行。

## 6. Power 与脚本能力：强大但不旁路

### 6.1 删除域名脚本黑名单

当前 highControlScriptGuard 把小红书、抖音、微博等域名上的多类脚本能力直接拒绝，但旧 Power 转发路径又可绕过它。继续补黑名单只会同时得到“能力不够”和“规则不一致”。

目标做法：

- 域名只影响初始节奏和观测强度，不决定某个工具能否存在。
- 高级能力由本轮真实任务需要或用户显式 Power 设置按需出现，不再用几个关键词正则把整个 Power 集合一次性解锁。
- browser_eval 默认在隔离世界或只读模板执行；确需 main world 时由动作效果和任务范围决定。
- browser_cdp 使用代码维护的方法到效果映射。例如 Network.getAllCookies、Storage.getCookies 属于 secret_export，不能伪装成 observe。
- eval/cdp 的网络请求、秘密读取、跨 origin 写入和下载出口都进入同一效果判定。
- 小红书可使用必要的结构读取、shadow host 识别、框架同步和可信点击升级，不再因为“平台名”先天残废。
- 不提供 CAPTCHA 求解、指纹伪造、访问控制绕过能力。

### 6.2 审计分级

- 普通 observe、console、network、只读 eval：记录完整动作摘要和结果；审计短暂失败不应让用户任务整体失败。
- page mutation、upload、download、external submit：必须有动作回执，保证结果可核验和避免重复。
- payment、remote delete、account/credential change、secret export：执行前持久记录用户确认、对象、run、tab、document、效果和代码/参数 hash；写入失败即拒绝。
- 审计不是授权来源；授权来自当前任务范围和真实确认。

## 7. 下载、采集与长任务

### 7.1 统一下载链

删除主进程裸 Node fetch 兜底，统一使用 Ready 浏览器 session：

- 自动带当前登录态、代理、Referer 和浏览器网络策略。
- 流式写入临时文件，校验大小、类型、hash 后原子改名；不把整个文件读进内存。
- 默认不覆盖同名文件，断点和重试必须识别是否已写入。
- 每个任务有磁盘余量和总字节预算，但预算来自用户目标、可用磁盘和任务设置，不为“小红书”硬塞一个低上限。
- 跟踪完整跳转链。用户明确访问的 localhost、内网和当前登录站点可以工作；从公网 URL 静默跳到 loopback、link-local 或无来源内网地址时拒绝并说明。
- 输出目录只能来自用户选取、当前 workspace/resource 或 Ready 默认下载目录；模型自己编一个绝对路径不构成权限。
- blob、data、媒体分片等资源仍在当前页面/session 上解析和下载，不能回退到无会话裸请求。

### 7.2 采集不再把内部策略变成用户门槛

- visible discovery、目标冻结、逐项深采、媒体下载、结果聚合是 browser_collect 的内部阶段。
- card_loop 与 url_batch 由系统根据页面路由、当前会话、历史成功率和验证信号自行选择；不再要求用户确认“允许降级”。
- 如果任务要求全量，系统能继续就自动 resume；达到可证明终点才完成。
- 只有确实无法继续且准备交付部分结果时，才用 ask_user_questions 询问用户是否接受部分结果。模型没有确认工具，UI 应答直接绑定 pending question 和 source task。
- checkpoint 必须保存目标清单、当前游标、失败分类、输出 hash、tab/document 绑定和下一步；恢复不得重复下载或重复外部提交。
- 取消与终态写入使用版本/CAS，cancelled 不得被迟到的 completed 覆盖。

## 8. 高风控平台的正确工程方案

### 8.1 不做“随机拟人”，做交互真实性与自适应节奏

- 同一 origin 的写动作默认串行；独立标签的只读研究可有限并行。
- 点击有真实的 move、press、release 序列；拖拽有真实 drag path；输入根据组件需要选择 fast-fill 或逐键。
- 等待由 DOM/AX 可交互、网络、路由和目标状态驱动，不靠每一步固定 sleep。
- 对 429、Retry-After、challenge、登录墙、空壳页面、重复跳转、点击无效和加载异常分别分类。
- 命中限流后按 origin 冷却；命中安全验证后停止该 origin 的所有写动作，不继续试探。
- 站点经验只从成功/失败回执和 fresh verifier 接受的策略更新；网页内容不能直接写 active 规则。
- 固定 3 秒 interNoteDelay 和平台正则硬上限改为可测的 OriginInteractionBudget；它读取现场信号并可恢复，不是域名永久标签。

### 8.2 小红书真机验收矩阵

在专用测试账号和可撤销内容上验证，不用真实用户重要数据做破坏性试验：

1. 复用已有登录态，搜索关键词，打开列表和详情，返回列表后继续。
2. 主页无限滚动发现目标，冻结全量清单，逐篇恢复采集，不丢项、不重复。
3. 详情页读取标题、正文、标签、图片和视频资源；处理 custom element、closed shadow host 和 React 委托事件。
4. 下载多图和视频，验证文件数量、类型、hash、失败重试和磁盘中断恢复。
5. 发布图文：多图上传、拖拽排序、标题/正文/标签填写、预览、用户明确要求时最终发布、发布后回读 URL/标题证明成功。
6. 评论、私信或普通外部提交：明确要求时直接完成；提交结果不确定时先查证，绝不盲目重发。
7. 文件选择器、站点位置权限、弹窗、新标签、返回和刷新不会让任务失去 tab 绑定。
8. 注入 429、加载失败、验证墙和登录过期：系统降速或暂停，不继续爆发动作；用户接管后在同一 checkpoint 续跑。
9. 用户在 Agent 控制中即时接管：Agent 立即失去写权，旧动作不能迟到落下；恢复后重新绑定当前页面。
10. 连续运行中悬浮状态和鼠标位置与实际动作一致，任务结束后自动消失。

验收不写“零风控”这种无法证明的结论，而写以下可测结果：

- 测试期间没有由重复提交、并发写、无界重试、错误 tab、固定爆发或失效 lease 导致的自造异常。
- 检测到 challenge 后不再发生页面写入。
- 普通小红书任务不因域名被拒绝 eval、结构读取或可信输入升级。
- 正常任务没有多余的“高风控策略确认”卡。

## 9. 可视鼠标指针与控制悬浮提示

### 9.1 可视鼠标不是模型工具

新增 BrowserAgentPointerOverlay，由 BrowserActionExecutor 的真实动作事件驱动：

- 只在用户当前可见的 BrowserView 和当前被 Agent 控制的 tab 上显示。
- 显示真实移动位置、点击涟漪、拖拽轨迹和输入焦点；后台隐藏标签只在任务卡显示进度，不伪造鼠标。
- 坐标使用动作执行时的 CSS viewport 坐标，经 BrowserView bounds、zoom 和设备缩放换算；不直接相信模型随手给出的坐标。
- 全窗口 click-through，永远不挡网页点击。
- 最后一个动作后短暂淡出；任务结束、租约丢失、用户接管、BrowserView 隐藏或 tab 切换时立即清除。
- 动画不能为了“看起来像人”拖慢真实任务；实际输入轨迹和可视插值共享事件，但界面绘制不反向阻塞动作。

### 9.2 悬浮提示修复合同

当前 browser-lock-overlay-window 使用 focusable:false 且 setIgnoreMouseEvents(true)，所以用户无法关闭；renderer 又可能仅凭 frozen/takeover 状态继续显示。

目标状态机：

| 状态 | 提示 |
|---|---|
| 无 active task、无有效写租约 | 隐藏 |
| Agent 正在当前可见 tab 写入 | 显示“Agent 正在控制” |
| 等待用户接管 | 显示“等待你操作”并给出接管入口 |
| 用户已接管 | 显示不超过 1 秒的确认后隐藏 |
| task completed/failed/cancelled 或 lease lost | 显示不超过 1 秒的结果后隐藏 |
| 用户点击关闭 | 立即隐藏当前状态版本；不停止任务、不释放租约，新任务或新的接管状态可再次出现 |
| 状态推送丢失 | 由 active task + lease TTL 兜底硬隐藏 |

实现边界：

- 状态提示保持小型原生子窗口，可接收关闭按钮点击但不抢键盘焦点。
- 鼠标指针使用独立、全尺寸、完全 click-through 的叠层，避免为了让关闭按钮可点而让整块透明层拦住网页。
- “关闭提示”和“接管浏览器”是两件事。关闭只影响显示；接管才改变写权限。
- 悬浮状态只从 Main 的 active task、lease、surface binding 和 takeover 权威组合，不从 renderer 猜测。

验收：

- completed、failed、cancelled、lease lost、takeover accepted 五条终态均在 1 秒内消失。
- 关闭按钮即时生效，新任务能重新出现。
- Retina、缩放、窗口移动、侧栏变化、BrowserView hide/show 后指针位置仍准确。
- 扩展现有 verify:browser-native-lock 和 live proof，不以源码 grep 代替真机叠层验证。

## 10. 可靠性与效率缺口清单

| ID | 严重度 | 缺口 | 最优处理 | 验收 |
|---|---|---|---|---|
| R1 | P0 | 模型可调用 browser_confirm_collection_consent 自证同意 | 删除工具；UI 应答直写绑定 question/task 的状态 | 伪造 requestId/confirmed_via 永远失败 |
| R2 | P0 | 裸 fetch 下载可绕 session、整包进内存、路径过宽 | 统一 session 流式下载和来源/跳转/目录合同 | 大文件不爆内存；意外公网到本地跳转被拒；明确内网任务可用 |
| R3 | P1 | Power 效果由 expected_effects 自报 | 代码按工具、CDP 方法、目标和出口推导 | 少报效果不能放宽权限 |
| R4 | P1 | 域名脚本硬禁与 Power 旁路并存 | 删除域名硬禁，所有能力经过统一效果判定 | 小红书必要脚本可用；秘密导出仍受控 |
| R5 | P1 | lease 过期后本回合永久卡死 | 清理旧 lease 并原子重取一次 | 假时钟跨 TTL 后可继续写 |
| R6 | P1 | 部分写路径可无 lease gate | BrowserActionExecutor 成为所有写入口 | catalog 中每个 write 工具都有 gate 证明 |
| R7 | P1 | 普通 executeJavaScript、工具总时限和中止未统一 | deadline 贯穿 tool、controller、CDP、长任务 round；超时后恢复/隔离卡页 | 卡死页面不拖死 run，底层迟到结果不再落状态 |
| R8 | P1 | generation 不等于文档版本 | documentEpoch + snapshotRevision + live ref 验证 | 导航后旧 ref 必为 stale |
| R9 | P1 | selector 合成事件与 CDP 可信输入双轨 | 写入统一走可信动作通道 | 依赖 isTrusted/React tracker 的夹具通过 |
| R10 | P1 | cancel 与迟到终写可能互相覆盖 | 版本/CAS 终态写入 | cancelled 不会翻回 completed |
| R11 | P1 | JS dialog 可阻塞动作链 | 完整 dialog 状态机和 deadline | alert/confirm/prompt/beforeunload 均有确定结果 |
| R12 | P1 | 标签、新窗、拖拽、前进、刷新缺失 | 新语义工具并绑定 tab/task | 多标签研究与小红书多图排序真机通过 |
| R13 | P1 | 悬浮提示粘住且不可关、无可视指针 | 第 9 节双叠层与权威状态机 | 五种终态自动消失、关闭可用、指针准确 |
| R14 | P2 | page map 重复大结果、targets 无统一预算 | 统一 snapshot/find/cache，紧凑响应和分页 | p95 输入字节至少较基线下降 50%，目标召回不退化 |
| R15 | P2 | capture_viewport 返回不可消费 ID | 真图像块或内部视觉分析 | 模型能实际看见/理解截图 |
| R16 | P2 | locate/probe/action 反复扫 DOM | 同一 snapshot 上查找，动作最多一次内部刷新 | 常见定位点击不再需要模型二次读图 |
| R17 | P2 | 固定 3 秒节奏、无现场反馈 | OriginInteractionBudget + 429/challenge/结果回执 | 429 遵循 Retry-After；challenge 后零写入 |
| R18 | P2 | 错误既有裸字符串也有误分类 | 统一结构化错误、参数错与目标错分离 | 每类错误有唯一恢复建议 |
| R19 | P2 | cookie/session 只有 Settings 能处理 | 按需 browser_session，默认不暴露原始秘密 | 清理当前 origin、profile 切换与登录态判断可测 |
| R20 | P2 | console/network/archive 缺失 | 补诊断和页面归档语义 | SPA 故障诊断与 PDF/MHTML/MD 归档通过 |
| R21 | P3 | catalog、schema 注释、handler 归属漂移 | 由 catalog 生成清单测试，handler 按语义重组 | 文档、schema、目录数量一致 |
| R22 | P2 | observation/collection/batch 暴露名单手工重复，意图主要靠正则 | catalog metadata 生成分层集合；模型做语义判断，代码绑定能力范围 | 新增工具只改一处 catalog；上下文词不再误开整组能力 |

## 11. 分阶段实施

每阶段都有硬 gate。前一阶段没过，不进入下一阶段。

### Phase 0：合同与基线

目标：先把“什么算成功”写成机器能判的合同。

- 已知基线缺口：2026-07-17 实跑 npm run verify:browser-surface 时，前三项中的 P7c4 静态检查被未改动的 outputs/agent-audit/fix-plan/00-ROADMAP.md 身份隔离表述拦住；其后的 23 个 Node 合同和 81 个 TypeScript 合同单独运行均通过。Phase 0 必须先纠正该既有文案或检查器语义并恢复总 gate，不得把它当成豁免，也不得误称当前总 gate 已绿。
- 扩展现有 verify:browser-surface，加入按意图暴露集合、deprecated 永不暴露、常见回合工具数量上限和能力地板。
- 扩展 verify:browser-reliability，加入 snapshot 大小、旧 ref、动作回执、dialog、下载和取消竞态。
- 扩展 verify:browser-native-lock，覆盖提示关闭、自动消失、指针坐标和 BrowserView 生命周期。
- 录制四类基线：阅读、普通填写并提交、附件上传发布、长采集下载。记录工具调用数、模型回合数、快照字节、完成时间和失败原因。
- 新增浏览器工具清单生成测试，确认当前 54 项与第 4 节一一对应。

Gate：只新增/修订合同，不改变运行时行为；先关闭上述既有 P7c4 基线缺口，再证明 verify:browser-lane、surface、reliability、native-lock 全部为绿。

### Phase 1：先关闭现有高风险旁路与粘滞状态

- 删除 browser_confirm_collection_consent 的模型暴露和执行入口；移除 high_control_url_batch_downgrade 的用户确认流程。
- 删除裸 Node fetch 下载兜底，建立 session 流式下载最小闭环。
- 移除 expected_effects 的授权作用；先覆盖 cookie/secret 相关 CDP 方法。
- 修复 lease 过期重取、cancel 终态版本守卫、统一 browser deadline 的接线。
- 修复悬浮提示的 active task/lease 退出条件、自动消失和手动关闭。

Gate：R1、R2、R3、R5、R7、R10、R13 对应回归通过；涉及持久化跑 npm run verify:native。

### Phase 2：统一 BrowserActionExecutor

- 所有 model tool、后台采集和站点 skill 的写动作迁到同一执行器。
- 统一 tab/surface/document 绑定、租约、效果推导、deadline、AbortSignal、动作回执和恢复。
- 建立可信 click/type/scroll/key/upload/drag 基元。
- 建 dialog 状态机；已有 file chooser guard 和 site permission 流程接入同一动作会话。
- 删除直接写页面的旁路；不得保留 legacy 执行分支。

Gate：写工具全部有单写者证明；用户接管后旧动作不能落下；提交不确定时不会重复提交。

### Phase 3：统一 Snapshot 与 Ref

- 建 BrowserSnapshotService、documentEpoch、snapshotRevision、紧凑 refs、缓存和 browser_find。
- iframe、shadow host、custom element、React 委托与坐标兜底统一进 target resolver。
- screenshot 接真实图像输出；provider 无视觉能力时走内部视觉分析。
- 动作最多做一次内部快照刷新；仍歧义才回模型。

Gate：旧 ref、导航、页内路由、frame、shadow、超长页面和截断尾部按钮夹具全部通过；快照 p95 字节较 Phase 0 至少下降 50%，成功率不退化。

### Phase 4：模型工具面原子切换

- 按第 3、4 节建立新 catalog 和按意图暴露层。
- observation、collection、batch、advanced 集合全部从 catalog metadata 生成，删除共享层手工名称白名单。
- 在 Codex 准入 tool snapshot 与 Ready executor 权威点完成曝光和执行接线；`AgentSdkRuntime` / SDK parity 路径只同步合同，不冒充生产证明。
- 同一变更中迁完内部调用方、测试和 prompt，然后删除旧工具定义与旧名称 handler。
- 不保留 browser_execute_js、browser_run_workflow 或其他旧名兼容分支。
- browser_query_gemini 移到站点 skill；browser_stage_site_strategy 留内部。

Gate：现有 54 项全部被新目录、内部能力或删除合同接住；常见回合工具数符合上限；无 deprecated 泄漏。

### Phase 5：自适应节奏、可视指针与高风控站点

- 建 OriginInteractionBudget，接入 429、Retry-After、challenge、登录墙、空壳页、动作失败和站点经验。
- 移除固定平台 3 秒节奏和域名脚本黑名单。
- 接入可视鼠标、点击涟漪、拖拽轨迹、输入焦点和终态清理。
- 小红书 card loop、详情采集、媒体下载、图文发布、拖拽排序、评论/消息和接管恢复逐项建立合同与本地夹具；原生指针、控制提示、BrowserView 生命周期用真实 Electron 验证。

Gate：实现交付必须完成全部本地合同、夹具与真实 Electron BrowserView 证明；第 8.2 节中会创建外部内容的用例，只能在明确的专用测试账号和可回滚测试内容上执行，属于发布前验收，不得为了给源码实施“补证据”而擅自发布、评论或发消息。

### Phase 6：广泛适用能力补齐

- tabs/new window、forward/reload、console/network、archive、session/profile、origin permission。
- 长任务的完整/部分结果决策、断点恢复、磁盘预算和输出验证收口。
- 对需要站点特例的能力只建 skill/strategy，不向通用 catalog 回填站点名工具。

Gate：多标签研究、SPA 故障诊断、页面归档、登录态切换、内网站点下载和长任务恢复完成真实验收。

### Phase 7：总回归与文档收口

- 运行 npm run typecheck、npm run verify:browser-lane、npm run verify:browser-surface、npm run verify:browser-reliability、npm run verify:browser-native-lock、npm run verify:native 和受影响的完整 verify。
- 在真实 Electron 中复测 BrowserView hide/show/bounds、弹窗、下载、悬浮层、用户接管和恢复。
- 只更新受影响的单一权威入口：docs/architecture/current-runtime-contracts.md、测试约定和工具目录；不把阶段记录重复回填根指引。
- 对运行指标做 Phase 0 前后对比；若回合数、成功率或完成时间明显退化，不以“更安全”为理由强行通过。

## 12. 已定设计决定

用户批准本计划即表示接受以下决定；若不同意，可在开发前直接修改本节：

1. 正常浏览、上传、下载、采集、发布、评论和消息发送，只要用户当前任务已经明确要求，就不重复确认。
2. 付款、远程删除、账号/凭据修改和秘密导出仍需要确认；CAPTCHA、安全拦截和硬件验证由用户接管，不做绕过。
3. 删除小红书等域名的脚本硬禁，改为统一效果判定和现场自适应。
4. 不追求固定总工具数；追求普通阅读 8 个、普通交互 15 个且完整能力不丢失。
5. 不做一个包办一切的巨型 act 工具；保留清晰的 click、type、drag、upload 等语义工具。
6. 旧工具名称在原子迁移后直接删除，不保留兼容分支。
7. 可视鼠标默认对用户当前可见的 Agent 操作开启；后台任务不显示假鼠标。
8. 悬浮提示可手动关闭，且所有终态自动消失；关闭提示不等于夺回控制权。
9. card_loop、url_batch 和其他采集策略由系统自行选择，不再让用户批准内部实现细节。
10. Agent 不获得普通的全量 cookie 导出工具；明确的秘密导出需求走高风险确认。

## 13. 外部校准依据

- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)：采用 snapshot 驱动，并把 click、type、hover、drag、dialog、tabs 等保持为清晰语义工具，支持本计划“一个语义一个工具、定位策略内部化”的方向。
- [Chrome DevTools Protocol Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)：提供 mouseMoved、mousePressed、mouseReleased、mouseWheel、drag 与键盘输入等可信动作基元，支持统一输入和可视指针事件源。
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents/)：提供导航生命周期、页内导航、capturePage、savePage 等能力；其 executeJavaScript 在页面加载期间可能被挂起，支持本计划建立 documentEpoch 与统一 deadline 的必要性。

## 14. 最终完成定义

开发完成不是“新工具能调用”，而是同时满足：

- 普通用户指令从开始到完成不被不必要确认打断。
- 复杂站点需要的高级能力可用，不因平台域名被一刀切禁用。
- 所有写动作只有一个权威入口、一个当前 tab/document、一个写租约和可核验回执。
- 旧 ref、超时、取消、接管、弹窗、下载中断和任务恢复不会产生迟到写入或重复提交。
- 小红书采集、下载、发布、拖拽、评论/消息与接管续跑有完整本地合同；会改变外部账号状态的真机项另纳入专用测试账号的发布前验收。
- 用户看得见 Agent 真正操作的位置，悬浮提示能关闭且会自动消失。
- 常见回合工具面和快照体积显著下降，但能力、成功率和完成时间不退化。
- 所有专项 gate、native gate、真实 Electron 验收和独立反向审查通过后，才把计划状态改为 completed。

## 15. 2026-07-17 实施证据

已落地：

- 本计划完成时公开目录为 31 个语义工具；自 2026-07-18 起由 `2026-07-17-browser-agent-site-research-and-tool-contract-repair-implementation.md` 覆盖为 32 个，并新增独立 `browser_research`。旧名称的 schema、模型暴露和执行 handler 仍保持退役。
- BrowserActionExecutor 统一负责工具解析、写租约、origin 节奏、deadline、中止、动作生命周期和结构化失败；Power 效果不再由模型自报。
- BrowserSnapshotService 提供文档身份、紧凑快照、缓存、污标、不透明 ref 与一次重绑；默认页面地图预算从 32 KiB 收紧为 16 KiB。
- 点击、输入、按键、滚动和拖拽使用可信浏览器输入；对话框、下载、会话/profile、权限、console/network、归档、长任务检查点与恢复已补齐。
- 采集同意只由真实 UI 应答写入；租约过期、接管、取消和迟到终态均有原子保护。
- 原生指针与可关闭控制提示分为两个独立子窗口；指针窗口不接收鼠标，提示窗口可关闭且不抢键盘焦点。

验证记录：

- `npm run build`：通过。
- 实施初验 `npm run verify`：通过；主测试 7550 条（0 失败），串行子任务测试 157 条（0 失败），串行性能测试 11 条（0 失败）。
- `npm run verify:browser-lane`、`verify:browser-surface`、`verify:browser-reliability`、`verify:browser-native-lock`、`verify:native`：通过。
- 反向审查修复后，上述浏览器专项、受影响的 SDK/能力裁决测试、研究工具专项、类型检查、原生依赖检查和生产构建全部再次通过。
- 真实 Electron 证明：`outputs/agent-audit/live/2026-07-17-stage1-browser-native-overlay-report.json`，包含指针位置、关闭/终态、BrowserView hide/show 清理与恢复、活动标签保持和原生窗口几何检查。
- 反向审查后的整库重跑已证明浏览器相关失败归零；剩余失败只来自同一工作树中尚在推进的第二阶段文档性能与文件解析切片，统一在第二阶段终验清零后再跑最终 `npm run verify`，不把它们误记为阶段一通过或阶段一回归。

### 15.1 唯一一次独立反向审查闭环

独立审查任务 `/root/stage1_adversarial_review` 共提出 16 项有效问题，未再启动第二个阶段一审查者。全部处置如下：

1. 最终 SDK 工具面改为普通阅读 8 个、普通交互 15 个；长任务和高级工具只认当前主指令，历史摘要、页面文字和 reference skill 均不能解锁。
2. 混淆脚本与未知 CDP 方法按高权限效果失败关闭，不再把模型自报的只读效果当授权。
3. 新增代码拥有的 BrowserTaskEnvelope，绑定 scope、run、task、tab、origin 和允许操作；session/permission 等状态改变不能脱离当前任务。
4. Power 确认可在生产路径签发一次性精确 grant，绑定文档、对象、主机、目标和效果；缺任一绑定即拒绝。
5. 超时后先等待底层取消收口；不合作的写操作继续占有写窗口，迟到动作不能在用户接管后偷跑。
6. 下载与归档接入取消和临时文件清理，取消后不允许迟到重命名；删除 cwd、根目录和 home 的过宽写入授权。
7. 前后台采集的导航、滚动和写入共用同一租约边界；进程重启时只对 idle/expired 的旧租约原子重取，takeover 仍保持暂停。
8. browser_fill_form 首个字段失败即停止，未全部成功绝不提交；提交动作本身失败也不会谎报完成。
9. browser_read 实际执行 target、selector、stale-ref 与 max_chars 合同，歧义和过期均返回结构化结果。
10. browser_screenshot 在 analyze 模式下仍返回真实图像，缺省为通用分析，并保留 mode/clip。
11. 风控预算只接受结构化挑战信号和同源真实 429/Retry-After；普通页面文字不能永久锁站，只有用户明确完成接管才清除挑战。
12. 控制提示和指针由 Main 的动作/租约/任务终态驱动；接管、取消、失败、结束、BrowserView hide 都会清理，关闭按钮只隐藏提示、不伪造接管。
13. 指针按页面 zoomFactor 换算且不重复乘 Retina 比例，覆盖 0.72、1、1.25、2。
14. browser_tabs 返回 opener、root tab、owner/activity、前台 workflow 和写租约归属，避免 popup 或多任务选错标签。
15. browser_permission 按显式 tab 解析 origin 并与任务信封精确比较，不再误改活动标签权限。
16. Research 门禁改认 browser_collect 并明确拒绝已退役旧名；同时修复 TaskType 检查器的旧六项复制名单，改读共享唯一真值。

发布前外部验收：

- 小红书等平台的真实发布、评论、私信、账号安全验证未在本次源码实施中擅自执行。发布前应用专用测试账号、可删除的测试内容和明确的外部动作授权完成第 8.2 节的可变更项。
