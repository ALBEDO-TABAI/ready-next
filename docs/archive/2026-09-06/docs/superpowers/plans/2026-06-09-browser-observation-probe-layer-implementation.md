---
title: Browser Observation + Probe Layer 实施计划
date: 2026-06-09
status: revised-after-claude-feedback
owner: 白
executor: Codex
enforce: false
note: 本计划基于 web-access 源码复评、两轮 Claude 审查意见与 Ready 当前 Browser Agent 现状，目标是在不引入外部 proxy/Chrome 的前提下，把提示纪律、站点经验、页面结构观察、模型可组合只读探针、目标安全行动和动作后复查沉淀为 Ready 浏览器 agent 的正式合同。Recipe 改为后置的证据沉淀，不进入第一批关键路径。
related:
  - AGENTS.md §0（读完再写、失败要响亮）
  - AGENTS.md §0.5（先合同，后代码；修根因；拒绝 legacy 兼容分支）
  - AGENTS.md §2（BrowserView 原生覆盖层硬约束）
  - .claude/architectural-principles.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-counterplan.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-implementation.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-04-agent-self-serve-browser-collection-implementation.md
source_reviews:
  - /Users/user/.codex/attachments/9a21d914-7b77-482a-a2ff-3bcd6470844a/pasted-text.txt
  - /Users/user/.codex/attachments/ff6d5feb-9f48-47ab-984b-21d76e486727/pasted-text.txt
  - https://github.com/eze-is/web-access
evidence_current_ready:
  - src/main/modules/tools/browser-tools.ts:3575-3583（browser_read_page 仍主要读正文）
  - src/main/modules/browser-engine/agent-browser-page-map.ts（页面地图纯模块已存在）
  - src/main/modules/browser-engine/agent-browser-act.ts（目标行动 gate 已存在）
  - src/main/modules/tools/browser-tool-catalog.ts:17-43（页面地图/目标行动尚未注册进工具面）
  - src/main/modules/browser-engine/browser-tool-write-classification.ts:21-70（分类表已有未注册工具痕迹）
  - src/main/modules/browser-engine/page-state-service.ts:136-146（统一 capturePageState 仍有占位 probe）
  - src/main/modules/browser-engine/scoped-browser-facade.ts（固定 tab + 租约 + 子集 allowlist 基础）
  - src/main/modules/browser-engine/automation-service.ts:441-602（DOM.setFileInputFiles 已具备）
  - src/main/modules/agent-control/domain-adapters/browser-domain-orchestrator.ts:139-190（free-loop 进度仍部分依赖模型口头完成）
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Browser Observation + Probe Layer 实施计划

> 本文是和 Claude 第二轮反馈对齐后的修订计划。它不要求照搬 web-access，而是把 web-access 在浏览任务里真正有效的工作纪律转成 Ready 可验证、可集成、可逐步落地的浏览器 agent 合同。
>
> 施工前先读 §1-§5；任何实现先补可机器验证合同，再改代码。若后续 Claude 提出反证，以当前源码和行为测试为准修订本计划，而不是靠口头判断覆盖合同。

---

## 0. 一句话

Ready 不应该学习 web-access 的外部浏览器代理形态，而应该学习它更底层的浏览方法：**站点经验、页面结构观察、探针循环、动作后复查、失败恢复**。

目标是把 Ready 浏览器任务从现在偏“读正文 + 试工具”的模式，推进为：

1. 先识别站点和任务形态。
2. 再读取可操作页面结构，而不是只读 `body.innerText`。
3. 锁定唯一目标后再行动。
4. 每次行动后用页面证据复查。
5. 成功经验优先沉淀为站点经验；只有被多次证明确实稳定的模式，才后置沉淀为任务配方。
6. 失败时给出下一步合法修复路径，而不是继续随机尝试。

---

## 1. 前因后果

### 1.1 这次问题是怎么来的

用户观察到 web-access 操作浏览器的效果较好，尤其是测试过程中会为具体任务写一些脚本、调整 `.mjs` 文件，让页面操作和结果获取更稳定。这背后不只是“多了脚本能力”，而是浏览器 agent 的工作方式更像一个可迭代的现场调查流程：

1. 先用小探针看页面真实结构。
2. 根据页面反馈微调动作。
3. 失败时定位是入口错、页面未加载、目标不唯一、动态内容隐藏、还是跨 iframe / Shadow DOM。
4. 把验证过的站点规律保存下来，下次少走弯路。

Claude 的审查进一步指出：web-access 和 Ready 的产品形态不同。web-access 更像外部 CLI skill，通过独立 Chrome、HTTP proxy、环境变量、端口保护和脚本驱动来完成网页任务；Ready 是集成式 Electron 产品，已有 BrowserView、webContents、CDP、工具调度、任务卡、provider 策略、renderer/main 边界和用户可见浏览器状态。

所以这次计划的核心不是“把 web-access 搬进 Ready”，而是回答一个更窄的问题：

> web-access 哪些理念能提高 Ready 浏览器 agent 的成功率，并且能以 Ready 自己的架构合同落地？

### 1.2 当前 Ready 已经有的基础

Ready 不是从零开始。当前已经有几类重要基础：

1. BrowserView / webContents 控制链路已经存在，低层浏览器并不缺。
2. `ScopedBrowserFacade` 已经有固定 tab、租约、控制门和工具 allowlist 的雏形。
3. `agent-browser-page-map.ts` 已经有页面地图构建的纯模块。
4. `agent-browser-act.ts` 已经有“按目标行动”的 gate 思路，包括 generation、歧义、目标不存在等校验。
5. `browser-tool-write-classification.ts` 已经认识 `browser_read_page_map`、`browser_visual_step`、`browser_act_on_target` 这类工具名。
6. `automation-service.ts` 已经具备 `DOM.setFileInputFiles` 上传能力，不需要把“文件选择/上传”当成新缺口。
7. SDK prompt 里已有部分浏览任务纪律，例如高风控平台、当前页面状态、唯一目标和高控制限制。

这些基础说明：Ready 的主要缺口不是“没有能力操作浏览器”，而是 **6 月 4 日那批页面地图、目标行动和可见采集合同没有全部接到正式工具面**。WP2/WP3 的本质是“注册 + 接线 + 补合同测试”，不是从零重写浏览器。

这也降低了第一阶段风险：先把已有纯模块接入工具 catalog，再补动作后复查和页面证据，比直接新造大块 recipe runner 更稳。

### 1.3 当前真正的缺口

从现有证据看，缺口集中在六层：

1. **观察层不够强**  
   `browser_read_page` 仍偏正文读取，页面地图和目标结构没有成为 agent 默认观察入口。

2. **已有模块未接入工具面**  
   页面地图和目标行动的纯模块已存在，但工具 catalog 里还没有正式注册，导致模型仍容易回到弱工具。

