---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# 设计明细 03：Crystallize 维护流程与"智能涌现"

> 系列：docs/agent-evolution/（00 为路线图总览）
> 来源：Matrix 调研系列 04 篇（双写者记忆/crystallize/CAS 合并/门控）+ ready 现状调研（file-emergence v1、skills_schedules 调度、MemoryLifecycleManager、SubAgent 框架取证）
> 状态：设计稿（未立合同）

---

## 1. 定位：三种涌现并列，共用一套"证据聚合"哲学

ready 的 file-emergence v1 已经确立了一个优秀范式：**多源证据 → 候选 → 打分 → 置信度 → 可解释投影**（candidate-extractors → scoring → confidence → evidence[]）。本篇把同一范式延伸到第三类涌现：

| 涌现类型 | 现状 | 信源 | 产物 |
|---------|------|------|------|
| 文件涌现 | v1 实装中 | 日历/文件活动/对话/浏览历史 | 四时间桶的虚拟项目分组 |
| 项目涌现 | v1 范围内 | 同上 | FileEmergenceProject |
| **智能涌现（本篇）** | 新增 | 对话史 / CheckIn 学习决策（02 篇）/ 卡片访问信号（01 篇）/ 任务结果 | 信念卡的生长与修剪、用户适应性提升、**专项 agent 候选**（04 篇消费）|

Crystallize-ready 是承载智能涌现的**周期性维护流程**：它不发明新信号，只消化既有信号。

## 2. 总体架构（双写者模型的 ready 化）

```
实时写者（agent 当轮）                 后台写者（crystallize-ready，周期）
├─ memory_write_card 写信念卡          ├─ §0 确定性门控（不起 LLM 就先决定跑不跑）
├─ CheckIn.learningRefs 落学习文件     ├─ §1 Survey：消化新信号 → 写/改/升降卡
├─ USER.md / user_profiles 直写        ├─ §2 衰减与去重（agency-driven，先降档后删除）
└─ proof/artifact 正常落盘             ├─ §3 重建 Backlinks + index.md（确定性代码，非 LLM）
                                       ├─ §4 USER.md / 偏好合并（CAS 安全）
                                       └─ §5 涌现候选维护（agent 候选 / 路由卡修复）
```

关键分工继承 Matrix："agent 立即捕获新观察；维护整理累积状态"。维护**不是**主要写入者，空轮合法且可审计。

### 2.1 隔离区（staged）：写入即落盘，注入须晋升

⚠️ 用户边界修正（Codex 评审第 6 点，修正式采纳）：自动写记忆最大的风险是把临时偏好、第三方网页断言、一次性项目事实写成长期信念。但"先预览后落盘"会丢观察（用户不会及时审），所以取折中——**写穿隔离区**：

- 实时写卡（02 篇 learningDecision、agent 主动写）一律落 `status: staged`——**当轮落盘不丢观察**；
- staged 卡**不进 index 注入**，只在记忆面板"待确认"区可见；
- 晋升三通道：用户在面板采纳（一键）；维护回合发现同方向二次信号 → 自动晋升并记录依据；用户在对话中明确说"记住这个" → agent 直接写 `status: active`；
- 衰减：staged 卡 14 天无晋升信号 → 直接删除（无需先降档——它从未进入正式记忆）；
- 第三方网页内容的断言**只能**进 staged 且 source 必须标注来源 URL（05 篇不可信内容原则的记忆层延伸）。

## 3. 调度与门控

### 3.1 调度载体（全部复用现有设施）

- **触发**：复用 `skills_schedules` 表的调度模式（interval_minutes + next_run_at + skills_jobs 状态机），新建独立的 `maintenance_jobs` 记录（或直接以内部 skill 形式注册 `ready-crystallize`，走 skills-runtime 现成的 job 生命周期/错误隔离/重启恢复）。推荐后者：零新基建。
- **默认节奏**：每 6h（与 MemoryLifecycleManager 现有节奏对齐），按 agent 作用域错峰（全局 → 主 agent → 各专项 agent 依次间隔 10min），避免同时抢 USER.md。
- **手动入口**：设置页"立即整理记忆"按钮（对齐 Matrix 的 manual maintenance UI）。

### 3.2 确定性门控（LLM 调用前的省钱闸，照搬 should-crystallize-run 思想）

纯代码判定，输出单行 JSON 落 `maintenance_audit` 日志：

```typescript
{ decision: 'run' | 'skip', reason: string,
  signals: { lastRunAt, newCheckInsWithLearning, newConversationTurns,
             cardWritesSinceLast, memoryFileMtimeChanged, forced } }
```

skip 条件（全部满足）：距上次 < 最小间隔 && 无 learning-bearing CheckIn && 新对话轮次 < 阈值 && 无新卡写入。skip 只记 breadcrumb 即退出——**门控管跑不跑，会话内管做不做**，两层分离。

### 3.3 执行容器

复用 **SubAgent 框架**（sub-agent-runner.ts）跑一个无 UI 的维护回合：独立 scope（`maintenance:{agentScope}`），不写用户会话消息，工具面限定为 memory_read_card / memory_write_card / 受限文件读 + 维护专用合并工具。提示词文件化（`src/main/assets/prompts/crystallize-ready.md`，遵循 01 篇的提示词资产化方向），核心结构直接改写 Matrix crystallize.md。

## 4. 维护回合各段规格

### §1 Survey（信源优先级）

