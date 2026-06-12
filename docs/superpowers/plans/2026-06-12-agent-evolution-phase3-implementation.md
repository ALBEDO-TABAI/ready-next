---
title: Agent Evolution 阶段三（组织与维护智能）实施子计划
date: 2026-06-12
status: v3 修订（2026-06-12 Codex 三轮复审 2P1/2P2 回修：迁移编号顺序/C4 真值源/卡片路径说明/C3 账本入口），待 Codex 复核后恢复 approved；复核通过前 A1/PK1 不开工
revision_history:
  - v1 (2026-06-12): 初稿；同日 Codex 评审唯一 P1（总则 PK3 依赖 I4 与工单表/波次矛盾）修复（cd558d47）后 APPROVED。
  - v3 (2026-06-12): 吸收 Codex 三轮复审 4 点。P1：①迁移编号与开工顺序对齐——A1 改为 055 agents + 056 owner_agent_id（同单连续两号），PK1 改 057 packet columns，与单执行顺序 A1→PK1 一致且满足编号连续 gate；②C4 删除文件 CAS 主路径——主写入=DB 事务/CAS（user_profiles 画像行与/或 resident_user memory），USER.md 仅 DB 无行时镜像。P2：③A2 同步 memory_write_card 工具描述与 schema 说明（agents/<id>/knowledge 路径底层已允许但提示词仍说只能写全局目录）；④C3 写明维护回合不直接写 terminal run_meta——预算审计走 maintenance metric/log，任何 run_meta 写入必须经既有 finalizer/ledger 入口（runSubAgent 只是事件容器不拥有账本）。
  - v2 (2026-06-12): 吸收 Codex 二轮复审 6 点。P1：①ownerAgentId 落 schema——A1 携 057 迁移列 + Q1 范式全链，A4 为全仓唯一写值点；②A2/A4 顺序矛盾消解——A2 降级为 owner 参数化注入底座 + fixture 测试，端到端验收归 A4；③R 轨样本时钟起点改 253b6768 并加 typedTerminalRuns === totalTerminalRuns（unknown=0）硬条件。P2：④C3 容器钉死 runSubAgent（四决策入单，禁第四套 runner）；⑤C4 写入目标对齐真值源（DB resident_user 为主，USER.md 仅 fallback 镜像）；⑥B1 报告固定路径+评审清单。依据 00 路线图阶段三范围（A1-A4 / C3-C5 / PK1-PK4 / I4 / B4-B5 / E3-E4）+ 03/04/05/09/10/11 各篇工作包表拆单；并入阶段二遗留轨（Q4b 链 + B1 spike）作为独立前置轨；I5 经 HEAD 取证已由 EP2-K4 核销（仅复核行）。
owner: 白
author: Claude (Fable 5)
executor: 待定（Claude / Codex 逐单施工）
reviewer: Codex（共识）+ Claude（终审）
enforce: true
note: >
  阶段二（2026-06-11-agent-evolution-phase2-implementation.md approved v7）已交付
  知识与质量闭环的全部非阻塞单（波次 0-4 + I-auth，整轮 Codex 审查通过，临时回归
  入口 verify:evolution-p2）；Q4b 及下游按合同前置阻塞于真实使用门槛。本阶段交付
  "组织与维护智能"：专项 agent 实体与转办（A）、LLM 维护回合与涌现候选（C3-C5）、
  任务包编译层（PK）、最小传话（I4）、浏览器运行时守卫与 planner 降级（B4-B5）、
  意图流反馈个性化（E3-E4）。工单纪律沿用：先红测试 → 实现 → 焦点验证 →
  typecheck，单单 ≤约 300 行 diff、单独 commit、不顺手重构。
  里程碑（00 §4）：主 agent 会提议接手；候选卡进意图流；复合任务有分派合同。
pairs_with:
  - docs/agent-evolution/00-路线图与目标架构总览.md（阶段三范围）
  - docs/agent-evolution/08-缺陷解决映射与验收追踪.md（验收脊柱，工单合入后回填）
related:
  - docs/superpowers/plans/2026-06-11-agent-evolution-phase2-implementation.md（approved v7 基线；遗留轨工单定义以其为准）
  - docs/agent-evolution/03/04/05/09/10/11（本阶段工单的设计出处）
