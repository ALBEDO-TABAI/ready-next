# 现有改动对照计划归档（§1.5 产物）

> 日期：2026-06-18 ｜ 分支：agent-evolution/phase1 ｜ 对照计划：`docs/superpowers/plans/2026-06-17-send-im-l1-and-agent-state-fix-implementation.md`（r6）
> 方法：`git diff` 全量 41 改 + 7 新代码文件，按 G0–G4 归类（3 路并行读 diff + G0 切片人工复核）。
> 状态：**仅归档/对照，未改代码。** 这是 precheck 的前置（计划 §1.5）。

---

## 0. 头条结论（critical）

**工作树把 G1 / G2 / G4 都实质做了，唯独 keystone G0-root 没做（只做了它的 D1 子分支）。这正是计划 §8-R4 警告的"顺序倒置"：下游全修了，地基没修。**

- **G0-root（终态如实化 + 触发面校准）= 未实现。** 硬证据：
  - 计划要求的病因码 `delivery_failed/tool_unavailable/no_artifact/proof_gap` 在**生产代码中一个都不存在**（grep 全空）。
  - `run-finalizer.ts` 的 `done → adjudication_degraded` 改写块**逐字未动**（diff 只加了 `skillExecutionForm` 透传）。
  - `runtime.ts` 新增 `describeInboundChannelFailure` 只是把 `adjudication_degraded` **在 IM 回复层换了句人话**（"执行没有正常收口：…"）——这是症状层创可贴，反而**证明根因仍在发 `adjudication_degraded`**。
- **G0-D1（direct skill 的 s1 `markNotApplicable`）= 已完成且有测试。** 但它只是 G0 的一个窄分支。
- **后果**：即便 send-im 现在能发、能跨轮、名字也统一了，一旦动作真失败或证据不达标，run 仍会被 `adjudication_degraded` 塌缩 → 用户仍看到"完成判定未通过"。**下游的修复成效会被未修的 G0 继续掩盖**——和 06-18 findings 的根因完全一致。

**建议**：进入实现阶段时，**先补 G0-root**（按计划 §0.0 唯一执行顺序），再回归验证已落地的 G1/G2/G4 是否真的"看得见好"。现有下游代码大体可保留，但其验收 green 必须在 G0-root 落地后重测。

---

## 1. 按 G 分桶的完成度

| 桶 | 计划要求 | 工作树现状 | 测试 | 判定 |
|---|---|---|---|---|
| **G0-root** | 真失败落病因码、触发面校准、shadow/enforce 名实一致 | **未做**：无病因码、finalizer 改写块未动、仅 IM 回复层 cosmetic 翻译 | 无 | ❌ **缺（keystone）** |
| **G0-D1** | direct skill s1 不适用 | 已做：`criteria-templates.ts` `skillExecutionForm==='direct'`→`markNotApplicable(s1)`；`run-finalizer`/`turn-engine` 透传 | `run-finalizer-checkin.test.ts` | ✅ 完成 |
| **G1 暴露** | `@[Send IM]`→本轮工具可见 | 已做：`skill-context-orchestrator` 命中 `hasLocalSendImFileIntent` 短路到 `[send-im]`；live 名 `skill_send_im_file` | `skill-context-orchestrator.test.ts`、`tool-registry-…test.ts` | ✅ 完成 |
| **G1 跨轮(C-G1-X)** | "再试一次"不丢 skill、不被重分类 | 已做：`agent-sdk-runtime` `localSendImIntentTtl`+`isLocalSendImRetryFollowup`，并**强制关掉** browser/collection 重分类 | 仅 send-im 工具的 retry 测试间接覆盖；**TTL 闸门本身无焦点测试** | ⚠️ 完成但缺直测 |
| **G1 继承交付上下文(C-G1-Y)** | 重试继承文件+通道、直接进发送 | 已做：send-im 工具 `isRetrySendImRecovery` 从上轮恢复路径 | `send-im-skill-tool.test.ts`（retry restore） | ✅ 基本完成 |
| **G2 ret=-2 如实** | 后端业务码、非大小 | 已做：`_raise_for_business_error` 对 `ret/errcode/...` 判负，wire 进 `_post_json`/`_get_json`；100MB 门独立 | `wechat-openclaw-adapter.test.ts`（断 `ret=-2`→failed） | ✅ 完成 |
| **G2 路由/绑定** | routeTag/botAgent/context_token | 已做：`SKRouteTag` header、`bot_agent`、`context_token` 复用；删 `defaultTarget` 改发"绑定账号本人"；设置页加 routeTag/botAgent 配置 | adapter test + `remote-im-attachment-contract.test.ts`（含设置 source-grep） | ✅ 完成（真机另验） |
| **G4-D4 名字统一** | 全链单一名 `skill_send_im_file` | 已做：**删掉**重复表 `STATIC_TOOL_NAMES`，`buildToolName` 统一走 static；manifest/SKILL.md/live 全一致；`skill_send_im_send_file`→null 守卫 | `tool-registry-skills-dynamic-resolution.test.ts` | ✅ 完成 |
| **G4-D3 下载→send-im + 多图** | 下载登记产物层、send-im 无路径解析、多图 | 已做：`browser-tools` 下载登记 `projectionPatch.recentArtifacts`；send-im 从产物层解析；支持多文件 | `browser-download-recent-artifacts.test.ts`（4 图端到端）；adapter 多附件仅断 N=2 | ⚠️ 完成；**无"最终 payload=4 附件"端到端断言**（C-G4-3 测试口径未足） |
| **G3 兜底纪律** | present_file 不得冒充发 IM | 部分：`remote-im-file-intent` 负向意图 + `remote-im-attachment-contract` 锁"附件只来自 delivery proof"；**无"Send IM 不可用→禁 present_file 顶替"的直测** | 部分（contract test） | ⚠️ 部分 |

