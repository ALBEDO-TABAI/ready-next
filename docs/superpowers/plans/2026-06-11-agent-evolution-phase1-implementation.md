---
title: Agent Evolution 阶段一（可观测与安全地基）实施子计划
date: 2026-06-11
status: approved v2.1 — Codex 共识达成（2026-06-11，2 轮合同评审 7+2 点全部闭合），enforce 生效，逐单施工
revision_history:
  - v1 (2026-06-11): 初稿。依据 docs/agent-evolution/ 00~11 设计系列（已经两轮 Codex 评审压实）拆为可执行工单。
  - v2 (2026-06-11): 吸收 Codex 合同评审 7 点。P1：①I3-1 取消"用现有 TurnFrame 字段自动预批准"（粗粒度意图证明不了对象级授权）——阶段一 M2/M3 全走确认卡，预批准能力另立阶段二工单 I-auth；②I3-2 明确执行模型为「原 run 内同步等待」（运行态不跨 run 重建）+ 专用 release 入口（token 只跳过再确认，authorization/工具策略照跑，确认≠提权）。P2：③G1 验收补 verify:native；④T4-2 增非 browser/skill 工具旧字段快照测试（全域改动全域证明）；⑤B3 种子卡定为 bundled 只读 + 用户目录覆盖（不写用户目录、升级不覆盖用户改动）。P3：⑥K1/K2 staged 验收措辞改为"读 API 默认排除 staged"，真实注入禁令留 K3；⑦K2 syncBeliefCards 本阶段只提供函数不接启动，启动接线并入 K6。同步更新 05 篇设计与 PHASE1 开发计划。
  - v2.2 (2026-06-11): 施工期 B2 下钻发现合同与 HEAD 注入架构不匹配（DomainAdapterPrepareResult 无提示词注入字段；fragment refs 只能 readMemoryFile 从记忆根读，读不到 X3 assets）。Codex 评审采纳"收紧版 A"：新增 EP1-B2a 给 fragment ref 加可选内联 `text`（仅宿主代码生成、内容来自 X3 loader、不接用户输入），`resolveTriggers` 优先注入 text 否则读 path；旧 path 方式零行为变化；memory ref 不塞正文。B2 改为构造期经 X3 渲染纪律资产、`contributePromptFragment` 贡献 inline fragment；`matches` 不假设 route 有值。
  - v2.1 (2026-06-11): 吸收 Codex 复核 2 点。P2：K1 路径守卫升级为**两 glob 白名单**（普通卡 `knowledge/*.md` + 站点卡 `knowledge/sites/*.md`，唯一允许的子目录），bundled 只读卡走只读解析不经写入守卫；B3 站点卡写入准入由 K1 白名单统一裁决，不另立守卫（消除 B3 用户覆盖路径与 K1 守卫的冲突）；同步 01 §152。P3：I3-1 明令**阶段一禁止确认缓存**（"同对象同动作确认一次"依赖对象级授权 key，须 I-auth 后启用），加"连续两次命中两次都确认"防御测试；05 §3.2 该条标注为 I-auth 后启用。
owner: 白
author: Claude (Fable 5)
executor: Claude (Fable 5)
reviewer: Codex（共识）+ Claude（终审）
enforce: true
note: >
  本文将 agent-evolution 路线（docs/archive/2026-09-06/docs/agent-evolution/00-路线图与目标架构总览.md）的阶段一
  拆为可执行工单。工单纪律沿用 stability 合同：先合同测试（红）后实现（绿）；
  每单 ≤约 300 行 diff、10 分钟内可自验；不顺手重构、不碰无关文件。
  本阶段不触碰 agent-sdk-runtime.ts 的终态路径与 run-finalizer.ts（02 篇 Q 系列属阶段二），
  与 stability 合同无同文件竞争；唯一共享文件为 tool-executor.ts（I3/T4），两轨道内部串行。
pairs_with:
  - docs/archive/2026-09-06/docs/agent-evolution/00-路线图与目标架构总览.md（路线）
  - docs/archive/2026-09-06/docs/agent-evolution/08-缺陷解决映射与验收追踪.md（验收脊柱，工单合入后回填状态）
