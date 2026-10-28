# Codex runtime 两个大文件拆分

## 目标与范围

`codex-binding-repository.ts`（10819 行）与 `codex-runtime-production-composition.ts`（5656 行）都是 Ready 自己对接 Codex 的代码，台账评为危险：一个类承载准入、交付、恢复、压缩、收尾与进程租约全部持久化职责，一个函数闭包承载整个运行时装配。本轮按职责拆成有向分层的模块，**不改任何行为**：公开接口、导出路径、SQL、事务边界与错误码保持原样，现有全部行为测试与门禁不改断言即通过。

不在本轮：拆开单个超长函数的内部（`readToolPublicationBarrier` 653 行、`prepareIngress` 951 行、`closeCandidateOwned` 995 行等）——它们整体迁入专属模块，函数内部重写属于行为改动，另行立项。

## 现状事实（2026-10-07，AST 盘点）

- 仓库：1 个类 `CodexBindingRepository`（9529 行，178 个成员，其中 2 组重载），另有 78 个顶层声明（43 个导出，含 3 个运行时函数与错误类之外的类型）。成员间调用的高扇入核心是 `requireThread`(42)、`immediate`(41)、`requireTurn`(27)、`readActiveThreadByAlias`(14)。唯一以值方式使用 `this` 的位置是把仓库自身交给 `assertCodexTerminalEvidenceOwners`（2 处）。没有子类或原型改写。
- 组合根：`createCodexRuntimeComposition` 一个函数 5228 行，107 条内部语句，18 个可变 `let`（gateway、host、state、supervisor、sidecarSession、registry、productRecovery、lifecycle、bootGeneration 等）被多个闭包捕获。
- 测试与脚本中 7 处直接读取组合根源码文本；`helpers/codex-production-composition-harness.ts` 用 AST 从源码里取出 `ingressPort`/`startIdentityPort` 等闭包再求值——端口无法独立构造是这一做法的根因。

## 合同

1. **仓库门面不变**：`codex-binding-repository.ts` 仍导出 `CodexBindingRepository` 与原有全部导出名；类的公开方法集合与拆分前快照（`binding-repository/public-surface.json`，由拆分前源码 AST 生成）完全一致。门面不含 SQL（无 `.prepare(`、`.exec(`），除构造函数外每个方法只有一条把 `this.context` 交给领域函数的委托语句。
2. **领域模块是上下文上的函数**：`codex-runtime/binding-repository/*.ts` 不含 `this` 与 class；共享状态只有 `CodexBindingContext`（db、当前合同、工具绑定子仓库、`immediate` 事务、门面自身引用）。
3. **分层无环**：领域模块按声明的层级只能导入更低层（同层禁止互相导入），运行时导入图无环；层级表写在边界测试里，新增模块必须登记。
4. **组合根拆为显式依赖的工厂**：`codex-runtime/composition/*.ts` 每个工厂只经参数获得依赖；原 `let` 共享状态集中到一个 `CodexCompositionLive` 对象，读写都经它；组合根只负责创建状态与按顺序接线。入场端口（`aliasBindingPort`、`startIdentityPort`、`ingressPort` 及其依赖）由导出工厂构造，测试 harness 直接调用工厂，不再从源码求值。
5. **规模上限**：上述目录内每个文件与两个根文件都少于 1000 行。例外只有两个整体迁入的单函数文件——`composition/candidate-closeout.ts`（`closeCandidateOwned`）上限 1050 行、`composition/ingress-prepare.ts`（`prepareIngress`）上限 1025 行；它们的函数内部拆分属上文“不在本轮”，上限只防止继续增长。
6. **源码断言随迁**：原先扫描组合根或仓库源码、断言已退役符号不存在的测试与脚本，改为同时扫描入口文件与 `composition/`、`binding-repository/` 全部文件，断言内容不变；基线里的同一笔源码断言债务保持可见（只重算位置哈希），不借辅助函数消账。
7. **行为不变**：`typecheck`、全部 verify 段（逐段独立运行）、完整单元测试、真实二进制 e2e 全部通过，且不修改任何既有测试断言（仅允许 import 路径与 harness 的构造方式改变）。

