---
title: 主线回归路线 — P3 架构收口排期（真机关账 → turn-engine 退役 → 巨文件手术 → DirectChat/事件单源）
date: 2026-07-03
status: proposed
enforce: false
source:
  - docs/superpowers/plans/2026-07-02-agent-core-experience-roadmap.md（主线母文档）
  - docs/superpowers/plans/2026-07-03-P3-review-and-surgical-plan.md（Phase A-D 精确手术步骤，权威）
  - docs/superpowers/plans/2026-07-03-HANDOFF-agent-module-rework.md（岔路收口记录，梯队一至三已完成）
  - docs/superpowers/plans/2026-07-03-deferred-work-register.md（D1-D7 工单）
  - docs/superpowers/plans/2026-07-03-p1-p2-autonomous-closeout-and-retest.md（待复测清单）
purpose: >
  7-02 主线（P0 流式→P1 浏览器可靠性→P2 学习回路→P3 架构收口）在 P2/P3 之间
  岔出一条审计修正线（深审→handoff→梯队一二三），现已收口。本文核对"文档声称
  vs 仓库事实"后，把回归主线后的路线排出来。用户记忆的三大项（巨文件手术拆分、
  turn-engine 退役、agent 模块继续优化）确认为 P3 主体，但顺序和范围按实测修正。
---

# 0. 现在位置（文档 × 仓库事实对账）

| 主线阶段 | 状态 | 证据 |
|---|---|---|
| P0 流式与可见性 | ✅ 完成+真机验证 | provider 真 SSE、hold 放行、活动流、心跳、质量面板 |
| P1 浏览器可靠性 | ✅ 代码完成，**真机回归未关账** | roadmap §P1 落地状态全绿，但"三个 XHS 真机回归"从未实战（`browser_transaction_unconfirmed` 生产 0 次触发=机制未经检验） |
| P2 学习回路 | ✅ 完成（含岔路补强） | P2-1..6 + P5d 确定性迁移 + 梯队三（D2 事中自检/D5 反馈/emergence feed） |
| 岔路：审计修正线 | ✅ 收口 | 梯队一（死债）、梯队二（三态正向 gate 注册表）、梯队三（通电）；checkpoint f8682671 + 44802786 + 59936854 |
| **P3 架构收口** | ⬅️ **当前主线** | 本文排期 |

岔路的净收益归位主线：正向 gate 注册表（防"建了没接"复发）、gate-flip 纪律、
真实退出码验证纪律、~1.4k 死债清除——这些都是 P3 手术的安全设施。

> **✅ silent-catch 已回绿（2026-07-05 完成，72628891）**：重锚 + 第一批清偿落地——`check-silent-catch` EXIT=0（166→0），baseline 350→355（293 live + 62 重锚键，57 stale 移除），94 novel 逐块眼校后全部注释自证清偿（0 入 baseline / 0 补 log）。**但完整 `npm run verify` 仍未全绿**——silent-catch 红揭开后暴露两个既有拦点（均 stash/HEAD~1 基线复验与本次无关，此前被掩蔽）：`verify:ipc-contract` **19 条**（18 条 browser-engine/ipc-handler.ts + 1 条 claude-bridge/run-timeline-emitter.ts:27）+ `npm run test` **73 fail/6610**（HEAD~1 基线 75 fail、零新增）——详 §6.3。

# 1. 用户记忆三大项的核对结论

| 记忆 | 核对 | 修正 |
|---|---|---|
| "巨大文件的手术拆分" | ✅ 是 P3 主体（Phase B 系列） | 对象比记忆多：>2.6k 的源文件约 11 个；头号是 browser-tools.ts **8053**（已从 8484 抽出 probe），其次 runtime.ts 4327、runtime-manager 3800、Settings 3486、useAgent 2983、turn-orchestrator 2675（本轮 D2 后） |
| "turn-engine 的退役" | ✅ 是 P3 Phase A | 生产 **0 引用**确证（4827 行 dormant）；难点不在删码而在**253 断言契约测试的外科摘除**（冻结的是被 Stage U 取代的 2026-04-17 旧设计）+ C29/C30 有前次规划失败史。另：DirectChat **不是** dormant（live 服务容器），退役=六职责迁移，单独 Phase C |
| "agent 模块的继续优化" | ✅ 但需具体化 | = Phase C（DirectChat）+ Phase D（run-timeline 事件单源）+ 伴随线（D-register 残项、意图门控漏判专项、债务清理包、E1-E5 体验合同化） |

# 2. 排期（按依赖与风险，每阶段动工前按 §10 转当日 implementation 合同）

## Phase R — 真机回归关账（先做，短，需用户在场）

P1 的验收欠账 + 本轮新件的真机确认，一次跑完：

1. **XHS 三回归**（roadmap P1 验收原文）：发布全链（V0 纪律：重启现源、记录 commit；观察 `browser_transaction_unconfirmed` 是否如实触发/不误触发）、拖拽出视觉分析、账号采集冻结真实笔记。
2. **E1-E5 体验断言首次基线**：按 roadmap §4.1 写统计脚本（tools.log 的 read_page 连读次数→E5、账本 proof_gap 日占比→E2、静默窗→E1），产出基线数字进 quality 面板或脚本。
3. 顺手确认：ct-punc 模型包装上后 video-expert-analyzer 复跑；多步任务后 `criteria_self_check_injected` 出现（D2）；ReadyMode 涌现段有卡时可用。

**出口判据**：三回归各有一次通过记录（或失败已定位为站点/登录态问题并登记）；E 基线数字落档。

## Phase A — turn-engine 退役（A0 可无人值守；A2/A3 建议在场）

按 `2026-07-03-P3-review-and-surgical-plan.md` §3 Phase A 修正版分步，不复述细节，仅记入口与红线：

- **A0 盘点（无人值守可做）**：turn-engine 全部 export 的引用判定（dead / 需抽取 / live 另有等价覆盖）。已知同死候选：`HostCapabilityDispatcher`（唯一生产引用者就是 turn-engine，A0 一并盘点）。
- **A1 抽取 → A2 删类+专属测试 → A3 守卫测试转"文件不存在" gate**。
- **红线**：253 断言契约测试只做外科摘除（stale 的 TurnEngine-owner 断言走、live 的 DirectChat host 契约留）；每步真实退出码验证（管道教训）；`check-directchat-turnengine-dormant-boundary` gate 同步转型。
- 产出：−4.8k 源 + ~10k 测试死重；dormant 侧双运行时税清零。

