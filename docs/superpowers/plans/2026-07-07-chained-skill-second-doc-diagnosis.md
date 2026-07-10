---
title: 链式双技能任务第二份文档未落盘（proof_gap）根因诊断
date: 2026-07-07
kind: diagnosis
enforce: false
status: revised-after-adversarial-review-round-2
revision_note: >
  v2：起草稿核心结论"proof_gap 是裁决器正确拦下假 done"被审查证伪并经独立复核确认——终态 proof_gap 实为裁决器 c1
  对 inline reference-skill run 的结构性假阴性；第二份文档缺失有两个并列直接原因（写盘被拒 + 深读生成截断）；
  预算 desync（原 R3）无运行时因果，已降级。
  v3（本版，round-2 修正）：证据数字订正（40/69、单位字/字节）；写盘 corrective 组装点订正为 tool-input-validator.ts:78-96；
  content 是裸 z.string()；§5.4 补"无条件 c1→NA 会误 accept 欠交付"的计数难点。
incident:
  run_id: req-1783410490078-3tc5uu
  task_id: task-69df89f6-1aac-4c60-838d-6c991f28c8a4
  scope_id: conv-7a45e809-ca07-48a6-81f3-22f2dfb4f1a6
  agent: analyst
  window_local: "2026-07-07 15:48:10 → 15:53:43 (+08)"
companion: 2026-07-07-chained-skill-envelope-remediation-implementation.md
---

# 链式双技能任务第二份文档未落盘 · 根因诊断（v3）

> 只做取证与定性，不含改动。修复契约见 companion。
> 证据可追溯：`<TMP>/ready-agent-metrics.log`（M:行号，行号仅锚点、以内容/时间戳为准）、
> `<TMP>/ready-tools.log`（T:行号）、账本 SQL、`file:line` 源码。`<TMP>`=`/var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T`。
> 版本沿革见文末 §7（v1→v2→v3，均对抗审查修正留痕）。

## 0. 一句话结论 + 四层判定

链式双技能任务（先 `image-reverse-describe` 后 `image-deep-read`，各产一份文档到用户目录 `V`）里，**第二份（深读）文档有两个并列直接原因未落盘**：
(a) 写盘 `skill_write_artifact` 被 zod 校验**双字段**拒（`issueCount=2`，从未落盘）；
(b) 深读**正文本身生成未完成**——末条 assistant 消息在 `**L3 ` 处截断，只产出到 L2（意图层），L3 功能/L4 判断/存疑清单皆缺。
而这条 run 的**终态 `proof_gap` 不是裁决器"识别到缺文档"，而是判据 c1（`steps_complete`）对 inline reference/advisory 技能 run 的**结构性假阴性**——c1 只认 `run_state`/`task_event` proof-kind，这类 run **永不铸造**这两种 proof，故**哪怕完美交付两份文档也会以完全相同方式判败**。

