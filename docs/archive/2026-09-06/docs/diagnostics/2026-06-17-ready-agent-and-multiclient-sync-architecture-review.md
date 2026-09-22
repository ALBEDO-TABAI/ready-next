---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Ready Agent / Skill / 多客户端同步 — 深审与优化设计

> 日期：2026-06-17 ｜ 状态：**仅设计与分析，未改任何代码** ｜ 分支：agent-evolution/phase1
> 方法：三轮排查（日志/账本取证 + 三路并行代码审查 + 自核验）→ 第一性原理归并 → 架构方案 + 移动端接口预留。
> 配套诊断：
> - `docs/archive/2026-09-06/docs/diagnostics/2026-06-17-okf-bundle-no-package-and-ui-stuck-findings.md`（Problem A / B）
> - `docs/archive/2026-09-06/docs/diagnostics/2026-06-17-send-im-codex-round-layered-review.md`（send-im 分层）
> 本文是上述两份的合并、升维与前瞻（含移动端/iPad 同步接口预留）。

---

## 0. 一句话结论

我们遇到的不是一堆孤立 bug，而是**一个架构根**反复发作：**Ready 的 agent runtime 实质是一个状态权威的 server，但本地 renderer 把自己当权威、靠 fire-and-forget 事件消费运行态；判定/技能授权层又没有对"执行形态"和"显式附着"显式建模。** 这个根同时解释了 UI 卡死、send-im 失败、以及未来手机/iPad 同步会十倍放大的风险。把状态层做成 **client-agnostic（server 权威 + client 对账）** 是正确方向；但 send-im 仍有独立的 L1 链路缺口（授权、工具名、资源、多文件、判定），不能只靠同步架构顺手解决。

---

## 1. 前因后果（三轮脉络）

### 1.1 第一轮 — 用 okf-bundle 提知识
- **Problem A（UI 卡死）**：run 后端已 `done`/`success=true`，renderer 仍"思考中"、停止键失效。根因：renderer 只靠实时终态 IPC 事件清 `isStreaming`，**无投影对账兜底**；主进程终态事件 `webContents.send` 是 fire-and-forget（只 `!isDestroyed()` 守卫）。停止键不是权威对账手段：当前 renderer 点击时会先本地清前台状态再发 `agent:kill`，若仍卡住，应继续查 busy 判定、后续事件回灌或投影重建，而不是假设主进程返回 `killed:false`。
- **Problem B（无知识包）**：okf-bundle 被声明 `runtime:reference/advisory`，无执行面（无 python typed action / child_loop），通用 primitive 又被 advisory fence，agent 退化用 document 工具写单份文档。

### 1.2 第二轮 — Codex 修了一轮，send-im 仍失败
Codex 这轮（28 文件 / +1606 行）方向是**远程 IM/send-im 新功能** + commit `ff92577e fix(agent): support script-backed reference skills`。用户 `@[Send IM] 把这四张图发到我微信`，结果："本次会话没有可调用的 skill 执行工具" + 任务判 `直答`/失败。

### 1.3 三路审查 + 账本核验
三路 reviewer（暴露 / 执行 / 横切）一度分歧；自核验账本后定调：失败不是单因，而是**三层叠加**（见 §2）。

---

## 2. 观察到的问题和缺口（分层 + 证据 + 判定）

> 标注：`[确证]` 有日志/账本/代码三角证据；`[待核实]` 有强证据但需再确认；`Codex新增` / `既有` 表示责任归属。

### L0 系统级（爆炸半径最大，先于功能）
- **A1 Problem A（UI 卡死）未修，仍在。** `[确证][既有]` `runtimeDriver.ts`/`ipc-handler.ts` 不在本轮 diff。
  - 证据：`runtimeDriver.ts:1467-1485`（仅实时终态事件清 `isStreaming`）；`ipc-handler.ts:1557-1568`（fire-and-forget 转发）。
- **A2 判定器过严 / 命名与行为分裂。** `[待核实][既有/疑近期 enforce]` 按北京时间日界、排除用户取消 run，今天 23 个 closed run 中 **9 个**被改判 `adjudication_degraded`，含一个 0 工具的"直答"（ckxwcl）。源码注释仍写 `shadow semantics` 不改变生命周期，但当前 `run-finalizer.ts` 已会把 `done` 改成 `error/adjudication_degraded`；测试也在断言这个降级行为。`direct-skill 的 s1 改判`是确证 bug（见 D1）；"整体是否过严"需对 new-vs-baseline 再确认。

