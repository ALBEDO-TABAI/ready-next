# Ready 当前运行时硬合同

> 更新时间：2026-07-19
> 本文承接原先重复写在 `AGENTS.md` 与 `CLAUDE.md` 里的详细约束。两份根指引保留入口与红线；修改本页覆盖的模块前必须读取对应章节。

代码、类型、行为测试和 CI gate 比本文更权威。若实现与本文冲突，先判断是实现回归还是文档漂移；不得为旧文档复活已退役路径。

## 1. 应用壳、CSS 与原生窗口

- `src/renderer/main.tsx` 保留 bootstrap 级错误兜底；`src/renderer/App.tsx` 保留 `/workbench` 与 `* -> /workbench` fallback。
- Renderer 的通用 `*` reset 必须位于明确的 `@layer base`。禁止在层外重置通用 `margin` / `padding`；回归入口是 `scripts/check-css-cascade-layer-reset.cjs`。
- 代码文件只要净增行数，收尾前就检查总行数。超过 1000 行按“危险 / 一般 / 健康”更新 `docs/code-health/large-file-health-log.md`：健康无需动作，一般写复查日期，危险在最终回复提醒。生成物、锁文件和 vendored 第三方文件不计，但生成器源码仍计。
- BrowserView 是原生覆盖层，不受 DOM `z-index` 控制。任何 primary、secondary、关闭分栏或卸载转换只要让 Browser 离开可见 mode 集合，都必须先经 `hide-all` intent + 匹配 ack，再提交 DOM mode；恢复后按稳定 bounds 显示。文件打开使用同一协调入口，但只保留这段正确性等待，不串行等待 ritual 或场景滑动。
- 聊天输入框液态玻璃只以真实 Electron dev 为验收面；`#/liquid-test` 只用于调参。生产输入框不得加外部暗色阴影或静态截图贴片，消息末尾必须按浮层实测高度留白。
- Windows 顶部 chrome 保留系统最小化、最大化、关闭按钮；Ready 圆点在左上，中心按 `WORKBENCH_EDGE_RAIL_SLOT_INSET_X + WORKBENCH_EDGE_RAIL_SLOT_SIZE / 2` 与左轨槽位对齐（当前 25px）。`titleBarStyle: 'hidden'` + `titleBarOverlay` 负责同层背景，Mica 只能是有普通背景 fallback 的增强。
- 窗口截图必须从 Main 捕获完整 `BrowserWindow` 合成面，不得只截 Renderer DOM 而遗漏 BrowserView。PNG 的窗口主体必须完全不透明；普通 macOS 窗口补齐原生窗口按钮，只在四角外侧保留透明抗锯齿圆角；全屏/最大化不强行裁圆角。快捷键指南与实际解析器共用 `src/shared/app-shortcuts.ts` 的单一目录。

## 2. 会话、资源与工具面

- 会话 scope 按“来源频道 + 线程或本地 conversation + agent”隔离；工具日志只进入运行态或胶囊层，不混入正文消息。
- 飞书或远程图片、文件先进入会话资源层，不自动触发 Agent；后续任务必须显式选择资源。
- 系统提示词分为版本化常驻核心、按需领域/产品资料和每轮运行时事实。常驻核心的唯一来源是 `assets/prompts/core/ready-system.md`，常规 scoped run 与默认/fallback 入口必须复用同一加载器；`assets/prompts/product/about-ready.md` 只在用户询问 Ready 开发、协作背景或关注渠道时进入 L2，普通任务不得主动宣传。
- `TOOLS.md` 不进入 L0，也不代表授权；本轮最终工具定义是模型可调用能力的唯一事实。默认 `USER.md` 不得伪造未确认偏好；用户画像、记忆、人格和历史只能作为低于当前用户指令与代码边界的上下文。
- scoped run 的用户画像只由当前 scope 的 `userId` 读取；无绑定的本地会话回落 `default-user`，无绑定的远程会话不得读取本机档案或 `USER.md`。长期偏好、沟通风格和 Agent tone 必须经共享格式器进入生产提示；用户画像、人格和运行指令拥有 L0 保留预算，不能被增长的常驻记忆从尾部裁掉。已保存的回复风格还必须以版本化末端提醒成为 provider instructions 最后一块，且只出现一次；地域/人物气质标签是表达要求，不是真实身份声明。它只影响面向用户的自然语言，不得改写引用、代码、工具参数、权限或事实标准。
- 每轮日期事实使用应用所在系统的本地日历日期与星期，同一格式器同时服务运行时提示和每日记忆文件；不得用 UTC 日期与本地星期拼接出跨日矛盾。
- 显式技能引用与本地文档资源产生代码级 capability floor。收窄过滤只能做减法，不得移除地板；最终工具面必须非空且包含全部地板。
- `current_document_context` 的地板是文档编辑面：read section、Widget 增删改查、replace exact、save tab；刻意不含整文覆写。`local_document_resource` 保持只读，提及文件不等于授予写权限。
- capability floor 的 live 权威点是 SDK executor 计算/补回工具，以及 turn orchestrator 收窄后的最终强制。违反要记录 `tool_surface_floor_violation` 或 `sdk_runtime_empty_surface_recovered`。
- SDK executor 的同一份 `CapabilityResolution` 必须同时驱动工具面与本轮能力冲突事实。只有用户或任务意图明确请求、但最终组状态不可见的能力进入 `requestedButSuppressed`；默认技能目录曝光、显式 false 与 `run_intent_suppressed` 不得伪造用户请求。否定浏览器表达优先于工作流与最近意图兜底，不能继承上一轮浏览器工具面。冲突经 `SystemReminderRegistry` 只进入本轮 instructions，必须告诉模型真实原因并禁止声称“已收到授权”或“稍后自动挂载”，不得写入 `MemorySession` 历史。
- `documentTargetGuard` 所需的 open/save 工具若不在模型可见面，由 executor 从注册表恢复执行并记录 `document_target_guard_tool_recovered`；提示文案必须与自动开存行为一致。
- typed envelope refs 是权限第一信源；只有缺失时才允许文本候选兜底，并记录 `source=text_fallback`。禁止仅靠用户原文正则决定权限。
- `run-capability-controller.resolveRunCapabilities` 目前没有生产调用方，只承担 SDK-shaped parity。不得把它描述成 live 工具面的权威裁决点。
- 回归入口：`check-capability-gate-enforced-in-arbitration.cjs`、`capability-floors.test.ts`、`document-target-guard-selfheal.test.ts`。