| 层 | 判定 | 一句话依据 |
|---|---|---|
| **完成度裁决（criteria/adjudicator）** | ✅ **主责（结构性假阴性）** | `task-adjudicator.ts:42` `steps_complete:['run_state','task_event']`，`:82` 只比对 proof-kind、从不读 steps_json；本 run proof 仅 `artifact×32/tool_result×9/assistant_response×1`（无 run_state/task_event）。台账佐证：`multi_step_task` 终态 `proof_gap×69`（done 仅 11），其中 **40 条 proof 含 artifact 交付证据、却仍以 proof-kind 闸判败**（证明是"无计数的 proof-kind 机制"在筛，**非**断言这 40 条都是错杀的完整交付——本事故本身就是真欠交付）。 |
| **Skill runtime（写盘契约）** | ✅ **有责** | 第二份文档写盘两次 `tool_input_validation_failed issueCount=2 firstPath:relativePath`（M:1260/1262）；`relativePath` 只有一个字段，`issueCount=2` ⟹ 第二个必填串（`content`）亦失败；纠正回吐不够可执行，模型连吃两拒后 `initiator=done` 放弃。 |
| **生成（provider 输出完成度）** | ⭕ **并列直接原因·机制未定** | 末条 assistant **4435 字（10349 字节）** 截断于 `**L3 `（磁盘实证），深读只到 L2；截断机制（max-tokens/收敛/流中断）无 metrics 事件可锁，标未定。 |
| **Agent 编排 · 上下文** | ⭕ 放大器 | 单 run **22 次**自动压缩，`beforeTokens` 中位≈597K（峰 633K，≈3.0–3.17× 200K 窗口），单次丢 16–78 条（中位 48），持续撕碎路径/入参记忆。 |
| 预算（原 R3） | ❌ **无运行时因果（已证伪）** | 运行时真值 `task_projections.budget_json=multi_step_task/40`、`toolCallsUsed=24`（用 60%、余约 16）、`initiator=done`。预算**未逼停**；仅 `run_meta` 起点快照仍是 `short_task/24/bootstrap=true`（陈旧），属台账一致性、非因果。 |
| 门禁（P3-2 `skill_run_shell` 同意闸） | ❌ 排除 | 技能无脚本、不需 shell；唯一 shell 调用是 `missing_tool_soft_recovery`（软恢复非拒绝，M:1172）。 |
| Skill 本身 | ⭕ 基本无辜 | manifest/SKILL.md 规范；Step 1（同族技能）成功产出并导出，证明技能可用。 |

**修复含义**：让第二份文档写成功（写盘契约）**不足以**消除终态失败——c1 仍会判败。**必须同时让判据正确处理 skill-primitive 交付——含按"预期产出"计数**；仅靠 NA 式"识别交付"会反向把欠交付（只交付 1/2）误判 accept（裁决器纯 proof-kind 无计数，见 §5.4 / companion D-CRIT）。这才是终态止血。详见 companion。

## 1. 复现语境（100% 取证）

- 用户逐字请求（`run_meta.first_message_text`）：
  > 先用@[image-reverse-describe]分析@[110b543cd333.webp]输出一份文档到@[V]，再用 @[image-deep-read]分析一遍再输出一个分析文档到相同目录

  随后 `重试`、`继续`——同 scope 第 3 次重试（前两次 07:46/07:47 均 `fetch failed`/`blocked_external`）。
- 两技能均为 `~/…/skill-runtime/custom-skills/{image-deep-read,image-reverse-describe}` 下 **custom `runtime:"reference"`/`execution.mode:"advisory"`**，目录仅 `references/`+`SKILL.md`，**无 `scripts/`**。
- run 时长 `durationMs=333216`（5m33s，对上截图"本轮等待中 05:33"）；用户 16:52 截图看到的是 15:53 已终结的卡片。

## 2. 证据链（时间序，逐条可追溯）

| # | 时刻(UTC) | 证据 | 引用 |
|---|---|---|---|
| 1 | 07:48:10 | 工具面 `toolCount=13`，`floors=skill_selected:image-deep-read,current_document_context`（**单技能授权**），无 `skill_run_shell` | T:543 |
| 2 | 07:48:10 | 两技能 SKILL.md 双双内联（reverse-describe 3869B/deep-read 2603B） | M:1152, M:1153 |
| 3 | 07:48:10→ | **22 次** `agent_sdk_auto_context_compacted`；`beforeTokens` min 565704/中位≈597.7K/max 633070（15/22>585K），`after`≈138–155K，单次丢 16–78 条（中位 48，14/22>38，峰 78），窗口 200000（≈2.83×min/3.0×中位/3.17×峰） | M:1156 等 22 行 |
| 4 | 07:48:33→ | 读 **image-reverse-describe** 参考文件在 image-deep-read 读根下连续 `not_found`/`no_root_match`（`attemptedRoots=[outputs/image-deep-read, custom-skills/image-deep-read]`），烧约 1/3 工具调用 | M:1159, M:1190, M:1233 |
| 5 | 07:48:38 | 模型试调 `skill_run_shell` → `agent_sdk_missing_tool_soft_recovery`（软恢复非拒绝） | M:1172 |
| 6 | 07:49:52/07:50:06 | **Step 1 成功**：`skill_write_artifact` 5204B/3386B（part1/part2） | M:1198, M:1203 |
| 7 | 07:50:42 | 导出 → `V/110b543cd333-描述层完整报告.md`(8663B，磁盘实证) | 磁盘 + steps_json |
| 8 | 07:51:52/07:52:47 | **第二份文档写盘两次被拒**：`tool_input_validation_failed skill_write_artifact issueCount=2 firstCode:invalid_type firstPath:relativePath`（**双字段畸形**） | M:1260, M:1262 |
| 9 | 07:52:51/07:52:52 | `skill_inspect_run_state`×2 → error（reference 技能无 child run_state） | M:1265–1272 |
| 10 | 07:53:43.518 | 末条 assistant **4435 字（10349 字节）**，尾部 `…"童装造型"和"时尚杂志编辑图"之间寻找交叉地带。\n\n---\n\n**L3 ` **截断**（深读只到 L2；同类消息他处可达 **26199 字节**、无落库上限，故属生成截断） | `chat_messages` 磁盘实证 |
| 11 | 07:53:43 | `adjudicator_enforce_divergence verdict=degraded actualStatus=done blockers=[criteria_unsatisfied:c1] proofCount=42` → `run_close terminalReason=proof_gap initiator=done toolCallsUsed=24 taskType=multi_step_task` | M:1277–1279 |

