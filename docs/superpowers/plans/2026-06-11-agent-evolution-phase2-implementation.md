---
title: Agent Evolution 阶段二（知识与质量闭环）实施子计划
date: 2026-06-11
status: draft v1 — 待 Codex 合同评审；评审通过前不开工、enforce 不生效
revision_history:
  - v1 (2026-06-11): 初稿。依据 docs/agent-evolution/00 路线图阶段二范围 + 01/02/03/05/06/07/10/11 各篇工作包表拆单；并入阶段一显式移交项（I-auth 对象级授权、K6 启动接线 syncBeliefCards、frozen-call 审计迁 proof_refs、T4 重试分级收敛、type_at/type_smart 视觉通道残余→B1）。
owner: 白
author: Claude (Fable 5)
executor: 待定（Claude / Codex 逐单施工）
reviewer: Codex（共识）+ Claude（终审）
enforce: false
note: >
  阶段一（2026-06-11-agent-evolution-phase1-implementation.md，13 单全部合入，
  回归入口 verify:evolution-p1）交付了可观测与安全地基。本阶段交付"知识与质量闭环"：
  完成必有证据与裁决（Q）、记忆确定性自治（K/C）、账本可信（T）、意图增量（I）、
  意图流上线（E）、批量执行 spike（B1）。工单纪律沿用阶段一：先红测试后实现、
  每单 ≤约 300 行 diff、单独 commit、不顺手重构。
  阶段门（00 §4）：08 表 P 系列全部核销 + verify:stability 新增断言全绿。
pairs_with:
  - docs/agent-evolution/00-路线图与目标架构总览.md（阶段二范围）
  - docs/agent-evolution/08-缺陷解决映射与验收追踪.md（验收脊柱，工单合入后回填）
related:
  - docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md（已合入基线）
  - docs/superpowers/plans/2026-06-10-agent-stability-closure-implementation.md（S 系列基线；Q4/T3 在其收口通道内扩展）
  - docs/agent-evolution/01/02/03/05/06/07/10/11（本阶段工单的设计出处）
---

# Agent Evolution 阶段二实施子计划

## 0. 总则

1. **轨道与串行约束**
   - 轨道 Q（质量框架，02 篇）：Q1 → Q2/Q3（并行）→ Q4 → Q5 → Q6，主串行链。**Q4 是全阶段唯一触碰 `run-finalizer.ts` 的工单**——所有 CheckIn/裁决写入必须在 `finalizeRunOutcome()` 收口通道内扩展，`check-run-finalize-funnel.cjs` 必须保持绿（不开旁路）。
   - 轨道 K（知识注入与真值源，01 篇）：K3 → K4；K6 **先子合同后施工**（见 EP2-K6C）。
   - 轨道 C（确定性维护 v1，03 篇）：C1 / C2 并行 → C6。**v1 全确定性、零 LLM**（03 §6 分期原则为准；C6 在 03 工作包表中对 C3 的依赖按 v1 口径解除——本阶段只做代码可判定的升降档/清理子集）。
   - 轨道 X（上下文增强，06 篇）：X1b（Q1 后）；X2（Q4 后，且施工第一步先做 HEAD 预算账本勘探——历史上 budget 接线存在"checkpoint 仅耗尽写/续跑重置用量"等半态，勘探结论写入工单再动手）。
   - 轨道 I（意图增量，05 篇）：I-auth-D（设计补充文档单，先行）→ I1 → I2 → I-auth（实现）。I2 与 I-auth 都触碰 `tool-executor.ts`，**轨内串行**；本阶段无其他工单碰该文件。
   - 轨道 T（账本可信，07 篇）：T1（Q1 后）→ T2 → T3；T4-3（重试分级收敛，独立小单）。T3 触碰 finalizer 通道，排在 Q4 之后。
   - 轨道 E（意图流，10 篇）：E1（Q1 后）→ E2（Q5 后）。v1 只做 resume / follow-up / 沉淀三类卡。
   - 轨道 B（浏览器，11 篇）：B1 spike 独立并行，产物是报告不是代码合入；不进 verify 链。
   - **共享文件矩阵**：`prompt-assembly.ts`（K3、X1b——串行，K3 先）；`run-finalizer.ts`（Q4、T3——串行，Q4 先）；`tool-executor.ts`（I2、I-auth——串行）；`migrations.ts`（Q1、T1 若需列——一律末尾追加，编号 gate 兜底）。
