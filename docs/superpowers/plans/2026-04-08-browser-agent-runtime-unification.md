# Browser-Agent Runtime Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Ready 当前分散在 `direct-chat`、`browser-agent-runner`、`browser-tools`、`session-continuity` 和任务卡里的浏览器智能收成一套统一浏览器运行时，为后续更强的浏览器-agent 结合打底。

**Architecture:** 保留现有 BrowserView 宿主和 Browser Agent V7 证据优先原则，不照搬 Hermes 的外接浏览器实现，而是借它“统一浏览器抽象”的方法。第一阶段只做统一合同，不做大范围产品行为改写：先建立统一浏览器运行时、页面状态、证据服务和 planner，再把 deterministic runner、tool loop 和任务卡投影逐步迁到新合同上。

**Tech Stack:** Electron 34、React 19、TypeScript 5、better-sqlite3、node:test via `tsx`

---

## Cross Comparison

### 1. 浏览器后端抽象

- **Hermes 更强的点：**
  浏览器 provider 抽象非常稳定，不管底层接 Browser Use、Browserbase、Firecrawl 还是 CDP，agent 看到的都是同一套浏览器工具。
- **Ready 更强的点：**
  浏览器不是外挂能力，而是工作台里的真实产品身体，拥有 BrowserView、tab、host、layout、前台切换和任务卡联动。
- **本阶段决定：**
  不引入 Hermes 那套 cloud provider 路线，改为在 Ready 内部建立一个统一的 agent-facing browser runtime adapter，继续把 `BrowserController` 作为真实执行底座。

### 2. 页面状态模型

- **Hermes 更强的点：**
  页面世界模型稳定、简单，导航后自动补 snapshot，模型心智负担小。
- **Ready 更强的点：**
  已经有比 Hermes 更强的页面阶段理解和连续性信息，但这些能力散在多个模块里。
- **本阶段决定：**
  把当前分散的页面身份、动作候选、上传状态、prompt 状态、运行态状态统一成正式 `BrowserPageState` 快照。

### 3. 证据 gating

- **Hermes 更强的点：**
  浏览器生命周期和 cleanup 是正式底座能力，不是临时补丁。
- **Ready 更强的点：**
  对上传、填写 prompt、提交、运行态的证据要求更严格。
- **本阶段决定：**
  保留 Ready 现有更强的证据优先原则，并从 `BrowserAgentRunner` 中抽出统一 evidence service，让 planner、runner、tool loop、任务卡共用同一套判断。

### 4. 任务规划位置

- **Hermes 更强的点：**
  工具面清楚，浏览器任务心智简单。
- **Ready 更强的点：**
  已经具备浏览器意图识别、连续性注入、任务类型区分，但主要堆在 `direct-chat.ts`。
- **本阶段决定：**
  从 `direct-chat.ts` 抽出 `browser-task-planner`，把任务识别、连续性合流、执行路径选择收进独立模块。

### 5. UI 任务投影

- **Hermes 更强的点：**
  对 agent 来说浏览器工具面稳定。
- **Ready 更强的点：**
  已经把浏览器任务阶段往聊天任务卡投影，而且用户能看到当前步骤。
- **本阶段决定：**
  不退回 Hermes 那种“主要看最终结果”的方式，而是让浏览器运行时直接输出结构化任务状态，减少现在对字符串解析的依赖。

### 6. 阶段一的范围边界

- **本阶段必须做：**
  - 统一浏览器运行时接口
  - 统一页面状态快照
  - 统一证据服务
  - 抽出 planner
  - runner / tool loop 共用统一页面模型
  - 结构化浏览器任务投影
- **本阶段不做：**
  - 外部云浏览器接入
  - 跨会话搜索
  - 记忆可插拔
  - 自动自学改 skill / 自动写长期记忆
  - 整体重写 `direct-chat.ts`

## Planned File Structure

### New files

- Create: `src/shared/browser-agent-task.ts`
  统一浏览器任务结构化 payload 类型，供 main / renderer 共用。

- Create: `src/main/modules/browser-engine/agent-runtime-adapter.ts`
  把 `BrowserController` 暴露成 agent-facing 统一运行时接口。