## Phase B — browser-tools.ts 手术拆分（机械，可无人值守，可与 A 并行）

- 按能力缝抽组：collection / power / media / navigation / observe 各一模块，`browser-tools.ts` 保薄门面 re-export；每抽一组 typecheck+focused 绿。纯移动零行为变更（probe 抽取已验证此法）。
- 目标：主文件 <2k；每步独立可提交。
- B 完成后按同法排队：runtime.ts 4327（能力缝：crystallize/decay 调度、projection 接口、host 装配）、runtime-manager 3800、Settings.tsx 3486（renderer，需在场）、useAgent（src/renderer/stores/useAgent.ts，renderer，需在场）。**触碰 >2k 文件的工单默认附带"顺路拆出所改区域"**（roadmap §4.5 长期规则）。
- **B7 收官后的预埋缝（2026-07-05 定稿，触线即用的手术图，不主动拆）**：两个贴线模块现在内聚良好、不主动再拆，任何工单把它们推过 2k 时按此缝顺路拆——
  - `browser-act-tools.ts`（1967，距线 33 行）：缝 A=坐标输入四件套（click_at/type_at/scroll_at/send_keys，本就主要委托 browser-input-actions）；缝 B=navigate/search 对。共享守卫入口与 settle/followedTab 逻辑跟行动主体走，不进 shared。
  - `browser-collection-tools.ts`（1683）：缝=「后台任务生命周期」（start/get/resume/cancel/aggregate）vs「媒体采集下载」（collect_images/download_*）；采集共识 store 单例跟采集侧走，不可跨模块分裂。

## Phase C — DirectChat 职责迁移退役（合同先行 + 在场）

- 六职责逐个迁出（域适配器宿主 / 技能上下文 / 浏览器控制器 / sidecar / runtime / 会话生命周期），每职责一步一契约测试；全部迁完后 orchestrator 不再 `new DirectChatEngine()` → 删。
- **前置**：机器可验证合同（C29/C30 有前次失败史，红线§0.5.1）；A 完成后做（守卫测试转型后边界更清晰）。

## Phase D — run-timeline 事件单源（合同先行 + 在场）

- D1 统一事件模型 → D2 `agent:stream`+`scopeRunEvent` 收敛为投影、renderer 全派生 → D3 gate 防旁路。
- 放最后：renderer 全域改动，白屏高危；P0 的体验收益已经拿到，此项是架构地基不抢时序。

## Phase I — 微信 IM 远程完全体（2026-07-04 追加，合同先行 + 专门会话）

**目标（用户原话锚定）**："让远程接入真正好用而且能顺利完全调用 Ready 现在的所有功能"——远程 IM 通道从"能收发"升级到**能力对等**：本地会话能做的（浏览器工作流、文档、技能、任务续跑、附件资源、确认闸门），微信线程里同样能做、能看到进度、能确认。

- **现状锚**（动工前先做现状调研，逐条核实）：会话 scope 按"来源频道+线程+agent"隔离已是硬约束；飞书/远程附件先进资源层已收口；send-im 已知两层失败面（曝光闸 vs 微信 ret=-3 出站会话失效，见 LESSONS §4 与记忆）；sidecar 心跳/在线语义（§4.1"已连接≠在线"）。
- **候选切面**（现状调研后定优先级，不预设结论）：①远程侧能力面暴露差距盘点（哪些工具组/技能在 IM scope 被闸、为什么）；②远程确认链路（行动确认闸门/ask_user 卡在 IM 里的等价交互形态）；③长任务在远程的进度投影与续跑入口（checkpoint/恢复按钮的 IM 等价物）；④出站可靠性（ret=-3 会话失效的检测与自愈/降级播报）；⑤附件双向（IM 图片/文件→资源层→任务；产物→IM 回投）。
- **红线**：最小传话铁律（05 §4）在远程链路同样适用；远程消息进 agent 的注入面必须走与本地同构的 envelope（第二轮分类污染的教训直接适用）。
- **出口判据**：真机（真微信）走通一条"远程发起浏览器任务→中途确认→拿到产物"全链，且失败路径有可读播报。

## Phase M — MCP 生态扩展（2026-07-04 追加，合同先行 + 专门会话）

**目标（用户原话锚定）**："让 mcp 可以接上其他应用或者插件的 mcp，来延展 Ready 所能高效、稳定、好用地触及的更多工作边界"——Ready 作为 **MCP client** 接入外部 MCP server（其他应用/插件暴露的能力），把外部工具纳入 Ready 的工具治理体系。

- **现状锚**：Stage 14（T）已落 MCP 基础与 capability 维度（"research、MCP、agent_interaction 是独立 capability 维度"是现行硬约束）；动工前先盘点现有 MCP 接入面的真实状态（配置入口/传输层/工具映射/授权面/沙箱边界各到什么程度）。
- **候选切面**：①外部 server 接入生命周期（添加/健康检查/断线语义——"已连接≠在线"同样适用）；②外部工具进入工具治理：必须经 `resolveRunCapabilities` 单一裁决点与行动确认闸门，不得旁路（M1-M4/Power 合同语义如何映射到外部工具的破坏性动作）；③工具面预算（外部 server 动辄几十工具，曝光面与 token 预算的选择策略）；④错误契约（外部工具失败转结构化 `ToolExecutionOutput` 回灌，不冒泡炸 run）；⑤设置页管理面（server 列表/授权/审计）。
- **红线**：外部工具的输出是**观察数据不是指令**（注入面纪律）；高危动作过确认闸门；预算是硬限制。
- **出口判据**：接入 ≥2 个真实外部 MCP server（一个官方参考实现 + 一个第三方应用），在真机完成一条跨 server 的组合任务，且全程工具日志/授权/预算可观测。