2. **每单交付物**：失败测试 → 实现 → 焦点验证命令绿 → `npm run typecheck` 绿；涉及 SQLite 迁移的工单（Q1、T1）加 `npm run verify:native`。
3. **每单提交**：单独 commit，message 引用工单号（如 `feat(agent): EP2-Q1 task projection quality columns`）。
4. **gate 汇总**：末单 G2 新增 `verify:evolution-p2`；02/07 篇验收红线测试（checkin-funnel gate、criteria 矩阵、ledger-consistency、reconcile-orphan-closure、tool-envelope-retry-matrix）按各自工单同步挂入 `verify:stability`。
5. **禁止事项**
   - 终态只能经 `finalizeRunOutcome()` 收口；Q4/T3 不得新增通道外终态写点（S 系列硬合同）。
   - 零 proof 判 done = 0 是硬规则：adjudicator 不得因"模型说完成了"放行（02 §4）。
   - 账本单向上行：执行级→事件→task 级→run 级，唯一写入者；T2 gate 转 error 前先以 warning 跑一个版本收集存量违规清单（07 §5 风险条）。
   - staged 卡片内容不得进入任何注入路径（K3 接线时此禁令成为可测真值，01 §3.3）；index/RULES 注入必须过预算截断并计入 context_bill。
   - 维护任务（C 轨）只走 `memory_write_card` 校验写入，禁止直接 fs 写卡；坏卡置 invalid 不删除。
   - 意图流卡 ≤8 张硬上限 + confidence 门槛；卡类型可关；不得绕过 02 的裁决出口直接改任务终态。
   - LLM 只做判断题：裁决规则、门控矩阵、衰减阈值、负面类别拦截一律代码实现。
   - B1 spike 期间不得向生产暴露任何脚本执行工具；高风控站点硬拦不因 spike 放宽（11 §4 风险条）。

---

## 轨道 Q：任务执行质量框架（设计出处：02 篇）

### EP2-Q1 task_projections 质量列迁移
- **改动文件**：`migrations.ts`（054：`task_projections` 加 `criteria_json/checkins_json/proof_refs_json/learning_refs_json` 四列 + `check_in_pending` 状态枚举兼容）、新增 `src/__tests__/migration-task-quality-columns.test.ts`
- **实施要点**：旧行 NULL 兼容；三列治理上限（checkins ≤50、proof_refs ≤100，超限滚动归档 `<outputDir>/task-archive.jsonl`）随 Q3/Q4 写入端实现，本单只立列；zod schema 校验函数同文件预置（写入前校验，malformed 拒写并告警）。阶段一 frozen-call 审计事件迁 proof_refs 的 TODO 在 Q4 接线时一并兑现。
- **测试（先红）**：迁移幂等（fake DB 范式 + 按名隔离）；旧行 NULL 读取兼容。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/migration-task-quality-columns.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~140 行。

### EP2-Q2 Criteria 模板引擎
- **改动文件**：新增 `agent-control/quality/criteria-templates.ts`（task_type × module 二维查表 + 计划阶段模型补充接口）、新增 `src/__tests__/criteria-template-matrix.test.ts`
- **实施要点**：六类 task_type（direct_answer/short_task/multi_step_task/media_task/continuation/research）× 三类 module 全键覆盖；模板键与 HEAD 枚举一致性断言（防 task_type 漂移）；`not_applicable` 必须显式带理由，不可静默删除。
- **测试（先红）**：全键覆盖矩阵；HEAD 枚举一致性；not_applicable 理由必填。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/criteria-template-matrix.test.ts && npm run typecheck`
- **规模**：~280 行。

### EP2-Q3 Proof 自动采集
- **改动文件**：新增 `agent-control/quality/proof-collector.ts`（工具结果/artifact/task_event/run_state 四源 → proof_refs 行）、接线点跟随 HEAD（工具结果在 tools-runtime 出口、task_event 在 TaskEventBridge 监听——additive listener，不改桥本体）、新增 `src/__tests__/proof-collection-four-sources.test.ts`
- **实施要点**：四源各自落一条结构化 proof（kind/ref/ts/digest）；上限治理与归档按 Q1 预置 schema；采集失败不阻断主流程（记 metric）。
- **测试（先红）**：四源各一条 proof 落库；超限滚动归档；malformed 拒写。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/proof-collection-four-sources.test.ts && npm run typecheck`
- **规模**：~260 行。

