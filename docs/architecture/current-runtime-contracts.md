# Ready 当前运行时硬合同

> 更新时间：2026-07-15
> 本文承接原先重复写在 `AGENTS.md` 与 `CLAUDE.md` 里的详细约束。两份根指引保留入口与红线；修改本页覆盖的模块前必须读取对应章节。

代码、类型、行为测试和 CI gate 比本文更权威。若实现与本文冲突，先判断是实现回归还是文档漂移；不得为旧文档复活已退役路径。

## 1. 应用壳、CSS 与原生窗口

- `src/renderer/main.tsx` 保留 bootstrap 级错误兜底；`src/renderer/App.tsx` 保留 `/workbench` 与 `* -> /workbench` fallback。
- Renderer 的通用 `*` reset 必须位于明确的 `@layer base`。禁止在层外重置通用 `margin` / `padding`；回归入口是 `scripts/check-css-cascade-layer-reset.cjs`。
- 代码文件只要净增行数，收尾前就检查总行数。超过 1000 行按“危险 / 一般 / 健康”更新 `docs/code-health/large-file-health-log.md`：健康无需动作，一般写复查日期，危险在最终回复提醒。生成物、锁文件和 vendored 第三方文件不计，但生成器源码仍计。
- BrowserView 是原生覆盖层，不受 DOM `z-index` 控制。任何 primary、secondary、关闭分栏或卸载转换只要让 Browser 离开可见 mode 集合，都必须先经 `hide-all` intent + 匹配 ack，再提交 DOM mode；恢复后按稳定 bounds 显示。文件打开使用同一协调入口，但只保留这段正确性等待，不串行等待 ritual 或场景滑动。
- 聊天输入框液态玻璃只以真实 Electron dev 为验收面；`#/liquid-test` 只用于调参。生产输入框不得加外部暗色阴影或静态截图贴片，消息末尾必须按浮层实测高度留白。
- Windows 顶部 chrome 保留系统最小化、最大化、关闭按钮；Ready 圆点在左上，中心按 `WORKBENCH_EDGE_RAIL_SLOT_INSET_X + WORKBENCH_EDGE_RAIL_SLOT_SIZE / 2` 与左轨槽位对齐（当前 25px）。`titleBarStyle: 'hidden'` + `titleBarOverlay` 负责同层背景，Mica 只能是有普通背景 fallback 的增强。

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
- OpenAI-compatible 的 `baseUrl` 是 API 前缀：origin-only 地址统一补 `/v1`，显式前缀原样保留，消费者只能再拼资源路径，禁止形成 `/v1/v1`。保存和请求边界必须移除 URL 中的用户名、密码、查询参数与锚点；设置输入框保留编辑草稿。Packer 的明文 HTTP 仅允许严格解析后的本机或私网地址，不能用域名前缀猜私网。
- 一键运行时配置由 Main 持有带 `runId/revision` 的单任务快照；设置页重进只恢复投影，重复开始加入原任务。停止先进入 `cancelling`，旧 run 的晚到进度不得改写终态或后续重试，Renderer 必须提供可见的停止与失败后重试入口。
- 标准 `build:dist` 只允许空 AI seed；有意内置配置只能由 Web Packer 显式授权、临时写入并在 finally/下次启动恢复。Packer 只有在包内 seed 与本次请求一致、精简/完整运行时形态正确、Framework/签名/DMG 校验及只读挂载全部通过后才能发布成品。
- 公开网络调研统一走 `web_search_domains / web_search / web_fetch`：AnySearch、Tavily、DuckDuckGo 和 Jina 由加密的外部服务配置提供。AnySearch 垂直搜索先查询子领域参数，失败不得丢掉 domain 约束改做通用搜索；通用搜索与正文提取才允许按已启用服务显式回退。
- openai-compatible chat/responses 与 anthropic 三条 SDK 路径都必须真 SSE：文本增量交付，工具调用和推理在流中累积，终局与阻塞路径同构整形。
- 降级只有三类：`READY_SDK_TRUE_SSE=off` 总开关；服务返回非 SSE 时伪流式交付；仅错误体明确提及 stream 的 4xx 可单次阻塞重试。413/401/429 等语义性 4xx 必须原样冒泡。
- 回归入口：`npm run verify:streaming`。
- 工具错误由 dispatch 转成结构化 `ToolExecutionOutput` 回灌模型；只有 Abort 或 host 不可用等基础设施错误可以冒泡。
- 单个可选工具失败不能提前写死整轮 `proof_gap`；只有明确的交付失败、工具不可用或产物缺失可写终态失败类别，其余由最终证据统一裁决。`run_meta.last_message_text` 只用于诊断，禁止据此猜测“正文未送达”并补发；Renderer 只在消息正文仍为空时接收 send 返回文本，已有流式正文时不得追加。
- `tool_not_registered` 表示工具不存在；`authorization_denied` 表示工具存在但本轮未授权，两者互斥。
- 新 error kind 必须进入 `src/main/modules/agent-control/contracts/error-kinds.ts` 并通过对应 drift gate；日志或 metric 失败不能反过来打断请求。