---

## 2. 关键风险与缺口（按严重度）

1. **【最高】顺序倒置：G0-root 缺位。** 下游 G1/G2/G4 已做，地基没做 → 成效被 `adjudication_degraded` 继续掩盖。**必须先补 G0-root** 再验收其余。
2. **【中】C-G0-2"防假成功"测试尚不存在**（因为 G0-root 没做）。补 G0 时务必按计划 §2.5 三条全断（病因码 ∧ verdict≠accept ∧ ≠adjudication_degraded）。
3. **【中】`describeInboundChannelFailure` 是错层创可贴**：在 IM 回复层翻译 `adjudication_degraded`。G0-root 落地后应复审——要么删（根因已如实），要么改成读真病因码，避免双重语义。
4. **【中】C-G4-3 多图端到端口径不足**：工具层有 N=4，但**没有**"最终 sidecar payload 含 4 附件"的断言；adapter 仅断 N=2。补一条 4 图端到端 payload 断言。
5. **【低】缺直测**：`remote-im-file-intent.ts`（意图正则）、`messageComposer.ts`（附件路径文本块）、`agent-sdk-runtime` 跨轮 TTL 闸门、`sidecar-manager` 的 `attachments` 字段（仅 source-grep）——逻辑非平凡，建议补行为测试。
6. **【低】whitespace 杂质**：`browser-agent-runner.ts`、`browser-engine/ipc-handler.ts` 引入硬 tab 缩进（仅风格，无行为）。
7. **【低】not-in-plan（良性）**：`package.json` 加 `verify:send-im-l1` 并入 `verify:stability`；`test-coverage-exemptions.json` 加 3 条 SQLite-skip 豁免（owner=send-im-l1）。属测试基建，记录即可。

---

## 3. 逐文件归类（消费方/证据）

**G0-root（缺）**：无文件。

**G0-D1（已完成分支）**
- `quality/criteria-templates.ts` (+16) — `skillExecutionForm==='direct'`→`markNotApplicable(s1)`。
- `runtime-core/run-finalizer.ts` (+29) — `normalizeSkillExecutionForm` 透传；**改写块未动**。
- `agent-control/turn-engine.ts` (+6) — 标 `module='skill'` 处一并写 `skillExecutionForm`。
- `contracts/run-contracts.ts` (+4) — `skillExecutionForm` 类型。
- `tools/tool-executor.ts` (+6) — proof sink / confirmation task event（G0 取证侧）。
- 测试：`run-finalizer-checkin.test.ts` (+68)。

**G1（暴露 + 跨轮）**
- `skills/skill-context-orchestrator.ts` (+3) — 命中意图短路 `[send-im]`。
- `runtime-core/agent-sdk-runtime.ts` (+125) — 跨轮 TTL + 关闭重分类 + `collectToolOutputProofs` 调用。
- `skills-runtime/manifest.ts` (+8) — 注册 send-im 内嵌 skill。
- `shared/remote-im-file-intent.ts` (NEW) — 意图/负向意图正则（**缺直测**）。
- `renderer/modules/agent/messageComposer.ts` (+10) — 附件路径文本块（**缺测**）。
- `domain-adapters/run-capability-controller.ts` (+2) — 能力裁决微调。
- `scripts/check-skill-allowed-tools-enforced.cjs` (+6) — allowlist 来源 gate。
- 测试：`skill-context-orchestrator.test.ts` (+56)、`agent-sdk-runtime.test.ts` (+47)、`tool-registry-skills-dynamic-resolution.test.ts` (+147，跨 G1/G4)。

