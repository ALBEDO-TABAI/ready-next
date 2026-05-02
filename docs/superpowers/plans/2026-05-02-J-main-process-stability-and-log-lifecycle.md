---
name: J — 主进程稳定性 + 日志生命周期
description: I 阶段（跨边界确认合同 + renderer 观测面）交付后的稳定性收口。修两件运维级缺口：(1) 主进程 0 个全局异常 / Electron 子进程退出 handler，async chain 抛错直接 kill 进程 + cleanup 永不触发；(2) 当前 9 个 ready-*.log 文件存在 appendFileSync / appendFile 单文件无 rotation，另有 1 个 ready-design-run-captures.ndjson 白名单候选。Scope 严格控制在这两件 + 配套 CI gate；不引入 runtime audit harness（soak/chaos）/ 不扩 e2e / 不动 turn-engine / 不兜外部 spawn 子进程。
status: completed
enforce: true
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
---

# J — 主进程稳定性 + 日志生命周期（counter-proposal）

> **定位**：I 阶段（跨边界确认 + renderer 观测面）落地后剩下的运维级稳定性缺口收口。**不是 v4 / 不是 runtime audit 工具箱起步 / 不动 agent 层抽象**。
>
> J 完成后 v3 audit scope 进一步扩展：从 "main 进程内 agent runtime 子集"（v3+H）→ "+ renderer ↔ main 边界"（I）→ "+ main 进程 ↔ Electron runtime 边界 + 文件系统 log lifecycle"（J）。每一阶段只扩一层。

---

## 0. Context

### 0.1 J 在路线中的位置

| 阶段 | scope 边界 | 状态 |
|---|---|---|
| v3 (A0-G) | main 进程内 agent / skill runtime 子集 | ✅ |
| H tail closeout | + 文档真实性 / silent failure / timer / 测试反模式 | ✅ |
| I cross-boundary | + renderer ↔ main 边界 + 同发送链确认 + renderer 观测面 | ✅ HEAD `a29425e` |
| **J 本文档** | + main ↔ Electron runtime 边界 + 文件系统 log lifecycle | ✅ feat HEAD `9453967` |

### 0.2 audit 来源

2026-05-02 v3+H+I 完成后做的"还有什么缺口" reaudit：剩下的"今天会爆 / 中期会爆"还有两项 —— P1.1 主进程异常 + P1.2 全 ready 日志 rotation。J 收这两项。

### 0.3 与 I 完成基线的关系

J 改的是 main 进程入口和 log 子系统，跟 I 的 send confirmation / friendly mapping / metric channel 无交集。但 `verify:j` **必须内嵌 `verify:i`** 防止退化。

J 不复用 `tool-error-metrics.ts` registry —— **按 CLAUDE.md §6.11 规约，process / log observability metric 留在自己模块内（如 `src/main/utils/process-metrics.ts`），不并入 `TOOL_ERROR_METRICS`**。

---

## 1. 范围 = 2 类根因 / 7 项（覆盖 9 类 `.log` + 1 个 ndjson）

### 根因 P1.1 — 主进程零全局异常 / Electron 子进程退出 handler

**证据**：

```bash
$ grep -n "process\.on\|app\.on" src/main/index.ts
573:  app.on('browser-window-created', ...)
590:  app.on('activate', ...)
598:app.on('window-all-closed', ...)
611:app.on('before-quit', ...)
# 仅 4 个业务 hook
# 0 个 process.on('unhandledRejection')
# 0 个 process.on('uncaughtException')
# 0 个 app.on('render-process-gone')
# 0 个 app.on('child-process-gone')
```

#### 项 1：`unhandledRejection` 0 处理

任何 async chain（DB worker / IPC callback / sidecar spawn / RSShub / skill child runner 内部）reject 未被 catch → Node v15+ 默认终止进程 → Electron 主进程 kill → **`before-quit` cleanup 永不跑** → 孤儿进程 / lock file 泄漏 / 用户工作丢失。

#### 项 2：`uncaughtException` 0 处理

同步抛错未 catch → 同上。Electron 默认终止 + crash report，但**不**进 cleanup。

#### 项 3：`app.on('render-process-gone')` 0 处理

