# Audiovisual Prompt Template Wiring Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the 4 updated storyboard-analysis prompts into the matching audiovisual report routes so generated reports use the stronger route-specific analysis frameworks without changing routing decisions.

**Architecture:** Keep the existing routing and report pipeline intact. Replace the 4 route templates with prompt-derived templates and add only the minimal context fields those templates need, verified through focused failing tests first. The work stays inside the template engine and template files, so route inference behavior remains unchanged.

**Tech Stack:** Python, pytest, markdown templates

---

## Chunk 1: Lock route-template expectations in tests

### Task 1: Add failing assertions for the four dedicated templates


**Files:**
- Modify: `tests/test_audiovisual_template_engine.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] **Step 1: Write failing tests for template resolution and key placeholders**
- [ ] **Step 2: Run focused pytest to verify the new assertions fail for the right reason**
- [ ] **Step 3: Keep the assertions minimal and tied to the 4 target frameworks only**

## Chunk 2: Wire prompt-derived templates and context

### Task 2: Update the route templates and minimal template context


**Files:**
- Modify: `scripts/templates/template_commentary_mix.md`
- Modify: `scripts/templates/template_documentary_generic.md`
- Modify: `scripts/templates/template_narrative_trailer.md`
- Modify: `scripts/templates/template_event_brand_ad.md`
- Modify: `scripts/audiovisual/reporting/template_engine.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] **Step 1: Replace the 4 templates with prompt-derived route-specific versions**
- [ ] **Step 2: Add only the context fields required by the new templates**
- [ ] **Step 3: Keep route inference and unrelated templates unchanged**

## Chunk 3: Verify end-to-end report generation

### Task 3: Run focused regression checks


**Files:**
- Test: `tests/test_audiovisual_template_engine.py`
- Test: `tests/test_routing_and_dispatch.py`

- [ ] **Step 1: Re-run the focused template-engine tests until green**
- [ ] **Step 2: Run the route/report integration tests that could catch unintended regressions**
- [ ] **Step 3: Stop only when the report generation path is verified to use the new templates cleanly**
