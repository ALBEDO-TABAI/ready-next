# Codex runtime 0.160.1 采用与已有对话续接

## 目标与范围

把 Ready 唯一固定的 Codex runtime 从 `0.149.0` 升到官方正式版 `rust-v0.160.1`（2026-10-05；`0.161`、`0.162` 仍为 alpha），并且**已有对话在升级后照常续接**：普通续轮、从已接受前缀分叉、带尾部重建和手动压缩都要有经实测的跨版本证据。不保留 0.149 的兼容分支；Windows 仍不在 Codex 支持范围。

## 已验证事实（2026-10-07）

### 发布身份

| 项目 | 值 |
|---|---|
| release / tag object / commit | `rust-v0.160.1` / `c3e23d4c4385619ecec78408766e46b7fa7dd9ad` / `d27764b82f7118f674371e6d6e76271d9d606edb` |
| asset | `codex-aarch64-apple-darwin.tar.gz`，95904314 bytes，SHA-256 `670af2b049d9c95afb74d7da385f30c5033d13a07175001dd8958c51944984d0`（与 GitHub 公布摘要一致） |
| binary | `codex-aarch64-apple-darwin`，241556032 bytes，SHA-256 `09fa44fdc37a5fc70dc1ace31235f90468a2e193d0e85f7552eab068ea2582be`，`codex-cli 0.160.1` |
| 签名 | `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)` |

ChatGPT 桌面应用自带的 0.160.1 是另一份打包，摘要不同；Ready 仍按 source lock 只认官方 release asset。

### 协议差异（stable v2，由 0.160.1 生成）

- client request 95 → 104：新增 `account/gatewayOAuth/{login,read,cancel}`、`plugin/reconcile`、`thread/attachment/{add,list,remove}`、`thread/items/list`、`thread/revert`、`thread/turns/list`；**删除 `thread/rollback`**（Ready 未使用）。
- server notification 75 → 83：新增 `account/gatewayOAuth/changed`、`mcpServer/event/stream/notification`、`modelProvider/authRecovery{Started,Completed}`、`thread/attachment/updated`、`thread/realtime/item/{started,completed,transcript/delta}`；无删除。server request 不变。
- 结构多为加法：`Thread` 增 `historyMode`、`model`、`originator`、`reasoningEffort`；`ThreadItem` 增 `functionCallOutput` 变体、userMessage 增 `questions`；`ThreadResumeParams`/`ThreadForkParams` 增 `excludeTurns`；`TurnStartParams` 增 `disabledPluginIds`、`serviceTierForTurn`、`toolOutput`；image 输入可用 `fileId`；`TurnError` 增 `misalignment`；`CodexErrorInfo` 增 `rateLimitExceeded`、`flexUnavailable`、`tooManyDenials`；initialize capabilities 增 `explicitGatewayOauth`。

### 运行行为（真实二进制，隔离夹具或用户数据只读副本）

