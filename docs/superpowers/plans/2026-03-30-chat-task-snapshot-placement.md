# Chat Task Snapshot Placement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each agent reply carry its own task snapshot under the message, while showing a temporary in-progress block at the bottom before the reply arrives.

**Architecture:** Persist a lightweight task snapshot onto each assistant message at reply-finalization time, then let `ChatMessages` render that snapshot directly under the owning message. Replace the fixed top task zone with message-level placement plus a bottom temporary in-progress block driven by the active run state.

**Tech Stack:** React 19, TypeScript, Zustand, existing task card view model helpers, Node test contracts

---

## Chunk 1: Snapshot Data Wiring

### Task 1: Define message-level task snapshot shape

**Files:**
- Modify: `src/renderer/modules/agent/types.ts`
- Modify: `src/renderer/modules/agent/messageComposer.ts`

- [ ] **Step 1: Add a failing contract expectation for message-level task snapshot metadata**
- [ ] **Step 2: Run the new contract test and confirm it fails**
- [ ] **Step 3: Define lightweight task snapshot types and serialization helpers**
- [ ] **Step 4: Re-run the contract test and confirm this part passes**

### Task 2: Persist snapshot onto completed assistant replies

**Files:**
- Modify: `src/renderer/modules/agent/runtimeDriver.ts`
- Modify: `src/renderer/modules/agent/messageComposer.ts`

- [ ] **Step 1: Extend the failing contract to require assistant persistence with task snapshot meta**
- [ ] **Step 2: Run the contract and confirm failure**
- [ ] **Step 3: Persist the active run snapshot when saving assistant messages**
- [ ] **Step 4: Re-run the contract and confirm pass**

## Chunk 2: Message-Level Rendering

### Task 3: Move task cards from top zone into message flow

**Files:**
- Modify: `src/renderer/components/agent/ChatPanel.tsx`
- Modify: `src/renderer/components/agent/ChatMessages.tsx`
- Test: `src/__tests__/chat-task-snapshot-placement-contract.test.ts`

- [ ] **Step 1: Write a failing contract for message-under-message snapshot rendering and top-zone removal**
- [ ] **Step 2: Run the contract and confirm it fails**
- [ ] **Step 3: Render task snapshot cards under agent messages using existing task card UI pieces**
- [ ] **Step 4: Remove the fixed top task zone**
- [ ] **Step 5: Re-run the contract and confirm pass**

### Task 4: Add bottom temporary in-progress block

**Files:**
- Modify: `src/renderer/components/agent/ChatMessages.tsx`
- Test: `src/__tests__/chat-task-snapshot-placement-contract.test.ts`

- [ ] **Step 1: Extend the failing contract to require a bottom temporary in-progress block**
- [ ] **Step 2: Run the contract and confirm failure**
- [ ] **Step 3: Render a temporary bottom task block only while work continues and before a new agent reply has content**
- [ ] **Step 4: Re-run the contract and confirm pass**

## Chunk 3: Verification

### Task 5: Re-run targeted contracts

**Files:**
- Test: `src/__tests__/chat-task-snapshot-placement-contract.test.ts`
- Test: `src/__tests__/agent-task-panel-contract.test.ts`

- [ ] **Step 1: Run `node --test src/__tests__/chat-task-snapshot-placement-contract.test.ts`**
- [ ] **Step 2: Run `node --test src/__tests__/agent-task-panel-contract.test.ts`**
- [ ] **Step 3: If either fails, fix and re-run before stopping**
