# Ready 当前运行时硬合同

> 更新时间：2026-08-12
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
- 会话 scope id 是稳定产品身份；`aliasGeneration` 只表示 Codex 原生 thread incarnation，`messageVisibilityEpoch` 才表示当前可见上下文。停止、Browser verifier nonaccept 或 publication divergence 可以创建更高 alias generation，但不得推进可见 epoch、清除历史或阻断下一条真实用户输入；用户重置必须在同一事务内推进两轴，并清除旧消息、任务投影、召回索引、附件派生和上下文提示。每个 scoped run 在 admission 时冻结可见 epoch；所有当前产品写入都必须按该 epoch 做数据库 CAS，当前列表/搜索/UI 只读与 scope 当前 epoch 相同的行，旧行只允许具名的 exact-run 恢复或审计入口读取。远程入站合并在首个事件时冻结 `scope + messageVisibilityEpoch`，冲刷前后均必须重读当前 epoch；重置或关闭还必须同步丢弃该 scope 已合并未消费的入站、关闭它的 Browser target claim，旧合并批次和旧 claim 不得跨入新 epoch。
- 关闭会话必须在 lifecycle closeout 或 idle retirement 的同一事务内写入 scope tombstone；关闭后的 scope 不得再被列表、消息读取、搜索、准入或迟到 Renderer 事件复活。任一不可逆退役且已无运行中 turn/effect/fence 的 Codex thread 都必须生成持久归档待办；归档 owner 先精确读回 thread 已空闲，再发送 archive。响应未知时同一连接不得盲重试，新 sidecar generation 才可在重新对账后续做。远程同一自然线程之后的新入站创建新 scope incarnation，不复用已关闭历史。
- 飞书或远程图片、文件先进入会话资源层，不自动触发 Agent；后续任务必须显式选择资源。
- 系统提示词分为版本化常驻核心、按需领域/产品资料和每轮运行时事实。常驻核心的唯一来源是 `assets/prompts/core/ready-system.md`，常规 scoped run 与默认/fallback 入口必须复用同一加载器；`assets/prompts/product/about-ready.md` 只在用户询问 Ready 开发、协作背景或关注渠道时进入 L2，普通任务不得主动宣传。
- `TOOLS.md` 不进入 L0，也不代表授权；本轮最终工具定义是模型可调用能力的唯一事实。当前 Codex 生产输入只由固定的 Ready 宿主指令、本轮用户输入、显式资源与冻结工具合同组成；`USER.md`、用户画像、记忆、人格档案、路由卡与历史 Agent 资料都不进入 thread instructions、turn input 或 `additionalContext`。这些历史资料可供查阅、整理与审计，但不得改变当前 Codex 的身份、语气、路由、权限或任务行为。
- 每轮日期事实使用应用所在系统的本地日历日期与星期，同一格式器同时服务运行时提示和每日记忆文件；不得用 UTC 日期与本地星期拼接出跨日矛盾。
- 显式技能引用与本地文档资源产生代码级 capability floor。收窄过滤只能做减法，不得移除地板；最终工具面必须非空且包含全部地板。
- `current_document_context` 的地板是文档编辑面：read section、Widget 增删改查、replace exact、save tab；刻意不含整文覆写。`local_document_resource` 保持只读，提及文件不等于授予写权限。
- Codex 当前文档轮只把资源 ID、内容寻址版本、摘要值、替代关系和授权代次放进原生 `additionalContext`；文档标题、路径和正文不得进入。Renderer 在发送时冻结当前可见且聚焦的 pane/tab/path incarnation，正文只允许经 `document_read_section` 按需返回。
- 当前文档的完整合法工具面仍保留 capability floor，但本轮执行授权只签 `document_read_section`。Renderer 回执必须来自当前 Main window，读取前后都匹配同一版本；旧版本返回 `resource_version_superseded` 且正文为 0。最终回答还必须持有绑定 run/thread/turn/call/action、资源版本、tab/pane/path incarnation 的成功读取回执，缺失、失败或跨轮拼接一律不发布。
- 已存在 Codex thread 的恢复必须在同一个仍存活的 sidecar session、connection epoch、client 与 abort signal 上完成 `thread/read -> thread/resume`；读取后、恢复后和落恢复凭证前任一身份变化都拒绝本轮，不能切到新 client 续做。恢复凭证只接受 `connection_opened_at` 已存在且 `closed_at/tree_zero_at` 均为空的进程租约，凭证未同步落库不得把 thread 标为 loaded 或开始 turn。
- 固定 Codex 版本不会在 `thread/resume` 后恢复空环境选择；因此每个 `turn/start` 都必须由 host 精确携带 `environments: []`，重申无本地执行环境。缺失、非空或 caller override 都必须在写入 sidecar 前拒绝，不能靠网关删工具或等待 Codex 自行收敛。
- capability floor 的 live 权威点是 `resolveReadyToolTurnSnapshot`：它在 Codex 准入前从可信工作面、资源、技能授权与代码策略解析完整工具面和本轮 allow-set，冻结后由 thread/turn 合同与网关逐次核验。收窄只能做减法，原生 thread/turn 不得自行扩权；缺地板、空面、摘要漂移或恢复时身份不一致都必须在联网前失败。
- 同一份冻结工具快照必须同时驱动模型可见工具、dispatch authorization 与本轮能力冲突事实。只有用户或任务意图明确请求、但最终不可见的能力进入冲突提示；默认技能目录曝光、显式 false 与被抑制的运行意图不得伪造用户请求。否定浏览器表达优先于工作流与最近意图兜底，不能继承上一轮浏览器工具面。冲突只进入本轮 instructions，必须告诉模型真实原因并禁止声称“已收到授权”或“稍后自动挂载”，不得写入原生历史。
- `documentTargetGuard` 所需的 open/save 工具若不在模型可见面，由 executor 从注册表恢复执行并记录 `document_target_guard_tool_recovered`；提示文案必须与自动开存行为一致。
- typed envelope refs 是权限第一信源；只有缺失时才允许文本候选兜底，并记录 `source=text_fallback`。禁止仅靠用户原文正则决定权限。
- `run-capability-controller.resolveRunCapabilities` 与旧 SDK executor 只承担历史/支撑代码职责。不得把它们描述成 Codex live 工具面的权威裁决点。
- 回归入口：`check-capability-gate-enforced-in-arbitration.cjs`、`capability-floors.test.ts`、`document-target-guard-selfheal.test.ts`。