3. **状态探针分散**  
   `BrowserPageStateService.capturePageState` 仍有占位 probe，真正有价值的 workflow probe 分散在工具实现和 runner 中，没有形成统一页面状态合同。

4. **进度过度相信模型口头完成**  
   free-loop 进度仍会解析模型文本里的“步骤 N 完成”，这不如基于页面证据、工具结果和任务输出推进。

5. **站点经验没有一等公民位置**  
   平台规律、可靠入口、常见陷阱、链接生成方式、隐藏内容规律等，没有持久化成可复用的 domain hints。

6. **模型缺少可组合的只读探针**  
   web-access 测试里“为任务写 mjs”的核心价值，不是固定脚本本身，而是面对陌生页面时可以小步探测、观察反馈、再微调。Ready 不应让 agent 随机改脚本文件，但也不能把所有适应性锁死进固定模板。第一阶段应提供受限但灵活的只读探针工具。

7. **Recipe 容易过早模板化**  
   如果一开始就把 `official-entry-resolution`、`visible-list-collect`、`upload-and-submit-proof` 写成固定 recipe，可能会回到 web-access 明确反对的“操作手册/模板脚本”路线。Recipe 应该后置：先让观察、行动、只读探针和站点经验跑通，再从真实成功任务里沉淀稳定模式。

---

## 2. 从 Claude 审查中吸收什么

### 2.1 吸收“站点经验”，但不让它变成硬编码真理

Claude 提到的 domain-based site experience memory 值得吸收。很多网页任务失败，不是因为点击能力弱，而是因为 agent 不知道站点习惯：

1. 哪些入口页可靠。
2. 哪些“内容不存在”提示不可信。
3. 哪些链接必须由站点生成才有效。
4. 哪些内容在 DOM 里已经加载，但在视觉上暂时隐藏。
5. 哪些平台把主要内容放在 iframe、Shadow DOM 或延迟渲染区域。

Ready 应该引入 `SiteExperienceStore`，但必须明确边界：

1. 它只能提供 hint，不能直接替代当前页面观察。
2. 每条经验必须带来源、时间、置信度、适用 domain/path、验证方式。
3. 过期或低置信度经验只能降低探索成本，不能让 agent 跳过复查。
4. 模型可以总结经验，但经验的匹配、过期、启用、降级必须由代码决定。

### 2.2 吸收“探针 -> 观察 -> 微调”的循环

用户特别提到 web-access 测试中经常写任务脚本、调整 `.mjs` 文件。这个逻辑值得引入，但不能原样照搬。

在 Ready 中，它应该先变成三种受控能力：

1. **模型可组合只读探针**  
   agent 可以提出“我要观察什么”，运行时把它约束为只读、无写入、无导航、无网络副作用、risk-gated 的页面探针。它不是裸 eval，也不是固定 recipe 模板，而是保留 web-access 现场适应力的最小产品化形态。

2. **失败恢复建议**  
   每次探针、观察或工具失败时，不只返回错误，还返回下一步可尝试的合法动作，例如重新读取页面地图、等待渲染、切换同源 iframe、标记跨域不可读、要求用户授权、改用视觉单步。

3. **后置任务配方 recipe**  
   只有当某类任务在真实任务中多次证明稳定，才把探针、动作、复查和输出结构沉淀成显式 recipe。Recipe 是事后结晶，不是第一阶段先验框架。

这不是让模型随意写 `.mjs`；而是让 Ready 先获得可审查、可测试、可限制风险的观察层，再谨慎决定哪些模式值得固化。

### 2.3 吸收具体技术事实

Claude 提到的几条技术事实应转成 Ready 合同：

1. **平台的“content not found”不一定可信**  
   判断内容不存在前，必须复查 URL、入口来源、站内跳转链和页面生成方式。

2. **站点生成链接比用户猜测链接可靠**  
   对需要官方入口、活动页、商品页、社交平台帖子页的任务，优先从页面真实链接、接口响应或站内导航中提取 URL。

3. **隐藏 DOM 也可能是已加载内容**  
   页面地图不能只看可见文本；需要在安全边界内读取可操作节点、隐藏容器、dialog、tab panel、collapsed section。

4. **iframe / Shadow DOM 不能作为“读不到”的终点**  
   页面观察必须标出 iframe、shadow root 和跨域限制。如果能读则读，不能读则给出结构化原因和下一步。

5. **子 agent 提示应以目标为中心，而不是工具为中心**  
   对高风控或复杂页面，子任务 prompt 应描述目标、约束、证据要求和退出条件，不应只说“用某工具点某按钮”。

6. **POST body / 结构化输入优先于 URL 兼容路径**  
   对迁移、提交、文件选择等任务，输入合同应优先用结构化 payload，不要靠把复杂状态塞进 URL 或字符串。

### 2.4 吸收“任务结果必须能复查”

web-access 有价值的不是“动作多”，而是动作后会继续确认页面是否真的进入目标状态。Ready 应把这点变成硬验收：

1. 点击后必须确认页面 generation、URL、目标节点状态或新内容。
2. 上传后必须确认 input files、预览、按钮状态或提交结果。
3. 抽取后必须记录来源 URL、页面标题、时间和采集范围。
4. 滚动采集后必须记录终止条件：到底、重复率过高、数量达到、用户停止或超时。
5. 失败后必须区分：未加载、目标不唯一、权限不足、跨域不可读、页面阻止自动化、工具未授权。

### 2.5 把提示纪律提到第一批交付

Claude 第二轮反馈指出：目标驱动话术和几条技术事实不依赖新工具，可以最先上线。这个判断正确。

第一批 prompt 改动应单独交付：

1. 不要把平台错误页直接判成内容不存在。
2. 优先找站内真实生成的链接，而不是猜 URL。
3. 页面无正文不等于没有内容，先检查动态渲染、隐藏 DOM、iframe、Shadow DOM。
4. 不要在同一条失败路径反复重试。
5. 子 agent / 子任务 prompt 描述目标、约束、证据要求和退出条件，避免只给“点击/输入/导航”这类动作指令。
6. 任何浏览任务结果都要带来源、时间、页面状态和复查证据。

这部分应作为 WP0.5，排在工具接线之前。

---

## 3. 不吸收什么

### 3.1 不引入 web-access 的外部 HTTP proxy 形态

Ready 已经有 Electron BrowserView 和主进程控制链路。外部 proxy 会新增端口、生命周期、权限、跨平台和安全面，反而绕开 Ready 现有的 renderer/main/tool dispatch 合同。

结论：不把 HTTP proxy 当成第一阶段方向。

### 3.2 不默认接管外部 Chrome

web-access 通过外部 Chrome 运行有它的 CLI 场景价值，但 Ready 的产品边界是集成式工作台。接管外部 Chrome 会带来：

1. 用户隐私和登录态边界不清。
2. Ready 任务卡和 BrowserView 状态不同步。
3. 用户浏览器与 agent 浏览器难以分离。
4. 指纹、权限、下载、文件上传和截图链路不可统一验证。

