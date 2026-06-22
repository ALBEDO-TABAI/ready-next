---
title: Agent 身份统一 + 生命周期补全 + 设置页合并
date: 2026-06-22
status: reviewed-by-codex; governing-decision-locked (§6① 内置实体); ready-for-build
enforce: true
owners:
  - workstream-A (Settings UI): Claude
  - workstream-B (data model + lifecycle + IPC): Codex
supersedes: none
related:
  - docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md
---

# Agent 身份统一 + 生命周期补全 + 设置页合并

> 本文是先合同后代码的实施合同(CLAUDE.md §0.5)。三个问题共用一条根因:系统里存在**两套并行的 "agent" 概念,从未合并**。本文给出统一架构、可机器验证的不变量,并把工作拆成两条**可并行**的工作流(A=设置页 UI / B=数据模型+生命周期+IPC),seam 明确,互不踩线。

---

## 1. 背景:三个问题,一条根因

用户反馈的三个问题:

1. **设置页 agent 内容分散在三个 Tab**(`agent` / `agent 人格` / `agent 系统`),职责重叠、不合理,需合并为一个 Tab,但内部要做好分区避免臃肿。
2. **聊天区能选的"agent"只是一个 soul 预设,不是完整的专项 agent**;人格列表里的 agent 和专项 agent 分开,用户困惑。需要把 soul 分配进专项 agent,让聊天选的是"完整专项 agent(含人格)"。
3. **专项 agent 只有退休没有删除**;退休后不能再用,和删除无区别却更占地方,过于复杂。

根因:系统里有**两张表、两套主键**,各管一半,从来没有打通。

| | 「人格 / soul」 | 「专项 agent」 |
|---|---|---|
| 表 | `agent_personalities` | `agents`(registry) |
| 主键 | `agent_name`(UNIQUE,按名字) | `id`(slug) |
| 字段 | displayName / personalityText(SOUL.md)/ tone | charter / status / parentAgentId / **`personaRef`(死字段)**/ mergedIntoAgentId |
| 注入 | 按 `scope.agent`(名字)注入 L0 人格段 | 按 `ownerAgentId` 注入 RULES.md + 知识索引 |
| 生命周期 | 无状态,可增删改 | active / retired / merged,**无删除、无复活** |

---

## 2. 当前事实(带证据)

### 2.1 两套主键、聊天区选的是"名字"

- 聊天选择器数据源:`useAgent.ts:1260-1280` `reloadAgents()` 从 `agentPersonality.list()` 取**人格**(字段 `agentName`),`ChatInput.tsx:285-329` 映射成 `{id: agent.name}`。
- 选中写入:`useAgent.ts:1282` `selectAgent(name) => currentAgent = name`;新会话 scope `agent: currentAgent`(`useAgent.ts:1635-1636`)。**所以 `scope.agent` 存的是名字。**
- 人格注入按名字:`prompt-assembly.ts:497-510` `loadSOUL(agentName)` → `agentPersonalityRepository.getPersonality(agentName)`(`agent-personality-repository.ts:40-51`,按 `agent_name` 查);调用点 `prompt-assembly.ts:609` `loadSOUL(scope.agent)`。
- 专项注入按 id:`prompt-assembly.ts:1048-1063` `injectionOwner` 优先 `ownerAgentId`,未传时回退 `scope.agent`;RULES `:1064-1075`、知识索引 `:1100-1107` 都按 `injectionOwner`。
- `ownerAgentId` 唯一写入点:`handoff-proposal.ts:157-162` `updateTaskOwner(taskId, target.id)`,值是 registry `id`(slug)。

### 2.2 `personaRef` 是死字段

- `agent-registry-repository.ts:28-38` 定义 `personaRef: string | null`;建表/seed 永远写 `null`(`migrations.ts:2240-2257`,迁移 055 只 seed `butler`)。
- 全代码无任何读/写 `persona_ref`。它本是"agent↔soul 关联"的预留桥,从未接上。

### 2.3 两张表不是 1:1