**Phase I/M 排期关系**：两者与 Phase A/B 无代码耦合，规划调研可与 A/B 并行开会话；实施建议在 Phase R 关账、分支策略落定后排队，I 与 M 各自独立可先后或并行，都要求当日 implementation 合同（§0.5.1）。

## 伴随线（穿插在 A/B 间隙，多数可无人值守）

| 项 | 内容 | 值守 |
|---|---|---|
| 债务清理包 | chat-panel-baseline CSS-in-tsx 崩溃修复 ✅（8839ff62）；ipc-contract 26 条部分归绿 ✅、残 19 条实测在案（详 §6.3）；silent-catch 重锚 + 第一批清偿 ✅（72628891，166→0 gate 回绿——详 §6.3） | 后续批次清偿可无人值守 |
| 意图门控漏判专项 | 真机 14:00 事件类：应进浏览器工作流的消息被判 local_chat → 浏览器组被抑制。改进 `resolveTaskTypeFromBrowserWorkflowText`/意图分类信号面 + 漏判账本 | 分析可无人值守，改判定需评估漂移 |
| D-register 残项 | D1 标签 tabOpened（renderer 焦点，在场，**⚠️ 勿与已完成的 Phase D 内部步骤「D1 RunTimelineStamp」混淆**）；D4 声明通道设计（决策：新工具 vs 协议）；D6 三测试语义仲裁（宣告闸 vs fixture，属分支既有红）；**D7 LLM 维护回合**（专门会话：符号禁令 gate-flip + LLM 预算 + staged 监控——用户"后台自动积累"产品观的下一主件）；D19 意图门控改判定（分析定稿待实施）；涌现数据源第二批（与 D7 合并规划）。**逐项现状见 §6.2** | 各异，见工单 |
| 涌现数据源第二批 | prepare/harvest/forming 的信号采集（日历联动/产物打开跟踪/文件聚类）；与 D7 同属"后台成长"，合并规划，避免再造前台面（feedback 记忆：后台积累优先） | 设计先行 |

# 3. 分支策略（✅ 2026-07-05 已落定并执行）

原悬点：主线全部工作堆在 `feature/vertical-tabs`。**2026-07-05 用户拍板合并回主线，已执行**：因 `main` 相对 merge-base ahead=0，`feature/vertical-tabs` 纯线性领先 403 提交，走**零冲突 fast-forward**（`05c2d5a1..f959281d`），main worktree（`ready-cowork-main-fix`）合并前后均干净。合并后 `main == feature/vertical-tabs == f959281d`，分叉归零。

- **环境注记（✅ 2026-07-05 已解决）**：main-fix worktree 原 node_modules 是自有旧副本，缺 `@tabler/icons-react`/`pdf2json` 等后加依赖（8 个 `Cannot find module` typecheck error 源于此，非合并缺陷）。已按 newtab 同款约定把 main-fix 的 node_modules 改为 symlink → `ready-cowork/node_modules`（已构建好的完整树，避免 better-sqlite3 原生重编风险），旧副本移除。验证：main-fix `npm run typecheck` EXIT=0（8 error 清零）、`npm run native:check` EXIT=0（Electron 42.3.0 ABI 146 加载 better-sqlite3）。
- **后续开发（✅ 2026-07-05 晚 topology 收敛，取代上条 main-fix 过渡方案）**：因 `main == feature/vertical-tabs`（主线无支线未含的新增），**弃用独立 main-fix worktree**——已 `git worktree remove` 掉 `ready-cowork-main-fix`，把本会话所在 worktree（目录仍名 `ready-cowork-newtab`，可 `git worktree move … ready-cowork-main` 改名）`git checkout main`，并删除已全合并的 `feature/vertical-tabs` 分支。现 mainline 开发唯一 worktree = 该目录（分支 `main`，node_modules 仍 symlink→`ready-cowork/node_modules`，native:check/typecheck 已 EXIT=0 复验）；后续提交直接进 main。**heads-up**：本地 `main` 上游被配成 `origin/codex/readyguy`（非 origin/main），裸 `git push` 会推错远程，推前先确认。vertical-tabs 的 4 个 source-grep 合同残项仍登记未清（见 §6.3）。

# 4. 推荐启动顺序（07-03 原排期，已大半落地 → 见 §7）

> **⚠️ 本节为 07-03 原始排期，已过时**：Phase A/B/C/D + Phase I P0 + Phase M stdio 均已于 07-05 落地（见 §5.1.x），E1-E5 基线也已写掉。**现行下一会话顺序见 §7**，剩余活集中在 §6 台账。本节保留作历史。

1. **Phase R**（用户在场，半天）：三回归 + E 基线 + 新件确认 → 关 P1 账。
2. 并行开 **A0 盘点** + **Phase B 第一组抽取**（无人值守安全，产出证据与纯移动 diff）。
3. A0 证据齐 → 在场会话做 **A2/A3 契约外科** → Phase A 收口。
4. 债务包与意图门控专项穿插；**Phase C、D、D7 各自合同先行、在场排期**。

# 5. 进度更新（2026-07-04）

## 5.1 深夜自主推进批（2026-07-04 深夜 → 07-05 凌晨，用户授权无人值守）

### 5.1.1 续批（07-05 凌晨，B8 + I/M 调研）

### 5.1.3 R1 第十五轮（07-05 上午，第十四轮真机日志定案后）