### EP2-Q4 task-adjudicator 与 finalizer 接线（本阶段最大风险单）
- **改动文件**：新增 `agent-control/quality/task-adjudicator.ts`（完成硬规则 + 准入校验 + CheckIn 组装）、`runtime-core/run-finalizer.ts`（在 `finalizeRunOutcome()` 内调用 adjudicator——通道内扩展，不开旁路）、新增 `scripts/check-checkin-funnel.cjs` gate、新增 `src/__tests__/run-finalizer-checkin.test.ts`
- **实施要点**：五条终态路径各产生正确 CheckIn；**零 proof 判 done 被拒**（降级为带 blocker 的非 done 终态）；learningDecision=memory_card 不满足准入（先写文件后记 learningRefs）→ 降级；阶段一 frozen-call released/denied/expired 审计行迁 proof_refs；`check-run-finalize-funnel.cjs` 全程保持绿。
- **测试（先红）**：扩展 run-finalizer-all-paths 范式——五路径 CheckIn；零 proof 拒 done；准入降级；funnel gate 不破。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/run-finalizer-checkin.test.ts src/__tests__/run-finalizer-all-paths.test.ts && node scripts/check-checkin-funnel.cjs && node scripts/check-run-finalize-funnel.cjs && npm run typecheck`
- **规模**：~300 行。

### EP2-Q5 待裁决队列与任务卡裁决出口
- **改动文件**：`SystemReminderRegistry` 注册 check_in_pending 提醒（不内联文案）、任务卡 projection 增裁决字段 + renderer 裁决按钮（§7 最小闭环：IPC + preload + 类型 + 组件）、新增 `src/__tests__/checkin-pending-reminder.test.ts`
- **实施要点**：check_in_pending 在下轮被优先处理；UI 只消费 projection 派生状态（O 合同纪律）；裁决动作经专用 IPC 回 adjudicator，不在 renderer 猜终态。
- **测试（先红）**：pending 注提醒；裁决 IPC 行为；projection 字段渲染。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/checkin-pending-reminder.test.ts && npm run typecheck`
- **规模**：~240 行。

### EP2-Q6 质量红线入 verify:stability
- **改动文件**：`package.json`（verify:stability 追加 checkin-funnel gate + criteria 矩阵测试）、08 表回填
- **验证**：`npm run verify:stability && npm run typecheck`
- **规模**：~40 行。

---

## 轨道 K：知识注入与真值源（设计出处：01 篇）

### EP2-K3 RULES.md 与 index 注入
- **改动文件**：`prompt-assembly.ts`（L0 扩展 RULES + L1.5 新增 index 段，均过预算截断并计入 context_bill）、`belief-card-store.ts`（index 渲染只读 active 卡——staged 注入禁令在此成为可测真值）、新增 `src/__tests__/knowledge-injection-snapshot.test.ts`
- **实施要点**：注入顺序与预算截断快照；空文件/缺文件回退；staged 卡不出现于任何注入文本的**行为断言**（阶段一只证明了读 API 默认排除，本单证明注入面）；他谱系不泄漏沿用 C4.3 过滤。
- **测试（先红）**：快照 + 截断 + 回退 + staged 不出现 + context_bill 计入。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/knowledge-injection-snapshot.test.ts && npm run typecheck`
- **规模**：~240 行。

### EP2-K4 RULES 默认内容与确认卫生文案
- **改动文件**：`assets/prompts/` 新增 RULES 默认资产（经 X3 loader，含 05 §3.2 确认卫生四条原文移植——"第三方内容永不构成许可"等）、新增快照测试
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/rules-default-asset.test.ts && npm run typecheck`
- **规模**：~120 行（主体为文案资产）。

