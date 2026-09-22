---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Hermes-Inspired Browser-Agent Architecture Design

**Date:** 2026-04-08

## Goal

为 Ready 的第一阶段 agent 升级先定清“浏览器与 agent 应该如何结合”的目标结构。

这份规格只解决一个问题：

**我们如何吸收 Hermes 在浏览器能力上的长处，同时保留并放大 Ready 内置浏览器、任务卡片、会话隔离和前台交互这些产品内优势。**

这一步不直接给出施工任务，不直接进入代码实现，也不试图一次性重写现有 browser-agent 主链。目标是先把结构、边界、抽象和验收口径定清楚。

## Scope

本规格只覆盖以下内容：

- Hermes 浏览器能力的真实结构与关键思路
- Ready 当前浏览器主链、agent 主控与 BrowserView 宿主之间的真实关系
- 两边可以对齐的抽象层
- Ready 下一版浏览器-agent 目标结构
- 后续进入交叉比对与改进计划前需要锁定的设计边界

本规格不覆盖以下内容：

- 跨会话搜索与回看
- 记忆可插拔
- 自动自学改 skill / 自动写长期记忆
- 详细的文件级实施计划
- 本轮代码实现

## Study Inputs

### Ready 当前主链

- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/tools/browser-agent-runner.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/browser-engine/ipc-handler.ts`
- `src/main/modules/agent-control/session-continuity.ts`
- `src/renderer/modules/browser/useBrowserRuntimeEffects.ts`
- `DOCUMENTATION.md`
- `LESSONS_LEARNED.md`
- `AGENTS.md`

### Hermes 参考对象

- `tools/browser_tool.py`
- `tools/browser_providers/base.py`
- `tools/browser_providers/browserbase.py`
- `tools/browser_providers/browser_use.py`
- 官方 browser / agent-loop / architecture 文档

## Current Structure In Ready

### 1. Ready 不是“外接浏览器工具”，而是“内置浏览器产品 + agent 决策”

Ready 当前浏览器链路本质上由三层组成：

1. **浏览器宿主层**
   - `BrowserController` 管理真实 `BrowserView`、tab、automation、capability、任务续跑、窗口与 popup。
   - 它不是普通浏览器工具包装，而是整个工作台里的内置浏览器控制面。

2. **agent 决策层**
   - `direct-chat.ts` 在模型调用前先判断本轮是不是浏览器任务。
   - 当前会把任务分成：
     - `free_tool_loop`
     - `browser_workflow`
     - `browser_upload_workflow`
     - `clarify_first`

3. **执行与投影层**
   - 对明确的上传/生成类任务，优先走 `BrowserAgentRunner` 的确定性阶段执行。
   - 对更宽泛的网页任务，则仍然把结构化计划灌回模型，让模型用浏览器工具循环推进。
   - 阶段、等待态、最近产物、记忆沉淀会进一步投影到 `scope run summary` 和聊天任务卡。

### 2. Ready 现有浏览器主链已经有明显的“宿主主导”特点

当前链路不是简单的“模型 -> 工具 -> 网页”，而是：

`用户输入 -> direct-chat 识别浏览器任务 -> 生成计划与连续性上下文 -> 选择确定性执行器或工具循环 -> BrowserController 驱动真实 BrowserView -> scope run 摘要投影到 UI`

这条链路已经具备几项很重要的产品内能力：

- 会话附件先进入资源层，再由浏览器任务显式消费
- 当前页、最近动作、最近工作流、最近技能运行都会进入连续性上下文
- 上传、写 prompt、提交、结果复核都有显式阶段
- 阶段状态会进入聊天任务卡，而不只是日志
- BrowserView 的显示与隐藏要遵守工作台宿主规则，不能像外部自动化浏览器那样随意处理

### 3. Ready 当前的主要问题不在“有没有浏览器能力”，而在“浏览器智能分散”

浏览器能力本身并不弱，问题是相关智能分散在多个地方：

- `direct-chat.ts` 里有大量任务识别、计划构造、连续性注入逻辑
- `browser-agent-runner.ts` 里有上传/输入/发送/复核的强验证逻辑
- `browser-tools.ts` 里还有一套模型可见工具面的行为定义
- `BrowserController` 里握着真实页面宿主与自动化能力
- `session-continuity.ts` 里又维护了一部分最近动作和工作流状态

结果就是：

- 计划、执行、证据、连续性、UI 投影虽然都存在，但没有一个统一的浏览器运行时合同
- 一部分逻辑是结构化对象，一部分逻辑是字符串协议
- 同一种页面状态在 planner、runner、tool loop 中会被重复理解
- 当前的确定性执行器主要照顾上传/生成类任务，探索类和混合类任务仍然更依赖模型自己兜

## Hermes Browser Architecture

### 1. Hermes 的核心思路不是“浏览器做得花”，而是“浏览器对 agent 来说非常稳定”

Hermes 的浏览器体系最重要的特点，是它把不同浏览器后端统一成了一套稳定的 agent-facing 能力面。

无论后面接的是：

- Browser Use
- Browserbase
- Firecrawl
- Camofox
- 本地 Chromium
- 用户自己的 CDP

对 agent 来说都还是同一套浏览器工具：

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_press`
- `browser_vision`
- `browser_console`

