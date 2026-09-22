---
title: P3 Backlog 续跑 Handoff — 会话交接（silent-catch 重锚起手 + 剩余项入口）
date: 2026-07-05
status: handoff
enforce: false
source:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-03-agent-mainline-p3-route.md（完整剩余台账 §6/§7，权威）
  - docs/superpowers/plans/2026-07-03-deferred-work-register.md（D1-D19 工单原文）
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 0. 一句话

> **✅ 本 handoff 全部履约（2026-07-05）**：§2.1 silent-catch（72628891）、§2.3 D7（fb4b1b98）、§2.4 全部穿插项（D19 dc1ccf73 / C5-b 021593fd / D4 5dba2c3d / D6 a2fa0666 / D1 f034778f）均完成；途中暴露的 ipc-contract 19 条（097eaca4）与 npm test 73 fail（2bb00a0e）也已清零。§2.2 真机复测批收敛为《2026-07-05-user-retest-checklist.md》待用户执行。本文全文留作历史。

上一会话把 worktree topology 收敛完（mainline = `ready-cowork-newtab` on `main`），并把剩余工作台账写进路线文档 **§6（剩余项逐条）+ §7（执行顺序）**。正要动手 §7.1 **silent-catch 重锚**（`npm run verify` 现红）时上下文过重，转交。**新会话：先读本文 §1-§3，再按 §2 顺序推进。** 本文只补「怎么动手」的细节，全量台账仍看 route §6/§7。

# 1. 立刻上手（环境 & 现状 & 授权）

- **worktree**：`/Users/user/实验田/ready-cowork-newtab`，分支 `main`，HEAD `ca6367ab`，干净。这是**唯一** mainline 开发 worktree（main-fix 已弃、`feature/vertical-tabs` 分支已删）。
- **node_modules**：symlink → `/Users/user/实验田/ready-cowork/node_modules`（donor 在 phase1，phase1⊆main 可弃）。typecheck/native:check 已 EXIT=0。
- **heads-up**：①本地 `main` 上游错配成 `origin/codex/readyguy`，裸 `git push` 推错远程——推前显式 `git push origin main`。②目录名仍 `-newtab`（用户说先不管，不影响开发）。
- **授权基线**：用户给最高权限、审慎逐项推进、不需逐步确认。但**「在场/真机」类项**（真机复测、D1 视觉验证、D7 架构决策）产出后要留给用户验，不自行判「完成」。
- **提交纪律**：pathspec 提交；真实退出码验证（`>log; echo EXIT=$?`，禁 `| tail && echo ok`）；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

# 2. 执行顺序（route §7 落地版）

1. **silent-catch 重锚**（§3 playbook，先做）——`verify` 现红，不关掉后续改动没法用完整 `verify` 干净验证。机械+审阅，可无人值守。
2. **真机复测批**（用户在场，route §6.1）——R1 全链 / Phase I P0 微信往返 / Phase M server-filesystem / MCP 本地二进制 / 飞书 CLI，一次跑完关账。
3. **D7 LLM 维护回合 + 涌现数据源第二批**（专门会话，合同先行，route §6.2）——剩余最重的产品件。
4. **穿插**（多可无人值守或短在场）：D19 意图门控改判定、C5-b 逐个裁决、D4 声明通道、D6 三测试仲裁。

# 3. silent-catch 重锚 playbook（本会话已挖到的执行细节，别重挖）

## 3.1 现状（实测 ca6367ab）
- 完整 `npm run verify` 在 `check-silent-catch` **红**；`verify:stability` 链**不含**此 gate（所以「stability 绿」从不覆盖它——别被骗）。
- 数字：**472** catch / baseline **350**（293 live / 57 stale / 其中 11 指向已删文件）/ **166 未覆盖 = 红**。
- 166 拆分：**72 relocated**（snippetHash 已在 baseline，仅换了文件——Phase B/C/D 手术搬迁）+ **94 novel**（hash 不在 baseline：搬迁中重排 或 真新债）。
- 94 novel 的 git blame 月份分布：70 条 2026-06 / 21 条 2026-07 / 3 条更早——**blame 日期不能区分「搬迁」vs「新写」**（搬迁 catch 的 blame 指向搬迁 commit）。故须逐块看内容，不能靠日期。

## 3.2 gate 判据（读 `scripts/check-silent-catch.cjs` 定案）
一个 `catch` **不算** silent（gate 放行），当块体满足其一：
- 块内任意位置含注释匹配 `/silent-catch:\s*\S/`（即 `// silent-catch: 原因` 或 `/* silent-catch: 原因 */`，**注释须在 `{}` 内**）；
- 块内含 `throw`；
- 块内含调用，其名匹配 `/(?:log|warn|error|metric|emit.*partial)/i`；
- 或 baseline 有该 catch 的 `file:snippetHash` 条目。

键 `entryKey = file:snippetHash`；`snippetHash` = catch 源码经 `replace(/\s+/g,' ').trim()` 归一后 sha256 前 16 位（**内容级**，改格式/换行不变、改逻辑变）。

