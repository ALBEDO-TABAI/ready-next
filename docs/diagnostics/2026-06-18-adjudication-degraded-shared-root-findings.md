# Findings — `adjudication_degraded` 反复"没根治"的共同根因（扩大化审查）

> 诊断日期：2026-06-18 ｜ 工具：ready-debug（日志优先级 + 账本巡检）+ 代码定位 + git 溯源
> 分支：agent-evolution/phase1 ｜ 状态：**仅诊断，未改代码**
> 方法：先锚定今天两次重试的真实 run → 三账本核验 → 顺着 `adjudication_degraded` 下钻到收口/判定/取证三段代码 → git blame 溯源促成时间点。

---

## 0. 头条结论（confirmed）

**用户每轮看到的"还是失败 / 没根治"，源于一个共同根因把多个独立病因塌缩成同一症状——不是只有一个 bug，而是多个真实病因（工具没暴露、微信 ret=-2、没产出文件）被同一个不透明终态盖住，看起来像同一个问题反复发作：**

> 终态判定器（task-adjudicator）实际运行在 **enforce 模式**——它会把模型已经判 `done` 的 run **强制改写成 `error / adjudication_degraded`**；但它判决所依据的取证管线（proof-collector）**只收"成功且 proof-kind 对得上"的证据**。两者叠加的结果是：凡是「关键动作失败」或「产物没被登记成对应 kind 的 proof」的 run，一律被改判成**同一个不透明终态 `adjudication_degraded`**（用户侧显示"完成判定未通过"）。
>
> 这个不透明终态把**所有不同的真实病因**（工具没暴露、微信 ret=-2、没产出文件……）**塌缩成同一个症状**。所以 Codex 每修好一层真实病因，用户看到的结果都一模一样 → 错觉是"没根治"。

一句话定性：**enforce 级的判定闸门，架在一条会漏证据的取证管线上，再用一个不透明终态把真实病因全遮住。** 命中 CLAUDE.md §0.5 第 2 条（修根因不修症状）与 §0「失败要响亮」。

---

## 0.1 复审更新（Codex 交叉复核 + 二次取证）

Codex 交叉复核认同大方向、同意升 G0，提出两处校正。二次取证后**两处都成立，其中 ret=-2 一处的证据比"更像路由"更硬**，另把两个现象合并成同一机制：

**校正一（框架）：G0 不是"把所有锅归判定器"。** 判定闸门是"为什么所有失败长一个样、为什么每轮没根治"的共同根因（症状塌缩 / 可诊断性丧失），但它**不解释**"这轮为什么没暴露 Send IM"，也**不解释**"微信为什么 ret=-2"。真实病因是多个、相互独立的；判定闸门只是把它们**盖**成一个码。故 G0 的准确表述是 **"终态如实化 + 判定器触发面校准"**，不是"全归判定器"。

**校正二（`ret=-2` ≠ 文件太大，已被代码证伪）：** 适配器的大小门是**独立的、且报另一句话**——`_send_attachment`（`wechat_openclaw_adapter.py:508-509`）只有 `st_size > WEIXIN_MEDIA_MAX_BYTES(=100MB)` 才抛"微信附件超过 100MB"；3.2MB 远不触发。而"微信接口返回 ret=-2"来自 `_raise_for_business_error`（`:178-187`）对 `ret/errcode/code` 的**后端业务码**判负。**所以"3.2MB 太大"是模型臆测，代码已证伪。** ret=-2 由 `ilink/bot/getuploadurl` 或 `ilink/bot/sendmessage` 返回，结合适配器的 `routeTag/SKRouteTag/botAgent/binded_redirect/context_token` 路由绑定层，最可能是**路由标签 / bot 绑定 / 会话 context_token** 之类后端拒绝（需真机 + 抓原始 endpoint 定，但**大小假设已排除**）。

