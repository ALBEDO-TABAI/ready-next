# Codex 手动压缩：未加载线程、被拒派发与恢复

## 已验证事实（2026-10-07，用户数据只读）

- 用户在 Ready 启动后（17:28:56 Codex 运行时就绪）单独发送 `@[context-compact]`，界面显示“这次没能压缩上下文：发送失败”。
- `codex_manual_compaction_bindings` 新增一条记录（17:29:15.617），同时取得 `manual_compaction` 派发栅栏；派发尝试 1 毫秒内 `response_kind = rejected`。Codex 日志（`logs_2.sqlite`）在 `thread/compact/start` 之前只有一次 `thread/read`，没有 `thread/resume`。
- 真实 0.149 二进制探针：线程在一个进程内跑完一轮后重启 app-server，`thread/read` 显示 `status: notLoaded`；此时 `thread/compact/start` 返回 `-32600 thread not found`；`thread/resume` 之后同一调用成功，压缩回合只含一个 `contextCompaction` 项，上游收到 `{trigger:manual, reason:user_requested, implementation:responses, phase:standalone_turn, strategy:memento}`。
- ChatGPT 桌面应用的手动压缩（`X4t`）先确保会话由当前窗口持有：持有者不可用时先恢复会话（`resumeConversationForUnavailableOwner`），然后才调用 `thread/compact/start`。
- Ready 的 `loadedThreads` 只在内存中，Ready 或运行时重启、连接意外关闭、未成功收口的产品回合都会清空或移除；产品回合经 `ensureThread` 按需走带身份核验的 `thread/resume`，手动压缩没有这一步。
- 被拒后：`compactSession` 只返回 `compaction_state_unknown`，记录仍为 pending，栅栏仍在，头部动作被 `manual_compaction_pending` 全部阻断（包括发送）。
- 17:34:15.621（派发 5 分钟后）手动压缩的 provisional inbound 所有者到期，缓冲区以 `provisional_buffer_deadline_exceeded` 让整个运行时连接协议失败并重启（metrics `codex_sidecar_protocol_failure`）。
- 17:34:17.491 恢复把这条记录标为 unknown（`dispatch_may_have_reached_child`）：恢复只看 `child_write_attempted_at`，没有消费已记录的 `response_kind = rejected`。会话因此只剩“开始新上下文”。
- 启动恢复对从未写出的派发会重新派发压缩，但启动时线程同样未加载，重派必然得到 `thread not found`，随后同样落入 unknown。
- 修复加载后用真实二进制 + Ready 网关复测，又暴露下一层：已压缩过的线程在重启并 `thread/resume`（只带 threadId）后，压缩请求里没有任何 developer 消息，网关以 `gateway_instruction_digest_mismatch` 拒绝；Codex 接受了 RPC 却没有请求上游，Ready 等满超时并把 provisional 所有者到期变成连接失败。
- 真实二进制探针（同一隔离夹具，按请求打印 developer 消息分段）：
  - 未压缩线程：重启后 `thread/resume` 不论是否带 `developerInstructions`，后续请求都只有一份 Ready 指令（不会重复）。
  - 已压缩线程：重启后只带 threadId 恢复，下一轮普通请求的 developer 消息只剩 Codex 自带的 skills/permissions 段，**Ready 的 developer 指令丢失**；带 `developerInstructions` 恢复后，下一轮恢复为一份 Ready 指令。
  - `thread/fork` 同理：从已压缩的线程分叉、不带 `developerInstructions` 时新线程丢失 Ready 指令，带上则恢复；未压缩线程分叉带上也不重复。
  - 紧接在一次压缩之后的独立压缩（中间没有普通回合，不论是否重启）请求里没有任何 developer 消息：Codex 只在普通回合开头重新注入初始上下文。
- 固定 0.149 的 `ThreadResumeParams` 与 `ThreadForkParams` 都接受 `developerInstructions`。Ready 的线程指令合同摘要由 `readCodexInstructionContractDigest` 从固定基础指令 + 单条 Ready developer 消息计算，启动恢复已有按 `expectedDigest` 复原指令的先例。

## 合同

1. **已加载前置条件**：手动压缩在派发前（实时入口与启动恢复的重派）都先确保线程已在当前连接加载：已在 `loadedThreads` 中直接使用，否则走与产品回合相同的 `thread/read → 核验 → thread/resume → 核验 → 记录恢复证据` 路径（线程 ID、source、fork 来源、指令来源为空、隔离 cwd）。恢复失败不创建压缩记录，结果为 `native_protocol_error`，会话保持空闲。
2. **被拒派发的结算**：`thread/compact/start` 收到带数字 code 与非空 message 的 JSON-RPC 错误时，只有连续两次线程回读都显示回合列表与派发前完全一致且没有进行中的回合，才算“未开始”。证明成立时在同一事务内把记录标为 `abandoned_reason = dispatch_rejected` 并同时 reconciled（状态视为已结算）、删除栅栏、推进头部动作序号；证据是派发尝试上记录的拒绝响应摘要加结算时的两次回读（`thread_read_digest` 在表约束中只属于已完成的压缩回合，不复用）；同时撤销该压缩的 provisional inbound 所有者（不得等到期触发协议失败）。结果为 `native_protocol_error`，`preserveUi`，会话回到空闲，可直接再试或继续发送。证明不成立时按现有规则标记 unknown。超时、连接关闭等无响应失败不在本合同内，保持现状。
3. **启动恢复**：pending 或 unknown（未 quarantine、未认领压缩回合）的记录，若最近一次派发尝试的响应为 `rejected`，用合同 2 的同一回读证明与同一结算事务收口；不重派、不因已写出子进程而判 unknown。已有用户数据中的这类记录在下次启动时由此自动解除，不手工修改数据库。
4. **启动重派**：对证明从未写出的派发，重派前先满足合同 1。
5. **界面**：单独发送 `context-compact` 与聊天菜单“压缩上下文”共用同一结果呈现，按失败码给出直白说明，草稿保留；不再显示通用的“发送失败”。
6. **重建线程时重申 Ready 指令**：Ready 发出的每个 `thread/resume`（产品回合、手动压缩、启动恢复对 fork 的核对）与 `thread/fork` 都带上该线程冻结的 developer 指令；指令由线程记录的 `instruction_contract_digest` 经 `resolveCodexThreadInstructionContract({ expectedDigest })` 复原，摘要漂移时拒绝而不是带错指令恢复。
7. **没有新内容不压缩**：线程最近一个回合只含压缩项（上次压缩之后没有任何普通回合）时，手动压缩不建记录、不派发，结果为 `no_active_operation`，界面说明目前没有需要压缩的新内容。