## 3. Skill 标准、选择与续跑

- embedded skill 由启动扫描 `assets/embedded-skills/*` 注册：优先读 `ready-skill.json`，否则读 `SKILL.md` frontmatter。目录名必须与 manifest id 或 bare skill name 一致。
- Codex 准入每轮只读取一次有效技能清单并冻结选中技能、原生 skill input、资源摘要和工具授权。`use_skill` 与其他会在同轮改变工具面的控制工具不进入 Codex 模型面；没有被当前准入选中的技能不得靠旧提示、历史目录或模型文字扩权，dispatch authorization 始终是最终闸门。
- 代码侧 `findExplicitlyRequestedSkills` 只认完整技能名或明确别名，禁止按普通任务词或 description 模糊激活。
- 选中的技能通过 pinned app-server 原生 `skill` input 进入当前 turn；模型读取方法论后必须继续完成当前任务，不能只给计划等用户再次发言。
- 外来技能的 `allowed-tools` 一律忽略并记 `ignoredFields`；工具面只由 Ready 授权层决定。未知 frontmatter 字段忽略，不因规范扩展拒绝导入。
- custom/导入技能只要带 `scripts/`，或在标准 frontmatter 通过 `metadata.requires.bins` 声明合法裸程序名，就拥有可执行面。声明程序在该技能激活轮直接可用，不增加 Ready 专属开关；未获得脚本同意时，shell allowlist 只含该技能声明的程序，不继承通用命令或 `host_requirements` 扩展。custom 自带 `scripts/` 仍按技能保存 `skill_shell_consent`，embedded skill 默认允许。路径、shell 元字符和破坏性命令不能成为声明程序。
- `skill_run_shell`、artifact 读写和 config patch 仍必须遵守沙箱、allowlist、大小上限、symlink 与保留文件约束；用户同意 shell 不等于取消这些边界。
- Codex 当前只准入无脚本技能的宿主原生 primitive；可变的 typed action、技能目录脚本以及非专用 `skill_run_shell` 必须在工具面准入前明确拒绝。`lark-cli` 是唯一允许的 shell primitive，并继续由独立的全局可执行文件权威冻结。任何会返回 `framePatch` 或 `contextModifier` 的工具（包括长技能控制和浏览器下载）在 Codex 尚未接入共享状态消费者前同样必须在工具面准入阶段拒绝，不能执行后丢弃状态却返回成功。
- `SKILL.md` 中形如 `../<skill-id>/SKILL.md` 的兄弟技能链接只在目标已注册且为 reference/advisory 时生效；Codex 准入把被授权的目标根作为只读资源固定进当前 turn，不加入 artifact 写根。不识别绝对路径、`../../`、任意文件链接或未注册目录，也不因链接自动导入外部技能。
- `~/.agents/skills` 只读发现并建议导入，绝不自动导入或写回。作者侧校验使用 `npm run skills:lint <dir>`；lint ERROR 不替代导入时的安全扫描。
- import 保持宽松：缺 id/description 时只使用既有 safeSlug 与 description 推导兜底，lint ERROR 不阻断导入；安全底线仍是 manifest 存在性、目录扫描与执行授权。
- `skill_executions` 状态机、相关 IPC 和 workflow coordinator 已退役，不得复活。历史进度仍由 task tracker、projection 与 child/detached 账本承载；Codex 不消费这些账本来启动续跑。
- LLM 可见 skill 工具只来自 manifest action 与 primitive；reference/advisory skill 以内联 `SKILL.md` 为主，`read_skill` 归一为 internal，reference hint 不能单独打开 primitive。Codex 的 host `developerInstructions` 只承载稳定的 Ready 运行约束，不嵌入技能正文。显式或本轮选中的技能由 Main 对技能目录与 `SKILL.md` 内容摘要做权威校验后，以 pinned app-server 原生 `skill` input 交给当前 turn；同一路径资源去重，恢复时摘要漂移必须在 turn 前失败。技能正文不是 `additionalContext`，也不得为了换技能改写既有 native thread 的根指令。
- Codex 无技能直答沿用共享 `direct_answer` 的 8 次工具上限；只要冻结授权已选中技能，就沿用共享 `multi_step_task` 的 40 次工具上限，并继续强制单一并行工具组。模型轮次都比工具上限多保留一次；当持久工具额度已用完或进入最后一个模型名额时，网关仍先校验完整冻结工具面，但发往上游的请求必须移除工具并强制只生成最终答复。Provider 受控续试仍是每次请求最多 6 次，不能把任务工具预算与网络续试预算混为一谈。
- `childRunId`、`detachedTaskId` 与 `outputDir + runStatePath` 只作为历史任务、产物读取和精确取消的身份；当前 Codex 不提供公开续跑入口。未来若重新引入续跑，必须至少持有这些真实句柄，只有 `taskRunId/skillId` 的空壳仍不得视为可续跑。
- child-loop action 属于子循环，父循环不得强制合成 typed tool use。embedded manifest、driver 注册与静态工具名映射必须一致。

## 4. Provider、流式与工具错误