Electron renderer crash（OOM / GPU / native module）→ 主进程**不知情** → 用户白屏，**没有自动恢复 / 没有 metric**。

#### 项 4：`app.on('child-process-gone')` 0 处理（限定：仅 Electron 内部 child process）

Electron `child-process-gone` 仅触发 Electron 内部 child process（utility / GPU / spawn helper / renderer）—— J 范围内修这条。

**注意**：Node `child_process.spawn` 出来的**外部子进程**（ffmpeg / yt-dlp / scenedetect / Python sidecar）crash **不**触发 `child-process-gone`，要靠 caller 自己的 `'exit'` / `'error'` listener。今天大多数 caller（如 sidecar-manager.ts）有 ad-hoc listener，但**没有进程级 safety net**。

**这部分（外部 spawn 子进程兜底）不在 J 范围**，留独立 ADR / follow-up PR。J 只做 Electron 内部 child process。

### 根因 P1.2 — 9 个 `ready-*.log` 文件无 rotation + 1 个 ndjson 白名单候选

**证据**（W0 grep `getLogPath('ready-*.log')` 整理）：

| Log channel | 写入点 file:line |
|---|---|
| `ready-agent-metrics.log` | `metrics.ts:4` (H 阶段加，151 处 emit) |
| `ready-database.log` | `database.ts:306` + `database/worker-bridge.ts:34` |
| `ready-tools.log` | `tools/tool-event-log.ts:4` + `tools/browser-agent-runner.ts:227` + `tools/browser-tools.ts:30` |
| `ready-system-tools.log` | `tools/system-tools.ts:14` |
| `ready-memory-tools.log` | `tools/memory-tools.ts:13` |
| `ready-directchat.log` | `claude-bridge/direct-chat.ts:144` + `claude-bridge/ipc-handler.ts:75` |
| `ready-search.log` | `search-engine/adapters.ts:10` + `file-watcher.ts:39` + `indexer.ts:19` |
| `ready-settings.log` | `settings-engine/ipc-handler.ts:22` |
| `ready-browser.log` | `browser-engine/diagnostics-service.ts:4` |

= **9 类 `.log` 文件**（`getLogPath('ready-*.log')` 路径点共 15 处，部分文件被多 writer 共享；`ready-browser.log` 通过 `fs/promises.appendFile` 异步写入，其余当前为 `appendFileSync` 形态）

**特殊文件**：`ready-design-run-captures.ndjson`（`ipc-handler.ts:284`）—— 一次性 capture 写，**不**是日志流。J 默认保留不动 + W0 escape clause（W0 若实测累积速度同类风险，可纳入 J 或开 follow-up PR）。

#### 项 5：rotation 全空白

```bash
$ grep -rn "rotateLog\|logRotation\|maxLogSize\|winston-daily\|file-stream-rotator" src/main/ → 0
```

全部 `.log` 当前都是单文件直写：大多数为 `appendFileSync(path, line, 'utf8')`，`ready-browser.log` 为 `fs/promises.appendFile(...)`。重型用户长跑 1-3 月内必爆。

#### 项 6：缺共享 logger helper

15 处独立 `getLogPath('ready-*.log')` 路径点 + `appendFileSync` / `appendFile` 写入模式 —— **没有共享 logger helper**。J 抽出 `createRotatingLogger(filename)`，所有 `.log` writer 改用，rotation 单点实现。

#### 项 7：rotation 形态

可选：按大小 / 按时间 / 混合。J 不强制选哪个；implementation 阶段 codex 决（推荐：按大小 50MB + 保留 5 个历史文件 = 单 channel cap 250MB，全套 9 channel cap ~2.25GB）。env `READY_LOG_MAX_BYTES` / `READY_LOG_MAX_FILES` 可调。

---

## 2. 显式 out-of-scope（**严格 scope 控制**）

不在 J 范围，留给独立 PR / 后续阶段：

### 不属本阶段的 audit 范式
- runtime audit harness（soak / chaos injection / race detector / cross-boundary contract test）—— J 完成后再判断需求
- 真子进程 e2e 矩阵扩展（browser / document / RSS / calendar each 1 条）—— 独立 PR
- 覆盖率基础设施（c8 / istanbul）—— 独立 PR