### L1 功能阻断（send-im 要能用必修，全部 `[确证]`）
- **D1（keystone）判定 overlay 把 direct-mode skill 当长任务。** `Codex新增 collision / 既有 overlay`
  - 机制：调 `skill_*` → 任务行 `module='skill'` → 追加 `skill` overlay 准则 **s1**（`run_state.json 终态 done 且 delivery_report 存在`）→ direct-mode 的 send-im 直接返回 `ToolExecutionOutput`、**永不写 run_state.json/delivery_report** → s1 永远不满足 → run 改判 `adjudication_degraded` → 上抛 `Agent execution failed`。
  - 账本实证：`req-1781697937533-78euqa … blockers:["criteria_unsatisfied:s1"] … run_close terminalReason:adjudication_degraded toolCallsUsed:5`。
  - 责任：s1 准则是给 child-loop/python 长任务（video-expert 会写 run_state.json）设计的；Codex 新增首个"direct 纯工具"skill 却没和既有准则对账。`markNotApplicable` 当前 0 调用方。
- **D2 暴露：`@[skill]` 显式附着不为本轮授权 direct skill。** `既有设计缺口`
  - 机制：live 授权只认本轮文本经 `findExplicitlyRequestedSkills` 触发；`@[Send IM]` 提及被抽走后，剩余文本无技能字面 token、四图也非 `@[文件]` → `no_skill_signal` → 砍掉所有 `skill_*`（20:05 那次触发到了、14:14/14:24 没触发）。direct skill 不是 reference-like，不进 reference-hint、也无 sticky active-context。
  - 证据：`tool_capability final_tools` 三快照（61 带 `skill_send_im_send_file` / 78 / 56 各 0 skill 工具）；`skill-context-orchestrator.ts:98-143,462-465`。
- **D3 文件解析 + 多文件。** `Codex新增`
  - 机制：`resolveFile` 只认 `requestEnvelope.resources`（composer 附件/引用）+ `@[]` 提及；浏览器下载文件**不进 resource 层**；`selectResource` 仅在精确名匹配或 `resources.length===1` 时返回；多文件无 fan-out（单次单文件，SKILL.md 没说发 N 次）。
  - 证据：`send-im-skill-tool.ts:80-94,144-188`；`agent-control/contracts/request-envelope.ts:255-392`。

### L2 潜伏陷阱（`[确证]`，当前 latent）
- **D4 工具名三处打架。** `Codex新增`
  - live 自洽用 `skill_send_im_send_file`（`buildToolName` 读 `STATIC_TOOL_NAMES`，其中**无** send-im 条目，回退默认名）；Codex 把 `skill_send_im_file` 加到了**另一张表** `STATIC_SKILL_TOOL_NAMES_BY_ACTION`，manifest `allowed_tools` 与 SKILL.md 也写 `skill_send_im_file`。
  - 影响：今天无害（live 不读 `allowed_tools`）；但 SKILL.md 误导模型叫错名 → 若照做则 `tool_not_registered`；policy/turn-engine 路径一旦启用，`filterToolsByAllowedTools` 会按错误名把工具清零。
  - 证据：`skills-tools.ts:128-151`、`skills-tools-static.ts:36`、`send-im/ready-skill.json:8`、`send-im/SKILL.md`。

### L3 测试诚信（`[确证]`）
- **D5 两个新测试 pin 了错误名 / 走 stub & fallback，绿但假。** `Codex新增`
  - `tool-registry-skills-dynamic-resolution.test.ts`：靠让 dynamic 抛错走 static fallback 才断到 `skill_send_im_file`；`skill-context-orchestrator.test.ts`：hardcode 返回 `skill_send_im_file`。两者都测不到 live 实际暴露名，也抓不到暴露丢失。`send-im-skill-tool.test.ts` 直接调 `executeSendImFileTool`、手喂单 resource，绕过暴露/授权/判定/多文件。
