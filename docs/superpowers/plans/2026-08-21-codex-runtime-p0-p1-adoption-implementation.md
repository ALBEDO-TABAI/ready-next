---
title: Ready Codex Runtime P0-P1 采用实施计划
date: 2026-08-21
status: implemented
review_status: passed
reviewed_at: 2026-08-21
implemented_at: 2026-08-21
enforce: true
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-08-15-ready-semantic-capability-selection-and-browser-workflow-implementation.md
  - docs/superpowers/audits/2026-08-15-codex-deferred-capability-p0.md
note: >
  本计划只覆盖官方 Codex runtime 0.149.0 升级、deferred dynamic tools 的重新裁决、
  app-server 只读诊断，以及 goal / paginated history 的采用边界。
  不增加第二套模型循环、任务状态、权限、历史或恢复系统；没有证据通过的能力保持关闭。
---

# Ready Codex Runtime P0-P1 采用实施计划

## 0. 文档定位与完成标准

本文的实施合同已于 2026-08-21 完成。实际身份、协议裁决、验证、包体和安装版证据见 [0.149.0 采用审计](../audits/2026-08-21-codex-runtime-0.149.0-adoption.md)。

### 0.1 已冻结假设

1. 目标版本固定为 OpenAI 官方 `rust-v0.149.0`，不在施工中自动追逐更新版本。若开工时决定改用更高版本，必须先重做协议差异和本计划裁决。
2. Ready 继续使用 Codex app-server。官方把它定位为产品内深度集成入口，适合会话、审批和流式事件；本计划不改回 SDK 或私有 fork。
3. 当前交付目标是 macOS arm64。Intel、Windows、远程 WebSocket 和远程 Code Mode 不随本计划扩入。
4. 真实 Provider A/B 会产生费用，只有在执行当下取得明确授权后才运行。提交状态未知时只读回，不盲目重试。
5. 当前工作树包含其他在途改动。施工必须限定到本文责任面，单独记录基线并做范围化提交，不整理或覆盖无关文件。

### 0.2 实现完成标准

本轮已按以下结果收口：

1. 官方 0.149.0 资产、源码身份、签名、许可、二进制和生成 schema 全部重新锁定并读回一致。
2. Ready 当前直答、多轮、工具、停止、恢复、压缩和统一收口行为在新 runtime 上没有回归。
3. deferred 最终只能是两种状态之一：完整实证后启用，或保持关闭并留下明确审计；不得停在半接线状态。
4. runtime 诊断只进入现有诊断包，按需读取，不改变任务、重试、计费或完成状态。
5. goal 与 paginated history 继续保持关闭，且没有为它们留下兼容层或隐藏入口。
6. 安装版通过隔离资料目录验收，包内 runtime 版本、大小和 SHA 与 manifest 一致。

## 1. 结论先行

| 优先级 | 内容 | 本计划裁决 | 最终产品状态 |
|---|---|---|---|
| P0 | 官方 runtime `0.146.1 → 0.149.0` | 实施 | 先独立升级，暂不开新能力 |
| P0 | 现有生产主链兼容 | 实施 | 所有既有行为恢复后才继续 |
| P0 | deferred / namespace / 原生 `tool_search` | 条件实施 | 真机完整通过才单路启用，否则继续关闭 |
| P1 | `server/diagnostics` | 实施 | 只在导出诊断包时读取一次 |
| P1 | 原生 thread goal | 不实施 | `features.goals=false`，通知继续 opt-out |
| P1 | `historyMode:"paginated"` 与分页恢复 | 不实施 | 继续使用 legacy history 与现有恢复链 |

这里的“不实施”不是漏项，而是基于当前官方行为和 Ready 权威边界作出的完成结论。

## 2. 已确认事实

### 2.1 官方事实