- AI provider 能力必须由共享能力层解析；“OpenAI 兼容”不代表一定支持原生 tools、vision 或 video。通用 openai-compatible 的 `toolUseMode=auto` 必须按不支持工具收口，只有显式 `on` 或内置 provider 合同可以开放；Packer 仅可为已经真实验证过工具流的固定端点写入 `on`。
- Codex 必须从本轮冻结的 Ready 模型预设读取推理强度、显式上下文长度和显式输出上限：推理强度进入每次原生 turn 的默认协作模式设置，上下文长度进入新 thread，输出上限进入实际上游请求；续轮与启动恢复不得改读当前设置。连接测试只在真实成功响应时把 ChatGPT OAuth 标为可用，缓存凭证或 HTTP 400 都不能冒充健康连接。已按 `publication_diverged` 完整收口的旧原生 thread 不得复用；用户下一条真实输入可在同一 Ready 对话下创建绑定当前已验证 runtime/protocol 的空 generation，但不得自动重播旧消息或注入旧原生历史。升级遗留的旧合同空 generation 只有在从未准入、无 thread、无 turn、无 fence 时才可原子退役并重建；已有执行身份或栅栏时仍须失败关闭。
- OpenAI 内置预设仍以 API Key 为默认认证。`ChatGPT OAuth（实验）` 只能由用户主动连接为独立预设：授权主体是 Codex，Ready 凭证与 Codex CLI 隔离，模型服务只绑定 `127.0.0.1` 且每个请求校验随机代理口令；凭证依赖 refresh token 自动续期，已启动的本机服务随 Ready 进程保持且不因切换预设而关闭，只有显式断开才删除凭证；Provider 必须走 Ready 的无状态 Responses 适配器并在每次请求回放完整历史，不得进入官方 OpenAI 的连续响应客户端；该代理虽把流式事件体标为 `application/json`，显式 OAuth 路径仍必须按 SSE 增量消费，并在终局载荷缺少文字时用本轮增量恢复完整回答；缺凭证、口令不匹配或上游失败都必须关闭失败，不得回落到 API Key 或其他账号。
- 固定 OAuth 预设的连接、恢复、工作区保存与断开共用同一串行边界；保存执行时必须重读最新工作区，允许普通 active profile 切换保留最新 OAuth 预设，禁止旧快照新增、复活或覆盖它。该边界处于忙状态时，任何 provider 的新 Codex 准入都必须在落消息与 run 前可重试地拒绝，原子准入还要再次核验。product turn 与未 quarantine 的 pending/unknown manual compaction 都冻结它们的 upstream profile 路由；可轮换凭证，但不得删除或改写路由。
- 设置页的工具调用 `auto` 必须展示共享能力层解析出的生效值；openai-compatible 自动关闭时明确说明：端点真实支持 function calling 才可“强制开启”。聊天文字不得直接写设置。只有本轮已有 `provider_disabled_tools` 冲突、共享能力仍为关闭且用户明确肯定授权具体工具时，Main 才可复用当前轮的 `ask_user_questions` 确认卡；“打开网页”“当前打开的标签页”“使用浏览器工具”等任务动作不算设置授权。卡片只允许本机 Renderer 作答，远程绑定会话不得发起、转发或提交这类本机设置确认。确认后重新读取活跃配置，核对 active profile id + provider/baseUrl/model，只修改 `toolUseMode`；workspace、当前配置与兼容镜像在同一数据库事务内写入。配置漂移、拒绝、取消、超时或持久化失败均不写。确认只能结算仍存活的同轮 waiter；不得新建 non-user successor、自动重放原请求或复用旧工具面快照。原轮已结束时，后续任务只能由下一条真实用户输入准入。
- OpenAI-compatible 的 `baseUrl` 是 API 前缀：origin-only 地址统一补 `/v1`，显式前缀原样保留，消费者只能再拼资源路径，禁止形成 `/v1/v1`。保存和请求边界必须移除 URL 中的用户名、密码、查询参数与锚点；设置输入框保留编辑草稿。Packer 的明文 HTTP 仅允许严格解析后的本机或私网地址，不能用域名前缀猜私网。
- 一键运行时配置由 Main 持有带 `runId/revision` 的单任务快照；设置页重进只恢复投影，重复开始加入原任务。停止先进入 `cancelling`，旧 run 的晚到进度不得改写终态或后续重试，Renderer 必须提供可见的停止与失败后重试入口。
- 标准 `build:dist` 只允许空 AI seed；有意内置配置只能由 Web Packer 显式授权、临时写入并在 finally/下次启动恢复。Packer 只有在包内 seed 与本次请求一致、精简/完整运行时形态正确、Framework/签名/DMG 校验及只读挂载全部通过后才能发布成品。
- 公开网络调研统一走 `web_search_domains / web_search / web_fetch`：天气、新闻、股价、汇率、比分、航班、路况、空气质量和公开官网等实时信息默认进入该路径，不因当前工作面是 Browser 就强制使用可见 BrowserView。只有任务依赖当前登录态、当前页面或点击/输入/上传等页面交互时才由 Browser 工具执行。开启模型工具调用后，这三项以 Ready 管理的函数工具进入 Responses 主链；在网关尚未接管 hosted `web_search_call` 的完整事件与账单合同前，不得把供应商托管搜索与 Ready 函数工具混用。AnySearch、Tavily、DuckDuckGo 和 Jina 由加密的外部服务配置提供。AnySearch 垂直搜索先查询子领域参数，失败不得丢掉 domain 约束改做通用搜索；通用搜索与正文提取才允许按已启用服务显式回退。
- Codex 主请求由固定 app-server 与 Ready 网关承载；Ready 自管的 openai-compatible chat/responses、anthropic 辅助请求和独立 verifier 都必须真 SSE：文本增量交付，工具调用和推理在流中累积，终局与阻塞路径同构整形。
- Kimi Coding 的 `k3` 只走 Anthropic `/v1/messages` 主链，思考强度只允许 `low / high / max` 且默认 `high`；普通文字与工具调用都必须保留并在下一轮原样回传完整思考块和签名，请求必须声明 `keep=all` 等价的上下文保留合同。其他模型或旧版无完整身份的历史不得中途切入 K3，必须在联网前拒绝并提示新建会话。
- `provider_request_bill` 与 `provider_wire_request_bill.toolSchemaCount` 必须直接读取 provider 边界同一个实际 `ModelRequest.tools`；禁止为统计重新执行动态 `isEnabled`，也禁止用注册全集近似。注册全集只能另记为 `configuredToolSchemaCount`，差值记 `disabledToolSchemaCount`。每次请求的 input、instructions 与 tools 必须成对记录。
- 图片上下文估算区分语义下限与文本协议物理负载：无法观测字节的 opaque image ref 按单图 1600 token 下限计；data URL 与 `computer_screenshot` 按 `max(1600, base64字符数/4)` 计。K3 等把 base64 当文本送入的端点实测可由单张 1.4MB 截图超过 100 万 token，不得为了避免保守压缩而恢复“所有图片固定 1600”的低估。
- Ready 自管辅助请求的流式降级只有三类：`READY_SDK_TRUE_SSE=off` 总开关；服务返回非 SSE 时伪流式交付；仅错误体明确提及 stream 的 4xx 可单次阻塞重试。413/401/429 等语义性 4xx 必须原样冒泡；该开关不得改变 Codex app-server 主链。
- 回归入口：`npm run verify:streaming`。
- 工具错误由 dispatch 转成结构化 `ToolExecutionOutput` 回灌模型；只有 Abort 或 host 不可用等基础设施错误可以冒泡。
- Codex 动态工具的动作回执与 app-server 结果交付是两个独立持久事实。动作已确认、但原连接在响应写回完成前断开时，只允许同一 Ready run、native thread/turn/call、工具、参数与冻结合同在新连接的新 RPC 上回放已持久结果，绝不重新执行动作。每次交付保存 canonical 响应，只在底层 transport write callback 成功后确认；publication 必须从任一精确交付尝试重算 native candidate 的响应摘要。同一 live RPC 重复、旧连接仍活跃、pending/unknown 回执或任一身份/合同漂移都必须拒绝。
- 单个可选工具失败不能提前写死整轮 `proof_gap`；只有明确的交付失败、工具不可用或产物缺失可写终态失败类别，其余由最终证据统一裁决。`run_meta.last_message_text` 只用于诊断，禁止据此猜测“正文未送达”并补发；Renderer 只在消息正文仍为空时接收 send 返回文本，已有流式正文时不得追加。
- `tool_not_registered` 表示工具不存在；`authorization_denied` 表示工具存在但本轮未授权，两者互斥。
- 新 error kind 必须进入 `src/main/modules/agent-control/contracts/error-kinds.ts` 并通过对应 drift gate；日志或 metric 失败不能反过来打断请求。

