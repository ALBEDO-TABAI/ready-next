---
title: 链式技能信封修复实施契约（R-CRIT / R-WRITE / R-GEN / R-XREAD / R-CTX / R-LEDGER）
date: 2026-07-07
kind: implementation
enforce: true
status: revised-after-adversarial-review-round-2
depends_on: 2026-07-07-chained-skill-second-doc-diagnosis.md
verify_entry: 拟新增 npm run verify:skill-envelope-write（含 R-CRIT + R-WRITE gate）
principle: 先契约后代码；修根因不修症状；每项有可机器验证的合同与回归入口。
revision_note: >
  v2：原 R1/R2/R3/R4 大改——新增 R-CRIT（终态假阴性）/R-GEN；R-XREAD 修读根触点；R-LEDGER（原 R3）降级。
  v3（本版，round-2 修正）：R-CRIT 承认"无条件 c1→NA 会误 accept 欠交付"（裁决器纯 proof-kind 无计数），D-CRIT 升为 P0
  真决策（无条件 NA+另建欠交付检测 / per-step 覆盖计数）+ 欠交付回归测；R-WRITE 更正"枚举已存在"（真杠杆=逐字段示例+点名全部失败字段）、
  corrective 触点改 tool-input-validator.ts:78-96、content 裸 z.string()、gate red-first；R-LEDGER 删越界 clamp、真缺陷点 run-finalizer.ts:748。
---

# 链式技能信封修复实施契约（v3）

> 契约文档，未过对抗评审**不进入动手环节**（用户要求）。诊断与证据见 depends_on。
> 结构：问题重述 → 可验证契约 → 源码触点 → 变更方案 → 测试 → 回归 gate → 风险/回滚。

## 0. 范围与排序

诊断结论：第二份文档缺失有**两个并列直接因**（写盘被拒 A1 + 生成截断 A2），且**终态 `proof_gap` 是裁决器 c1 对 skill-primitive run 的结构性假阴性**——**修好写盘不足以消除终态失败**。

排序按"实施依赖与成本"（诊断 §4 按"因果直接性"排，次序有别属预期）：
- **P1（并列 primary）**：**R-CRIT**（让终态裁决**正确处理** skill-primitive run——**D-CRIT 已定=方案 b：裁决器加"已交付覆盖计数"**，既消除完整交付的假阴性、又让欠交付 1/2 仍判败，避开无条件 NA 的误 accept）+ **R-WRITE**（**解除 A1 写盘死锁、让写盘可恢复**；注：校验 issue 已回吐模型、非落盘保证，落盘还依赖 R-CRIT/R-CTX/重试）。二者缺一：只修 R-WRITE，run 仍判 degraded；只修 R-CRIT，第二份文档仍写不出。
- **P2**：R-CTX 调查（新 instrumentation，只取证不改行为）。
- **P3**：R-GEN（生成截断，调查后定）；R-LEDGER（台账一致性）。
- **P4**：R-XREAD（工效，可选，取决于 R-CRIT+R-WRITE 是否已让链式任务通过）。

**红线**：不放宽裁决**阈值**。"让判据识别 skill-primitive 交付"**不等于**能计数交付——现裁决器纯 proof-kind 成员判定、无计数，单条 artifact 即满足 c2，故**无法区分交付 1/2 与 2/2**；要保住"少交付一份仍判败"须按计划产出计数。**D-CRIT 已定=方案 b（2026-07-07 用户拍板）**：在 skill-primitive c1 覆盖计数**这一条路径**上，`CRITERIA_PROOF_MAP` + `steps_json` 预期产出 schema 本轮**在 scope**、红线相应显式放开（详见 §7）；非 skill / 其它 criteria kind / 带 run_state 句柄的 skill run 仍原样不动。不改两个 custom 技能内容。手术式改动。

---

## R-CRIT · 让终态裁决正确处理 skill-primitive run（primary；**D-CRIT 已定=方案 b·裁决器覆盖计数**）