- 网关元数据：普通请求与手动压缩都带 `root_turn_id`；内层新增 `window_number`（整数，`window_id = <session_id>:<window_number>`）、`context_window_id`（压缩后更换）、`analytics_enabled`（Ready 关闭统计，恒为 `false`）、普通请求另带 `model`（`ready-e0-model`）。现行网关的精确键集合会拒绝 0.160.1 的全部请求。
- 回合内自动压缩签名、压缩后丢弃本轮 Ready 上下文、未加载线程压缩返回 `thread not found`、恢复/分叉已压缩线程丢失 developer 指令、紧接压缩的独立压缩无 developer 消息：与 0.149 相同，2026-10-06/07 两份合同仍然必要。压缩后的回读保留此前的工具调用项（0.149 会丢失）。
- Ready 现行 `config.toml` 在 `--strict-config` 下通过；旧线程可读（`historyMode=legacy`）。新线程默认 `historyMode=paginated`，`thread/read` 仍返回全部回合（150 回合实测），恢复/分叉不受影响。
- 手动压缩的实时通知与持久回读使用同一个 `contextCompaction` 条目 id（0.149 两者不同）；Ready 两列分别记录，旧行仍有效。
- 用户输入回读形态由 thread 的 `historyMode` 决定（创建时确定）：0.160.1 新建线程为 `paginated`，逐项、同序回读（skill/mention 各自成项）；此前创建的线程及从它分叉的线程为 `legacy`，0.160.1 下的新回合仍按拼接文字、不回显 skill/mention 回读（安装版验收与隔离副本实测）。
- 未变化的 additionalContext 键值仍被省略，超过 1000 token 的值仍从中间截断（`…500 tokens truncated…`），3800 字节以内原样送达：与 0.149 相同（2026-10-07 隔离夹具实测）。
- `codex unarchive` 对未归档线程报错退出（0.149 静默成功）；续接探针只对状态库中已归档的线程执行。
- 0.160.1 打开 Codex home 时把 `state_5.sqlite` 的迁移从 50 推进到 58（新增 `thread_attachments` 等）；0.149 仍能打开迁移后的 home 并读取线程，底层数据不因回退损坏。
- **基础指令变化**：0.160.1 的原生基础指令为 16979 字（0.146.1 与 0.149.0 均为 20751 字）。恢复一个 0.149 创建的线程后，请求携带的是**新**基础指令，线程历史中的 Ready developer 指令保持不变（用户数据副本实测，原 rollout 摘要前后一致）。用户库全部 7 个 runtime 清单下的线程都记录同一指令合同 `eb75d36a…`；此前升级从未改变基础指令。

## 合同

1. **固定身份**：`source-lock.json`、`contracts/runtime-contracts.json` 的 `pinnedCodexVersion`、四份 schema、两份 native capture 全部由 0.160.1 官方二进制重新生成或实采；`runtime-manifest.json` 只由 `generate-e0-artifacts.cjs` 生成；`check-native-evidence.cjs` 的 release tag 改为 `rust-v0.160.1`。开发二进制只经 `prepare-pinned-runtime.cjs` 落地，且改为原子替换，不就地覆盖可能正在运行的文件。
2. **网关元数据**：只接受 0.160.1 的精确形状。普通、自动压缩、手动压缩请求都必须有一致的 `root_turn_id`；`window_number` 为非负安全整数且 `window_id`（内外层一致）等于 `<session_id>:<window_number>`；`context_window_id` 非空；`analytics_enabled` 必须为 `false`；普通请求的 `model` 必须等于绑定的 Codex 模型，压缩请求不得带 `model`。不保留 0.149 的可选分支。
3. **协议面**：8 个新通知逐个具名归类（Ready 不消费的进 opt-out）；`thread/rollback` 不在 Ready 的出站方法中；新 `CodexErrorInfo` 显式归类（`rateLimitExceeded` 与现有限流同等、`flexUnavailable` 与 `tooManyDenials` 为非瞬时失败）；新线程/条目字段与 `functionCallOutput` 变体按窄解析器规则处理，不因未知可选字段拒收，也不把新变体当成产品项。
4. **有效指令合同**：线程记录中的 `instruction_contract_digest` 是不可变的血统合同。线程在当前 runtime 下的有效合同按以下规则推导，网关、续轮判定、分叉/带尾部重建继承核对、恢复与压缩的指令复原一律使用有效合同：
   - 血统合同等于当前 runtime 与当前 Ready 指令计算出的合同 → 即为有效合同；
   - 否则，若续接目录中“线程创建清单 → 当前清单”的 `ordinary_continuation` 边以实测证据声明 `instructionContract: { source: <血统合同>, target: <当前合同> }` → 有效合同为当前合同；
   - 否则有效合同就是血统合同（与当前合同不符，按 `instruction_contract_changed` 走现有的新上下文路径）。
   同一 runtime 对的所有边若声明映射必须一致；映射的目标必须等于当前合同，否则仓库构造即以 `runtime_continuity_instruction_contract_stale` 失败（随后改动 Ready 指令必须重新实测），CI 另行断言已签入证据的目标等于当前合同。没有数据库结构变更。