结论：Ready 第一阶段继续基于自己的 BrowserView / webContents。未来若做“使用系统浏览器”也应是单独能力，不混入本计划。

### 3.3 不开放任意 JS 给模型

“任意 JS = 主视角”的观察很重要，但不能直接等价为“模型可以任意执行 JS”。Ready 必须区分：

1. 低风险只读 probe。
2. 受控 DOM 行动。
3. 高风险写操作。
4. 需要用户授权或浏览器锁的操作。

结论：不开放裸 eval；但应新增一个模型可组合的只读探针工具。该工具只允许观察，不允许写 DOM、点击、输入、导航、提交、下载、发请求或修改存储，并受 allowlist、risk level、lease 和高风控策略约束。

### 3.4 不把 `.mjs` 动态修改当成产品能力

测试时改脚本很有效，但产品里不能让 agent 通过不断写临时 `.mjs` 维持成功率。那会带来不可复现、不可审计、难回滚和权限扩大。

结论：保留“为任务形成小探针”的思想，第一阶段落地为可组合只读探针和行为测试；recipe 只作为后置沉淀，不作为第一阶段默认执行框架。

### 3.5 不为旧弱路径保留长期兼容分支

根目录指引明确架构级改动拒绝 legacy 兼容分支。页面地图、目标行动和证据推进一旦成为合同，就不应同时维护“老的正文猜测路径”和“新的结构化路径”两套长期策略。

结论：可以分阶段迁移，但每阶段都要有明确退役对象和验收门槛。

### 3.6 不新增工具而不收口旧工具

当前 browser catalog 已经有 42 个 `browser_*` 工具。新增 `browser_read_page_map`、`browser_act_on_target`、`browser_probe_readonly` 时，如果不同时写明它们取代或收编哪些旧工具，就会形成 45 个工具和两套并行范式。

这会直接破坏本计划：

1. 模型仍会选择旧的点击、输入、坐标和正文读取工具。
2. `targetId + generation` 的安全合同会被绕开。
3. 页面地图和只读探针只会变成“又多几个工具”，而不是默认浏览纪律。

结论：WP0 必须交付工具面合并 / 退役地图。每个新工具都要写明替代对象、迁移门槛和退役方式。

---

## 4. 目标架构

### 4.1 Browser Observation Contract

新增或升级一个统一的浏览器观察合同，用于替代“只读正文”的默认判断。

观察合同必须分两层，不能默认一次吐出全量 DOM：

1. **summary 层**  
   默认返回页面身份、风险标记、关键目标摘要、目标数量、可疑空态原因、top target groups、下一步建议和必要 evidence。大页面只返回限量节点和分页游标。

2. **detail-on-request 层**  
   只有当 agent 指定 target group、frame、form、list、media group 或 detail cursor 时，才返回对应细节。细节仍必须限量、摘要化，并带 generation。

这条必须写进 schema，而不是只在 token 风险里提醒。否则大页面会把上下文打爆，模型也会回到“读一大坨页面再猜”的旧模式。

M1 只交付最小 page map，不把完整观察合同偷偷塞进“接线”：

| 字段 / 能力 | M1 归属 | 后续归属 |
| --- | --- | --- |
| `generation`、`text`、`targets[]`、`box` | WP2 必须交付，基本来自现有 `agent-browser-page-map.ts` | 持续优化 |
| ambiguity group | WP2 必须交付，用于拒绝盲点重复目标 | 持续优化 |
| 基础 `riskFlags` | WP2 只做最小集：file input、disabled、external link / navigation hint、可能登录态 | M2/M3 扩展 payment/destructive/user-data/automation-blocked |
| `evidence` | WP2 只记录 target 来源、generation 和当前 map 截断状态 | WP5 接入任务进度证据 |
| `nextAllowedActions` | WP2 只给 `read map again`、`act on target`、`wait`、`stop with reason` | WP4/WP7 后扩展 probe、frame、visual step |
| forms / dialogs / media / lists | M1 不承诺完整分类，只能从 `targets[]` 中派生最小摘要 | M2/M3 按真实任务补 detail-on-request |
| iframes / shadowRoots | M1 只允许标注存在或未知，不承诺穿透读取 | WP7 处理同源/跨域机制 |

建议输出字段：

1. `pageIdentity`
   - `url`
   - `title`
   - `domain`
   - `navigationSource`
   - `generation`
   - `capturedAt`

2. `text`
   - `visibleTextSummary`
   - `importantTextBlocks`
   - `emptyOrBlockedReason`

3. `pageMap`
   - `targets`
   - `forms`
   - `fileInputs`
   - `buttons`
   - `links`
   - `dialogs`
   - `tabs`
   - `media`
   - `lists`
   - `iframes`
   - `shadowRoots`

4. `targetHints`
   - stable `targetId`
   - role
   - label
   - selector or CDP reference where safe
   - frame context
   - bounding box where available
   - visibility and disabled state
   - ambiguity group

5. `riskFlags`
   - login required
   - payment / purchase / destructive action
   - external navigation
   - file upload
   - user data exposure
   - automation blocked
   - cross-origin unreadable frame

6. `evidence`
   - why a target is considered valid
   - source snippet or structural proof
   - freshness / generation match

7. `nextAllowedActions`
   - read map again
   - act on target
   - wait
   - scroll
   - visual step
   - ask user
   - stop with reason

这层的目标是让 agent 先“看清页面”，再决定如何行动。

### 4.2 Browser Action Contract

将 `browser_act_on_target` 作为标准行动入口，而不是让模型直接拼选择器、猜按钮或反复点击文本。

动作动词必须先和现有纯模块对齐。当前 `agent-browser-act.ts` 的枚举是 `click | expand | choose | fill | hover`。M1 不新增语义不清的动作名：

1. 计划里的 `type` 在 schema 中映射为 `fill`。
2. 计划里的 `select` 在 schema 中映射为 `choose`。
3. `set files` 和 `submit` 不进入 M1；文件上传继续由现有上传链路负责，submit 先通过 `click` 或后续明确 enum 扩展处理。
4. `expand` 和 `hover` 要保留在 schema / prompt 里，避免实现枚举和计划文档分叉。

行动前必须验证：

1. `tabId` / scope 属于当前任务。
2. `targetId` 存在。
3. `generation` 未过期。
4. 目标不在歧义组，或用户/模型已明确 disambiguation。
5. 风险级别允许本轮工具执行。
6. 操作不会越过当前 lease。

行动后必须返回：

1. `before`
2. `action`
3. `after`
4. `readBack`
5. `changed`
6. `failureKind`
7. `nextSuggestedAction`

这能把“点了没点上”“点错了”“页面变了但没读回来”变成可观测状态。

### 4.3 Site Experience Store

新增站点经验存储，用来保存经过验证的 domain 规律。

建议数据结构：