- **D6 silent-catch gate 违规。** `Codex新增（轻）` `send-im-skill-tool.ts:297` catch 功能上返回结构化 `send_failed`（不算对模型静默），但缺注释/日志，被 `check-silent-catch.cjs` 命中（该 gate base 已红）。

### L4 未验证（需真机微信）
- 图片 `image_item` 上传协议（`mid_size` 用密文长度、`no_need_thumb:true`）；send-to-self 依赖 `to_user_id==self`（无 filehelper 兜底）；inbound 附件下载 `except Exception: return None` silent drop（仅入站）。`wechat_openclaw_adapter.py:413-417,441-527,829-851`。

### Problem B（okf-bundle）状态：部分修复
commit `ff92577e` 加 `explicitReferenceSkillHasScripts()`：reference+`scripts/` 的 skill 放行 `skill_run_shell`(+write/read artifact)。但 okf-bundle 仍产不出包：`okf_tools.py` 只 validate/scan/index、不写 bundle；`SKILL.md` 从没提 `skill_write_artifact`/`skill_run_shell`，给的是裸 `python …` 与假定环境写。**runtime "给"了 primitive，skill 指令没"用"。**

---

## 3. 思考逻辑（第一性原理：把缺陷归并到一个根）

把上面所有项摊开问"它们共享什么"：

1. **A1（UI 卡死）** = renderer 把"运行态"当本地权威，靠 fire-and-forget 事件，丢一帧就永久错。
2. **A2 + D1（判定器/overlay）** = 判定准则没对"执行形态"建模（direct 纯工具 vs 长任务写盘），一刀切。
3. **D2（暴露）** = "显式附着 `@[skill]`"这个用户意图没被显式建模成"本轮授权状态"，而是每轮从文本重推断。
4. **D3（文件解析）** = 跨边界产物（浏览器下载文件）没进统一 resource 层，下游拿不到。
5. **移动端诉求** = 想让"第二/第三个 client"看到运行态/文档态/内容——而这些状态有的是 server 权威（可同步）、有的是 renderer-only（同步不了）。

**共同根**：**跨边界、跨客户端的状态没有被显式、权威、可对账地建模**——正是 CLAUDE.md §0.5 第 6 条红线（"renderer/main/DB/文件系统/父子任务等跨边界状态必须显式建模，不允许裸 fire-and-forget 靠重试碰运气"）和"终态账本与可见收口原子完成"。

**升维洞察**：runtime 已经是个状态权威 server（scopes/messages/projections/run_meta/settings 全在 SQLite）。**renderer 只是第一个 client；Feishu/微信 sidecar 是第二个（无界面）client；手机/iPad 是第三个 client。** 既然如此，正确做法不是给每个客户端各写一套同步，而是**把状态层做成 client-agnostic：server 持有权威 + 变更流，所有 client（含 renderer）都退化成"对账式订阅者"。** 这一步同时：
- 修 A1（renderer 不再 fire-and-forget，改对账）。
- 给 A2/D1 一个干净的准则维度（按执行形态裁决）。
- 给移动端复用同一套状态地基（mobile = 又一个订阅者），但这需要单独合同与回归，不是 send-im 修复的免费副产物。

---

## 4. 修复与优化方案

> 目标（用户要求）：优化后各功能正常、架构最优、效果最好、执行高效。
> 设计原则（遵 CLAUDE.md §0.5）：**先合同后代码；修根因不修症状；client-agnostic 不写客户端分支；CI 强制优先于文档约束。**

### 4.1 L1 send-im 功能链（最小闭环，先让"发图到微信"真能跑通）

按依赖排序，每项给"合同 → 改向 → 验证"。

**① D1 keystone — 判定 overlay 按执行形态裁决**
- 合同：`resolveCriteria(taskType, module)` 对"direct-mode/tool-only skill 执行"不得追加 `skill_run_state`（s1）类准则；或 s1 的 matcher 把"direct 执行成功的 tool_result(status=done)"视为满足/不适用。
- 改向（二选一，推荐后者，证据链更稳）：
  - (a) `scopeRunModuleForTool` 对 direct-mode skill 不 stamp `module='skill'`，但这会把技能工具事件混入 `system`，容易让投影/时间线/后续审计更难追；不建议作为首选。
  - (b) 给 s1 准则加"执行形态"维度，direct 执行走 `markNotApplicable`，或让 direct skill 的成功 `ToolExecutionOutput(status=done)` 满足对应判据（顺手补上 `markNotApplicable` 的 0 调用方）。
