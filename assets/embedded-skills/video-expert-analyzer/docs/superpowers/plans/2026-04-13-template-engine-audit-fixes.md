# Template Engine Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复模板引擎本轮审计确认的问题，并用测试与文档对齐把回归风险压住。

**Architecture:** 先在现有测试文件中补最小失败用例，再以最小代码改动修复 `audiovisual_template_engine.py` 中的模板加载、图块注入和报告校验逻辑。最后同步更新设计文档，让说明与真实行为一致。

**Tech Stack:** Python, pytest, Markdown docs

---

## Chunk 1: Tests First

### Task 1: Cover include guardrails and fallback

**Files:**
- Modify: `tests/test_audiovisual_template_engine.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] Step 1: 写缺文件、循环 include、family fallback 的失败测试。
- [ ] Step 2: 跑对应 pytest 用例，确认它们按预期失败。

### Task 2: Cover report assembly edge cases

**Files:**
- Modify: `tests/test_audiovisual_template_engine.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] Step 1: 写重复图块标记和缺节输出的失败测试。
- [ ] Step 2: 跑对应 pytest 用例，确认它们按预期失败。

## Chunk 2: Minimal Engine Fixes

### Task 3: Harden template loading

**Files:**
- Modify: `scripts/audiovisual_template_engine.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] Step 1: 实现 family fallback。
- [ ] Step 2: 为 include 增加存在性检查和循环引用检测。
- [ ] Step 3: 跑相关 pytest，确认通过。

### Task 4: Harden final report assembly

**Files:**
- Modify: `scripts/audiovisual_template_engine.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] Step 1: 修正重复图块标记的替换逻辑。
- [ ] Step 2: 增加节名完整性校验并给出清晰报错。
- [ ] Step 3: 清理重复正则定义。
- [ ] Step 4: 跑相关 pytest，确认通过。

## Chunk 3: Docs and Verification

### Task 5: Align docs with implementation

**Files:**
- Modify: `docs/template_design_spec.md`
- Modify: `docs/migration_plan.md`

- [ ] Step 1: 改正过时的 family base 命名和 fallback 描述。
- [ ] Step 2: 明确当前阶段的节名校验行为。

### Task 6: Final verification and self-audit

**Files:**
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] Step 1: 跑模板引擎全量测试。
- [ ] Step 2: 做一轮相邻风险自审，确认没有新增明显缺口。
