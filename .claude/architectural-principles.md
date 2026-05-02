# 战略级架构原则（详细展开）

> 配套 `CLAUDE.md` §0.5 与 `AGENTS.md` §0.5。  
> 顶层规则在两份协作指引里；本文档是每条规则的**反例 / 正例 / 自检问题 / 复发签名**。

---

## 原则 1：先合同，后代码

### 含义

任何架构级 PR 在写代码之前，必须先把"如果这个改动成功，CI 能机器验证哪几条合同"写下来。合同必须可执行（脚本 / 测试 / lint rule / 类型检查），不可以是人读注释。

### 反例

- "实现 outputDir GC" → 直接开始写 cleanup 函数。
- "child runner 加 retry" → 直接在 `startSkillChildRun` 加 try/catch + retry loop。
- 任何 PR 描述只写"我做了什么"而不写"成功的可机器验证标准是什么"。

### 正例

- "实现 outputDir GC" 之前先写：
  - 合同 1: `findStaleOutputDirs(asOf)` 返回的目录在 7 天前已 terminal。
  - 合同 2: `cleanupOutputDir(path)` 不删除 within-window child run 的目录（断言抛错）。
  - 合同 3: 一次完整 GC 跑后，磁盘占用减少 ≥ 预期值的 80%（基于固定 fixture）。
- 这 3 条合同都是 test 文件里的 `it()`，写完才开始动 source。

### 自检问题

写代码前先答：

1. 这个改动失败时，CI 哪个测试会红？测试名？
2. 这个改动只测**结构**还是测**行为**？(参考原则 5——结构断言不算)
3. 三个月后有人想撤这个改动，靠什么判断"撤了之后系统是否回到改动前状态"？

### 复发签名

- PR 描述：动词在前（"添加 / 修改 / 重构"），没有名词宾语（"什么样才算成功"）。
- 测试列表：只验证 happy path，没验证"约束"（不应发生的事）。
- 合并时改动 source 文件 ≥ 3 个但新增 test 文件 ≤ 1 个。

---

## 原则 2：修根因，不修症状

### 含义

看到 N 个相似 bug 或 1 个棘手 bug 时，第一动作是**归类**：它属于哪条已知根因？没有已知根因覆盖时，先识别新根因再开 PR。**症状清单 PR** 是反模式。

### 反例

- B1（infra_error 写入端散落 9 处）→ 修 9 个写入端的 1 个，留 8 个明天再说。
- A1（finalizeRun guard）发现后，只换 guard 不审 `recentCloses` 在其它路径（cancel / process_restarted）的对称性。
- 看到一个测试失败 → 改测试让它过，不查为什么失败。

### 正例

- A1 修复时同步审了：cancelSkillChildRun 路径、reconcileExistingChildRun 路径、observer wait fan-out 路径——一次性把"recentCloses 在多 lifecycle 下的语义"全部过完，不留死角。
- B6（resume 不清旧 closeEvent）发现后，引入 `prepareResumeLifecycle` 集中函数，**不**只在 `resumeSkillChildRun` 一处加 `closeEvent: null`，因为 `reconcileExistingChildRun` 也是一条 resume 入口。

### 自检问题

PR 开工前先答：

1. 这个 bug 在仓里**还有几个变体**？（grep / type 检查能列出来吗？）
2. 这个 bug 的"修复"是改一行还是改一组？如果是一行——你确定？
3. 修完之后，**反向**问：哪些代码还在做同样的事但还没出 bug？要不要一起改？

### 复发签名

- 同一个文件在三个月内被 hotfix ≥ 3 次。
- commit message 出现"and other places"、"similar issue"、"same pattern"。
- 修 bug 的 PR 描述里说"as a follow-up"——99% 这条 follow-up 永远不会来。

---

## 原则 3：拒绝 legacy 兼容分支

### 含义

任何形如 `if (legacy) { ... } else { ... new }`、union 留旧成员不删、`@deprecated` 但不删、"暂时保留兼容性 = 永远保留" 的写法，都是根因复发的种子。删除 legacy 是合同的一部分，不是技术债。

### 反例

- `terminalReason: 'infra_error'` 留在 union 里，注释写"deprecated, use child_process_crashed"——下一个写代码的人照样选 infra_error 当 catch-all。
- `findChildRunByOutputDir(opts)` 接 `opts.legacyShape` 当后门兼容旧调用方——下一次有人想"这只是临时"又用 legacyShape 派生新接口。
- DB 列加新版 + 留旧版同步写——drift 是迟早的事。

### 正例