1. **learning-bearing CheckIns**（02 篇）——`learningDecision ∈ {memory_card, skill_update}` 但 learningRefs 缺失/未完成的，补落地；`next_task` 未创建的，补建；
2. **会话摘录**——上次运行以来的对话（复用 session_recall_metadata 的 preview/latest_task_summary，避免拉全文 transcript）；
3. **卡片访问信号**——`agent_memory_access_log` 的 access_count 与 was_useful：反复命中且有用 → 升置信度；命中但标无用 → 降。

四类动作与 Matrix 一致：新观点→新卡；加深→改卡身；反复确认→升档；遇反例→降档。

### §2 衰减与去重（agency-driven）

- 衰减信号 = `created` 久远 + 零入链（Backlinks 空）+ access_count 长期为零 三者合取，**先降档后删除**，L 档再满足才删（删除前 frontmatter 标 `source: decayed`）；
- 近重复**不直接合并**：新卡标 `source: possible-duplicate-of [[older-slug]]`，下轮或用户裁决（UI 可在记忆面板给"疑似重复"过滤器）；
- 与 MemoryLifecycleManager 的关系：现有时间归档逻辑保留管 L1/L2 旧记忆；belief 卡的衰减由本段接管（按使用信号而非纯时间），`memory-lifecycle.ts` 增加 belief 分支跳过纯时间归档。

### §3 重建 Backlinks + index（确定性代码，不进 LLM 回合）

照搬 Matrix 的算法但用 TS 实现为纯函数模块（`knowledge-index-builder.ts`）：strip 旧 `<!-- backlinks:auto -->` 块 → 全量正向边扫描 → 重写各卡 Backlinks → 重建 index.md（tag 分组、置信度降序、行动导向线索、Updated 时间戳）→ 同步 DB 镜像行。**放在 LLM 回合之后由代码执行**——Matrix 用 bash 内嵌提示词是因为它没有宿主代码层，ready 有，确定性工作交给代码更稳。

### §4 共享文件合并（CAS 安全）

USER.md / user_profiles 的维护性合并照搬 merge-user-md 协议的 TS 版：读取快照 hash → 内存合并（只动本轮涉及部分，≤40 行约束）→ 候选写临时文件 → 比对 hash 一致才原子 rename，不一致良性跳过（exit 0 语义），结果写审计行。多 agent 错峰 + CAS 双保险。决策门照抄："纯项目工作不进画像；不为了写而抢锁。"

### §5 涌现候选维护（连接 04 篇）

主 agent 作用域的维护回合额外执行（crystallize-ceo 的移植）：

- **专项 agent 候选**：从会话史/任务史找重复模式——同域相似请求 ≥2 次、稳定输入/过程/输出、记忆能改善后续工作 → 写/更新 `aspire` 卡（frontmatter 加 `status: hint | candidate | emerged | routed | retired`），必须含带日期的证据与"下次升降置信度的条件"；
- **路由卡修复**：已有专项 agent 但请求仍落在主 agent → 写/修 `routing-*.md`（tag: self, confidence: H）；
- **修剪建议**：专项 agent 长期无流量/与他者重叠 → 写"合并/退休"建议卡，**只建议不执行**（执行权在 04 篇的用户确认流程）。

候选达到 `candidate` 且证据 ≥3 条时，向 UI 投影一张"涌现建议卡"（复用 file-emergence 的 evidence[] 可解释展示模式）——用户点确认才真正派生（04 篇流程）。

## 5. 输出与审计

- 每轮单行报告进 maintenance 日志：`crystallized(scope): N cards, M demoted, index rebuilt, USER.md <updated|unchanged|skipped>, candidates: X`；
- skipped 是正常守卫行为不是错误；
- 红线照抄 Matrix：不重写不理解的画像区段；不写凑数卡；不绕过 CAS 合并。

## 6. 工作包拆分与验收

**分期原则（Codex 评审采纳）：v1 全确定性，LLM 回合后置。** C1/C2/C6 加一个确定性子集（index 重建、坏卡检测、孤链清点、疑似重复标记、staged 过期清理）就是完整可用的 v1 维护——零 LLM 成本、零写坏风险；C3-C5 的 LLM 回合在确定性版稳定运行后再开。

| WP | 内容 | 依赖 | 验收 |
|----|------|------|------|
| C1 | knowledge-index-builder.ts（Backlinks/index 纯函数重建 + 坏卡/孤链/重复检测 + staged 过期清理） | 01 篇 K1 | 单测：图重建幂等、strip 防重复计数、index 排序规则、staged 14 天清理 |
| C2 | 确定性门控 + ready-crystallize 内部 skill 注册（调度/job 生命周期） | 无 | 门控矩阵单测；skip 留 breadcrumb |
| C3 | 维护回合提示词 + SubAgent 容器接线（§1/§2/§5，**LLM 回合，v2**） | C1/C2、01 篇 K1-K3 | 端到端：喂固定信号集 → 产出预期卡片操作；空轮干净退出 |
| C4 | CAS 合并工具（TS 版 merge 协议）+ USER.md 决策门 | C3 | 并发测试：双写者交错只成功一个、无半态、审计行正确 |
| C5 | 涌现候选 §5 + UI 涌现建议卡投影 | C3、02 篇 Q4（learning 信源） | 模拟两次相似请求 → candidate 卡生成；建议卡 evidence 可解释 |
| C6 | belief 衰减接管 memory-lifecycle 分支 | C3 | 升降档/删除路径测试；先降档后删除 |

风险与对策：维护回合烧 token → 门控 + 信源用摘要不用全文 + 空轮合法；LLM 改坏卡片 → 全部写入走 memory_write_card 的格式校验，§3 重建由代码兜底；与 file-emergence 抢信号表 → 只读不写 file_activity_events，互不依赖（additive listener 模式已是项目共识）。