```ts
type BrowserSiteExperience = {
  id: string
  domain: string
  pathPattern?: string
  appliesToTaskKinds: string[]
  aliases: string[]
  reliableEntryPatterns: string[]
  generatedLinkPatterns: string[]
  knownTraps: Array<{
    kind: string
    description: string
    recovery: string
  }>
  selectorsOrTargetHints: Array<{
    purpose: string
    hint: string
    confidence: number
  }>
  frameHints: Array<{
    purpose: string
    framePattern: string
    readable: boolean
  }>
  riskLevel: 'low' | 'medium' | 'high'
  confidence: number
  source: 'manual' | 'successful-task' | 'test-fixture'
  lastVerifiedAt: string
  expiresAt?: string
}
```

存储位置建议：

1. 运行时经验放 app data / SQLite，跟随用户环境。
2. 测试 fixtures 放 repo，作为合同样本。
3. 不把随机临时脚本或未经验证的模型猜测写进持久经验。

存储决策：

1. 站点经验的主存储建议用 SQLite，而不是复用通用 memory 基础设施。
2. 理由是站点经验需要按 domain/path/task kind 做结构化查询、过期、置信度和风险过滤。
3. memory 可以作为导入、导出或摘要来源，但不作为运行时授权和风险判断的唯一事实源。
4. 代价是本 WP 必须进入 `verify:native` 验收门。

启用规则：

1. 先匹配 domain/path/task kind。
2. 再按 `expiresAt`、`confidence`、`riskLevel` 过滤。
3. 注入给模型时只作为 hint。
4. 工具执行仍以当前页面证据为准。
5. 站点经验的 `riskLevel` 只能抬高风险，不能降低风险。`isHighControlPlatformText` 这类硬名单是安全地板，学习到的经验不能把硬名单站点降级或绕开高风控工具限制。

### 4.4 Model-Composable Readonly Probe

新增一个模型可组合的只读探针层，用来吸收 web-access 中最有效的“现场写观察脚本”能力，同时避免裸 eval 的安全问题。

建议工具名：

1. `browser_probe_readonly`
2. 或 `browser_observe_dom`

建议输入：

```ts
type BrowserReadonlyProbeInput = {
  tabId?: string
  generation: number
  query: string
  scope?: 'document' | 'visible' | 'forms' | 'links' | 'media' | 'frames' | 'shadow-dom'
  maxNodes?: number
  includeHidden?: boolean
}
```

运行时必须强制：

1. 只读，不允许写 DOM。
2. 不允许点击、输入、提交、导航、下载。
3. 不允许 `fetch`、XHR、WebSocket、storage 写入、cookie 写入。
4. 不允许访问跨域 iframe 内容；跨域只能返回 frame 元数据和不可读原因。
5. 高风控平台默认禁用自由表达式，只允许固定只读 scope。
6. 输出必须有 node limit 和摘要，避免把整页 DOM 塞给模型。
7. 每次 probe 记录 `query`、`scope`、`generation`、`riskDecision` 和 failure kind。

这个工具比 recipe 更靠前，因为它解决的是陌生页面适应性。Recipe 如果过早落地，会把这种适应性重新模板化。

### 4.5 Evidence-Driven Progress

当前 free-loop 进度还部分依赖模型说“步骤 N 完成”。后续应改为证据推进：

1. 工具结果确认页面状态变化。
2. 页面地图、只读探针或 action readBack 满足当前步骤验证条件。
3. 浏览器证据服务记录了目标达成。
4. task card projection 消费真实状态，而不是 renderer 本地猜测。

模型仍可以解释下一步，但不能单靠口头声明推进任务状态。

开工前必须再次确认 live 路径。当前源码已显示 `direct-chat.ts` 初始化 `BrowserDomainOrchestrator`，`browser-domain-adapter.ts` 在 `applyResult` 中调用 `recordToolLoopProgress`，所以这条大概率是活代码；但只要后续 runtime 切换，WP5 必须先用日志或行为测试确认浏览器 free-loop 在出货构建里确实流经该路径。

### 4.6 Managed Browser Session

在当前 `ScopedBrowserFacade` 基础上，形成更明确的 Managed Browser Session：

1. 每个浏览任务绑定一个 browser scope。
2. scope 内固定 tab、generation、lease 和允许工具集。
3. 用户接管、页面跳转、lease 过期都显式改变状态。
4. 子任务只能访问自己的 scope，不能偷用用户当前页面。
5. 任务结束后清理 lease、临时下载、probe state 和悬挂监听。

这与 2026-06-04 的 Agent Browser / 用户 Browser 解耦方向一致。第一阶段可以先在当前 agent tab 上实现，后续再迁到真正独立 Agent Browser。

### 4.7 Recipe as Evidence-Grown Pattern

Recipe 不进入第一批关键路径。它只在满足以下条件后才允许进入实现：

1. 同一任务模式已通过真实任务或最小可复现页面多次验证。
2. 该模式中的 probe、action、readBack 和 evidence 已经可以由现有工具表达。
3. 失败分支清楚，且不会因为固定模板压制对陌生页面的探索。
4. recipe 能减少重复劳动，而不是替代页面观察。

候选场景仍可记录为后续观察对象，例如：

1. 官方入口和站内生成链接确认。
2. 长列表可见内容采集。
3. 上传并提交后的证据确认。

但这些在第一阶段应先作为狗粮任务和站点经验来源，不直接固化成 recipe runner。

### 4.8 Tool Surface Consolidation Map

新增工具必须同时带退役地图。目标不是把旧工具立即物理删除，而是分阶段完成：先从默认 prompt 和模型首选工具里降级，再把旧工具改成内部 fallback 或薄门面，最后在合同和狗粮证明后移除或保留为人工调试工具。

当前 catalog 有 42 个 browser 工具。第一阶段新增 3 个工具时，必须按下表收口：

| 新工具 / 新范式 | 收编或取代的旧工具 | 第一阶段处理 | 退役门槛 |
| --- | --- | --- | --- |
| `browser_act_on_target` | `browser_click`、`browser_click_text`、`browser_click_at`、`browser_type`、`browser_type_smart`、`browser_type_at`、`browser_compose_message`、`browser_send_keys` | 从默认 browser prompt 中降级为 fallback；普通点击/输入/提交必须先 page map，再 target action | target action 通过 stale、ambiguity、disabled、readBack、文件上传合同测试，并通过至少三类 M1 狗粮任务后，旧动作工具不得作为默认入口 |
| `browser_read_page_map` | `browser_read_page`、`browser_probe_workflow_state`、`browser_locate_action_targets`、`browser_locate_input_targets`、`browser_list_upload_targets` | `browser_read_page` 改为信息性正文读取，不再是浏览任务默认观察；locate/list/probe 类工具改为 page-map detail 或内部 probe 来源 | page-map 能覆盖目标、表单、文件 input、动作候选、输入候选、upload target、iframe / Shadow DOM 标注后，旧观察工具不得作为唯一证据 |
| `browser_probe_readonly` | `browser_execute_js` 的只读用法；`browser_extract_structured`、`browser_visible_collect`、`browser_scroll_collect`、`browser_collect_images` 中的只读观察片段 | 只收编“观察”部分；批量下载、后台采集、长任务继续保留原工具职责 | readonly probe 证明能安全回答陌生页面观察问题，且不能写 DOM / 导航 / 发请求 / 改 storage 后，`browser_execute_js` 的只读用途从默认 prompt 中退场 |