### 账本佐证（均已复核）
- `task_projections`(task-69df89f6)：`status=failed`、`interaction_state=suspended`、`title=正在使用image-deep-read`。
  - `criteria_json`：`c1{steps_complete}` 未满足、`c2{artifact}` 满足、`s1{skill_run_state}` **已 notApplicable**；`satisfiedCount=1/2`。
  - `proof_refs_json` kind 分布：**artifact×32 / tool_result×9 / assistant_response×1**（**零 run_state/零 task_event**）。
  - **`budget_json`（运行时真值）：`multi_step_task / maxToolCalls:40 / toolCallsUsed:24 / bootstrapBudget:false`。**
- `run_meta`(req-1783410490078-3tc5uu)：`terminal_reason=proof_gap`；**`budget_json`（起点快照，陈旧）：`short_task/24/bootstrapBudget:true`**。
- 台账系统性：`run_meta` 中 `task_type=multi_step_task` 终态 = `proof_gap 69 / adjudication_degraded 19 / done 11 / …`；这 **69 条 proof_gap** 的 module 分布为 document 29 / system 23 / skill 11 / browser 6（合计 69），其中 **40 条 proof 含 artifact 交付证据、却仍以 proof-kind 闸判败**——证明"无计数的 proof-kind 机制"在**普遍**筛掉带交付证据的 run（**这 40 条不必都是错杀**：本事故就是 artifact 交付了描述层、深读却真欠交付；机制问题在于它对交付质量**不甄别**）。
- 磁盘 `V/`：仅 `110b543cd333-描述层完整报告.md`(8663B)，**无任何深读层文档**；`skill-runtime/outputs/image-deep-read/` 同理仅描述层产物。

## 3. 失败机制（因果结构，分三层，避免以症状充根因）

### A. 第二份文档未落盘 —— 两个**并列**直接原因（均 confirmed）
- **A1 写盘被拒**：07:51:52 / 07:52:47 两次 `skill_write_artifact` `issueCount=2 invalid_type relativePath` ⟹ `relativePath` 非字符串/缺失 **且** 第二个必填串（`content`，唯一另一必填）同时失败。既有 `path→relativePath` 别名 shim（`tool-input-validator.ts:42-59`）只补 `relativePath`、不碰第二字段，故对同形入参复跑仍 `safeParse` 失败、仍不写盘。深读文档从未成为磁盘文件。
- **A2 生成未完成**：末条 assistant（07:53:43.518）截断于 `**L3 `。按 image-deep-read 输出契约（**L2 意图 → L3 功能 → L4 判断 + 存疑清单**），本次只完成 L2；即便写盘成功，也只会存一份 L2 半成品。两次被拒写盘（07:51–52）**早于**深读正文出现（07:53:43），不能假定它们承载完整深读。
- **A1、A2 相互独立**：修好 A1（写盘）不产出 A2 缺的 L3/L4；补全 A2 也仍会被 A1 的 schema 拒。二者都要解。

