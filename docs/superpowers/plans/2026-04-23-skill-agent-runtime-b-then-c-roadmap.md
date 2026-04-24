# Ready Agent Runtime — B 方案 → C 方案 Roadmap

> 起草：2026-04-23
> 分支：`codex/skill-runtime-b-plan`（worktree：`.worktrees/codex-skill-runtime-b-plan/`）
> 前置：
> - `docs/superpowers/plans/2026-04-23-skill-runtime-bootstrap-rootcause.md`（事故根因与 CC-Source 对比）
> - 2026-04-17/18/19/20 三轮 agent-runtime-realignment 审计系列

---

## 0. TL;DR

- **结论先读**：C 方案（通用 agent 循环替代 4 个专用 agent）最终不可避免，但 **先走 B** 才是负责任的顺序。B 作为「通用原语 + markdown 驱动」在 skill 这一个受控域里的最小可行证明，为 C 扫除绝大多数未知。
- **B 范围**：skill 运行时现代化，4–6 周，影响约 25 个文件；退役 `skill.workflow.json` / `skill_executions` / 6 个 submit_\* 工具，改为 `markdown + 4 个通用原语 + todo` 驱动。
- **C 范围**：3–6 个月，影响 100+ 文件；把 browser / document / calendar / rss 4 个专用 agent 合并为单一通用 agent loop，domain 知识下沉到 tool 描述 + system prompt。
- **B→C 桥**：B 在 skill 域中造出的 4 个通用原语（`skill_ask_user`、`skill_run_shell`、`skill_write_artifact`、`skill_read_artifact`）+ 沙箱路径策略 + tool-gating-by-context 模式，**正好是 C 要推广到所有域的基石**。B 跑通了，C 的信心从猜测变为事实。
- **决策门**：B 全量上线 + 稳定 4 周后，再决定 C 启动时机；B 跑不通（某个原语在 Electron 安全边界里无法干净实现）就是停止信号，避免在 C 上踩同一个坑。

---

## 1. 现状锚点

- `main` 已整合至 `ce98417`（2026-04-23，74 commits fast-forward）。
- 测试基线：1390 pass / 36 fail —— 全部是既有红，非本轮引入，B/C 启动时视为基线债而非阻塞。
- 4 个 domain agent 并存：
  - `browser-engine` + `browser-task-planner`（V7 任务理解/计划/执行/复核四步）
  - `document-engine` + `document-task-pipeline-executor`（widget 多资源任务）
  - `calendar-engine` + `calendar-domain-adapter`
  - `rss-engine` + `rss-domain-adapter`
  - 以及 `skills-runtime`（本次 B 的目标）
- `agent-control/` 有 ~30 个模块作为跨域裁决层（`intent-classifier` / `policy-arbitration` / `run-capability-controller` / `turn-engine` / `tool-registry` / `execution-intent-resolver`）。C 的核心就是收敛这一层。
- Electron 进程边界给通用原语（尤其 `Bash`）施加了强约束：不能像 CLI 那样「任意 shell」，必须沙箱化。

---

## 2. B 方案范围（一句话版）

> **Skill 运行时退出状态机路线，进入「markdown 方法论 + 受控通用原语 + 模型自驱动」路线**；目标是 `novel_writer_system` 类 reference 技能和 `video-expert-analyzer` 类 workflow 技能 **共用同一套调用心智**，不再需要 `skill_executions` 表和 6 个 submit_\* 工具。

### 会改的
- `src/main/modules/skills-runtime/**`（state machine 退役）
- `src/main/modules/tools/skills-tools.ts`、`skill-execution-*.ts`（工具面重构）
- `src/main/modules/tools/skill-primitives/`（新增 4 个通用原语）
- `src/main/modules/agent-control/skill-context-orchestrator.ts`（内联注入）
- `src/main/modules/agent-control/skill-domain-adapter.ts`（裁决层配合）
- `src/main/modules/agent-control/tool-registry.ts`（sessionId-aware gating）
- `assets/embedded-skills/{video-copy-analyzer,video-expert-analyzer,lets-go-rss}/`（迁移 3 个内置 skill）
- Renderer：`SkillAskUserPrompt`、任务卡 projection 源从 `SkillExecutionDetail` 切到 `todo`
- 数据库迁移：drop `skill_executions` 表（Phase 4 之后）

### 不会改的
- 4 个 domain agent（browser/document/calendar/rss）的架构
- 4 个 mode 的 UI（workbench / browser / document / calendar / rss 模式切换）
- BrowserView 原生层（§6.2）
- 附件安全边界（§6.4）、文档资源绑定（§6.8）、live-info 路由（§6.9）
- `tool-registry` 除 skill 分支外的其余分组
- CLAUDE.md 的 §6.1–6.11 除 6.7（技能中心）和 6.10（工具策略仲裁）外的条款

---

## 3. C 方案概要（spec 层）

> **把 4 个 domain 专用 agent 收敛为一个通用 agent loop**，intent-classifier / policy-arbitration / run-capability-controller 从「硬编码仲裁规则」降级为「tool 描述 + tool 使用政策 + permission 规则」。domain 知识在 tool 层和 system prompt 层重新表达。

### C 的最终形态
- **一个 agent 循环**：不再有 `browser-task-planner` / `document-task-pipeline-executor` / `calendar-*` 各自的 turn 引擎；只有一个 `turn-engine` 处理所有任务
- **一个 tool registry**：所有能力（browser 操作、document widget、calendar 事件、rss 管理、skill 技能）统一以 tool 形式暴露，按 `domain-capability-group` 标签分组
- **domain 知识下沉到**：
  - tool 的 `description` 和 `when_to_use` 字段
  - system prompt 模板里按 domain 激活的段落
  - permission 规则和 allowedTools frontmatter（类 CC-Source）