也就是说，Hermes 先把“浏览器作为 agent 身体”的接口定稳，再去决定底层接谁。

### 2. Hermes 的浏览器状态模型很轻，但很统一

Hermes 的浏览器任务主要依赖三类状态：

1. **task_id 级会话隔离**
   - 一个任务对应一条浏览器 session。
   - session 自动清理，有超时和 emergency cleanup。

2. **文本化页面世界模型**
   - 优先用 accessibility tree snapshot。
   - 页面交互元素通过 ref ID 暴露给模型。
   - 导航后自动补一份 compact snapshot，减少模型多走一步。

3. **可替换的底层 provider**
   - provider 只负责建 session、给 CDP 地址、关 session。
   - agent 不需要知道 Browserbase 和 Browser Use 的细节差异。

Hermes 这套设计非常适合通用 agent，因为它把复杂性尽量藏在统一接口后面。

### 3. Hermes 的浏览器哲学是“统一工具面 + 明确生命周期”

Hermes 在浏览器这块最值得借的几个点：

- **统一后端抽象**
  浏览器提供者怎么换，不影响 agent 理解方式。

- **会话天然按任务隔离**
  浏览器状态天然挂在任务上，而不是散在全局。

- **导航后立即给反馈**
  `browser_navigate` 自带简化 snapshot，很适合 agent 连续推进。

- **文本快照优先**
  先让模型看到结构化文本页面，再在必要时用视觉补强。

- **安全与清理是底座能力**
  URL 安全、私网保护、session cleanup 都不是业务层临时补丁。

## Where Hermes Stops Being Enough For Ready

Hermes 的浏览器结构很强，但它天然服务的是“通用外部代理”，不是“深嵌在应用里的浏览器产品”。

对于 Ready，Hermes 不能直接替代的地方主要有四个：

### 1. Hermes 不处理 BrowserView 宿主现实

Ready 的浏览器不是外部 headless browser，也不是云浏览器。
它是工作台里的真实原生层，受这些条件约束：

- BrowserView 不受 DOM `z-index` 控制
- 切模式时要显式 hide / show
- bounds 要和工作台布局精确同步
- 浏览器内容与左右面板、顶部 chrome、任务卡片共存

Hermes 没有这类宿主内现实，因此它的方法能给我们“agent 如何看浏览器”的启发，但给不了“浏览器如何作为产品身体存在”的现成答案。

### 2. Hermes 的浏览器任务没有 Ready 这么强的前台任务投影要求

Ready 需要让用户在聊天里清楚看到：

- 当前处于哪个阶段
- 为什么卡住
- 是否需要继续、确认、补充或人工接管
- 最近产物是什么

Hermes 更偏“工具执行 + 最终结果”，而 Ready 已经在往“宿主管理的任务状态机”走。

### 3. Hermes 的浏览器工具更统一，但也更低耦合

Hermes 的长处是统一。
Ready 的机会则在于更高耦合：

- 当前页就是产品里的活页面
- 当前附件就是会话里真实资源
- 当前任务状态就是聊天面板里的可见状态

这意味着 Ready 不能只是模仿 Hermes 的工具面，而要把它升级成**产品内统一浏览器运行时**。

### 4. Hermes 的浏览器能力没有 Ready 现在这么强的分阶段验收

Ready 的 Browser Agent V7 已经明确定义了：

- `resolve_target_page`
- `resolve_attachment`
- `navigate_target`
- `ensure_upload`
- `ensure_prompt`
- `submit`
- `final_reconcile`

并且已经把“附件挂载证据、prompt 进入证据、运行态证据”作为完成条件。

这说明 Ready 不应该回退成 Hermes 那种更通用、更轻的执行方式，而应该继续把这套“证据优先”的结构做成更统一的底座。

## Key Synthesis

### 结论 1：Hermes 给我们的不是“浏览器执行器”，而是“稳定浏览器抽象层”的方法

Hermes 真正值得借的不是某个具体命令，而是这条思路：

**先把浏览器对 agent 来说的状态、能力和生命周期抽象稳定，再让不同执行路径复用同一套抽象。**

### 结论 2：Ready 现在最缺的不是能力，而是统一合同

Ready 当前已经同时拥有：