## 3. Skill 标准、选择与续跑

- embedded skill 由启动扫描 `assets/embedded-skills/*` 注册：优先读 `ready-skill.json`，否则读 `SKILL.md` frontmatter。目录名必须与 manifest id 或 bare skill name 一致。
- 每轮只读取一次有效技能清单并形成不可漂移的 snapshot；`use_skill` 曝光、模型可见目录和已选技能的动态提醒共用该 snapshot。只有最终工具面真实含 `use_skill` 时，目录才经 `SystemReminderRegistry` 组装 id + name + description 并进入本 run 的 instructions；它不写入 `MemorySession` 输入历史，也不在无激活工具时宣传不可用的技能。升级前已经持久化的旧目录必须在低压压缩、强制压缩和 snapshot 恢复入口全部剔除。模型以完整 `skill_id` 调用 `use_skill`；latent `skill_*` 工具只在选中后的下一次模型迭代按 allow-set 可见，dispatch authorization 始终是最终闸门。
- 代码侧 `findExplicitlyRequestedSkills` 只认完整技能名或明确别名，禁止按普通任务词或 description 模糊激活。
- `use_skill` 返回方法论后必须继续完成当前任务，不能只给计划等用户再次发言。
- 外来技能的 `allowed-tools` 一律忽略并记 `ignoredFields`；工具面只由 Ready 授权层决定。未知 frontmatter 字段忽略，不因规范扩展拒绝导入。
- custom/导入技能的 `skill_run_shell` 默认关闭，按技能保存 `skill_shell_consent`；embedded skill 默认允许。未同意的轮次只能执行只读方法论，不能伪造脚本结果。
- `skill_run_shell`、artifact 读写和 config patch 仍必须遵守沙箱、allowlist、大小上限、symlink 与保留文件约束；用户同意 shell 不等于取消这些边界。
- `~/.agents/skills` 只读发现并建议导入，绝不自动导入或写回。作者侧校验使用 `npm run skills:lint <dir>`；lint ERROR 不替代导入时的安全扫描。
- import 保持宽松：缺 id/description 时只使用既有 safeSlug 与 description 推导兜底，lint ERROR 不阻断导入；安全底线仍是 manifest 存在性、目录扫描与执行授权。
- `skill_executions` 状态机、相关 IPC 和 workflow coordinator 已退役，不得复活。进度走 task tracker、projection 与 child-run 合同。
- LLM 可见 skill 工具只来自 manifest action 与 primitive；reference/advisory skill 以内联 `SKILL.md` 为主，`read_skill` 归一为 internal，reference hint 不能单独打开 primitive。
- 长任务续跑必须持有 `childRunId`、`detachedTaskId` 或 `outputDir + runStatePath`；只有 `taskRunId/skillId` 的空壳不算可续跑。
- child-loop action 属于子循环，父循环不得强制合成 typed tool use。embedded manifest、driver 注册与静态工具名映射必须一致。

## 4. Provider、流式与工具错误

