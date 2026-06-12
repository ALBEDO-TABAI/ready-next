---
status: approved v3 — Codex 追加意见 2P1/1P2 回修后待终核（v2 已 APPROVED；v3 补 index 落点决策 / retired owner 注入决策 / specialist id 字符规则），逐单施工待终核放行（建议首单 K-mirror，A 轨 A5 起步）
revision_history:
  - v3 (2026-06-13): 吸收 Codex 追加意见 2P1/1P2。P1①K-mirror index 落点定死——root index.md 只收 global 作用域卡（crystallize 维护回合的 writeIndexFile 唯一写入口与 01 §7b DEFAULT_FILES 合同不变）；agent 卡只参与本作用域 backlink 解析与衰减信号，不产 per-agent index 文件（无读者=幽灵产物，禁止）；红测钉死"agent 卡不泄入 root index.md"。P1②A7 "自然失活"改为显式机制——A2 owner 注入解析在 prompt-assembly 处增加 registry status 查验（复用既有 getAgentRoster dep）：非 active 的 owner 降级 global-only（与"显式非法 id"同一降级语义），老任务聊天历史不受影响、后续轮不再吃 retired 知识；红测钉死。P2 specialist id 字符规则——A6 派生 id 强制小写 slug（^[a-z0-9][a-z0-9._-]*$，与卡片文件名字符集一致，否则 routing-<id>.md 撞 NORMAL_CARD 小写正则永不被 listRoutingCards 读到）；isSafeAgentScopeId 保持宽容兼容存量，新派生收紧。
  - v2 (2026-06-13): 吸收 Codex 一轮评审 6P1/3P2/3 开放问题。P1：①K-mirror 同步必须带作用域（agent 卡 scope_id='agent:<id>'，不得落 'global'）；②backlink/index 构建改 scope-aware（同 slug 跨 agent 不互相计）；③候选卡晋升字段改 stage→emerged（status 联合无 emerged，C5 已立 stage 封闭联合）；④B6 对 active 卡零自动改写——学习产物一律 staged 旁卡/建议卡；⑤A5 routing 卡 triggers 约定完整定义（封闭关键词列表 frontmatter 字段+确定性匹配+冲突兜底+写侧校验）；⑥B6 前置论证补全（只消费失败事实不读 enforce 行为，信源接口点名）。P2：四 gate 点名+迁移连续 gate 进 A6a 验证；共享文件矩阵补 knowledge-index-builder/settings/preload/UI/prompt 资产；计划改"058 被占须先修订合同"。开放问题：B6 信源=resolveCollectionVerdict 产物+CheckInRecord.blockers+工具信封 errorKind 闭集；triggers=关键词列表非正则非向量；A7 非 active agent 卡片自然失活+镜像行保留，无需清扫。
  - v1 (2026-06-13): 初稿。范围=00 路线图阶段四【进化】（A5-A7 / B6 / E-剩余卡类）+ 阶段三收口时用户提出的镜像覆盖缺口（K-mirror）。阶段三主轨 13 单已全部收口（整轮审查零 P1，verify:evolution-p3 绿）。
owner: 白
author: Claude (Fable 5)
executor: 待定（Claude / Codex 逐单施工）
reviewer: Codex（共识）+ Claude（终审）
enforce: true
note: >
  阶段三（2026-06-12-agent-evolution-phase3-implementation.md approved v3）已交付
  "组织与维护智能"全部主轨单（A1-A4 / C3-C5 / PK1-PK4 / I4 / G3，整轮审查零 P1，
  回归入口 verify:evolution-p3）。本阶段交付"进化"：确认制预路由（A5）、派生流程与
  生命周期（A6-A7）、站点卡学习回路（B6）、意图流剩余卡类内核（E5）、agent 作用域
  卡片的镜像/衰减/维护覆盖（K-mirror）。里程碑（00 §4）：完整飞轮——重复模式 →
  候选 → 用户确认 → 专项 agent → 越用越准。
  工单纪律沿用：先红测试 → 实现 → 焦点验证 → typecheck，单单 ≤约 300 行 diff、
  单独 commit、不顺手重构。
pairs_with:
  - docs/agent-evolution/00-路线图与目标架构总览.md（阶段四范围）
  - docs/agent-evolution/08-缺陷解决映射与验收追踪.md（验收脊柱，工单合入后回填）