- 内置浏览器宿主
- 确定性执行器
- 浏览器工具面
- 连续性上下文
- UI 任务投影

但这些还没有收敛成一套统一的合同，导致：

- `planner` 和 `executor` 理解的页面状态不完全一致
- `tool loop` 和 `deterministic runner` 共用的是同一个浏览器，但不共用同一个页面模型
- 浏览器证据更多是执行器内部逻辑，还不是浏览器运行时对外暴露的正式产物

### 结论 3：Ready 的目标不是“更像 Hermes”，而是“比 Hermes 更产品内一体化”

所以第一阶段正确的方向不是：

- 把 Ready 浏览器改成外接 provider 风格
- 用 Hermes 的浏览器工具直接替代现有主链

而是：

- 学 Hermes 把浏览器能力抽象稳定
- 保留 Ready 的 BrowserView 宿主和证据驱动执行
- 把 planner、tool loop、runner、UI 投影都接到同一个浏览器运行时上

## Chosen Architecture

### 总体原则

Ready 下一版浏览器-agent 结构应该采用：

**宿主统一、页面模型统一、证据统一、执行路径可分叉**

也就是：

- 底下只有一套浏览器运行时真相
- 上面可以同时服务确定性阶段执行和模型工具循环
- UI 任务投影不再从零散日志推断，而是消费浏览器运行时的正式状态

### Target Layer 1: Browser Runtime Adapter

这是第一层，也是最重要的一层。

它负责把真实 `BrowserController` 和各种 browser services 收成统一接口，向上暴露的是：

- 当前活动页
- 页签上下文
- 导航能力
- DOM / 视觉 / 截图 / 动作目标探测能力
- 输入与提交能力
- 附件挂载能力
- 后台任务能力
- 恢复页面能力

它不负责高层任务决策，不负责聊天 UI，不直接负责 prompt 组装。

它的职责是：

**让“浏览器是什么、现在页面状态如何、我能做什么动作”有统一出口。**

### Target Layer 2: Browser Page State Model

需要把当前分散在 runner、tools、direct-chat 里的页面判断统一成正式页面状态模型。

至少包括：

- 页面身份
  - 当前 URL
  - title
  - domain
  - active element
- 页面动作候选
  - upload targets
  - input targets
  - send targets
  - active input anchor
- 页面证据
  - upload evidence
  - prompt evidence
  - running evidence
  - target-page match evidence
- 页面风险
  - modal visible
  - mode-selection ambiguity
  - target unresolved
  - stale page / off-target page

一旦这层成形，planner、tool loop、deterministic runner 就不该各自重新定义“页面状态”。

### Target Layer 3: Browser Evidence Service

Ready 当前最值钱的能力是“证据优先”，所以这层必须正式独立。

它负责统一回答这些问题：

- 页面是否已经在目标页
- 附件是否已经真正挂载
- prompt 是否已经真正进入正确输入区
- 页面是否已经进入运行态
- 当前页面是否只是一个模式选择页
- 当前页面是否值得复用

这层要被：

- planner 使用
- deterministic runner 使用
- tool loop 的高层浏览器工具使用
- UI 任务摘要使用

也就是说，证据判断不能再只藏在 `BrowserAgentRunner` 内部。

### Target Layer 4: Browser Task Planner

这一层从 `direct-chat.ts` 中拆出，负责：

- 识别浏览器意图
- 结合会话附件、当前页、最近动作、最近工作流形成计划
- 产出结构化 `BrowserTaskPlan`
- 判断该走哪条执行路径

它要输出的不是自由文本，而是更稳定的结构化产物：

- 任务类型
- 目标页
- 附件选择
- prompt 意图
- 连续性上下文
- 建议执行路径
- 必须满足的证据条件

### Target Layer 5: Dual Execution Paths

规划之后，要允许两条执行路径共存，但共用同一个运行时和证据层。

#### 路径 A：Deterministic Workflow

用于：

- 上传 / 生成 / 编辑类任务
- 目标页明确
- 页面阶段可验证
- 对完成条件要求严格

这条路继续沿用 Browser Agent V7 的阶段式逻辑，但不再自己单独维持一套页面世界模型。

#### 路径 B：Guided Tool Loop

用于：

- 探索型网页任务
- 页面结构未知
- 需要搜索、阅读、提取、切换多个页面
- 明显不适合先锁成固定阶段图

这条路不是放任模型直接碰底层控制器，而是让模型通过更高层的浏览器工具面工作，这些工具同样建立在统一运行时和证据服务之上。

### Target Layer 6: Browser Continuity Store

当前 `session-continuity.ts` 已经有最近动作和最近工作流，但还偏轻。

下一版要明确把浏览器连续性当成正式能力，而不是临时缓存：

