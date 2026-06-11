---
name: ready-debug
description: Ready 应用故障诊断技能（给 Claude Code / Codex / Cursor 等编码代理用）。当出现"设置丢失 / 历史空白 / scope not found / agent 无声死亡 / 采集异常"等症状时，按本技能的日志优先级、症状映射、账本巡检和 findings 模板定位根因，避免把原生依赖(ABI)问题误判成前端状态问题。
---

# ready-debug — Ready 应用诊断技能（v1）

本技能面向**外部编码代理**（Claude Code 自动发现；其他代理见 README.md）。用于在开发/排障环境定位 Ready 的运行时故障。核心纪律：**先看 `ready-database.log` 排除 ABI 问题，再怀疑前端状态**——原生依赖 (better-sqlite3) 的 ABI 不匹配会伪装成"设置丢失/历史空白"，最容易误判。

日志均在系统临时目录：macOS = `os.tmpdir()`（通常 `/var/folders/.../T/` 或 `$TMPDIR`）；Windows = `%TEMP%`。下文用 `<TMP>` 指代。数据库在 `<userData>/ready.db`（或环境变量 `READY_DB_PATH`）。

## 表 1 · 日志源优先级

按此顺序看，命中即停：

| 顺序 | 日志 | 看什么 |
|---|---|---|
| 1 | `<TMP>/ready-database.log` | SQLite 加载/迁移错误、`NODE_MODULE_VERSION` 不匹配——**任何"数据读不出来"先查这里** |
| 2 | `<TMP>/ready-directchat.log` | agent 决策、run 生命周期、终止路径 |
| 3 | `<TMP>/ready-agent-metrics.log` | 结构化 metric：`context_bill`、`run_close`、`belief_card_audit` 等 |
| 4 | `<TMP>/ready-tools.log` | 工具分发与执行、`errorKind` |
| 5 | `<TMP>/ready-browser.log` | BrowserView / 采集 / popup |

辅助：`ready-agent-sdk.log`、`ready-memory-tools.log`、`ready-search.log`、`ready-settings.log`、`ready-process-events.log`。

## 表 2 · 症状 → 检查

| 用户可见症状 | 先查 | 不要先怀疑 |
|---|---|---|
| 设置丢失 / 历史空白 / scope not found | `ready-database.log` 的 ABI/迁移错误（见表 4 ABI 段） | 前端状态没读出来 |
| agent 无回复后被迫"继续"（无声死亡） | `ready-directchat.log` run 终止路径；账本 `run_meta` 卡在非终态行（表 3） | 模型不听话 |
| 采集 0 项却判完成 / 部分失败重跑从零 | `ready-browser.log` + `collection-verdict` 判定 | 网站反爬 |
| 后台任务完成无反馈 | `browser_tasks`/`skill_task_runs` 终态 + 事件桥是否回灌（表 3） | agent 忘了 |
| 注入内容异常 / 旧任务串味 | `ready-agent-metrics.log` 的 `context_bill` 行看各 section 字节 | 提示词写错 |

## 表 3 · 账本巡检 SQL 包

连库（只读）：`sqlite3 "<userData>/ready.db"`（或 `$READY_DB_PATH`）。

```sql
-- 无声死亡：卡在非终态的 run（终态应为 done/error/cancelled/preempted/...）
SELECT run_id, task_id, status, terminal_reason, updated_at
FROM run_meta
WHERE status NOT IN ('done','error','cancelled','preempted','interrupted','checkpoint')
ORDER BY updated_at DESC LIMIT 20;

-- 三账本对同一 run 的口径是否矛盾
SELECT rm.run_id, rm.status AS run_status, rm.task_type,
       tp.status AS proj_status, tp.task_type AS proj_task_type
FROM run_meta rm
LEFT JOIN task_projections tp ON tp.run_id = rm.run_id
ORDER BY rm.updated_at DESC LIMIT 20;

-- 后台任务终态分布
SELECT kind, status, COUNT(*) FROM browser_tasks GROUP BY kind, status;
SELECT skill_id, status, COUNT(*) FROM skill_task_runs GROUP BY skill_id, status;
```

## 表 4 · findings 模板 + ABI 检查 + 修复门

### ABI 检查（"数据读不出来"类的首要嫌疑）

```bash
# 项目内置检查（权威）：比对 better-sqlite3 编译 ABI 与当前 Electron
npm run native:check
# 失败时重建：
npm run rebuild:native   # = patch + electron-builder install-app-deps
```

历史坑：better-sqlite3 按错误的 Node ABI 编出来，Electron 主进程加载失败 → 表现为"设置丢失/历史空白"。`ready-database.log` 会出现 `NODE_MODULE_VERSION` 字样。

### findings.md 五段式（产出给用户的结论）

```markdown
## 症状
（用户可见的现象，一句话）

## 可能原因
（根因判断）

## 证据
（引用日志行号 / SQL 结果 / 错误码——必须可追溯）

## 临时绕过
（用户现在能用的 workaround，如无则写"无"）

## 修复尝试
（是否动了代码；动了什么；没动则写"仅诊断"）
```

### 修复门（硬规则）

发现可修复问题时，**先问用户**：「现在修，还是只出报告？」——未经同意不改代码。仅诊断时"修复尝试"段写"仅诊断，未改代码"。

## 使用流程

1. 复制用户的症状描述；
2. 按表 1 顺序读日志，表 2 锁定方向；
3. 命中数据类症状 → 先跑 ABI 检查（表 4）；
4. 用表 3 巡检账本；
5. 写 findings.md（五段式）；
6. 若要改代码，过修复门。