### B. 终态 `proof_gap` 的真实机制 —— c1 结构性假阴性（confirmed，v1 曾误述）
- 裁决器对 `c1(steps_complete)` 的满足条件是 **proof-kind 命中**：`CRITERIA_PROOF_MAP.steps_complete=['run_state','task_event']`（`task-adjudicator.ts:42`），`:82` 仅 `presentKinds.has(kind)`，**从不读 steps_json**（故本 run 三步 steps_json 全 `done` 与 c1 判定无关）。
- inline reference/advisory 技能 run **只经 primitive 交付**（artifact/tool_result），**不产生 child run_state / task_event**（`proof-collector.ts:233`：此类 KIND proof 仅在真实 child run 下铸造）。故 c1 对该 run 形态**结构性不可满足**，且**不甄别交付质量**——完美两份文档同样判败（c2/artifact 在失败 run 里已满足）。
- 现有 `criteria-templates.ts:124-155` 已为同因把 `s1(skill_run_state)` 判 `notApplicable`，并有一段把 `c1` 判 NA 的逻辑；但该逻辑要求 `hasPlannedSteps !== true`（:141）——本 run 声明了计划步骤（`hasPlannedSteps===true`），恰被这道门槛排除，故 c1 保持 active 而判败。**这就是精确 bug 位点。**
- **定性更正**：拒绝这次 run 作为"结果"没冤枉它（它确实因 A1+A2 未完成）；但裁决器**并没有在校验完成度**，而是在对一整类 reference-skill run 无差别判败。"结果恰好对"≠"机制正确"。

### C. 系统性条件（为何模型会写坏参数、放弃、绕错路径）
- **上下文撕碎**（放大器，confirmed 现象）：**22 次压缩（其中 14 次单次丢 >38 条）**、中位 3.0× 窗口、单次丢中位 48 条，模型持续丢失刚读到的路径/入参格式（"导致 A1 双字段畸形"属强推断）。
- **单技能读根**（confirmed 现象，沙箱**行为正确**）：链式任务 floor 只授权最近技能（`skill_selected:image-deep-read`），另一技能参考读参被读根沙箱正确挡下，烧约 1/3 工具调用。属工效/覆盖缺口，非安全 bug。
- **非预算**：运行时预算 40、用 24（60%），未逼停（见 §0/§2 账本）。

## 4. 根因清单（按修复优先级，确信度标注）

| ID | 名称 | 责任层 | 确信度 | 与"链式任务失败"的因果 |
|---|---|---|---|---|
| **R-CRIT** | c1 `steps_complete` 对 skill-primitive run 结构性假阴性（proof-kind 闸 + `hasPlannedSteps` 门槛排除 NA） | 裁决/quality | 机制=100%（源码+proof 分布+台账）；"是终态失败根因"=100% | **直接决定终态**：不修，写盘修好 run 仍判 degraded。 |
| **R-WRITE** | `skill_write_artifact` 双字段畸形被 `invalid_type` 硬拒，纠正不可执行 | runtime 模块 | 失败发生=100%；具体第二字段=`content` 为最可能（不可 100% 取证） | **直接堵死写盘**（A1）。 |
| **R-GEN** | 深读正文截断于 L3（生成未完成，机制未定） | provider 输出/编排 | 截断=100%；机制（max-tokens/收敛/流断）=未定 | **直接**致 A2；即便写盘成功也只存 L2。 |
| **R-XREAD** | 链式引用的另一技能读根不可达（单技能授权 → 单技能读根） | runtime 模块（读根装配，非 floor 计算） | 现象=100%；"沙箱是 bug"=否（工效缺口） | 间接（烧预算、加剧 C）。 |
| **R-CTX** | 上下文膨胀未当硬约束：单 run 22 次压缩、中位 3.0× 窗口 | Agent 编排 | 现象=100%；"致 A1"=强推断 | 系统性温床。 |
| **R-LEDGER** | `run_meta.budget_json` 起点快照陈旧（`short_task/24`）≠ 运行时真值（`multi_step/40`） | Agent 编排（台账写点） | desync=100%；**运行时因果=无（已证伪）** | 纯观测/续跑种子一致性，与本次失败无因果。 |