- Create: `src/main/modules/browser-engine/page-state-service.ts`
  负责生成统一 `BrowserPageState` 快照。

- Create: `src/main/modules/browser-engine/evidence-service.ts`
  统一判断 target / upload / prompt / running / ambiguity 等证据。

- Create: `src/main/modules/agent-control/browser-task-planner.ts`
  负责浏览器任务识别、连续性合流、计划生成、执行路径选择。

- Create: `src/__tests__/browser-agent-runtime-contract.test.ts`
- Create: `src/__tests__/browser-agent-evidence.test.ts`
- Create: `src/__tests__/browser-task-planner.test.ts`

### Modified files

- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/tools/browser-agent-runner.ts`
- Modify: `src/main/modules/tools/browser-tools.ts`
- Modify: `src/main/modules/agent-control/session-continuity.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/main/modules/agent-control/types.ts`
- Modify: `src/renderer/modules/agent/scopeRunState.ts`
- Modify: `src/renderer/modules/agent/runtimeDriver.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `DOCUMENTATION.md`
- Modify: `LESSONS_LEARNED.md`
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`

## Chunk 1: Contract First

### Task 1: 先锁定新的浏览器运行时分层合同

**Files:**
- Create: `src/__tests__/browser-agent-runtime-contract.test.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/tools/browser-agent-runner.ts`
- Modify: `src/main/modules/tools/browser-tools.ts`

- [ ] **Step 1: Write the failing contract test**

补 source-level 断言，要求：
- `direct-chat.ts` 不再自己长期持有浏览器计划主逻辑，而是依赖独立 `browser-task-planner`
- `browser-agent-runner.ts` 不再自己定义完整页面世界模型，而是消费统一 runtime / page state / evidence 模块
- `browser-tools.ts` 的高层浏览器工具不再直接拼各自判断，而是能够复用统一运行时能力

- [ ] **Step 2: Run focused contract test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-runtime-contract.test.ts`
Expected: FAIL，因为这些分层模块还不存在。

- [ ] **Step 3: Add the minimal file shells**

先创建以下空壳模块和基础导出：
- `src/shared/browser-agent-task.ts`
- `src/main/modules/browser-engine/agent-runtime-adapter.ts`
- `src/main/modules/browser-engine/page-state-service.ts`
- `src/main/modules/browser-engine/evidence-service.ts`
- `src/main/modules/agent-control/browser-task-planner.ts`

- [ ] **Step 4: Re-run contract test**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-runtime-contract.test.ts`
Expected: PASS 或只剩更细粒度断言失败，继续补最小导出直到通过。

## Chunk 2: Unified Browser Runtime And Page State

### Task 2: 建立统一浏览器运行时适配层

**Files:**
- Create: `src/main/modules/browser-engine/agent-runtime-adapter.ts`
- Modify: `src/main/modules/browser-engine/ipc-handler.ts`
- Test: `src/__tests__/browser-engine-services.test.ts`
- Test: `src/__tests__/browser-agent-runtime-contract.test.ts`

- [ ] **Step 1: Write the failing tests**

补断言，要求新 adapter 至少能统一暴露：
- active tab / tab context
- navigate
- execute JS
- 动作候选探测入口
- 输入 / 点击 / 上传入口
- 恢复页面入口
- 任务恢复入口

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-engine-services.test.ts src/__tests__/browser-agent-runtime-contract.test.ts`
Expected: FAIL，因为 adapter 还没有真实接线。

- [ ] **Step 3: Implement minimal adapter**

把 `BrowserController` 中已有能力收成统一接口，不新增产品行为，只做薄适配和归一化命名。

- [ ] **Step 4: Re-run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-engine-services.test.ts src/__tests__/browser-agent-runtime-contract.test.ts`
Expected: PASS.

### Task 3: 建立统一页面状态快照

**Files:**
- Create: `src/main/modules/browser-engine/page-state-service.ts`
- Modify: `src/main/modules/tools/browser-agent-runner.ts`
- Modify: `src/main/modules/tools/browser-tools.ts`
- Create: `src/__tests__/browser-agent-page-state.test.ts`

- [ ] **Step 1: Write the failing test**

要求 `page-state-service` 统一返回：
- 页面身份
- input / send / upload 候选
- active input anchor
- modal / off-target / ambiguity 等页面风险

- [ ] **Step 2: Run focused test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-page-state.test.ts`
Expected: FAIL，因为统一页面状态服务还不存在。