- AI provider 能力必须由共享能力层解析；“OpenAI 兼容”不代表一定支持原生 tools、vision 或 video。通用 openai-compatible 的 `toolUseMode=auto` 必须按不支持工具收口，只有显式 `on` 或内置 provider 合同可以开放；Packer 仅可为已经真实验证过工具流的固定端点写入 `on`。
- 设置页的工具调用 `auto` 必须展示共享能力层解析出的生效值；openai-compatible 自动关闭时明确说明：端点真实支持 function calling 才可“强制开启”。聊天文字不得直接写设置。只有本轮已有 `provider_disabled_tools` 冲突、共享能力仍为关闭且用户明确肯定授权具体工具时，Main 才可直接复用 `ask_user_questions` 确认卡；“打开网页”“当前打开的标签页”“使用浏览器工具”等任务动作不算设置授权。卡片只允许本机 Renderer 作答，远程绑定会话不得发起、转发或提交这类本机设置确认。确认后重新读取活跃配置，核对 active profile id + provider/baseUrl/model，只修改 `toolUseMode`；workspace、当前配置与兼容镜像在同一数据库事务内写入。配置漂移、拒绝、取消、超时或持久化失败均不写。成功时旧工具面回合先结束，再以原始请求、原 scope/task 和全新 run 唯一地自动续跑；不得要求用户重发，也不得复用旧配置快照。
- OpenAI-compatible 的 `baseUrl` 是 API 前缀：origin-only 地址统一补 `/v1`，显式前缀原样保留，消费者只能再拼资源路径，禁止形成 `/v1/v1`。保存和请求边界必须移除 URL 中的用户名、密码、查询参数与锚点；设置输入框保留编辑草稿。Packer 的明文 HTTP 仅允许严格解析后的本机或私网地址，不能用域名前缀猜私网。
- 一键运行时配置由 Main 持有带 `runId/revision` 的单任务快照；设置页重进只恢复投影，重复开始加入原任务。停止先进入 `cancelling`，旧 run 的晚到进度不得改写终态或后续重试，Renderer 必须提供可见的停止与失败后重试入口。
- 标准 `build:dist` 只允许空 AI seed；有意内置配置只能由 Web Packer 显式授权、临时写入并在 finally/下次启动恢复。Packer 只有在包内 seed 与本次请求一致、精简/完整运行时形态正确、Framework/签名/DMG 校验及只读挂载全部通过后才能发布成品。
- 公开网络调研统一走 `web_search_domains / web_search / web_fetch`：AnySearch、Tavily、DuckDuckGo 和 Jina 由加密的外部服务配置提供。AnySearch 垂直搜索先查询子领域参数，失败不得丢掉 domain 约束改做通用搜索；通用搜索与正文提取才允许按已启用服务显式回退。
- openai-compatible chat/responses 与 anthropic 三条 SDK 路径都必须真 SSE：文本增量交付，工具调用和推理在流中累积，终局与阻塞路径同构整形。
- Kimi Coding 的 `k3` 只走 Anthropic `/v1/messages` 主链，思考强度只允许 `low / high / max` 且默认 `high`；普通文字与工具调用都必须保留并在下一轮原样回传完整思考块和签名，请求必须声明 `keep=all` 等价的上下文保留合同。其他模型或旧版无完整身份的历史不得中途切入 K3，必须在联网前拒绝并提示新建会话。
- `provider_request_bill` 与 `provider_wire_request_bill.toolSchemaCount` 必须直接读取 provider 边界同一个实际 `ModelRequest.tools`；禁止为统计重新执行动态 `isEnabled`，也禁止用注册全集近似。注册全集只能另记为 `configuredToolSchemaCount`，差值记 `disabledToolSchemaCount`。每次请求的 input、instructions 与 tools 必须成对记录。
- 降级只有三类：`READY_SDK_TRUE_SSE=off` 总开关；服务返回非 SSE 时伪流式交付；仅错误体明确提及 stream 的 4xx 可单次阻塞重试。413/401/429 等语义性 4xx 必须原样冒泡。
- 回归入口：`npm run verify:streaming`。
- 工具错误由 dispatch 转成结构化 `ToolExecutionOutput` 回灌模型；只有 Abort 或 host 不可用等基础设施错误可以冒泡。
- 单个可选工具失败不能提前写死整轮 `proof_gap`；只有明确的交付失败、工具不可用或产物缺失可写终态失败类别，其余由最终证据统一裁决。`run_meta.last_message_text` 只用于诊断，禁止据此猜测“正文未送达”并补发；Renderer 只在消息正文仍为空时接收 send 返回文本，已有流式正文时不得追加。
- `tool_not_registered` 表示工具不存在；`authorization_denied` 表示工具存在但本轮未授权，两者互斥。
- 新 error kind 必须进入 `src/main/modules/agent-control/contracts/error-kinds.ts` 并通过对应 drift gate；日志或 metric 失败不能反过来打断请求。

## 5. Run 终止、连续性与 Dynamic Delivery

- 所有退出路径都经 `src/main/modules/agent-control/runtime-core/run-finalizer.ts` 的 `finalizeRunOutcome()`；终态账本与可见收口在同一通道完成。通道外写终态由 `check-run-finalize-funnel.cjs` 拒绝。
- bootstrap 预算只是执行前容量猜测；零工具回合以终态 `direct_answer` 收口时必须先重绑预算，再用同一任务类型写 projection、`run_meta`、裁决和关闭指标。最终工具面含 Browser 时，bootstrap 从第一次 provider 调用起获得 220 次高额应急容量；持久研究状态出现后按结构真值重绑为 `research` 并保留已用量。70%/90% 水位只用于诊断和 UI，不再向模型注入“收敛、总结或询问是否继续”；220 只承担异常循环的最后熔断，不是健康长任务的例行分段点。显式 research、browser transaction、continuation 或 skill 预算不得被纯文本逃逸降级。
- Renderer 可以保留失败前已流出的正文，但不得把 Main 返回的 `error/adjudication_degraded` 猜成未持久化的绿色完成；合法纯回答必须由 Main 直接写成 `done`。
- 零工具的行动宣告不能直接判 done：先转向，再 checkpoint；完成判定必须基于本轮真实证据。
- Renderer 60 秒 watchdog 只是活性探针。Main 确认同 requestId 仍 active 时返回 active 并续期，Renderer 不得终止仍运行的 provider。
- Main 的 no-progress 守卫独立于 Renderer watchdog，按 requestId 仲裁；用 `main_no_progress_timeout` 区分 renderer/model/tool timeout。
- Dynamic Delivery 的 adaptive 120 秒、thorough 240 秒是滚动无进展窗口；成功文本或工具结果会续期，持续无进展才以 `delivery_wall_clock_exceeded` 收口。
- 旧 run 晚到不能覆盖同 scope 新 run；已落库消息不能显示成消息丢失。
- 冷启动把持久化的 `working | running` 都视为上次进程遗留。仍绑定 Browser workflow 且持有当前 clean checkpoint 的 Owner 必须先经 Browser 单事务转成 owner-crash 可续跑暂停，再由通用 reconciler 清理其余无有效检查点的行；迁移后的 `running` 词汇不能逃过清扫，有检查点的 Parent 也不能被标成不可继续。
- Dynamic Delivery 默认 `adaptive`，设置页可切 `standard`；输入框 `thorough` 只影响下一次发送并立即复位。
- 只有结构事实证明有收益时才进入协作/独立复核。worker 永远无工具；Owner 独占工具、写入、确认和外部动作。候选答案在 fresh verifier 接受前不能进入共享会话、流式输出或恢复快照。
- research 任务只有本轮已有明确引用和足量正文时，才可在 Owner 前派无工具 worker；Boost/thorough 不能绕过证据门。
- 多文件交付在语义复核前必须按 current-run proof 回读目标文件，检查非空、数量、声明交付项和索引链接；成功 auto-export 必须铸 artifact proof。
- `report_sources` 必须同时有带 URL 的来源发现与真实正文读取回执；页面 map 和后台句柄不算正文。
- 回归入口：`npm run verify:stability`、`npm run verify:dynamic-delivery`。