## 5. Run 终止与连续性

- Codex product run 的退出只经 `ReadyCodexLifecycleAdapter` 与 canonical closeout transaction participant；终态账本、任务投影和可见消息在同一事务中提交并回读。`finalizeRunOutcome()` 只约束仍存在的非 Codex SDK/background 支撑路径，不得接入 Codex 生产主链；两类通道外写终态分别由 Codex 合同门和 `check-run-finalize-funnel.cjs` 拒绝。
- bootstrap 预算只是执行前容量猜测；零工具回合以终态 `direct_answer` 收口时必须先重绑预算，再用同一任务类型写 projection、`run_meta`、裁决和关闭指标。最终工具面含 Browser 时，bootstrap 从第一次 provider 调用起获得 220 次高额应急容量；持久研究状态出现后按结构真值重绑为 `research` 并保留已用量。70%/90% 水位只用于诊断和 UI，不再向模型注入“收敛、总结或询问是否继续”；220 只承担异常循环的最后熔断，不是健康长任务的例行分段点。显式 research、browser transaction、continuation 或 skill 预算不得被纯文本逃逸降级。
- Renderer 可以保留失败前已流出的正文，但不得把 Main 返回的 `error/adjudication_degraded` 猜成未持久化的绿色完成；合法纯回答必须由 Main 直接写成 `done`。
- 零工具的行动宣告不能直接判 done：先转向，再 checkpoint；完成判定必须基于本轮真实证据。
- Renderer 60 秒 watchdog 只是活性探针。Main 确认同 requestId 仍 active 时返回 active 并续期，Renderer 不得终止仍运行的 provider。
- Main 的 no-progress 守卫独立于 Renderer watchdog，按 requestId 仲裁；用 `main_no_progress_timeout` 区分 renderer/model/tool timeout。
- 旧 run 晚到不能覆盖同 scope 新 run；已落库消息不能显示成消息丢失。
- Codex 启动恢复在精确接管 product fence 后，必须用同一 `aliasId + aliasGeneration + readyRunId` 重建 Ready 宿主的活跃运行句柄，使恢复中工具和停止共用同一 abort signal；终态、失败或启动 generation 切换只能释放同 `readyRunId` 的句柄，不得影响同 scope 后续 run。Renderer 冷启动或重载必须先注册运行事件监听，再通过只读 IPC 消费 `CodexBindingRepository.readLifecycleOperation()` 的持久真值；只在 alias generation、readyRunId 和请求期间本地运行指纹都未变时回填，旧快照不得复活已终止轮。
- stop 在用户点击时必须携带当时活动的 `readyRunId`；close 与 reset 也携带点击时的 `readyRunId`，仅空闲态允许为 `null`。Main 的首次持久读必须与该值一致，不能把 A 的延迟请求重新解析为同 generation 已开始的 B。运行中的动作先以同一 `aliasId + aliasGeneration + readyRunId + thread + turn + action(stop | close | reset)` 写入不可变 `lifecycleAction`，再中止该 run 的宿主信号并发送 exact interrupt；Main 崩溃后 boot 按持久 action 继续，不能重新派发 Browser verifier 或工具。`interrupt_state_unknown` 不得永久禁用同一动作的精确重试：Main 先 `thread/read`，同 turn 已终态则完成对应 stop/close/reset closeout，同 turn 仍运行才重发 interrupt；身份缺失、重复或漂移继续保持 unknown。stop 退役旧 thread 后由下一条真实输入惰性创建 successor，close 同事务 tombstone scope 且不建 successor，reset 同事务创建空 generation 并推进可见 epoch；旧 run 的返回不得改写或中止新 run。
- reset/close 的 lifecycle 事务成功后，Main 必须在回答 Renderer 前用单一同步收口清理运行上下文、远程合并入站、Browser target claim、活跃技能/续跑/授权/否定、Lark 授权流、reference hint、技能投影、交互卡、会话快照和 run summary。只有 lifecycle result 与持久 scope 的 alias、新 generation 或 close evidence 精确读回一致才能进入清理，任一身份漂移都失败关闭。各清理步骤独立执行并最多重试一次；最终失败必须可观测且不得跳过后续步骤，也不得把已持久成功的 reset/close 伪报为事务失败。
- 冷启动把持久化的 `working | running` 都视为上次进程遗留。仍有精确 Codex product fence 的当前轮交给专用 recovery owner 对账；其他无主行按类型定态并释放 Browser claim。历史 checkpoint、`manual_suspend` 与 human-takeover 投影只读保留，冷启动不得把它们转成公开续跑入口、新 Owner 或 non-user successor。旧 epoch 记录只审计不写入。
- Ready 旧 Dynamic Delivery/worker/owner 编排已从 Codex 生产主链退役，设置入口与“live-required”门禁同步删除。不得为恢复该旧能力重接 `AgentSdkRuntime` 或维护第二套会话/终态机；未来的多 Agent 能力只能以 Codex native thread/item 为权威另立合同。Browser fresh verifier 是 Ready 的独立产品证据门，不等于复活旧 Dynamic Delivery。
- 多文件交付在语义复核前必须按 current-run proof 回读目标文件，检查非空、数量、声明交付项和索引链接；成功 auto-export 必须铸 artifact proof。
- `report_sources` 必须同时有带 URL 的来源发现与真实正文读取回执；页面 map 和后台句柄不算正文。
- 回归入口：`npm run verify:stability`。