- **第十四轮观测链首次全程可见**，日志钉死两根因（`6c04ee6d` 修复）：
  1. **升级点击点空**：escalation 两次触发（reason=closed_shadow_host ✓）、可信指针两次落 css=(569,851)、escalatedChanged=false ×2——换算视口 1026×896 后，该点在「暂存离开」与「发布」之间的**死区**：`xhs-publish-btn` host 包围盒横跨整个按钮组，rect 中心不在红按钮上。修复=升级前经 CDP 组合树命中测试（`DOM.getNodeForLocation` 穿透 closed root + `Runtime.callFunctionOn` 直接引用读文本）在 host rect 内水平扫描，与 map 目标名/disambiguation **唯一**匹配才点；多候选不盲点（误点「暂存离开」会毁流程），候选连 normalized 坐标回给模型直接 click_at。新模块 `browser-shadow-hit-test.ts`。
  2. **正文灌进标题**：02:46:59 type_at 落点死区/标题区，焦点滞留刚 fill 完的标题框，正文全文打进标题，模型盲试 4 分钟（02:51:10 改 act fill 编辑器 target 一次成功）。修复=type_at 打字前验 activeElement 可编辑性（buildFocusedEditableProbeJs），不可编辑响亮拒绝 `type_target_not_editable`；打完回读 `typedInto`（label+textHead）同轮可见落点；跨帧编辑器（kind=frame）放行不误伤。
  - 配套：clickPoint 带 host rect、pointTarget 带 tag（空 label 编辑器不再误判脱靶）、escalation 结果/日志全程含 via/pointTarget/candidates；discipline 与 XHS 站点卡填写策略翻转（**标题正文均优先 act fill target**，type_at 仅兜底且必看 typedInto；标题 textarea 自增高告诫）。
  - 合同随实现同步：probe-collect clickPoint 钉点补 rect；site-card-alignment 旧锚 `iframe/OOPIF` 重锚 `frame tree`（第十三轮卡改写遗留，HEAD 已红）。测试：三套件 77✓（新增 5 行为测试）；typecheck/verify:stability 0。
  - 下一轮复测观测点：`act escalation scan ... candidates=[...] matched=...`、`act escalation firing via=scan_name_match|scan_disambiguation_match|rect_center`、`type_at resolved ... typed=... typedInto=...`。

### 5.1.5 R1 十六轮 + 两裁决 + Phase D 收官（07-05 下午，用户授权不间断）

- **R1 第十六轮（8b1d6bb2）**：三根因毫秒级实锚——①接管闸旧假设不成立（CDP 注入会触发 before-input-event）：agent 自己的 send_keys 触发自家 pending_confirm、键被吞（模型 Cmd+A/Backspace 修复静默失效→标题区死循环）、被吞 Meta 键落穿应用菜单（两次 Cmd+A 与两次窗口缩放动画时间戳对齐）→ AgentInputPassthroughRegistry 直通登记（真实用户接管语义原样）；②R15 焦点护栏只报不拒被模型三次无视 → 容量硬拒（maxLength<文本长/单行收多段=机械拒绝）；③compose 评分器把 maxlength=64 标题排在正文编辑器前 → 容量出局+多段偏向 contenteditable+富文本判定属性化。配套：map 命名链补 data-placeholder（空 tiptap 编辑器首次有名）、send_keys 焦点回读、主窗几何观测日志。passthrough 5✓+browser-tools 71✓+probe-collect 10✓。
- **两项授权裁决（1ffba155）**：①修生产码——c8e566a4 的 projectionSummaryForEvent 通杀丢 event.message，复原 message 优先（任务卡进度保真；6/26 起的既有红归绿，追踪器邻域 72✓ 零涟漪）；②重锚测试——recall 可见性过滤已随 23d6ec9a 菜单合并下沉为 ChatHeader 逐频道过滤（语义更强），钉点随迁+hook 零消费死肢 visibleResults 摘除。
- **Phase D 当日实施完毕（b933a763）**：D1 RunTimelineStamp 信封+run-timeline-emitter 唯一发射漏斗（ipc-handler 10 处裸 send 全收编）；D2 useAgent 并行 scopeRunEvent 订阅迁入 runtimeDriver 单枢纽（今晨拆分铺平无环引用）；D3 check-run-timeline-single-source gate 挂 verify:stability 链首+行为测试三条。typecheck/gate/stability/renderer 行为网 54✓/npm run build 全绿。残余登记：reduce 级全派生纯化为后续增量项。

### 5.1.4 renderer 双拆分 + Phase C 全程收官（07-05 午后，用户授权不间断）

- **Settings.tsx 3486 → 878**（六面板 + shared 出壳至 `src/renderer/pages/settings/`，re-export 保口，14 片段零残差证明 + silent-catch snippetHash 内容级旁证；5 合同测试重锚 + silent-catch/eslint baseline 随迁）；**useAgent.ts 2983 → 2119**（agent-store-types 253 + agent-store-helpers 714，32 处 export 前缀为唯一字节差；pendingSend coalescing/agentRuntimeDriver 等引 store 簇按铁律留守；导出面 38 符号零增减）。两泳道并行子代理 + pathspec 协议，各自 HEAD 基线证明零新增失败。
- **Phase C 当日全程完成（DirectChatEngine 退役）**：C1 合同+调用面终审（ce8076b6，六职责解剖：sidecar/runCleanupRegistry/abort 机器/sessions 全暗线实锚）→ C2 DomainAdapterHost 活面平移 + parity 合同（3a0fa67a）→ C3 orchestrator 切换 + MultimodalBlock 迁 contracts 八导入方（49fb76fc）→ C4 引擎删除 + boundary gate 转存在性合同 → C5 19 处钉点三分法外科裁决（72920dc8，A 改锚 host/tool-catalog/ipc-handler/document-schemas、B 摘引擎私有约百余条、C 摘清单；document-tool-session-context 整文件删）。验证链：typecheck/boundary+三 gate/verify:stability/p6f 全绿；裁决套件 65/66。
- **升级裁决项（既有红，非本批引入，隔离 worktree 背书）**：① memory-capture 行为红——根因 `c8e566a4`（06-26）`projectionSummaryForEvent` 对非 projectionOnly 事件返回 `titleForTool()` 丢弃 `event.message`，修复需生产语义裁决（改 tracker vs 改期望）；② chat-session-recall 的 renderer 钉 `visibleSessionRecallResults` 漂移（ChatPanel.tsx:954 已无 visible 过滤），renderer 在场队列。
- **C5-b 登记（引擎删除暴露的失联簇，须逐个对照路线裁决"删 vs 待接线"，禁止bulk 删）**：`error-contract.ts`（deriveAgentErrorContract，类型+函数全零消费）、`resolveRecentSkillTaskRun`（skill 恢复 DB 兜底在 SDK live 无 provider）、`resolveExecutionIntentContext`、run-capability-controller 的 `prepareInitialRun/reconcileAfterBrowserDecision`、`applyRunBudgetHint`（预算记账"接线进行中"在案，倾向待接线）、execution-tool-config `buildToolGuidance` 系、`DesignToolLoopOrchestrator`、`VideoFallbackService`。
- **Phase D 勘察合同骨架落笔**（`2026-07-05-D-run-timeline-event-single-source-survey.md`，enforce:false）：双通道证据（agent:stream 唯一发射点 ipc-handler:1472 / publishScopeRunEvent 23 处）、D1-D3 骨架、红线（finalizeRunOutcome 不动、run-continuity 仲裁进信封）；**实施需在场**（renderer 全域、白屏高危）。
- silent-catch 账：引擎 5 条 catch 平移为 host 5 条（该 gate HEAD 即红的注册债，净零新增）；p6d 两违规（tool-runtime TOOL_ADMISSION + browser-tools ACTION_CONFIRMATION）均验证为既档/B7 拆分遗留。