**排序主张（本表按"因果直接性"排）**：R-CRIT + R-WRITE **并列 primary**（前者止终态、后者解写盘死锁，缺一不可）→ R-GEN → R-XREAD/R-CTX → R-LEDGER。companion 的落地顺序按"实施依赖与成本"排（R-CTX 调查前置、R-XREAD 殿后），两处轴不同、次序有别属预期，非矛盾。

## 5. 排除项 & 诚实存疑

**明确排除**
- **门禁（P3-2 shell 同意闸）**：技能无脚本、不需 shell；唯一调用软恢复非拒绝。放宽同意闸零影响。
- **预算逼停（原 R3 因果）**：运行时真值 40/用 24/`initiator=done`，**已证伪**。
- **Skill 内容本身**：规范；Step 1 成功。

**诚实存疑（留给下一轮评审）**
1. **R-WRITE 第二字段不可 100% 取证**：metrics 只记 `issueCount=2 firstPath=relativePath`，未记全部 issue 与入参；`content` 缺失/非串为最合理推断（其余必填只有它），但无入参直证。
2. **R-GEN 截断机制未定**：本 run 全程无预算/轮次耗尽 metrics 事件；max-tokens 截断 / 自报 done 后流中断 / 收敛逼收 三者皆可能，仅断言"生成未完成"这一**结果**，不断言终止**机制**。
3. **R-CTX 565–633K 构成未定量归因**：现有 `context_bill` 只记 prompt 装配段（≈31K），565K 是 provider 请求整体 items 计量（图片≈85K tokens/张为主嫌）；"图片每轮重发"待新 instrumentation 证实（见 companion R-CTX）。
4. **R-CRIT 的 NA 会误 accept 本 run（已核实，最关键未决）**：裁决器满足判定是**纯 proof-kind 集合成员、不计数**（`task-adjudicator.ts:80-95`：NA 项退出 `applicable` 分母，`satisfied<applicable` 才 degrade）。若把 c1 无条件判 NA：本事故 criteria 变为 `applicable={c2}`、`c2(artifact)` 已被 doc1 的 artifact 满足 → `satisfied={c2}` → `1<1` 为假 → **verdict=accept**，反把"只交付 1/2 文档"的欠交付重新遮蔽。**且任何 artifact/tool_result 可满足的判据都无法区分 1/2 与 2/2**（单条 proof 即满足）——要让"少交付一份仍判败"，必须引入**按计划产出计数**（steps_json 承载每文档预期 + 裁决器计数），这与 companion 自设的"不改 CRITERIA_PROOF_MAP/手术式"红线冲突。故 R-CRIT 是"无条件 NA"还是"补计数判据"是**真决策点（companion D-CRIT），未定**，直接决定修完后半截交付是否还被 accept。

## 6. 证据索引（便于评审复核）