**新洞察（合并）：mqid6t 的"暴露丢失" = Codex 的 G1"重试身份丢失"，且触发是确定性的，不是 flaky。** 二次取证：
- w0jcej 的用户轮文本里**有** `@[Send IM]@[…pdf]` → 本轮授权 skill → 工具暴露 → 调用 → ret=-2。
- mqid6t 的 scope 标题就是 **"再试一次"**，用户轮**没有** `@[Send IM]`（它只在上一轮摘要里）→ 本轮 `findExplicitlyRequestedSkills` 无命中 → **不授权 skill → final_tools 0 个 skill 工具**（toolCount=63 实证）→ 任务被分类成 research、退化去 file_search → 模型报"Send IM 不可用"。

→ **"暴露时有时无"不是随机，是确定性**：skill 授权只认**当前轮字面** `@[skill]`，"再试一次 / 继续"这类后续轮一律丢 skill。这把我原先标的"暴露 L1"和 Codex 的"G1 重试身份"统一为同一根：**skill 授权/身份不跨轮持久。**

**采纳 Codex 的分层（带上述两处校正）**，后续按此序修：
1. **G0**：终态如实化 + 判定器触发面校准（病因码不塌缩成 `adjudication_degraded`；取证天然缺失时禁止伪装失败）。
2. **G1**：skill 身份跨轮持久（修"再试一次/继续"丢 skill = 原暴露 L1）。
3. **G2**：微信发送路由/绑定诊断（`ret=-2`，先定 endpoint + 查 routeTag/botAgent/context_token，**非文件大小**）。
4. **G3**：兜底纪律（Send IM 不可用**不得**改道 `present_file` 冒充发微信——两者非同一交付方式；mqid6t 模型确实这么兜了）。

---

## 1. 证据时间线 —— 今天（06-18）两次重试

活动库：`~/Library/Application Support/ready/ready.db`（11:24 最后写）。日志目录：`/var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T/`（11:26–11:31 最后写）。两次重试都是发图/发文件到微信。

| run | 时间 | task_type | module | 终态 | 真实病因（被遮住的那个） |
|---|---|---|---|---|---|
| `req-…-w0jcej` | 11:12 | short_task | **skill** | adjudication_degraded | **微信接口 `ret=-2`**：发送路径已真的打到微信，3.2MB PDF 上传失败 |
| `req-…-mqid6t` | 11:26 | research | research | adjudication_degraded | **暴露层**：本轮根本没暴露 `skill_send_im_*` 工具 |

两次的终态字符串完全相同，但底层是**两个不同的真实病因**——这正是"塌缩"现象的活样本。

### 1.1 w0jcej（11:12）——工具暴露了、也调用了、微信真失败
- `task_projections.module = skill`，`run_meta.task_type = short_task`，`tool_calls_used = 2`。
- DB `proof_refs_json` 只有 1 条 `assistant_response`，模型原话：
  > "连续两次都失败了，微信接口返回 `ret=-2` 错误……PDF 有 3.2MB，微信机器人接口对文件大小有限制"
- metrics：`adjudicator_shadow_divergence … verdict:"degraded", actualStatus:"done", terminalReason:"done", proofCount:1, blockers:["criteria_unsatisfied:c1"]` → 随后 `run_close … terminalReason:"adjudication_degraded"`。
- **关键**：blocker 是 `c1`，**不是 `s1`**。说明 Codex 这轮的 `s1 markNotApplicable`（direct skill 不要求 run_state）**确实生效了**——s1 已被正确剔除，失败迁移到了 base 准则 `c1`。

### 1.2 mqid6t（11:26）——工具根本没暴露
- DB `proof_refs_json`：`file_search / file_inventory / file_search / assistant_response`，模型原话：
  > "**Send IM 工具不可用（已被本轮工具策略过滤）**，所以无法直接发送到微信。同时 `present_file` 也因为文件不在沙箱目录内而无法使用。"
- tools 日志快照证实：`tool_capability stage=sdk_runtime_final_tools toolCount=63`，工具集里**唯一**含 "skill" 的是 `install_skill`——**没有任何 `skill_send_im_*` 执行工具**。
- metrics：`adjudicator_shadow_divergence … verdict:"degraded", proofCount:4, blockers:["criteria_unsatisfied:c1","criteria_unsatisfied:c2"]` → `run_close … adjudication_degraded`。
- research 的 c1/c2 都要 `artifact` proof；本轮没产出任何文件（也产不出，工具没暴露）→ 两条都不满足。

