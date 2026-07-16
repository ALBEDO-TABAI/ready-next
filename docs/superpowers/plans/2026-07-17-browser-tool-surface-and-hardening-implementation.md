---
title: 浏览器 Agent 工具面审查与硬化改进计划
date: 2026-07-17
status: proposal（待 codex 逐单推进）
enforce: false
owner: 白
author: Claude (Fable 5)
executor: 待定（建议 Codex 逐工单施工）
scope: agent 可见的 54 个浏览器工具及其支撑引擎（src/main/modules/tools/browser-*、src/main/modules/browser-engine/*）
note: >
  本文件是审查结论 + 改进方案，enforce:false，不作为 gate。落地时每个 WS 先补机器可验证合同再改代码（架构红线 §0.5）。
  证据行号为审查当时（2026-07-17）读到的位置，codex 施工前需以当时代码复核。
---

> 目标四维：**广泛适用性**、**安全性**、**符合各平台审查规范（人味节奏 + 礼貌限流，非指纹伪装）**、**极高效率**。
> 一句话结论：底层身份、写租约、效果分类表、错误分类、采集同意存储都扎实（勿回归）；病灶集中在六处——①工具面冗余且靠 description 文字路由；②读页地图 token 与 DOM 重扫；③写入是机器速度、无节奏、无限流；④Power 授权 = 效果自证 + 审计不落盘 + 下载 SSRF + 可伪造 consent；⑤turn-lease 过期死锁 + executeJS 无超时；⑥能力缺口（标签/刷新/拖拽/弹窗/cookie）。

---

## 0. 审查方法与范围

- 覆盖 `browser-tool-catalog.ts` 的 54 个 agent 可见工具（`BROWSER_INTERACTION_TOOL_NAMES` 28 + `BROWSER_CONTENT_TASK_TOOL_NAMES` 26），执行分发 4 个 handler（act/observe/power/collection），暴露闸门 4 道，以及输入合成、Power 策略、下载、采集同意、任务生命周期、租约、页地图等支撑引擎。
- 六个维度并行独立取证（架构/清单、效率、合规节奏、安全同意、可靠生命周期），关键结论已交叉互证并由主审独立复核（输入合成、Power 策略、黑名单绕过、截图通道、暴露闸门、能力缺口、错误分类、租约 opt-in 均亲验）。
- 严重度：**P0** 安全/数据完整性；**P1** 可靠性/正确性/关键适用性；**P2** 效率/体验；**P3** 清理/文档。

## 1. 现状地图（简要）

**工具面**：54 工具 / 2 能力组 / 4 执行 handler。`executeBrowserTool`（`browser-tools.ts:483`）单一 `switch` 分派。
**暴露闸门（层叠）**：①能力组可见性（默认关，需 `browserDecisionMode` 浏览意图，`capability-resolver.ts:90-95`）；②采集意图强开 + 子集收窄（observation/collection/batch 三子集，`agent-sdk-tool-executor.ts:330-393`）；③写租约 gate（**opt-in**，仅 lane 流，`agent-browser-lease-gate.ts:36`）；④Power 执行闸（`browser-power-policy.ts`）。
**已扎实、勿回归的部分**：
- 结构化互斥错误分类（`agent-browser-errors.ts`）+ 失败类别恢复建议（`browser-power-failure.ts`）。
- 写效果静态分类表（fail-closed 判 write，合同测试保护，`browser-tool-write-classification.ts`）。
- 写租约单写者 + 用户即时接管 + `finally` 释放 + TTL 自愈（`browser-write-lease.ts`）。
- 采集同意持久化按 `requestId` 键存（`browser-collection-consent.ts`），`allow_partial` 正确惰性。
- 页地图为 `Accessibility.getFullAXTree` 去噪、长度封顶、`generation` 门控（`agent-browser-page-map.ts`）。
- 真实安全 Chromium view（`nodeIntegration:false/contextIsolation:true`），UA 去 Electron token，下载带 Referer，anti-bot `ERR_ABORTED(-3)` 容忍。**身份诚实——这是最大合规资产，勿加 stealth 伪装。**
- BrowserView hide/show/bounds 纪律在 renderer/shell 以 stale-ack 有序实现（`visibility-command-state.ts`），agent 流不占用 DOM 覆盖面、无需参与，**非缺陷**。

## 2. 缺陷清单（分类 + 证据 + 严重度）

### A. 工具面与命名（Surface & taxonomy）
| ID | 严重 | 问题 | 证据 |
|---|---|---|---|
| A1 | P2 | **prose 路由的重复簇**：点击 4（act_on_target 主 / click / click_text / click_at）、输入 5（act_on_target fill 主 / type / type_smart / compose_message / type_at）、读页 5、定位候选 5、采集下载 9、执行 JS 4。主/兜底只写在 description，无结构约束；模型靠读大段中文自我路由。 | `catalog:116-143`；`browser-act-tools.ts:1543/1585/1667/1698/1746` |
| A2 | P1 | **弃用工具仍广告给模型**：`browser_execute_js`/`browser_run_workflow` 标 `deprecated:true`，但暴露层无人消费该标记（`filterBrowserAnthropicTools` 只按名过滤）→ decision-mode 路径可见、collection-intent 路径隐藏，暴露口径不一致。 | `tool-registry.ts:503`；`catalog:294/300` |
| A3 | P2 | `browser_compose_message` ≈ `browser_type_smart`（同 `buildSmartTypeJs`，仅默认 `submit=true` 不同），近乎重复面。 | `browser-act-tools.ts:1706/1754` |
| A4 | P2 | 薄适配 `browser_download_gallery`/`browser_research_topic` 仅预设 `startTask` 的 kind/payload，与 `browser_start_task` 功能冗余。 | `browser-collection-tools.ts:1369/1387` |
| A5 | P3 | 执行 handler 4 分法与 catalog 2 组不对齐；`browser_query_gemini` 是 write（`external_submit`）却落在 observe handler 文件，文件归属与读写语义错位。 | `browser-tools.ts:633`；`browser-power-policy.ts:60` |
| A6 | P3 | schema 文件头注释过时：interaction 写"25"（实 28）、content 写"13"（实 26）、"four tools additionalProperties"（实更多）。文档漂移。 | `schemas/browser-interaction-schemas.ts:2`；`schemas/browser-content-schemas.ts:2-6` |

### B. 效率（Efficiency）
> 关键前提：`ToolExecutionOutput` 只有 text 通道（`tool-result-types.ts:35-64`），截图 base64 缓存成 write-only `image_id`、主模型永不读回 → **截图对主模型 0 token**，成本在 DOM 重扫、vision 子模型、以及读页地图 JSON。

| ID | 严重 | 问题 | 证据 |
|---|---|---|---|
| B1 | P2 | **`browser_capture_viewport` 把全分辨率 PNG 送给没有人**：写入 write-only 缓存、无图像通道回主模型，模型调它"看页面"只拿到无用 `image_id` → 死回合 + 白烧 CPU/内存。 | `browser-observe-tools.ts:210-223,682-711`；`tool-result-types.ts:35-64` |
| B2 | P1 | **读页地图是主要 token 中心（~10-18k/次，尖峰 25k+）**：`text` 封 32KB 但 `targets[]` 数组**无字节上限**；`JSON.stringify(...,null,2)` pretty-print（+10-15%）；每次调用全量重建、无 diff/无缓存，`generation` 恒自增。 | `agent-browser-page-map.ts:139-166`；`browser-observe-tools.ts:76-81,186-189` |
| B3 | P2 | settle-retry：首扫 <5 targets 时整页 + 全子帧**二次重扫**、`generation` 双增。 | `browser-observe-tools.ts:613-624` |
| B4 | P2 | **无跨调用共享快照**：`act_on_target` 每次独立重扫全 DOM 目标库 2×（probe + act），与 read_page_map 的遍历脱节。一个"定位+点击+校验"= 2-3 模型回合 + 3-8 次渲染层 DOM 遍历。 | `browser-act-tools.ts:1200,1292` |
| B5 | P2 | `probe_workflow_state` 单次 ~5-8 次独立 DOM 遍历 + 截图，无跨探针复用；唯一 1.4s 快照缓存只在 sub-agent、非主模型路径。 | `browser-observe-tools.ts:722-751`；`browser-agent-runner.ts:1343` |
| B6 | P2 | 截图取全设备像素（Retina 2×→2880×1800 PNG），vision POST 前不缩放/不转 JPEG，每次 45s 超时。 | `automation-service.ts:281-322`；`browser-vision.ts` |

### C. 平台合规与人味节奏（Compliance & cadence）
> 定位：**身份已诚实干净，短板是节奏与限流**。以下均按"可靠性 + 平台礼貌"改，非指纹规避。

| ID | 严重 | 问题 | 证据 |
|---|---|---|---|
| C1 | P1 | **写入是机器速度**：坐标点击瞬移、无移动轨迹、press/release 无停留；打字走 CDP `Input.insertText` 一次性提交（非逐字），selector 路径直写 `.value` + 合成 `input/change`；按键背靠背；滚动单次满幅；**零 timing jitter**。WP5"人味输入通道"明确未建。 | `browser-input-actions.ts:210,254,565`；`browser-act-tools.ts:2200`；`capability-service.ts:451` |
| C2 | P1 | **前台动作零限流**：只有后台 note 采集有 `interNoteDelayMs = isHighControl?3000:0`；前台 click/type/scroll/send_keys 无 per-origin 节流；所有 delay 是字面常量、无 jitter；不消费实时 429/`Retry-After` 驱动退避（`network-observer` 已看到响应但未回喂）。 | `content-task-runner.ts:1487`；`network-observer-service.ts` |
| C3 | P2 | 站点经验库 `risk_level`/`confidence` **不驱动节奏**；节奏 = 平台正则二值；无从观测（429/challenge）回写节奏的学习环。 | `browser-site-experience-store.ts` |
| C4 | P2 | `retry-policy.ts`（懂 `Retry-After`、但确定性 `base*2^attempt`、**无 jitter**）只挂 outbound HTTP，不在导航/交互路径；浏览器 stage 重试 `recoverPageState` 后立刻重打、无增长退避。 | `retry-policy.ts:39`；`browser-agent-runner.ts:233` |
| C5 | P2 | **输入信号真实性双轨不一致**：坐标路径 CDP（trusted）vs selector/smart 路径 in-page 合成事件（`isTrusted=false`）；校验 `isTrusted` 的站点上 selector 路径会**静默失效**（既是合规也是可靠问题）。 | `browser-input-actions.ts:352-364,904-940` |
| C6 | P3 | `login_wall` 检测需可见 modal + 关键词共现；整页 interstitial 登录/验证可能漏判、落 `empty_list`。 | `page-state-service.ts:237-251` |

### D. 安全与同意（Security & consent）— P0 密集
| ID | 严重 | 问题 | 证据 |
|---|---|---|---|
| D1 | **P0** | **效果自证授权**：free JS eval + raw CDP 归类"非破坏性"，Power Mode 一开即靠 model 声明的 `expected_effects` 自我授权，**无人比对声明 vs 实际行为**。`browser_power_cdp`（`Network.getAllCookies`）可导出全 partition cookie（含 HttpOnly）却标 non-destructive；`power_eval` main-world 可读 cookie/localStorage/同源认证 fetch，外泄一行代码。（Node bridge 不可达 = 好） | `browser-power-policy.ts:80-89,113-130,273-281`；`browser-power-tools.ts:400`；`automation-service.ts:329-331` |
| D2 | **P0** | **下载 SSRF + 无大小上限**：主进程 node `fetch` 无 host 过滤，`127.0.0.1`/`169.254.169.254`（云 metadata）/内网/`localhost` 全放行，绕过 session/renderer 网络策略；整 `arrayBuffer` 入内存无 cap；目标目录任意绝对路径 `mkdir -p` + `overwrite` 覆写。 | `browser-media-download.ts:334-337,392,419`；`download-service.ts:189` |
| D3 | **P0** | **可伪造采集同意**：`browser_confirm_collection_consent` 直接信任 model 传的 `request_id`+`confirmed_via`、无卡片绑定/验证；模型在拒绝载荷里就拿到 `requestId` → 自证 `confirmed_via='ask_user_questions'` → 铸造持久"用户已同意"记录。与 `action-confirmation-policy.ts:135` 的怀疑口径自相矛盾。 | `browser-collection-tools.ts:1729-1757,1553` |
| D4 | P1 | **Power 调用无落盘审计**：内存 500 环形缓冲、**执行后**写、永不 fail-closed；无 hash 绑定，`codeSummary` 截 240 字。违背 CLAUDE.md"高危动作 durable receipt"红线。 | `browser-power-policy.ts:32,155-164`；`browser-power-tools.ts:275,402` |
| D5 | P1 | **Power Mode = 回合级 + 效果不可知**：靠正则匹配用户原话开启；单能力触发词（如"下载视频"）即解锁**全部** non-destructive Power 工具（含 free eval / raw CDP），非只解锁下载。 | `browser-power-policy.ts:99-101` |
| D6 | P1 | **高控平台脚本黑名单被 Power 绕过**：`execute_js→power_eval` 转发在 `:509` 先 return，`highControlScriptGuard` 在 `:556` 只 `!legacyPowerDecision` 时跑，且 guard 不列 `power_eval/power_cdp` → 强检测平台（小红书/抖音）可注入任意 JS，**违背 §4.4 平台合规初衷**。 | `browser-tools.ts:501-527,556-581,146-154` |
| D7 | P2 | 下载目标目录无 allowed-root 约束（文件名防穿越好，但父目录任意）。 | `download-service.ts:189`；`browser-media-download.ts:334` |
| D8 | P3 | `registerBrowserPowerGrant` 无生产调用方 → 显式 grant / 破坏性效果当前不可铸（今 fail-closed）；未来 grant UI 是真正的破坏性授权面，需按合同设计。`grantUniveralAccess` 拼写 → 隔离世界 universal access 静默 no-op。 | `browser-power-policy.ts:132`；`browser-power-tools.ts:248` |

### E. 可靠性与生命周期（Reliability & lifecycle）
| ID | 严重 | 问题 | 证据 |
|---|---|---|---|
| E1 | P1 | **turn-lease 过期死锁**：一次写后 >60s（读/推理/慢工具）租约 `expired`，下一次写 `leaseId` 非空 → 跳过重取 → heartbeat 非 held → 返回 `lease_required` 且 `leaseId` 仍留 → **本回合后续所有浏览器写永久失败直到回合结束**，agent 无法自恢复。 | `agent-browser-turn-lease.ts:45-75`；`browser-write-lease.ts:81,190-195` |
| E2 | P1 | **超时策略是死代码**：`tool-execution-timeout-policy.ts` 仅测试引用；browser 工具未设 `executionTimeoutMs` → SDK 收 `undefined`；`executeJS` 无超时 → 卡死渲染器让后台轮次永挂（round 内卡 → between-round `maxDurationMs` 看门狗永不触发）。 | `tool-execution-timeout-policy.ts`；`automation-service.ts:329-332` |
| E3 | P1 | **page-map generation 导航后不失效**：只有 read_page_map 自增，无 `did-navigate`/close 钩子；相等只证"无更新读取"非"页面未变"；复用/重挂的 `backendDOMNodeId` 可命中不同语义元素 → 误操作。 | `browser-observe-tools.ts:64-84`；`agent-browser-act.ts:58-64` |
| E4 | P2 | 持久化是**无版本守卫的 `UPDATE...WHERE id=?`**：cancel ↔ loop 终写竞态可把 `cancelled` 翻回 `completed/paused`（结构确认，竞态假设）。 | `task-persistence-service.ts:203-215`；`content-task-runner.ts:1432-1447` |
| E5 | P2 | 错误面不一致：部分裸 `'Error: ...'` 串绕过结构化面；`fill/choose` 缺 `value` 误标 `target_not_found`（目标在、是参数缺）→ 消费者被误导去"重读地图"。 | `browser-collection-tools.ts:1288,1320`；`agent-browser-act.ts:65-70` |
| E6 | P1 | **写租约 gate 是 opt-in**：只有 lane-A/B 流带 gate，legacy/直接 model 调用无 gate → 单写者保护**非全局地板**。 | `agent-browser-lease-gate.ts:1-14,36-44` |
| E7 | P3 | generation/ambiguity `Map` 泄漏已关闭标签页的条目（可忽略）。 | `browser-observe-tools.ts:64-84` |

### F. 能力缺失（Missing capabilities）— 广泛适用性
| ID | 严重 | 问题 | 证据 |
|---|---|---|---|
| F1 | P1 | **无 agent 标签页管理**：无 switch/close/new_tab（`agent-runtime-adapter` 无），只 `get_tabs` + `navigate`（自建一页）。多标签研究/对照、并行打开做不了。 | `agent-runtime-adapter.ts`；`catalog:24-53` |
| F2 | P2 | 无 `reload` / `go_forward`（只 `go_back`）。卡载恢复、前进缺失。 | `catalog` |
| F3 | P1 | **拖拽内部有实现**（`Input.dispatchDragEvent`，仅文件落区）**但未开放为工具**——XHS 图序重排等（见记忆）做不了。 | `automation-service.ts:781-783` |
| F4 | P1 | **无 JS 弹窗处理**（alert/confirm/prompt/beforeunload）：只有 `setWindowOpenHandler` 管新窗；原生对话框会阻塞自动化（MCP 亦警示此风险）。 | `browser-engine/*.ts`（无 dialog handler） |
| F5 | P2 | **无 cookie/session/storage 管理工具**：会话经 `persist:browser` 分区持久，但 agent 无法保存/恢复/清除登录态、无法确定性读登录状态。 | `host-layout-service.ts` |
| F6 | P2 | 无"保存当前页为 PDF/Markdown/单文件"整页归档（有媒体下载、无正文归档）。 | — |
| F7 | P3 | `browser_query_gemini` 是站点特例硬编码，宜泛化或降级为 skill。 | `browser-observe-tools.ts:948` |

## 3. 目标工具面（重组方案）+ 逐项最优做法

**总原则**：①每个意图**一条主路径**，兜底降级为主工具的**内部解析策略**而非独立 model 工具；②**结构路由代替 prose 路由**；③**分层/渐进暴露**（core → advanced → power），默认浏览回合只见精简集；④保留能力地板非空契约（CLAUDE.md §2）。目标：54 model 可见 → ~26，Power 工具默认隐藏、授权后才现。

**T1 — 核心感知（只读，浏览时常开）**
- `browser_read_page_map`（主）：加 `unchanged-since-generation` 快路 + `targets[]` 纳入字节预算 + 紧凑 JSON（去 pretty-print）。
- `browser_read_page`（正文补充）、`browser_get_tabs`、`browser_wait_for_condition`（把 `browser_wait` 合并为 `condition=interactive`）。

**T1 — 核心行动（一主 + 显式低层）**
- `browser_act_on_target`（唯一主入口：click/expand/choose/fill/hover/type/submit）。把 `browser_click`/`click_text`/`type`/`type_smart`/`compose_message` **折叠成 target 的解析模式**（selector | text | smart | role）→ 减 5 个 model 工具（A1/A3）。
- `browser_input_at`：把 `click_at`/`type_at`/`scroll_at`/`send_keys` 合并为一个低层坐标/按键工具（action 参数），4→1，定位为"结构定位失败时"。
- `browser_navigate`、`browser_go_back`；**新增** `browser_reload` + `browser_go_forward`（F2）。
- `browser_upload_scope_attachment`（保留，好复合体）、`browser_ask_user_takeover`（保留）。
- **新增** `browser_manage_tabs`（open/switch/close）（F1）、`browser_drag`（targetId→targetId 或坐标）（F3）、弹窗处理：主进程挂 `webContents` 的 dialog 事件做**自动无害应答 + 记录**，必要时经 `browser_ask_user_takeover`（F4）。

**T2 — 定位 / 视觉（5→2）**
- `browser_locate_targets(kind: upload|send|close|back|input)`：合并 `locate_action_targets`+`locate_input_targets`+`list_upload_targets`。
- `browser_analyze_viewport`（视觉兜底）；修 `browser_capture_viewport`：或把 `image_id` 接到真正的图像块，或折叠进 analyze（今送给没有人，B1）。
- `browser_probe_workflow_state`（保留，真正的抗回合复合体；去其 5-8 次内部 DOM 重扫、把 1.4s 快照缓存暴露到主路径，B5）。

**T2 — 采集/下载（9→3 + 任务控制）**
- `browser_collect(mode: viewport|gallery|scroll|structured)`：合并 `collect_images`+`scroll_collect`+`extract_structured`+`visible_collect` 的发现段。
- `browser_collect_notes`（逐篇深采，consent-gated，保留）。
- `browser_download(source: collected_task|urls)`：合并 `download_urls`+`download_collected_media`+`download_gallery`；退役 `research_topic` 薄适配。
- 任务控制照旧（干净）：`start_task`/`get_task`/`resume_task`/`cancel_task`/`aggregate_results`/`confirm_collection_consent`。

**T3 — Power（仅 power-mode/grant 生效时暴露，否则隐藏）**
- `power_eval`/`power_cdp`/`power_network_trace`/`power_resource_forensics`/`power_script_run`/`media_download_advanced`。
- **从 model 面退役** `browser_execute_js` + `browser_run_workflow`（保留内部 compat shim，停止广告；让暴露层消费 `effectProfile.deprecated`，A2/D6）。
- `browser_stage_site_strategy` 移到后台/设置；`browser_query_gemini` 泛化或降级 skill（F7）。

**跨切面骨架（"极高效率 + 平台合规"底座）**
- 统一**人味写入通道**（WP5）：逐字插入 + 抖动 inter-key 间隔 + press/release 停留 + 鼠标移动轨迹 + 抖动 settle；**所有写入唯一走此通道**（含 selector 路径改走 CDP，消除 untrusted 事件双轨 C5）。
- **前台动作 per-origin 限流**（token-bucket + jitter），由站点经验 `risk_level`/`confidence` + 观测 429/`Retry-After` 驱动，取代平台正则二值（C2/C3/C4）。
- **Power 落盘审计 receipt**（绑 run/tab/url/hash/effect，durable，写失败 fail-closed）取代 500 内存环（D4）。
- **收口高控黑名单绕过**（guard 覆盖 power_eval/power_cdp，或在 execute_js→power_eval 转发**前**判定；高控平台脚本硬拒作为**硬地板**，Power 不可越）（D6）。
- **页地图 `targets[]` 字节封顶 + unchanged 快路 + 按 generation 键的 per-turn 已解析目标缓存**（B2/B3/B4）。

## 4. 分阶段实施（codex 工单，按 严重度 × 局部性 排序）

> 每单**先补机器可验证合同/gate 再改代码**（红线 §0.5）。跨 renderer/main/DB/文件系统边界的状态必须显式建模，禁止裸 fire-and-forget（红线 §6）。

### WS0 — 合同与度量基线（先行）
- 建 `verify:browser-surface` gate：断言 model 可见浏览器工具集合 = 目标白名单（含"deprecated 不得出现在任何暴露路径"、"Power 工具仅在 power/grant 态可见"、"能力地板非空"）。
- 建 token/round 度量夹具：对典型三流（发消息、上传、采集画板）录制 model 回合数 + read_page_map 字节，作为 WS3/WS4 回归基线。
- **合同**：白名单 + 暴露不变量的结构测试；度量基线快照。

### WS1 — 安全硬化（P0，先做，多为局部）
1. **下载 SSRF + 大小闸**（D2/D7）：主进程下载前解析目标 host，拒绝私网/环回/`link-local 169.254`/`localhost`/非公网（可配 allowlist）；流式下载 + `maxBytes` 上限 + 磁盘配额；下载根目录约束到 allowed-root。**合同**：SSRF 单元表（含 metadata IP、十进制/八进制/IPv6 变体）+ 超限拒绝测试。
2. **消灭效果自证**（D1/D5）：`power_eval`/`power_cdp` 至少标 `credential_use`/`secret_export` 潜在效果并要求显式 grant；`power_cdp` 对 `Network.getAllCookies`/`Storage.getCookies`/`Runtime.evaluate` 等按方法名归为破坏性/需 grant；Power Mode 激活从"整回合 non-destructive 全通"改为**按声明能力最小授权**（下载词只解锁下载，不解锁 eval/cdp）。**合同**：方法→效果映射表 + "声明外效果被拒"测试。
3. **收口高控黑名单绕过**（D6）：把高控平台脚本硬拒提到转发**之前**，并让 `highControlScriptGuard` 覆盖 `power_eval/power_cdp/power_script_run`；高控平台脚本硬操作作为**不可越硬地板**。**合同**：高控 URL × Power 态 × 各脚本工具的拒绝矩阵测试。
4. **同意不可伪造**（D3）：`browser_confirm_collection_consent` 只接受与真实已应答 `ask_user_questions` 卡 / UI 动作绑定的 token（卡 id ↔ requestId 绑定），拒绝纯 model 断言。**合同**：复用 `action-confirmation-policy` 怀疑口径，测"model 自证被拒 + 真实卡应答通过"。
5. **Power 落盘审计**（D4）：receipt 落 DB，绑 run/tab/url/code-hash/effect/grant，**写失败即拒调用**（fail-closed）。**合同**：审计行存在性 + 失败即拒 测试。

### WS2 — 可靠性修复（P1）
1. **turn-lease 死锁**（E1）：heartbeat 失败时清空 `this.leaseId` 并按 re-auth 规则尝试一次重取，而非返回卡死的 `lease_required`。**合同**：">60s 写间隔后仍能再次写"回归测试（假时钟）。
2. **executeJS 超时 + 轮次看门狗**（E2）：`automation-service.executeJS` 包 `Promise.race(timeout)`；给 browser 工具设 `executionTimeoutMs` 或接通 `tool-execution-timeout-policy`；后台轮次加独立于 `evaluateStop` 的 round 级看门狗。**合同**：卡死渲染器不挂任务的测试。
3. **generation 导航失效**（E3）：挂 `did-navigate`/`did-navigate-in-page`/tab-close，bump 或 clear 该 tab 的 generation。**合同**："导航后旧 targetId 判 stale"测试。
4. **写租约全局地板**（E6）：评估把 lease gate 从 opt-in 收敛为所有 agent 浏览器写的默认地板（或明确记录为何某些路径豁免）。**合同**：写调用必经 gate 的结构断言。
5. **错误面归一**（E5）：裸 `'Error: ...'` → `agentBrowserError`；`value` 缺失改专用码（如 `missing_value`）而非 `target_not_found`。**合同**：错误码互斥测试扩断言。
6. **cancel 竞态**（E4）：终写前对 `cancelledTasks` 做 compare-and-set 或版本守卫。**合同**：cancel 落在终写窗口不被翻回的测试。

### WS3 — 效率（P2，靠 WS0 基线验收）
1. **read_page_map 瘦身**（B2/B3）：`targets[]` 纳入字节预算并分页；去 pretty-print；`unchanged-since-generation` 快路（页面未变返回轻量"未变"而非重建）；settle-retry 只补扫增量。**合同**：典型页 token ↓、二次重扫消除的度量回归。
2. **per-turn 已解析目标缓存**（B4）：按 generation 键缓存 read_page_map 的解析结果，`act_on_target` 复用、免 live-probe 重扫。
3. **capture_viewport 修复**（B1）：接图像块或折叠进 analyze；避免死回合。
4. **vision 前缩放**（B6）：长边 ~1280 或转 JPEG 再 POST。

### WS4 — 工具面重组（P2，改动最大，强合同护航）
- 按 §3 折叠点击/输入/定位/采集/下载簇；退役 deprecated 与薄适配；实现分层暴露（core/advanced/power）。**必须**在 WS0 白名单 gate 下进行，保证能力地板非空、无 deprecated 泄漏、Power 默认隐藏。**合同**：目标白名单 gate 转绿 + 三流回合数不劣于基线。

### WS5 — 人味写入通道 + 每源限流（P1，合规底座）
- 统一写入通道（WP5）：逐字 + 抖动间隔 + press/release 停留 + 鼠标轨迹；selector 路径改走 CDP（消除 untrusted 双轨 C5）。
- per-origin token-bucket + jitter，读 `network-observer` 的 429/`Retry-After` 做自适应退避；站点经验 `risk_level` 参数化节奏与并发（C2/C3/C4）。**合同**：注入 429 → 观测退避；写入产生逐字 keydown 事件的行为测试。
- （合规定位说明：此为"像正常用户一样有节奏、尊重站点限流"的可靠性/礼貌改造，**非指纹伪装**；保持现有诚实真实浏览器身份。）

### WS6 — 能力补全（P1/P2，广泛适用）
- `browser_manage_tabs`（F1）、`browser_reload`/`browser_go_forward`（F2）、`browser_drag`（F3）、弹窗自动应答 + takeover（F4）、cookie/session/storage 管理 + 确定性登录态读取（F5，需明确隐私边界，见 §6）、整页归档 PDF/MD（F6）。每项走 CLAUDE.md §7"最小闭环"（Main handler + Preload + Renderer 类型/UI + 行为测试 + 单一权威文档）。

## 5. 验证与 gate 映射
- WS0：新增 `verify:browser-surface`（暴露白名单 + 地板 + deprecated 不泄漏 + Power 隐藏）。
- WS1：SSRF 表、效果映射、高控拒绝矩阵、同意绑定、审计 fail-closed 单测；涉及 SQLite 审计/同意跑 `npm run verify:native`。
- WS2：假时钟 lease/超时/generation/cancel 回归。
- WS3/WS4：token/round 度量基线对比 + 白名单 gate。
- WS5：429 退避 + 逐字事件行为测试。
- 全程 `npm run typecheck`；改动范围对应专项 gate；真实 Electron 中对 BrowserView/采集做与风险相称的回归（红线 §10）。

## 6. 待用户决策的开放问题
1. **Power Mode 激活方式**：保留"正则匹配用户原话"还是收敛为显式设置/一次性确认？（正则宽、易被单词误触，D5）
2. **工具面收敛幅度**：是否接受把 5 个 fallback 折叠进 `act_on_target`（有模型行为回归风险，需 WS0 度量护航）？
3. **cookie/session 工具的隐私边界**（F5）：允许 agent 读取/导出登录态到什么程度？默认只读登录"是否已登录"布尔，还是允许 cookie 级操作（需强 consent）？
4. **人味节奏默认开关**（WS5）：默认开启（更合规但更慢）还是按站点风险自适应开启？
5. **弃用工具**（A2/D6）：`execute_js`/`run_workflow` 是否可直接从 model 面下线（内部 compat 保留），还是需保留一个过渡期？

---

### 附：一句话优先级
先做 **WS1（安全 P0：SSRF / 效果自证 / 高控绕过 / 伪造同意 / 审计落盘）** 与 **WS2（可靠 P1：lease 死锁 / executeJS 超时 / generation 失效）**——这两批局部、高危、低回归风险；再做 **WS3 效率** 与 **WS5 人味节奏/限流**；**WS4 工具面重组** 与 **WS6 能力补全** 放最后，靠 WS0 的白名单 + 度量基线兜底回归。
