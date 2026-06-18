# Findings — okf-bundle 只出文档 + 对话框卡死停不掉

> 诊断日期：2026-06-17 ｜ 工具：`.claude/skills/ready-debug` ｜ 分支：agent-evolution/phase1
> 结论：**两个互相独立的缺陷**在同一次操作里叠加。A 是核心 app 缺陷（可见收口），B 是新建 skill 的接线缺陷。
> 状态：**仅诊断，未改代码**（用户选择"只出报告，先不改"）。

涉及 run：`req-1781681116088-uywbch`（scope `conv-66ecb07d-468c-429d-8daf-21c258f05d3f`），15:25:16 起、15:29:38 收口。
活动库：`~/Library/Application Support/ready/ready.db`。日志目录：`/var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T/`。

---

## 问题 A — UI 永远"思考中"、停止键失效

### 症状
文档已产出、后端任务实际早已结束，但对话框一直显示"思考中"，红色停止键点击无反应（持续 5 分钟以上）。

### 可能原因（根因）
后端终态账本已原子写完，但**可见收口（renderer）走 fire-and-forget IPC 投递，丢一个终态事件就可能永久卡死，且 renderer 侧没有任何投影对账兜底**。停止键不是权威对账手段：当前 renderer 点击时会先本地清前台状态再发 `agent:kill`，如果看起来仍无效，应继续查 busy 判定、后续事件回灌或投影重建，而不是假设主进程返回 `killed:false`。
违反 CLAUDE.md 硬约束："终态账本与可见收口**原子完成**" + "跨边界状态必须显式建模，不允许裸 fire-and-forget 靠重试碰运气"。

### 证据
- 三处账本一致判完成：
  - `ready-agent-metrics.log`：`run_close runId=req-1781681116088-uywbch terminalReason=done initiator=done toolCallsUsed=16 taskType=short_task` @ 15:29:38
  - `ready-directchat.log`：`sendScoped done ... requestId=req-1781681116088-uywbch success=true error=none` @ 15:29:38
  - DB：`run_meta.status=done`、`task_projections.status=completed`；非终态 run 巡检查询返回空
  - 截图时间 15:34 仍"思考中" → done 后 5 分钟未退出 streaming
- 代码定位：
  - `src/renderer/modules/agent/runtimeDriver.ts:1467-1485`：`isStreaming` 只由实时终态 IPC 事件清零；不读 `task_projections`（已 completed）对账，也不在 `sendScoped` promise resolve 后兜底清。
  - `src/main/modules/claude-bridge/ipc-handler.ts:1557-1568`：终态经 `mainWindow.webContents.send('agent:scopeRunEvent', …)` 投递，只有 `!isDestroyed()` 守卫，无 ack / 无重投。
  - `src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts:254`：停止键走 `agent:kill`；当前 handler 无条件返回 `{ killed: true }`，renderer 也会在发 kill 前先乐观清前台状态，所以"停止无效"不应归因于 `killed:false`。
- 触发环境：`ready-directchat.log` 15:24:16 `setupAgentIPC called, Ready agent runtime initialized`（引擎/IPC 在该 run 前 1 分钟刚重新初始化）。

确定 vs 推断：
- **已确证**：后端已收口；renderer 无 projection / promise 对账兜底；停止键当前只是本地乐观清理 + kill 请求，不是权威对账。
- **推断**：终态事件"具体被哪一下丢"（15:24 重初始化期间 webContents 正在 reload / 监听绑到旧实例）。主进程日志无法单独证死，但结构脆弱性 + 重初始化时间点是最合理触发源。

### 临时绕过
刷新 renderer（dev ⌘R / 重启 app）。后端已 `completed`，重载会按 projection 重建状态、退出"思考中"，文档不丢。

### 修复尝试
仅诊断，未改代码。若修：renderer 终态加 projection 对账兜底（或 `sendScoped` resolve 后兜底清 streaming）+ 停止键后触发权威投影对账。属架构级，碰可见收口硬约束，改前应配对到对应 plan 文档。

---

## 问题 B — 只出一份文档、没出 OKF 知识包

### 症状
用 okf-bundle 提取知识，只生成一份普通文档，没有 OKF 知识包（多文件 bundle + `okf_tools.py` 校验 + 母题索引登记）。

### 可能原因（根因）
**okf-bundle 的 `ready-skill.json` 缺执行面**。`SKILL.md` 是强制生产者（"必须实际创建知识包文件夹并写 .md"、"必须跑 `scripts/okf_tools.py validate`"），但 manifest 只声明一个 `read_skill`(reference) action——没有 `runtime:"python"` typed action、没有 `child_loop`、没有 `expose_when_hint_armed`，所以永远不会 provision run/output 目录；而通用 skill primitive 对 advisory/reference skill 又被 fence。agent 拿着指令没有可用的多文件写盘面，只能退化用 `document_*`（唯一不被 fence 的内容出口）写一份文档。

### 证据
- `ready-agent-metrics.log`：
  - `reference_primitive_lifecycle_skipped skillId=okf-bundle`（skill_read_artifact / skill_inspect_run_state）
  - `skill_primitive_rejected reason=not_found` → `okf-bundle/SKILL.md`、`okf-bundle/ready-skill.json`、`okf-bundle/skill.workflow.json`
  - `skill_primitive_rejected reason=outputdir_not_found outputDir=okf-bundle`
- `ready-agent-sdk.log`：产文档那个 run 工具序列全是 `file_inventory / file_read_excerpt / document_new_tab / document_set_content / document_save_tab`——无一次 `skill_write_artifact` / `skill_run_shell`。
- DB `skill_task_runs`：无任何 okf-bundle 行（只有 video-expert-analyzer）——从未作为任务真正跑过。
- Manifest 对照（同为 `execution.mode: advisory`，结果天差地别）：
  - ✅ `assets/embedded-skills/video-expert-analyzer/ready-skill.json`：有 `runtime:"python"` typed action（`video_expert_pipeline` 等）+ `child_loop` + `host_requirements.expose_when_hint_armed` → 有执行面、建 output dir、落 skill_task_runs。
  - ❌ `assets/embedded-skills/okf-bundle/ready-skill.json`：只有 `read_skill`(reference)。`okf-library` 同病。
- Fence 代码：`src/main/modules/tools/skills-tools.ts:1006-1015`（advisory/reference skill 的 primitive 在 `recordSkillTaskEvent` 前 early-return）。

附带观察（非主因）：同一 run `run_meta.task_type=short_task` 但 `task_projections.task_type=multi_step_task`，口径不一致；short_task 永不分包。次要，主因是 manifest 无执行面。

确定 vs 推断：
- **已确证**：manifest 缺执行 action、agent 因此退化写文档（manifest 对照 + 日志 + DB 三方一致）。
- 背景：`okf-bundle`/`okf-library`/`script-expert-ready`/`surf-pro` 均为今天新建 untracked（`??`），属接线未完成，非历史回归。

### 临时绕过
无（advisory-only 无法满足 SKILL.md 的多文件 bundle 契约）。需补 manifest 才能真正产包。

### 修复尝试
仅诊断，未改代码。若修：照 video-expert-analyzer 给 okf-bundle/okf-library 补 `runtime:"python"` typed action（封装 `okf_tools.py` validate/index/scan + bundle scaffold）+ `child_loop` + `host_requirements.expose_when_hint_armed`，使 primitive 能落在真实 output dir。