### 不属本阶段的产品 / 架构决策
- 根因 4 RSS 视频终态复用合同 / O2 跨 device single-flight / O3 parent×child budget 联动 —— 独立 ADR
- C1 Hook handler 实装 / C2 LayeredCompactor L2 算法 —— 待真实需求

### 不属本阶段的代码结构
- turn-engine.execute() 重构 —— 形态选择已论证混合形态合理，不动
- errorKind helper 4 处去重（H Final Record 已记 followup）
- renderer 端 silent catch baseline 长尾减少（I2 已冻结 N0=81）

### 不属本阶段的 log 子系统改造
- 远端 log aggregation —— Ready 是 desktop app，本地 rotation 足够
- 结构化 log schema 统一 —— 独立 PR
- log 内容压缩 / encryption —— 当前不需要

### 不属本阶段的子进程兜底
- **外部 `child_process.spawn` 子进程**（ffmpeg / yt-dlp / scenedetect / Python sidecar）crash 兜底 —— 进程级 safety net 不在 Electron `child-process-gone` 覆盖范围内，留独立 ADR / follow-up PR
- 远程 sidecar 心跳 / 重启策略 —— 独立 PR

**关键约束**：J 不引入新抽象层（除 `rotating-logger.ts` + 可选 `process-handlers.ts` 拆分 —— 这两个是 P1.1 / P1.2 必需的最小封装）；不修改 v3 + H + I 任一阶段合同；`verify:j` 内嵌 `verify:i`。

---

## 3. Hard Contracts（CI 必须可机器验证）

### J-Contract-1：主进程必须有 4 类全局 handler

`src/main/index.ts`（或拆出的 `src/main/process-handlers.ts`，由 codex 决）必须在 `app.whenReady()` 之前注册：

```ts
process.on('unhandledRejection', (reason, promise) => { ... })
process.on('uncaughtException', (error) => { ... })
app.on('render-process-gone', (event, webContents, details) => { ... })
app.on('child-process-gone', (event, details) => { ... })
```

**Handler 行为合同**：
- 调用 logger 记录（写入 `ready-process-events.log`，自身走 J-Contract-2 rotation）
- emit metric（**不**进 `TOOL_ERROR_METRICS`；用本地常量模块如 `src/main/utils/process-metrics.ts`，metric name 字面量传 `logAgentMetric`）
- handler 自身**不**再抛
- `unhandledRejection` / `uncaughtException` 触发时尝试 graceful shutdown（调既有 `cleanupAgentRuntime()` 等）后 `app.exit(1)`，**禁止** "emit metric 后让进程继续 happy-running" 形态
- `render-process-gone` / `child-process-gone` **不**强制 exit（OS-level 不可恢复事件，主进程仍可继续）—— 仅记录 + 通知 renderer（如可能）

**CI 验证**：新建 `scripts/check-process-handlers.cjs`：
- 扫 `src/main/index.ts` / `src/main/process-handlers.ts` 必须 register 4 类 handler（grep `'unhandledRejection'` / `'uncaughtException'` / `'render-process-gone'` / `'child-process-gone'`）
- 4 类 metric name 必须在 `process-metrics.ts` 类本地常量定义（**不**接受 `TOOL_ERROR_METRICS.*` 形态）
- 故意删除任一 handler / metric → 报错

**反测**：`scripts/__tests__/check-process-handlers.test.cjs` 4 类故意删除场景。

### J-Contract-2：所有 `ready-*.log` 走统一 rotation

`appendFileSync(<*.log path>, ...)` / `appendFile(<*.log path>, ...)` **禁止**直接出现在 `src/main/`，**除了**：
- `src/main/utils/rotating-logger.ts`（J 新建，rotation 实现自身）
- 显式白名单：`*.ndjson` capture（`ready-design-run-captures.ndjson` 等）/ 测试 / 一次性脚本

所有现有 15 处 `getLogPath('ready-*.log')` 对应 writer 改用统一 helper：

```ts
import { createRotatingLogger } from '../utils/rotating-logger'
const logger = createRotatingLogger('ready-tools.log')
logger.append(text)
```

