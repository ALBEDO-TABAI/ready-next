# Evals

本 skill 的测试分两层：路由断言只能证明"选对了路"，笔记质量要靠 LLM-judge 验收。

## 第一层：路由断言（自动）

```bash
python3 scripts/validate_study_notes.py
```

对 `evals.json` 里每个 case 跑 `route_study_notes.py`，断言 `expected_route` / `expected_goal` / `expected_complexity` / `expected_modality` / `expected_status` / `expected_confidence` / `expected_unsuitable`。同时做文件结构和文档一致性检查。改动脚本或任何 reference 后必须跑。

## 第二层：笔记质量（LLM-judge，人工触发）

每个 case 的 `manual_checks` 字段是该 case 产物的验收标准，validator 只把它们打印成 TODO，不会自动执行。验收流程：

1. 取一条 eval 的 `prompt` / `texts` / `files` / `hints`，按 SKILL.md 完整流程生成笔记。
2. 把下面的 judge prompt、该 eval 的 `manual_checks`、生成的笔记，交给一个**新开的** LLM 会话裁决（不要复用生成笔记的会话，避免自我辩护）。
3. 任何一条 check 判 FAIL：记录原因，修对应的 method 文件 / SKILL.md / 路由脚本，然后回归第一层 + 重跑该 case。

### Judge prompt 模板

```text
你是笔记质量验收员。下面有三部分：原始材料、验收标准、待验收的笔记。

对每条验收标准独立给出 PASS / FAIL 和一句话理由。
判断只看笔记本身是否满足标准，不要脑补"作者大概想表达什么"。
额外回答两个问题：
1. 笔记里有没有任何原文不存在的事实、数字或判断？（有则整体 FAIL）
2. 把这份笔记的模板换给另一种内容类型，是否照样成立？（是则说明在偷套通用模板，标注 WARN）

【原始材料】
<eval 的 prompt/texts/hints>

【验收标准】
<该 eval 的 manual_checks，逐条>

【待验收的笔记】
<生成的笔记全文>
```

### 何时跑第二层

- 改动 SKILL.md 工作流、任何 method 文件、output-contract.md 或 study-goals.md 之后：至少抽 3 条覆盖受影响路由的 case。
- 新增路由或新增目标专属块之后：跑该路由/目标的全部 case。
- 只改路由脚本、未动文档：第一层全绿即可，第二层可跳过。