---

## 2. 根本原因（confirmed）—— 一根因，四个互相咬合的机制

### M1 · "shadow" 名义、enforce 行为（判定器越权改写终态）
- `run-finalizer.ts:204-229 writeTerminalOutcome`：拿到判定器返回的 verdict，**直接改写终态**：
  ```ts
  if (status === 'done' && verdict && verdict !== 'accept') {
    if (canResumeAsUserPoint(...)) { effectiveStatus='checkpoint'; effectiveTerminalReason='checkpoint_budget' }
    else { effectiveStatus='error'; effectiveTerminalReason='adjudication_degraded' }   // ← 221 行
  }
  ```
- 但 `recordShadowAdjudication` 的文档注释（`run-finalizer.ts:242-251`、`task-adjudicator.ts:11-12`）仍白纸黑字写着 **"the verdict NEVER mutates lifecycle status/terminal state"**，metric 也仍叫 `adjudicator_shadow_divergence`（看着像 observe-only）。**文档/命名说 shadow，代码行为是 enforce**——这是整个误判的认知盲点来源。
- **git 溯源**：promotion 这段由提交 **`923dddfe`（2026-06-17 00:50，作者 白，非 Codex）** 引入。它的前身 `b3442011`（EP2-Q4a）是**真 shadow**（只记 CheckIn，不动终态）。即 **6-17 凌晨这次提交把"观察"偷偷变成了"执法"，但没改注释、没改 metric 名、也没同步加固取证**——这才是这两天所有 run 批量 degraded 的引爆点。

### M2 · 取证管线对"失败工具"零收集（成功偏置）
- `proof-collector.ts:129-131 collectToolOutputProofs`：
  ```ts
  const normalized = normalizeToolExecutionOutput(output)
  if (isFailedToolOutput(normalized)) return []   // 失败工具 → 零 proof
  ```
  `isFailedToolOutput`（:78-86）把 `errorKind / ok:false / status=error|failed`，以及正文命中 `失败|无法|未找到|ret=…` 等都算失败。
- 后果：w0jcej 两次 `skill_send_im` 都 `ret=-2` 失败 → **产出 0 条 `tool_result` proof** → short_task 的 c1（要 `tool_call`←`tool_result`）永不满足 → degraded。
- 取证管线本身**是接上的**（`agent-sdk-runtime.ts:4362` 每个工具结果都过 `collectToolOutputProofs`），所以"干净的成功 run"能正常 accept；**漏的只有失败动作和 kind 对不上的产物**。

### M3 · proof-kind 匹配过粗（分不清"做了但失败"和"没做"）
- `task-adjudicator.ts:64-90`：done 候选若 `satisfied < applicable` 即 degraded。satisfied 仅按 **proof-kind 是否在场**判断（`CRITERIA_PROOF_MAP`）。
- short_task c1 文案是"至少一次工具调用，或结构化声明无需工具"，**本意是"你有没有行动"**；但实现只认 `tool_result` 这个 kind 在不在 → **"调用了但失败"== "压根没调用"**，都判不满足。
- research c1/c2 只认 `artifact` kind；`file_search/file_inventory` 是 `tool_result`、`document_*` 产文档也未必登记成 `artifact` proof（取证靠 `proof-collector.ts:101-127` 的路径启发式抓 `path/savedPath/recentArtifacts` 等字段，抓不到就没有）。

### M4 · 终态不透明（把所有真实病因塌缩成一个症状）—— "每轮没根治"的直接成因
- 三种完全不同的真实病因（工具没暴露 / 微信 ret=-2 / 没产出文件）最后都写成同一个 `adjudication_degraded`，用户侧统一显示 **"完成判定未通过"**（`task-projection-sync.ts:453`）。
- 于是 Codex 哪怕真修好了一层（见 §3），症状字符串一模一样 → 看起来像"没根治"。**这是诊断信号被自己人毁掉**：判定闸门用一个万能失败码盖住了它本应放行/本应如实报错的一切。

> M1×M2×M3 = 合法/失败的 run 都被改判；M4 = 改判后无法区分病因。四者缺一，现象都不会这么顽固。