**Rotation 行为合同**：
- 单文件大小达阈值（默认 50MB，env `READY_LOG_MAX_BYTES` 可调）→ 滚动
- 保留最多 N 个历史（默认 5，env `READY_LOG_MAX_FILES` 可调）→ `<name>.log` / `<name>.log.1` / ... 后丢弃最老
- rotation 失败**不**影响主流程 → console.warn + emit `log_rotation_failed` metric
- 逐 logger 单独维护 rotation 状态（Ready desktop 单进程 sync writer，无并发竞争）

**CI 验证**：新建 `scripts/check-log-rotation.cjs`：
- 扫 `src/main/` 所有 `appendFileSync(... .log` / `appendFile(... .log` 字面量 / 模板，必须经 `createRotatingLogger` 路径（白名单：helper 自身 + ndjson + 测试）
- 9 类既知 log channel writer 全部改造完
- 故意加 `appendFileSync(getLogPath('foo.log'), ...)` 或 `appendFile(getLogPath('foo.log'), ...)` 直写 → 报错

**反测**：`scripts/__tests__/check-log-rotation.test.cjs` 直写场景 + ndjson 白名单豁免场景。

### J-Contract-3：rotation 单测覆盖

`src/__tests__/rotating-logger.test.ts` 至少 5 条：
- it('appends to fresh file when size below threshold')
- it('rotates when current file exceeds READY_LOG_MAX_BYTES')
- it('keeps at most READY_LOG_MAX_FILES historical files')
- it('handles rotation failure without breaking append')
- it('rotation is idempotent across restarts')

### J-Contract-4：`verify:j` 内嵌 `verify:i` + 4 类 break gate

```
verify:j = verify:i + check-process-handlers + check-log-rotation + test:j:gates + test:j:focus
```

`test:j:gates` 跑 W4 cjs script 自测；`test:j:focus` 跑 rotating-logger.test.ts + 主进程 handler 测试。

4 类 break 反测必须挡住：
- 删除 `process.on('unhandledRejection')` → check-process-handlers 报错
- 加 `appendFileSync(getLogPath('xxx.log'), ...)` 直写 → check-log-rotation 报错
- rotation 实现 bug 让 file size 超阈值不滚 → rotating-logger.test.ts 报错
- 任一前序 verify (a*-i) 退化 → verify:j fail

### J-Contract-5：A0-I 不退化

`verify:j` exit 0 时 verify:a0 → ... → verify:i 全 green（嵌套保证）。

### J-Contract-6：不引入新抽象层

**唯一允许的新模块**：
- `src/main/utils/rotating-logger.ts`（rotation 必需的最小封装）
- `src/main/utils/process-metrics.ts`（process / log metric 本地常量；按 §6.11 规约不进 `TOOL_ERROR_METRICS`）
- 可选 `src/main/process-handlers.ts`（若 codex 决定从 main/index.ts 拆出，仅是代码组织，不是新架构）

不新建 `*-registry.ts` / `*-coordinator.ts` / `*-context-builder.ts` 等架构类。
不修改 verify:a*-i 任一阶段合同（仅追加 J 自己的 gate）。
不引入 ESLint hard rule（cjs script 形态足够）。

---

## 4. 已知风险与边界

### 4.1 全局 handler 反吞业务错误

`uncaughtException` handler 内若 `console.error(err); return`，会让本应 fail-fast 的 bug 被吞进生产。

**缓解**：J-Contract-1 行为合同明确"`unhandledRejection` / `uncaughtException` 触发时尝试 graceful shutdown 后 `app.exit(1)`"，**禁止** "emit metric 后继续 happy-running" 形态。

### 4.2 rotation 阈值

50MB / 5 文件 = 单 channel cap 250MB，全套 9 channel cap ~2.25GB。env 可调。**J 不预设最优值**，留生产观察 + 文档（CLAUDE.md §6.x 补 J 段说明）。

### 4.3 既有 log 兼容

老 log 文件可能已超新阈值。implementation 决 (a) boot 时立即 rotate（首次开启滚一批） / (b) 延后到下次 append 触发。推荐 (b) lazy（不打扰 boot）。

### 4.4 15 处 writer 改造的局部风险