## 5. Run 终止、连续性与 Dynamic Delivery

- 所有退出路径都经 `src/main/modules/agent-control/runtime-core/run-finalizer.ts` 的 `finalizeRunOutcome()`；终态账本与可见收口在同一通道完成。通道外写终态由 `check-run-finalize-funnel.cjs` 拒绝。
- bootstrap 预算只是执行前容量猜测；零工具回合以终态 `direct_answer` 收口时必须先重绑预算，再用同一任务类型写 projection、`run_meta`、裁决和关闭指标。显式 research、browser transaction、continuation 或 skill 预算不得被纯文本逃逸降级。
- Renderer 可以保留失败前已流出的正文，但不得把 Main 返回的 `error/adjudication_degraded` 猜成未持久化的绿色完成；合法纯回答必须由 Main 直接写成 `done`。
- 零工具的行动宣告不能直接判 done：先转向，再 checkpoint；完成判定必须基于本轮真实证据。
- Renderer 60 秒 watchdog 只是活性探针。Main 确认同 requestId 仍 active 时返回 active 并续期，Renderer 不得终止仍运行的 provider。
- Main 的 no-progress 守卫独立于 Renderer watchdog，按 requestId 仲裁；用 `main_no_progress_timeout` 区分 renderer/model/tool timeout。
- Dynamic Delivery 的 adaptive 120 秒、thorough 240 秒是滚动无进展窗口；成功文本或工具结果会续期，持续无进展才以 `delivery_wall_clock_exceeded` 收口。
- 旧 run 晚到不能覆盖同 scope 新 run；已落库消息不能显示成消息丢失。
- Dynamic Delivery 默认 `adaptive`，设置页可切 `standard`；输入框 `thorough` 只影响下一次发送并立即复位。
- 只有结构事实证明有收益时才进入协作/独立复核。worker 永远无工具；Owner 独占工具、写入、确认和外部动作。候选答案在 fresh verifier 接受前不能进入共享会话、流式输出或恢复快照。
- research 任务只有本轮已有明确引用和足量正文时，才可在 Owner 前派无工具 worker；Boost/thorough 不能绕过证据门。
- 多文件交付在语义复核前必须按 current-run proof 回读目标文件，检查非空、数量、声明交付项和索引链接；成功 auto-export 必须铸 artifact proof。
- `report_sources` 必须同时有带 URL 的来源发现与真实正文读取回执；页面 map 和后台句柄不算正文。
- 回归入口：`npm run verify:stability`、`npm run verify:dynamic-delivery`。

## 6. 后台任务、采集与浏览器执行