5. **续接证据**：对 8b2e1f3f、d47a3b86、f981c518（published）与 cda6bd5f、22816589（observed active）全部来源，用 0.160.1 在用户库与 Codex home 的隔离副本上实测 `ordinary_continuation`、`fork_from_accepted_prefix`、`reseed_uncommitted_tail`、`manual_compaction` 四类操作，产出 `ready_runtime_transition_proof_v1` 证据（探针形式，含目标二进制摘要、版本、隔离副本、本地夹具 provider、先前上下文可见、输入基数、指令合同映射）。22816589 的清单副本加入 `manifests/`；`runtime-sources.json` 保留全部来源分类；不可恢复来源仍不得声明边。探针在副本内改写 rollout 路径并核对没有任何路径指向原 Codex home，运行前后核对原 rollout 摘要不变。
6. **失败续接 seam**：`codex-failed-turn-continuity.e2e.ts` 与 `codex-user-input-readback.e2e.ts` 在 0.160.1 上重跑，签发 v6 探针回执，`codex-terminal-facts.ts` 的回执常量同步更新；四条 seam 任一不成立则不得宣称续接。
7. **文档与验收**：根指引（`CLAUDE.md`、`AGENTS.md` 同步）、`PROGRESS.md`、`PROJECT_OVERVIEW.md`、`DOCUMENTATION.md`、`docs/README.md`、`current-runtime-contracts.md`、`windows-development.md`、assets README、`run-history-continuation-installed-proof.mjs` 的来源表同步到 0.160.1；历史审计与旧回执保持原样。

8. **工具请求形状**：0.160.1 把动态工具 JSON Schema 中的 `minItems` 原样保留在请求 `tools` 里（任意节点；值须为非负整数，否则 `thread/start` 拒绝该工具），0.149 会丢弃它；其余关键字的处理不变（2026-10-07 逐个关键字实测）。用户库全部已存工具面都含 `minItems`，旧线程在 0.160.1 下恢复后发出的请求工具因此与存档的 `toolSurfaceDigest` 不同（隔离副本实测：与存档摘要不符，与按 0.160.1 规则重算一致）。
   - `normalizeCodexDynamicToolSchema` 镜像 0.160.1：保留 `minItems`，非法值在 Ready 构建工具面时即拒绝。
   - 线程冻结的工具面是不可变谱系：`entries`、`dynamicTools`、`toolNames` 与运行时无关，`responsesTools` 是创建时 runtime 对这些动态工具的序列化，`toolSurfaceDigest` 是它的谱系身份，继续用于 turn 元数据、turn 行、授权快照与收尾核对。`assertReadyToolSurface` 要求与运行时无关的部分按当前代码重建完全一致、`responsesTools` 与 `dynamicTools` 逐项同名同描述同类型、两个谱系摘要与所存内容自洽；不再要求旧序列化等于当前规则。
   - 当前 runtime 实际发送的请求工具由冻结的 `dynamicTools` 按当前规则推导（`codexRequestToolsDigest`）。网关绑定新增 `requestToolsDigest`：普通请求取线程冻结工具面的推导值，压缩请求为空数组摘要；网关以它核对请求 `tools`，元数据的 `toolSurfaceDigest` 仍与谱系身份比对。自动压缩证据中后继普通请求的 `toolsDigest` 同样与推导值比对。
   - CI：真实二进制 e2e 用 Ready 的完整生产工具定义启动线程，要求请求 `tools` 与 Ready 推导完全一致；单测覆盖 `minItems` 保留与非法值、旧谱系工具面的读取与推导、网关两类摘要的分工。

不在本轮范围：Windows Codex 支持；0.161/0.162 预发布版；`thread/attachment`、realtime、gateway OAuth 等新功能接入（全部 opt-out）。

## 实施顺序

1. 固定身份（合同 1），`verify:codex-runtime-source` 通过。
2. 重采 native capture 与检查脚本（合同 1），当前指令合同随新夹具变化。
3. 网关元数据、协议面适配（合同 2、3），单测与真实二进制 e2e 回归。
4. 有效指令合同（合同 4）：目录加载、仓库推导、续轮判定、继承核对、组合层复原。
5. 续接探针扩展与证据（合同 5），`verify:history-continuation` 通过。
6. 失败续接回执 v6（合同 6）。
7. 全部门禁、安装版续接验收与文档（合同 7）。

## 验证