- 验证：行为测试——构造 direct skill 调用成功 → 断言 run 终态非 `adjudication_degraded`、无 `criteria_unsatisfied:s1`。回归 `verify:stability`。

**② D2 暴露 — 显式 `@[skill]` 附着 = 本轮授权**
- 合同：当本轮存在显式 `@[skill]`（任何 runtime 类型，含 direct），该 skill **必为本轮 explicitly-requested**，不依赖剩余文本重推断；附着信息不得在 mention 抽取后丢失。
- 改向：把 `@[skill]` 附着落成一个 per-turn `activeSkillContext`（direct skill 也可有），在 `resolveSkillAuthorizationForTurn` 里优先于文本推断；或让 `findExplicitlyRequestedSkills` 读"附着列表"而非仅剩余文本。
- 验证：行为测试——`@[Send IM] 把这四张图发到我微信` → 断言 final_tools 含 `skill_send_im_send_file`。

**③ D3 文件解析 + 多文件**
- 合同：浏览器/工具下载产物进入会话 resource 层（与 CLAUDE.md "飞书/远程图片先进资源层"一致）；`send_file` 支持多文件（`filePaths[]` 或目录+glob）；多候选无名匹配时返回**结构化 disambiguation**而非 flat `file_not_found`。
- 改向：下载工具写 resource 层；`send-im-skill-tool` 接受多路径并 fan-out（或在描述里明确"一次一文件、模型自行多调"）；`selectResource` 返回候选列表。
- 验证：行为测试——4 下载图 + "发到我微信" → 断言 4 次发送意图被解析（或一次多附件）。

**④ D4 名字统一（cheap，去潜伏陷阱）**
- 合同：一个 skill action 全链**单一工具名**（exposure = authorization = dispatch = manifest allowed_tools = SKILL.md = 测试）。
- 改向：把 `'send-im:send_file'` 也加进 `STATIC_TOOL_NAMES`（`buildToolName` 真正读的表），或**合并两张重复表为单一真源**（根治，防再次漂移）；同步改 manifest/SKILL.md/测试到该名。
- 验证：boot 断言两表一致 + 行为测试断言 live 暴露名 == manifest 名。

**⑤ D5/D6 测试诚信**
- 合同：send-im 必须有一条"从原始用户文本经真实 dispatch 跑到判定结果"的行为测试；不得靠 stub/抛错走 fallback 来 pin 工具名。
- 改向：补真实路径行为测试（覆盖 D1/D2/D3）；删/改两个假断言；`send-im-skill-tool.ts:297` 补注释或 metric 过 silent-catch gate。

### 4.2 L0 系统级（架构级，单独排，碰硬约束）

**⑥ Problem A — renderer 改为"对账式 client"（这是移动端同步的同根地基，优先做）**
- 合同（强化既有红线）：终态"账本写入"与"所有 client 可见收口"必须可对账；任一 client 丢事件后，必须能从**权威投影**自愈，不靠重投碰运气。
- 改向（推荐目标态，见 §5 统一）：
  - 引入 **client registry / ClientSession**：renderer 注册为 client，事件投递经 registry 逐 client 派发（替代裸 `mainWindow.webContents.send`），带"最近已确认序号"。
  - renderer 的 `isStreaming/scopeRunState` 改为**从 `task_projections` + 终态对账派生**：mount/focus/重连时拉一次权威快照对齐；终态事件丢失则由对账纠正。
  - 停止键点击后不要只相信本地乐观清理；应触发一次权威投影对账，若后台已无活动 run，则按投影强制清 streaming。
- 验证：注入"丢一帧终态事件"的测试 → 断言 renderer 仍在下一次对账清 streaming；`verify:stability` 回归。

**⑦ A2 判定器过严复核（独立排查）**
- 先确认 new-vs-baseline（git 历史 + 是否近期 shadow→enforce）；若确为过严，给"0 工具直答/direct 执行"等形态正确的成功路径豁免，避免把正常结果判失败。