related:
  - docs/superpowers/plans/2026-06-10-agent-stability-closure-implementation.md（S 系列，已合入基线）
  - docs/agent-evolution/01/05/06/07/11（本阶段工单的设计出处）
---

> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# Agent Evolution 阶段一实施子计划

## 0. 总则

1. **轨道与串行约束**
   - 轨道 K（知识地基）：K1 → K2，串行。
   - 轨道 X（上下文可观测）：X4 / X1a / X3 相互独立，可并行；X3 先于 B2。
   - 轨道 I（安全闸门）：I3-1 → I3-2，串行；与 T4 共享 `tool-executor.ts`，**I3 与 T4 工单全局串行**（I3-1 → T4-1 → T4-2 → I3-2 或按先到先得，禁止并行改同文件）。
   - 轨道 T（协议与诊断）：T4-1 → T4-2；T5 独立可随时做。
   - 轨道 B（浏览器资产）：B2 依赖 X3；B3 依赖 K1；B2/B3 互相独立。
2. **每单交付物**：失败测试 → 实现 → 焦点验证命令绿 → `npm run typecheck` 绿。涉及 SQLite 的工单（K2、I3-2）跑 `npm run verify:native`。
3. **每单提交**：单独 commit，message 引用工单号（如 `feat(agent): EP1-K1 belief card store`）。
4. **gate 汇总**：末单 G1 新增 `verify:evolution-p1` 链（挂当前链顶之后），收编本计划全部焦点测试；同步 CLAUDE.md §8 索引与 08 表状态回填。
5. **禁止事项**：
   - staged 状态的卡片内容不得出现在任何注入路径（01 §3.3 是硬合同，不是建议）；
   - 确认闸门放行只能消费冻结记录，禁止任何"让模型重新生成参数后执行"的实现（05 §3.2）；
   - 工具信封为 additive 改造，禁止删除或改变 `text/data/errorKind` 旧字段语义（07 §3.1 迁移步骤 ②）；
   - 站点风险等级唯一权威是代码侧 store，知识卡 riskLevel 镜像字段不得参与守卫判定（11 §2.3）；
   - 模型只做判断题：策略表、状态机、路径守卫、冻结放行一律代码实现。

---

## 轨道 K：知识地基（设计出处：01 篇）

### EP1-K1 信念卡存储与读写工具