### 5.1.2 B8-D 战役收官（07-05 凌晨-上午，用户授权不间断）

- **R1 第十三轮修复包**（d9073471）：升级点击的 changed 假信号压制修净（closed-shadow host 无条件升级 + 全程日志）、click_at 结果带 pointTarget 闭环坐标系误用、power_eval 表单直写劝阻注记 + 纪律/站点卡铁则。D18 权限自动拒真机首验通过（18:44:25 geolocation agent_auto_deny 无弹窗）。
- **B8-D 两泳道八批全部落地**（M1-M3 + R1-R5，两泳道并行、pathspec 提交协议、隔离 worktree 复验技法）：
  - runtime-manager.ts **3800 → 1113**：ModelPackManager(486)/MaintenanceSweeps(206)/ExternalEnvResolver(178)/SkillHostPrep(85)/SkillExecutionEngine(702)/PythonRuntimeProvisioner(377)/SkillInstallPipeline(748)/SkillJobScheduler(281)；留守=装配/委托/被安全合同硬钉的三小簇。
  - runtime.ts **4327 → 2029**：ProjectionSyncCoordinator(188)/SessionPreroute(176)/DetachedSkill(169)/SessionRecallFacade(140)/NarrationContinuation(226)/ReferenceHint(212)/Schedule(126)/ChannelConfig(225)/ScopeAttachment(129)/SidecarPoll(192)/ConversationScopeStore(254)/RemoteChannelService(1022)；终态=X 级枢纽（sendScoped/lifecycle/装配/~60 一行委托与 IPC 组一一对应）。
  - **Phase C 落点就位**：ConversationScopeStore + ProjectionSyncCoordinator 已是 typed 服务，DirectChat 会话生命周期/projection 两职责迁移有明确对接面。
  - 合同随实现同步：各批 source-grep 钉点/gate 逐处重锚（提交正文各有清单）；终封全量套件甄别出 4 处漏网钉点已补锚（含委托接线断言）。
  - 验证：每批簇套件+宽面+gate 真实退出码全绿；R5 附 verify:stability 136 tests 绿；主会话独立终验 typecheck/stability 0。


- **B8 手术图定稿**（`2026-07-05-B8-runtime-split-surgery-map.md`）：runtime.ts=hub-and-spoke（X 枢纽 ~1160 + 12 D 簇 ~2700 + P ~300）；runtime-manager=子系统工具箱（11 自足子系统，D ~2980，更好拆）；强证据=runtime 公有面与 IPC 组一一对应；Phase C 先拆后迁结论（ConversationScopeStore + ProjectionSyncCoordinator 是 C 的 typed 落点）。
- **B8-P 纯移动刀完成**：runtime.ts 4327→4133、runtime-manager 3800→3385（新 runtime-helpers/runtime-manager-types/runtime-manager-helpers/start-skill-child-run-and-wait 四文件，逐字节 cmp，778af160 + 95a3ac03）。D 级（ProjectionSyncCoordinator/ModelPackManager 打头）待在场监督。
- **Phase I 调研定稿**（`2026-07-05-phase-I-wechat-remote-parity-survey.md`）：`remote_channel` profile 是死配置（远程 run 实跑 local_chat 全量能力）；P0=远程确认链路（M2/M3/反问在微信侧静默挂死，是进度/文件回投的公共底座）；P1 进度投影+续跑、P2 ret=-3/在线语义、P3 附件双向、P4 能力面接线殿后。
- **Phase M 调研定稿**（`2026-07-05-phase-M-mcp-ecosystem-survey.md`）：合同骨架+四 gate 齐、零通电（transport stub/discovery not_implemented/注册零调用/OAuth throw）；治理缺口=外部工具破坏性动作全落 M4 放行，实施前必补动态映射；最小落地=官方 stdio server-filesystem 免 OAuth 先通主链。
- **browser-act-tools/browser-collection-tools 预埋缝**已入 §Phase B 节（触线即用，不主动拆）。


- **R1 第十二轮根因链修净（代码侧完备，待真机复测关账）**：D18 act 可信指针升级 + changed 假信号修复 + 站点权限 agent 自动拒绝（9a3993b3）；D16 文件选择器 CDP 拦截（c8f182a4）；控制闸 pending_confirm 45s TTL（66d6f501）；D9 证据链核验完整（transactionConfirmed→proof→adjudicator→finalizer，无需新码）。剩余唯一未知=真机跑通「发布点击落地→成功证据铸造」全链。
- **Phase A 完成**：turn-engine.ts(4827)+HCD 删除，12 引擎专属测试整删、12 存活文件外科（live 断言保留），boundary gate 转存在性合同，4 引擎 gate 退役、6 gate 摘引擎项，metric 死值清理，package.json 全链摘除（505e2ea2）。−15.7k 行。
- **Phase B 收官（B4-B7 全部完成，子代理串行执行）**：browser-tools.ts **6285→713**（薄门面达标，远低于 <2k 目标）。B4 Power 组（849 行，48c0b06a）→ B5 采集/内容任务组（1683 行，27212da9）→ B6 观察组（979 行 + map 状态单例迁移，95321758）→ B7 行动/导航组（1967 行含 act_on_target/D18 块逐字节搬移，978c1dfe）。共享叶子沉淀 browser-tool-shared.ts（614）。最终 facade 只剩必须留守的共享合同：Safe Mode 脚本合同预备段、attachBrowserActionSessionOutput（sitePermissionNotices 排空红线）、legacy Power 前置、catalog 导出、dispatch 骨架（lease gate + 四组委托 + catch/finally）。每组移动块对 HEAD 逐字节 cmp 证明；四 browser gate 扫描列表随组同步；主会话独立终验 typecheck/四 gate/76 测试全绿。
- **债务包完成**：chat-panel-baseline 两层崩溃修复（CSS 上移 main.tsx + harness 补 MutationObserver）；ipc-contract 归绿（十条 non_literal_push 重锚 + 六个身份通道按两表拆分登记 allowlist）（8839ff62）。
- **意图门控漏判分析定稿**：live-info 词表缺事件/活动类主题 + 无漏判账本——登记 D19（改判定需漂移评估，专门会话）。
- **分支既有红清单（HEAD 基线证实，非本批引入）**：direct-chat emitRuntimeError×2、Phase 4.4 detached taxonomy、shared-enum-drift 的 tool-runtime TOOL_ADMISSION 违规、browser-engine-services popup context、chat-panel-waterfall 单测、D6 三测试（已登记）。