## 6. 后台任务、采集与浏览器执行

- Browser Agent 负责理解目标、选择下一步和判断证据是否足够；代码只负责能力边界、状态推进、页面动作和可验证结果。链接先作为资源理解，不按站点、语言、控件文案、查询关键词或固定步骤硬编码流程。
- `assets/prompts/browser/discipline.md` 是 Browser 详细纪律的唯一稳定来源；只在最终工具面真实含浏览器能力时注入一次。普通网页搜索、未激活的浏览器环境和已被 exclusive skill 接管的轮次不得误注入。用户提出多个独立目标时，模型必须把每个目标声明为独立 required work item；一个汇总项不能代替多目标覆盖，一个证据只证明它实际读取到的目标与字段。代码不解析站点、语言、关键词或固定字段替模型做这项语义拆分。
- 浏览器激活只读取可信结构事实：当前工作面、绑定当前页面的 `browserPageRef` 和本轮技能组合。能力叠加与互斥由统一组合器决定，不从用户自然语言猜工具子集。Codex 0.146.1 只允许在 `thread/start` 注册动态工具，`turn/start` 不支持同轮追加工具；因此 Codex 必须在 turn 准入前从可信工作面与资源解析并冻结本轮 Browser 子集，并过滤 `use_browser/use_skill` 等控制工具，显式技能走原生 `skill` input。不得把控制工具放回模型面后伪称已在同轮扩权。
- `browser-capability-registry` 是公开工具名、operation、effects、运行模式和执行边界的唯一代码真值；共享语义清单和 wire schema 从同一合同派生。条件参数必须在 schema 中表达，模型自报 effects、同意或权限不能改变代码侧结论。
- 除标签管理等 management 操作外，所有页面绑定操作都必须携带可核对的父任务、Owner run、browser task、物理标签与持久 journal 路由；可信内部调用也不能绕过。路由缺失、冲突或已失效时明确失败，不新建第二套临时进度。
- 所有公开页面动作经 `BrowserActionExecutor` 进入同一执行栈：先登记动作和写租约，再由可信鼠标、键盘或直接文本通道完成物理输入并记录机械 delivery/effect。浏览器任务新开的标签固定进入该任务自己的后台 work tab，不抢用户前台；创建时已知的精确 tab id 必须随动作持久化，完整文档身份稍后到达时只允许同一 tab 的真实读取补齐因果关系。动作若在返回时仍需观察，就只标记 `needsObservation`，不能伪造 observation receipt。搜索只是“填入当前结构目标并提交”；工具返回文案、目标数量或候选数量都不能冒充动作或阅读证据。
- 输入 readiness 按 transport 分别裁决，不存在一个“当前页面全部可写”开关。稳定 ref 重解析到同一 rendered editable、精确 focus 成功且 physical target 仍存在时，direct text 可在 hidden/parked/detached host 上投递并严格回读；同一表单的结构化 `requestSubmit()` 也可用。键盘事件由 CDP 定向送到绑定 physical target，保留页面当前的 DOM 焦点所有者，不依赖 host 可见性、Ready 前台或活动 tab。detached/hidden target 只在单次受写栅栏保护的 dispatch 内临时挂到窗口外 parked host，同时使用 CDP focus emulation，结束后按原状态恢复；全程不调用 app/BrowserWindow/WebContents focus。指针、滚轮和拖拽仍只在可见、活动、前台 host 上开放。所有输入在物理投递前都必须重读同一 write admission；停止或人工接管一旦生效，不得发键，也不得产生原生聚焦副作用。
- `BrowserSnapshotService` 是页面结构与 target ref 的唯一公开真值。ref 同时绑定逻辑标签、物理 target、frame document 和 snapshot revision；完整目标集保持私有，公开快照受预算约束。页面或 frame 变化后必须重新观测，禁止按 role/name、href、站点规则或旧 generation 无声重绑后继续写。
- 主 frame 与子 frame 通过 CDP/DOM/AX 分层采集；CDP AX/DOM 是 closed-shadow、委托控件和无普通 DOM 语义目标的主要来源。DOM fallback 只收集链接、表单控件、显式 role、contenteditable 和标题等结构目标，不再因标签名带短横线、`cursor:pointer`、元素文本或 DOM 顺序猜可点击性。`browser_find` 只按结构属性、可见性、可用性、可编辑性、frame 和包含关系过滤，由模型结合上下文选择目标。截图返回真实图像。BrowserView 被 DOM 覆盖时先 hide/停放，恢复后 show 并同步 bounds；任一 show/bounds 恢复只能保留 Main 当前活动页与已声明分栏页，过期 Renderer 意图不得重新挂载旧网页。
- 点击在结构目标已唯一确定但 point probe 暂时失败时允许可信输入通道尽力投递；输入文字、上传和密码目标必须先验证真实目的地。文件上传必须显式选择一个附件、多个附件、名称或 `latest:true`，并在 input readback 中精确核对已赋值文件；禁止静默取“最新附件”。
- 搜索的 fill 和 submit 是两个独立 action：公开 `browser_type` 只填字并回读，`browser_search` 或显式的后续动作再单独提交。提交先优先使用该输入所属的精确 form；只在无可绑定 form 时才使用显式 submit target 或绑定 physical target 的 Enter。键名别名必须先归一化为 Chromium 的标准 key/code；若文字已落入而提交未送达，返回“可能已部分生效”并要求 fresh observation，不抛掉已落入的事实、不原样重试，也不升级为人工接管。提交送达与搜索结果成立分开记录，后续结果/空结果必须来自更新的绑定 observation；不导航不等于未提交，也不自动重发。快照观察到的真实 href 可带来源 ref 直接导航，不强制先点击；仍禁止合成站点 URL。
- 任一已结算但尚无因果 observation receipt 的页面动作，都会从同一 journal 派生 observe-only barrier；它不依赖 checkpoint cursor，也不另建 pending 状态。barrier 存在时终态候选不能发布，模型在同一 Owner/run/task 内最多获得一次显式观察收口机会，并自行选择合适的只读 Browser 工具；代码不自动调用 snapshot，也不写站点、语言、查询词或步骤规则。原生工具协议在一个有界调用内读回观察；文本工具桥允许一次观察响应和一次无工具的结果合成响应，两者都独立于已耗尽的普通轮次预算。观察响应中的全部调用保持只读，即使首个读取已清除 journal barrier，后续调用也不能写页面；合成响应不再开放工具。未清除 barrier 或未形成最终答复时必须持久化为明确非成功终态，候选文本保持不可见；不得生成可续跑按钮、non-user successor 或自动重放。
- 终态候选还必须核对持久研究覆盖。`research_incomplete` 时候选保持不可见，缺失 work items 作为结构事实回给同一 Owner/run/task 做有界收口；required work item 的覆盖或其绑定证据增加时刷新该同轮窗口，无关页面动作、观察和未绑定资源不得冒充研究进展。窗口耗尽仍无完整证据时写明确非成功终态；历史 `checkpoint_incomplete` 只读保留，不再表示公开可续跑能力。
- 下载只走当前浏览器 session，以临时文件流式落盘、预算校验、hash 与原子发布收口。公开地址静默跳入本地网络时拒绝，用户明确打开的内网/本地来源保持可用；输出只能进入本轮明确授权或 Ready 管理的目录。
- Power 工具效果按工具、CDP 方法、目标和输出通道机械推导，不按域名封锁。普通观察与诊断不因审计暂时失败而阻断；真实破坏性或秘密外发动作必须在执行前匹配已持久化的精确 grant。权限请求按 partition、逻辑/物理标签、Owner、任务、scope、origin 和请求身份逐项绑定，不使用全局等待队列。
- `browser_research` 只维护 `start | evidence | complete` 三类持久研究状态：建立开放 work items、把指定 observation receipt 绑定到指定字段、在完成时核对覆盖与来源。它不运行站点 adapter、固定步骤计划或后台浏览器 runner；下一页面动作始终由主 Agent 通过公开工具决定。
- browser journal/checkpoint 是动作、证据、暂停和续跑的唯一持久真值。续跑依赖原任务路由、已完成动作和未解决 work items，不继承自然语言意图副本或 collection/batch 标记。只有绑定真实页面读取的 observation resource 能成为来源证据；失败回执、工具日志、URL、标题或候选数量不能冒充正文。
- Browser suspension 的 checkpoint、Parent projection/run 状态与可见 canonical assistant notice 在同一 SQLite 事务内写入并回读。budget、steering、incomplete、provider transfer、confirmation、permission、human takeover 等原因都不得只留 transient 文案；任一写入或 digest 回读失败时整体回滚。checkpoint 进入统一终态收口前必须已携带与 DB 同 id/digest 的 canonical receipt，不得以 `success=true` 发出缺失最终可见消息的 done。
- 旧 Browser Owner/`MemorySession`/Runner 自愈路径不属于 Codex 生产图，不得成为恢复或发布权威。Codex 原生 thread、turn、tool delivery receipt 与当前 Browser journal/checkpoint 才是可恢复真值。
- Browser workflow closeout 只做一次 typed inspection，结果为 `absent | action_in_flight | observation_required | research_incomplete | sealable`。成功只能从 `sealable` 进入最终复核。Codex fresh verifier 拒绝候选时，候选保持不可见，并保存结构化 summary/gaps、被拒候选 digest 与 exact durable verifier receipt；当前没有可恢复的 non-user successor，因此不得写假 checkpoint、`canResume` 或 continue 动作。repair/block/mechanical block/invalid/provider unavailable/result unknown/identity drift 以明确非成功终态收口，且因原生 thread 历史已含未发布的 assistant turn，必须同事务退役旧 thread binding；下一条真实用户输入在同一 Ready 对话中自动建立新 generation 和空的 native root，不继承被拒候选。engine-terminal 复核正在等待时，用户停止必须先持久化绑定精确 run/thread/turn 的 interrupt，再中止同 run/scope/alias 的活跃信号，最后以 `cancelled_user` 单次原子收口；精确活跃所有者不存在时必须失败关闭，不得继续回报停止成功。完整 Codex checkpoint successor 是后续能力，在 ingress/history/resource/skill/authorization 合同全部闭合前不得宣称可用。error/cancel/interrupted 不复用成功 seal，而是在核对 child revision 与绑定后原子收口，不能留下仍为 running 的 Parent、child 或 run。`terminalQualityPatch` 属于 Parent 质量账，可以随非成功核心事务写入而不要求成功 seal；只有 Browser `done` 仍必须同时持有当前 seal、fresh verifier accept receipt 与匹配 digest，并在 canonical 事务内重读 exact settled accept receipt。
- `browser_research(action=complete)` 只在所有开放 work items 都有匹配当前文档与目标字段的有效证据时完成；正文必须来自详情页读取，列表事实只能覆盖其实际读到的字段。受预算约束的结果与证据摘要写入同一个 task transaction，重启或 rebind 后仍可核验和交付。
- 浏览器任务永久保留创建 run、活动执行绑定、父任务和 revision。Renderer 只消费 Main projection；旧 revision 不得覆盖新的真实用户轮，projection 写失败不得反向杀死真实任务。停止或用户立即接管时先同步关闭旧 Owner 写栅栏；物理接管只把 exact claim 转为 `user_owned` 或释放，不创建 checkpoint、takeover intent 或 successor。`manual_suspend`、human takeover 与旧 checkpoint 仅作历史终态投影，不得继续显示“思考中”或产生“继续 Agent”动作。下一次 Agent 执行必须由用户的新输入单独准入。
- Renderer 的暂停/等待文案只读结构真值；历史 `waitingFor`、`taskContinuation`、`resumableActions` 和 `canResume` 不能在通用 Agent 任务卡上派生继续、确认、拒绝或恢复按钮。真实 `childRunId`、`detachedTaskId` 及其专用取消/查询入口依然按各自合同工作，不得与通用 continuation 混用。计时在 checkpoint/终态冻结为“本轮用时”。
- Agent 指针层只展示真实可信鼠标动作，完全 click-through；动作终态、租约丢失、接管、标签切换、BrowserView 隐藏或 bounds 改变时清除。提示显示状态不改变任务、权限或执行状态。
- 浏览器专项回归入口是 `npm run verify:browser-orchestration`、`npm run verify:browser-surface`、`npm run verify:browser-reliability` 与 `npm run verify:browser-grounded-orchestration-native`；涉及 SQLite、下载记录或任务持久化还必须跑 `npm run verify:native`，最终另跑隔离配置下的真实 Electron live proof。完整基线一旦通过，后续局部修正保留累计证据，只复测原失败、直接风险变体和受影响 gate，不机械重跑未受影响矩阵。
- RSS 自动刷新由 Main 单实例调度，不依赖 RSS 页面是否打开；`rss:auto_refresh_interval_ms=0` 表示仅手动刷新。冷启动按持久化的最近一次 `fetchAll` 完成时间补跑或等待剩余间隔，设置保存后立即重新排期。手动与自动刷新必须复用同一个 `fetchAll` 入口和 `RSSUpdateLock`；自动结果通过状态查询与完成事件通知 Renderer，`success:false` 和部分源错误都必须保留为可见警告。
- RSS 文章在统一抓取出口按平台内容编号归一后再入库；Bilibili 视频页、带追踪参数的链接和明确只指向一条视频的动态，以及 Twitter/X 同一状态的等价链接，必须得到同一文章身份。普通文章对视频或推文的引用不得改变文章身份。同标题或同发布时间不能单独作为去重依据；历史别名合并必须保留未读、收藏、收件箱可见性和分析任务关联。
- Agent 定时任务已从 Codex 生产版退役：Renderer 入口、IPC、启动调度与执行器均不可调用。升级时只会一次性停用 `scheduled_tasks` 中的旧计划、将未完成 occurrence 定态并保留历史审计；不得恢复一条绕过 Codex 用户入场合同的后台执行链。Skills Runtime 自有的定时机制是独立能力，不受此退役影响。