- **改动文件**：新增 `src/main/modules/agent-control/knowledge/belief-card-store.ts`（frontmatter 解析/校验、五态状态机、原子写 tmp+rename、**写入路径白名单**见下）、新增 memory 工具 `memory_read_card` / `memory_write_card`（落点跟随现有 memory 工具文件，以 HEAD 为准）、工具注册、新增 `src/__tests__/belief-card-store.test.ts`、`src/__tests__/memory-card-tools.test.ts`
- **写入路径白名单（Codex 评审 P2 采纳——一次定清，B3 不再各搞一套）**：用户可写卡仅限两类，均在用户记忆根 `.ready-agent-memory/` 下：① 普通信念卡 `**/knowledge/*.md`；② 站点卡 `**/knowledge/sites/*.md`（唯一允许的 knowledge 子目录，domain 即文件名）。除这两个 glob 外一律拒绝（含其他 knowledge 子目录）。bundled 只读卡（B3 种子卡，在 `src/main/assets/` 内）**走只读解析路径，不经写入守卫**——它从不被写入用户域。
- **实施要点**：卡片 frontmatter 必填 `title/description/confidence/tag/created/status`（站点卡追加 `site`）；`memory_write_card` 新卡默认 `status: staged`（用户对话明示"记住"由调用方传 `status: active`）；malformed frontmatter → 拒写并返回结构化原因（不是吞错）；状态迁移仅暴露 §01-3.3 的四个写入点对应的 API，每次迁移追加审计行（复用 metrics.ts 入口）。**读 API 默认排除 staged**（`readCard`/`listCards` 默认 `status: active`，staged 须显式传参才返回——这是阶段一能证明的"staged 不外泄"边界）。本单**不做**注入接线（K3 属阶段二）、不做 DB 镜像（K2）。
- **测试（先红）**：合法卡写入→读回逐字段一致；坏 frontmatter 拒写；**路径白名单**——`knowledge/*.md` 与 `knowledge/sites/*.md` 准入、`knowledge/other-subdir/*.md` 拒绝、路径逃逸（`../`、绝对路径、symlink 出域）拒绝；bundled 只读卡只读不可写入用户域；**读 API 默认不返回 staged 卡**；staged→active/rejected 迁移 + 审计行存在；14 天过期清理函数（注入固定时钟）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/belief-card-store.test.ts src/__tests__/memory-card-tools.test.ts && npm run typecheck`
- **规模**：~280 行。

### EP1-K2 DB 镜像列与 file→DB 同步

- **改动文件**：`src/main/modules/migrations.ts`（新迁移：`agent_memory_metadata` 增列 `slug TEXT`、`confidence TEXT`、`file_path TEXT`、`status TEXT`、`content_hash TEXT`，沿用既有幂等模式）、`src/main/modules/repositories/memory-repository.ts`（belief 行 upsert/按 slug 查询）、`belief-card-store.ts`（写卡后同步镜像）、新增 `src/__tests__/migration-belief-columns.test.ts`、`src/__tests__/belief-card-db-sync.test.ts`
- **实施要点**：同步方向 file → DB 单向；`content_hash` 不一致以文件重算覆盖 DB；解析失败的文件标 DB `status: invalid`（不删行、不删文件）。watcher 增量同步**不在本单**（01 K6 属阶段二）。**`syncBeliefCards()` 本阶段只提供函数、不接入启动流程**（Codex 评审 P2#7 采纳——避免在本阶段引入启动时序与 native 验收负担）；启动接线连同 watcher 一并放到 K6（阶段二），届时补启动验证。DB 读 API 同样默认排除 staged（与 K1 一致）。
- **测试（先红）**：迁移双跑幂等；写卡→镜像行字段一致；手动调用 `syncBeliefCards()` 后以文件为准；损坏文件→invalid 行且原行不丢；DB 读默认不返回 staged。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/migration-belief-columns.test.ts src/__tests__/belief-card-db-sync.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~220 行。

---

## 轨道 X：上下文可观测（设计出处：06 篇）

### EP1-X4 注入账单 context_bill

- **改动文件**：新增 `src/main/modules/agent-control/context-bill.ts`（账单组装纯函数）、`src/main/modules/agent-control/prompt-assembly.ts`（buildForScopedRun 各 section 组装处收集 `{section, bytes}`，结尾经 metrics.ts 写一行账单）、新增 `src/__tests__/context-bill.test.ts`
- **实施要点**：账单字段对齐 06 §5（L0/L1_summary/L1_taskIndex/L1_userNotes/L2_triggers/reminders/total/truncations）；只记字节数与截断事实，不记内容（隐私）；测试环境写入隔离路径（沿用 S0-1 机制）。
- **测试（先红）**：构造已知大小的各 section → 账单行字节数与实际注入串长度一致；截断发生时 truncations 非空。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/context-bill.test.ts && npm run typecheck`
- **规模**：~160 行。

### EP1-X1a 任务索引 v1（仅现有列）

- **改动文件**：新增 `src/main/modules/agent-control/session/daily-task-index-builder.ts`（纯函数：task_projections 现有列 `status/task_title/blocked_reason/continuation_ref_json/updated_at` → 索引行）、`prompt-assembly.ts` loadL1（索引段注入，置于当日文件之前，并行期共存；预算 1200 字符划自 L1 既有 8000）、新增 `src/__tests__/daily-task-index.test.ts`
- **实施要点**：行格式 `- [task:{id}] {title} | {status}[:blocked_reason] | {续跑条件一句话(来自 continuation_ref)}`；按 scope 谱系过滤（复用 C4.3 / daily-memory-scope-filter 的谱系判定，不重写）；终态任务只列当日完结且未被查看过的（收割线索）；**输出禁止出现祈使句**——builder 是纯拼装，不含任何"请继续"类文案。`memory/{date}.md` 保留为用户手记，注入顺序在索引之后。
- **测试（先红）**：blocked 任务渲染 blockerReason 与续跑条件；他谱系任务不出现；空任务日输出空段；全输出无祈使句模式断言（行为断言：逐行匹配格式 schema，而非 grep 黑名单）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/daily-task-index.test.ts && npm run typecheck`
- **规模**：~200 行。

### EP1-X3 提示词资产 loader

- **改动文件**：新增 `src/main/modules/agent-control/prompt-assets/loader.ts`（frontmatter `name/version/description/variables` 解析 + 变量插值 + 缺文件回退注册的硬编码兜底）、新增 `src/main/assets/prompts/` 目录与首批资产占位（I3 确认卡文案、X1a 索引段头、B2 浏览器纪律——B2 资产正文由 B2 工单交付）、新增 `src/__tests__/prompt-asset-loader.test.ts`
- **实施要点**：loader 启动时加载并缓存；version 不变 → 渲染结果逐字节稳定（快照测试锁定）；变量缺失 → 报错不渲染半成品；资产文件打包路径与 dev 路径双解析（沿用 assets/skills 的既有模式）。
- **测试（先红）**：加载/插值/回退/快照稳定性/未声明变量拒渲染。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/prompt-asset-loader.test.ts && npm run typecheck`
- **规模**：~180 行。