- 裁决/quality：`task-adjudicator.ts:39-54`（CRITERIA_PROOF_MAP）、`:77-102`（proof-kind 满足判定）；`criteria-templates.ts:65-69`（c1 模板）、`:124-155`（s1/c1 NA 逻辑 + `hasPlannedSteps` 门槛）；`proof-collector.ts:26,233`（proof kinds、KIND proof 铸造条件）；`run-finalizer.ts`（终态收口）。
- 写盘：`primitive-schemas.ts:46,49`（**仅 `relativePath` 用 `TRIMMED_STRING`=`z.string().trim().min(1)`；`content` 是裸 `z.string()`**，空串合法 → `issueCount=2` 的第二个失败字段最可能是 `content` 缺失/非串）；`tool-input-validator.ts:42-59`（别名 `normalizeSkillArtifactPathAlias` 仅 `path→relativePath`）、**`:78-96`（校验失败输出组装：全部 issue 已入 `data.issues`@:78-84、`issueCount`@:93 已回吐模型，仅 human `text`@:87 用 firstIssue）**；`path-sandbox.ts:185-198`（`resolveWritableWithinRoot` 已接受根内绝对路径、根外仍 `path_escape` 拒）。**注**：`tool-executor.ts:441` 仅 `return outcome.output` 直通、作用域无 `parsed.error.issues`，非组装点。
- 读根（R-XREAD）：`root-resolver.ts:29-41`（单 skillId→roots）、`read-artifact.ts:54,124`（`resolveReadableExistingWithinAnyRoot` + `candidateRoots`）、`skills-tools.ts`（`additionalAllowedReadRoots` 源自 `frame.activeArtifactRoots`）、`agent-sdk-utils.ts:892-910`（envelope skill_reference 名单）。**注**：`capability-floors.ts:31` 只算"必在工具名集合"（`reasons.push('skill_selected:'+skillId)`），是**单技能授权的上游成因/日志证据**（对应 §2 row1），**非读根强制点**——勿误挂为读根机制。
- 预算：`run-budget-policy.ts:16-50`（预设 short=24/multi=40、`rebindTaskBudgetRuntime:329-351`）；live rebind `agent-sdk-utils.ts:490-505`（`resolveAgentSdkTaskBudgetRuntime`）+ `run-coordinator.ts:197`；`task-projection-sync.ts:609`（projection 预算落库，已正确=40）；`run_meta.budget_json` 写点 `run-finalizer writeRunMetaOutcome` + `run-meta-snapshot.ts`（EP2-T1 enrich，起点快照陈旧处）。**注**：`turn-state.ts:134 adoptResolvedTaskTypeBudget` **零调用=死代码**，勿当升级路径引用。
- 日志：M:1152-1281、T:540-543。账本：`run_meta`/`task_projections`。

## 7. 版本沿革（v1→v2→v3，审查修正留痕）

### v1 → v2（第 1 轮对抗审查）
1. **终态机制翻案**：v1 称"proof_gap 是裁决器正确 100% 拦下缺文档"——**证伪**。真机制=c1 proof-kind 结构性假阴性（不读 steps_json、reference-skill 不铸 run_state/task_event），对交付质量不甄别。→ §0/§3B/§4 R-CRIT。
2. **第二份文档双直接因**：v1 称"分析已进聊天、只缺写文件"——**过度断言**。深读正文截断于 L3（只到 L2）。→ §3A(A2)/§4 R-GEN。
3. **预算证伪**：v1 R3 称预算 `short_task/24` 收窄恢复空间——读了 `run_meta` 陈旧起点快照；运行时真值 `multi_step/40`、用 60%、未逼停。→ 降级为 R-LEDGER（台账一致性）。
4. **写盘双字段**：v1 只归因 `relativePath` 单字段；`issueCount=2` ⟹ `content` 亦失败。→ §3A(A1)/R-WRITE 契约。
5. **触点/机制误挂订正**：读根机制从 `capability-floors:31` 改到 `root-resolver`+`read-artifact.ts:124`；`adoptResolvedTaskTypeBudget` 标死代码。
6. **压缩统计订正**：`~2.8×` 是分布最小值；中位≈3.0×/597K、峰 3.17×/633K、单次丢中位 48/峰 78。

### v2 → v3（第 2/3 轮对抗审查 + 覆盖复审）
7. **R-CRIT 补计数难点**：核实裁决器纯 proof-kind 无计数——无条件 c1→NA 会把本事故（只交付 1/2）误 accept；"识别交付≠计数交付"，须按预期产出计数。§0 修复含义、§5.4、companion D-CRIT 同步。
8. **写盘 corrective 触点/前提订正**：组装点 `tool-input-validator.ts:78-96`（非 `tool-executor.ts:441`）；全 issue 枚举**已存在**、真杠杆是逐字段示例+点名全部失败字段；`content` 是裸 `z.string()`。
9. **R3 触点证伪细化**：真缺陷=`run-finalizer.ts:748 if(taskBudgetRuntime)` 条件写 budget（task_type 有 facts 兜底、budget 无）；删越界 LIVE clamp。
10. **证据/单位订正**：`41→40`；末条 assistant `4435 字（10349 字节）`（曾误作字节）；"40 条"改为机制表述（非全属错杀）。