1. [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)明确把 app-server 定位为产品内深度集成接口；实验 API 必须由客户端显式声明 `capabilities.experimentalApi`。
2. [OpenAI 官方 0.149.0 release](https://github.com/openai/codex/releases/tag/rust-v0.149.0)已发布。它是本计划的固定目标，不把“GitHub 页面存在”当作包体身份完成，仍需核对官方 arm64 资产、完整 commit、SHA、签名、许可和生成 schema。
3. `dynamicTools` 是实验 API；工具定义随 thread 保存并可在 resume 时恢复。deferred 工具必须依赖官方 namespace 与 hosted `tool_search` 链，Ready 不应自行实现一个关键词工具搜索器。
4. [0.149.0 app-server source](https://github.com/openai/codex/tree/rust-v0.149.0/codex-rs/app-server)提供实验性的 `server/diagnostics`，返回进程 id、内存数据和数值 gauges；它是进程观测，不是任务状态。
5. thread goal 不只是 CRUD 元数据。[0.149.0 goal runtime source](https://github.com/openai/codex/tree/rust-v0.149.0/codex-rs/ext/goal)会在 thread 空闲时主动发起非用户 continuation turn。
6. paginated history 的官方资料存在冲突：当天在线文档明确说新 thread 创建返回 `-32601`，完整读取、turn 分页和 resume fail closed；0.149.0 tagged source 已包含相关路径。源码存在不等于目标 release 在 Ready 条件下可用，因此本计划把它定为 unverified / closed。
7. `thread/turns/list`、`thread/items/list` 即使出现在实验协议中，也不改变上一条产品裁决。

### 2.2 Ready 当前事实

1. `assets/codex-runtime/source-lock.json` 与 `runtime-manifest.json` 已锁定 `rust-v0.149.0`，同时绑定官方资产、二进制、签名、许可和 stable / experimental schema。
2. `scripts/codex-runtime/prepare-pinned-runtime.cjs` 是本地准备 runtime 的唯一入口；不允许启动时下载、PATH 搜索或未锁版本替代。
3. 当前生产主链是：

   ```text
   用户准入
     → CodexHostOrchestrator
     → Ready product composition
     → ReadyCodexLifecycleAdapter
     → pinned app-server
     → canonical closeout transaction
     → Renderer projection
   ```

4. `resolveReadyToolTurnSnapshot` 在联网前冻结本轮工具面和 allow-set；模型可见工具与 dispatch authorization 必须来自同一份快照。
5. `additionalContext` 只承载不可变薄引用；每次 `turn/start` 必须继续精确发送 `environments: []`。
6. deferred 源码裁决仍是 `READY_CAPABILITY_DEFERRED_LOADING_SUPPORTED = false`。本轮因没有执行当下的付费授权，证据状态保留 `BLOCKED`，产品状态保持 `disabled`。
7. 当前网关只接受扁平 function tools，工具桥拒绝非空 namespace。仅升级 binary 不会自动让 deferred 成立。
8. 当前 app-server 客户端只公开生产需要的窄方法面；未知 notification 必须显式分类，不能加一个通用忽略桶。
9. Ready 已有 runtime 状态与诊断包出口。新诊断应复用该出口，不新增页面、后台轮询、数据库表或健康状态机。
10. Ready 的任务投影、动作回执、Provider usage、恢复和 canonical closeout 已各有唯一权威。Codex status、goal、history 或 diagnostics 都不得成为第二套产品真值。

## 3. 单一目标架构

升级后仍只保留一条生产路径：

```text
Ready 冻结资源 / 权限 / 工具
          │
          ▼
官方 pinned app-server ──→ Ready Provider gateway
          │                       │
          │ dynamic call          │ 模型流
          ▼                       ▼
Ready tool bridge ─────────→ lifecycle adapter ─→ canonical closeout

server/diagnostics ──按需读取──→ 现有诊断包
                     （只读旁路，不连入任务状态）
```

### 3.1 不可改变的权威边界

1. **Ready 拥有产品语义**：用户准入、资源、技能、工具授权、动作确认、预算、产物、任务投影和最终消息。
2. **Codex 拥有原生执行**：thread、turn、模型循环、流式事件和官方协议内的工具调用传输。
3. **终态只有一个入口**：只有 lifecycle adapter 与 canonical closeout 可以结算 Ready run；status、diagnostics、goal 或分页结果都不能结束任务。
4. **授权每轮重新冻结**：resume 恢复官方 dynamic tool 定义，不等于恢复 Ready 当前轮授权；dispatch 时仍必须核对当前 allow-set。
5. **runtime 漂移先结旧账再换 thread**：仍有 fence 或 unresolved turn 的旧 binding 先按原身份精确对账；结算后，新的用户 turn 沿 alias generation 规则创建新原生 thread，不跨 runtime 继续旧 thread。

### 3.2 机器合同

| 编号 | 合同 |
|---|---|
| C1 | 启动前校验 release tag、完整 commit、平台、架构、archive SHA、binary SHA、大小、签名、许可和四份 schema digest |
| C2 | 所有 0.146.1 → 0.149.0 协议差异均被分类；未知通知继续 fail closed |
| C3 | `resolveReadyToolTurnSnapshot` 仍同时驱动模型可见面与 dispatch allow-set，native thread 不可扩权 |
| C4 | 只有 `turn/completed` 加 Ready closeout 证据可结算；status 与 diagnostics 永不参与终态判断 |
| C5 | deferred 未完整 PASS 时常量保持 false；PASS 后只保留官方单一路径，不保留 eager/deferred 产品开关 |
| C6 | diagnostics 只在明确导出诊断包时请求一次；失败只标记 unavailable，不阻断会话或诊断包导出 |
| C7 | `features.goals=false` 且 goal notifications 继续 opt-out |
| C8 | thread 继续使用 legacy history；不发送 `historyMode:"paginated"`，不接分页 resume |

## 4. 实施阶段

P0-1 → P0-2 必须顺序执行。P0-2 通过后，deferred 裁决与只读 diagnostics 可独立推进；不能用任一新能力掩盖升级回归。

### P0-1：纯 runtime 升级

**目标**

把官方 0.149.0 变成可复现、可核验的 Ready pinned runtime，不改变任何产品能力开关。

**允许改动**

- 官方 source lock、runtime manifest、LICENSE / NOTICE、stable / experimental schema、native captures 与真实受影响的 runtime 合同。
- 只为 0.149.0 真实协议差异调整 client normalizer、通知分类和版本身份测试。
- 新建一份 0.149.0 升级审计；历史 0.146.1 审计不改写。

**机器合同**

1. 替换资产前，在预定实现基线上跑通 0.146.1 身份与主链门；已有失败必须先定责，不能归因给升级。
2. 只从官方 release 资产准备 binary，生成后精确读回 `codex-cli 0.149.0`。
3. stable / experimental schema 与 active native captures 必须由该 binary 重新生成或实采，不手改版本字串；capture 校验必须读回 `rust-v0.149.0`。
4. 协议 census 明确记录新增、删除和形状变化；每个新 notification 归入 projected、passive、rerouted 或 named opt-out。
5. `features.goals`、deferred 常量和 legacy history 保持原值。

**验证**

- `npm run verify:codex-runtime-source`
- `npm run verify:codex-runtime-e2`
- 版本、schema 与通知 census 的针对性测试

**退出条件**

- PASS：身份与协议合同全部一致，进入 P0-2。
- FAIL / UNKNOWN：不升级产品，恢复已验证的 0.146.1；不加版本 fallback 或 runtime 切换开关。

### P0-2：现有生产主链兼容验收

**目标**

证明新 runtime 没有改变 Ready 当前生产行为。

**允许改动**

只修 0.149.0 实际造成的 client、gateway、lifecycle 或恢复边界漂移；不得顺手启用 deferred、goal、分页、queue、project、section 或 plugin。

**机器合同**

1. root thread 身份、`instructionSources`、现有 sandbox / approval isolation、`additionalContext` digest 与 `environments: []` 继续精确核对。
2. start / resume 使用同一有效 sidecar session、connection epoch、client 和 abort identity。
3. 未知提交不盲重放；旧 run 不覆盖新 run；用户停止仍精确绑定当前 thread / turn。
4. 手动和自动 compaction 继续走现有合同，不因新历史 API 改路。

**验证**

- `npm run verify:codex-runtime-e3`
- `npm run verify:codex-runtime-e4`
- `npm run verify:codex-runtime-e6`
- 在 0.149.0 capture 已重采并读回身份后运行 `npm run verify:codex-runtime-compaction`
- `npm run verify:stability`
- `npm run verify:streaming`
- `npm run typecheck`

**退出条件**

现有主链全部通过后才能进入 deferred 实验；任何终态、授权或恢复回归都阻断升级。

### P0-3：deferred / namespace 同条件裁决

**目标**

在已独立通过的 0.149.0 上，回答一个问题：官方 search → load → call 能否在 Ready 真实网关和授权链中完整成立。

**先做一次性探针**

1. 为 Ready 的目标模型提供锁定且可审计的 model metadata，明确证明 `supports_search_tool`，不依赖未知模型 fallback。
2. 网关探针只接受官方 hosted `tool_search` 与 namespace 的精确形状，不放宽为任意 tool 类型。
3. 全局启用前同时证明 Ready 现有 Responses 与 `chat/completions` wire path 不回归；任一路径无法承载时全局保持 false，不增加 Provider 分支。
4. 付费前冻结同一组 eager / deferred 任务、至少三对运行和现有超时预算，记录：初始工具定义数量与字节、实际请求数、总完成时间、搜索回合时间、工具选择和任务结果。
5. 净收益硬门是：总工具定义字节下降、成功任务数不下降、错误工具调用为零；非 deferred 任务不增加请求且中位完成时间不慢于 eager；deferred 任务最多增加一次原生搜索，其“deferred 总时长减 eager 总时长”的中位数不得超过搜索回合自身中位时长。任一不满足都保持 false。
6. 必须逐段拿到 start accepted、search result、namespace、目标 tool call、Ready bridge 回执和最终结果；缺任一段都不是 PASS。
7. start 或 Provider 提交结果未知时先读回，不重复付费提交。

**功能硬门**

1. direct capability floor 始终可见，deferred 组初始不进入普通工具表。
2. 搜索结果只要求来自该 thread 已登记的 Ready catalog；搜索可见不代表本轮执行授权，不为逐轮过滤另建系统。
3. search → load → call 在 start 与 resume 后都完成，调用身份完整到达 Ready bridge。
4. 上轮已加载、本轮撤权的工具必须在 dispatch 被拒绝；历史加载不能扩权。
5. 当前 `ReadyToolTurnSnapshot` 是唯一执行硬门；未知 namespace、未知工具和本轮未授权工具互斥失败。

**裁决**

产品状态只有 enabled / disabled；探针证据单独保留 PASS / FAIL / BLOCKED / UNKNOWN。

- **FAIL / BLOCKED / UNKNOWN**：产品状态都保持 disabled；证据结论按原值记录，UNKNOWN 不得改写成 FAIL。删除一次性探针后结束本切片，不写关键词 fallback、不造 Ready 版 tool search。
- **PASS**：再进入产品接线，只做四件事：给现有 capability group 分配官方 namespace；让 gateway 接受精确 hosted search / namespace；让 bridge 接受目录内 namespace 并继续核对当前 allow-set；一次性翻转源码常量。不得保留双实现或用户设置开关。

**产品接线验证**

- `npm run verify:codex-capability-selection`
- `npm run verify:codex-workbench-surface`
- `npm run verify:codex-tool-bridge`
- 真实 Provider A/B 与安装包复测

### P1-1：按需 runtime 诊断

**目标**

在用户导出 Ready 诊断包时，额外保存一次 app-server 进程快照，帮助判断 sidecar 自身是否异常。

**唯一产品落点**

1. 在现有 app-server client / native runtime 增加严格的 `server/diagnostics` 只读方法。
2. 唯一所有权链是：`CodexRuntimeComposition` 只读快照 → `AgentControlRuntime` 的只读 getter → `setupAppCacheIPC` 注入 callback → diagnostic core 只负责序列化。不得跨层直连或创建第二个 app-server client。
3. Main 在导出既有诊断包时请求一次，并写入 `state/codex-runtime.json`；runtime 未启动时直接写 `unavailable`，不得为了出包启动、恢复或替换 sidecar。
4. 文件只包含：可用状态、runtime 版本与 binary SHA、connection epoch、process id、resident memory、macOS physical footprint 和原样数值 gauges。
5. 不新增 Renderer 页面、Preload 方法、后台 poll、数据库表、告警器或自动恢复动作。

**机器合同**

1. diagnostics 响应不含用户消息、prompt、工具参数或密钥。
2. gauge 不假设固定顺序或必然存在；只保存服务端当次返回的名称与数值。
3. 方法不存在、sidecar 未运行或读取失败时，诊断包记录 `unavailable` 并照常导出。
4. diagnostics 永不改变 heartbeat、run、projection、Provider usage、retry 或 closeout。

**验证**

- client enabled / unsupported / failed 三个可观察结果
- 真实 0.149.0 sidecar 返回 process 与 memory 数据
- 导出包解压读回 `state/codex-runtime.json`
- 断言请求前后 active run、任务投影和最终消息不变

### P1-2 / P1-3：goal 与 paginated history 明确不接入

| 内容 | 当前裁决依据 | 本计划硬门 | 未来重评条件 |
|---|---|---|---|
| thread goal | 0.149.0 会在 idle 时主动发起非用户 continuation turn，绕过 Ready 的用户准入、冻结授权和 closeout | 保持 `features.goals=false`；goal notifications named opt-out；不加 CRUD、镜像、数据库、UI 或同步桥 | 官方把 metadata 与自动续跑分离，或 Ready 另立完整 non-user successor 合同 |
| paginated history | 在线文档称创建与 resume fail closed，tagged source 却已有路径；官方材料未收敛，Ready 恢复仍依赖完整 read → resume | 保持 legacy；不发送 paginated；不加 list/items 产品方法、双读、缓存或 fallback | 官方文档与目标 binary 同时支持创建、完整分页、resume 和单 writer 语义，且黑盒探针通过 |

复用现有 host、notification、client 与 compaction 合同测试证明这两项没有被 0.149.0 升级意外打开。它们不是本计划遗留的开发项。

### P1-4：统一包体与安装版验收

**目标**

把源码通过、真实 sidecar 通过、包体正确和安装版可用分成四份证据。

**验证顺序**

1. 完成受影响专项门后运行 `npm run verify:codex-runtime-experiment`、`npm run verify:native`、`npm run build`。
2. 只认 `npm run verify:release-structural` 生成并提升的 DMG，再用 `npm run verify:release-structural-receipt` 读回；不先另跑 `pack:clean` 生成第二个候选包。
3. receipt 必须绑定被安装 DMG 的 SHA；从最终包体重新读取 runtime 版本、字节数、SHA、签名和 manifest，禁止拿 build 目录替代包内文件。
4. 在隔离 userData 下安装并运行，证明实际进程来自安装目标而非 mounted / build app，再次读回安装后 runtime 身份；最后确认应用退出后 sidecar 进程树归零。

## 5. 文件责任边界

只列确定的权威入口；具体测试文件按真实行为落在现有相邻测试中，不提前铺开目录。

| 责任 | 权威入口 | 改动边界 |
|---|---|---|
| runtime 身份 | `assets/codex-runtime/source-lock.json`、`runtime-manifest.json`、schemas、LICENSE / NOTICE | 只记录官方 0.149.0 真实值 |
| runtime 实证 | active protocol captures、capture scripts、`check-native-evidence.cjs` | 用 0.149.0 实采并读回身份，不改写历史审计 |
| runtime 准备与校验 | `scripts/codex-runtime/prepare-pinned-runtime.cjs`、`check-source.cjs` | 复用现有入口；除非 0.149.0 真实格式变化，否则不改 |
| app-server 协议 | `codex-native-runtime.ts`、`codex-app-server-client.ts` | 版本漂移与 diagnostics；deferred 仅 PASS 后接线 |
| Provider 工具合同 | `codex-model-gateway-contract.ts` 与现有 Responses / chat wire tests | 只在 deferred PASS 后加入精确 hosted search / namespace 形状 |
| 工具编译与授权 | `codex-tool-surface.ts`、`codex-capability-catalog.ts`、`codex-tool-bridge.ts` | 继续使用现有目录与本轮 allow-set，不建第二份 catalog |
| 产品生命周期 | `ready-codex-lifecycle-adapter.ts`、`codex-runtime-production-composition.ts` | 原则上不改；若升级暴露真实漂移，只修单一主链 |
| 诊断包 | `CodexRuntimeComposition`、`AgentControlRuntime`、`diagnostic-pack-core.ts` 与既有导出 handler | 只读 callback 注入，不新增 UI / IPC 面 |
| 权威文档 | `docs/architecture/current-runtime-contracts.md` 与新 0.149.0 审计 | 实现后只更新受影响条目，不改写历史审计 |

任何文件只因顺手清理、格式化、重命名或“以后可能用到”而变化，都不属于本计划。

## 6. 验收场景矩阵

| 场景 | 必须看到的结果 | 证据层 |
|---|---|---|
| 冷启动 | 包内 0.149.0 身份通过，sidecar 单实例可用 | 包体 + 安装版 |
| 普通直答 | 流式正文完整，只产生一个最终消息 | 真实 sidecar + 安装版 |
| 连续多轮 | 同一有效 thread 恢复，资源与权限按新轮重新冻结 | 真实 sidecar |
| 只读工具 | 模型可见名、dispatch 名和回执身份一致 | gateway + bridge |
| 写操作 | 仍先确认，执行后持有真实读回；拒绝时零副作用 | 安装版 |
| 用户停止 | 精确 interrupt 当前 turn，最终只收口一次 | lifecycle |
| sidecar 异常 | 未知 start / crash 先对账，不盲重放 | recovery e2e |
| 压缩 | 手动和自动 compaction 后仍保留当前工具与资源合同 | compaction e2e |
| deferred | 初始隐藏、搜索命中、调用成功、跨轮撤权仍拒绝 | 一次性 A/B + 安装版 |
| diagnostics | 导出包含一次新鲜快照；读取失败也能正常出包 | 解压读回 |
| goal | 没有自动非用户 turn，没有 goal 工具或通知进入产品状态 | host + protocol test |
| history | 仍为 legacy；没有分页创建、双读或恢复旁路 | client contract |
| 退出 | Ready 关闭后隔离 sidecar 进程树归零 | 安装版 |

deferred 证据只要不是 PASS，矩阵中的启用场景就替换为“产品保持 disabled 且普通 eager 工具行为正常”，不把 FAIL / BLOCKED / UNKNOWN 改写成功能通过。

## 7. 停止、回滚与交付

### 7.1 硬停止条件

出现任一情况立即停在当前阶段：

1. 官方资产、签名、完整 commit、SHA、许可或 schema 无法相互证明。
2. 0.149.0 使现有终态、授权、恢复、compaction 或安装版行为回归。
3. deferred 任一段只有推测、mock 或提交未知，没有完整 Provider 与 Ready 回执。
4. diagnostics 需要新状态机、后台轮询或会影响任务行为才能工作。
5. 为 goal 或 pagination 必须新建第二套任务、历史、恢复或兼容层。

### 7.2 回滚方式

1. runtime 升级未通过时，回退该独立升级提交并继续使用已验证的 0.146.1；不增加运行时版本开关。
2. deferred 未通过时只保留 false 裁决；若产品接线后安装版失败，回退 deferred 接线提交，不用补丁维持双路径。
3. diagnostics 失败只回退诊断切片，不影响已经通过的 runtime 升级。
4. runtime 变化时先保留旧 binding 完成 unresolved turn / fence 的精确对账；结算后新用户 turn 才沿 alias generation 建立新 thread。

## 8. 明确不做

- 不替换 App Server，不维护 OpenAI/Codex 私有 fork。
- 不扩入本轮 P0-P1 之外的协议能力、平台、远程执行、account usage 或成本展示。
- 不新增 runtime 下载器、PATH fallback、版本开关或旧协议兼容分支。
- 不开发 Ready 自己的 `tool_search`、关键词 router、第二个 catalog、goal 镜像、分页历史服务或后台健康系统。
- 不增加设置开关、状态卡、新诊断页面或 Provider 分支。
- 不重写 Provider usage、compaction、recovery、task projection 或 canonical closeout。
- 不改写历史审计，不把 0.149.0 证据倒填进 0.146.1 记录。
- 不用源码测试、schema 字段或模拟响应冒充真实 Provider、包体或安装版证据。

## 9. 开发收口清单

- [x] P0-1 官方身份与 schema 锁定通过。
- [x] P0-2 当前生产主链完整通过。
- [x] P0-3 deferred 证据状态如实保留，产品状态只有 enabled / disabled，无半接线和 fallback。
- [x] P1-1 诊断只进入既有诊断包且读回成功。
- [x] P1-2 goal 保持关闭，无自动、非用户发起的 continuation 入口。
- [x] P1-3 history 保持 legacy，无分页恢复旁路。
- [x] 专项门、runtime 全门、native、build 与 release structural 全部通过。
- [x] 净增代码的文件已复核总行数；超过 1000 行时按项目规则更新 large-file health log。
- [x] 最终包内 runtime 身份重新读回一致。
- [x] 隔离安装版完成冷启动、工作台、runtime 身份与退出验收，退出后 sidecar 进程树归零；需付费 Provider 的场景未在无授权时执行。
- [x] 只改本文责任范围；其他工作树改动原样保留。