related:
  - docs/superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md（approved v3 基线；遗留轨与阶段三阻塞单定义以其为准）
  - docs/agent-evolution/04/10/11/03/01（本阶段工单的设计出处）
---

# Agent Evolution 阶段四实施子计划

## 0. 总则

1. **轨道与串行约束**
   - **遗留轨 R（独立前置轨，定义不变）**：阶段二 Q4b 链（Q4b → Q5 → {T3, X2} → E2 → Q6 → G2）与 R-B1 spike，工单定义一律以阶段二合同 approved v7 为准；解锁门槛（`export-adjudicator-divergence --since 253b6768`：≥50 终态 run 且 typed===total、≥3 自然日、≥4 类 task_type、false_reject=0）不变。**阶段三阻塞单（E3/E4 依赖 R-E2；B4/B5 依赖 R-B1）随遗留轨解锁后按阶段三合同执行，本合同不复制不改写。**
   - 轨道 A（04 篇档位二/三）：**A5 → A6a → A6b → A7 严格串行**。A5 是档位二（会话创建预路由），A6 是档位三（派生），A7 是生命周期收尾。
   - 轨道 K（01 篇真值源延伸）：**K-mirror 独立无前置**，建议首单（A6 派生出的专项卡需要镜像/衰减覆盖，先把地基补平）。
   - 轨道 B（11 篇）：**B6 前置 = 02 Q4a（shadow，已合入）+ 03 C3（已合入）**——B6 不依赖 B1/B4/B5，走现有采集通道的失败信号，可与 A 轨并行。
   - 轨道 E（10 篇）：**E5（prepare/harvest/forming 三类卡内核 extractor）前置 = E1（已合入）**；forming/prepare 的消费面是 v1 文件树四桶（已存在），**harvest 卡的意图流投影接线依赖 R-E2，E5 只交付内核与文件视图消费 + 投影接口**。
   - **共享文件矩阵**：`migrations.ts`（A6a——末尾追加 058，名称隔离范式；**若开工时 058 已被遗留轨占用，必须先修订本合同再开工**）；`belief-card-store.ts`、`belief-card-mirror.ts`、`knowledge-index-builder.ts`（K-mirror 先行，B6 后碰 store）；`agent-registry-repository.ts`（A6a → A7 串行）；`emergence-cards.ts`（E5；遗留轨 E3 若同期解锁需协调周序）；`runtime.ts`/`run-coordinator.ts` 与 settings-engine/preload/renderer 类型（A5 接线，单内 additive）；`assets/prompts/derivation/seed-rules.md`（A6a 新建独占）；PersonalityEditor 系（A7 独占）。`agent-sdk-runtime.ts` 主轨零触碰（用户在途改动落地后另议）。
2. **每单交付物**：失败测试 → 实现 → 焦点验证命令绿 → `npm run typecheck` 绿；涉及迁移的（A6a）加 `npm run verify:native`；触碰既有合同面的单加对应 `verify:evolution-p1/p2/p3`。
3. **每单提交**：单独 commit，message 引用工单号（如 `feat(agent): EP4-A5 session preroute + agent_auto_routing setting`）。
4. **禁止事项**
   - **无确认自动派生永不存在**（00 不做清单）：`agent_auto_routing=auto` 只影响**会话路由**（先例命中直建会话且头部可一键改回）；派生新 agent、退休、合并、知识迁移、风险等级变更一律用户显式确认，且不可一键批量。
   - 种子 RULES 生成是**单次有界 LLM 调用**，容器钉死 `runSubAgent`（C3 范式），产物用户可改后才落盘；禁止占位 KR/流程文本（最小化创建纪律）。
   - 知识迁移清单必须逐项用户确认；迁移是文件级移动且**可逆**（卡片可随时移回，路径仍受 `isAllowedCardPath` 封闭联合约束）。
   - B6 学习回路只产 staged 卡/staged 旁卡（带日期证据）；**对既有卡（含 active）零自动改写**；任何站点风险等级变更须用户确认；高风控站点硬拦不因学习回路放宽（也不自动收紧——方向变更一律确认）。
   - 维护/学习写卡一律走 `BeliefCardStore.writeCard` 校验且强制 staged；staged 卡不进任何注入面（既有禁令延伸到新写入者）。
   - 意图流新增卡类继承 ≤8 张全局上限 + 单类 ≤3 + confidence 门槛 + 可关闭 + 反馈降权（漂移幅度 ±50% 有界，E4 落地前权重恒定）。
   - 终态只经 `finalizeRunOutcome()`；账本单向上行；packet/最小传话/确认闸门等阶段一至三合同红线全部继承（funnel gate 全程绿）。
   - agents 表行变更只有两个入口：A6b 确认派生（INSERT specialist 行）与 A7 确认退役/合并（UPDATE status）；其余路径禁止建行改行（A4 采纳只写任务 ownerAgentId，不动 agents 表）。