**G2（微信路由/发送/ret=-2 + IM 通道路径）**
- `python/channels/wechat_openclaw_adapter.py` (+642) — 发送/上传 CDN/下载/路由(SKRouteTag,botAgent)/`ret=-2` 如实/inbound 附件/typing。
- `runtime-core/runtime.ts` (+498) — **IM 通道收发**：`sendChannel(attachments)`、`collectOutboundChannelAttachments`(proof→附件)、typing、inbound 命令、`describeInboundChannelFailure`(⚠️错层创可贴)。
- `runtime-core/channel-delivery-result.ts` (NEW) — `normalizeChannelDeliveryResult`（发送结果归一，非 finalizer 终态）。
- `agent-control/sidecar-manager.ts` (+45) — `sendChannel.attachments`、`sendChannelTyping`、`cryptography` 依赖 gate。
- `python/main.py` (+15) — `/channels/send` 加 `attachments` 列表、`/channels/typing`。
- `python/channels/{manager,base,feishu_app_adapter,telegram_adapter}.py` — `attachments` 透传 + `send_typing`。
- `python/requirements.txt` (+1) — `cryptography`。
- `settings/RemoteIMSettingsPanel.tsx` (+87) — routeTag/botAgent 配置 UI（删 defaultTarget）。
- `preload/index.ts`、`types/electron.d.ts`、`ipc/channel-management-group.ts` (-1 each) — 一致删 `defaultTarget`。
- 测试：`wechat-openclaw-adapter.test.ts` (+505)、`remote-im-attachment-contract.test.ts` (NEW)、`skill-python-runtime-contract.test.ts` (+3)。

**G4-D4（名字统一）**
- `tools/skills-tools.ts` (+75) — 删 `STATIC_TOOL_NAMES`，`buildToolName` 走 static；路由 send-im→executor。
- `tools/skills-tools-static.ts` (+48) — `'send-im:send_file'→'skill_send_im_file'` 单源 + 静态定义。
- `assets/embedded-skills/send-im/` (NEW) — manifest `allowed_tools:["skill_send_im_file"]` + SKILL.md。

**G4-D3（下载→send-im + 多图）**
- `tools/browser-tools.ts` (+117) — 下载登记 `recentArtifacts`(image/video/download) + `discoveredHandles`。
- `tools/send-im-skill-tool.ts` (NEW) — 文件解析(显式/`@[ref]`/recentArtifacts/目录展开/retry)、自发target、`ret=-2` 诊断、多文件、负向取消。
- `task-projection/run-projection.ts` (+34) — `recentArtifacts` 装配。
- `tools-runtime/tool-runtime.ts` (+1)、`tool-runtime-context-builder.ts` (+3) — recentArtifacts 进工具上下文。
- `tools/browser-agent-runner.ts` (+25)、`browser-engine/ipc-handler.ts` (+17) — `string|ToolExecutionOutput` 解包（⚠️硬 tab）。
- 测试：`browser-download-recent-artifacts.test.ts` (NEW)、`send-im-skill-tool.test.ts` (NEW)。

**not-in-plan（测试基建，良性）**
- `package.json` (+3) — `verify:send-im-l1` 链。
- `scripts/test-coverage-exemptions.json` (+24) — 3 条 SQLite-skip 豁免。

---

## 4. 对计划的回写建议（不改代码）
- 计划 §1.5 已要求本归档——本文即产物，可在计划 §1.5 引用本路径。
- **G0 在 §2.1 注明"D1 已完成"是准确的；但应在 §2 显著处补一句"G0-root 在本工作树尚未实现，且下游 G1/G2/G4 已先行落地（顺序倒置），G0 必须补齐后回归"**——避免被 §2.1 的"已完成分支"误读为 G0 整体已做。
- §7 提交顺序仍成立，但**首个 commit 不是"从零写 G0"，而是"在既有树上补 G0-root + 其防假成功测试"**，随后把已存在的 G1/G2/G4 改动按桶拆分/补测试纳入对应 commit。