### 4.3 Problem B okf-bundle 收尾
- 合同：reference+scripts 的生产者 skill，其 `SKILL.md` 必须**显式指示**用 `skill_run_shell`/`skill_write_artifact` 落到 skill 输出目录；`okf_tools.py` 或新增 action 负责 scaffold bundle 目录。
- 改向：补 SKILL.md 指令 + 让脚本/primitive 真正写 bundle 文件；或把 okf-bundle 升为带 python typed action 的执行 skill（对照 video-expert）。

### 4.4 顺序与依赖
```
先（解锁功能，低风险）：①D1 → ②D2 → ③D3 → ④D4 → ⑤测试
后（架构级，含红线，配 plan 文档）：⑥Problem A 对账化（= 移动端地基）→ ⑦判定器复核
并行可做：Problem B 收尾
```
**关键**：⑥不是 send-im L1 的前置条件；它是 Problem A 的正解，也应按 §5 预留移动端接口，但要作为单独架构项排期，避免扩大本轮发图修复面。

---

## 5. 移动端 / iPad 远程同步 — 接口预留设计

> 用户诉求：未来手机/iPad app 远程接上电脑端 Ready，同步**运行状态、文档状态、文档内容**。
> 本节给"现在就该预留什么（低成本）"+"分阶段怎么长"，避免日后返工。

### 5.1 核心论点
**mobile = 第三个 client。** 不要为它单独造同步子系统；让现有状态层 client-agnostic，mobile 与 renderer、IM 走同一套"权威快照 + 变更订阅 + 提交"接口。已有 Feishu/微信 sidecar 证明"无界面远程客户端复用 runtime"这条路通。

### 5.2 现状评估（什么已可同步 / 什么需提升）

| 同步对象 | 现状 | 可同步性 | 处理 |
|---|---|---|---|
| **运行态**：scopes/messages/projections/run_meta | SQLite 权威 | ✅ 今天就可读+订阅 | 暴露 client-agnostic 读+变更流 |
| 运行态镜像：`isStreaming`/`scopeRunState`/草稿/active scope | renderer-only Zustand | ❌ renderer 私有 | **提升为权威/per-client**（= Problem A ⑥） |
| **文档态**：哪些 tab 打开/dirty/active | renderer-only（useDocTabs + localStorage） | ❌ 主进程零持久 | 提升：主进程持有文档会话态 + 变更事件 |
| **文档内容（存盘）**：`.md` 文件 | 文件系统 | ⚠️ 可经 file API 同步（非实时） | 文件级同步即可 |
| **文档内容（实时在编辑）**：markdown blob | renderer-only 内存、无版本/op-log/冲突处理 | ❌ | 需版本化 + 变更流（分阶段，见 5.5） |
| 设置/记忆 | SQLite 权威 | ✅ | 暴露只读镜像 |

证据：文档态 `useDocTabs.ts:178-466`（renderer 权威、内存）、`document-commit-registry.ts`（仅 widget 提交）；运行态权威表 `migrations.ts`（chat_conversations/chat_messages/task_projections/run_meta）；客户端边界 `preload/index.ts`（~15 个 push 通道）；远程范式 `runtime.ts` inbound channel + `sidecar-manager.ts` + `ready_sidecar/main.py`。

### 5.3 现在就该预留的 5 个 seam（低成本、且与 L0/L1 改动同源）

1. **状态权威化 + 变更流（与⑥同一件事）**
   - 预留 `getScopeRuntimeSnapshot(scopeId)`（权威快照：projections + 运行态 + 终态）与 `onScopeRuntimeChanged`（带单调序号的变更流）。renderer 改对账时**就按 client-agnostic 接口写**，别写成 renderer 私有路径。mobile 直接复用。
2. **传输与客户端 API 解耦**
   - 今天 preload IPC == 客户端 API。预留一层 **transport-agnostic service 接口**（agent/document/session 的请求-响应 + 订阅），让 renderer 走 IPC、mobile 走 WS/HTTP **同构**。投递经 client registry（⑥），天然支持 N 订阅者 + 逐 client ack。
3. **client 身份 + per-client 会话态**
   - 预留 `clientId` 概念：`activeScopeId`、草稿、presence 改为 **per-client**（不再假设"唯一 renderer"）。低成本现在就 thread 进去，避免日后全量改。