- 迁移 045 把 **4 个默认人格** seed 进 `agent_personalities`:`butler` / `copywriter` / `video-editor` / `analyst`(`migrations.ts` 045,`default-personas.ts:1-106`)。注意:这 4 个名字本身就是合法 slug。
- 迁移 055 只把 **`butler`** seed 进 `agents` registry。→ `copywriter` / `video-editor` / `analyst` **没有 registry 行**。
- 用户经 `PersonalityEditor` 建人格(`agentPersonality.create`)**不创建 registry 行**(`agent-personality-repository.ts:56-94` 只 INSERT 人格表)。
- 派生的专项 agent 有 registry 行(slug id)但**不一定有人格行**;它们目前也**进不了聊天选择器**(选择器只读人格表)。

### 2.3.1 本机真实数据:slug 上已存在正面冲突(2026-06-22 实测)

查 `~/Library/Application Support/ready/ready.db`:

```
agents:              butler|管家|active        copywriter|葵老板|retired|parent=butler
agent_personalities: butler|管家  copywriter|文案  video-editor|剪辑  analyst|分析
```

- `butler`:两表一致(管家/管家,active)。
- `copywriter`:**同 slug 冲突** —— registry 是用户派生、**已退休**的「葵老板」(parent=butler),人格表却是默认的「文案」。**显示名不同、状态不同、来源不同。**
- `video-editor` / `analyst`:只有人格,无 registry 行。

→ 这证明:**slug 当前未被保留**,派生 agent 可以抢占默认人格的 slug;两表在同 slug 上可以状态/名称发散。任何"回填即 1:1"在这条数据上都会损坏数据(让默认「文案」消失 = 回归,或偷偷复活并改名「葵老板」= 毁掉用户派生)。迁移必须先做**冲突扫描 + 解决策略**(见 §3.4),不能假定干净回填。

### 2.4 生命周期:无删除、无复活

- 状态:`agent-registry-repository.ts:26` `'active' | 'retired' | 'merged'`。
- `updateStatus`(`:158-192`)只允许 active→retired/merged:`:165` 主 agent 禁退、`:172` 只有 active 能转、`:180` merge 目标须 active。**无反向转换、无 delete 路径**(repo 完全没有 delete)。
- 退休保留资产目录(CLAUDE.md 红线);owner 解析对 retired/merged/不存在 owner 一律降级 global-only(`prompt-assembly.ts:1048-1063`)。→ **真删一个 agent 对注入链路是安全的**(残留 ownerAgentId 自动走 global-only)。
- IPC:`agent-registry-group.ts` 仅 `agent:registry:list` / `listKnowledge` / `updateStatus`;preload `index.ts:106-112`;renderer `AgentRegistryPanel.tsx:96-118`。

---

## 3. B 的历史遗留安全性论证(回答用户条件 #1)

> 用户条件:"选 B 的话要考虑好会不会造成历史遗留问题;如果确认在用户的各项使用场景中都不会触发问题,B 也可以。"

### 3.1 朴素 B(把 scope.agent 改成 registry id)会断 —— 不采用

子审查确认,直接"把选择器数据源换成 registry active、scope.agent 改填 id"会触发:

1. 非 butler 默认人格、所有用户自建人格**没有 registry 行** → 选择器里集体消失。
2. `loadSOUL` 按名字查,若 `scope.agent` 变成与 `agent_name` 不同的 id → 人格静默丢失。
3. 已持久化的旧会话 `scope.agent` 是名字(`database.ts:2246-2301`),新会话变 id → 命名空间分裂,旧会话注入解析错乱。

### 3.2 安全形态 B'(采用):统一到 slug 主键,**不动 scope.agent**

关键洞察:**默认人格的名字本身就是 slug**(butler/copywriter/video-editor/analyst),`scope.agent`/`ownerAgentId`/`agent_name`/registry `id` **在 slug 这个层面本就同构**,只是两张表没保证彼此存在。

因此统一方向不是"改 scope.agent 的取值",而是:

> **让 `agents` registry 采用 persona 已有的 slug 作为 id,把两张表补成严格 1:1,并强制此后任何新建走"同 slug 双建"。`scope.agent` 的取值与命名空间完全不变。**

落地形态:
- **回填(冲突感知,非简单 INSERT)**:按 §3.4 的 A/B/C/D 四类分别处理;**已停用状态优先、永不复活**;D 类冲突显式决议 + 账本。绝不假定干净 1:1。
- **接通 `personaRef`**:`persona_ref = id`(自引用),从此非死字段;`loadSOUL` 增加"经 registry.persona_ref 解析"兜底,但**主路径仍按名字**,旧行为不变。
- **选择器换源**:`reloadAgents()` 改读 registry active agents,但**放进 scope.agent 的值仍是该 agent 的 slug**(== persona agent_name)。派生专项 agent 因此天然进入选择器,且选中后 `loadSOUL(slug)` 命中(回填保证了人格行存在)。
- **双建不变量**:`PersonalityEditor` 建人格 / 派生确认建专项,都必须在同一事务里建另一半。