W3 实施时一次只改一个 writer（按 9 类 log channel 顺序），每改完跑一遍 `verify:i` 确认不退化。如某 writer 行为不能 1:1 迁移（如 ndjson 特殊形态），保留原 `appendFileSync` + 加白名单。

### 4.5 cleanup timeout

`unhandledRejection` 后 cleanup 卡住 → 主进程僵尸。**implementation 必须**包 timeout：`Promise.race(cleanup, sleep(N seconds))` + `app.exit(1)`。N 由 codex 决（建议 5s）。如发现 cleanup 时间 >10s，触发 ESCALATE 拆 J1+J2。

---

## 5. 给 codex 的开放问题（implementation 时自决并写明理由）

1. **W 划分**：建议 `W0 文档修正 + audit → W1 主进程 4 类 handler + handler 测试 → W2 rotating-logger helper + 单测 → W3 9 类 `.log` writer 迁移 → W4 cjs scripts (process-handlers + log-rotation) + verify:j gate → W5 docs + Final Record`。codex 可调。
2. **rotation 形态**：按大小（推荐 50MB / 5 文件）/ 按时间 / 混合？
3. **Process handler 模块组织**：写在 `src/main/index.ts` 还是拆 `src/main/process-handlers.ts`？建议拆出（main/index.ts 已 600+ 行）。
4. **`unhandledRejection` 后 cleanup timeout**：建议 5s，可调。
5. **新 metric 名**：建议 5 类 = `process_unhandled_rejection` / `process_uncaught_exception` / `render_process_gone` / `child_process_gone` + `log_rotation_failed`。codex 可微调。
6. **Render-process-gone 是否给 renderer 推 IPC**：建议**不推**（renderer 已挂），仅记录 + 等 reload 时主进程通过 init context 告知"上次有过 crash"。
7. **是否给 9 类 log 各自不同阈值**：建议统一阈值起步，未来按需拆分。
8. **ndjson escape clause**：W0 实测 `ready-design-run-captures.ndjson` 累积速度。如发现同类风险（>50MB / 增速明显），纳入 J；否则保留不动 + 白名单。
9. **W0 audit 真实数字偏离 §1 时**：优先修本文档（参 D-I 同形态规约）。

---

## 6. 文档维护