### 问题重述
`c1(steps_complete)` 满足条件是 proof-kind 命中 `['run_state','task_event']`（`task-adjudicator.ts:42`；`:80-95` 满足判定是**纯集合成员、不计数**）。inline reference/advisory 技能 run 只铸 artifact/tool_result、**永不铸 run_state/task_event**，故 c1 结构性不可满足（台账：`multi_step_task` `proof_gap×69`，40 条带 artifact 仍判败）。`criteria-templates.ts:151-155` 已有把 c1 判 NA 的逻辑，但 `stepsStructurallyUnavailable` 要求 `hasPlannedSteps !== true`（:141）——声明了计划步骤的 skill-primitive run 被排除，故 c1 保持 active 判败。这是 `s1` 已判 NA（:144-149）而 c1 未判的不对称。

### ⚠️ 核心难点（审查确诊，决定本节成败）
"让判据**识别** skill-primitive 交付"**不等于能计数交付**。已沿 `task-adjudicator.ts:80-95` 逐行核实：NA 项退出 `applicable` 分母，`satisfied<applicable` 才 degrade，满足纯 proof-kind 成员、**无计数**。
- 若把 c1 **无条件判 NA**：本事故 criteria 变 `applicable={c2}`、`c2(artifact)` 已被 **doc1** 的 artifact 满足 → `satisfied={c2}` → `1<1` 为假 → **verdict=accept**，**反把"只交付 1/2 文档"的欠交付重新遮蔽**（正是诊断要暴露的）。
- 且 `CRITERIA_PROOF_MAP` 里所有 artifact/tool_result 判据**单条 proof 即满足**，故**没有任何现有判据能区分交付 1/2 与 2/2**——"换一个可被 primitive 满足的判据"同样区分不了。要"少交付一份仍判败"，**必须引入按计划产出的计数**。

### 决策点 D-CRIT（**动手前必须拍板；(a)/(b) 都需"已交付计数"，区别只在计数放哪**）
- **(a) 无条件 NA + 另建欠交付检测**：c1→NA 从 reject-all 变 accept-all，欠交付另建机制兜。**⚠️ 审查确诊：(a) 并非"免计数/更轻"**——两个直觉写法都被证伪：① "每份预期产出下发一条判据"仍被**同一条** doc1 artifact 满足（裁决器纯 kind-Set 成员 + model 追加判据固定 `kind:'artifact'`，`criteria-templates.ts:188`），区分不了 1/2 与 2/2；② "artifact proof 计数 ≥ 预期"被中间产物击穿（本事故 `artifact×32`、去重后仍 32 条路径、多为 skill-runtime 中间写盘，`32≥2` 恒真）。故 (a) 真正需要**按目标目录/预期去重的"已交付产出"计数器**（依赖最终交付识别 + `steps_json` 承载预期），与 (b) **同量级**。
- **(b) 裁决器 per-planned-step 覆盖计数** ✅ **【已选定，2026-07-07 用户拍板】**：scope-in"每计划产出是否有对应**已交付** artifact"的计数判据替换 c1；需 `steps_json` 承载每文档预期产出（**当前不含**，`TaskStep` 无 expectedOutput 字段）+ 裁决器计数逻辑。红线已按 §0/§7 显式放开（限本路径）。
- **真正的分野**：不是"NA vs 计数"，而是"已交付覆盖计数放在**独立检测器**(a) 还是**裁决器判据**(b)"——两者都逃不掉"最终交付识别 + 预期承载"。**结论=(b)**：计数落裁决器判据。C-CRIT 契约与测试据此**转为 committed**（不再 provisional）。

### 可验证契约（C-CRIT，committed=方案 b）
1. **完整交付的 skill-primitive run 不再被 c1 假阴性判败**（两方案共同目标）。
2. **欠交付仍判败**（区分方案 a/b 的核心）：交付 <预期产出数 的 skill-primitive run **必须** `verdict≠accept`。
3. **边界**：仅 `module==='skill' && !skillHasChildRunState`；`CRITERIA_PROOF_MAP` 若动须显式声明（方案 b）；`document`/`system`/`browser` 与带 run_state 句柄的 skill run **逐字节不变**。
4. **可观测**：落 `adjudicator_criteria_resolved{item:'c1', module:'skill', mode:'na'|'coverage_count', delivered, expected}`。