### 3.3 逐场景核对(为什么 B' 不触发历史遗留)

| 场景 | B' 下的结果 | 判定 |
|---|---|---|
| 旧会话(scope.agent=名字)重载 | 取值不变,名字==slug==registry id(归一后),`loadSOUL` 命中 | ✅ 安全 |
| 用户自建人格(两表无冲突) | 回填 + 双建保证有 registry 行 | ✅ 安全 |
| 派生专项 agent 进选择器并带人格 | 双建保证有人格行,选中 `loadSOUL(slug)` 命中 | ✅ 安全 |
| `ownerAgentId` 使用 | 已是 slug == registry id == persona key,三者一致 | ✅ 安全(且**修掉** `prompt-assembly.ts:1056` 把 scope.agent 当 owner 的潜伏 bug——归一后该回退对所有 agent 都正确,不再只是 butler 巧合正确) |
| 删除/停用一个 agent 后,其名下旧任务 | owner 解析已降级 global-only | ✅ 安全 |
| **同 slug 两表冲突(如 copywriter:葵老板 retired vs 文案)** | **朴素回填会损坏数据** | ⚠️ **必须先走 §3.4 冲突解决** |

**结论(修订):B'(slug 主键统一,不动 scope.agent)对**无冲突**的场景安全,且顺带修掉潜伏 owner bug。但 §2.3.1 证明存量库存在同 slug 两表冲突,**回填不是简单的 `INSERT OR IGNORE`,而是一次带冲突解决的合并迁移**(§3.4)。"安全"的前提是 §3.4 + §3.5(slug 保留规则)先落地。**采用 B',但把迁移升级为"统一实体合并",不是"两表勉强绑定"。**

### 3.4 迁移前冲突扫描与解决策略(codex 修改意见,采纳)

迁移分两步,**先扫描后写**,且**已有状态优先、永不偷偷复活**:

**Step 0 — 扫描分类**(只读,产出冲突清单,记账本可观测):
- `A 类 仅人格`(video-editor / analyst):无 registry 行。
- `B 类 仅 registry`:无人格行(派生但未建人格)。
- `C 类 两表一致`(butler):slug 相同、名义不冲突。
- `D 类 两表冲突`(copywriter):同 slug,但 **status / displayName / charter 任一发散**。

**Step 1 — 按类解决**:
- A 类:补 registry 行,**status 取人格的当前可选性**(人格在选择器中可见 ⇒ `active`)。
- B 类:补人格行(默认 soul 由 charter 生成,见 §4.5),**status 保留 registry 现状**(retired ⇒ 迁移后是"停用",不复活)。
- C 类:接通 `persona_ref`,无其它动作。
- D 类(核心,**已按决策① = 内置实体定稿**):保留 slug 归内置 agent,被挤占的派生 agent 让位:
  1. **内置 agent 夺回保留 slug**:`copywriter` 归内置「文案」(active)。
  2. **被挤占的派生 agent 让位但不丢、不复活**:「葵老板」**重新 slug 化**(如 `copywriter-x` 或基于显示名生成的合法 slug),保留其 `disabled`(原 retired,**永不复活**,INV-7)、`parent=butler`、资产目录与知识卡;同事务**更新它名下旧任务的 `ownerAgentId`** 指向新 slug(历史任务本就 global-only 降级,更新仅为引用一致)。
  3. 每条 D 类决议写账本(`agent_identity_migration` outcome),设置页"Agent 管理"提供一次性复核入口。

> 注:本机仅 `copywriter` 一条 D 类(§2.3.1);`video-editor`/`analyst` 是 A 类(仅人格,原地补 registry 行,见 §4.4 原地改造)。

**Step 2 — 校验**:INV-1/INV-7/INV-8(§5)在迁移后强制扫描零孤儿、零静默复活、零 slug 重复。

> 原则:**已停用/退休的 agent,迁移绝不偷偷恢复成可用**;两表冲突一律显式决议 + 账本,不靠"哪张表先写"碰运气(CLAUDE.md §0.5 红线 6)。