## 6. 后台任务、采集与浏览器执行

- Browser Agent 负责理解目标、选择下一步和判断证据是否足够；代码只负责能力边界、状态推进、页面动作和可验证结果。链接先作为资源理解，不按站点、语言、控件文案、查询关键词或固定步骤硬编码流程。
- `assets/prompts/browser/discipline.md` 是 Browser 详细纪律的唯一稳定来源；只在最终工具面真实含浏览器能力时注入一次。普通网页搜索、未激活的浏览器环境和已被 exclusive skill 接管的轮次不得误注入。用户提出多个独立目标时，模型必须把每个目标声明为独立 required work item；一个汇总项不能代替多目标覆盖，一个证据只证明它实际读取到的目标与字段。代码不解析站点、语言、关键词或固定字段替模型做这项语义拆分。
- 浏览器激活只读取可信结构事实：当前工作面、绑定当前页面的 `browserPageRef` 和本轮技能组合。直接浏览器工作面一次提供完整的 typed browser surface；其他环境通过 `use_browser` 显式进入。能力叠加与互斥由统一组合器决定，不从用户自然语言猜工具子集。
- `browser-capability-registry` 是公开工具名、operation、effects、运行模式和执行边界的唯一代码真值；共享语义清单和 wire schema 从同一合同派生。条件参数必须在 schema 中表达，模型自报 effects、同意或权限不能改变代码侧结论。
- 除标签管理等 management 操作外，所有页面绑定操作都必须携带可核对的父任务、Owner run、browser task、物理标签与持久 journal 路由；可信内部调用也不能绕过。路由缺失、冲突或已失效时明确失败，不新建第二套临时进度。
- 所有公开页面动作经 `BrowserActionExecutor` 进入同一执行栈：先登记动作和写租约，再由可信鼠标、键盘或直接文本通道完成物理输入并记录机械 delivery/effect。动作若在返回时仍需观察，就只标记 `needsObservation`，不能伪造 observation receipt。搜索只是“填入当前结构目标并提交”；工具返回文案、目标数量或候选数量都不能冒充动作或阅读证据。
- 输入 readiness 按 transport 分别裁决，不存在一个“当前页面全部可写”开关。稳定 ref 重解析到同一 rendered editable、精确 focus 成功且 physical target 仍存在时，direct text 可在 hidden/parked/detached host 上投递并严格回读；同一表单的结构化 `requestSubmit()` 也可用。指针、键盘事件、滚轮和拖拽只在可见、活动、前台 host 上开放；任一通道不得主动抢 OS 焦点。
- `BrowserSnapshotService` 是页面结构与 target ref 的唯一公开真值。ref 同时绑定逻辑标签、物理 target、frame document 和 snapshot revision；完整目标集保持私有，公开快照受预算约束。页面或 frame 变化后必须重新观测，禁止按 role/name、href、站点规则或旧 generation 无声重绑后继续写。
- 主 frame 与子 frame 通过 CDP/DOM/AX 分层采集；CDP AX/DOM 是 closed-shadow、委托控件和无普通 DOM 语义目标的主要来源。DOM fallback 只收集链接、表单控件、显式 role、contenteditable 和标题等结构目标，不再因标签名带短横线、`cursor:pointer`、元素文本或 DOM 顺序猜可点击性。`browser_find` 只按结构属性、可见性、可用性、可编辑性、frame 和包含关系过滤，由模型结合上下文选择目标。截图返回真实图像。BrowserView 被 DOM 覆盖时先 hide/停放，恢复后 show 并同步 bounds。
- 点击在结构目标已唯一确定但 point probe 暂时失败时允许可信输入通道尽力投递；输入文字、上传和密码目标必须先验证真实目的地。文件上传必须显式选择一个附件、多个附件、名称或 `latest:true`，并在 input readback 中精确核对已赋值文件；禁止静默取“最新附件”。
- 搜索的 fill 和 submit 是两个独立 action：先回读输入值，再优先提交该输入所属的精确 form；只在无可绑定 form 时才使用显式 submit target 或前台 Enter。提交送达与搜索结果成立分开记录，后续结果/空结果必须来自更新的绑定 observation；不导航不等于未提交，也不自动重发。快照观察到的真实 href 可带来源 ref 直接导航，不强制先点击；仍禁止合成站点 URL。
- 任一已结算但尚无因果 observation receipt 的页面动作，都会从同一 journal 派生 observe-only barrier；它不依赖 checkpoint cursor，也不另建 pending 状态。barrier 存在时终态候选不能发布，模型在同一 Owner/run/task 内最多获得一次显式观察收口机会，并自行选择合适的只读 Browser 工具；代码不自动调用 snapshot，也不写站点、语言、查询词或步骤规则。原生工具协议在一个有界调用内读回观察；文本工具桥允许一次观察响应和一次无工具的结果合成响应，两者都独立于已耗尽的普通轮次预算。观察响应中的全部调用保持只读，即使首个读取已清除 journal barrier，后续调用也不能写页面；合成响应不再开放工具。未清除 barrier 或未形成最终答复时持久化为可续跑暂停，非观察操作和自动重放一律拒绝。
- 终态候选还必须核对持久研究覆盖。`research_incomplete` 时候选保持不可见，缺失 work items 作为结构事实回给同一 Owner/run/task 继续；required work item 的覆盖或其绑定证据增加时刷新继续窗口，无关页面动作、观察和未绑定资源不得冒充研究进展。连续两次继续仍没有任何持久进展时才写 `checkpoint_incomplete`，其含义固定为“现场已保存、当前已暂停、可继续”，不得写成失败或伪装成后台 worker 仍在运行。
- 下载只走当前浏览器 session，以临时文件流式落盘、预算校验、hash 与原子发布收口。公开地址静默跳入本地网络时拒绝，用户明确打开的内网/本地来源保持可用；输出只能进入本轮明确授权或 Ready 管理的目录。
- Power 工具效果按工具、CDP 方法、目标和输出通道机械推导，不按域名封锁。普通观察与诊断不因审计暂时失败而阻断；真实破坏性或秘密外发动作必须在执行前匹配已持久化的精确 grant。权限请求按 partition、逻辑/物理标签、Owner、任务、scope、origin 和请求身份逐项绑定，不使用全局等待队列。
- `browser_research` 只维护 `start | evidence | complete` 三类持久研究状态：建立开放 work items、把指定 observation receipt 绑定到指定字段、在完成时核对覆盖与来源。它不运行站点 adapter、固定步骤计划或后台浏览器 runner；下一页面动作始终由主 Agent 通过公开工具决定。
- browser journal/checkpoint 是动作、证据、暂停和续跑的唯一持久真值。续跑依赖原任务路由、已完成动作和未解决 work items，不继承自然语言意图副本或 collection/batch 标记。只有绑定真实页面读取的 observation resource 能成为来源证据；失败回执、工具日志、URL、标题或候选数量不能冒充正文。
- Browser workflow closeout 只做一次 typed inspection，结果为 `absent | action_in_flight | observation_required | research_incomplete | sealable`。成功只能从 `sealable` 进入最终复核；fresh verifier 拒绝 Browser 候选时，候选保持不可见，结构化 summary/gaps 与被拒候选 digest 必须进入同一个 suspension checkpoint 并由下一 Owner 直接读取，不能只保存泛化暂停文案；任务最终接受后这类恢复事实必须从公共会话提交中移除，不能污染后续新需求。error/cancel/interrupted 不复用成功 seal，而是在核对 child revision 与绑定后原子收口，不能留下仍为 running 的 Parent、child 或 run。`terminalQualityPatch` 属于 Parent 质量账，可以随非成功核心事务写入而不要求成功 seal；只有 Browser `done` 仍必须同时持有当前 seal、fresh verifier accept receipt 与匹配 digest。
- `browser_research(action=complete)` 只在所有开放 work items 都有匹配当前文档与目标字段的有效证据时完成；正文必须来自详情页读取，列表事实只能覆盖其实际读到的字段。受预算约束的结果与证据摘要写入同一个 task transaction，重启或 rebind 后仍可核验和交付。
- 浏览器任务永久保留创建 run、活动执行绑定、父任务和 revision。Renderer 只消费 Main projection；旧 revision 不得覆盖新续跑，projection 写失败不得反向杀死真实任务。停止或用户接管时先关闭写栅栏，再持久化可续跑暂停；用户输入继续送入页面，不额外排队或要求二次确认。
- Agent 指针层只展示真实可信鼠标动作，完全 click-through；动作终态、租约丢失、接管、标签切换、BrowserView 隐藏或 bounds 改变时清除。提示显示状态不改变任务、权限或执行状态。
- 浏览器专项回归入口是 `npm run verify:browser-orchestration`、`npm run verify:browser-surface`、`npm run verify:browser-reliability` 与 `npm run verify:browser-grounded-orchestration-native`；涉及 SQLite、下载记录或任务持久化还必须跑 `npm run verify:native`，最终另跑隔离配置下的真实 Electron live proof。完整基线一旦通过，后续局部修正保留累计证据，只复测原失败、直接风险变体和受影响 gate，不机械重跑未受影响矩阵。
- RSS 自动刷新由 Main 单实例调度，不依赖 RSS 页面是否打开；`rss:auto_refresh_interval_ms=0` 表示仅手动刷新。冷启动按持久化的最近一次 `fetchAll` 完成时间补跑或等待剩余间隔，设置保存后立即重新排期。手动与自动刷新必须复用同一个 `fetchAll` 入口和 `RSSUpdateLock`；自动结果通过状态查询与完成事件通知 Renderer，`success:false` 和部分源错误都必须保留为可见警告。
- RSS 文章在统一抓取出口按平台内容编号归一后再入库；Bilibili 视频页、带追踪参数的链接和明确只指向一条视频的动态，以及 Twitter/X 同一状态的等价链接，必须得到同一文章身份。普通文章对视频或推文的引用不得改变文章身份。同标题或同发布时间不能单独作为去重依据；历史别名合并必须保留未读、收藏、收件箱可见性和分析任务关联。
- Agent 定时任务的唯一时间与领取真值是 Main + SQLite 的 `scheduled_tasks` / `agent_schedule_occurrences`；sidecar 不再调度或镜像。每次触发先持久领取 occurrence，再按 scope 串行进入生产 Agent 主链；同一 schedule 不并发，前台运行优先，缺失 scope/Agent/workspace 时暂停或阻塞而不走兜底会话。
- 定时任务入口仍在四模式切换器右侧，但总览、编辑和历史占用中间工作区，不增加第五种 mode。打开时持有持续 BrowserView 遮罩，关闭时释放并恢复活动页；液态玻璃投影只读取背后的工作内容节点，禁止把覆盖面自身包含进投影源。
- 时间预览和真实调度共用结构化规则计算器，保存 IANA 时区；一次、日历和间隔任务遵守 DST、错过合并、稳定 occurrence id 与最小五分钟间隔合同。Renderer 只消费 Main readback，`onChanged` 只用于失效通知。