- [ ] **Step 3: Implement minimal page-state snapshot builder**

先把 `BrowserAgentRunner` 里已有的 snapshot、candidate、anchor 逻辑收进 `page-state-service`，不要改行为，只做归一化。

- [ ] **Step 4: Re-run focused test**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-page-state.test.ts`
Expected: PASS.

## Chunk 3: Evidence Service

### Task 4: 把上传、prompt、运行态等关键判断收成统一证据服务

**Files:**
- Create: `src/main/modules/browser-engine/evidence-service.ts`
- Create: `src/__tests__/browser-agent-evidence.test.ts`
- Modify: `src/main/modules/tools/browser-agent-runner.ts`
- Modify: `src/main/modules/tools/browser-tools.ts`

- [ ] **Step 1: Write the failing evidence tests**

覆盖至少这些判断：
- 当前是否已在目标页
- 附件是否已挂载
- prompt 是否已进入正确输入区
- 页面是否进入运行态
- 当前页是否更像模式选择页

- [ ] **Step 2: Run focused test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-evidence.test.ts`
Expected: FAIL，因为 evidence service 还不存在。

- [ ] **Step 3: Implement minimal evidence service**

把 `BrowserAgentRunner` 中的上传、prompt、running、target 判断迁入统一服务，并保留当前证据优先行为。

- [ ] **Step 4: Re-run focused test**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-evidence.test.ts`
Expected: PASS.

## Chunk 4: Planner Extraction

### Task 5: 从 direct-chat 中抽出浏览器任务 planner

**Files:**
- Create: `src/main/modules/agent-control/browser-task-planner.ts`
- Create: `src/__tests__/browser-task-planner.test.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/session-continuity.ts`

- [ ] **Step 1: Write the failing planner tests**

要求 planner 至少能独立处理：
- 浏览器意图识别
- 附件 / prompt 意图解析
- 连续性上下文合流
- 目标页复用判断
- `browser_upload_workflow / browser_workflow / clarify_first / free_tool_loop` 选择

- [ ] **Step 2: Run focused planner tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-task-planner.test.ts`
Expected: FAIL，因为 planner 还在 `direct-chat.ts` 内。

- [ ] **Step 3: Move the logic with no behavior expansion**

先把现有判断原样迁到 `browser-task-planner.ts`，再让 `direct-chat.ts` 只负责调用 planner，不再自己长期持有浏览器任务构造细节。

- [ ] **Step 4: Re-run focused planner tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-task-planner.test.ts src/__tests__/browser-agent-runtime-contract.test.ts`
Expected: PASS.

## Chunk 5: Runner And Tools Converge On One Runtime

### Task 6: 让 deterministic runner 改用统一 runtime / page state / evidence

**Files:**
- Modify: `src/main/modules/tools/browser-agent-runner.ts`
- Modify: `src/main/modules/browser-engine/agent-runtime-adapter.ts`
- Modify: `src/main/modules/browser-engine/page-state-service.ts`
- Modify: `src/main/modules/browser-engine/evidence-service.ts`

- [ ] **Step 1: Write the failing contract extension**

补断言，要求 runner：
- 不再自己长期维护页面状态判断逻辑
- 改用统一 page-state 和 evidence service
- 继续保留 Browser Agent V7 的阶段顺序和证据 gate

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-agent-evidence.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor runner with behavior parity**

迁移内部判断，保留阶段名、重试策略、恢复策略和完成条件不变。

- [ ] **Step 4: Re-run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-agent-evidence.test.ts src/__tests__/browser-tools.test.ts`
Expected: PASS.

### Task 7: 让高层 browser tools 复用同一套运行时与证据