暂不收编：

1. `browser_capture_viewport` 和 `browser_analyze_viewport`：仍作为视觉兜底。
2. `browser_scroll_at`：在 target action 支持 scroll 前保留，但不能绕开 generation 校验做关键动作。
3. `browser_upload_scope_attachment`：仍负责会话附件资源上传；它和 `browser_act_on_target` 的文件 input 行动互补。
4. `browser_start_task` / `browser_get_task` / `browser_resume_task` / `browser_cancel_task`：仍负责后台任务生命周期，不被只读 probe 替代。

`browser_visual_step` 的处置：M1 不注册为正式工具，也不继续作为“幽灵工具”保留在分类表里。视觉兜底先使用已有 `browser_capture_viewport` / `browser_analyze_viewport`。若 M3 证明需要视觉单步，再把它作为 `browser_act_on_target` 的视觉 fallback 或独立工具重新进入 catalog、schema、classification 和测试。

WP0 必须把这张表落实成 catalog / prompt / schema 的迁移合同。否则新增工具会增加模型选择负担，而不是减少错误路径。

---

## 5. 分阶段实施计划

### M1 Gate：先证明，再扩展

M1 只包含最能证明本计划有效的骨架：

1. WP0 合同和测试矩阵。
2. WP0.5 提示纪律独立上线。
3. WP2 页面地图正式工具。
4. WP3 目标行动正式工具。
5. M1 狗粮验证。

M1 通过前，不启动 WP4 只读探针、WP1 站点经验、WP5 证据进度、WP8 会话收口或 WP6 recipe 候选沉淀。

M1 通过标准：

1. `browser_read_page_map` 和 `browser_act_on_target` 已注册到正式工具面。
2. 旧点击/输入/正文读取工具已从默认 prompt 中降级，不能绕开 target-id + generation 合同成为首选路径。
3. 本地 mock 页或低风险真实网页完成三类狗粮：页面理解、点击/输入行动、动作后 readBack。
4. 工具日志能串起 observation、target、action、generation 和 failure kind。
5. 至少一个失败场景能返回结构化错误，而不是让模型继续重复旧路径。

只有 M1 通过后，才进入 M2：只读探针、站点经验和更广泛狗粮。M3 再处理证据驱动进度、iframe / Shadow DOM 补强、Managed Browser Session 和 recipe 候选。

### WP0：合同和测试矩阵先行

目标：在动实现前，把浏览观察、目标行动、只读探针、站点经验、工具面退役和进度证据写成可验证合同。

改什么：

1. 新增或扩展 browser interaction schema。
2. 明确 `BrowserObservation`、`BrowserTarget`、`BrowserActionResult`、`BrowserReadonlyProbeResult`、`BrowserSiteExperience`。
3. 新增工具面合并 / 退役地图，明确新工具取代或收编哪些旧工具。
4. 补一组 contract tests，先覆盖纯函数和调度层，不依赖真实网页。

验证：

1. 页面地图生成能稳定去噪。
2. 目标 stale generation 会被拒绝。
3. 歧义目标必须报结构化错误。
4. 高风险 action 必须被 risk gate 拦下。
5. 只读探针不能写 DOM、不能导航、不能发请求、不能修改 storage。
6. 站点经验不能降低硬名单高风控风险。
7. 默认 prompt / tool guidance 不能继续把旧点击、旧输入、旧正文读取作为首选浏览路径。

完成标准：

1. 合同测试失败时能指出具体缺口。
2. 工具面退役地图和 M1 gate 写入合同。
3. 后续 WP 都能引用这些合同，不再靠文档口头约束。

### WP0.5：提示纪律独立上线

目标：先交付低风险、高即时收益的 prompt 纪律，不等待新工具。

改什么：

1. 更新 Browser Domain prompt / SDK runtime prompt 中的浏览任务纪律。
2. 明确“错误页不等于不存在”“站内生成链接优先”“隐藏 DOM / iframe / Shadow DOM 需要复查”。
3. 子 agent 或子任务 prompt 改成目标、约束、证据要求和退出条件，不用动作暗示替代目标。
4. 要求模型遇到同一路径失败时换证据路径，而不是重复导航或重复点击。

验证：

1. prompt 文本有合同测试或 snapshot，避免后续回退。
2. 高风控平台的安全提示仍在，且没有被站点经验覆盖。
3. 至少用一个本地 mock 页面或真实低风险网页狗粮，确认模型会先复查证据再下结论。

完成标准：

1. 这是可以单独合入的第一批改动。
2. 不依赖 `browser_read_page_map`、`browser_act_on_target` 或站点经验存储。

### WP1：Site Experience Store

目标：把站点经验从 prompt 里的散乱记忆变成可过期、可降级、可审计的提示源。

改什么：

1. 新建 `browser-site-experience-store`。
2. 支持按 domain/path/task kind 查询经验。
3. 支持 `confidence`、`lastVerifiedAt`、`expiresAt`。
4. 支持从成功任务写入“候选经验”，但默认只作为低置信 hint。
5. 在 Browser Domain Adapter 或 prompt assembly 注入当前 domain 的经验摘要。

验证：

1. 过期经验不会作为强提示注入。
2. 不同 domain 不会串经验。
3. 高风险经验不会自动授权高风险动作。
4. 成功任务只能写入带来源和时间的候选经验。
5. `isHighControlPlatformText` 命中的站点不能被站点经验降级。

完成标准：

1. agent 能看到站点 hint。
2. 工具执行仍以当前页面证据为准。
3. 没有经验时任务行为不退化。

### WP2：页面地图成为正式工具

目标：让 `browser_read_page_map` 从已有纯模块变成正式工具入口，减少 agent 对正文和猜测选择器的依赖。

改什么：

1. 在 `browser-tool-catalog.ts` 注册 `browser_read_page_map`。
2. 在 schema 中定义输入输出。
3. 在 `browser-tools.ts` 接入 `agent-browser-page-map.ts`。
4. 将页面地图结果纳入 browser evidence。
5. 在 prompt 中明确：进入页面后优先读取 page map，再行动。
6. 将 `browser_read_page`、`browser_probe_workflow_state`、`browser_locate_action_targets`、`browser_locate_input_targets`、`browser_list_upload_targets` 从默认观察路径降级为 detail / fallback / 内部来源。

验证：