## 7. 文档与 Widget

- 附件、`@[文件]`、当前文档与引用片段先进入结构化资源层；多来源、多目标、多步骤任务先计划再执行。
- 关系图谱中可打开的文档节点必须由 Main 返回真实路径；Renderer 只对本地文档节点提供悬浮正文预览与点击打开，并沿统一工作面切换入口进入 Document，不能用文件名猜路径。
- 文档标签元数据与可恢复草稿分开持久化：标签激活不得同步重写未变化的大正文；草稿合并写入，并在页面隐藏或退出前冲刷。磁盘回读必须一次性落为 clean 内容，不能先制造 dirty 再补 saved。旧内嵌草稿快照必须无损迁移。
- 保存只提交发起写盘时的精确正文快照；写盘期间继续输入时，晚到结果不得覆盖新正文或删除新草稿。首次打开由编辑器读盘；激活或目录变更可刷新任何 clean 的本地文本（包括内存正文为空），同一 tab/path 回读合并，结果返回时再次检查 path 与 dirty。
- 双开文档以 `focusedPaneTabId` 决定唯一保存目标；全局保存只有一个入口，每个编辑面通过注册表提供自己的保存实现。目录变更在 Main 按 Renderer 合并发送，Renderer 只有一个调度入口；dirty 标签不回读，隐藏期只记待刷新标签，激活后只读最新一次。
- 预览结构解析仍以最新全文为真值，但块渲染使用稳定的内容寻址身份与 memo 边界；Widget 编译、高度和 Mermaid 结果只能放入有容量上限的缓存，全文档 Widget 共用一个主题 observer。隐藏的普通 DocumentMode 卸载重树；含交互 Widget 的最后可见场景冻结正文并保留 iframe，重新显示后再追到最新正文。
- PDF 通过 `local-file://` 的 HEAD/Range 响应按需读取，Renderer 只挂载当前页前后各 3 页、最多 7 页的重页树；未访问页用轻量占位，尺寸在渲染后按页校准，缩放不重渲染窗口外 slot。Board 节点连续拖动只在 DOM 快路更新，结束时一次提交文档状态；框选、缩放、箭头和滚轮连续事件按动画帧合并，取消必须恢复起始状态。
- DOCX 读/写、XLSX 解析、EPUB 导入与 Agent/附件的 DOCX/XLSX/PDF 重文档提取只在惰性 document worker 串行执行；Main 不保留同步回退重处理。分段文本提取的 offset/limit 下推到 worker，只返回请求窗口。文本与 DOCX 保存都使用同目录原子发布，失败时不损坏原文件。
- keep-alive 的 DocumentMode 只在可见时响应文件选择。文件树、搜索和图谱已经打开的目标不得被 DocumentMode 再次 stat/open/activity；文件涌现活动只把快照标脏，刷新经空闲合并调度且同一工作区只允许一轮生成。FileTree 的涌现上下文只订阅 group/path 等结构事实，正文、dirty 与激活时间变化不得重建调度或发查询。
- H1/H2 freeform 只在命中特定触发词时使用；其他 Widget 使用结构化骨架 A-G、`relation_map` 或 `process_flow`。
- Widget 视觉唯一来源是 `src/shared/document-widget-theme.ts` 与 `document-widget-dot-charts.ts`：Ready 单橘红、mono 标签、禁饼图/彩虹/Emoji 图标；`pie` 输入渲染为合规占比形态。
- OpenUI componentSpec、骨架编译器与 iframe 基线 CSS 都走令牌。预览/导出优先从 `skeleton_spec` 或 `component_spec` 重编译；`widget_code` 只作无法重建时的兼容回退。
- iframe、接收器、导出注入与宿主 bootstrap 脚本必须使用与 `index.html` CSP 完全一致的 `WIDGET_SCRIPT_NONCE`。
- `onclick/oninput/onchange` 先由 sanitizer 改写为 `data-ready-on*`，再由 receiver 调用具名函数；静态回退与导出必须剥除事件属性。
- “信息卡、摘要卡、对比卡、关系图、流程图、图表”必须走 `document_insert_widget`，不能用 Markdown 表格或文本替换冒充。
- Widget 更新上下文优先于 live-info 判定；天气、新闻、股价、汇率、比分、航班、路况、空气质量和官网公告等实时问题必须进入网页查询工作流。
- 回归入口：`npm run verify:document-perf`、`npm run verify:widget-ready`；详细设计见 `docs/superpowers/plans/2026-07-17-document-mode-performance-implementation.md` 与 `docs/superpowers/plans/2026-07-11-document-widget-ready-design-language-implementation.md`。