---

## 3. Codex 这轮**确实改对了**什么（别误判为没进展）

| 改动 | 证据 | 效果 |
|---|---|---|
| direct skill 的 s1 判据剔除 | `criteria-templates.ts:104-125` 新增 `skillExecutionForm==='direct'` → `markNotApplicable(s1)`；`run-finalizer.ts` 把 `skillExecutionForm` 串到判定 | **真修复**：w0jcej 的 blocker 已从 `s1` 迁到 `c1`，证明 s1 不再误杀 direct skill |
| 微信发送路径打通 | `wechat_openclaw_adapter.py` +642 行；w0jcej 已真的把文件送到微信并拿到 `ret=-2` | **真进展**：从"压根没发"推进到"发了、微信侧拒了" |
| `skillExecutionForm` 落点 | 即我上一版计划 D1 的字段透传，已落地 | 合同到位 |

**但用户看到的结果不变**，因为：①enforce 闸门把 blocker 从 s1 换成 c1/c2（打地鼠——每修一条准则，闸门就卡下一条）；②M4 不透明终态让所有结果长一个样。**这恰好反证了根因在闸门，不在某一条具体准则。**

---

## 4. 仍未触碰 / 新浮现（carryover + new）

- **Problem A（UI 卡死、停止键失效）：未碰。** `runtimeDriver.ts`、`claude-bridge/ipc-handler.ts` 均**不在本轮 diff**。renderer 仍只靠实时终态事件清 streaming，无 projection 对账兜底。
- **暴露层确定性丢失（非 flaky，mqid6t 实锤）**：用户轮是"再试一次"、无字面 `@[Send IM]` → 本轮不授权 skill → final_tools 0 个 skill 执行工具。本质同 G1（skill 身份不跨轮持久），见 §0.1。
- **微信 `ret=-2`（新浮现，需真机定 endpoint）**：发送路径打通后暴露的下一层。**已证伪"文件太大"**——大小门是独立的 100MB 门（`:508-509`，3.2MB 远不触发且报另一句话）；`ret=-2` 是 `_raise_for_business_error`（`:178-187`）对后端业务码的判负，结合 `routeTag/botAgent/context_token` 路由绑定层，最可能是路由/绑定/会话上下文被后端拒。详见 §0.1 校正二。
- **okf-bundle（Problem B）：仍是 partial**（`ff92577e` 放行了 script-backed reference skill 的 primitive，但 `okf_tools.py` 不建包目录、SKILL.md 不提 `skill_write_artifact`，仍产不出知识包）。
- **skill_task_runs 无 send-im 行**：全表只有 `video-expert-analyzer`（且 `run_id` 空、时间戳 epoch-0）。direct skill 不落 skill_task_runs 属设计内，但这意味着 send-im 的判定**完全依赖 run_meta+projection 那条链**，更凸显 M2/M3 漏证据的危害。

---

## 5. 影响面 / 爆炸半径

- 本 metrics-log 窗口内 **`adjudicator_shadow_divergence` 39 次，全部是 `verdict:degraded / actualStatus:done`**——即 39 个"模型判 done"的 run 被判定器判降级；按代码，每个 diverge 的 done 候选都会被改写离开 done（→ `adjudication_degraded` 或 `checkpoint`），其中本窗口可见 **≥15 个落 `adjudication_degraded`**。
- **不止 send-im、不止 skill**：mqid6t 是 research、ckxwcl 是 0 工具 direct-answer，都被这条闸门 degraded。**这是全 task_type 的系统性闸门**，send-im 只是最先撞上的高频场景。
- **潜伏更大的危险**：真正成功、但产物没被登记成对应 kind proof 的 run（例如某些 `document_*` 产文档、未来任何新交付形态），**会被同一条闸门误杀**。今天是误杀失败 run（看着像"对"），明天就是误杀成功 run。

---

## 6. 确定 vs 推断