1. 普通按钮、链接、输入框、文件 input 能出现在 map 中。
2. 重复文本按钮会进入 ambiguity group。
3. iframe / Shadow DOM 被标注，不被静默吞掉。
4. 被隐藏但可操作的结构能给出状态，而不是混在正文里。

完成标准：

1. 模型不再只能依赖 `browser_read_page` 的正文。
2. 页面地图输出足够支持下一步 target action。
3. 旧观察工具不能作为浏览任务的唯一证据。

### WP3：目标行动成为正式工具

目标：把 `browser_act_on_target` 注册成正式工具，并用它替代多数“按文本猜点击”的动作。

改什么：

1. 在 catalog 注册 `browser_act_on_target`。
2. 接入 `agent-browser-act.ts`。
3. 支持 click、type、select、set files、submit 等基础 action。
4. action 必须携带 `targetId` 和 `generation`。
5. 行动后自动触发 readBack 或 observation refresh。
6. 将旧点击/输入/坐标/消息工具从默认动作路径降级为 fallback。

验证：

1. stale target 必须失败。
2. 歧义目标必须失败并返回候选项。
3. disabled / invisible / cross-frame 不可达目标必须给出原因。
4. 点击后页面变化会被记录。
5. 文件上传使用已有 `DOM.setFileInputFiles`，不重复发明上传路径。

完成标准：

1. 浏览器 action 结果可复查。
2. task card 能展示动作前后证据。
3. 工具错误能结构化回灌模型。
4. 旧动作工具不能绕开 target-id + generation 成为首选路径。

### WP4：模型可组合只读探针

目标：新增受限但灵活的只读探针工具，补上 web-access 最有价值的现场适应力。

改什么：

1. 新增 `browser_probe_readonly` 或同等工具名。
2. 允许模型表达观察目标，但运行时把它限制在只读、无导航、无网络副作用、无 storage 写入。
3. 支持按 scope 观察 document、visible、forms、links、media、frames、shadow-dom。
4. 输出 node limit、摘要、failure kind 和下一步建议。
5. 高风控平台禁用自由表达式，只允许固定只读 scope。
6. 同步收口 `capturePageState` 的占位 probe，让统一页面状态服务复用这些只读 probe。

验证：

1. probe 无法写 DOM、无法点击、无法导航、无法发请求。
2. 空页面、普通页面、表单页、上传页、iframe 页都能返回合理状态。
3. probe 失败不会吞掉整体 page state，但必须记录失败原因。
4. 高风控策略下不会执行未授权 probe。
5. 跨域 iframe 返回结构化不可读原因。

完成标准：

1. 模型能对陌生页面提出安全的观察问题。
2. 页面状态不再依赖占位 `null`。
3. 后续站点经验和 progress 都能读同一个 page state。

### WP5：进度推进改为证据驱动

目标：减少甚至去掉对模型文本“步骤完成”的依赖。

改什么：

1. 施工前再次验证浏览器 free-loop 在出货构建里经过 `BrowserDomainOrchestrator.recordToolLoopProgress`。
2. 在 Browser Domain Orchestrator 中引入 `BrowserTaskEvidence`。
3. 将工具结果、page observation、只读 probe result、下载/上传结果接入进度判断。
4. 模型口头总结只能作为 narration，不能单独推进 step。
5. task projection 消费 evidence 状态。

验证：

1. 模型说完成但没有证据时，任务不能进入完成态。
2. 工具结果满足证据时，即使模型措辞不同，也能推进状态。
3. 用户中断或浏览器失焦时，状态能停在可恢复点。
4. 如果 live 路径不经过该 orchestrator，本 WP 先停下改定位，不在死路径上施工。

完成标准：

1. 任务进度可从日志和工具结果复盘。
2. 不再靠中文文本解析作为主要完成依据。

### WP6：Recipe 候选沉淀（后置，不进首轮关键路径）

目标：只在真实任务证明某个模式稳定后，再把它沉淀成 recipe。第一阶段不先造通用 recipe runner。

候选观察场景：

1. `official-entry-resolution`
   - 输入：用户要找的对象、候选 domain、目标类型。
   - 输出：官方入口、站点生成链接、证据链。
   - 防错：不能把平台错误页当成不存在。

2. `visible-list-collect`
   - 输入：采集目标、数量、滚动策略、停止条件。
   - 输出：items、来源、滚动范围、终止原因。
   - 防错：重复率过高或到底必须停止。

3. `upload-and-submit-proof`
   - 输入：文件、目标页面、提交目标。
   - 输出：上传证据、提交证据、失败原因。
   - 防错：只用现有 file input / CDP 上传路径，不模拟系统文件窗口。

改什么：

1. 先不新增 recipe runner。
2. 在 dogfood 任务中记录可复用模式、失败分支和证据要求。
3. 只有模式重复出现且页面观察/目标行动/只读探针都能表达时，再写 recipe types。
4. recipe 写入前必须有反例检查，证明它不会压制陌生页面探索。
5. 成功 recipe 只能生成低置信站点经验候选。

验证：

1. 没有足够狗粮证据时，不允许实现 recipe。
2. 每个 recipe 都必须有 fixtures 和合同测试。
3. 每个 recipe 的失败路径可复现。
4. recipe 不允许越权调用非 allowlist 工具。

完成标准：

1. Recipe 从证据中长出来，不从猜测中预设。
2. recipe 不依赖临时 `.mjs` 文件，也不替代页面观察。

### WP7：iframe / Shadow DOM / hidden content 观察补强

目标：把 Claude 提到的具体页面结构陷阱纳入观察合同。

改什么：

1. page map 标注 iframe 列表、frame title、src、可读性。
2. 同源 iframe 通过 CDP frame execution context 读取；跨域 iframe 只标注元数据和不可读原因。
3. Shadow DOM 节点进入 page map 或以结构化摘要展示。
4. hidden but loaded 内容单独标注。
5. 对跨域不可读 frame 给出明确 failure kind。

验证：

1. Shadow DOM 组件中的按钮能被发现或明确说明不可达。
2. iframe 页面不会被误判为空。
3. hidden loaded content 不会污染 visible text summary，但能作为可展开线索。
4. 跨域 iframe 不被承诺可读取，必须返回结构化限制原因。

完成标准：

1. “读不到”必须有结构化原因。
2. agent 能知道下一步是切 frame、展开、等待，还是请求用户授权。

### WP8：Managed Browser Session 收口

目标：把当前 `ScopedBrowserFacade` 扩展成更正式的会话边界，为后续 Agent Browser / 用户 Browser 解耦铺路。

改什么：

1. 明确 browser scope 生命周期。
2. 每个 scope 绑定 tab、lease、generation、allowedTools、riskLevel。
3. 用户 takeover、导航变化、任务结束都写入 scope 状态。
4. 子任务、只读探针和后续 recipe 只能访问当前 scope。
5. 清理悬挂监听、临时下载、probe state。

验证：