## 3.3 重锚纪律（禁盲 `--update`）
`node scripts/check-silent-catch.cjs --update` 会把**全部** 472 当前 catch 写进 baseline = 把 94 novel 里可能的真新债一起 bless，**违「净不增」，禁用**。分开处理：
- **72 relocated**：安全重锚——它们本就是已接受的 silent catch，只是搬了家。把对应 baseline 条目的 `file` 更到新位置（或补新条目）。
- **94 novel**：逐个看块体，**优先加 `// silent-catch: <为什么无害>` 注释**（自证 + 满足 gate = 真「微还债/清偿」，比塞 baseline 好）；确属该处理的补 log/throw；只有确认是「纯搬迁重排、逻辑未变」才可入 baseline。
- 目标：`verify` 绿 + baseline 只增「已证搬迁」项，不新增「未看过就 bless」项。这一步同时**开启用户要的「分批清偿」**（94 加注释就是清偿第一批）。

## 3.4 复现诊断命令（/tmp 文件不留，命令自带；在 worktree 根跑）
```bash
# 分类 166 = relocated | novel，并 dump file<TAB>line<TAB>类别
node -e '
const { checkSilentCatch } = require("./scripts/check-silent-catch.cjs");
const b=require("./scripts/snapshots/silent-catch-baseline.json");
const be=Array.isArray(b)?b:b.entries; const bh=new Set(be.map(e=>e.snippetHash));
const r=checkSilentCatch({root:process.cwd()});
for (const v of r.violations.filter(x=>x.snippetHash&&x.line))
  console.log(`${v.file}\t${v.line}\t${bh.has(v.snippetHash)?"relocated":"novel"}`);
'
# baseline liveness（current/baseline/stale/uncovered）
node -e '
const { scanSilentCatches } = require("./scripts/check-silent-catch.cjs");
const b=require("./scripts/snapshots/silent-catch-baseline.json");
const be=Array.isArray(b)?b:b.entries; const key=e=>`${e.file}:${e.snippetHash}`;
const cur=scanSilentCatches({root:process.cwd()}); const ck=new Set(cur.map(key));
console.log("current",cur.length,"baseline",be.length,"stale",be.filter(e=>!ck.has(key(e))).length);
'
```

## 3.5 收尾判据
- `node scripts/check-silent-catch.cjs` **EXIT=0**；
- `npm run verify:stability` + `npm run typecheck` 复跑绿；
- baseline 变更连同代码注释一起 pathspec 提交，提交正文写清「72 重锚 + 94 逐项处置（X 加注释 / Y 补 log / Z 入 baseline 附理由）」。

# 4. 其余项入口（省得新会话重找）

| 项 | 入口 | 关键约束 |
|---|---|---|
| **D7 LLM 维护回合** | route §6.2 | **先写机器可验证合同**（红线 §0.5 先合同后代码）；符号禁令 gate-flip + LLM 预算门控 + staged 写卡监控；与涌现第二批合并规划；用户「后台自动积累产品观」下一主件 |
| **D1 标签 tabOpened** | deferred-register `# D1`（line 11） | `tab-lifecycle-service.createTab` 建 agent/background tab 补发 `browser:tabOpened`（payload `activate:false`）；**⚠️ ≠ 已完成的 Phase D 内部步骤「D1 RunTimelineStamp」**；renderer 视觉验证在场 |
| **D4 声明通道** | deferred-register `# D4`（line 85） | `appendModelCriteria` 接裁决——新工具 vs 协议二选一（决策题） |
| **D6 三测试仲裁** | deferred-register `# D6`（line 117） | agent-sdk-runtime 三测试 vs 行动宣告闸合同碰撞（宣告闸 vs fixture 谁对）；分支既有红 |
| **D19 意图门控改判定** | deferred-register `# D19`（line 234） | 分析已定稿（live-info 词表缺事件/活动类 + 无漏判账本）；改判定**需漂移评估 + 回归测试兜底** |
| **C5-b 失联簇** | route §6.3（8 符号清单） | **禁 bulk 删**；逐个「删 vs 待接线」；`applyRunBudgetHint` 倾向留（预算记账在案） |
| **涌现数据源第二批** | route §6.2 / §6.4 | prepare/harvest/forming 信号采集（日历联动/产物打开跟踪/文件聚类）；设计先行；后台积累优先勿造前台面 |

# 5. 别踩的坑（本会话踩过或确认过）
- `verify:stability` 绿 ≠ `verify` 绿（silent-catch 只在完整 `verify`/`verify:e`）。
- D1 命名撞车（Phase D 内部 D1 已完成 ≠ D-register D1 标签）。
- 净不增（禁盲 `--update`）/ 禁 bulk 删（C5-b）/ 先合同后代码（D7、任何架构级）。
- `main` 上游错配 `origin/codex/readyguy`，push 前显式指定 `origin main`。
- 改目录名要在**别的**会话做（`git worktree move`），别在锚它的会话里改。