机器校验：新增 `src/__tests__/codex-runtime-module-boundaries.test.ts`（合同 1、2、3、5、组合根部分的 4），接入 `verify:codex-runtime-e1`；harness 改造由使用它的原生测试覆盖；合同 6、7 由既有门禁覆盖。

## 实施顺序

1. 生成仓库公开面快照与边界测试（先红）。
2. 仓库：AST 代码改写把成员方法转为上下文函数（`this.db`→`context.db`、私有方法 `this.x(...)`→`x(context, ...)`、公开方法 `this.x(...)`→`context.self.x(...)`、`this`→`context.self`），按层级表写入领域模块，类型与纯函数移入 `types.ts`/`shared.ts`，门面生成一行委托；校验分层与规模。公开方法经 `context.self` 调用，保留了实例分派：测试对实例方法的替换与原先一样生效。
3. 组合根：引入 `CodexCompositionLive`，按依赖分析抽出工厂模块，harness 改为直接构造；源码断言随迁。
4. 全量门禁、文档（代码地图、运行时合同中的路径、台账）。

## 实施结果（2026-10-08）

### 仓库

- `codex-binding-repository.ts` 634 行：构造期合同校验 + 128 个一行委托，无 SQL；`binding-repository/` 22 个模块，最大 `publication-barrier.ts` 913 行。层级表（低→高）：`types/shared/context` → `core` → `turns/process-leases` → `uncommitted-tails` → `native-history` → `continuity` → `lifecycle-heads/publication-receipts/browser-verifier` → `publication-barrier/lifecycle-transitions/interrupts` → `admission/start-dispatch/manual-compaction/gateway-binding/recovery` → `closeout-product` → `closeout-terminal`。
- 公开方法集合与运行时导出与 `public-surface.json` 快照一致。

### 组合

- `codex-runtime-production-composition.ts` 190 行：创建 `CodexCompositionLive`，按 `base → closeout-support → engine-terminal → candidate-closeout → closeout-dispatch → lifecycle → head-continuation → begin-new-context → action-surface → alias-ports → ingress-prepare → ingress-port → runtime-start` 顺序接线，再返回运行时表面；导出名与拆分前完全一致。
- `live-state.ts`：原 18 个 `let` 成为 `CodexCompositionLive` 字段，纯默认值（null/false/0/'new'）在创建时给出，`gateway` 与 `memoryWorker` 由 `base` 在原位置构造。原闭包里的两处前向引用改为显式晚绑定钩子：`deliverRecoveredCloseout`（由 lifecycle 绑定，engine-terminal 调用）与 `closeCandidate`（由 closeout-dispatch 绑定，candidate-closeout 重收恢复候选时调用）；未绑定即调用会抛 `codex_composition_unbound:<name>`。
- 语句顺序：除 `new CodexProductRunPreparer()`（无构造逻辑、无状态）提前到 `base` 外，所有有构造副作用的语句保持原相对顺序。
- 测试可单独调用的命名部分：`createPreparedReservationRelease`、`createActionSurfaceInvalidationPublisher`（`base.ts`）与 `refreshDriftedPristineFreshStartHeads`（`runtime-start.ts`，启动时的纯净 head 刷新循环）。harness 现按生产顺序直接调用 `composition/` 工厂，调用方提供的同名依赖（组合部分、base 值或 live 字段）替换生产部分；pristine 刷新测试改为调用命名函数，不再从源码求值。

### 测试与门禁的随迁