- Browser Agent 走“理解 -> 计划 -> 分步执行 -> 复核”；链接是资源，不是立即执行指令。
- `assets/prompts/browser/discipline.md` 是 Browser 详细纪律的唯一稳定来源；只在最终模型工具面含 `browser_interaction` 或 `browser_content_tasks` 时注入一次本轮 instructions。Browser DomainAdapter 不再按关键词重复注入该纪律，普通 `web_search` 也不触发；运行时只补当前 `browser_visible_collect`、Power 与用户接管等动态事实。
- Safe Mode 只接受 `browser-readonly-script-templates.ts` 中的命名只读模板，自由脚本以 `freeform_script_denied` / `script_blocked` 拒绝。
- Power Mode 使用 `browser_power_eval`、`browser_power_cdp`、`browser_power_network_trace`、`browser_power_resource_forensics`，按 effect/grant/audit 执行，不用站点静态封锁代替授权。
- 破坏性浏览器效果由 `src/shared/browser-power.ts` 枚举；live target 命中支付、凭据、访问控制等语义时必须返回 `grant_required`。
- 后台任务终态经 `TaskEventBridge` 回到 Agent 循环：活跃 run 注入提醒，无活跃 run 写 pending 并播报续跑。没有注册路由的 `scheduleTask` 必须运行时失败。
- 自动续跑只允许播报建议；执行动作仍需用户明确确认。
- 浏览器页面引用、平台名、账号名和“分析/选题”只开放观察工具；只有用户明确说采集、抓取、下载或保存，才开放持久采集工具并承担采集文件验收标准。`browser_get_task` 必须纯查询，`browser_resume_task` 只能继续原任务，两者都不得把完成的发现任务自动升级成保存采集。
- 可见发现任务与后续保存任务是一条可追踪的任务链：停止入口必须指向当前仍运行的保存任务；卡片清除只移除展示，不能偷偷停止任务。采集卡在运行和完成后都保留固定位置，直到用户点右上角清除或右滑清除，并展示可打开的结果文件夹、报告与清单。
- 采集 projection 必须继承发起 Agent、父任务与执行绑定；保存目录从任务计划开始就可见，终态以 runner 回写的真实 `outputRootDir/reportPath/manifestPath` 为准，不能让用户靠默认路径猜结果位置。
- 采集终态只由 `browser-engine/collection-verdict.ts` 的 `resolveCollectionVerdict()` 决定：0 条永不 completed，部分进展不清断点，整任务重试只重试失败项。
- RSS 自动刷新由 Main 单实例调度，不依赖 RSS 页面是否打开；`rss:auto_refresh_interval_ms=0` 表示仅手动刷新。冷启动按持久化的最近一次 `fetchAll` 完成时间补跑或等待剩余间隔，设置保存后立即重新排期。手动与自动刷新必须复用同一个 `fetchAll` 入口和 `RSSUpdateLock`；自动结果通过状态查询与完成事件通知 Renderer，`success:false` 和部分源错误都必须保留为可见警告。
- RSS 文章在统一抓取出口按平台内容编号归一后再入库；Bilibili 视频页、带追踪参数的链接和明确只指向一条视频的动态，以及 Twitter/X 同一状态的等价链接，必须得到同一文章身份。普通文章对视频或推文的引用不得改变文章身份。同标题或同发布时间不能单独作为去重依据；历史别名合并必须保留未读、收藏、收件箱可见性和分析任务关联。
- RSS 新增与刷新产生的分类必须随文章写入，并能被分类统计与导出读回；单源刷新也执行同一关键词分类。未执行分类的刷新保留已保存分类，不以空值清除；文章更新不重置已读、收藏或收件箱可见性。验收包含真实 Electron SQLite 下的 `rss-classification-persistence.test.ts`。
- RSS 已保存内容的分页查询与正文读取以 `shared/rss-workspace.ts` 和 `database/rss-content-store.ts` 为共同合同；正文获取是独立动作，查询/读取不得启动网络或修改已读。翻页和续读绑定查询/文章版本，删除后同 ID 重建也不能接收旧请求结果。正文获取按 requestId 跟踪全部尚未结束的请求，退出前先取消并等待，再关闭数据库。079 迁移在现有磁盘库上先生成包含 WAL 数据的一致备份；迁移失败保留原数据。当前新读工具只对本机已绑定 local 会话开放，未授权远程读取不得回落到界面通道。
- Agent 定时任务的唯一时间与领取真值是 Main + SQLite 的 `scheduled_tasks` / `agent_schedule_occurrences`；sidecar 不再调度或镜像。每次触发先持久领取 occurrence，再按 scope 串行进入生产 Agent 主链；同一 schedule 不并发，前台运行优先，缺失 scope/Agent/workspace 时暂停或阻塞而不走兜底会话。
- 定时任务入口仍在四模式切换器右侧，但总览、编辑和历史占用中间工作区，不增加第五种 mode。打开时持有持续 BrowserView 遮罩，关闭时释放并恢复活动页；液态玻璃投影只读取背后的工作内容节点，禁止把覆盖面自身包含进投影源。
- 时间预览和真实调度共用结构化规则计算器，保存 IANA 时区；一次、日历和间隔任务遵守 DST、错过合并、稳定 occurrence id 与最小五分钟间隔合同。Renderer 只消费 Main readback，`onChanged` 只用于失效通知。

## 7. 文档与 Widget