---

# Agent Evolution 阶段三实施子计划

## 0. 总则

1. **轨道与串行约束**
   - **遗留轨 R（阶段二收尾，独立于阶段三主轨）**：Q4b → Q5 → {T3, X2} → E2 → Q6 → G2，工单定义、规模、验证一律以阶段二合同 approved v7 为准，本合同不复制不改写。**解锁条件（可执行）**：`node scripts/export-adjudicator-divergence.cjs --since <253b6768 合入时间>`（**样本时钟起点 = 253b6768**——样本完整性三件套与 DirectChat 全域保护之前的 shadow 样本已污染作废）输出 `totalTerminalRuns ≥ 50` 且 `typedTerminalRuns === totalTerminalRuns`（`taskTypes.unknown` 必须为 0，否则覆盖统计不可信）、窗口 ≥3 自然日、taskTypes 覆盖 ≥4 类（必含 direct_answer 与 multi_step_task）、清单逐行 disposition 后 `false_reject` = 0、复核清单提交进 repo。B1 spike（真实浏览器实测）同属遗留轨。**遗留轨与主轨并行推进；主轨内仅 E3/E4 与 PK4 的部分验收依赖遗留轨产物（见各单前置）。**
   - 轨道 A（专项 agent 实体，04 篇）：A1 → A2 → A3 → A4 严格串行。A5-A7（预路由/派生/退休）属阶段四，本合同不含。
   - 轨道 C（LLM 维护回合 v2，03 篇）：C3 → {C4, C5}。**C3 是本阶段唯一新增 LLM 回合**——必须经 EP2-C2 的确定性门控（不过门控不起 LLM），信源用摘要不用全文，空轮合法可审计；所有卡片写入走 `memory_write_card` 格式校验，禁止直接 fs 写卡。
   - 轨道 PK（任务包编译层，09 篇）：PK1 → PK2 → PK3 → PK4。**09 篇的 PK3→I4 依赖由 PK3 内置的 verbatim 注入子项满足**（SubAgent/技能子进程 brief 逐字断言在 PK3 验收内）；EP3-I4 是其后的**收口单**（handoff 子项 + 全局断言矩阵），不是 PK3 的前置。PK4 的 CheckIn 验收基于 Q4a（shadow）已合入的 CheckIn 结构，**不依赖 Q4b enforce**。
   - 轨道 I（05 篇）：EP3-I4 为收口单，依赖 A4（handoff 工具 A4 才存在）+ PK3（verbatim 注入子项已在其内落地）——它补 handoff 子项与既有 sub-agent 派发残余转发点，并交付三类转发点的全局逐字断言矩阵。I5 经 HEAD 取证已由 EP2-K4 完成（确认卫生四条原文已进 RULES 默认资产 + 注入快照测试），**仅复核行，不再立单**。
   - 轨道 B（11 篇）：B4 依赖 B1 spike 报告（遗留轨）；B5 依赖 I4 + PK3 + B1。B1 报告未评审通过前 B4/B5 不开工。
   - 轨道 E（10 篇）：E3 依赖 E2（遗留轨）；E4 依赖 E3 + C3。
   - **共享文件矩阵**：`run-finalizer.ts`（遗留轨 Q4b → T3 串行，主轨零触碰）；`prompt-assembly.ts`（A2 → A3 串行；遗留轨 X2 若同期需协调周序）；`migrations.ts`（A1、PK1——一律末尾追加，名称隔离范式）；`agent-sdk-runtime.ts`（A4、I4、PK3 三单触碰——轨间按波次错开，单内 additive）；`emergence-cards.ts`（C5、E3——C5 先）。
