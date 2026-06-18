# Findings — video-expert-analyzer vnext "没法续做也没一次完成"

> 诊断日期：2026-06-18 ｜ 工具：ready-debug（账本巡检 + 产物层 run_state + 技能脚本 + git 溯源）
> 分支：agent-evolution/phase1 ｜ 状态：**仅诊断，未改代码**
> 触发：Codex 修好远程发送后，回头跑 video-expert vnext，既无法一次跑完、也无法续跑。

---

## 0. 头条结论（confirmed）

**根因在 skill 自己的 finalize 阶段——视听剖析（audiovisual）报告过不了"prompt 保真度"硬校验，且这条失败没有修复回环，于是 finalize 死锁在 `blocked`。** 不是远程发送的回归，也不是 G0 判定器的 bug。

> 65/65 场景已全部打分（coverage 1.0），管线走到最后一步 `finalize`，**只差视听剖析 MD/PDF**。视听剖析校验先被一个**标题匹配误判**挡住：prompt 要求 `### 意识形态"自然化"评估`，产物实际写了 `### 意识形态“自然化”评估`，只是直引号/弯引号不同；校验器按字面匹配，误报"缺子条目"。同时，错误被首个 `raise ValueError` 截断，后面真实存在的字数/Scene 证据不足没有一次性暴露；这条失败又被 `ai_analyzer.py` 的**通用 `except` 当成终态错误**标 `blocked`，没有转成可续的 handoff 修复回环。所以：
> - **一次跑不完**：最后一步被保真度校验硬挡，且 65 场景的成果全卡在门口。
> - **续不动**：`blocked` 是确定性失败，重跑 finalize 会**原样再撞同一面墙**（不是偶发，是必现）。

**两个症状是同一个根因的两面。** G0 这轮新上的 `proof_gap` 终态是**如实**反映"skill 任务 blocked、未 done"，属正确行为——它只是让这个本就存在的 skill 死锁**变得可见**了。

---

## 1. 证据链

### 1.1 产物层 run_state.json（最硬的一手证据）
`…/[开眼视频App] 日本高考…/run_state.json`（15:42 写）：
```json
{ "version": "vnext", "status": "blocked", "current_stage": "finalize",
  "total_scenes": 65, "completed_scenes": 65, "coverage_ratio": 1.0,
  "next_batch": null, "can_finalize": false,
  "last_error": "视听剖析生成失败：Prompt fidelity failure: ## 品牌符号学与意识形态分析: 缺子条目 ### 意识形态\"自然化\"评估",
  "verification": { "missing_outputs": ["audiovisual_md","audiovisual_pdf"], "passed": false } }
```
- 全部场景打分完成、`next_batch:null` → **重活都干完了**，只卡在 finalize 的视听剖析。
- `missing_outputs` 只有 `audiovisual_md/pdf`；磁盘上**确无** audiovisual MD/PDF（生成被校验拦下、从未落盘）。
- 第二个视频（纯AI生成的TVC）run_state 同病：`blocked` @ 15:30。**复现稳定。**

### 1.2 失败来自保真度校验：先有误判，后有真实缺口
- `scripts/audiovisual/reporting/template_engine.py:1365` `extract_prompt_fidelity_rules(prompt_text)`：**必需章节/子条目是从 prompt 模板里抽出来的**（品牌广告走 `chart/file-Prompt/ad-brand-campaign-storyboard-analysis-prompt.md`，该文件确含"品牌符号学/意识形态/自然化"）。
- `template_engine.py:2072-2077`：子条目用 `f"### {title}" not in present_subs` 做字面匹配，没有对直引号/弯引号、全半角、空白做归一化。历史产物的 `validation_errors.json` 里可见 `### 意识形态“自然化”评估` 已存在且字数达标，因此 run_state 里的"缺子条目"是**校验误判**。
- 校验函数一遇到第一类错误就 `raise`，没有继续收集后续失败。翻看同一份 `validation_errors.json`，除误判外还存在真实缺口：例如 `## 媒介语境与 Campaign 生态位分析` 的 distinct Scene 数不足；另一个视频还有模块字数不足、Scene 证据不足。当前机制把这些都遮住了。
- LLM 产物**确实生成了内容**（命中父章节并写出目标子节）→ 说明**远程/openclaw 传输不是病因**，病因在校验/修复/收尾链路。

### 1.3 失败被吞成终态 blocked，而不是修复回环
- `scripts/ai_analyzer.py:1994-2028` finalize 段有两条出口：
  - `except AudiovisualHandoffPending`（:2001）→ 写 handoff 任务包、标 blocked、提示"读取并完成后**重新运行 finalize**"——**这是设计好的可续 handoff**。
  - `except Exception`（:2023）→ `视听剖析生成失败：{exc}` → 标 blocked。**保真度 ValueError 落到这条**，是**死路**：不生成"补这一子节"的 handoff 包，agent 没有可执行的修复出口。
- `scripts/audiovisual/reporting/handoff.py:88` `AudiovisualHandoffCoordinator`：handoff 本是可续机制（agent 填产物→重跑→读缓存）。**但保真度校验在产物组装阶段、走的是通用 except，没有回灌进 handoff 协调器再派一轮。**
- 磁盘 `audiovisual_handoff/` 不是完全空：只有 `body/validation_errors.json`。但缺 `receipt.json`、`brief.md`、`body/task.md`，也没有可被 Ready 读取的修复任务登记；因此对产品来说仍是**不可续**。

### 1.4 近因：最近一次大改正好在这块
`git log` 最近触及该组件的提交 **`648495ce "Fix video analysis report generation gaps"`**：
- `template_engine.py +279`、`builder.py +253`、`handoff.py`、`SKILL.md +13`（外加两份 fix 计划文档）。
- 即**视听剖析报告 + 保真度校验刚被大改/收紧**。强一致于"以前能用、这轮回头来用就卡死"——校验变严但**缺配套的修复回环**。