- 删 `terminalReason: 'infra_error'`，让所有用它的写入点编译失败，强制选具体值。**编译错才是合同**。
- 弃用 API 时同 commit 删调用方：grep 出所有调用，PR 内 batch 改完，再删 API 定义。
- DB 列重命名走 migration 一次切换；不留双写阶段。

### 自检问题

PR 开工前先答：

1. 这个改动有没有 legacy 后门？哪怕"只是为了过渡"？
2. 如果**强制**删 legacy 路径，哪几个调用方会断？把它们一起改的工作量有多大？
3. 是不是真的需要过渡？还是只是不想一次改完？

### 复发签名

- 注释 `// TODO: remove after migration`、`// legacy, will deprecate`。
- TypeScript 类型 union 越积越大，不缩。
- API 签名里有可选参数 `{ legacy?: boolean }` 或 `{ v2?: true }`。

---

## 原则 4：形态意识

### 含义

抄 CC-Source / 业界"标准答案" / 别的项目模式之前，必须先问：

> **"它没这个问题，是因为根本没这个需求，还是因为它解得更好？"**

前者照抄 = 引入不属于本项目形态的复杂度。后者照抄 = 真正解债。

### 反例

- "Anthropic CC-Source 没有 pause/resume，所以我们也删掉它" → 错。CC 是 REPL 短 turn，没长任务；Ready 有 30min VEA，必须 pause/resume。
- "X 库默认就这么设计的" → 没问"X 库的形态约束跟我项目一样吗"。
- "GitHub 上 1k star 的同类项目都这样写" → star 数不证明形态相同。

### 正例

- CC-Source 用 `AbortController 树 + WeakRef + cleanupRegistry`——这是形态无关的"资源信号传播 + 集中回收"模式，**值得抄**。
- CC-Source 不复用 lifecycle id（resume = 新 instance）——这是"REPL 短 turn"特有，**Ready 不能照抄**。
- CC-Source 用代码注释保证原子写——这是"工程文化驱动"模式，Ready 没那个文化基础，**不能照抄**，必须用 mkdtemp/rename 机制保证。

### 自检问题

抄一个外部模式前先答：

1. 那个项目的**形态**是什么？（REPL / 长任务 / 单进程 / 分布式 / 多产品共享 / ...）
2. 我们项目跟它在该维度上**形态一致吗**？
3. 如果不一致，那个模式的**哪部分**是形态无关的（值得抄），哪部分是形态特有的（不能抄）？

### 复发签名

- PR 描述："参考 X 项目这样实现的" 而不解释形态对应。
- 引入了一个外部库的"完整模型"但只用了 30%——剩下 70% 是不属于本项目的复杂度。
- 后续 review 总在改"这跟我们场景不太对" → 形态错位的滞后表现。

---

## 原则 5：CI 强制 > 文档约束 > 人审

### 含义

合同的强制度有三档，**永远从最强档开始**：

- **CI 强制**：违反时构建失败、PR 不能合并。机器执行。
- **文档约束**：CLAUDE.md / AGENTS.md / 注释。靠人读了去遵守。
- **人审**：靠 reviewer 看 diff 时挑出来。

凡能上 CI 的合同**必须**上 CI；CI 不能覆盖再用文档；都不能再用人审。**最弱档是"我下次注意"——它不算合同**。

### 反例

- B3 的 source-string 测试通过了 acceptance gate，因为 gate 写法是文档级（"代码应走 executeToolCall"），可以靠 grep 满足。
- A1 历史漏检，因为"测试不应 mid-test reset singleton" 没机制，只靠 reviewer。
- "下次架构改动前先写 plan" → 文档约束。这次 Codex 跳过 plan 就跳过了，没机制阻止。

### 正例

- 删 `terminalReason: 'infra_error'` from union → tsc 直接报编译错（CI 强制）。
- ESLint 自定义 rule 禁止 `readFileSync(*.ts)` + regex 组合 → CI 强制。
- counter-proposal 文件存在但 implementation plan 文件不存在时 PR-time hook 阻止 commit → CI 强制。
- `__breaksInvariant: string[]` test helper 标记 + metric → CI 上对该 metric 的 fixture 报警。

### 自检问题

立任何新规则时先答：

1. 这条规则能不能上 CI？（typecheck / test / lint / hook 任一种）
2. 上不了的根本原因是什么？（"懒得写"不算）
3. 退到文档级时，**测试这条文档真的有效**——下个 PR 违反时谁会发现？

### 复发签名