### 源码触点
- `criteria-templates.ts:136-155`（c1 NA/覆盖判据装配、`hasPlannedSteps` 门槛）。
- `task-adjudicator.ts:80-95`（`applicable`/`satisfied`/degrade；方案 b 在此加计数）。
- 方案 b 附加：`steps_json` 产出 schema（承载每文档预期）+ 其写入侧（projection/plan）。
- `CRITERIA_PROOF_MAP`（`:39-54`）：方案 a 不动；方案 b 动则改红线。

### 测试
- **欠交付回归测（最关键，两方案都必须过）**：`module=skill`、`hasPlannedSteps=true`、预期 2 产出、**artifact proof 多条（含中间写盘）但仅 1 条命中预期交付路径**（**忠实还原本事故的 `artifact×32`/1 交付形态，不可写成"1 条 artifact"**——否则裸计数 `1<2` 判红=假绿，而真事故 `32≥2` 仍会误 accept）→ 断言 `verdict≠accept`。**注**：P1 的 e2e（复跑落 2 文档）只驱动全成功路径、**抓不到此回归**，故必须有此独立单测。
- 完整交付测：预期 2、实际 2 artifact、无 run_state → 断言 `verdict=accept`。
- 零扰动测：`document`/带 run_state 句柄 skill run c1 判定逐字节不变。

### 回归 gate
- `scripts/check-skill-primitive-criteria-coverage.cjs`：断言欠交付 skill-primitive run 不 accept、完整交付 accept、非 skill 不变。red-first。

### 风险 / 回滚
- 风险：方案 a 若欠交付检测没接好 → 退化成 accept-all（本事故会误 accept）。缓解=契约点2 的欠交付回归测为准入硬门。
- 回滚：criteria-templates（+方案 b 的 adjudicator 计数）分支，删即回退到现状（c1 结构性判败）。

### 实现状态（P1 落地 + 对抗评审 round-1，2026-07-07）
**已落地=方案 b 消费侧（consumer）**：`delivery_coverage` 判据 + `resolveDeliveryCoverage`（task-adjudicator.ts）+ resolveCriteria 转换 + finalizer `deriveCoverageTargets` 读 `steps_json.expectedOutputs` + `adjudicator_criteria_resolved` 观测；`TaskStep.expectedOutputs` 双定义 schema round-trip。单测/gate 全绿。

**关键设计更正——单调（monotonic）无 fail-open**（评审 round-1 major 修正）：no-target 的 skill-primitive run **不再判 NA**。原设计"无声明预期→c1 判 NA→靠 c2"会**fail-open**：NA 把 c1 移出 applicable，单条 c2 artifact 即 accept 一个不可验证的交付——正是把本事故（欠交付）**误 accept** 的方向。改为：**只在声明了预期产出（coverageTargets 非空）时转 delivery_coverage 计数；无声明时 c1 原样保持（pre-P1 的 steps_complete，仍非 accept）**。因此 P1 **只增不减**（有 target 时加辨别力，无 target 时保持旧判据），不引入回归。

**producer 明确 owned 为 cross-phase（未接线）**：现无任何代码向 `TaskStep.expectedOutputs` 写值（skill 任务走 `domain_executor` 非 `planner`，`buildPlannerSteps` 不产它；`skill-task-tracker` 事件派生步骤无此字段）。故 live 运行 `coverageTargets=[]` → c1 保持旧判据 → **本事故 live 仍按 pre-P1 判（非 accept），不因 P1 变差**。方案 b 的**辨别力（catch 欠交付）在 producer 接线后才 live**；producer 是"expected 交付数=判断题（模型定），计数=代码"的架构，走 cross-phase（可选 model-declared 或谨慎确定性信号，须避免"2 技能 1 文档"的 over-demand 误判）。P1 交付=consumer + 单调默认，**不 dark 成 fail-open、也不假称已 live 修好本事故**。