---

## 遗留轨 R 与阶段三阻塞单（此处只列归属，不复制定义）

| 单 | 解锁条件 | 定义出处 |
|---|---|---|
| R-Q4b → Q5 → {T3, X2} → E2 → Q6 → G2 | §0.1 四条门槛 | 阶段二合同 approved v7 |
| R-B1 | 真实浏览器实测窗口 | 阶段二合同 approved v7 |
| E3 / E4 | R-E2 合入 | 阶段三合同 approved v3 |
| B4 / B5 | R-B1 评审通过（B5 另需 I4+PK3，均已合入） | 阶段三合同 approved v3 |

---

## 轨道 K：agent 作用域卡片全链覆盖（设计出处：01 篇真值源 + 阶段三收口缺口）

### EP4-K-mirror agent 作用域卡进入镜像/衰减/维护信源
- **缺口（HEAD 取证）**：`belief-card-mirror.ts` 的 `syncBeliefCards` 与 C3 的 `collectBeliefDecaySignals` 都走 `store.listAllCardFiles()`，其默认 `dir='knowledge'` 只扫全局目录——`agents/<id>/knowledge/**` 的卡片能写、能注入（A2 owner 通道），但**不进 DB 镜像、不参与衰减、维护回合看不见**。A6 派生出专项 agent 后，其知识卡会在这三个面上隐形腐烂。
- **改动文件**：`belief-card-store.ts`（新增 `listAllCardFilesAllScopes(): Array<{ relPath, card, scopeId }>`——全局 `knowledge/` 产 `scopeId: 'global'`，枚举 `agents/<id>/knowledge/` 产 `scopeId: 'agent:<id>'`；agent 目录枚举须经 `isSafeAgentScopeId` 过滤，复用既有 walk）、`belief-card-mirror.ts`（`syncBeliefCards` 改走全作用域枚举并**把作用域写穿 upsert 的 `scopeId` 参数**——HEAD 取证：`upsertBeliefCardMirror` 的 `scope_id` 默认 `'global'`（:87），不传则 agent 卡会被镜像成 global，违反 04 §2 的 `scope_id='agent:{agentId}'` 口径）、`knowledge-index-builder.ts` 与 `collectBeliefDecaySignals`（**backlink/index 构建改 scope-aware**——HEAD 取证：`slugOf` 取 basename 且 `bySlug` 是全局 map，两个 agent 同名 slug 会跨作用域串联；改为按 scopeId 分桶解析，`[[slug]]` 只在本作用域内成边，全局卡仍在 global 桶内互链）、新增 `src/__tests__/agent-scope-card-coverage.test.ts`
- **index 落点决策（定死）**：**root `index.md` 只收 global 作用域卡**——crystallize 维护回合的 `writeIndexFile` 唯一写入口（`crystallize-gate.ts` :87，01 §7b DEFAULT_FILES 合同）与其落点保持不变；agent 作用域卡**只参与本作用域的 backlink 解析与衰减信号**，**不产 per-agent index 文件**（当前没有任何读者——写得出读不到的幽灵产物被本仓库纪律禁止；未来若 per-agent 知识索引注入需要 index 文件，另立单）。喂给 index-builder 的输入按 scopeId 分桶后，**只有 global 桶进 root index.md 渲染**。
- **实施要点**：存量零感知——无 `agents/` 目录时行为 = 现状（global 桶单桶 = 现行为）；镜像/衰减对 agent 卡的处理规则与全局卡一致（无特殊路径），差异只有 scope_id 与 backlink 命名空间；**读 API 的 staged 排除与注入面规则不变**（本单只扩扫描，不动注入）。
- **测试（先红）**：agent 作用域卡出现在 mirror 同步结果且 `scope_id='agent:<id>'`、`file_path` 携作用域前缀（global 卡仍 `'global'`）；**两个 agent 各有同名 slug 卡时互不计 backlink**（红测钉死）；**agent 卡不泄入 root index.md（红测钉死）**；衰减信号含 agent 卡且 backlink 按作用域计；无 agents 目录回退现状；staged agent 卡仍被注入面排除（回归断言）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-scope-card-coverage.test.ts src/__tests__/belief-card-mirror.test.ts src/__tests__/knowledge-index-builder.test.ts src/__tests__/maintenance-llm-round.test.ts && npm run typecheck`
- **规模**：~200 行。

---

## 轨道 A：确认制预路由与派生体系（设计出处：04 篇档位二/三）

### EP4-A5 会话创建预路由 + agent_auto_routing 设置项
- **routing 卡 triggers 约定（本合同新立，04 档位二的"routing 卡命中"在此机器化）**：belief-card frontmatter 增可选 `triggers` 字段（additive，沿 C5 `stage` 字段先例）——**逗号分隔的字面关键词列表**（≤8 个、每个 1-32 字符、禁正则/禁通配/非向量），写侧由 store `validateFrontmatter` 校验（坏格式拒卡）。匹配规则（确定性）：对新会话首条消息做大小写折叠后的**字面包含**判定；目标 agent = 卡文件名 `routing-<agentId>.md` 绑定且 registry 中 status=active（retired/不存在 → 该卡不参与）；**多卡命中按命中关键词数取最高，并列 = 冲突 → 兜底主 agent 且建议条列出冲突卡**；无 `triggers` 字段（含 C5 存量修复卡）或 staged 卡不参与匹配。
- **改动文件**：`belief-card-store.ts`（frontmatter `triggers` 字段：解析/校验/序列化，additive）、新增 `agent-control/agents/session-preroute.ts`（纯函数路由器，三级判定：**状态优先**——新会话首条消息经 I1 `intent-state-first` 分类为 continue_task/status_query 且存在最近 active/blocked/check_in_pending 任务携 ownerAgentId → 续用该 agent；**先例次之**——按上述 triggers 约定命中 ACTIVE routing 卡 → 目标 agent；**兜底**——主 agent，走 A4 档位一提案）、设置项 `agent_auto_routing: off | suggest | auto`（默认 suggest；对齐 `agent-auto-narration-setting.ts` 的跨进程设置范式：settings repository + IPC + Settings UI 可见）、会话创建链接线（runtime/scope 创建路径读设置：off=零行为变化；suggest=路由结果作为会话头部建议条数据下发，用户点击才切换；auto=先例命中直建到目标 agent 且头部显示"已按惯例转给 X，点此改回"）、新增 `src/__tests__/session-preroute.test.ts`
- **实施要点**：路由器是查表+分类，不是模型调用；**continue 类永远回原 agent**（C4.1 协同硬断言）；off 档下整条链路零触碰（存量零感知）；suggest/auto 的 UI 面走 §7 最小闭环（IPC/preload/类型/组件——建议条为轻量横幅，复用既有会话头部区域）。
- **测试（先红）**：三级判定矩阵（状态命中/先例命中/兜底）；continue 类回原 agent；off 档零变化；auto 档先例直建+改回数据完整；triggers 边界全覆盖——malformed 格式拒卡、多卡并列命中兜底+冲突列出、retired 目标不参与、无 triggers 不参与、staged 不参与、超长/超数关键词拒卡。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/session-preroute.test.ts && npm run typecheck`
- **规模**：~290 行。