### 1.5 续跑账本（修正一处自身误判）
- ⚠️ **更正**：先前用 `updated_at/1000` 查 `skill_task_runs` 得到 "1970"，是**查询把 ISO 文本列当毫秒数除**的假象；原值是正常 ISO（`2026-06-18T07:42:33Z`=本地 15:42）。**没有时间戳坏档这个 bug。**
- 真实账本（`skill-task-run-repository.ts`）：
  - `child_run` 行（vh1rxrxow / vrufczv8l）`resume_payload_json.childRun.status=blocked` 且 **childRunId 句柄在**——durable handle 完好，**理论可续**。
  - 但有多条 `typed_action` 行卡 `running`、`run_id=<NULL>`、无 `finished_at`（每次重试新建一行、never 终态）→ **孤儿 running 行堆积**；续跑/活跃查询 `status IN ('queued','running','blocked') ORDER BY updated_at DESC` 会被这些孤儿污染、且 `run_id=NULL` 让行与父 agent run 失联。
  - 这是**续跑的次要放大器**，不是主因：即便句柄完好，重跑也会再撞 1.2 的保真度墙。

---

## 2. 两个症状 → 同一根因

| 症状 | 机制 |
|---|---|
| **没法一次完成** | finalize 视听剖析先被标题字面匹配误判硬挡，后续真实缺口没有一次性暴露 → 终态 blocked，65 场景成果全卡门口 |
| **没法续做** | 该失败只写 `validation_errors.json`，**不生成 Ready 可识别的修复 handoff 包**；默认直连模式下一次 finalize 也不会读取修复后的 `body/output.md`，因此重跑容易原样再撞；叠加孤儿 `running` 行 + `run_id=NULL` 让续跑账本更乱 |

---

## 3. 确定 vs 推断 / 排除项

**已确证**
- finalize 卡在视听剖析保真度校验，首个报错是 `意识形态"自然化"评估` 子条目缺失；但历史产物实际写了弯引号版本，属于标题匹配误判。
- 首个报错后还存在真实的模块字数/Scene 证据缺口，当前校验没有一次性汇总。
- 保真度 ValueError 走通用 except 终态 blocked，无 Ready 可识别的修复回环（ai_analyzer 代码结构 + handoff 目录只有 validation_errors）。
- LLM 已产出内容（命中父章节和目标子节），**远程/openclaw 传输不是病因**。
- `proof_gap` 是 G0 如实反映 blocked，**判定器无 bug**。
- 近因落在 `648495ce`（视听剖析 + 保真度校验大改）。

**推断（需进一步定）**
- 视听剖析这轮走的是 openclaw/inline dispatch 还是 file-handoff（`report_mode` 字段）——只有 validation_errors、无 receipt/task，倾向 inline dispatch；影响修复回环接在哪一层。
- 子条目要求（自然化评估）是 `648495ce` 新加的强制项，还是 prompt 早有、只是这轮才硬校验——决定是"放宽校验"还是"补修复回环"。

**已排除（不要误归因）**
- ~~skill_task_runs 时间戳 epoch-0 坏档~~ —— 我的查询假象，实际正常。
- 远程发送 / 微信 ret=-2 —— 与本问题无关（传输已通、内容已生成）。
- G0 判定器过严 —— `proof_gap` 是对 blocked 的如实反映，非误杀。

---

## 4. 修复方向（仅方向，未改代码 —— 待修复门）

1. **【主】标题匹配归一化**：`##` / `###` 校验必须允许直引号/弯引号、全半角和空白差异，不要把同一标题误报为缺失。
2. **【主】一次性汇总校验失败**：不要第一个 `raise` 就停；同一轮要同时报出缺子条目、子条目字数、模块字数、Scene 证据和 anchor 缺口，避免用户/agent 一次补一点、反复撞墙。
3. **【主】给保真度失败接修复回环**：finalize 的视听剖析保真度 `ValueError` 不应只落通用 except 死掉，而应生成 Ready 可识别的 handoff 修复任务包：保留当前失败草稿，写入 `receipt.json` / `brief.md` / `body/task.md` / `body/validation_errors.json`，让 agent 定向修复。
4. **【主】direct finalize 要消费修复稿**：默认直连模式下一次 finalize 若发现 `body/output.md` 已比 `validation_errors.json` 更新，应优先用这份修复稿继续组装，而不是重新问模型生成一份新的不确定正文。
5. **【主】handoff 补完不等于完成**：Ready 自动补完 handoff 后不能直接把 child run 标 completed；必须继续/触发下一次 finalize，只有 MD/PDF 等交付产物真的存在并通过 delivery report 才能完成。
6. **【次】清理续跑账本**：孤儿 `running` typed_action 行需在管线退出（exit 2 blocked）时落到正确终态/标记；`run_id` 与父 agent run 的关联补齐，避免续跑查询被孤儿行污染。

## 5. 临时绕过
- 当前**无干净绕过**：直接重跑很可能必现。可行的人工兜底不是只补 `### 意识形态"自然化"评估`，而是对照 `audiovisual_handoff/body/validation_errors.json` 一次性补齐所有字数与 Scene 证据缺口，并确保修复稿能被下一次 finalize 读取；临时放宽校验只可用于本地定位，不是正式修复。

## 6. 修复尝试
**待实施。** 本文已从"缺一个子节"修正为"标题归一化误判 + 真实缺口被短路遮住 + 缺修复回环 + handoff 补完未必 finalize"的分层根因；修复应按第 4 节顺序落地并配测试。