**已确证：**
- enforce 改写存在且促成于 `923dddfe`（代码 + git blame）。
- 失败工具零取证（proof-collector 代码 + w0jcej proofCount=1 实证）。
- s1 已被正确剔除、blocker 迁到 c1（w0jcej blockers 实证）——Codex s1 修复有效。
- mqid6t 本轮未暴露 skill 工具（final_tools 快照 toolCount=63 实证）。
- w0jcej 微信 `ret=-2`（DB assistant_response proof 实证，模型转述工具结果）。
- Problem A 未改（diff 文件清单实证）。

**推断（需进一步定）：**
- 39 次 divergence 与 15 次 adjudication_degraded 的差额（24），最可能是 metrics 日志轮转截断所致，未逐条配平；不影响"闸门改写 done"这一机制结论。
- `ret=-2` 是否纯大小限制 vs 协议/鉴权问题，需真机微信复核（`ret=-2` 是微信侧返回码，非本地）。
- mqid6t 这轮"为何没授权 skill"的精确分支（`findExplicitlyRequestedSkills` / `@[skill]` 附着是否进 per-turn 授权），日志未直接打点，需代码侧补证——但"没暴露"这一事实已由 final_tools 快照确证。

---

## 7. 修复方向（仅方向，不改代码 —— 留待修复门）

按"先根因后症状"排序，**keystone 从 send-im 上移到判定闸门**：

1. **【keystone，新】判定闸门与取证管线对齐**——三选一或组合，必须先定合同：
   - (a) **校准 enforce 触发面**：只有当"取证管线对该 task_type 是可满足的"时才允许把 done 改写为 degraded；取证天然缺失（如失败动作、未登记产物）时，**禁止伪装成 `adjudication_degraded`**。
   - (b) **终态如实化**：动作真失败时，终态必须是病因码（`send_failed:wechat_ret=-2` / `tool_unavailable` / `no_artifact`），**不得塌缩成 `adjudication_degraded`**（直接解掉 M4，恢复可诊断性）。
   - (c) **统一 shadow/enforce 的名实**：要么真 enforce 就改注释+metric 名+补全取证；要么退回 shadow 只记录不改写。**当前名实不符本身是 bug**。
2. **取证补全（M2/M3）**：失败工具至少留"已尝试且失败"的结构化痕迹供判定区分"做了失败"vs"没做"；研究/文档产物登记成 `artifact` proof。
3. **暴露层 / skill 身份跨轮持久**（mqid6t = Codex G1）：`@[skill]` 授权要能跨"再试一次/继续"持久，不能只认当前轮字面 token。
4. **微信 `ret=-2`**（w0jcej = Codex G2）：先定 endpoint（`getuploadurl` vs `sendmessage`）+ 查 `routeTag/botAgent/context_token` 绑定，**非文件大小**（100MB 门已排除）。
5. **兜底纪律**（mqid6t = Codex G3）：Send IM 不可用时禁止改道 `present_file` 冒充发微信。
6. **Problem A**：renderer 终态 projection 对账兜底（架构级，单独排，碰可见收口硬约束）。

> 已有计划文档 `docs/superpowers/plans/2026-06-17-send-im-l1-and-agent-state-fix-implementation.md` 的重心需上移：原计划把 D1（direct-skill 判据）当 keystone，但本次审查表明 **D1 只是闸门的一个分支，真 keystone 是"enforce 闸门 × 漏证据管线 × 不透明终态"这条共同根因**。建议把第 1 项作为新的 G0 硬门加进该计划。

## 8. 临时绕过
- 单条任务卡死：刷新 renderer（⌘R / 重启）。后端多已 `error/done`，重载按 projection 重建，不丢文档。
- 发微信：`ret=-2` 是后端业务码（**非大小**，100MB 门已排除），暂无本地绕过——手动发送（模型已给出文件路径）。重连/重新扫码绑定微信、确认 `routeTag/botAgent` 配置后再试可能消除。
- 发 skill：后续轮要带上字面 `@[Send IM]` 再说"发"，别只说"再试一次"（当前 skill 授权不跨轮，见 §0.1）。

## 9. 修复尝试
**仅诊断，未改代码。** 本文档只组织表征、定位共同根因；是否进入修复（尤其 keystone 闸门改动属架构级）需过修复门、并配对到上面的 plan 文档。