### EP4-A6a AgentFactory 派生数据层（迁移 058 + 种子 RULES + 迁移清单）
- **改动文件**：`migrations.ts`（**058**：`agents` 表 ALTER ADD `parent_agent_id` TEXT + `derivation_reason` TEXT——04 §2 schema 补全，名称隔离幂等）、`agent-registry-repository.ts`（create 携双新列；mapRow 回读；NULL 兼容）、新增 `agent-control/agents/agent-factory.ts`（`deriveSpecialistAgent(input)` 六步流程的**数据层**：①agents 表插 specialist 行——**派生 id 强制小写 slug：`^[a-z0-9][a-z0-9._-]*$`**（比 `isSafeAgentScopeId` 更严：与卡片文件名字符集一致，否则 `routing-<id>.md` 含大写会撞 NORMAL_CARD 小写正则、永远不被 `listRoutingCards()` 读到；`isSafeAgentScopeId` 保持宽容兼容存量 id，新派生在 factory 入口收紧并对外拒绝大写）、derivation_reason 指向候选卡 slug→ ②建 `agents/<id>/knowledge/` 骨架 → ③种子 RULES：提示词资产 `assets/prompts/derivation/seed-rules.md`（X3，信源=候选卡证据+相关 CheckIn 摘要，**摘要不全文**），单次有界 LLM 调用经钉死 `runSubAgent` 容器（C3 四决策范式：取消=abortSignal/审计=metric 单行/错误=breadcrumb），产物先返回给确认 UI（用户可改），**确认前不落盘** → ④知识迁移清单**构建**（从主 agent 作用域按候选卡域筛选相关卡，列 relPath+title 清单，**只列不动**）→ ⑤routing 卡内容构建（含 `triggers:` 行——条件/目标/主 agent 保留什么/转办要带什么）→ ⑥候选卡 **`stage` → `emerged`**（C5 封闭联合 hint|candidate|emerged|routed|retired；**`status` 字段保持 staged/active 生命周期不动**——status 联合里不存在 emerged，写错字段=测试红）的写封装（经 store 校验））、新增 `src/__tests__/agent-factory.test.ts`
- **实施要点**：本单**不含任何 UI 与采纳判定**——所有写动作由 A6b 的用户确认回调触发；factory 各步幂等（重复派生同 id 拒绝）；迁移清单与卡片移动是文件级 rename（可逆，目标路径过 `isAllowedCardPath`）；最小化创建（只种证据支持的内容，禁占位文本）。
- **测试（先红）**：迁移 058 幂等按名隔离 + registry 双列往返；factory 六步在 fake 确认回调下逐步可断言；种子 RULES 经 fake LLM 单次调用且摘要信源；迁移清单只列不动；重复 id 拒绝；**大写/非法 slug 的派生 id 在 factory 入口被拒（红测：routing 文件名可读性约束）**；stage→emerged 经 store 校验且 **status 字段不被写成 candidate/emerged（守卫断言）**。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-factory.test.ts src/__tests__/migration-agents-table.test.ts && node scripts/check-migration-numbering-sequential.cjs && npm run verify:native && npm run typecheck`
- **规模**：~300 行。

### EP4-A6b 派生确认 UI + 采纳闭环
- **改动文件**：派生确认面（候选卡（C5 投影，stage=candidate 且证据 ≥3）→ 确认对话：命名可改 + 种子 RULES 预览可改 + 知识迁移清单逐项勾选——**复用 ask_user_questions 卡机变体范式优先**；若多步表单超出卡机表达力，立独立确认对话组件并走 §7 最小闭环：IPC/preload/类型/组件）、采纳回调接线（确认 → A6a factory 执行全部写动作 → routing 卡落盘（staged，**用户在同一确认流里勾选"立即生效"才置 active**；triggers 字段按 A5 约定生成并过写侧校验）→ 候选卡 `stage` → emerged）、拒绝路径（驳回 → 候选卡保持 candidate + 反馈记录，观察句措辞）、新增 `src/__tests__/agent-derivation-flow.test.ts`
- **实施要点**：**端到端验收**：候选卡 → 确认 → agents 表新行 + 骨架目录 + RULES 落盘 + routing 卡生效 → A5 先例路由命中新 agent（04 WP 表 A6 验收原文）；确认不可一键批量；新 agent 默认 status=active 且立即可被 A4 handoff/A5 路由发现。
- **测试（先红）**：端到端派生链（fake LLM + 真 store + 真 registry on 临时根）；拒绝路径无任何写动作；迁移清单未勾选项不移动；routing 卡默认 staged；A5 先例命中新写入的 active routing 卡。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-derivation-flow.test.ts src/__tests__/session-preroute.test.ts && npm run typecheck`
- **规模**：~300 行。