### 3.5 统一 slug 规则(codex 修改意见 #5,采纳)

当前人格名规则与专项 agent id(slug)规则不完全一致(§2.3.1 的冲突就是这个缺口的产物)。统一后:
- **唯一 slug 命名空间**:人格新建与派生新建共用同一套 slug 校验(小写 slug,沿用 `isSafeAgentScopeId`)。
- **保留 slug**:内置默认 agent 的 slug(及主 agent `butler`)进保留表,派生/新建**不得抢占**(否则结构化拒绝)。
- **唯一性**:`agents.id` 全局唯一(已是主键),迁移后 `agent_personalities.agent_name` 与之 1:1,新建走双建事务保证不产生第二命名空间。

---

## 4. 目标架构

### 4.1 统一身份(问题 2)

- **一个 agent = 一个实体**,主键 slug。它*拥有*一条人格(soul 是它的属性),并拥有 charter / RULES / 知识 / 路由 / 生命周期。
- `agents` 与 `agent_personalities` 严格 1:1(slug 对齐),`persona_ref` 接通。
- 选择器列出 registry active agents;选中 = 选中完整实体;soul 不再是独立可选的孤立预设。

### 4.2 生命周期补全(问题 3,codex #3/#4 采纳)

**产品用词不出现 "retired"。** 三个语义互斥的用户动作:

- **停用 / 启用(可逆)**:停用 = 不参与路由/注入、从聊天选择器隐藏,但**可再启用**;资产保留。这是 `retired` 的产品化替代。
- **合并(终态)**:并入另一个 agent,迁移知识卡(`agent-factory.ts:228-249`);表示"这个 agent 并入了别的 agent"。
- **删除(真删,新增)**:见下,需确认,**主 agent 禁删**。