## 8. 行动确认、知识与专项 Agent

- 非浏览器高危工具在 authorization 后由 `agent-control/safety/action-confirmation-policy.ts` 的 M1-M4 表裁决；不得用提示词代替确认闸门。
- 内置 `operator` 使用保留身份与独立内置人格；迁移遇到任何不完全等于内置种子的同 slug agent 时，必须先无损改名和搬迁人格再补种。历史保留 slug 人格错绑只允许由后续迁移在账本与精确占位内容共同证明时修复，含糊或用户编辑状态不得覆盖。`social-media-ops` 是 reference/advisory 技能；截图缓存只算坐标证据，视觉判断必须走能返回分析结果的工具。
- `run_setup_command` 的 `confirmAck` 只表示进入执行阶段，不是用户授权凭证；所有执行阶段调用必须冻结原参数并走 Ready 确认卡。CLI 授权优先使用可续接的 JSON/device-code 流程并显示可点击链接；退出码 10 的高风险重试不得自动追加 `--yes` 后执行，原始 TTY 交互仍明确不支持。
- staged 信念卡不得进入 prompt；Reflection 不得直接写 prompt 可见的 `resident_user` / `scope_memory`，并必须发 `reflection_outcome` 账本。
- owner 解析顺序：显式合法 `ownerAgentId` 优先；完全未传时回退 `scope.agent`；显式非法时降级 global-only，不借道读取其他 Agent 谱系。
- charter/路由索引只进入主 Agent 会话；`ownerAgentId` 只能由用户采纳 handoff 后写入，后续轮次随 scope 最近 owner 切换。
- 任务包最多嵌套两层；`direct_answer` / `short_task` 不分包，multi-step/research 只有多目标时才分。子包失败只能重派一次、带理由降级或阻塞，禁止静默吞掉。
- 子包上行报告最多 5 行摘要加引用，不把原始请求或证据重新转述成另一份任务说明。
- handoff、SubAgent、技能子进程只传 `userRequestVerbatim` 原文与结构化 refs；恢复路径读取持久化原文，不重新转述派生。
- LLM 维护回合先过确定性门控；skip 必须零 LLM 调用，执行容器固定为 `runSubAgent`，维护写卡只能 staged。用户画像合并对 DB 真值做 CAS，只有无 profile 行时才用 `USER.md` 镜像；涌现候选只在 candidate 且证据不少于 3 条时投影。
- 新专项 Agent id 必须是小写 slug，派生、停用、合并都要用户确认；`disabled` 可逆，`merged` 不可逆且保留资产，禁止新写 `retired`。
- agent 作用域卡可进入镜像、衰减和维护信源，但 root `index.md` 只收 global。历史 owner 保留；merged owner 确定性重定向，disabled/缺失 owner 降级主 Agent，不读取其他专项资产。
- routing 卡只有 active、含不超过 8 个字面 triggers、目标 active 时参与；continue 类永远回原 Agent。
- 浏览器失败学习只生成 staged 新卡、旁卡或风险建议卡，不能自动改写 active 站点卡；设置页必须显示知识总开关、待确认信念卡、站点卡风险和维护回合状态。
- prepare/harvest/forming 等涌现卡必须带 evidence 与行动出口；受保护路径只显示“产物已生成（受保护路径）”。
- 回归入口：`npm run verify:evolution-p1`、`npm run verify:evolution-p3`、`npm run verify:evolution-p4`。