- CLAUDE.md 越写越长，但生产 bug 没下降。文档不是合同。
- "我们之前讨论过这个问题"——讨论了不上 CI = 没讨论。
- PR 模板里的"自检 checkbox"——人会无脑勾。

---

## 原则 6：跨边界状态一致性显式建模

### 含义

任何跨 renderer / main / DB / 文件系统 / 子进程 / 子任务的状态，只要存在"一边先生成，另一边后确认"，就必须明确选一种一致性策略。常见可选项只有几类：temp-id 后替换、持久化确认门、最终一致、或服务端 lazy create。没有选型的 fire-and-forget 不是架构，是隐形 race。

### 反例

- renderer 先生成 `conv-local-*` 并允许用户立即发送，但 main 的 `sendScoped` 必须先查到 DB 行；创建 IPC 失败或尚未完成时，只把 raw "scope not found" 甩给用户。
- 父任务写内存态、子任务写文件态，双方都假设对方一定已经落盘，没有确认门或恢复路径。
- 一个 IPC 返回 `{ success: false }`，调用端只 `.catch(() => undefined)`，不检查返回值，后续继续使用本该已确认的 id。

### 正例

- 本地会话发送时，renderer 把 `scopeId + agent` 一起传给 main；main 如果发现 `conv-*` 本地 scope 缺失，可以按同一 id 幂等补建，再进入 run。
- 文件系统状态采用 atomic write + read-after-write 校验；下游只消费已确认路径。
- 子任务运行态以 durable `taskId / childRunId` 为边界，父任务只读取已发布的投影，不猜测子任务内部阶段。

### 自检问题

1. 这个 id / 文件 / projection / task state 的权威方是谁？
2. 消费方在权威方确认前能不能行动？如果能，选的是哪种一致性策略？
3. IPC / 文件写入 / DB 写入返回失败时，调用方会停住、补建、还是继续裸跑？

### 复发签名

- `void window.electronAPI.*` 紧跟着立即使用同一个 id。
- `.catch(() => undefined)` 或 `{ success: false }` 被吞掉后继续走 happy path。
- 报错文案是 "not found: <client-generated-id>"，但 UI 刚刚显示这个对象已经存在。

---

## 反模式速查表

如果在某个 PR / 讨论 / commit 里看到下面这些信号，**该 PR 大概率违反了某条原则**：

| 信号 | 违反原则 |
|---|---|
| "as a follow-up" / "in a separate PR" / "later" | 原则 2（修根因） |
| `// TODO: remove after migration` | 原则 3（拒绝 legacy） |
| `if (legacy) ...` 或 `{ legacy?: boolean }` 参数 | 原则 3 |
| union 类型新成员加了，旧成员留着不删 | 原则 3 |
| 测试用 `readFileSync` + regex 断言代码"长这样" | 原则 5（CI 强制） |
| acceptance gate 写法："代码应/不应包含 X" | 原则 5 |
| "参考 X 项目实现" 但没解释形态对应 | 原则 4（形态意识） |
| commit message 描述"我做了什么" 而不说"如何验证成功" | 原则 1（先合同） |
| 同一文件 3 个月内被 hotfix ≥ 3 次 | 原则 2 |
| `void electronAPI.*` 后马上使用同一个 client id | 原则 6（跨边界状态一致性） |
| "我下次注意" / "团队习惯改一下" | 原则 5 |

---

## 与本仓既有规则的关系

CLAUDE.md / AGENTS.md 里的具体规则（§6.1-§6.14、§10、§12 等）是这 6 条原则在不同子系统下的具体展开：

- §6.7（技能中心原则）→ 多处对应原则 2（统一 skill_* 工具走单一出口）+ 原则 3（B Phase 4 的 skill_executions 状态机退役）。
- §6.10（Agent 工具策略裁决）→ 原则 2（`run-capability-controller.resolveRunCapabilities` 是策略冲突的唯一裁决点，禁止双重挡板）。
- §6.11（工具错误契约）→ 原则 1（错误形状是合同）+ 原则 5（CI 验证 errorKind/recoverable 字段）。
- §6.13（Skill 长任务状态与续跑）→ 原则 2（任务身份验证以 task id 为第一身份）+ 原则 5（real DB 验收前先 rebuild:native）。
- §7（新功能开发最小闭环）→ 原则 6（跨进程状态必须同步 main / preload / renderer 类型 / UI / 文档）。
- §12（CLAUDE.md / AGENTS.md 同步）→ 原则 5（同步机制本身要 CI 检查，不靠人审）。

任何新增的具体规则都应该映射到至少一条原则；映射不上 = 大概率不该加这条规则。