**matcher 加固**（评审 round-1 修正 dup/greedy/loose/vacuous 四项）：`resolveDeliveryCoverage` 先按规范化路径**去重**（一份真实文件的多条 proof 至多覆盖一个 target）→ **最大二部匹配（Kuhn）**（贪心会饿死受限 target 而误拒完整交付）；`deliveredSatisfiesTarget` **路径锚定**（bare basename 仅当 target 无目录段才匹配，防他处同名中间产物冒充全路径 target）；`expected===0`（声明规范化后全空）**不再 vacuous accept，判不满足**。producer-filter 与 adjudicator 共用 `normalizeDeliveryTarget`（criteria-templates 导出）避免过滤口径分歧。残留（cross-phase producer 同期硬化）：delivered 集含 collector 收割的辅助路径（run_state/report），dir-target 会被同目录辅助文件满足——producer 应发**具体文件/路径 target 而非裸目录**，或 delivered 集收敛到真交付 proof。

---

## R-WRITE · 写盘纠正可执行化（解除 A1 死锁，primary；非落盘保证）

### 问题重述
第二份文档写盘两次 `issueCount=2 invalid_type firstPath:relativePath`（M:1260/1262）。`skill_write_artifact` 必填 `relativePath`（`TRIMMED_STRING`）+`content`（**裸 `z.string()`**，空串合法），`issueCount=2` ⟹ 第二个失败字段最可能是 `content` **缺失/非串**（`undefined`→`invalid_type`）。**关键更正**：既有校验失败输出**已把全部 issue 回吐模型**（`tool-input-validator.ts:78-84` 装 `data.issues`、`:93` `issueCount`），仅 human `text`（`:87`）用 firstIssue。事故 `issueCount=2` 证明**模型当时已拿到两个畸形字段的完整枚举、仍连吃两拒后放弃**——**枚举不是缺失杠杆**。故 R-WRITE 只能把纠正**更可执行**、降低模型放弃概率，**不是落盘保证**（落盘还依赖 R-CRIT 终态 + R-CTX 上下文 + 重试）。

### 可验证契约（C-WRITE）
1. **别名扩展（键位收敛，预防性）**：在 `normalizeSkillArtifactPathAlias` **函数体**内扩源键——现仅 `relativePath` 无效时取 `path`，增补 `file/filePath/output_path/outputPath`。**注**：`SKILL_ARTIFACT_RELATIVE_PATH_TOOLS`（`:20`）是"哪些工具走别名"的**工具名集**、非源键白名单，勿改错对象。别名仅在 `relativePath` 非有效串**且**某源键有效时触发；事故精确入参未取证，故此扩展**预防性**、非事故确证杠杆。`content` **无替代键**，不做别名。
2. **纠正更可执行（非"新增枚举"——枚举已存在）**：新增工作是 (a) 对**每个**失败字段给规范形态示例（`relativePath`=相对技能输出根的字符串；`content`=字符串；`encoding∈{utf-8,base64}`；`mode∈{overwrite,append}`）；(b) human `text`（现仅 `firstIssue`@:87）**点名全部失败字段**；(c) 显式指路"落用户绝对目录：先 write 到技能输出根、再 `skill_export_artifact` 到 `targetPath`"。
3. **validator 保持无根**：root-aware 路径解析只在 handler（`resolveWritableWithinRoot` 需 `(root,path)`；validator 刻意无 electron/无 root，签名被 `tool-executor-contract.test.ts` 钉死）。**不做**"根内绝对路径在归一层收敛"——`relativePath` 是非空串校验、绝对路径不触发 `invalid_type`，且根内绝对已由 handler（`skills-tools.ts:197`/`write-artifact.ts:124`）接受，属 no-op。
4. **安全不回退**：根外绝对、`~/`、`..`、保留文件名仍由 `path-sandbox.ts` 原样拒。