- J 完成后更新本文档 `status: completed` + Final Record（HEAD / verify:j 输出 / 9 类 log channel 迁移结果 / 反测覆盖说明）
- 路线图 `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1 末尾追加 J 行（**标记为"v3 audit scope 第二次扩展（main↔Electron runtime + 文件系统）"，不是 v4 起点**）
- CLAUDE.md / AGENTS.md §6.x 末段补 J 阶段约束：
  - 主进程 4 类全局 handler 必须存在
  - `ready-*.log` 必须经 rotating-logger
  - process / log metric **不**进 `TOOL_ERROR_METRICS`（§6.11 规约）
  - env `READY_LOG_MAX_BYTES` / `READY_LOG_MAX_FILES` 可调阈值
- W0 audit 数字偏离则**优先修计划文档**

---

## 7. 与战略原则的对照

`CLAUDE.md §0.5` 6 条原则在 J 的应用：

1. **先合同，后代码** ✓ — §3 给 6 条 hard contract，每条 CI 可机器验证
2. **修根因，不修症状** ✓ — P1.1 / P1.2 都是"运维形态根因"
3. **拒绝 legacy 兼容分支** ✓ — `appendFileSync` 直写在 J 之后**禁止**，不留双轨
4. **形态意识** ✓ — desktop app 形态：本地 rotation 足够；Electron `render-process-gone` / `child-process-gone` 是 desktop 特有事件
5. **CI 强制 > 文档约束 > 人审** ✓ — 6 条 hard contract 全 CI 强制
6. **跨边界状态一致性显式建模** ✓ — main 进程 ↔ OS 信号 / Electron runtime / 文件系统三类边界第一次显式建守护

---

## 8. 给 codex 的执行摘要

> **必读**：§1 全部 7 项及证据（含 9 类 log channel 表 + ndjson 白名单候选）/ §3 6 条 hard contracts / §5 9 个开放问题
>
> **必做**：
> 1. W0 pre-flight audit（参 D-I 阶段形态）：
>    - grep 验证 §1 全部数字（重点：`getLogPath` 全量列表确认 9 类 `.log` + 1 个 ndjson；`src/main/index.ts` 现有 handler 数；外部 spawn 子进程 caller 列表 —— 后者只列不修）
>    - 实测 dev 环境各 `ready-*.log` 当前大小（`getLogPath()` 当前使用系统临时目录；macOS 实测为 `/var/folders/.../T/`，不是 `~/Library/Logs/ready/`）
>    - 决定 §5 全部 9 个开放问题
>    - 输出 `2026-05-02-J-main-process-stability-and-log-lifecycle-pre-flight-audit-report.md`
> 2. W0 audit 阶段如发现 §1 数字偏离 >30% → **优先 in-place 修订本文档**（参 D-I 同形态规约），不修代码
> 3. 写 implementation.md：W 划分 / land 顺序 / Test plan / Risk + Mitigation / Final Record 占位段（land 后填）
> 4. 给我 review implementation.md，**review 通过前不写业务代码**
>
> **不允许**：
> - 引入新抽象层（除 §3 J-Contract-6 列的 3 个最小封装）
> - scope 蔓延到 §2 out-of-scope（特别是外部 spawn 子进程兜底 / runtime audit harness）
> - 修改 A0-I 任一阶段合同
> - "emit metric 后让进程继续 happy-running" 的 unhandledRejection 形态
> - process / log metric 进 `TOOL_ERROR_METRICS`（§6.11 规约）
> - 用 try/catch 掩盖 J 阶段引入的回归
>
> **三类 ESCALATE 条件硬执行**：
> 1. W0 audit §1 任一证据数字偏离 >30% → 修文档不修代码
> 2. 9 类 log channel 实测发现 ≥3 个 channel 已有 >1GB 历史数据 → implementation 加 boot-time eager rotation 路径（非 lazy），文档写明
> 3. handler 实施时发现某条 graceful shutdown 路径 cleanup 时间 >10s → 拆 J1（handler + log rotation 基础）/ J2（cleanup timeout + 强 kill 行为）两阶段

---

## 9. Final Record

**状态**：completed.

**Feat HEAD**：`9453967 feat(stability): land J main-process handlers and log rotation`

**Scope 结果**：
- 主进程 4 类 handler 已在 `app.whenReady()` 前注册：`unhandledRejection` / `uncaughtException` / `render-process-gone` / `child-process-gone`。
- Fatal 类错误走 5s bounded cleanup 后 `app.exit(1)`；Electron runtime-gone 类事件只记录和打点，不强制退出。
- 9 类现有 `.log` channel 已迁移到 `createRotatingLogger`：agent metrics / database / tools / system tools / memory tools / directchat / search / settings / browser。
- `ready-design-run-captures.ndjson` 保持 W0 白名单，不纳入本轮 rotation。

**新增 gate / 测试**：
- `scripts/check-process-handlers.cjs`
- `scripts/check-log-rotation.cjs`
- `test:j:gates`
- `test:j:focus`
- `verify:j = npm run verify:i && node scripts/check-process-handlers.cjs && node scripts/check-log-rotation.cjs && npm run test:j:gates && npm run test:j:focus`

**反测覆盖**：
- 删除任一目标 handler 会触发 `check-process-handlers.cjs`。
- process/log metric 进入 `TOOL_ERROR_METRICS` 会触发 `check-process-handlers.cjs`。
- 新增 sync 或 async 直写 `ready-*.log` 会触发 `check-log-rotation.cjs`。
- rotation 单测覆盖 below threshold、above threshold、max history、failure tolerance、restart idempotence、sync + async writer。

**最终验证**：
- `npm run verify:j`：passed（包含 `verify:i`、process handler gate、log rotation gate、J gates/focus）。
- `git diff --check`：passed。

**ESCALATE 结果**：
- 新事实偏离：未触发（W0 已修正 9 类 `.log` + 1 ndjson 事实）。
- cleanup >10s：未触发；实现采用 5s bounded cleanup。
- external spawn 蔓延：未触发；外部 `child_process.spawn` 兜底仍留 ADR / follow-up，不进 J。