- **intent-classifier 降级**：从「决定走哪个 domain 的 agent」降级为「决定激活哪组 tool 描述 + 哪段 system prompt」，可能最终被 tool description 的自然语言表达吸收掉
- **policy-arbitration 退役**：`run-capability-controller` 作为「工具策略裁决」的唯一点，取代每个 domain adapter 各自的防抖/降级逻辑
- **UI**：4 个 mode 仍在（产品形态不变），但每个 mode 实际是「工具可见性 + system prompt 激活」的预设，模式切换不再切换 agent

### C 的明确非目标
- 不做成 CLI（保留 Electron + 渲染层）
- 不替换 BrowserView / 附件 / 文档资源绑定这些产品级机制
- 不放弃 session scope 隔离（§6.3）和 skill/attachment 数据层

---

## 4. B → C 桥接资产

B 产出的东西有 5 项会直接成为 C 的基石：

| B 产出 | 在 C 里的用途 |
|---|---|
| **4 个通用原语**（ask_user / run_shell / write_artifact / read_artifact） | 从 `skill_*` 前缀移除，升级为全局 `ask_user` / `run_shell` / `write_file` / `read_file`，供所有 domain agent 使用 |
| **沙箱路径策略**（每个调用方只能读写自己的受控目录） | 推广：browser/document/calendar 各自的 `CLAUDE_DOMAIN_DIR` 约定 |
| **tool-gating-by-context**（Phase 0 的 sessionId-aware 过滤） | 推广：`run-capability-controller` 直接据此重写，按运行时状态 + 激活 domain 精确决定工具可见性 |
| **inline injection 模式**（reference skill → isMeta user message） | 推广：browser/document 域的「当前环境提示」也可内联注入（替代 `### Widget 更新上下文`、`### 浏览器 Tab 状态` 等专用标签） |
| **todo 驱动的任务卡**（替代 SkillExecutionDetail） | 推广：browser-task-planner 的 V7 四步状态、document pipeline 的 job step，全部改用 todo 表达 |

这些不是 B 「顺便能做」，是 B 的必然产物。只要 B 做完，C 的前 3 个 phase 几乎等价于「把 skill 域的经验复制到另外 3 个 domain」。

---

## 5. 决策门（何时启动 C）

**B 的第 4 个 phase 合并到 main 后**，观察 4 周。启动 C 必须同时满足：

- ✅ 3 个内置 skill（novel_writer_system 非内置但代表 reference；video-copy / video-expert / lets-go-rss 三个 embedded）跑通且无回归
- ✅ `skill_executions` 表彻底删除
- ✅ B 中的 4 个通用原语有生产使用数据（至少 100 次成功调用）
- ✅ sandbox 路径策略在真实用户手里没发生过越界事故（telemetry）
- ✅ 任务卡 UI 切换到 todo 后，产品体感没有下降（内部用户反馈）

**停止 C 的条件**（B 如果暴露任何一项就不要推 C）：
- ❌ `skill_run_shell` 必须 case-by-case 加白名单才能干活（说明通用化不现实，C 会把这种工作放大 10 倍）
- ❌ `skill_ask_user` 的跨 turn 挂起机制有死锁 / 状态丢失
- ❌ todo 驱动的任务卡在复杂任务下无法还原足够的进度可见性
- ❌ domain adapter 的降级逻辑在 skill 域里找到了不能用通用原语表达的场景

---

## 6. 时间线（最激进版）

```
Week 1     ┃ B-Phase 0 止血（novel_writer_system 立即可用）
Week 2     ┃ B-Phase 1 通用原语（4 个工具 + 内联注入）
Week 3     ┃ B-Phase 2 video-copy-analyzer 迁移（最简 skill 验证）
Week 4-5   ┃ B-Phase 3 video-expert-analyzer + lets-go-rss 迁移
Week 6     ┃ B-Phase 4 状态机退役 + UI 切换
Week 7     ┃ B-Phase 5 C 方案准备（文档 + 决策数据）
Week 8-11  ┃ 观察期（4 周）
Week 12+   ┃ C-Phase 1 起步（若决策门全绿）
```

保守版在每个 phase 之间加 2–3 天缓冲，总时长翻到 8–10 周。

---

## 7. 非目标（不在 B 也不在 C）

- 不动 3 个 domain（browser/document/calendar/rss）的核心领域算法
- 不动 Electron 进程模型、IPC 架构、BrowserView 原生层
- 不动会话 scope / 附件数据层 / skill manifest 存储路径
- 不动 AI provider 层（`src/shared/ai-providers.ts`）
- 不做多 user / 多租户改造
- 不做 MCP 扩展（除非 C 决策时单独立项）

---

## 8. 关联资源

- 根因文档：[2026-04-23-skill-runtime-bootstrap-rootcause.md](./2026-04-23-skill-runtime-bootstrap-rootcause.md)
- B 详细阶段：[2026-04-23-skill-runtime-b-plan-phases.md](./2026-04-23-skill-runtime-b-plan-phases.md)
- 历史审计线索：
  - `2026-04-17-ready-agent-runtime-realignment-audit.md`
  - `2026-04-18-ready-agent-runtime-realignment-second-round-audit.md`
  - `2026-04-19-ready-agent-browser-tool-manifest-invariant-round3-audit.md`
  - `2026-04-19-ready-agent-continuous-widget-modification-timeout-round{1,2}-audit.md`
  - `2026-04-20-ready-agent-continuous-widget-modification-timeout-round3-audit.md`
- CC-Source 参考实现：`/Users/user/Documents/实验田/CC-Source`
- 协作基线：`CLAUDE.md` §6.7（技能中心）§6.10（工具策略仲裁与超时）§6.11（工具错误契约）