### 源码触点
- `tool-input-validator.ts:52-57`（`normalizeSkillArtifactPathAlias` **函数体**扩源键，**非**改 `:20` 的工具名集 `SKILL_ARTIFACT_RELATIVE_PATH_TOOLS`）**与 `:78-96`（纠正组装：`data.issues` 已全枚举、在此加逐字段示例 + human `text`@:87 点名全部失败字段）——corrective 工作是这一个文件。
- `primitive-schemas.ts:46,49`（`.describe()` 文案强化；**`content` 是裸 `z.string()`、无 `min(1)`**，勿误写）。
- **注**：`tool-executor.ts:441` 仅 `return outcome.output` 直通、作用域无 `parsed.error.issues`，**无需改动**（订正 v2 误挂）。

### 测试
- 单测（确定性，还原事故形态）：`{relativePath 缺失/非串} + {content 缺失/非串}` 参数化 → 断言别名补 `relativePath`、`safeParse` 仍因 `content` 失败、`data.issues` 含两字段、human `text` **点名 content 且带示例**、**未写盘**；`encoding:'utf8'` → `text` 点名 encoding。
- 反例：根外绝对路径 → 仍 `path_escape` 拒（安全回归）。

### 回归 gate
- `scripts/check-skill-artifact-write-corrective.cjs`（**red-first**：先证明对现状为红）：断言别名白名单已扩、human `text` 含全部失败字段名 + 逐字段示例（**非**断言"枚举存在"——那已是现状、零改动即过=no-op）、非串 `content` 仍 `safeParse` 失败且不写盘。

### 风险 / 回滚
- 风险：别名过宽把用户本意 export 的写盘静默改道 → 别名只在 `relativePath` 缺失时填充；export（有 `targetPath`）不触发 write 归一。
- 回滚面（订正 v2 误挂）：改动落**两处**——`tool-input-validator.ts`（别名 + 纠正文案）与 `primitive-schemas.ts`（`.describe()`）；`tool-executor.ts` **不涉及**。二者各自独立可还原。

---

## R-GEN · 深读生成截断于 L3（调查后定，P3）

### 问题重述
末条 assistant **4435 字（10349 字节）** 截断于 `**L3 `，深读只到 L2（L3 功能/L4 判断/存疑清单缺）。机制未定：max-tokens 截断 / 自报 done 后流中断 / 收敛逼收 皆可能，本 run 无预算或轮次耗尽 metrics 事件可锁。

### 第一阶段调查（C-GEN-a，只取证）
- 复核末轮 provider 响应的 `finish_reason`/`stop_reason`（是否 `length`/max_tokens），与该轮 `max_tokens` 设定；确认截断是**生成侧**（provider 截断）还是**装配侧**（落库/展示上限，已初步排除：同类消息他处达 **26199 字节**、无上限）。
- 若为 max_tokens：定位链式长产出轮的 `max_tokens` 计算，评估是否对"多文档深读"轮偏小。

### 第二阶段（按调查结论，不预设）
- 若 max_tokens 偏小 → 对长产出轮放宽/分段续写（`mode:'append'` 已支持长文档补尾）。
- 若流中断/自报 done → 复核编排纪律**能否覆盖非零工具截断**：本 run 24 次工具调用、**非零工具宣告**，既有"零工具行动宣告不判 done"纪律**不直接适用**，须扩成"截断/生成未完成也不得判 done"。

### 风险
- 放宽 max_tokens 抬 token 成本；须限定长产出轮，附成本对照。

---

## R-XREAD · 链式技能读根覆盖（工效，可选，P4）

### 问题重述
链式任务 floor 只授权最近技能，read primitive 只对该技能 `artifactRoot+assetRoot` 放行；模型执行 Step 1（另一技能方法论）读其参考被读根沙箱**正确**挡下，烧约 1/3 预算。沙箱行为正确——工效/覆盖缺口，非安全 bug。

### 触点订正（v1 指错函数）
- **真正接入点**：`read-artifact.ts:54`（`resolveReadableExistingWithinAnyRoot`，**存在性感知**）+ `:124`（`candidateRoots=[artifactRoot,...additionalRoots,assetRoot]`）；`additionalRoots` 供给在 dispatcher `skills-tools.ts`（`additionalAllowedReadRoots`，源自 `frame.activeArtifactRoots`）；envelope 技能名单 `agent-sdk-utils.ts:892-910`；根解析 `root-resolver.ts:29-41`。
- **勿用** `path-sandbox.ts:259 resolveReadableWithinAnyRoot`（存在性盲，只服务 `skill_inspect_run_state`）——否则次级 assetRoot 存在的相对引用会误 `not_found`。