### 5.1.6 R18 + Phase I P0 + Phase M stdio 先行（07-05 下午，用户授权不间断）

- **R1 第十八轮（7d20a06a）**：十七轮铁证推翻死区理论——逃生扫描已命中「发布」、坐标在按钮内、事件可信仍无变化。三盲区收口：①扫描器带 disabled/真实 rect/遮挡，act 命中 disabled 机械拒绝（target_disabled），指针无效升级组合树直接 el.click()；②delta bodyText 前 1000 字符看不见 body 末尾校验 toast——瞬时提示嗅探回传 pageNotices；③locate(send) 对 closed shadow 全盲（第一名竟是「添加商品」）——dash-tag 宿主组合树增补，「发布」进 send_button 列表（带 disabled）。click_at 回传 composedTarget/shadowCandidates/pageNotices。监督闸另一半真相：run 结束后仍吞用户点击+弹「等待确认」→ 仅 agent 驱动期生效（bounds-lock 令牌判据）+ pending 胶囊 TTL 过期补推送 + listener 去重。silent-catch 净还 2（168→166）。**待 R19 真机复测。**
- **Phase I P0 远程确认链路（7d4fd467，合同 `2026-07-05-phase-I-p0-remote-confirmation-implementation.md`）**：卡→渠道（emitter 双出口 + agent_channel_threads 反查 + 纯文本序列化）；答案→卡（入站拦截：编号/原文/前缀解析、取消词、失败回格式指引；复用唯一 submit/cancel core）。codec 7✓ + service 5✓；frozen-call login-fill 超时经 HEAD 隔离 worktree 定性为既有红。**待真微信往返验收。**
- **Phase M 第一阶段 stdio 先行（合同 `2026-07-05-phase-M-stdio-first-implementation.md`）**：stdio JSON-RPC 实装（换 stub，websocket 诚实失败）+ tools/list 发现（canonical 命名+目录）+ 启动装配（settings `mcp_servers_json`）+ **确认闸动态映射**（外部工具 readOnlyHint 才放行，其余 M2——关键治理缺口关闭）+ 每 server 24 上限可观测裁剪 + 真 schema 直出。真 spawn fixture e2e 7✓ + 家族回归 85✓ + 四 MCP gate 绿。**待真机 server-filesystem 接入验收。**

### 5.1.7 远程观察面 + MCP/CLI 安装 + E1-E5 基线 + 主线切换（07-05 下午→晚，用户授权不间断）

- **install_mcp_server 两阶段确认工具（fe3245c6，本地二进制补丁 729efe15）**：agent 代装 MCP server（用户可能只会说「帮我装 X」）。三形态源：npm 包 / `uvx:` / **本机可执行绝对路径**（Pencil.app 型自带 `mcp-server-darwin-arm64`，此前被 npx/uvx 白名单拒）。本地二进制机械准入（绝对/存在/常规/可执行 mode&0o111）+ 解释器黑名单（sh/bash/zsh/python/node/deno/env… 拒——它们等价运行任意脚本会架空确认卡）；phase2 confirmAck 回显描述符再校验；不收 env。
- **远程 run 观察面对齐 + 发送慢根治（0b42411a + 729efe15）**：16:30 真微信日志钉死三点——①路径拒绝烧 2.5min（模型给 `~/…`/`$HOME/…` 被「必须绝对路径」拒两次）→ `channel_send_file` 机械展开家目录；②本地看不到工具调用/任务卡（渠道 run 缺 `sourceMessageId`，本地 run 一直有）→ 补齐，任务卡挂载与本地同构；③回复本地显两条（渠道 assistant 持久化双属主：main onSuccess + renderer 流式）→ 渠道 scope 唯一属主定 main、renderer 只展示不落库、瞬影段被真值行收编。新工具 `channel_send_file`（domain channel/group channel_outbound，ret=-3 响亮 `channel_delivery_failed`）+ MCP 设置页真管理面（换掉 not-shipped 占位）。
- **run_setup_command 一次性安装/配置命令（257b607e，用户授权「任意命令+用户确认」）**：飞书/即梦 CLI 类跑完即退命令（≠常驻 MCP server，另一维度）。两阶段确认，**命令不经 shell**（数组式 spawn `shell:false`，元字符不被解释=根消注入），命令名元字符拒、超时（默认 180s/上限 600s）、输出 8KB 上限、非零退出转 warning 不炸 run。测试用 `npx @larksuite/cli@latest install` 锚定。
- **E1-E5 体验基线脚本（f959281d）**：`scripts/experience-baseline.cjs` 从 tools/metrics 日志产五维数字，`--assert` 对 E2 泛化失败/E5 同页连读≥3 两条硬线把关。首基线：真流式 0.727、E5 回执缺陷 0、E4 信号 66。挂 `experience:baseline` / `verify:experience-baseline`（Phase R §4.1 度量落地）。
- **分支合并 + 主线切换（4119ad23 + 77069252）**：feature/vertical-tabs 零冲突 FF 并入 main（详 §3）；主开发 worktree 切至 `ready-cowork-main-fix`（**当日晚即弃用移除、mainline 收敛到 newtab worktree，见 §3 末**），node_modules symlink→`ready-cowork/node_modules`（避免 better-sqlite3 原生重编），typecheck/native:check 双 EXIT=0（详 §3）。
- 各件行为测试随实现：channel-send-file 5✓（含 `expandChannelFilePath`）、mcp-install 8✓（含本地二进制）、run-setup-command 6✓、experience-baseline 5✓；typecheck/verify:stability EXIT=0。**注**：完整 `verify` 的 silent-catch gate 现红（166 未覆盖，refactor 搬迁历史欠账，非本批引入——详 §6.3）。