---

## 轨道 I：行动确认闸门（设计出处：05 篇 §3）

### EP1-I3-1 策略表与 dispatch 闸门

- **改动文件**：新增 `src/main/modules/agent-control/safety/action-confirmation-policy.ts`（M1-M4 静态映射表：工具名 + 参数特征 → 模式；首批清单照 05 §3.1）、`src/main/modules/tools/tool-executor.ts`（authorization 检查之后插入闸门查表：M1 → 结构化拒绝并指引用户手动；**M2/M3 一律进入 I3-2 冻结流程**（本单先返回 `denied_pending_confirmation` 占位）；M4 → 放行）、新增 `src/__tests__/action-confirmation-policy.test.ts`
- **实施要点**：**预批准在阶段一不实现**（Codex 评审 P1#1 采纳）——现有 `TurnFrame`（turn-frame.ts）只有 start/continue/check/cancel 粗粒度意图，证明不了"用户同意删除/发送/上传某具体对象"，用它做自动预批准是伪命题。因此阶段一 **M2 与 M3 同等对待，全部走确认卡**；05 §3.1 的"M3 预批准有效"语义降级为"待对象级授权能力就绪后启用"，本单不读任何意图字段做放行判断。对象级"动作授权判断"能力（把"用户对此对象批准了此动作"做成可证明的结构化事实）另立工单（阶段二，记为 **I-auth**，05 篇 §3 补设计），就绪后再把 M3 的预批准路径接上。策略表与 05 §3.1 清单一一对应并在表内注释引用设计条目编号。本单不做确认 UI 与放行（I3-2）。
- **禁止确认缓存（Codex 评审 P3 采纳）**：阶段一无 I-auth，**不得实现任何"同一对象同一动作本会话确认一次即可"的缓存**——那需要对象级授权 key 才安全。M2/M3 每次命中一律走确认卡；唯一可复用的是单个 frozen call 的一次性 release token（只对那一次被冻结的调用有效，不跨调用/不跨对象）。05 §3.2"避免重复确认"条目标注为 I-auth 后启用。
- **测试（先红）**：M1-M4 矩阵（每模式至少一个工具样例）；同一工具不同参数特征落不同模式（如 file delete 单个 vs 批量）；**M3 在无 I-auth 能力时与 M2 同走冻结流程**的断言（防止实现者私接"读意图字段预批准"）；**同一对象同一动作连续两次命中 → 两次都要确认**的断言（防止偷做确认缓存）；闸门位于 authorization 之后的顺序断言。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/action-confirmation-policy.test.ts && npm run typecheck`
- **规模**：~220 行。

### EP1-I3-2 冻结放行与确认卡

- **改动文件**：`src/main/modules/migrations.ts`（新表 `pending_confirmations`：`id/run_id/task_id/scope_id/tool_name/params_json/created_at/expires_at/status('pending'|'released'|'denied'|'expired')/released_at`）、新增 `src/main/modules/agent-control/safety/frozen-call-store.ts`、`tool-executor.ts`（M2/M3 拦截 → 冻结入库 + 经 `ask_user_questions` 变体发结构化确认卡——遵守"每 turn 最多一次、同 session 单 pending"既有约束，已有 pending 时第二个 M2 调用直接 `denied_pending_confirmation` 让模型改道）、确认/拒绝 IPC handler + preload + renderer 类型（§7 最小闭环）、新增 `src/__tests__/frozen-call-release.test.ts`
- **执行模型（二选一，本合同定为「原 run 内等待」，Codex 评审 P1#2 采纳）**：确认闸门是**同步阻塞式**——M2/M3 命中时，工具调用在**原 run 的工具执行上下文内挂起**（abortSignal、browserController、allowedToolNames、scope/runId 等运行态全部活着，不跨 run 重建），等待用户在确认卡上操作；用户确认 → 在**同一执行上下文**内放行原始 tool_use 恰好一次。**不采用「后续 run 恢复执行」模型**（那会要求把整个 ToolRuntimeContext 序列化重建，本阶段不做）。直接后果：确认有超时（默认 10 分钟），超时/run 被抢占或取消 → 该 frozen call 置 expired，工具返回结构化"确认超时已取消"，**绝不在上下文失效后补执行**。
- **专用 release 入口（硬规则）**：放行只能经 `frozen-call-store.release(id, token)` → 回到 `tool-executor` 的**同一 dispatch 路径**用冻结参数继续，**带 `confirmationToken` 跳过的只有"再次确认"这一步，注册检查、authorization、run-capability 工具策略一律照常执行**（确认 ≠ 提权）。冻结记录只存 `tool_name + params`，不存运行态——运行态来自仍然活着的原上下文，这正是选「原 run 内等待」而非「后续 run 恢复」的原因。
- **实施要点**：用户确认 → 按 `id` 原样取冻结参数，经 release 入口执行**恰好一次**（status 原子置 released，二次放行拒绝）；拒绝 → 结构化拒绝回灌模型；过期（默认 10 分钟）→ expired；放行/拒绝事件经 metrics.ts 落审计行（阶段二 Q1 合入后迁 proof_refs，本合同注明 TODO 引用）。**不引入 TaskEventBridge 跨 run 回灌**——因执行在原 run 内同步完成，结果直接作为该 tool_use 的返回回灌模型循环。
- **测试（先红）**：冻结→确认→执行参数与冻结时逐字节一致（**核心断言：无重新生成**）；放行经 release 入口仍跑 authorization（构造一个确认后恰好失去授权的场景 → 断言被 authorization 拦下而非靠 token 提权）；二次放行拒绝；过期作废 + 上下文失效后不补执行；拒绝回灌结构化错误；单 pending 约束下第二个 M2 被拒。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/frozen-call-release.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~300 行。

---

## 轨道 T：工具协议与自诊断（设计出处：07 篇）

### EP1-T4-1 errorKind → kind 映射表

- **改动文件**：新增 `src/main/modules/tools/tool-result-envelope.ts`（`kind` 枚举 + `mapErrorKindToEnvelopeKind()` + envelope 组装纯函数）、新增 `src/__tests__/tool-envelope-mapping.test.ts`
- **实施要点**：纯新增，不接线。映射穷举 HEAD 现存全部 errorKind 取值（实施时枚举核对）；未知值 → `internal_error` + 告警字段。kind 集合照 07 §3.1（含 `denied_by_policy/denied_by_user_negation` 两个预留值，I3/阶段二接线）。
- **测试（先红）**：映射穷举断言（含未知值兜底）；envelope schema 校验。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/tool-envelope-mapping.test.ts && npm run typecheck`
- **规模**：~140 行。