1. 非当前 scope tab 不能被工具误操作。
2. lease 过期后 action 必须失败。
3. 用户切换页面后 stale generation 必须触发重新观察。
4. 任务结束后不残留锁和监听。

完成标准：

1. agent 操作浏览器不会污染用户当前浏览状态。
2. 后续独立 Agent Browser 可以复用同一 scope 合同。

### WP9：端到端狗粮验证

目标：用真实任务证明新体系比旧路径更稳。

建议狗粮任务：

1. 官方入口查找  
   从用户给出的非标准链接或名称出发，找官方页，返回站内生成链接和证据。

2. 高风险平台页面判断  
   遇到“content not found”时，复查入口、链接、渲染状态和站点生成链接，不直接下结论。

3. 长列表采集  
   采集搜索结果、评论或信息流，记录滚动终止原因。

4. 上传并确认  
   上传文件后确认 input、预览、按钮状态和提交结果。

5. 用户接管  
   用户在 agent 操作中切换页面或暂停，任务进入可恢复状态。

验证：

1. 每个任务保留工具日志和 evidence。
2. 失败场景必须有可解释 failure kind。
3. 旧的 `browser_read_page` 弱路径不能被用作唯一证据。

完成标准：

1. 至少三类任务通过真实或最小可复现页面验证。
2. 计划中的合同能解释成功和失败。

---

## 6. 关键实现路径

### 6.1 工具注册和 schema

优先涉及：

1. `src/main/modules/tools/browser-tool-catalog.ts`
2. `src/main/modules/tools/schemas/browser-interaction-schemas.ts`
3. `src/main/modules/tools/browser-tools.ts`
4. `src/main/modules/browser-engine/browser-tool-write-classification.ts`

实施原则：

1. 先注册 `browser_read_page_map` 和 `browser_act_on_target`。
2. 输入输出必须结构化。
3. 工具错误必须回灌为结构化 `ToolExecutionOutput`。
4. 分类表、catalog、prompt 暴露保持一致。

### 6.2 页面观察和证据

优先涉及：

1. `src/main/modules/browser-engine/agent-browser-page-map.ts`
2. `src/main/modules/browser-engine/page-state-service.ts`
3. `src/main/modules/browser-engine/evidence-service.ts`
4. `src/main/modules/browser-engine/capability-service.ts`

实施原则：

1. 页面 map 是 observation 的核心，不只是辅助调试。
2. page state 不再返回占位 probe。
3. evidence 是任务状态推进依据。
4. 观察失败也要结构化。

### 6.3 目标行动

优先涉及：

1. `src/main/modules/browser-engine/agent-browser-act.ts`
2. `src/main/modules/browser-engine/automation-service.ts`
3. `src/main/modules/browser-engine/scoped-browser-facade.ts`

实施原则：

1. 目标行动只能基于 fresh page map。
2. 文件上传复用已有 `DOM.setFileInputFiles`。
3. 每次 action 后必须 readBack。
4. 写操作必须走 lease 和 risk gate。

### 6.4 站点经验

建议新增：

1. `src/main/modules/browser-engine/browser-site-experience-store.ts`
2. `src/shared/browser-site-experience.ts`
3. 对应测试 fixtures

实施原则：

1. 运行时经验进 app data / SQLite。
2. repo 内只放合同 fixture。
3. 经验是 hint，不是事实。
4. 经验写入必须有成功证据。
5. 经验只能抬高风险，不能降低硬名单高风控风险。

### 6.5 只读探针

建议新增：

1. `src/main/modules/browser-engine/browser-readonly-probe.ts`
2. `src/shared/browser-readonly-probe.ts`
3. 对应 schema / contract tests
4. `BrowserPageStateService.capturePageState` 的 probe 接入点

实施原则：

1. 模型可以表达观察意图，但运行时只执行受限只读查询。
2. 禁止 DOM 写入、导航、点击、输入、提交、下载、发请求、storage/cookie 写入。
3. 同源 iframe 可以进入对应 execution context；跨域 iframe 只返回元数据和不可读原因。
4. 输出必须限量、摘要化，并记录 failure kind。
5. 高风控平台只允许固定只读 scope。

### 6.6 Recipe 候选

第一阶段不建议新增：

1. `browser-recipe-runner.ts`
2. 固定 `official-entry-resolution` / `visible-list-collect` / `upload-and-submit-proof` recipe

实施原则：

1. 先把这三类场景作为 dogfood 任务。
2. 从成功和失败证据中记录可复用模式。
3. 只有模式被多次验证后，再写 recipe types 和 fixtures。
4. recipe 只能减少重复工作，不能替代页面观察和只读探针。

### 6.7 Prompt 和 Orchestrator

优先涉及：