## 9. 文件涌现与 Tag Forge

- 文件管理公开入口只负责无状态查询与工具分发；路径授权、真实路径边界和持久 JSON 原语集中在共享运行层，文件整理状态归文件整理模块，Tag Forge 批次与审核状态归 Tag Forge 域。禁止把这些状态重新塞回公开入口或复制边界实现。
- hidden、snoozed、not_related 等持久反馈必须在 Main 与 Renderer 两端同时生效；当前 tab、dirty tab 或阅读进度不能把被压制项目重新注入。
- 文件涌现生成必须携带失效代次；生成期间的新活动或反馈不能被旧生成结果覆盖为 fresh，下一次查询必须重新读取真值。
- 自动 Tag Forge 写入必须先有 durable creation receipt。receipt 绑定 source run、创建 tab、目标 path/fileKey 和最终 hash；禁止 run 级 token fallback。
- 文件夹批量打标的模型只调用 `tag_forge_prepare_batch -> tag_forge_apply_batch`；typed folder reference 只为这两个动作补充本轮目录边界，不得授权任何其他文件工具。目录授权只来自用户消息上由 Renderer 携带的结构化文件夹附件元数据；本轮实际 `@[文件夹]` 引用的历史附件沿用同一元数据，不授权未引用的附件，正文中的同名标记也不得生成授权。执行前必须对目录与文件的真实路径重新做边界检查，禁止通过符号链接绕到宽根；目录内的 Markdown 符号链接只登记失败原因，不得读取其目标正文。工作区根自身是符号链接时，以其真实位置完成同一边界判断，不得误拒绝合法文件。准备工具在代码侧递归盘点、读取正文、签发 revision，并只给模型返回不透露主机路径的 `itemId`。每批最多 4 份且正文合计不超过 60000 字符（单份超长文档可独立返回）；无法读取的 Markdown 必须显式阻断 `done`，不得静默漏标。
- 无论用户显式点名 Tag Forge，还是只用自然语言要求给文件夹打标，选技后模型工具面都必须立即替换为 `file_locate` / `file_read_excerpt` / `tag_forge_prepare_batch` / `tag_forge_apply_batch` / `declare_completion_criteria`。不得保留通用文件写入、命令、技能产物或自行追问工具。
- 内容标签与工作流状态分离：Tag Forge 本轮自动负责的内容标签必须有且仅有一个 form，并至少有一个 domain 或 entity，安全范围为 2–15；手工或导入标签原样保留、不占自动标签名额，也不转为自动标签或全局词表项。除 form 最多一个外，domain/entity/use 不设独立硬配额；模型只保留有直接证据、可跨文档复用且能新增独立检索路径的标签。同义词、翻译、大小写和拼写变体只保留一个归一标签，已有具体标签时不再添加同义的宽泛上位词。active 标签名与别名必须跨词条唯一，标准名优先于别名解析；词表冲突必须在加载时失败，不能留给运行时猜 facet。当前文档已有且能由受控词表标签或别名确定 facet 的手工标签，直接在本文件内满足覆盖要求，不依赖模型本轮重复提案；正文证据成立的同名手工标签也只在本文件内满足覆盖，不进入全局词表或反问。两者都不重复写入、不发起冗余确认。`ready_state` 由代码单独维护且不在文档预览中展示。只有状态标签的历史文档必须自动进入修复，不得因“已有标签”而跳过。
- 显式批量写回只接受带文内证据的 `proposals`，不再接受 `tags` 简写。已有词条立即归一；置信度不低于 0.92、证据中直接出现标签名的新 domain/entity/use，只受每份文档 15 个自动内容标签的安全上限约束并直接采用。达到上限后的候选直接忽略，不得仅因数量溢出进入用户确认。文档中已存在的用户标签不得再次进入反问；其余存疑项在整个文件夹确定项都写完后由宿主合并反问。同一 folder run 最多一张、最多 35 项，超出容量的低置信候选直接忽略，不制造第二张卡或无卡等待状态。卡片、批次、文档、scope、run 和精确 proposal id 必须一一绑定，用户回答后宿主自动续跑。
- 标签文件、当前打开 tab、搜索索引与标签归属必须是一个可回滚的写入单元；任一步写入或回读失败都恢复原文，禁止出现“文件已改但任务失败”。`waiting_review`、`done:false` 和其他非终态不产生完成证明，不得被任务卡写成完成。
- Tag Forge 文件夹轮使用 240 秒无进展窗口，为单次模型等待超时后的既有 provider 重试留出时间；abort 后 provider 即使正常返回，也必须按超时收口，禁止再显示“工具已执行完成”。成功批次 JSON 必须按结构化 `ok/status` 判断，正文出现“失败”“无法”等词不能把成功进度误判成失败。
- 批量路径不得退回逐文件 read/write 或已退役的单文件 Tag Forge 工具，也不得为此开放通用写文件或 shell。文本工具桥必须把 prepare 的结构数据完整交给下一模型回合，并沿既有任务回合预算循环到 `done:true`；预算耗尽时不得把 `remaining>0` 伪装成完成。
- 自动新文档路径只接受尚不存在、位于授权 workspace 且 realpath 不越界的 Markdown 目标；每条标签证据必须从最终将落盘的正文中精确回查，最终正文、回执 hash 与写回内容必须一致。精确命中且置信度不低于 0.65 的 domain/entity/use 新词在文档 2–15 个自动内容标签安全范围内直接采用，低可信、无精确证据或超出容量的候选直接忽略，不发起新文档确认。缺少“恰好一个 form + 至少一个 domain 或 entity”时不得稀疏完成；失败重试必须从持久 receipt 恢复。
- 文件涌现只能消费 `suppressed=0` 且已经索引 readback 的 assignment。用户删除自动标签后手工加回时，来源转为 user/manual。
- 长期评估使用生成时的 immutable snapshot、稳定 fileKey 和成熟窗口；不能用评估时的可变项目成员倒推历史。
- 回归入口：`npm run verify:file-emergence`、`npm run verify:tag-forge`。