- `verify:codex-runtime-source`、`verify:codex-runtime-protocol/tool-surface/response-surface/child-env/compaction`、`verify:codex-runtime-e2/e3/e4/e6`、`verify:codex-input-continuity`、`verify:codex-turn-delivery`、`verify:history-continuation`、`verify:native`、`verify:codex-workbench-surface`、`verify:widget-ready`、typecheck、lint。
- 有效指令合同：单测覆盖“血统=当前”“目录映射”“无映射→新上下文”“映射目标≠当前合同→加载失败”；真实二进制在用户数据副本上证明旧线程在 0.160.1 下经 Ready 网关续轮、分叉、带尾部重建与手动压缩成功。
- 回退：0.149 能打开 0.160.1 迁移后的 Codex home；新清单下创建的线程在旧版 Ready 中按 `runtime_unverified` 走新上下文，不静默续接。

## 验证结果（2026-10-07）

- 续接探针（`scripts/probe-codex-runtime-continuity.mjs`，经 tsx 使用 Ready 生产配置写入器、developer 指令与指令摘要）在用户库只读 `.backup` 副本与 Codex home 隔离副本上，对 5 个来源各跑普通续轮、分叉后续轮、带尾部重建（含重启后第二轮）、重启后恢复并手动压缩再续轮，共 30 个 provider 请求，每个请求的指令摘要都等于当前合同 `fd461475…`；全部来源的谱系合同均为 `eb75d36a…`。运行前后原 Codex home 的 sessions/archived_sessions/state_5 摘要一致。
- 由该输出生成 20 条 transition 与证据（目标清单 `e2ae5b1c…`），新增 `manifests/0.160.1-e2ae5b1c.json` 与目标来源记录；加载器校验证据与映射逐字一致。用户库 15 个活跃已启动对话全部来自已映射来源。
- 应用内当前合同（`resolveCodexThreadInstructionContract`）与探针测得的合同一致；关闭映射的红灯检查使仓库原生用例失败。
- 失败续接回执 v6（`continuation-safe-probe-receipt-v6.json`）签发，`failed_after_completed_rounds_v1.nativeReadbackOmitsDynamicToolCalls=false`。
- `codex-sidecar-crash-recovery.e2e.ts` 与 `codex-sidecar-process-lease.e2e.ts` 自 2026-10-06 起在准入处失败（夹具缺续接候选、仓库未绑定清单与目录），掩盖了其后的真实二进制恢复验证；本轮按生产方式补齐后，中断与自动压缩断言同步到现行 seam 与证据列表，两者在 0.160.1 上全部通过。
- 网关单测与对抗套件的 7 份请求夹具补齐 0.160.1 精确元数据（`window_number`、`context_window_id`、`analytics_enabled=false`、product 的 `model`）；分叉元数据用例按 0.160.1 事实改写（压缩请求不带 `model`、手动压缩保留 `root_turn_id`、每类请求都要求外层 root）。此前 e3 链在 e2 处中止，这些夹具从未在新形状下运行过。
- 手动压缩条目身份断言改为 0.160.1 的同一 id；资源回读原生夹具改为逐项回读。
- 生产侧 `codex-provider-text.ts`（设置里的连接测试、RSS 翻译/简报等模型调用）自己合成一次网关请求，曾仍是 0.149 元数据形状，会被新网关全部拒绝；由 e3 门禁的连接测试发现，已改为 0.160.1 精确形状。去掉修复时 `rss-model-completion` 与 `codex-provider-text-oauth` 20 例中 19 例失败。
- 安装版验收所用的 `live-proof-identities.cjs` 中 `/usr/bin/sqlite3` 固定摘要在 2026-09-19 系统更新后失效（现为 3.54.0，`com.apple.sqlite3`，codesign 校验通过），本轮仅重新固定该项；`/bin/sh` 与 `package-lock.json` 的固定摘要同样已过期，但本验收不使用，留待对应构建验收单独复核。
- `run-history-continuation-installed-proof.mjs` 的来源表与普查按清单逐项（2026-10-07 普查，活跃/已启动：8b2e1f3f 6/6、d47a3b86 5/4、cda6bd5f 1/1、22816589 8/4），已启动对话不得被 runtime、模型、线程配置、目录或指令合同阻断（续接按此顺序检查）；只因冻结的旧版 Ready 工具定义而提供新上下文的对话（0.146 组已知情形）走恢复验证；从未启动的 5 个头在安装版分类后各自必须“可续”或“可恢复”，至少一个走完原始根刷新续轮；副本隔离改为只读打开（无进程打开、因而没有 `-wal` 的 WAL 库以 `immutable` 只读读取）与大小写无关的路径改写。“未结工作”判定只放行一种停住的记录：Codex 已拒绝、旧版又记为 unknown 的手动压缩（用户库中 10-07 02:29 那次失败压缩及其栅栏），安装版首启必须以 `dispatch_rejected` 结算并释放栅栏后才开始分类；其余栅栏或运行仍拒绝复制。
- 工具请求形状（合同 8）：安装版验收第一轮即暴露——0.160.1 新线程首个请求被网关以 `409 gateway_tool_surface_mismatch` 拒绝（rollout 记录），原因是 `minItems`；逐关键字实测只有它变化。用户库副本中恢复的 0.149 线程发出的工具与存档 `toolSurfaceDigest` 不符、与按 0.160.1 规则推导一致，即修复前升级会让全部旧对话的下一轮被拒。修复后：生产工具集真实二进制 e2e 通过（去掉 `minItems` 镜像时它点名 `browser_upload`、`declare_completion_criteria`、`tag_forge_apply_batch` 失败）；续接探针对 5 个来源的普通续轮、分叉与压缩后续轮都核对请求工具等于冻结工具面的推导值，证据据此重新生成。
- 用户输入回读（安装版验收第二处发现）：工具修复后，旧对话 H03 的回合在原生侧成功，但 Ready 收尾以 `formal_input_mapping_unknown` 判定历史不明——该线程是 `legacy`，新回合按拼接文字回读，而此前改为一律逐项比对。改为按 `thread.historyMode` 选择投影（`CodexThread.historyMode`，缺省按 schema 为 legacy）；用户输入回读 e2e 在真实二进制上分别以 `paginated` 与 `legacy`（实验参数 `thread/start.historyMode`）运行；续接探针的普通续轮与分叉续轮改发“当前文字 + 资源文字 + mention”并核对回读，5 个来源的旧线程及其分叉均为 legacy 且一致，证据据此重新生成。
- 安装版续接验收（`verify:history-continuation-installed`，打包 DMG + 用户库与 Codex home 的只读副本 + 本地夹具 provider，原 Codex home 摘要前后一致）最终一次运行：首启分类通过，用户库里 10-07 02:29 卡住的手动压缩在首启以 `dispatch_rejected` 结算并释放栅栏；全部可续的已启动对话完成第 1、2 轮同线程续聊，重启后第 3 轮仍在同线程且带上此前上下文；从未启动的对话刷新后续聊；历史-only 对话与 3 个因旧版 Ready 工具定义而需新上下文的 0.146 对话完成“保留记录，开始新上下文”并在重启后保持；边界后清理检查通过。停在 fresh-root 场景 F01：该场景靠注入首轮 HTTP 500 制造分叉，而自 2026-10-05 起此类零输出失败按 `failed_user_only_no_suffix_v1` 保留原线程（本次由 v6 回执签发），场景本身已过时，与 runtime 升级无关；带尾部重建路径由续接探针在真实 0.160.1 上覆盖。前一次运行在边界首启处曾报 `history_only_recovery_missing`，最终一次通过；验收脚本已补该处的诊断字段（目标、最后一次动作面读取、按钮是否出现）。2026-10-09 更正：F01/F02 改为注入网关会重试、但未经探针确认可保留历史的 HTTP 599（500 等已探明的零输出失败现在保留原线程，由 `codex-failed-turn-continuity.e2e.ts` 覆盖）；F01 改在关闭全部标签页的 Browser 模式下发送，因为 Document 模式总会带上聚焦文档（至少是空白“新文档”），尾部只能是“需重附资源”。重新打包后安装版续接证明首次全程通过（含 F01、F02 三轮与重启），原 Codex home 摘要前后一致。