4. **文档实时态可寻址 + 版本**
   - 即便先不做协同编辑：在 `useDocTabs` 变更点（`setTabContent/appendTabContent/...`）预留 `documentId + revision + changeEvent`，并在主进程留一份"最近已知内容 + revision"。MVP 让第二 client 能**只读镜像**实时内容；op-log/CRDT 留后续阶段。
5. **鉴权/配对**
   - 复用 sidecar 现有 `X-Ready-Token` bearer + 仿微信扫码的 pairing 流，预留"配对 + 颁发设备 token + 撤销"接口。不在主进程裸开端口。

### 5.4 分阶段落地（避免一次性 boil-the-ocean）
- **阶段 0（随⑥预留，不阻塞 L1）**：状态层 client-agnostic 化 + client registry。产出：renderer 对账修好（Problem A），且对外暴露了权威快照/变更流接口。它和 send-im L1 修复有关联，但不应混进"发图到微信"的最小闭环里一起做。
- **阶段 1（MVP：只读镜像）**：mobile 经 sidecar WS/HTTP 订阅某 scope 的运行态 + 消息 + 存盘文档内容；可在手机看进度、读文档、收结果。**只读，零冲突风险。**
- **阶段 2（双向：发起/控制）**：mobile 发消息、停止/续跑 run（复用 IM inbound 范式：mobile 是又一个 inbound 源）。
- **阶段 3（协同编辑实时文档）**：文档内容上 op-log 或 CRDT + 冲突解决。**最重，明确留到最后**，且仅当产品确需"手机改、电脑实时联动"才做。

### 5.5 与本轮 L0/L1 改动的交汇（避免返工）
做⑥时务必：把"renderer 对账读"写成 §5.3-1 的 client-agnostic 接口；把事件投递改成 §5.3-2 的 client registry；把 active scope/草稿按 §5.3-3 per-client 化。这三步是值得预留的方向，但不是零成本：需要单独合同和回归，避免为了移动端地基扩大 send-im 修复面。文档内容版本化（§5.3-4）可作为独立小改预留。

---

## 6. 风险与不做的事
- **不做**：为移动端单独造一套同步逻辑（违 client-agnostic，制造第二真源）。
- **不做**：阶段 3 协同编辑提前上 CRDT（过度工程；MVP 只读即满足绝大多数"在手机看进度/读结果"诉求）。
- **风险**：⑥触 CLAUDE.md 可见收口/红线，须配对 `docs/superpowers/plans/*-implementation.md` 并过 `verify:stability`。
- **风险**：A2 判定器若确为过严，盲目放宽会漏判真失败；须先 new-vs-baseline 定性。
- **依赖**：移动端阶段 1+ 依赖阶段 0（状态权威化）先落地，否则同步的是 renderer 私有的不可靠态。

---

## 7. 证据索引
- 账本：`run_meta`/`task_projections`（`~/Library/Application Support/ready/ready.db`）；`78euqa blockers:["criteria_unsatisfied:s1"] terminalReason:adjudication_degraded`；今日 9/23 run = adjudication_degraded。
- 日志（`<TMP>/`）：`ready-tools.log` 三个 final_tools 快照（skill 工具 61 有 / 78、56 无）；`ready-agent-sdk.log:802,806` `skill_send_im_send_file` 被调；`ready-directchat.log` `Agent execution failed`、15:24/14:24 `setupAgentIPC` 重初始化。
- 代码：暴露/名字 `skills-tools.ts:128-151`、`skills-tools-static.ts:36`；授权 `agent-sdk-runtime.ts:6151-6189`、`skill-context-orchestrator.ts:98-143,462-465`；判定 overlay `criteria-templates.ts:83-109`、`task-adjudicator.ts:43`、`run-finalizer.ts:197-206`；执行 `send-im-skill-tool.ts`、`remote-im-file-intent.ts`、`wechat_openclaw_adapter.py`；UI 收口 `runtimeDriver.ts:1467-1485`、`ipc-handler.ts:1557-1568`；文档态 `useDocTabs.ts:178-466`、`document-commit-registry.ts`；客户端边界 `preload/index.ts`；远程范式 `runtime.ts` inbound、`sidecar-manager.ts`、`ready_sidecar/main.py`；权威表 `migrations.ts`（chat_conversations/chat_messages/task_projections/run_meta）。