2. **每单交付物**：失败测试 → 实现 → 焦点验证命令绿 → `npm run typecheck` 绿；涉及迁移的（A1、PK1）加 `npm run verify:native`；触碰阶段一/二合同面的单加 `npm run verify:evolution-p1` 与 `verify:evolution-p2`。
3. **每单提交**：单独 commit，message 引用工单号（如 `feat(agent): EP3-A1 agents table + persona template candidates`）。
4. **禁止事项**
   - 无确认自动派生（00 不做清单）：A 轨到 A4 为止只做"提议 + 用户采纳"，派生流程（A6）属阶段四。
   - C3 LLM 回合不得绕过 C2 门控直接起跑；维护写卡一律 `memory_write_card`，坏卡置 invalid 不删除；与 file-emergence 共享信号只读不写。
   - packet 嵌套 ≤2 层（09 §2 硬校验）；`direct_answer` 永不分包；子包失败禁止静默吞——必须重派/降级/阻塞三选一并上行报告。
   - 最小传话铁律（05 §4）：跨层转发只传用户原话逐字（`userRequestVerbatim`）+ 显式 refs，禁止转述改写或拼接当天摘要；B5 验收含"计划改写消失"断言。
   - B 轨守卫 fail-fast 结构化错误（`locator_ambiguous` 等）回灌模型，不静默重试；高风控站点硬拦不因任何新通道放宽。
   - 归属切换默认同会话不切会话（A4）；意图流新增卡类继承 ≤8 张全局上限 + 单类 ≤3 + confidence 门槛 + 可关闭。
   - 终态只经 `finalizeRunOutcome()`；主轨任何单不得新增通道外终态写点（funnel gate 全程绿）。

---

## 遗留轨 R（阶段二收尾——定义见阶段二合同 v7，此处只列解锁与归属）

| 单 | 解锁条件 | 备注 |
|---|---|---|
| R-Q4b | §0.1 可执行门槛四条全满足 | enforce 接管终态 |
| R-Q5 | Q4b 合入 | 裁决出口（E3 的行动出口依赖它） |
| R-T3 / R-X2 | Q4b 合入 | T3 同时核销写方向 gate 存量清单 reconciler×5 行 |
| R-E2 | Q5 合入 | 意图流视图（E3/E4 的载体） |
| R-Q6 / R-G2 | 全部遗留单合入 | G2 定稿 verify:evolution-p2 + 08 表 P 系列核销 |
| R-B1 | 真实浏览器实测窗口 | spike 报告**固定路径 `docs/agent-evolution/B1-browser-script-channel-spike.md`**；评审清单（缺一不过）：①安全清单五项逐项证明 ②DSL/JS 沙箱形态选型与理由 ③翻页取数实测回合数与降幅（目标 ≥80%）④CDP 共存性结论 ⑤与生产隔离声明。评审通过解锁 B4/B5 |

---

## 轨道 A：专项 agent 实体与转办（设计出处：04 篇）

### EP3-A1 agents 表迁移 + persona 模板候选
- **改动文件**：`migrations.ts`（055：`agents` 表——id/name/charter/persona_ref/status/created_at，**仅建主 agent 一行**，08/04 迁移口径；**056：`task_projections` 加 `owner_agent_id` TEXT 列**——A2 注入解析与 A4 归属切换的 schema 基础；A1 同单占用连续两号 055/056，与单执行顺序 A1→PK1 及编号连续 gate（check-migration-numbering-sequential）一致）、**`ownerAgentId` 走 Q1 范式全链**（main/wire `TaskProjectionRecord` 增 `ownerAgentId?: string | null`、repository create INSERT/update 白名单/mapRow、renderer `electron.d.ts` 副本；任务卡 UI 只读消费不新增猜测——O 合同纪律；本单只立列与读写链，**写值唯一来自 A4**）、`repositories/agent-registry-repository.ts`（新增：list/get/create，读写收敛）、persona 模板候选机制（PersonalityEditor 数据层预留，不动 UI）、新增 `src/__tests__/migration-agents-table.test.ts`
- **实施要点**：**存量零感知**——agents 表只有主 agent 行时系统行为 = 现状（断言级）；旧会话零行为变化；表为空时回退现状（防迁移失败半态）。
- **测试（先红）**：迁移幂等（fake DB + 按名隔离，055/056 各自隔离）；仅主 agent 行；空表回退；registry 往返；ownerAgentId repository create-get 往返 + NULL 兼容。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/migration-agents-table.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~260 行。