## 10. AI 生图与图片产物

- GPT Image 与 Gemini Image 复用 `external_service_profiles_v1` 的加密密钥边界；设置页“试生成”必须走正式协议客户端并真实返回图片后才算成功，不能用模型列表或普通聊天请求代替。
- 本地主 Agent 只通过 `generate_image` 进入生图主链；自然语言与 `/imag` 共用该工具。参考图只来自本轮 `user_attachment / explicit_reference` 图片资源，按界面序号解析，模型不得提供或改写本机路径。
- GPT Image 使用 OpenAI Images generations/edits；Gemini Image 使用 `generateContent`。两条路径都必须支持取消、超时、大小与真实图片格式校验，并把远程结果收敛为本机临时图片，禁止把 base64 写入聊天历史。
- 生成结果先落在 `os.tmpdir()/ready-image-generation` 的有界缓存；聊天只保存结构化产物引用。复制、引用和落地前重新验证缓存真实路径；Markdown 文档的编辑/预览面都接收落点，复制到同级 `assets/`；文件树落地使用不覆盖复制。拖拽开始时先隐藏原生 BrowserView，再用 Renderer 落点判断文档、文件树或网页目标；网页落点复用既有本地媒体上传链，完成后再恢复 BrowserView。
- 任务产物经既有 projection 进入聊天；不新增 Renderer 直连模型、第二套任务状态机、自动服务切换或永久图库。完整合同与 gate 见 `docs/superpowers/plans/2026-07-15-ai-image-generation-service-implementation.md`。

## 11. 测试、原生依赖与平台

- 新测试默认验证真实入口的可观察行为；结构测试只用于行为无法证明的硬合同。不得用 source grep 冒充行为验证，不得用 skip 当通过。
- SQLite、设置、搜索索引或本地持久化验收先跑 `npm run verify:native`；普通 Node 下 ABI skip 只说明该路径未覆盖。
- 主进程启动、日志轮转、SQLite native gate 和 `better-sqlite3` 真实加载都属于验收边界。
- Windows 必须本机重装依赖并重编 `better-sqlite3`。路径使用 `app.getPath`、`process.resourcesPath`、`path.join`、`path.delimiter`；不得带入 macOS `node_modules`、`.app`、`.dmg`、`.icns`、种子、缓存或密钥。
- Windows 开发与回传流程见 `docs/platform/windows-development.md`；测试细则见 `docs/superpowers/testing-conventions.md`。