### EP4-A7 退休/合并流程 + agent 列表管理 UI
- **改动文件**：`agent-registry-repository.ts`（`updateStatus(id, 'retired'|'merged', { mergedIntoAgentId? })`——生命周期状态机：active→retired/merged 单向，主 agent 行禁退；merged 须携合法目标）、生命周期执行器（C5 修剪建议卡 → 用户确认 → status 变更 + 资产目录**保留**；merged 时知识卡可选择性并入目标 agent（复用 A6a 迁移清单机制，逐项确认）；建议卡核销（staged 修剪卡 → rejected/处理标记））、agent 列表管理 UI（扩展 PersonalityEditor：agents 实体与 persona 编辑**同屏不同区**——列表行：name/charter/status/派生来源/最近流量；操作仅限"确认退休/确认合并"，§7 最小闭环）、retired/merged agent 的运行时排除（A3 charter 注入、A5 路由、A4 handoff 目标校验已各自过滤非 active——补回归断言）、新增 `src/__tests__/agent-lifecycle.test.ts`
- **retired/merged owner 注入决策（定死，"自然失活"不成立——HEAD 取证：prompt-assembly 的 injectionOwner 解析（:992 附近）只看 ownerAgentId/scope.agent 不查 agents 表状态，老任务带 retired owner 仍会吃到 retired 知识）**：选择**注入失效**口径——A2 owner 解析处增加 registry status 查验（复用 A3 既有 `getAgentRoster` dep，零新依赖）：owner 解析到的 id 在 roster 中不存在或非 active → **降级 global-only**（与"显式非法 id"同一降级语义与同一代码路径）。老任务的聊天历史与已落账消息不受影响；后续轮不再注入 retired agent 的 RULES/knowledge。merged 的可选并入走迁移清单逐项确认（并入后以目标 agent 作用域生效）。
- **实施要点**：Retirement 不是创建的前置；资产目录永不删除（文件真值源纪律）；所有变更经确认、可观测（metric 单行）；K-mirror 镜像行保留（scope_id 仍可审计）。
- **改动文件补充**：`prompt-assembly.ts`（injectionOwner 解析处 status 查验——单内 additive，复用 getAgentRoster）。
- **测试（先红）**：状态机矩阵（合法/非法迁移、主 agent 禁退、merged 目标校验）；确认前零写动作；retired agent 从路由/handoff/charter 注入消失（三面回归断言）；**带 retired owner 的老任务后续轮注入降级 global-only（红测钉死，第四面）**；合并迁移逐项确认；资产目录保留。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-lifecycle.test.ts src/__tests__/agent-routing-injection.test.ts src/__tests__/agent-handoff-proposal.test.ts && npm run typecheck`
- **规模**：~300 行。

---

## 轨道 B：站点卡学习回路（设计出处：11 篇 B6）

### EP4-B6 失败 → 站点卡学习回路
- **前置**：02 Q4a（shadow CheckIn，已合入）+ 03 C3（维护回合，已合入）。**不依赖 B1/B4/B5**——信源是现有采集通道的结构化失败。
- **前置论证（Q4a 够用，不依赖 Q4b enforce）**：B6 只消费**失败事实**，不读取/不影响裁决的 enforce 行为——信源三个接口点名：①`browser-engine/collection-verdict.ts` 的 `resolveCollectionVerdict()` 产物（failed/partial 判决+诊断）；②Q4a shadow `CheckInRecord.blockers`（任务投影 checkins 列，只读）；③工具信封结构化 `errorKind` 闭集中的浏览器失败类（登录墙、脚本检测、selector 失效等）。三者在 HEAD 均已存在且与 Q4b 转正无关。
- **改动文件**：新增 `agent-control/knowledge/site-card-learning.ts`（确定性 extractor：按域名把上述失败信号映射为站点卡操作——**新站点无卡 → 写 staged 新卡（带日期证据+failure kind）；已有卡（无论 active/staged）→ 零自动改写**：产出 staged **旁卡**（`source: possible-update-of:<原卡 relPath>`，正文=带日期证据行），用户确认后由既有 staged 晋升/合并流程并入原卡——active 卡一个字节不被学习路径碰到；风险等级变更同样走 staged 建议卡（`possible-risk-update-of` 标记），确认后才动 store 风险对齐）、维护回合接线（C3 信号采集器增加站点失败信源，**只读**——写卡仍走本单 extractor 的确定性路径）、新增 `src/__tests__/site-card-learning.test.ts`
- **实施要点**：failure kind 是代码闭集（未知 kind 计 rejected 不写卡）；同域同日同 kind 去重（含旁卡内去重）；高风控站点硬拦清单**只读**——学习回路对其零写权；11 篇验收原文"注入一次登录墙失败 → 站点卡产生/更新"中的"更新"= staged 旁卡产生，并入须确认。
- **测试（先红）**：登录墙失败 → 新 staged 站点卡（证据带日期）；已有 active 卡 → **原卡逐字节不变 + staged 旁卡产生**；风险变更只产建议卡；未知 failure kind 拒绝；同日去重；硬拦清单零写。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/site-card-learning.test.ts src/__tests__/site-card-alignment.test.ts && npm run typecheck`
- **规模**：~260 行。

