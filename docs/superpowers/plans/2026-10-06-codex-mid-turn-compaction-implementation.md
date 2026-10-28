# Codex 回合内自动压缩与手动压缩入口

## 已验证事实

- 回合 `req-1791264114687-yaimhd`（把引用块换成信息卡并重写难懂的卡片）：37 次工具调用、37 个网关请求全部完成，单次请求输入涨到约 23.7 万 token；随后 Codex 发起回合内自动压缩，Ready 网关以 `gateway_turn_metadata_shape_invalid` 拒绝，回合失败（`nativeTurnError` 即该网关错误）。
- 真实 0.149 探针（隔离 `CODEX_HOME`、本地假上游、`model_auto_compact_token_limit = 40000`；脚本见会话草稿 `midturn-compaction-probe.mts`）：
  - 回合内压缩的元数据为 `compaction = {trigger:auto, reason:context_limit, implementation:responses, phase:mid_turn, strategy:memento}`，与回合前压缩只差 `phase`；外层与内层键集合与回合前压缩相同（含 `root_turn_id`），`tools` 为空；输入是此前全部历史加一条压缩提示（user 角色）。
  - 同一回合可多次压缩（探针中两次）。
  - 压缩后的下一次产品请求只剩基础 developer 指令、环境上下文、本轮用户消息和一条 user 角色的摘要交接；Ready 的本轮 `additionalContext`（资源引用、组件目录、记忆）全部被丢弃，网关据此算出的当前轮上下文为空，与准入摘要不符。
  - 回合读回为 `userMessage, contextCompaction, contextCompaction, agentMessage(final_answer)`，压缩前的工具调用项不再出现在读回中。
- 收尾的压缩证据 `verifyCodexAutomaticCompactionEvidence` 只接受每回合一次压缩，并要求后继请求的“最长字符串”变短；回合内压缩后保留的基础指令往往就是最长项，该条件不成立。`hasExactAutomaticCompactionEvidence` 也只接受恰好一次。
- `context-compact` 内置技能声明的 `skill_compact_context` 只在已退役的 SDK 运行时实现；Codex 路径落到通用技能执行器返回 “Unknown skill primitive”。Ready 已有基于 Codex 原生压缩的生命周期动作 `agent:compactSession`（聊天菜单“压缩上下文”），回合内的工具调用无法执行独立压缩。

## 合同

1. **网关分类**：自动压缩签名接受 `phase ∈ {pre_turn, mid_turn}`，其余字段逐项精确匹配；键集合与 `root_turn_id` 要求不变。
2. **压缩后的产品请求**：同一 `readyRunId + codexTurnId` 已有完成的自动压缩交换时，产品请求先按原精确核对；不符时只接受“当前 run 的 Ready 上下文完全不存在”——在整份请求中（不只是最新用户消息之前）找不到本 run 的资源快照、组件目录、未提交尾项，也没有重试或记忆项；其他 run 的旧资源标签只是历史。压缩后最新的 user 角色项是 Codex 的摘要交接，只看它之前的条目会把放在任务消息前的部分上下文漏判为空，所以必须全量扫描。出现部分、伪造或无法解析的 Ready 上下文仍拒绝。未发生压缩的回合保持原精确核对。
3. **收尾证据**：每次自动压缩与其后第一个产品请求配对，任意次数；每对都要求压缩请求与后继都已完成、上游快照一致、压缩请求无工具、后继工具面等于产品工具面、后继输入摘要不同且总字符数更少，且压缩请求中除最后一项（压缩提示）外至少有一项未在后继中出现（历史确被替换）。`hasExactAutomaticCompactionEvidence` 接受一个或多个按序排列的证据。
4. **手动压缩入口**：用户只发送 `context-compact` 技能（无其他文字或附件）时，Renderer 直接执行既有的生命周期压缩动作，不启动模型回合；回合内调用 `skill_compact_context` 返回明确说明（Ready 的压缩是独立操作，可单独发送该技能或使用聊天菜单），不再报未知原语。技能正文同步该行为，描述不变。

不在本轮范围（已知边界）：

- 回合内压缩后又发生瞬时失败的回合，仍按 `unknown_reset_required` 处理（需要开始新上下文）。
- Main 在压缩回合中途重启时，启动恢复只能从原生回读重建候选；回合内压缩后回读不再含此前的工具项，工具发布屏障会按 `admitted_tool_call_missing_from_terminal` 判为未完成。实时收尾使用 collector 实时收到的工具项，不受影响。要支持该场景，需要从 Main 的工具准入与交付记录重建被压缩掉的调用，另立合同。

## 验证

- 网关单测：`mid_turn` 被识别为自动压缩，签名其他字段改动仍拒绝；压缩后空上下文的产品请求被接受，未压缩回合或部分上下文仍拒绝。
- 证据单测：两次压缩得到两条配对证据；保留最长基础指令的回合内压缩不再误判；`hasExactAutomaticCompactionEvidence` 接受两条。
- 真实二进制 + Ready 网关 e2e：回合内两次压缩的回合经 Ready 网关完成并通过收尾证据。
- Renderer：只发送 `context-compact` 时调用压缩动作并清空草稿；带其他文字时照常发送。
- `skills:lint`、受影响 gate、类型检查、lint。

## 验证结果（2026-10-06）

- 网关：`codex-model-gateway-adversarial.test.ts` 43/43，新增 `mid_turn` 分类与其他字段改动拒绝、压缩后整份丢弃的上下文被接受、未压缩回合与部分上下文被拒绝、压缩后重新注入的精确上下文仍通过。
- 证据：`codex-automatic-compaction-evidence.test.ts` 5/5（两次压缩配对、保留最长基础指令的回合内压缩、只少了压缩提示的回放被拒、连续两次压缩之间缺产品请求被拒）；`codex-terminal-facts.test.ts` 16/16（两对证据有序通过，缺一对或乱序 reset-required）。
- 真实二进制 + Ready 网关：`codex-model-gateway-sidecar.e2e.ts`（`READY_CODEX_E3E=1`，Electron）新增回合内两次压缩场景，网关收据序列为 `product, automatic_compaction, product, automatic_compaction, product`，回合完成、两个工具调用都被收集、收尾证据两对、历史 `continuation_safe`。去掉压缩后上下文放行时该场景以 `gateway_additional_context_mismatch` 失败（红检）。线程配置只用生产同形的 `model_context_window`。
- 收尾与恢复：`codex-browser-verifier-closeout-native.test.ts` 与 `codex-product-boot-recovery.test.ts`（Electron）41/41。
- 手动入口：`standalone-compaction.test.ts`；`skill-compact-context-codex.test.ts` 经真实 `executeSkillTool` 断言回合内调用返回 `compaction_runs_between_turns` 说明，去掉修复时失败（红检）。`lint-skill` 通过。
- 以上新测试已加入 `verify:codex-input-continuity`（31/31）。