### 决策点 D-XREAD（三选一，默认倾向 b）
- (a) 扩 `SkillToolAuthorization` 携次级只读技能引用（改动最大、触授权模型）。
- (b) read primitive `additionalRoots` 增补"本 envelope 内其它 `skill_reference` reference-kind 技能的 `assetRoot`"（**只读**、只加 assetRoot、不含写根）。中等、隔离于授权模型。
- (c) 不改沙箱：链式所需参考在上下文装配阶段内联（最轻但加重上下文，与 R-CTX 相悖）。

### 契约（若采 b）/ 测试 / 风险
- 只读根并集只含 reference-kind assetRoot；写根不变；单技能 envelope 零扰动。
- 单测：双技能 envelope → 次级 assetRoot 可读、写根不可写、单技能零扰动。
- 风险：只读信息面扩大 → 限 reference-kind + 只读 + 同 envelope 显式引用。

---

## R-CTX · 上下文膨胀（新 instrumentation，P2 调查）

### 问题重述
单 run 22 次压缩、`beforeTokens` 中位≈597K/峰 633K（≈3.0–3.17× 200K 窗口）、单次丢中位 48/峰 78 条。疑：3 次重试历史累积 + 每轮重发图片（图片≈85K tokens/张）+ 双技能材料。构成未定量归因。

### 第一阶段（C-CTX-a，新增 instrumentation）
- **新增**（勿复用 `context_bill`）：`context_bill` 现仅记 prompt 装配段 UTF-8 字节（≈31K，run 起点 2 条、无 vision/history/tool、非每轮）；565K 是 `estimateInputItemTokens` 对整个 provider 请求 items 的每轮计量。→ **新增** `provider_request_bill{runId, turn, sections:{vision,history,tool_results,skill_inline,reminders}}`，每次 provider 调用前落。
- 判定"同一图片是否每轮重发进 provider 请求"（可修接线）vs"历史自然累积"（压缩策略范畴）。

### 第二阶段（按结论择一）
- 主因=图片重发 → 只在需 vision 的轮携带图片，余轮引用/摘要占位。
- 主因=重试历史累积 → 重试/继续时定向裁剪上一轮失败上下文，非全量继承。

### gate（分两步）
- P2 立即可验：`check-provider-request-bill-sections.cjs` 断言 `provider_request_bill` 含分来源字段。
- P4（阈值产出后）：单轮 `beforeTokens` 阈值断言（基线取峰 633K/3.17×）；阈值未定前该断言标 skip/inactive，**不得**让单一 gate 把未定阈值当 active pass/fail。

### 风险
- 误裁图片/历史损伤分析质量 → 先调查定主因，改动附"分析完整性"对照测（同图跑改前/改后，产物结构一致）。

---

## R-LEDGER · run_meta 预算快照一致性（台账卫生，P3；原 R3 降级）

### 问题重述（v1 因果证伪）
运行时预算真值 `task_projections.budget_json=multi_step_task/40`、用 24（60%）、`bootstrapBudget=false`——**已 rebind、未逼停**。仅 `run_meta.budget_json` 仍是起点快照 `short_task/24/bootstrap=true`。这是 **run_meta 起点快照未随运行时 rebind 回写**的台账不一致，**对第二份文档未落盘无运行时因果**；价值在观测一致性 + 跨进程续跑种子正确性。