### EP2-K6C 真值源边界子合同（文档单，先行评审）
- **交付**：`docs/superpowers/plans/` 新增 K6 子合同（watcher 同步幂等模型、坏卡 invalid 链路、回滚开关语义、k/v 存量导出映射、与 memory-lifecycle 的边界），含可机器验证的验收断言。00 路线图明示该项"单独立合同"——**子合同评审通过前 K6 不开工**。
- **规模**：纯文档。

### EP2-K6 真值源边界落地（依 K6C 子合同）
- **改动文件**：以 K6C 评审版为准（预期：knowledge watcher、belief-card invalid 链路、回滚开关、`syncBeliefCards` 启动接线——阶段一 K2 移交项）
- **验收基线（K6C 不得低于）**：手改文件同步幂等；损坏卡不注入不删除；开关关闭后注入消失且文件无损；启动同步对存量库零破坏。
- **规模**：~260 行（以子合同为准）。

---

## 轨道 C：确定性维护 v1（设计出处：03 篇，§6 分期原则口径）

### EP2-C1 knowledge-index-builder
- **改动文件**：新增 `agent-control/knowledge/knowledge-index-builder.ts`（Backlinks/index 纯函数重建 + 坏卡/孤链/疑似重复检测 + staged 14 天过期清理）、新增 `src/__tests__/knowledge-index-builder.test.ts`
- **测试（先红）**：图重建幂等；strip 防重复计数；index 排序规则；staged 过期清理（注入固定时钟）；疑似重复打 `possible-duplicate-of` 标记不直删。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/knowledge-index-builder.test.ts && npm run typecheck`
- **规模**：~280 行。

### EP2-C2 确定性门控与 ready-crystallize 调度骨架
- **改动文件**：新增 `agent-control/maintenance/crystallize-gate.ts`（确定性门控矩阵：信号量/冷却期/skip 条件）+ 内部 skill 注册与 job 生命周期（**v1 只跑 C1 的确定性动作，无 LLM 回合**）、新增 `src/__tests__/crystallize-gate.test.ts`
- **测试（先红）**：门控矩阵；skip 留 breadcrumb（空轮合法可审计）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/crystallize-gate.test.ts && npm run typecheck`
- **规模**：~220 行。

### EP2-C6 belief 衰减接管（确定性子集）
- **改动文件**：memory-lifecycle 的 belief 分支改走 access_count/was_useful 驱动升降档（先降档后删除；近重复标记不直删）、新增 `src/__tests__/belief-decay-deterministic.test.ts`
- **实施要点**：v1 全代码判定，无 LLM；阈值进配置常量并写入工单注释；与既有 30/90 天时间衰减并存一个版本（开关可回退）。
- **测试（先红）**：升降档矩阵；先降档后删除；标记不直删。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/belief-decay-deterministic.test.ts && npm run typecheck`
- **规模**：~180 行。

---

## 轨道 X：上下文增强（设计出处：06 篇）

### EP2-X1b 任务索引增强
- **改动文件**：`daily-task-index-builder.ts`（补 blockerCategory/criteria 进度/待裁决标记——读 Q1 新列）、扩展既有测试
- **测试（先红）**：增强字段渲染；X1a 行为零回归（无祈使句/谱系过滤断言保持）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/daily-task-index.test.ts && npm run typecheck`
- **规模**：~140 行。

### EP2-X2 预算转向提醒
- **前置勘探（写入工单后再施工）**：HEAD 预算账本可信度核对——checkpoint 写入路径、续跑用量累计、kill 路径终态；任一半态须先修复或在工单内显式声明边界。
- **改动文件**：新增 budget-steer reminder（70/90% 文案经 X3 资产化、`SystemReminderRegistry` 注册）、100% 触顶对接 Q4 checkpoint CheckIn、新增 `src/__tests__/budget-steer-injection.test.ts`
- **测试（先红）**：触顶前至少一轮收到 90% 转向；触顶产生 checkpoint CheckIn；文案来自资产快照。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/budget-steer-injection.test.ts && npm run typecheck`
- **规模**：~220 行。

---

## 轨道 I：意图增量与对象级授权（设计出处：05 篇）

### EP2-I-auth-D 对象级动作授权设计补充（文档单）
- **交付**：05 篇 §3 补"I-auth"设计：把"用户对哪个对象批准了哪个动作"结构化为可证明授权事实（来源=用户原话/确认卡答复；key=对象指纹+动作类别；TTL 与会话谱系边界；与 frozen-call 指纹的对账关系）。**评审通过前 I-auth 实现不开工**；M3 预批准与"同对象同动作免重复确认"解禁均以此为前置。
- **规模**：纯文档。

### EP2-I1 状态优先决策序
- **改动文件**：跟进意图入口先查 task ref 事实再进分类器（S4-1 增量）；分类器输入增强（任务 ref 状态喂兜底分支）、新增 `src/__tests__/intent-state-first-routing.test.ts`
- **测试（先红）**：无任务时"继续"→new_task；有 active 时任意措辞进度询问→status_query。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/intent-state-first-routing.test.ts && npm run typecheck`
- **规模**：~180 行。