### EP3-A2 per-agent RULES/knowledge 注入底座（owner 参数化；端到端验收归 A4）
- **改动文件**：`prompt-assembly.ts`（注入源按**本轮任务 owner** 解析：owner agent 的 RULES/knowledge 作用域优先，无 owner 回退 `scope.agent`——K3/A 轨叠加，复用既有 RULES/index 注入通道不另起）、`belief-card-store.ts`（按 agent 作用域目录读取：`agents/<id>/knowledge/`，全局目录回退）、**`tools/memory-tools.ts` 与 `tools/schemas/memory-schemas.ts` 的 memory_write_card/memory_read_card 描述同步**（底层路径守卫已允许 `agents/<id>/knowledge/*.md`，但暴露给模型的说明仍写"仅 knowledge/ 与 knowledge/sites/"——A2 落地 per-agent 目录时必须同步，否则 C3/C5 的模型写卡会被提示词误导）、新增 `src/__tests__/per-agent-injection.test.ts`
- **实施要点**：**A2 是底座单**——owner 来源为注入解析参数（本轮任务 projection 的 ownerAgentId，A1 列已就位；无值回退 scope.agent），用 **fixture 投影**驱动测试（直接构造带不同 ownerAgentId 的 projection 行），不依赖 A4 的切换工具；真实的采纳-owner 变更-注入切换端到端验收**归 A4**。他 agent 谱系卡片零泄漏（C4.3 纪律延伸）；预算沿用 K3 常量（RULES 全局+agent 合计 ≤2000 字符——01 §7b 口径在此兑现）。
- **测试（先红）**：fixture 投影 ownerAgentId=X 与 Y 注入快照不同；无 owner 回退 scope.agent；跨 agent 零泄漏；预算合计截断。（owner 真实切换链路断言在 A4。）
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/per-agent-injection.test.ts src/__tests__/knowledge-injection-snapshot.test.ts && npm run typecheck`
- **规模**：~240 行。

### EP3-A3 charter 列表与 routing 索引注入
- **改动文件**：`prompt-assembly.ts`（主 agent 会话 L1.5 增 charter/routing 段：来自 agents 表 charter + `routing-*.md` 卡，过预算截断计入 context_bill 新键 `L1_5_agent_routing`）、新增 `src/__tests__/agent-routing-injection.test.ts`
- **实施要点**：仅主 agent 会话注入（专项 agent 会话不注入彼此 charter——主 agent 保持薄的反面约束）；空表/无路由卡 → 段省略。
- **测试（先红）**：注入预算与截断；仅主 agent 会话；空态省略；context_bill 计入。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-routing-injection.test.ts && npm run typecheck`
- **规模**：~180 行。