---

## 轨道 E：意图流剩余卡类内核（设计出处：10 篇）

### EP4-E5 prepare / harvest / forming 三类卡内核 extractor
- **前置**：E1（涌现内核，已合入）。**消费面**：forming/prepare → v1 文件树四桶（既有视图，升级为消费内核卡）；harvest → 投影接口就绪、意图流接线随 R-E2。
- **改动文件**：`emergence-cards.ts` 增三个确定性 extractor（**prepare**：日历未来事件+关联项目 → "接下来有什么要来"；**harvest**：completed 任务 proof 产物近 N 天未打开 → "做完的东西在哪"；**forming**：v1 文件涌现聚类 → "手头在长出什么项目"——三者各带 evidence 链+confidence+行动出口，无出口不投影）、隐私边界落地（10 §2.5：卡面只展示产物名称/类型+跳转，不内联内容；secret-storage/凭证路径/受保护目录显示"产物已生成（受保护路径）"；第三方证据标注来源域名）、文件树四桶消费 forming/prepare 内核卡（既有 view model 数据源切换，UI 形态不变）、新增 `src/__tests__/emergence-remaining-cards.test.ts`
- **实施要点**：与既有 resume/follow-up/crystallize 同走 `assembleEmergenceFeed` 四重控制（≤8/单类 ≤3/confidence/出口必备）；去重优先级照 10 §2.5（文件对象优先文件树，携行动出口才进意图流——该判定在 feed 装配处，E5 内核不重复实现）；harvest 的"未打开"信号复用 file_activity_events 既有模式只读。
- **测试（先红）**：三类卡 fixture 信号正确产出且 evidence 完整（10 篇 E1 验收口径延伸）；受保护路径不出卡面；无出口卡不投影；文件树消费 forming/prepare 卡且 UI 数据形状不变；feed 四重控制对新卡类生效。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/emergence-remaining-cards.test.ts src/__tests__/emergence-card-extractors.test.ts src/__tests__/emergence-candidate-maintenance.test.ts && npm run typecheck`
- **规模**：~280 行。

---

## 收口

### EP4-G4 verify 链与文档同步
- **改动文件**：`package.json` 新增 `verify:evolution-p4`（本阶段全部焦点测试 + 四 gate 点名：`check-run-finalize-funnel.cjs`、`check-checkin-funnel.cjs`、`check-ledger-write-direction.cjs`、`check-authorization-fact-writes.cjs` + `check-migration-numbering-sequential.cjs` + `verify:native`）；CLAUDE.md/AGENTS.md §2/§8 同步（预路由三级判定与设置档、triggers 约定、派生确认纪律、生命周期入口收敛、站点卡学习零自动改写纪律、剩余卡类隐私边界）；08 表回填。
- **最终验证门（可执行）**：`npm run verify:evolution-p4 && npm run verify:evolution-p3 && npm run verify:evolution-p2 && npm run verify:evolution-p1 && npm run verify:stability && npm run typecheck`；全量 test 沿用"基线失败清单不新增"口径。
- **规模**：~80 行。

## 阶段验收（08 表回填）

| 设计验收断言 | 工单 |
|---|---|
| agent 作用域卡进入镜像/衰减/维护信源；无 agents 目录回退现状 | K-mirror |
| continue 类回原 agent；routing 卡命中走先例；off 档零行为变化 | A5 |
| 候选卡 → 确认 → 新 agent 可用且路由卡生效；无确认自动派生 = 0；迁移清单可逆 | A6a/A6b |
| 生命周期 active→retired/merged 仅经用户确认；资产目录保留；路由/handoff/charter/owner 注入四面排除非 active | A7 |
| 注入一次登录墙失败 → staged 站点卡/旁卡产生；active 卡零自动改写；风险等级无确认不变更 | B6 |
| 三类卡 fixture 信号正确产出 evidence 完整；受保护路径不出卡面 | E5 |
| 完整飞轮：重复模式 → 候选 → 用户确认 → 专项 agent → 越用越准 | A5+A6+C5（跨阶段） |