- **Phase R 七轮真机回归**：R2/R3 已过；R1 六层根因逐轮修净（执行→判定→注入呈现→感知→纪律知识→尾部偏置/容器误杀，commits 见 PROGRESS 与 checklist 文档），待重启复验「发布」进图与全链闭环；R4/R5 未跑。D 工单扩至 D1-D13。
- **Phase B**：B1-B3 完成，browser-tools 8484→~6100（净拆 + 真机修复回填）。
- **A0/A1**：证据定稿，A2 手术图就绪（在场做）。
- **新追加主线**：Phase I（微信 IM 远程完全体）+ Phase M（MCP 生态扩展），见上文两节——规划调研可与 A/B 并行，实施在 R 关账与分支决策后排队。
- dev 环境事故定案（07-04 深夜二次复核推翻旧结论）：swap 说被"重启后原样复现"证伪；真根因=tab 创建空白 primer 双导航把偶发 renderer seatbelt 初始化失败升级成 Chromium 早期 RFH 交换裸 CHECK（breakpad 符号化定位 `~RenderFrameHostImpl`）。已修：tab-lifecycle-service 删 primer 改单导航+原生涂底，真机 120s 存活验证（标签恢复+真实站点加载）。"偶发沙箱失败"已由 D15 定罪并修复：chokidar v5 在 macOS 每文件一 kqueue fd，九个工作区 watcher 灌满主进程 fd 表（实测 10572），spawn 的沙箱 socketpair 必败——file-watcher darwin 已切原生 recursive fs.watch（每根 1 fd，对照实验 5836→0）。Electron 42.3.0→42.6.0 仍作独立补丁位升级候选（非本病根治项）。盖章破签名为独立隐患，sync-dev-icon 自愈已内置。

# 6. 剩余工作台账（handoff，2026-07-05 关批后）

> P3 主体（Phase A turn-engine 退役 / Phase B 巨文件手术 / Phase C DirectChat 退役 / Phase D 事件单源）+ Phase I P0 远程确认 + Phase M stdio 先行 + 本轮三安装工具 + E1-E5 基线**均已落地并入 main**（见 §5.1.x）。本节把「仍未关」的活集中一处，供下个会话（在 mainline worktree，目录 `ready-cowork-newtab`、分支 `main`）直接接手。每项标注：值守需求 / 是否阻塞 `verify` / 动工入口。

## 6.1 真机复测欠账（需用户在场，多为「码完待验」）

| 项 | 状态 | 关账判据 |
|---|---|---|
| R1 发布全链（R18 三盲区收口） | 码净（7d20a06a），待真机复测（曾称 R19 通过，需再确认全链闭环） | 「发布」点击落地→成功证据铸造一次通过 |
| XHS 拖拽出视觉分析 / 账号采集冻结（R4/R5） | 未跑 | 各一次通过，或失败定位为站点/登录态并登记 |
| Phase I P0 远程确认（真微信往返） | 码净（7d4fd467），待真微信 | 卡→微信→答复→卡 一次闭环 + 失败路径可读播报 |
| Phase M server-filesystem 接入 | 码净（3e4611a2 stdio 先行），待真机 | settings 配一个 stdio server，跨 server 组合任务全程工具日志/授权/预算可观测 |
| MCP 本地二进制（Pencil.app 型） | 码净（fe3245c6+729efe15），待真机 | agent 装一个本地二进制 server 成功 |
| 飞书 CLI 安装（run_setup_command） | 码净（257b607e），待真机 | `npx @larksuite/cli@latest install` 经确认卡跑通 |

## 6.2 D-register 残项 + 后台成长（各异，见工单）

- **D7 LLM 维护回合（剩余最重，专门会话）**：符号禁令 gate-flip + LLM 预算门控 + staged 写卡监控。用户「后台自动积累产品观」的下一主件；与「涌现数据源第二批」合并规划（feedback 纪律：后台积累优先，勿再造前台按钮面）。合同先行、在场。
- **D1 标签 tabOpened（renderer 焦点，在场）**：`tab-lifecycle-service.createTab` 建 agent/background tab 时不发 `browser:tabOpened`（现只 popup 路径发），致 agent 建的标签不显示。**⚠️ 命名撞车**：Phase D 内部步骤「D1 RunTimelineStamp 信封」已完成（b933a763），与本 D-register「D1 标签」是两回事，勿误判已关。
- **D4 声明通道（决策题）**：`appendModelCriteria` 接裁决——新工具 vs 协议二选一，梯队二复验后缓办。
- **D6 三测试语义仲裁（已知红，登记在案）**：agent-sdk-runtime 三测试与行动宣告闸的合同碰撞（宣告闸 vs fixture 谁对）。属分支既有红，非本轮新引入。
- **D19 意图门控改判定（专门会话，需漂移评估）**：事件/活动类实时问题被判 local_chat → 浏览器组被抑制。分析已定稿（live-info 词表缺事件/活动类主题 + 无漏判账本），改判定动作未做。
- **涌现数据源第二批（设计先行）**：prepare/harvest/forming 信号采集（日历联动/产物打开跟踪/文件聚类），与 D7 同属「后台成长」，合并规划。

## 6.3 债务收敛（silent-catch 需先决策，其余多可无人值守）