### EP1-T4-2 信封并存 + browser/skills 试点

- **改动文件**：`ToolExecutionOutput` 类型（additive 增加可选 `envelope` 字段，落点跟随该类型现有定义文件）、`tool-executor.ts`（dispatch 出口统一组装 envelope）、skills 子进程结果包装处（stdout 单 JSON 信封纪律：结果经 READY_SKILL_RESULT_PATH 机制不变，子进程 stderr 诊断不入结果）、新增 `src/__tests__/tool-envelope-pilot.test.ts`
- **实施要点**：`ToolExecutionOutput`（tool-result-types.ts）是**全域共用结构**，dispatch 出口统一组装 envelope = 全域受影响。因此约束：envelope 字段**可选**，旧字段（text/data/errorKind）零改动零删除；新组装逻辑对所有域只做"附加 envelope"不改旧字段。本单只保证组装正确，模型侧注入格式变更属后续工单。
- **测试（先红）**：browser 域与 skill 域各一条工具结果含正确 envelope（试点正向）；**另取一个非 browser/非 skill 工具（如文件读或 memory 工具）做旧字段快照测试**，证明全域统一组装未破坏旧链路（Codex 评审 P2#4：全域改动需全域证明，不能局部证明）；重试分级（429 退避 ≤2 / 401 零重试）此处仅对**新增公共重试助手**生效的域做断言，未迁移域不动。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/tool-envelope-pilot.test.ts && npm run typecheck`
- **规模**：~260 行。