### EP2-I2 否定语义三层加深
- **改动文件**：`tool-executor.ts` dispatch 层否定拦截（命中否定类别 → `denied_by_user_negation`，信封 kind 已预留）、negations 写入 TurnFrame 持久化（生命周期=会话谱系，显式解除信号）、类别从 collection 扩展到与 05 §3 动作清单对齐、新增 `src/__tests__/negation-intent.test.ts`
- **实施要点**：暴露压制层（既有）+ dispatch 拦截层双保险；TurnFrame 写经声明的 frame patch 通道（M 合同）；解除信号由分类器输出，不做正则白名单。
- **测试（先红）**："不要采集，只看看"双层均拦；解除信号生效；类别扩展矩阵；与确认闸门顺序（否定拦截在闸门之前——拒绝权优先于确认权）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/negation-intent.test.ts && npm run typecheck`
- **规模**：~260 行。

### EP2-I-auth 对象级授权实现（依 I-auth-D 评审版）
- **改动文件**：以评审版为准（预期：授权事实存取 + 确认卡答复落授权 + M3 预批准接线 + 阶段一禁缓存条款的受控解禁）
- **硬边界**：第三方内容永不写入授权事实；授权 key 必须含对象指纹（与 frozen-call sha256 同源）；M1 永不受授权影响。
- **规模**：~280 行（以设计为准）。

---

## 轨道 T：账本可信（设计出处：07 篇）

### EP2-T1 所有权矩阵与 run_meta 快照化
- **改动文件**：07 §1 矩阵成文入仓（docs）、冗余字段口径源改造（run_meta 收口快照化，唯一写入者=finalizer）、必要迁移列、新增 `src/__tests__/ledger-consistency.test.ts`
- **测试（先红）**：同 run 双账本口径一致。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/ledger-consistency.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~240 行。

### EP2-T2 写方向 gate 与 malformed-ignored
- **改动文件**：新增 `scripts/check-ledger-write-direction.cjs`（**先 warning 模式跑一个版本**收集存量违规清单，转 error 走后续小单）、消费端 malformed 行跳过 + metric、新增测试
- **测试（先红）**：gate 扫描；注入坏行 → UI 跳过 + metric。
- **验证**：`node scripts/check-ledger-write-direction.cjs && npx tsx@^4.19.2 --test src/__tests__/ledger-malformed-ignored.test.ts && npm run typecheck`
- **规模**：~200 行。

### EP2-T3 reconcile 泛化
- **改动文件**：周期轻量 reconcile + finalizer 通道收尸（在 Q4 之后动 run-finalizer 周边；不开通道外终态写点）、新增 `src/__tests__/reconcile-orphan-closure.test.ts`
- **测试（先红）**：kill -9 重启 → 孤儿行全部关闭且 blockerCategory 正确、可续跑。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/reconcile-orphan-closure.test.ts && node scripts/check-run-finalize-funnel.cjs && npm run typecheck`
- **规模**：~240 行。