- **silent-catch：✅ gate 已回绿（2026-07-05，72628891）**——重锚 + 第一批清偿完成：72 relocated 实例（62 个 file:hash 键）续锚新位置、57 stale 移除（含 11 指向已删文件），baseline 350→355；94 novel 逐块眼校后**全部注释自证清偿**（45 处前缀补标既有理由注释 / 46 处新增注释行 / 3 处行内注释；0 入 baseline、0 补 log——均为结构化降级/错误回传或已注释的 intentional swallow，无一真哑吞）。未用盲 `--update`。验证：gate/typecheck/verify:stability/move-only 全 EXIT=0。
  - **后续（分批清偿）**：baseline 剩 355 条真静默 catch 逐批补可观测、缩减 355→…。候选起点：browser-discipline-asset 载入失败降级空纪律片段（prompt-assets 家族惯例静默 fallback，已注释自证；若要失败响亮再补 warn）。「净不增/微还债」纪律作用于这一步。
- **C5-b 失联簇逐个裁决 ✅（2026-07-05 定案：0 删 / 2 待接线 / 6 留-dormant）**。普查确认 8 组均仅「定义+测试」引用、零生产消费；`agent-runtime-host-contract.test.ts`（C29 宿主 parity 合同）钉住其中 7 组——生死权属 TurnEngine/DirectChat 退役流，不在本项抢跑。逐个判决：
  - `resolveRecentSkillTaskRun` → **待接线（真 built-but-dark）**：机制已在 skill-turn-identity resume 候选链占槽（taskRunSkillRun，与 supervisor/activeContext/projection 并列），缺的只是 live host 装配处传 DB provider（optional hook 恒 undefined）。接线点=SDK 侧 ApplySkillTurnIdentity ctx 组装；接线时按 Q 三重栅栏补行为测试。
  - `applyRunBudgetHint` → **待接线在案（预算流）**：预算记账闭环进行中（checkpoint 仅耗尽写/续跑重置用量未闭环）；task-budget-runtime-alignment + run-coordinator-budget 两测试是其合同。
  - `resolveExecutionIntentContext`、`prepareInitialRun`/`reconcileAfterBrowserDecision` → **留**：P6e parity 准入测试（sdk-turnengine-capability-parity）的锚，C29 退役前置证明件；判决权归 C29/C30。
  - `deriveAgentErrorContract` → **留-dormant**：provider-thinking-echo-gate（活跃 provider 合同）以其为 oracle；SDK 路径终局错误由 error-classifier 承担，若要统一先证语义差；随 claude-bridge 相关退役包（C31-b 族）裁决。注意 claude-bridge 整体非休眠（live 路径引用 tool-bridge/error-classifier/recovery-router 等 7+ 模块），不得按模块整删。
  - `buildToolGuidance` 系、`DesignToolLoopOrchestrator`、`VideoFallbackService` → **留-dormant**：分别为 TurnEngine 工具引导面 / DirectChat 设计循环 / 视频降级（SDK 侧由共享能力层承担）；各自合同测试钉形状，随 C29/C30/C31-b 关账一并处置。
- **ipc-contract 残项**：26 条既有违规已部分归绿（8839ff62）。**07-05 实测（silent-catch 回绿后暴露）**：干净 HEAD 上 `verify:ipc-contract` 红，**19 条**——18 条集中 `browser-engine/ipc-handler.ts`（9 个 sendToRenderer 站点被两条规则各报一次：NON_LITERAL_PUSH 无 allowlist + non_literal_push 无匹配 call site）+ 1 条 `claude-bridge/run-timeline-emitter.ts:27`。它是完整 `verify` 链现在的**第一拦点**（silent-catch 之后），此前被 silent-catch 红掩蔽。
- **npm test 既有红（07-05 实测，第二拦点）**：链尾 `npm run test` **73 fail / 6610**（HEAD 72628891），HEAD~1 基线对比 **75 fail、零新增**（差 2 条为计时敏感 flaky：note-collection auto-continue 对、direct-summary redact）。失败面主要是 UI source-grep 合同断言过时（FileTree 行背景 rgba 值、glass/motion 结构等）+ discipline 资产超 2500 预算 + 若干行为测试；与 silent-catch 清偿无关（注释不改运行时）。完整 `verify` 回全绿需清这两账。
- **vertical-tabs 自身残项**：4 个 source-grep 合同待改 + 浮层跨窗拖拽未接（HTML5 DnD 跨不了窗，需 Electron 原生 startDrag）。其「D1 标签可见性」与 §6.2 的 D1 同源。

## 6.4 Phase I/M 深化（合同先行 + 专门会话）

- **Phase I P1-P4**：P1 远程进度投影 + 续跑入口（checkpoint/恢复按钮的 IM 等价物）；P2 ret=-3 出站失效检测与自愈/降级播报 + 「已连接≠在线」语义；P3 附件双向（IM→资源层→任务 / 产物→IM 回投）；P4 能力面接线（`remote_channel` profile 现为死配置，远程 run 实跑 local_chat 全量能力，盘活后按 scope 精调）。
- **Phase M 第二阶段**：OAuth / websocket 传输（现诚实 `transport_not_implemented`）、consent UI、健康检查/断线语义、外部工具面预算策略深化、设置页审计面。

# 7. 下一会话推荐顺序（取代 §4，在 mainline worktree / 分支 main）

1. ~~先关 `verify` 红：silent-catch 重锚~~ ✅ **已完成（07-05，72628891，gate 回绿 166→0）**。完整 `verify` 剩两个既有拦点（§6.3）：ipc-contract 19 条（browser-engine 集中 18 条，可无人值守裁决 allowlist vs 改字面量）+ npm test 73 fail（UI source-grep 合同过时为主，需逐类裁决「改断言 vs 改样式」，部分可无人值守）。
2. **真机复测批**（§6.1，用户在场，半天）：R1 全链 + Phase I P0 微信往返 + Phase M server-filesystem + MCP 本地二进制 + 飞书 CLI，一次跑完关账；顺带 XHS 拖拽/采集（R4/R5）。
3. **D7 + 涌现数据源第二批**（§6.2，专门会话，合同先行）：剩余最重的产品件（后台自动积累产品观）。
4. **穿插**（多可无人值守或短在场）：D19 意图门控改判定、C5-b 逐个裁决、D4 声明通道、D6 三测试仲裁、vertical-tabs source-grep 合同；Phase I/M 深化按 §6.4 各自开会话排期。