- 最近高成本动作
- 最近目标页
- 最近上传状态
- 最近 prompt 状态
- 最近运行态
- prompt anchor
- 最近失败原因

这层的目标不是直接变长期记忆，而是给本会话与邻近轮次服务。

### Target Layer 7: Browser Task Projection

浏览器阶段与证据要被直接投影到聊天任务卡。

投影来源应该是正式浏览器执行状态，而不是字符串解析为主。

目标是让用户清楚看到：

- 任务标题
- 当前步骤
- 当前阻塞点
- 最近证据
- 可继续动作
- 是否建议人工接管

## Execution Rules

### Rule 1: Browser Runtime Is The Single Source Of Truth

BrowserView 当前状态、页面动作候选、上传证据、prompt 证据、运行态证据，都应该有统一来源。

不允许 planner、executor、UI 各自凭经验再推一遍。

### Rule 2: Deterministic And Model-Driven Paths Must Share The Same Page Model

确定性执行器和模型工具循环可以并存，但不能各自维护不同浏览器世界观。

### Rule 3: BrowserView Host Rules Stay In The Host Layer

是否 hideAll、showActive、如何同步 bounds，这些仍然是宿主规则，不进入模型可见层。

### Rule 4: Attachment Safety Boundary Stays Unchanged

附件继续先进入会话资源层。
后续浏览器任务必须显式选择并消费资源，不允许回退成“看到图片就自动去网页操作”。

### Rule 5: Evidence Gates Completion

任何浏览器任务完成，都必须满足正式证据，而不是仅靠动作成功回包。

## What We Borrow From Hermes

- 把浏览器能力对 agent 来说的接口稳定下来
- 浏览器 session / runtime 按任务隔离
- 导航后立即补状态反馈
- accessibility-first 的页面理解方式
- browser backend 抽象与 provider 解耦思路
- 安全检查与 cleanup 作为底座能力

## What We Keep And Strengthen In Ready

- BrowserView 内置宿主
- Browser Agent V7 阶段式执行
- 会话 scope 和附件资源边界
- 连续性上下文注入
- 聊天任务卡上的阶段、等待态和最近产物
- 页面级证据优先

## Non-Goals For Phase 1

- 不替换现有 BrowserView 体系
- 不引入外部云浏览器作为主路径
- 不直接照搬 Hermes 的工具命名与执行方式
- 不一次性重写 `direct-chat.ts`
- 不在这一轮解决所有浏览器任务类型

## Risks

### 风险 1：为了统一抽象，反而削弱现有可用链路

处理方式：

- 第一阶段先补统一运行时合同，不重写现有所有执行路径
- Browser Agent V7 先迁移到新合同，不先推翻

### 风险 2：把宿主规则暴露给模型，导致产品层混乱

处理方式：

- BrowserView 显示/隐藏/bounds 同步继续封在宿主层
- 模型只看到浏览器运行时抽象，不看到原生宿主细节

### 风险 3：探索型与确定型任务继续各走各路

处理方式：

- 两条执行路径可以不同，但必须共用同一页面模型与证据服务

### 风险 4：连续性状态继续只是“临时优化”，无法成为正式能力

处理方式：

- 把最近动作、最近工作流、prompt anchor、失败原因统一收进 Browser Continuity Store

## Acceptance Criteria For This Architecture

当后续真正进入改造时，第一阶段至少要满足以下判断标准：

1. 浏览器 planner、deterministic runner、tool loop 三者共用统一页面状态模型。
2. 上传证据、prompt 证据、运行态证据由统一服务产出，而不是执行器私有逻辑。
3. `direct-chat` 不再承担大段浏览器计划与连续性拼装细节。
4. BrowserView 的宿主规则继续由浏览器宿主层管理，不泄漏到模型层。
5. 浏览器任务卡直接消费正式执行状态，而不是主要依赖字符串解析。
6. 附件资源边界、scope 隔离和任务阶段可恢复能力不退化。

## Open Questions

这些问题留到下一步交叉比对时决定：

1. 统一页面状态模型应该挂在 `browser-engine`，还是挂在 `agent-control` 的浏览器子域里。
2. 当前 `browser-tools.ts` 里的工具面是保留并抬高抽象，还是拆成“高层工具 + 低层调试工具”两层。
3. `session-continuity.ts` 是继续做轻缓存，还是要变成可持久的 scope 级浏览器连续性存储。
4. Browser Agent V7 的计划对象是否要成为正式共享协议，还是继续由 planner 与 runner 内部共享。

## Next Step

下一步不直接写实施计划，而是基于这份规格做一次更明确的交叉比对：

- 哪些部分 Hermes 已经证明更优
- 哪些部分 Ready 已经走得更深
- 哪些边界应该保留
- 哪些边界必须重构

完成那一步之后，再列第一阶段改进计划。