### EP2-T4-3 重试分级收敛（阶段一 T4 移交项）
- **改动文件**：tool-executor 公共层新增重试助手（429 尊重 Retry-After + 退避 ≤2；5xx/网络 ≤2；401/403 与 arg_error 零重试），首批迁移 1-2 个外呼域（general_research 优先），未迁移域不动、新增 `src/__tests__/tool-envelope-retry-matrix.test.ts`
- **测试（先红）**：分级矩阵；401 零重试；429 退避 ≤2；未迁移域行为不变快照。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/tool-envelope-retry-matrix.test.ts && npm run typecheck`
- **规模**：~220 行。

---

## 轨道 E：意图流 v1（设计出处：10 篇）

### EP2-E1 涌现内核与三类卡
- **改动文件**：新增 EmergenceCard schema + resume/follow-up/沉淀三个 extractor（读 Q1 任务信号字段）、新增 `src/__tests__/emergence-card-extractors.test.ts`
- **测试（先红）**：三类卡各自从 fixture 信号正确产出且 evidence 完整；confidence 门槛；≤8 张上限。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/emergence-card-extractors.test.ts && npm run typecheck`
- **规模**：~280 行。

### EP2-E2 工作台意图流视图与行动出口
- **改动文件**：工作台意图流视图（renderer 组件 + projection 投影 + §7 最小闭环）、行动出口接线（续跑/裁决——裁决出口复用 Q5 的 IPC，不另立通道）、新增 `src/__tests__/emergence-feed-actions.test.ts`
- **实施要点**：UI 只消费 projection；与文件树视图同对象去重；视觉以 workbench 极简基准（宽度收紧/hover 全覆盖）。
- **测试（先红）**：blocked 任务 → 卡 → 点击续跑成功；卡上限与去重。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/emergence-feed-actions.test.ts && npm run typecheck`
- **规模**：~300 行。

---

## 轨道 B：批量执行通道 spike（设计出处：11 篇）

### EP2-B1 spike（并行长线，产物=报告）
- **交付**：spike 报告（DSL 候选 A 优先评估、JS 沙箱候选 B 为上界；安全清单五项逐项证明；翻页取数实测回合数，≥80% 降幅为 spike 目标）；CDP 共存性验证，不行退化为受限脚本 DSL。
- **硬边界**：spike 不向生产暴露任何脚本执行工具；高风控站点硬拦不放宽；阶段一 live-target 网的 type_at/type_smart 视觉通道残余在 spike 报告中给出正式方案。
- **验收**：报告评审通过；无生产代码合入（如需实验代码，走独立分支不进主线）。

---

## 收口

### EP2-G2 verify 链与文档同步
- **改动文件**：`package.json` 新增 `verify:evolution-p2`（本计划全部焦点测试 + 内部串 `verify:native`）；CLAUDE.md/AGENTS.md §2/§8 同步（裁决唯一通道、账本写方向、staged 注入禁令升级为注入面断言）；08 表回填（**P 系列全部核销**：P1/P2/P3/P4 裁决层、P5、P8、P9）；阶段门核对（verify:stability 新断言全绿）。
- **验证**：`npm run verify:evolution-p2 && npm run verify:stability && npm run verify:native && npm run typecheck && npm run test`
- **规模**：~80 行。

---

## 阶段验收（对应 08 表回填）

| 设计验收断言 | 工单 |
|---|---|
| 任何 run 终结：四终态之一 + CheckIn 存在；零 proof 判 done = 0 | Q1-Q4/Q6 |
| 后台终态 → 可见回执或待裁决队列；事件 payload 成 proof | Q3/Q5 |
| learningRefs 路径不存在 → CheckIn 被拒（先写文件后记账） | Q4 |
| staged 卡不出现于任何注入文本（注入面行为断言） | K3 |
| 手改文件同步幂等；坏卡不注入不删除；回滚开关无损 | K6（依子合同） |
| 升降档由使用信号驱动；先降档后删除；近重复不直删 | C1/C6 |
| 索引增强字段正确且 X1a 零回归；触顶前 ≥1 轮转向 + checkpoint CheckIn | X1b/X2 |
| "不要采集"双层均拦；解除信号生效；否定拦截先于确认闸门 | I2 |
| M3 预批准仅消费可证明授权事实；第三方内容永不解锁 | I-auth |
| 同 run 双账本口径一致；坏行跳过 + metric；kill -9 孤儿 100% 关闭 | T1/T2/T3 |
| 401 零重试 / 429 退避 ≤2；未迁移域不变 | T4-3 |
| blocked 任务 → 卡 → 一键续跑；卡 ≤8 张可关闭 | E1/E2 |
| spike 报告含安全清单五项证明与实测回合数 | B1 |