### 可验证契约（C-LEDGER）
1. **快照忠实回写运行时真值**：终态把 `run_meta.budget_json` 回写为**运行时 `taskBudgetRuntime` 真值**（taskType/数值/usage），使 `run_meta.budget_json.taskType == run_meta.task_type == run_close.taskType`、且数值/usage 与 projection 一致。**只忠实回写、不 clamp、不改写运行时预算**。
2. **真正缺陷点（订正 v2 越界）**：`run-finalizer.ts:748` 的 `if (taskBudgetRuntime)` 使 budget 仅在运行时存在时写；而 task_type 有 `facts?.taskType` 兜底（`:744`）、budget 无兜底 → 终态缺 `taskBudgetRuntime` 时 budget 停在起点种子（事故 `budget_json.used:0/bootstrap:true` 即此）。修复=终态缺 `taskBudgetRuntime` 时，budget **从 `task_projections` 行读回**（已含运行时真值 40，`task-projection-sync.ts:609`）并回写 run_meta——**兜底源明确为 projection 行**（`task_type` 的 `facts?.taskType` 兜底走另一路、勿混为 projection）。
3. **不越界**：**不**给 LIVE `rebindTaskBudgetRuntime` 加 `max`/clamp（那是运行时共享路径、与 §7"不抬预算上限"相抵、对本事故 24→40 升解析是 no-op）；**不**复活死代码 `adoptResolvedTaskTypeBudget`。
4. **无运行时因果声明**：文档与 gate 均不得据此声称"修复第二份文档"。

### 源码触点（v2 触点越界，收敛到 run_meta 写点）
- `run-finalizer.ts:715-751 writeRunMetaOutcome`（`:748 if(taskBudgetRuntime)` 条件写 budget、`:744` task_type 有 facts 兜底）+ `run-meta-snapshot.ts`（EP2-T1 enrich）——补 budget 侧兜底、回写运行时真值。
- **不改**：已正确的 `task-projection-sync.ts:609`（projection 预算=40）；LIVE rebind `agent-sdk-utils.ts:490-505`。
- **标死代码**：`turn-state.ts:134 adoptResolvedTaskTypeBudget`（零调用），勿当升级路径引用。

### 测试 / gate
- 行为测：bootstrap short_task 起、rebind 到 multi_step/40/used24、终态 `taskBudgetRuntime` 缺失 → 断言 `run_meta.budget_json` 回写为 40/used24（非停在 24/used0）、`taskType==task_type==run_close.taskType`。
- `check-run-budget-tasktype-parity.cjs`：断言三源 taskType 收敛、`run_meta.budget_json` 忠实等于运行时真值（**不**断言"单调不缩"——那是 clamp 语义，已删）。

---

## 6. 分阶段落地 + 验收

| 阶段 | 内容 | 独立验收 | verify 挂载 |
|---|---|---|---|
| **P0** ✅ **已关闭** | **D-CRIT 已定=方案 b**（裁决器 per-step 已交付覆盖计数替换 c1）——2026-07-07 用户拍板 | ✓ 决策成文；红线已同步放开（限 skill-primitive 覆盖计数一条路径，§0/§7） | — |
| **P1** ✅ **已落地（consumer + 单调默认；producer=cross-phase）** | R-CRIT（消费侧+单调无 fail-open）+ R-WRITE（并列）。经对抗评审 round-1（9 findings 全修：dup/greedy/loose/vacuous matcher 四项 + fail-open 单调化 + output_path export 隔离 + gate/test 加固） | **P1 硬门只含①②**：①`check-skill-primitive-criteria-coverage.cjs`（含**欠交付回归**：模拟"多中间 artifact/仅 1 交付"必不 accept）+`check-skill-artifact-write-corrective.cjs`（red-first）绿；②确定性单测绿（R-WRITE 归一/纠正、R-CRIT 覆盖判据+dedup+最大匹配）。**注**：live catch 欠交付待 producer（cross-phase）；P1 为单调（有 target 计数、无 target 保持 pre-P1 非 accept） | `verify:skill-envelope-write`（绿） |
| P2 | R-CTX 调查（加 instrumentation，不改行为） | `check-provider-request-bill-sections.cjs`：`provider_request_bill` 分来源字段存在可读；主构成结论回填诊断 §5.3 | 并入上链只读断言 |
| P3 | R-GEN（调查后定）；R-LEDGER parity | R-GEN `finish_reason` 结论成文；`check-run-budget-tasktype-parity.cjs` 绿 | 并入 verify 链 |
| P4 | R-CTX 阶段二 + R-XREAD（若评审采纳） | 对照测（产物结构不劣化）+ 跨技能读根 gate（名 `check-skill-crossref-read-root.cjs`，仅 R-XREAD 采纳时立） | 同上 |
| **跨阶段（P1+P3+P4 落地后）** | **run 级 e2e**（非 P1 单独硬门） | 真机复跑本任务：第二份文档落 V **且** `run_close terminalReason=done`——**依赖 R-CRIT+R-WRITE+R-GEN(+R-CTX)+模型重试**，若 R-GEN 截断是确定性 max_tokens 则须待 P3，故不作 P1 准入 | — |