### EP1-T5 ready-debug 自诊断技能（文档资产）

- **改动文件**：新增 `.claude/skills/ready-debug/SKILL.md`（四张表：日志源优先级 / 症状→检查映射 / 三账本巡检 SQL 包 / findings 五段式模板 + ABI 检查脚本段 + 修复前必问门）、新增 `.claude/skills/ready-debug/README.md`（非 Claude Code 代理的复制粘贴指引）
- **实施要点**：v1 仅面向外部编码代理（07 §4 双入口表）；内容与 CLAUDE.md §11 日志路径、verify:native 约定一致；技能正文引用真实命令均需在交付前实际跑通一遍。
- **测试（先红）**：无代码测试。**验证**：PR 描述附一次人工演练记录（任选一个真实症状走完四张表产出 findings.md）；reviewer 抽查 SQL 与命令可执行。
- **规模**：~250 行（纯文档）。

---

## 轨道 B：浏览器纪律与站点知识（设计出处：11 篇）

### EP1-B2a 合同修正 — fragment inline asset ref（收紧版 A，Codex 评审采纳）

⚠️ **HEAD 架构修正**：原 B2 写"prepare 阶段经 X3 loader 注入 prompt fragment"，但 HEAD 的 `DomainAdapterPrepareResult` 无任何提示词注入字段；域内指引只能经 `contributePromptFragment()` 的 refs，而 `resolveTriggers` 用 `readMemoryFile(ref.path)` 从记忆根读取——读不到 X3 的 `assets/prompts` 资产。更准确的说法是"**DomainAdapter 贡献 prompt fragment，经 X3 loader 生成 inline asset ref 注入**"。修正方式（**收紧版 A**，不做泛化内联）：

- **改动文件**：`domain-adapter.ts`（`CoordinatorPromptFragment` 的 ref 增加可选 `text?: string`——**仅供宿主代码生成的 fragment 使用，内容只来自 X3 loader 渲染，绝不接用户输入**；`path` 对此类 ref 可为 null/资产 key）、`prompt-assembly.ts`（`resolveTriggers` 注入分支：ref 带 `text` 时直接注入该文本，不走 `readMemoryFile`；memory ref 只记 title/summary/triggerId，**正文不入 memory ref**）、新增 `src/__tests__/fragment-inline-asset-ref.test.ts`
- **不变量**：旧 `path` 方式零行为变化（老 browser/document/rss/calendar fragment 不动）；inline 文本仍计入预算与 context_bill（X4）。
- **测试（先红）**：旧 path fragment 仍读记忆文件；inline asset fragment 能注入；非命中场景不注入；inline 文本被 context_bill 计入。
- **规模**：~80 行。

### EP1-B2 浏览器交互纪律资产