**Files:**
- Modify: `src/main/modules/tools/browser-tools.ts`
- Modify: `src/main/modules/browser-engine/agent-runtime-adapter.ts`
- Modify: `src/main/modules/browser-engine/page-state-service.ts`
- Modify: `src/main/modules/browser-engine/evidence-service.ts`
- Test: `src/__tests__/browser-tools.test.ts`

- [ ] **Step 1: Write the failing tool tests**

补断言，要求高层工具优先复用统一运行时，不再各自重新推页面状态。

- [ ] **Step 2: Run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewire browser tools**

先重接高层工具，不动低层控制器能力。

- [ ] **Step 4: Re-run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-tools.test.ts`
Expected: PASS.

## Chunk 6: Structured Browser Task Projection

### Task 8: 用结构化浏览器任务 payload 取代当前主要依赖字符串解析的路径

**Files:**
- Create: `src/shared/browser-agent-task.ts`
- Modify: `src/main/modules/tools/browser-agent-runner.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/main/modules/agent-control/types.ts`
- Modify: `src/renderer/modules/agent/scopeRunState.ts`
- Modify: `src/renderer/modules/agent/runtimeDriver.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Test: `src/__tests__/scope-run-state.test.ts`
- Test: `src/__tests__/agent-task-panel-contract.test.ts`

- [ ] **Step 1: Write the failing tests**

要求浏览器任务可以通过结构化 payload 驱动：
- `taskTitle`
- `taskSummary`
- `steps`
- `currentStepId`
- `waitingFor`
- `resumableActions`
- `recentArtifacts`

- [ ] **Step 2: Run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts`
Expected: FAIL，因为浏览器任务当前主要还是靠文本阶段解析。

- [ ] **Step 3: Add shared browser task payload types and emit them**

让 deterministic runner 和相关浏览器链路输出统一结构化 payload；renderer 继续兼容旧文本解析，但优先消费结构化结果。

- [ ] **Step 4: Re-run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts src/__tests__/agent-stream-segmentation.test.ts`
Expected: PASS.

## Chunk 7: Docs And Final Verification

### Task 9: 同步文档与协作约定

**Files:**
- Modify: `DOCUMENTATION.md`
- Modify: `LESSONS_LEARNED.md`
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update docs**

把以下约定补齐到文档：
- 统一 browser runtime
- 统一 page state / evidence
- planner 抽离
- 浏览器任务结构化投影

- [ ] **Step 2: Sanity-check doc updates**

Run: `rg -n "browser runtime|page state|evidence service|browser-task-planner|结构化浏览器任务" DOCUMENTATION.md LESSONS_LEARNED.md PROGRESS.md CHANGELOG.md`
Expected: 所有新约定都能被搜到。

### Task 10: 跑第一阶段总验证

**Files:**
- Test: `src/__tests__/browser-engine-services.test.ts`
- Test: `src/__tests__/browser-tools.test.ts`
- Test: `src/__tests__/browser-agent-runtime-contract.test.ts`
- Test: `src/__tests__/browser-agent-evidence.test.ts`
- Test: `src/__tests__/browser-task-planner.test.ts`
- Test: `src/__tests__/scope-run-state.test.ts`
- Test: `src/__tests__/agent-task-panel-contract.test.ts`

- [ ] **Step 1: Run focused browser-agent suite**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-engine-services.test.ts src/__tests__/browser-tools.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-agent-evidence.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts`
Expected: PASS.

- [ ] **Step 2: Run project typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run project verify if the focused suite is clean**

Run: `npm run verify`
Expected: PASS，或者只剩本轮无关的已知旧问题并单独记录。

## Phase 1 Success Criteria

- `direct-chat.ts` 不再长期持有浏览器任务主逻辑。
- `BrowserAgentRunner` 和高层 browser tools 共用同一套 runtime / page state / evidence。
- 浏览器阶段与证据不再主要依赖字符串解析才能投影到任务卡。
- BrowserView 宿主规则、scope 隔离和附件资源边界全部保留。
- Browser Agent V7 的完成标准不退化。

## Defer To Later Phases

- 跨会话浏览器搜索与回看
- 记忆可插拔
- 自动自学改 skill / 自动写长期记忆
- 更激进的浏览器能力开关体系
- 外部浏览器 provider 接入