**每阶段提交前**：`npm run typecheck` 0 错；涉持久化跑 `npm run verify:native`；关键链路基础回归。
**P1 验收硬指标**：区分 R-WRITE 确定性交付（别名扩展 + 逐字段示例/点名全部失败字段的纠正 + 非法入参不写盘）与 e2e"第二份文档落 V 且终态 accept"（依赖 R-CRIT + 模型重试 + R-GEN/R-CTX）——后者是 R-CRIT+R-WRITE+R-GEN 的**联合**验收，非任一单点保证；且 R-WRITE 已确证"枚举非缺失杠杆"，故其确定性交付**只保证纠正更可执行、不保证落盘**。

## 7. 明确不做（out of scope 本轮）
- 不放宽 `proof_gap` 判定**阈值**。注意：R-CRIT 让"完整 skill-primitive 交付不再假阴性"，但**要保住"少交付一份仍判败"须计数**——这不是降门槛而是补计数（D-CRIT）。
- 不改两个 custom 技能内容。
- 不重构 `SkillToolAuthorization`（除非 R-XREAD 评审选 a）。
- 不抬任何 task_type 预算上限（R-LEDGER 只忠实回写 run_meta 快照，**不 clamp、不改运行时预算**）。
- 非 skill 模块 / 带 run_state 句柄的 skill run 的 c1 判定不变。**D-CRIT=方案 b：本轮在 scope 触碰 `CRITERIA_PROOF_MAP`（新增 skill-primitive 覆盖计数 kind）+ `steps_json` 每文档预期产出 schema——红线据此显式放开，但严格限定在 skill-primitive c1 覆盖计数一条路径；非 skill / 其它 criteria kind / 带句柄 skill run 仍原样不动**。

## 8. 决策点汇总（对抗评审需拍板）
- **D-CRIT ✅ 已定=方案 b（2026-07-07 用户拍板）**：已交付覆盖计数落**裁决器判据**（非独立检测器）。缘由：(a) 的两种直觉写法（每产出一判据 / 裸 `artifact 计数≥预期`）都被证伪（前者被同一 artifact 满足；后者被中间产物 `32≥2` 击穿），(a)/(b) 都需"最终交付识别 + `steps_json` 承载预期"、成本同量级，故取更内聚的 (b)。本轮据此改 `CRITERIA_PROOF_MAP` + `steps_json` schema（红线限本路径放开）。准入硬门=忠实还原事故（多中间 artifact / 仅 1 交付）的"1/2 必不 accept"回归测（P1 e2e 抓不到）。
- **D-XREAD**：(a)/(b)/(c) 或**不做**（若 R-CRIT+R-WRITE 已让链式任务通过，R-XREAD 可省）。
- **D-CTX**：565–633K 主构成？图片每轮重发是否成立？→ 定 R-CTX 阶段二方向与阈值。
- **D-GEN**：`finish_reason` 是否 `length`？决定 R-GEN 走 max_tokens 放宽还是编排"不判 done"复核。
- **D-LEDGER**：R-LEDGER 是否本轮做（纯台账、无因果）——可延后。**注**：R-LEDGER 改 `run-finalizer.ts`、R-CRIT 改 adjudicator/criteria-templates（finalizer 只消费 verdict），**非同文件**，无"顺带"节省。