- 附件、`@[文件]`、当前文档与引用片段先进入结构化资源层；多来源、多目标、多步骤任务先计划再执行。
- 关系图谱中可打开的文档节点必须由 Main 返回真实路径；Renderer 只对本地文档节点提供悬浮正文预览与点击打开，并沿统一工作面切换入口进入 Document，不能用文件名猜路径。
- 文档标签元数据与可恢复草稿分开持久化：标签激活不得同步重写未变化的大正文；草稿合并写入，并在页面隐藏或退出前冲刷。磁盘回读必须一次性落为 clean 内容，不能先制造 dirty 再补 saved。旧内嵌草稿快照必须无损迁移。
- 保存只提交发起写盘时的精确正文快照；写盘期间继续输入时，晚到结果不得覆盖新正文或删除新草稿。首次 clean/empty-memory 文本只由编辑器读盘一次，父级激活刷新只处理已有内存正文。
- keep-alive 的 DocumentMode 只在可见时响应文件选择。文件树、搜索和图谱已经打开的目标不得被 DocumentMode 再次 stat/open/activity；文件涌现活动只把快照标脏，刷新经空闲合并调度且同一工作区只允许一轮生成。FileTree 的涌现上下文只订阅 group/path 等结构事实，正文、dirty 与激活时间变化不得重建调度或发查询。
- H1/H2 freeform 只在命中特定触发词时使用；其他 Widget 使用结构化骨架 A-G、`relation_map` 或 `process_flow`。
- Widget 视觉唯一来源是 `src/shared/document-widget-theme.ts` 与 `document-widget-dot-charts.ts`：Ready 单橘红、mono 标签、禁饼图/彩虹/Emoji 图标；`pie` 输入渲染为合规占比形态。
- OpenUI componentSpec、骨架编译器与 iframe 基线 CSS 都走令牌。预览/导出优先从 `skeleton_spec` 或 `component_spec` 重编译；`widget_code` 只作无法重建时的兼容回退。
- iframe、接收器、导出注入与宿主 bootstrap 脚本必须使用与 `index.html` CSP 完全一致的 `WIDGET_SCRIPT_NONCE`。
- `onclick/oninput/onchange` 先由 sanitizer 改写为 `data-ready-on*`，再由 receiver 调用具名函数；静态回退与导出必须剥除事件属性。
- “信息卡、摘要卡、对比卡、关系图、流程图、图表”必须走 `document_insert_widget`，不能用 Markdown 表格或文本替换冒充。
- Widget 更新上下文优先于 live-info 判定；天气、新闻、股价、汇率、比分、航班、路况、空气质量和官网公告等实时问题必须进入网页查询工作流。
- 回归入口：`npm run verify:widget-ready`；详细设计见 `docs/superpowers/plans/2026-07-11-document-widget-ready-design-language-implementation.md`。

## 8. 行动确认、知识与专项 Agent

- 非浏览器高危工具在 authorization 后由 `agent-control/safety/action-confirmation-policy.ts` 的 M1-M4 表裁决；不得用提示词代替确认闸门。
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

- IPC 转发频道必须是可枚举的字面量或有限联合；检查器把全部成员纳入发送—接收对账，禁止用按行号登记的动态转发豁免放行。Preload 调用保持具体频道可见，成功后的通知包装不隐藏真正的 invoke。
- 主资料库连接、迁移和关闭由 `DatabaseManager` 独占；六个产品域通过 `database/*-store.ts` 取得该管理器的当前连接，共享事务，不自行打开/关闭或缓存失效连接。总管理器不恢复产品读写方法，领域 SQL 不在 Repository 与 Store 之间重复实现。连接合同与记录类型分别来自 `database/connection.ts`、`database/records.ts`。存储边界和真实读写回归走 `npm run verify:storage`。
- 新测试默认验证真实入口的可观察行为；结构测试只用于行为无法证明的硬合同。不得用 source grep 冒充行为验证，不得用 skip 当通过。
- SQLite、设置、搜索索引或本地持久化验收先跑 `npm run verify:native`；普通 Node 下 ABI skip 只说明该路径未覆盖。
- 主进程启动、日志轮转、SQLite native gate 和 `better-sqlite3` 真实加载都属于验收边界。
- Windows 必须本机重装依赖并重编 `better-sqlite3`。路径使用 `app.getPath`、`process.resourcesPath`、`path.join`、`path.delimiter`；不得带入 macOS `node_modules`、`.app`、`.dmg`、`.icns`、种子、缓存或密钥。
- Windows 开发与回传流程见 `docs/platform/windows-development.md`；测试细则见 `docs/superpowers/testing-conventions.md`。