### EP3-A4 agent_propose_handoff 工具 + 转办建议卡 + 同会话归属切换
- **改动文件**：新增 handoff 工具（携 `userRequestVerbatim` + context refs，**禁止摘要**——I4 铁律在此立面）、转办建议 UI 卡（复用 ask_user_questions 卡机变体范式，§7 最小闭环：IPC/preload/类型/组件）、任务 owner 切换（写 A1 既有 `ownerAgentId` 列——**全仓唯一写值点**，经 repository update；同会话默认/新会话可选）、新增 `src/__tests__/agent-handoff-proposal.test.ts`
- **实施要点**：提议 → 用户采纳 → 任务卡 owner 变更 + 聊天连续 + 后续轮注入切换（A2 通道生效）；用户拒绝 → 结构化拒绝回模型；新会话路径预填原话。**工具属 M4（建议性，不执行外部动作），但采纳动作走用户点击——无确认自动转办不存在。**
- **测试（先红）**：**端到端：提议、采纳、ownerAgentId 写值、A2 注入切换（A2 降级掉的验收在此兑现）**；verbatim 逐字断言；拒绝路径；新会话预填。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-handoff-proposal.test.ts && npm run typecheck`
- **规模**：~300 行。

---

## 轨道 C：LLM 维护回合与涌现候选（设计出处：03 篇）

### EP3-C3 维护回合提示词 + SubAgent 容器接线
- **改动文件**：维护回合提示词资产（X3 loader，`assets/prompts/maintenance/`）、SubAgent 容器接线（**钉死为 `agent-control/sub-agent/sub-agent-runner.ts` 的 `runSubAgent` 一套**——不是 skill child、不是浏览器后台 sub-agent，**禁止新建第四套 runner**；四项决策：取消=沿用其 abortSignal 通道、预算=维护回合自带迭代上限；**token/用量审计走 maintenance metric 与单行日志，不直接写 run_meta**——runSubAgent 只是事件容器不拥有账本，若维护回合确需 run_meta 行（终态），必须经既有 finalizer/ledger 入口（finalizeRunOutcome 通道），禁止旁路（与本合同 §0.4 终态禁旁路条款同源）、日志=每轮单行报告进 maintenance 审计 + 既有 agent metrics、错误=runner 终态回灌 breadcrumb 不冒泡；job 生命周期挂 EP2-C2 的 `CrystallizeScheduler`/`runCrystallizeRound` 之后——确定性动作先跑，LLM 回合后置）、信号采集（learningRefs/CheckIn 摘要/staged 卡清单——**摘要不全文**）、EP2-C6 衰减轮接线（真实 backlinks/access 信号喂 `runBeliefDecayRound`）、新增 `src/__tests__/maintenance-llm-round.test.ts`
- **实施要点**：C2 门控 skip → LLM 零调用（断言）；产出只能是 `memory_write_card` 调用清单（格式校验拒坏卡）；空轮干净退出留 breadcrumb；每轮单行报告进 maintenance 日志（03 §5 格式）。
- **测试（先红）**：喂固定信号集 → 产出预期卡片操作（fake LLM）；门控 skip 零调用；坏卡产出被校验拒绝；空轮退出；衰减轮以真实信号驱动。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/maintenance-llm-round.test.ts src/__tests__/crystallize-gate.test.ts src/__tests__/belief-decay-deterministic.test.ts && npm run typecheck`
- **规模**：~280 行。

### EP3-C4 CAS 合并工具（USER.md 决策门）
- **改动文件**：新增 `agent-control/maintenance/cas-merge.ts`（**CAS 协议作用于 DB 真值，不是文件**：读 DB 行快照 hash → 内存合并 ≤40 行 → **同一事务内 hash 比对一致才条件写**，不一致良性跳过 exit-0 语义 + 审计行；03 §4 的"临时文件→rename"协议仅在 USER.md 镜像同步这一 fallback 子步骤复用，绝不是主写入路径）、USER.md 决策门（"纯项目工作不进画像；不为了写而抢锁"为代码判定）、新增 `src/__tests__/cas-merge.test.ts`
- **真值源对齐（HEAD 取证，loadUSER 读取顺序=user_profiles → resident_user memory → USER.md fallback）**：**C4 不做 USER.md 文件 CAS 主路径**。主写入必须是 **DB 事务/CAS**，覆盖 user_profiles 画像行与/或 resident_user memory（经 memory repository，hash 取 DB 行内容）；USER.md 仅在 DB 无行的 fallback 场景同步为可读镜像。施工自查红线：合并完成后 `loadUSER` 的 DB 优先路径必须读到结果——"写了文件但主路径不读"即违约。
- **测试（先红）**：双写者交错只成功一个、失败方良性跳过无半态；审计行正确；≤40 行约束；决策门拒纯项目内容；**合并后主路径（DB 优先 loadUSER）能读到结果**。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/cas-merge.test.ts && npm run typecheck`
- **规模**：~220 行。

### EP3-C5 涌现候选维护 + 建议卡投影
- **改动文件**：候选 extractor（同域相似请求 ≥2 次/稳定输入输出 → `aspire` 卡 `status: hint|candidate`，证据带日期 + 升降置信度条件）、路由卡修复（已有专项 agent 但请求落主 agent → `routing-*.md`）、修剪建议卡（**只建议不执行**）、`emergence-cards.ts` 增 candidate→意图流投影（candidate + 证据 ≥3 条才投影，复用 crystallize 类型显式确认）、新增 `src/__tests__/emergence-candidate-maintenance.test.ts`
- **实施要点**：候选确认后的派生执行属阶段四 A6——本单出口只挂"已记录，待派生流程上线"占位动作或路由卡修复。
- **测试（先红）**：模拟两次相似请求 → candidate 卡生成且 evidence 可解释；证据 <3 不投影；修剪卡不执行；观察句措辞。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/emergence-candidate-maintenance.test.ts src/__tests__/emergence-card-extractors.test.ts && npm run typecheck`
- **规模**：~260 行。