## 7. 文档与 Widget

- 附件、`@[文件]`、当前文档与引用片段先进入结构化资源层；多来源、多目标、多步骤任务先计划再执行。普通远程 IM 入站只持久化消息与附件资源并把事件收口为 `done`，不得启动 Agent run、typing、模型请求或自动回复；slash command、pending ask-card 回答和 Ready 内明确出站保留独立通路。冷启动时无主的旧 `running` 事件必须标记为失败且保留原因，不得伪装成已完成或永久运行中。
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
- 行动确认与 `ask_user_questions` 的等待 resolver 与 Matrix 一样属于进程内状态；连接销毁或 Main 冷启动后必须取消，不得复活旧卡、重放动作或制造非用户 successor。统一 `app_restart` sweep 必须在 Codex product recovery 和 ingress gate 开放前完成：只有当冻结行/卡片能与未终态的 `readyRunId + task + scope + alias generation + thread binding + native thread/turn + product fence` 逐项证明同一轮时，才在同一 SQLite 事务内写入取消证据，并局部终结该 Ready parent、Browser child 与 product fence。缺少精确身份、身份不同或原 run 已终态时只取消卡/冻结行，绝不修改任何新 run，其他 scope 继续可准入。
- 普通本地对话可在输入框选择“询问授权 / 替我决定 / 全部授权”。档位按 conversation scope 持久化，并由 Main 在每轮 ingress 从本地 scope 重新读取后冻结；Renderer 消息不能自报更宽档位，远程会话固定为“询问授权”。只有规则显式标记为可委托的普通动作才会减少确认；登录、扩权、本机安装或配置修改、技能配置补丁、删除、覆盖、批量不可逆操作、任意本地文件上传和疑似敏感外发始终询问或要求用户亲自完成。富文本和结构化正文必须按实际显示顺序检查敏感内容，不能只扫描序列化字符串。飞书 CLI 的委托规则还必须绑定 Ready 已验证的可执行文件版本；版本、命令或参数合同漂移时只退回逐次询问，不得沿用旧白名单。
- 历史 `operator` 等 Agent/persona 种子、slug 冲突账本与用户编辑档案继续无损可读，但不进入当前 Codex 选择器、指令、知识或路由。`social-media-ops` 是独立的 reference/advisory 技能；截图缓存只算坐标证据，视觉判断必须走能返回分析结果的工具。
- `run_setup_command` 只在用户同时明确安装/配置类动作与 CLI、命令行、本地程序、包管理器或运行环境目标时进入模型工具面；普通 CLI 读取不得借它绕过技能执行。它的 `confirmAck` 只表示进入执行阶段，不是用户授权凭证；所有执行阶段调用必须冻结原参数并走 Ready 确认卡。CLI 授权优先使用可续接的 JSON/device-code 流程并显示可点击链接；退出码 10 的高风险重试不得自动追加 `--yes` 后执行，原始 TTY 交互仍明确不支持。
- 普通 Agent 在用户明确要求使用“飞书 CLI / Lark CLI”执行任务，或明确查询该 CLI 登录状态时，选择内置 `lark-cli` 技能；否定表达不激活也不压掉正常飞书通道。安装、配置、更新、登录或权限设置请求仍走 `run_setup_command`，安装/更新与业务操作写在同一句时也先走 setup。该技能无脚本面，只能执行声明的全局 `lark-cli` 与两个只读/反问 primitive；全局 CLI 不从 ambient PATH 选首个同名文件，而是冻结标准全局安装 payload、版本和哈希，并在每次调用前复制成校验过的私有执行快照；安装文件在调用期间被普通更新器替换不影响本次快照结果，下一次调用重新解析。当前合同防止 PATH 劫持、普通更新竞态和技能目录漂移，但不把同一登录用户下主动枚举并替换 Ready 私有快照的恶意进程伪装成已消除风险；该残余边界与桌面执行环境规划一致。代码只允许 drive/docs/sheets 与 calendar 只读查询、匹配的单一最小 scope 与指定业务 skill，其他业务域、raw API、日历写操作、业务域批量授权、广域 scope 和阻塞登录一律拒绝。专用通道只操作已在飞书内的在线资源，不接管本地附件上传/导入；CLI 本地输出只能落到技能产物目录内的相对路径，覆盖、下载、导出和本地同步都逐次确认。经固定版本验证、且参数本身能证明范围小和不覆盖已有值的纯字面量表格写入、少量行列插入、短纯文本新文档创建、单文件移动或文件夹创建可按当前本地对话档位委托；新文档正文含 URL、标签、资源或主动块及显式格式时仍逐次确认。全文查找替换没有冻结版本与唯一命中证据时也仍逐次确认，公式、富文本外链和未知结构不得自动代决。授权完成、权限扩张、本机凭据、profile/config/update/logout、本地落盘、覆盖和删除始终逐次确认或拒绝。授权发起免确认，但申请的 scope 必须精确匹配同一会话、同一技能上一条固定 CLI 命令返回的 `missing_scopes`，成功发起后立即消费该证据；返回的 device code 只在内存中保存并替换成绑定会话和技能的不透明句柄，Agent 恢复后只有精确句柄才能进入凭据写入确认，授权命令的完整输出也不得写入溢出日志。认证先读 CLI 同版本 `lark-shared`，只按真实缺失 scope 增量授权，并在普通 Agent 对话展示链接与字符二维码后等待用户确认。
- staged 信念卡、历史人格、charter、路由索引、记忆与专项 Agent 蓝图都不得进入当前 Codex prompt、轮次输入、准入判断或工具面。它们可作历史资料库与审计真值保留，任何读取失败不得阻断 Codex 入场。
- 生产 `ownerAgentId` 是从当前 scope/run 准入绑定冻结的中性宿主审计身份，不代表人格、知识或路由已注入。公开 handoff 采纳、专项 Agent 创建/改名/派生、新会话预路由和通用 continuation 入口已退役，Preload/IPC/Renderer/模型工具面均不得恢复可调用链。
- 技能子任务、detached task 和技能产物交接是独立的真实能力；只传绑定当前任务的 `userRequestVerbatim` 原文与结构化 refs，不得借文件交接恢复 Agent owner 转移、公开 successor 或第二条模型主链。
- 自动模型维护回合已退役，启动和定时 tick 只运行本地确定性 crystallize 与 belief-decay，不读 provider 配置、不启动 subagent、不发起模型请求。涌现候选只在 candidate 且证据不少于 3 条时投影。
- 浏览器失败学习只生成 staged 新卡、旁卡或风险建议卡，不能自动改写 active 站点卡。设置页只能把信念卡、站点风险、人格与知识卡标为历史/本地资料，不得提供或宣称有会改变当前 Codex 的“知识总开关”、自动路由、人格注入或自动加载记忆。后台只运行本地确定性整理与衰减，provider 调用为 0。
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
- 显式批量写回只接受带文内证据的 `proposals`，不再接受 `tags` 简写。已有词条立即归一；置信度不低于 0.92、证据中直接出现标签名的新 domain/entity/use，只受每份文档 15 个自动内容标签的安全上限约束并直接采用。达到上限后的候选直接忽略，不得仅因数量溢出进入用户确认。文档中已存在的用户标签不得再次进入反问；其余存疑项在整个文件夹确定项都写完后由宿主合并反问。同一 folder run 最多一张、最多 35 项，超出容量的低置信候选直接忽略，不制造第二张卡或无卡等待状态。卡片、批次、文档、scope、run 和精确 proposal id 必须一一绑定。用户回答只结算仍存活的同轮 waiter，不得启动新 Agent run 或 non-user successor；原轮已结束时，用户下一条真实输入才能开始后续工作。
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