- 断言改动只有一处：`codex-runtime-host-boundary.test.ts` 的存储所有权检查。原先只允许门面写 Codex 表、只允许门面引用内部工具绑定仓库；现在“仓库”= 门面 + `binding-repository/`，检查含义不变。
- 退役符号检查（`verbatim-relay`、`orchestrator-persona-resolver`、`codex-live-graph-contract`、`single-ready-agent-memory-retirement-contract`、`scripts/check-codex-auto-narration-retired.cjs`）扩到拆出的模块；`codex-product-run-preparer` 的已审源码断言指向 `composition/ingress-prepare.ts`；`rss-analysis-report` 的方法执行测试指向 `composition/runtime-start.ts`；付费 E3 真实网关证明的候选集合纳入 `binding-repository/`。
- ESLint 基线：两条 `a1-gate` 源码断言条目仅按新上下文重算哈希；新增边界测试的源码读取带 `allow-source-grep` 理由。五处 `no-legacy-backdoor` 命中（`thread_materialization_kind === 'legacy'` 等数据枚举判断）在 HEAD 已存在且不在基线，本轮原样随迁到新路径；`check-eslint-baseline` 的其余差异与 HEAD 相同，未新增。
- `codex-runtime-module-boundaries.test.ts` 已接入 `verify:codex-runtime-e1`：仓库层级/无 this/无 class/行数、门面只委托、公开面快照，以及组合模块不在运行时互相导入（只允许 `./support`）、不在 live 之外保留可变状态、行数上限。

### 验证（2026-10-08）

- `npm run typecheck` 通过；`npm run build` 通过（含 native 重编与 electron-vite 打包）。
- `npm run test`：6769 + 139 + 39 + 38 通过，0 失败（并行套件的 597 个跳过是普通 Node 下的 SQLite ABI 跳过，由 `verify:native` 覆盖）。
- 逐段独立运行 `verify:codex-runtime-e6`、`verify:codex-turn-delivery`、`verify:codex-input-continuity`、`verify:history-continuation`、`verify:codex-runtime-compaction`、`verify:native`（195 通过）、`verify:codex-workbench-surface`、`verify:widget-ready`、`verify:single-ready-memory`、`verify:codex-runtime-protocol/tool-surface/response-surface/child-env/phase-status`、`verify:stability` 共 56 段，含真实二进制 e2e。唯一失败段 `check-sqlite-test-skip-pattern` 指向上一轮（0.160.1 采用与手动压缩）新增的三个测试：它们只用注入替身或纯函数、从不打开数据库，已按脚本规则登记 `c4Exempt` 并写明理由，复跑通过。
- 直接构造完整组合并走真实 SQLite 收尾路径的原生测试（`codex-browser-verifier-closeout-native`、`codex-undelivered-closeout-native`、`codex-user-stop-closeout-native`）与使用 harness 的四个测试文件（108 例）全部通过。
- 生成管线可重放：codemod、`prepareIngress` 拆出、base 子工厂、启动刷新命名、依赖/导入清理与空行整理逐步脚本化；最后一轮整理与已测代码只差空行（`diff -B` 无差异）。
- 安装态续接证明（`npm run build:dist` 新打包的 DMG，源数据与 codex-home 只读复制、隔离假模型服务）：真实 sidecar 启动、第 1–3 轮续聊、三次重启与边界检查全部通过，停在与拆分前相同的 F01 首轮失败场景（该夹具自 2026-10-05 起与现状不符，非本轮引入）；原 codex-home 哈希前后一致。
- 2026-10-09 更正：F01/F02 改为注入网关会重试、但未经探针确认可保留历史的 HTTP 599（500 等已探明的零输出失败现在保留原线程，由 `codex-failed-turn-continuity.e2e.ts` 覆盖）；F01 改在关闭全部标签页的 Browser 模式下发送，因为 Document 模式总会带上聚焦文档（至少是空白“新文档”），尾部只能是“需重附资源”。重新打包后安装版续接证明首次全程通过（含 F01、F02 三轮与重启），原 Codex home 摘要前后一致。