**删除的完整级联(codex #4 —— 不能只删一行):**
- **删除**:registry 行 + 人格行 + 资产目录(`agents/<id>/`)+ **指向它的 routing 卡** + 派生记录中对它的引用。
- **保留为历史**:**旧会话、旧任务不删**;`ownerAgentId` 悬挂由既有 global-only 降级兜底。
- **界面呈现**:旧会话/任务上把该 agent 显示为"已删除的 Agent"(占位名,不再可选、不再注入)。这样用户有删除自由,历史记录不破坏。

> 状态模型:`active ↔ disabled`(可逆,用户称"启用/停用")、`active → merged`(终态)、`* → 删除`(物理移除实体 + 级联,保留历史展示)。`retired` 历史值在迁移中归一为 `disabled`(§6 决策点②)。

### 4.3 设置页信息架构(问题 1,codex 产品 #1:渐进披露)

一个「Agent」入口,内部 4 个子区(子导航,非平铺);**默认首屏直接进"Agent 管理"**,复杂的派生/维护/路由卡**不在第一屏全摊开**:

1. **Agent 管理(默认首屏)**:统一列表 → 点进单个 agent 看人格 / 知识 / 路由 / 启用状态 + 操作(停用/启用/合并/删除)。← 问题 2/3 的 UI 落点。
2. **行为**:全局开关(后台自动播报、新会话智能路由)+ 知识系统总开关。
3. **派生与路由**:派生候选确认、routing 卡、blueprint、preroute 轨迹。
4. **知识与维护**:staged 信念卡确认、站点卡风险、维护回合状态。

### 4.4 默认 agent 的归属(§6 决策点① 已拍板:**升级为内置完整 agent**)

用户决策:全部升级为内置完整 agent,始终出现在聊天选择器;并**重定义内置阵容**。落地映射(**原地改造,slug 不变 → 老会话 scope.agent 零断裂,守 INV-3**):

| 内置 agent | 显示名 | slug(不变) | 定位 | 迁移动作 |
|---|---|---|---|---|
| 主 agent | **Ready**(原"管家") | `butler`(MAIN_AGENT_ID,深度接线,**不可改**) | 主协调 | 仅改 displayName→"Ready",charter/soul 沿用 |
| 文案 | 文案 | `copywriter` | 文案创作 | 保留;**夺回 slug**(见 §3.4 D 类) |
| 美术 | **美术**(原"剪辑") | `video-editor`(原地复用) | 画面分析 / 美术建议 | 改 displayName→"美术" + 新 charter/soul;slug 不动,老 `video-editor` 会话仍解析 |
| 智识 | **智识**(原"分析") | `analyst`(原地复用) | 学习 / 知识积累 / 学术调研 | 改 displayName→"智识" + 新 charter/soul;slug 不动,老 `analyst` 会话仍解析 |

> 说明:slug 是内部身份/路径键,用户只看显示名;原地复用 `video-editor`/`analyst` 比新建 slug 更安全(无孤儿 slug、无需迁移老会话)。四个内置 slug(`butler`/`copywriter`/`video-editor`/`analyst`)进**保留表**,派生/新建不得抢占(§3.5)。

### 4.5 派生自动生成 soul(codex 产品 #5,采纳)

新建专项 agent **不要求用户手写 soul**:从创建时的定位 / 职责 / 蓝图(charter)自动生成一份默认人格文本,之后允许用户编辑。避免创建流程变重。生成是 LLM 判断题(草拟),落库前 staged,符合 CLAUDE.md "模型只做判断题"。

---

## 5. 可机器验证合同(先合同后代码)

实现前/后必须有以下不变量的测试 + gate(失败=红):

- **INV-1(1:1 身份)**:对每个 active `agents` 行存在 `agent_personalities` 行且 `agent_name == agents.id`,反之每条人格行存在同 slug registry 行。回填迁移后扫描零孤儿。
- **INV-2(personaRef 已接通)**:每条 registry 行 `persona_ref` 非空且解析到存在的人格;`loadSOUL` 对所有 active agent slug 命中。
- **INV-3(scope.agent 命名空间不变)**:不新增/不改写任何已持久化 `chat_conversations.agent` 值;行为测试断言旧会话(agent=名字)重载后人格仍命中。
- **INV-4(生命周期)**:
  - 删除级联移除 registry 行 + 人格行 + 资产目录 + 指向它的 routing 卡 + 派生引用;主 agent 删除被拒。
  - 停用↔启用可逆;merged 仍为终态、merge 目标须 active。
  - 所有写仍经确认(沿用 `agent-registry-repository.ts:165` 主 agent 禁改 + 确认流)。
- **INV-5(删除/停用后注入安全 + 历史保留)**:删除或停用一个 agent 后,其名下旧任务注入降级 global-only,不崩、不泄漏他人谱系;旧会话/任务**仍存在**且显示"已删除的 Agent"占位(不被物理删除)。
- **INV-6(双建)**:经 IPC 新建人格或确认派生后,另一半行在同事务内出现(无半建状态)。
- **INV-7(永不静默复活)**:迁移对 §3.4 D 类(及任何 status=retired/disabled 的 registry 行)**不得**把状态改成 active;测试用 §2.3.1 形态的种子(copywriter retired + 文案 persona)断言迁移后该实体仍非可用。
- **INV-8(slug 唯一 + 保留)**:迁移后无重复 slug;保留 slug(内置 agent + butler)不可被派生/新建抢占(结构化拒绝);人格新建与派生共用同一 slug 校验。
- **INV-9(迁移可观测)**:每条 D 类决议写 `agent_identity_migration` 账本;迁移幂等(重跑零变更)。

回归入口(实现时新增):`npm run verify:agent-identity`(INV-1..9 焦点测试 + 1:1/slug/no-resurrect gate + `verify:native`)。**必须接进现有验证链**(codex #6):挂到 `verify:evolution-p4` 之后或并入 `verify` 总入口,避免"写了但没人跑"。

---

## 6. 决策点状态

1. ✅ **【已拍板】默认 agent = 内置完整 agent**(§4.4):管家→"Ready",阵容重定义为 文案/美术/智识,原地复用 slug;四内置 slug 进保留表。
2. **`retired` 字面量去留**(待 codex 实现确认):迁移归一为 `disabled`(推荐),或保留 `retired` 字面量仅加可逆转换。
3. **删除的资产处理**(待确认):硬删资产目录(推荐),或移入 `agents/.trash/<id>/` 软回收。
4. ✅ **派生默认 soul**:自动从 charter 生成 staged 人格(§4.5)。
5. ✅ **D 类被挤占 agent 去向**:内置「文案」夺回 `copywriter`,派生「葵老板」重新 slug 化 + 保持 disabled(§3.4)。

---

## 7. 工作流解耦(A=Claude / B=Codex,可并行)

### 7.1 Seam(关键:零共享行)

现有四个叶子面板(`PersonalityEditor` / `AgentDerivationPanel` / `AgentRegistryPanel` / `AgentSystemStudio`)以及两个内联控件,**全部是 propless、自包含组件**(自己持有 IPC + state,子审查已确认无 props)。这给出一条 seam:

> **叶子组件 = propless、自包含、default export。** 容器只负责"摆放"叶子,不碰叶子内部;叶子内部逻辑 + 后端随便改,不碰容器。

**修正(codex 提醒,采纳):此 seam 不是"零交汇"。** `AgentSystemStudio` 现状不是能无痛拆开的纯叶子,且创建/删除 agent 后**多个面板的列表需同步**(管理列表、派生面板、聊天选择器)。因此约定一个**统一刷新机制**:
- 复用现有 `window` 事件 `ready:agent-registry-changed`(`AgentRegistryPanel.tsx:85` 已监听)作为**唯一刷新信源**;任何写操作(增删改人格/registry/生命周期)成功后由 B 侧广播此事件。
- 所有列表面板(含 `AgentSettingsHub` 容器、聊天选择器 `reloadAgents`)统一订阅该事件刷新。**A 负责容器订阅、B 负责写后广播 + 各叶子订阅。**
- `AgentSystemStudio` 的子区拆分若 B 暂不做,A 整块摆放(§7.4 规则),但刷新事件契约先于拆分落地。

### 7.2 Workstream A —— 设置页 UI(Claude 负责)

**范围(纯 renderer,仅 `Settings.tsx` + 新容器组件):**
- `Settings.tsx`:把 `agent` / `personalities` / `agent-system` 三个 `settingsData` 条目(`:115-182`)收敛为单个 `agent` 条目;改 `:3170-3180` 渲染分派为单一容器。
- 新建容器 `AgentSettingsHub`(renderer 组件):4 个子区 + 子导航(段控/左侧子 nav),负责合并后的布局与"避免臃肿"的视觉设计(以 workbench 极简优雅为基准)。
- 把两个内联控件(后台自动播报 `:120-126` / 新会话智能路由 `:128-138`)迁入"行为"子区,沿用现有 settings getter/setter IPC(只读现成契约,不依赖 B)。
- 把现有叶子组件按 §4.3 摆进对应子区。

**A 对契约的依赖(只读约定,不改后端):**
- A 按 §7.4 的**冻结组件清单**摆放叶子;叶子名字/数量若 B 要改(见下),以清单为准。
- A 写防御式(沿用现有 optional-chaining + fallback 习惯),新 IPC 未落地时不报错。

**A 完成判据**:三 Tab 合一、子导航可切换、所有现有面板在新布局内正常渲染与交互、无新增本地状态猜测、typecheck 绿。

### 7.3 Workstream B —— 数据模型 + 生命周期 + IPC(Codex 负责)

**范围:**
- **冲突迁移(§3.4 / §3.5)**:扫描分类 A/B/C/D → 按类解决(已停用优先、永不复活)、slug 保留 + 统一校验、D 类决议写账本、幂等。
- **数据模型(§3.2 / §4.1)**:`persona_ref` 接通、`loadSOUL` registry 兜底、`reloadAgents` 换源(值仍为 slug)、双建事务、派生自动生成 staged soul(§4.5)。
- **生命周期(§4.2)**:`disabled` 可逆 + `delete` **级联**(行+人格+资产+routing 卡+派生引用,旧会话/任务保留并显示"已删除的 Agent");repo `updateStatus` 扩展/新增 `deleteAgent`;IPC `agent:registry:delete` + 可逆 enable;preload + renderer 调用。
- **刷新广播(§7.1)**:所有写后广播 `ready:agent-registry-changed`;各叶子 + 选择器订阅。
- **叶子面板内部**:`AgentRegistryPanel` 增删除/启用按钮 + 可逆语义 + 历史占位;`PersonalityEditor` 折叠为"每个 agent 内编辑人格";如需**新建统一管理面板**(§7.4)。
- **合同/测试(§5)**:INV-1..9 + `verify:agent-identity`,接进现有验证链。

**B 完成判据**:INV-1..9 全绿、`verify:native` 通过、迁移在 §2.3.1 形态种子上不复活退休 agent、生命周期三动作语义互斥、选择器列出含派生在内的 active agents、写后各面板同步刷新。

### 7.4 冻结契约(A↔B 的接口,过 codex 时锁定)

**(a) 冻结组件清单(A 按此摆位,B 按此交付):**

| 子区 | 组件 | 谁交付 |
|---|---|---|
| 行为 | 内联控件(自动播报 / 预路由)+ 知识系统总开关 | A 摆位;开关若需新 IPC 由 B 补 |
| Agent 管理 | `AgentManagementPanel`(B 可由 `PersonalityEditor`+`AgentRegistryPanel` 合并而来;若不合并则两者并列) | B 交付内部;A 摆位 |
| 派生与路由 | `AgentDerivationPanel` + 路由/blueprint(取自 `AgentSystemStudio` 子区) | B 交付内部;A 摆位 |
| 知识与维护 | 信念卡确认 / 站点卡风险 / 维护状态(取自 `AgentSystemStudio` 子区) | B 交付内部;A 摆位 |

> 规则:B 若新增/重命名/合并叶子组件,**只需更新本清单的组件名**;只要保持"propless、自包含、default export",A 的容器无需改 import 之外的任何逻辑。`AgentSystemStudio` 的内部子区拆分由 B 决定;若 B 暂不拆,A 先整块摆进"派生与路由 + 知识与维护"两区的合并位,后续 B 再细拆。

**(b) 冻结 IPC 契约(B 实现,A/叶子按名调用):**
- 既有(不变):`agent:registry:list` / `listKnowledge` / `updateStatus` / `agentPersonality:*`。
- 新增(B 落地):`agent:registry:delete({id})`、`updateStatus` 支持 `status:'disabled'` 与 `active`(可逆)。
- A 侧对新增方法用 feature-detection 调用,落地前优雅降级。

### 7.5 集成点(唯一需要协调的时刻)

两个交汇约定(非"零交汇"):
1. **文件区**:`Settings.tsx` 的 import + 容器对叶子的引用。A 持有 `AgentSettingsHub` 与 `Settings.tsx` 容器/分派;B 持有叶子组件文件本身;B 改组件名 → A 改一行 import。
2. **刷新事件契约**(§7.1):事件名 `ready:agent-registry-changed` 冻结;A 在容器/选择器订阅,B 在所有写后广播。这是两侧必须共同遵守的运行时契约,先于其它实现落地。

---

## 8. 实施顺序

0. **过 codex 已完成一轮**(本文已并入其 6 条修改意见 + 实测冲突数据);**待用户拍板 §6 决策点①**(默认 agent = 内置/模板)后锁定 §7.4 契约。
1. 并行启动:
   - A:`Settings.tsx` 合并 + `AgentSettingsHub` + 子导航 + 渐进披露摆位(对现有 IPC)+ 订阅刷新事件。
   - B:**先**冲突扫描 + 解决策略(§3.4)+ slug 保留(§3.5)→ personaRef + 选择器换源 + 双建 + 派生自动 soul → 生命周期(disabled/delete 级联 + IPC + 历史占位)→ 写后广播 → 叶子内部 → INV-1..9 测试 + gate 接链。
2. 集成:A 接 B 的最终组件名 + 新 IPC(feature-detect 转正)。
3. 验收:`verify:agent-identity` + `verify:native` + 关键页回归(Settings/Agent/聊天选择器 + 派生 agent 可选中对话 + 删除后历史显示"已删除的 Agent")。

---

## 9. 风险与回归入口

- **风险:同 slug 两表冲突(已实测,§2.3.1)** → §3.4 冲突扫描 + 显式决议;INV-1/7/8 gate 在迁移后强制扫描零孤儿/零复活/零重复;迁移幂等(INV-9)。
- **风险:迁移偷偷复活已退休 agent** → INV-7 用实测形态种子断言。
- **风险:删除导致 ownerAgentId 悬挂 / 历史丢失** → INV-5 覆盖(global-only 降级 + 旧会话任务保留 + "已删除的 Agent"占位)。
- **风险:创建/删除后多面板列表不同步** → §7.1 统一刷新事件 `ready:agent-registry-changed`。
- **风险:slug 命名空间二次分裂** → §3.5 统一校验 + 保留 slug + INV-8。
- **风险:A/B 并行改到 `Settings.tsx` 同区** → §7.5 单一交汇区 + import-only 约定。
- **回归入口**:`npm run verify:agent-identity`(新增,接进现有链)、`npm run verify:native`、CLAUDE.md §10 提交前检查。