不在本轮范围（已知边界）：

- 产品 `turn/start` 被拒并证明未开始后，其 provisional 所有者同样没有撤销入口，30 秒后会触发同类协议失败；需另立合同统一“证明未开始即撤销 provisional 所有者”。
- 启动恢复对“线程已存在、回合未开始”的产品 run 直接 `turn/start`，同样没有先恢复线程（启动时线程未加载）；属同一根因的另一入口，崩溃窗口很窄，另立合同处理。
- 手动压缩派发后无响应（超时、连接关闭）仍保持现状：记录 pending，等待恢复判定。

## 验证

- 真实二进制 + Ready 网关（`codex-model-gateway-sidecar.e2e.ts`）：重启运行时后不经恢复直接派发，复现被拒与 pending 栅栏；再次重启后启动恢复以回读证明结算并释放栅栏；再重启后经真实生命周期适配器手动压缩，先恢复线程再压缩，经网关完成并消费；随后下一轮产品回合继续同一线程且历史 `continuation_safe`。
- 适配器单测：需恢复时恢复先于建压缩记录；被拒且证明成立返回 `native_protocol_error` 并结算；证明不成立标记 unknown。
- 控制器单测：恢复中被拒记录结算、不重派；有新回合时不结算；重派前确保线程加载。
- 仓库原生测试（`verify:native`）：结算释放栅栏、头部回到空闲、恢复快照跳过；非 rejected、已认领或已消费的记录拒绝结算。
- 缓冲区单测：撤销后到期不触发协议失败；已有帧的所有者不可撤销。
- Renderer：失败码文案与菜单入口。
- 合同 6：真实二进制 e2e 中压缩后重启，经生产恢复路径恢复线程后的普通回合通过网关指令核对并完成；客户端与恢复授权单测断言 `developerInstructions` 随 resume/fork 发出；仓库/存储单测断言摘要漂移时拒绝。
- 合同 7：适配器/控制器单测断言最近回合只有压缩项时不建记录、不派发。

## 新版内核对照（2026-10-07）

用户提醒内核可能需要升级。ChatGPT 桌面应用自带 `codex-cli 0.160.1`（Homebrew 版同为 0.160.1；Ready 固定 0.149.0）。用同一组隔离探针（`CODEX_BIN` 指向 0.160.1）对照：

- 不变：未加载线程压缩仍返回 `thread not found`；压缩 → 重启 → 只带 threadId 恢复后，下一轮仍丢失 developer 指令；紧接压缩的独立压缩仍没有 developer 消息；回合内压缩签名相同，压缩后本轮 Ready 上下文同样被丢弃。官方 0.157.0 变更“Persist resume metadata in compaction checkpoints / Resume model context from the latest compaction boundary”没有改变这一点。本轮合同 1–7 在 0.160.1 上同样必要。
- 变化：请求元数据新增 `analytics_enabled`、`context_window_id`、`model`、`window_number` 等键，现行网关的精确键集合会以 `gateway_turn_metadata_shape_invalid` 拒绝 0.160.1 的所有请求；压缩后的回读保留了此前的工具调用项（0.149 会丢失，这会缓解“压缩回合中途重启后的启动恢复”边界）；基础指令长度变化（指令合同摘要夹具需重采）。
- 结论：升级内核是独立迁移（协议 schema 与清单重新固定、网关元数据合同、基础指令夹具、全部真实二进制探针与证据收据），不在本轮混做；本轮修复在升级后仍然成立。

## 验证结果（2026-10-07）

- 真实二进制 + Ready 网关（`codex-model-gateway-sidecar.e2e.ts`，`READY_CODEX_E3E=1`，Electron）新增场景全部通过：已压缩线程重启后经生产恢复路径的普通回合通过网关指令核对（合同 6）；重启后不经恢复直接压缩复现 `thread not found` 与 pending 栅栏（用户数据同形）；再次重启后启动恢复以回读证明结算并释放栅栏、会话回到 `idle_native_thread`（合同 2、3）；经真实生命周期适配器压缩先恢复再压缩并经网关完成（合同 1）；紧接再压缩返回 `no_active_operation`（合同 7）；压缩后普通回合 `continuation_safe`；中断的压缩在重启后由启动恢复先恢复线程再重派并完成（合同 4）。
- 红检（各自去掉对应修复后同一 e2e 失败）：恢复不带指令 → `gateway_instruction_digest_mismatch`；启动恢复不处理被拒 → 记录被标为 unknown（与用户数据一致）；压缩前不恢复 → `native_protocol_error`（同时验证被拒实时结算不再卡住）。
- 单测：控制器 11/11、适配器 49/49、缓冲区 20/20、客户端 45/45、启动恢复动作 7/7、Renderer 2/2；仓库原生测试新增被拒结算用例。