---

## 轨道 PK：任务包编译层（设计出处：09 篇）

### EP3-PK1 包字段约定 + 两层校验
- **改动文件**：`migrations.ts`（**057**：task_projections 加 `context_refs_json` 列 + `packet_role` 单列定死——09 §2；编号在 A1 的 055/056 之后，与单执行顺序一致）、wire/repository 全链（Q1 范式：wire 类型/INSERT/update 白名单/mapRow/safeParse 回退，禁 raw SQL 硬条款沿用）、嵌套 ≤2 层校验函数、新增 `src/__tests__/migration-packet-columns.test.ts`
- **测试（先红）**：迁移幂等按名隔离；三层嵌套被拒；repository 往返；NULL/malformed 回退。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/migration-packet-columns.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~220 行。

### EP3-PK2 编译器提示词资产 + 触发门槛
- **改动文件**：编译器提示词资产（X3 loader）、触发门槛代码判定（**direct_answer 永不分包**；multi_step + 多目标才进编译；门槛是代码不是模型）、包树产出校验（合法 packet_role/嵌套/refs）、新增 `src/__tests__/packet-compiler-gate.test.ts`
- **测试（先红）**：direct_answer 永不分包；门槛矩阵；fake LLM 产出包树校验（坏树拒绝）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/packet-compiler-gate.test.ts && npm run typecheck`
- **规模**：~240 行。

### EP3-PK3 执行通道查表分发 + verbatim 注入
- **改动文件**：通道查表（chat 子轮/SubAgent/技能子进程三通道，静态表）、SubAgent 与技能注入的 `userRequestVerbatim` 字段改造（I4 的技能子项在此落地）、新增 `src/__tests__/packet-dispatch-channels.test.ts`
- **实施要点**：brief = 用户原话片段 + 结构化 refs，逐字断言；通道选择是查表不是模型判断。
- **测试（先红）**：三通道各一条端到端（fake 执行器）；brief 逐字断言；未知通道 fail-fast。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/packet-dispatch-channels.test.ts && npm run typecheck`
- **规模**：~260 行。

### EP3-PK4 汇总包模板 + 子包失败三选一 + 上行报告
- **改动文件**：汇总包模板、子包失败处置（重派 ≤1 次/降级/阻塞三选一，**静默吞失败 = 测试红**）、上行报告合同（父包 CheckIn 经 Q4a shadow 通道落账——不碰终态，enforce 行为随遗留轨 Q4b 自动升级）、新增 `src/__tests__/packet-failure-upstream.test.ts`
- **测试（先红）**：子包失败 → 父包正确重派/降级/阻塞各一条；静默吞断言红；上行 CheckIn 落账。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/packet-failure-upstream.test.ts && node scripts/check-checkin-funnel.cjs && npm run typecheck`
- **规模**：~280 行。

---

## 轨道 I/B/E：传话铁律、浏览器守卫、反馈个性化

### EP3-I4 最小传话收口（前置：A4 + PK3）
- **改动文件**：A4 handoff 工具与 PK3 注入已分别立 verbatim 面（09 篇 PK3→I4 依赖由 PK3 子项满足）；本单收口残余转发点（sub-agent 派发既有路径）+ 全局断言测试 `src/__tests__/verbatim-relay.test.ts`
- **测试（先红）**：三类转发点（handoff/SubAgent/技能注入）转发内容 = 原话 + refs，无摘要拼接（逐字断言矩阵）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/verbatim-relay.test.ts && npm run typecheck`
- **规模**：~160 行。