- **改动文件**：新增 `assets/prompts/browser/discipline.md`（X3 资产：通道决策树[store riskLevel 权威] + 五步交互配方 + 定位器七级优先级 + 错误恢复状态机 + token 经济规则 + 已知风险站点硬规则）、`browser-domain-adapter.ts`（构造期经 X3 loader 渲染纪律资产，`contributePromptFragment()` 增加 `browser-discipline` fragment 携带 inline `text`，match 浏览器意图；预算上限 2500 字符）、新增 `src/__tests__/browser-discipline-injection.test.ts`
- **实施要点**：内容以 docs/agent-evolution/11 §2.2/§3 为准；纪律资产对**现有视觉/工具通道立即生效**（不等 B1 spike）；不修改任何工具行为，纯提示词层。**`matches` 不得假设 route 有值**——prompt assembly 发生在 route/prepare 之前，现有 fragment match 一律 `route: null`；基于浏览器意图文本/adapter 命中判断。
- **测试（先红）**：浏览器意图命中时 fragment 含纪律资产内容；资产快照稳定；非浏览器意图不注入。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/fragment-inline-asset-ref.test.ts src/__tests__/browser-discipline-injection.test.ts && npm run typecheck`
- **规模**：~120 行代码 + 资产文档。

### EP1-B3 站点知识卡与 store 镜像对齐

- **改动文件**：`belief-card-store.ts`（站点卡子类校验：`site` 字段 + riskLevel 镜像字段标记为生成值）、新增 `src/main/modules/agent-control/knowledge/site-card-reader.ts`（domain 命中 → 返回卡正文；riskLevel 镜像从 browser-site-experience-store 读取生成，**卡内手写值忽略并告警**）、bundled 种子卡 ×5（小红书/微博/B站/知乎/淘宝，随 `src/main/assets/` 分发）、`browser-domain-adapter.ts`（prepare 注入命中卡，预算 800 字符）、新增 `src/__tests__/site-card-alignment.test.ts`
- **种子卡归属（Codex 评审 P2#5 采纳——「bundled 只读 + 用户目录覆盖」）**：种子卡是 **bundled 只读资产**（在 `src/main/assets/`），不写入用户域。读取优先级：用户 `.ready-agent-memory/**/knowledge/sites/{domain}.md`（存在则用，**经 K1 站点卡白名单写入**）> bundled 默认卡（兜底只读，走 K1 只读解析路径）。用户从不被覆盖：升级只更新 bundled 层，用户目录零触碰。站点卡的写入路径准入由 **K1 白名单统一裁决**（`knowledge/sites/*.md`），B3 不另立路径守卫；site-card-reader 双层解析沿用 assets/skills 既有 dev/prod 路径模式。
- **实施要点**：守卫逻辑零改动（仍只消费 store）；卡片只供模型阅读经验叙述；store 模块名/接口以 HEAD 实际为准（设计文档按 Codex 称呼 browser-site-experience-store，实施第一步先定位核对，差异大则按开发计划 §4 风险项拆 spike 半单）。
- **测试（先红）**：domain 命中注入；未命中不注入；卡内手写 riskLevel 与 store 不一致 → 以 store 为准且告警行存在；**用户目录卡存在时覆盖 bundled、且升级不动用户卡**的断言；种子卡 frontmatter 全部通过 K1 校验。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/site-card-alignment.test.ts && npm run typecheck`
- **规模**：~240 行 + 种子卡。

---

## 收口

### EP1-G1 verify 链与文档同步

- **改动文件**：`package.json`（新增 `verify:evolution-p1`：本计划全部焦点测试，**内部串接 `npm run verify:native`** 覆盖 K2/I3-2 的 SQLite 迁移；若不内联则在完成定义里单列）、`CLAUDE.md` + `AGENTS.md` §8 索引追加本合同（§12 同步纪律）、`docs/archive/2026-09-06/docs/agent-evolution/08-缺陷解决映射与验收追踪.md`（本阶段行回填状态）
- **实施要点**：硬约束变化（确认闸门、staged 注入禁令）按 CLAUDE.md §10 同步进根目录指引 §2。
- **验证**：`npm run verify:evolution-p1 && npm run verify:native && npm run typecheck && npm run test`（Codex 评审 P2#3：native 门补回，K2/I3-2 含 SQLite 迁移）
- **规模**：~60 行。

---

## 阶段验收（对应 08 表回填）

| 设计验收断言 | 工单 |
|---|---|
| K1/K2 所有读 API 默认排除 staged（真实 prompt 注入禁令留到 K3 接线时验收） | K1/K2 |
| 注入账单与实际字节一致 | X4 |
| 索引行无祈使句、他谱系不泄漏 | X1a |
| M1/M2/M3 动作未确认执行 = 0；放行经 release 入口仍跑 authorization；放行参数与冻结时逐字节一致 | I3-1/I3-2 |
| 旧工具字段零破坏；映射穷举无遗漏 | T4-1/T4-2 |
| 高风险站点以 store 为唯一权威；卡片手写值无效 | B3 |
| 浏览器纪律对现有通道生效 | B2 |