1. `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
2. `src/main/modules/agent-control/domain-adapters/browser-domain-orchestrator.ts`
3. Browser Domain Adapter 相关 prompt assembly

实施原则：

1. WP0.5 先更新 prompt，告诉 agent 先观察、再行动、再复查。
2. prompt 注入 site experience 时要标明它只是 hint。
3. 进度推进以 evidence 为准。
4. 子 agent prompt 以目标、约束和证据要求为中心。
5. 动 WP5 前先确认浏览器 free-loop 的 live runtime 路径。

---

## 7. 验证矩阵

### 7.1 合同测试

必须覆盖：

1. prompt 纪律 snapshot，防止“先观察、再行动、再复查”的约束被回退。
2. 页面地图去噪。
3. targetId 稳定生成。
4. stale generation 拒绝。
5. 歧义目标拒绝。
6. iframe / Shadow DOM 标注。
7. hidden loaded content 标注。
8. 只读 probe 不能写 DOM、导航、发请求或改 storage。
9. high-control / risk gate 拒绝未授权 probe。
10. site experience 过期和低置信降级。
11. site experience 不能降低硬名单高风控风险。
12. evidence 不足时任务不能完成。
13. 后续若实现 recipe，recipe allowlist 必须拒绝越权工具。

### 7.2 行为测试

必须覆盖：

1. 普通页面读取 page map。
2. 点击按钮后 readBack 证明页面变化。
3. 上传文件后证明 input / preview / submit state。
4. 滚动采集达到停止条件。
5. “content not found” 页面不被直接判死。
6. 用户 takeover 触发 stale generation。
7. 只读 probe 在陌生页面上能回答限定范围内的观察问题。
8. 跨域 iframe 返回不可读原因，不误报为空页面。

### 7.3 日志和可观测性

必须能从日志看到：

1. observation id。
2. target id。
3. action id。
4. generation。
5. failure kind。
6. evidence id。
7. readonly probe query / scope / riskDecision。
8. scope / lease 状态。
9. 后续 recipe id。

### 7.4 回归检查

每阶段至少检查：

1. `npm run typecheck`
2. 对应新增或修改的 browser 合同测试
3. 相关工具 catalog / schema 暴露一致性
4. Browser 基础打开、读取、点击链路

涉及 SQLite、持久化或 app data 时，再加：

1. `npm run verify:native`

---

## 8. 风险和处理

### 8.1 站点经验可能过期

处理：

1. 每条经验有 `lastVerifiedAt` 和 `expiresAt`。
2. 过期经验只作为弱提示。
3. 当前页面证据永远优先。

### 8.2 新工具增加 token 和复杂度

处理：

1. `browser_read_page_map` 输出默认摘要，不把完整 DOM 塞给模型。
2. 大页面只输出 top targets、risk flags 和可请求的分页详情。
3. 后续若实现 recipe，recipe 输出只给结果和证据摘要。

### 8.3 JS probe 可能扩大风险

处理：

1. probe 分 risk level。
2. 高风控任务只允许固定只读 probe。
3. 写操作必须走 action contract。
4. 裸任意 JS 不作为 LLM 可直接调用能力；模型可组合只读探针必须由运行时限制副作用。

### 8.4 用户浏览器可能被污染

处理：

1. 当前阶段通过 scope、lease、generation 控制。
2. 后续接入独立 Agent Browser。
3. 用户接管时任务进入可恢复状态。

### 8.5 计划可能变成过度工程

处理：

1. 每个 WP 必须能独立落地和验证。
2. 第一批只做提示纪律、两个正式工具、一个只读探针、一个 site store。
3. 不先做通用脚本平台。
4. 不先做 recipe runner。
5. 不引入外部 proxy / Chrome。

---

## 9. 与 Claude 对齐时要重点讨论的问题

### 9.1 页面地图是新工具，还是 `browser_read_page` 的模式？

建议：先做新工具 `browser_read_page_map`。

理由：

1. 和现有弱正文读取区分清楚。
2. 更容易写合同和测试。
3. 后续可以让 `browser_read_page` 变成 observation 的薄门面，但不能保留一条长期弱正文默认路径。
4. 退役门槛必须写死：当 page-map 和 target-action 通过合同测试、至少三类狗粮任务证明可用后，`browser_read_page` 不得再作为浏览任务的默认入口或唯一证据来源。

### 9.2 站点经验放哪里？

建议：运行时放 app data / SQLite，repo 只放测试 fixture。

理由：

1. 站点经验跟用户环境和时间强相关。
2. repo 内经验容易变成过期硬编码。
3. fixture 能验证合同，不冒充实时事实。

### 9.3 Recipe 何时做？

建议：第一阶段不做 recipe runner。

理由：

1. web-access 的核心教训是让 AI 根据页面实际结构调整，而不是先套固定操作模板。
2. `official-entry-resolution`、`visible-list-collect`、`upload-and-submit-proof` 先作为狗粮任务和经验来源。
3. 只有同类任务被多次证明稳定，且反例清楚，才把它沉淀为 recipe。

### 9.4 站点经验能否自动写入？

建议：可以写入候选经验，但初始置信度低，必须带证据和时间，不能自动变成强规则。

理由：

1. 成功任务确实有学习价值。
2. 自动学习如果没有降级机制，会把偶然成功变成长期错误。

### 9.5 Managed Browser Session 放在当前 BrowserView，还是等独立 Agent Browser？

建议：先在当前 agent tab / BrowserView 工具链上实现 scope 合同，再迁到独立 Agent Browser。

理由：

1. scope / lease / generation 是两种形态都需要的底层合同。
2. 先做合同能降低后续迁移风险。
3. 不阻塞当前浏览器 agent 改善。

### 9.6 只读探针是不是变相开放 eval？

建议：不是。它必须是受限执行器，而不是裸 eval。

理由：

1. 模型只表达观察意图，运行时决定允许的只读 scope。
2. 禁止所有写入、导航、网络副作用和存储修改。
3. 高风控平台禁用自由表达式，只允许固定只读 probe。
4. 这保留 web-access 的现场适应力，同时不把产品安全交给模型自觉。

---

## 10. Definition of Done

本计划完成实现时，必须满足：

1. Browser prompt 纪律已独立上线，并有 snapshot 或合同测试防回退。
2. `browser_read_page_map` 和 `browser_act_on_target` 成为正式工具，并通过合同测试。
3. 浏览器观察输出能覆盖目标、表单、文件 input、链接、iframe、Shadow DOM、隐藏加载内容和风险标记。
4. 行动必须基于 fresh target，行动后必须 readBack。
5. 模型可组合只读探针能观察陌生页面，但不能写 DOM、导航、发请求或改 storage。
6. 站点经验能按 domain/path/task kind 查询、过期、降级和注入，且不能降低硬名单高风控风险。
7. 任务进度主要由 evidence 推进，不靠模型口头声明。
8. 用户接管、lease 过期、generation stale 都能进入可恢复状态。
9. 日志能串起 observation、target、action、readonly probe、evidence 和 scope。
10. 对应合同测试、行为测试和必要 native verify 通过。
11. 没有引入外部 proxy、外部 Chrome 默认接管、裸任意 JS 暴露、第一阶段 recipe runner 或长期 legacy 兼容分支。
12. 新工具对应的旧动作/观察工具已有明确降级、内化或退役路径，默认 prompt 不再鼓励双路径并行。

---

## 11. 推荐实施顺序

建议按以下顺序推进：

### M1：证明骨架成立

1. WP0 合同和测试矩阵。
2. WP0.5 提示纪律独立上线。
3. WP2 页面地图正式工具。
4. WP3 目标行动正式工具。
5. M1 狗粮验证。

M1 通过后再决定是否继续投入 M2。若 M1 不能证明新工具优于旧点击/输入/正文读取路径，就先修 M1，不继续扩展。

### M2：补适应力和经验

1. WP4 模型可组合只读探针。
2. WP1 Site Experience Store。
3. WP9 端到端狗粮验证。

M2 的目标是证明这套方案不仅适合 mock 页，也能面对陌生页面和站点规律。

### M3：收口长期运行形态

1. WP5 证据驱动进度。
2. WP7 iframe / Shadow DOM / hidden content 补强。
3. WP8 Managed Browser Session 收口。
4. WP6 Recipe 候选沉淀。

这个顺序的原因是：先把低风险提示纪律上线，再把“看页面”和“按目标行动”接到工具面，立刻狗粮证明。只有第一个闭环成立后，才继续推进只读探针、站点经验、进度证据、会话收口和 recipe 候选。

---

## 12. 本计划的边界

本计划不是：

1. 不是重写 Ready 浏览器。
2. 不是引入 web-access 作为依赖。
3. 不是新增一个自由脚本执行平台。
4. 不是接管用户系统 Chrome。
5. 不是把所有浏览任务都 recipe 化。

本计划是：

1. 把 Ready 已有浏览器能力组织成稳定闭环。
2. 把 web-access 的有效浏览纪律转成 Ready 自己的合同。
3. 先补可验证的观察和行动，再谈更复杂的 agent 浏览器形态。
4. 为后续用户浏览器 / agent 浏览器解耦打下会话和证据基础。