### EP3-B4 浏览器运行时守卫（前置：R-B1 报告评审通过）
- **改动文件**：locator 唯一性 fail-fast（`locator_ambiguous` 结构化错误回灌模型）+ snapshot 陈旧检测（操作前 DOM 代际比对）、新增 `src/__tests__/browser-runtime-guards.test.ts`
- **实施要点**：守卫在执行层，不改 live-target 安全网四收口入口（runGuarded* 不动，叠加在其后）；fail-fast 不静默重试。
- **测试（先红）**：歧义 locator → 结构化错误 + 模型恢复路径；陈旧 snapshot → 拒执行；安全网回归（live-target 29 测不动）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/browser-runtime-guards.test.ts src/__tests__/action-confirmation-live-target.test.ts && npm run typecheck`
- **规模**：~240 行。

### EP3-B5 planner 降级 + workflow 接包（前置：I4 + PK3 + R-B1）
- **改动文件**：planner 输出降级为结构化目标（不改写用户任务）、workflow 接 PK 包（brief verbatim 直达执行侧）、新增 `src/__tests__/planner-verbatim-workflow.test.ts`
- **测试（先红）**：**计划改写消失断言**——执行侧收到的 brief = 用户原话片段；workflow 接包端到端。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/planner-verbatim-workflow.test.ts && npm run typecheck`
- **规模**：~260 行。

### EP3-E3 反馈日志 + 卡类型开关（前置：R-E2）
- **改动文件**：意图流 dismiss 持久化（feedback 日志表或 settings 键——施工第一步核对 HEAD 存量）、卡类型开关（设置项，关闭类型不再投影）、新增 `src/__tests__/emergence-feedback.test.ts`
- **测试（先红）**：dismiss 持久化跨重启；关闭类型零投影；开关恢复。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/emergence-feedback.test.ts && npm run typecheck`
- **规模**：~200 行。

### EP3-E4 权重漂移（前置：E3 + C3）
- **改动文件**：维护回合消化反馈日志 → preference 卡（staged 起步，可见可删）、连续驳回 N 次（N=3，常量）→ 该类卡 confidence 降权、新增 `src/__tests__/emergence-weight-drift.test.ts`
- **测试（先红）**：连续驳回 3 次 → 权重下降且 preference 卡可见可删；删卡 → 权重恢复默认。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/emergence-weight-drift.test.ts && npm run typecheck`
- **规模**：~200 行。

---

## 收口

### EP3-G3 verify 链与文档同步
- **改动文件**：`package.json` 新增 `verify:evolution-p3`（本阶段全部焦点测试 + 串 `verify:evolution-p2` 内的四 gate + `verify:native`）；CLAUDE.md/AGENTS.md §2/§8 同步（agent 实体注入面、packet 嵌套上限、最小传话铁律、维护回合门控）；08 表回填；**I5 仅复核行核销**（EP2-K4 证据：rules-default-asset.test.ts 快照）。
- **最终验证门（可执行）**：`npm run verify:evolution-p3 && npm run verify:evolution-p2 && npm run verify:evolution-p1 && npm run verify:stability && npm run typecheck`；全量 test 沿用"基线失败清单不新增"口径（清单归 base 分支，见阶段二合同 G2）。
- **规模**：~80 行。

## 阶段验收（08 表回填）

| 设计验收断言 | 工单 |
|---|---|
| agents 表仅主 agent 行时系统 = 现状（存量零感知） | A1 |
| 同会话不同 owner 任务轮次注入不同；跨 agent 卡片零泄漏 | A2 |
| 提议 → 采纳 → owner 变更 + 聊天连续 + 注入切换；verbatim 逐字 | A4/I4 |
| 门控 skip → LLM 零调用；维护写卡全走 memory_write_card；空轮可审计 | C3 |
| 双写者 CAS 交错只成功一个、无半态 | C4 |
| 两次相似请求 → candidate 卡 + 可解释证据；只建议不执行 | C5 |
| direct_answer 永不分包；三层嵌套被拒；子包失败禁静默（三选一 + 上行） | PK1-PK4 |
| 计划改写消失：执行侧 brief = 用户原话片段 | PK3/B5 |
| locator 歧义 fail-fast 回灌；live-target 安全网零回归 | B4 |
| 连续驳回 → 降权 + preference 卡可见可删 | E3/E4 |
| 遗留轨：零 proof 判 done = 0（enforce 后）；意图流行动出口可用 | R 轨 |
