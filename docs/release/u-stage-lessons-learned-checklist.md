# Stage U LESSONS_LEARNED 验收清单

> 来源：`LESSONS_LEARNED.md`（329 行）+ `.claude/architectural-principles.md`
> 目的：Stage U release 前，每条"固化规则"必须有对应 CI gate / 行为测试 / manual verification
> 对应 plan：`docs/superpowers/plans/2026-05-20-U-release-readiness-implementation.md` §9 U8.7

## 0. 状态说明

- ✅ — 已有 CI gate 或行为测试覆盖
- 🟡 — Stage U 计划中即将引入的 gate / 测试
- ⚠️ manual — 必须 release 前手工验证，无机器自动化路径
- ❌ pending — 未覆盖，需补充

---

## 1. 启动与原生依赖（LESSONS §0, §1.0）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| `data-theme` / `data-skin` 必须在 `<head>` 同步 script 中先 setAttribute，再让 CSS 解析；IPC 只能后续对齐 | §0.0 | E2E：U7.6a 启动主题不闪测试 | 🟡 |
| `color-scheme: light dark` 必须在 `:root` 声明 + dark 主题覆盖为 `dark` | §0.0 | manual at U release（CSS 静态规则）| ⚠️ manual |
| Electron `BrowserWindow.backgroundColor` 在非 macOS 平台必须按持久化主题给值 | §0.0 | U8.6 Windows CI matrix 跑 build smoke | 🟡 |
| 演出层（ritual / overlay / mask）背景色用专门 token，不能复用 `--bg-primary` | §0.1 | manual at U release（视觉对齐）| ⚠️ manual |
| `better-sqlite3` 必须按当前 Electron ABI 重新编译；`postinstall` 跑 `electron-builder install-app-deps` | §1.0 | `npm run verify:native`（U8.6.1 `check-verify-native-trigger.cjs` 触发）| ✅ + 🟡 |

## 2. AI provider / 能力层（LESSONS §1.1-§1.7）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| "OpenAI 兼容" 不等于真兼容 tools — 必须建共享能力层 + 原生失败自动降级 | §1.1 | U6.1 `check-ai-capability-contract.cjs` 合并版 + U7.5b live provider smoke | 🟡 + 🟡 |
| 工具 schema 必须统一修复（数组缺 `items` 等） | §1.1 | `scripts/check-tool-input-sanitizer-single-source.cjs`（已有） | ✅ |
| 能力层（协议 / wireApi / tools / vision / video）统一解析，不散落 `if (provider === ...)` | §1.2 | `scripts/check-ai-resolved-capabilities-thinking-longcontext.cjs`（已有） | ✅ |
| 文本工具桥接是兼容层，不是首选；必须保留提示、回灌格式、自动纠偏 | §1.3 | `scripts/check-tool-call-args-hash-stable.cjs`（已有） | ✅ |
| Skill workflow 不能让模型自己记 — 宿主编译 + 持久化 + 只在 `need_*` 时交回 | §1.4 | U7.4 `/skill` `/doc` parity e2e | 🟡 |
| Skill runtime 结果必须结构化（`READY_SKILL_RESULT_PATH`），stdout 只做日志 | §1.5 | `scripts/check-event-ledger-shape.cjs`（已有） | ✅ |
| 长任务不能只显示 `planning/tool_running/done` 粗粒度 phase | §1.6 | `scripts/check-task-card-projection-only.cjs`（已有） + U7.7 phase smoke | ✅ + 🟡 |
| 本地普通请求默认不暴露 RSS/日程/飞书工具；只在用户明确提到时开放 | §1.7 | `scripts/check-message-capability-filter-wired-both-paths.cjs`（已有） | ✅ |

## 3. BrowserView 与前端壳层（LESSONS §2.1-§2.12）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| BrowserView 是原生覆盖层，不受 DOM `z-index` 控制；任何 overlay 必须协调 bounds / 显隐 / 动画 | §2.1 | U7.6a `check-browserview-overlay-order.cjs`（C-5）+ behavior test | 🟡 |
| 模式切换冻结帧：用 `captureViewportSnapshot` 而非 `captureWindowSnapshot`；按 tab 缓存 | §2.2 | U7.6a / U7.6b e2e | 🟡 |
| 复合淡出（opacity + blur + scale）+ 预测性预捕获 + `BROWSER_SURFACE_READY_DELAY_MS=16ms` | §2.2b | manual at U release（性能视觉）| ⚠️ manual |
| 面板动画与 BrowserView bounds 解耦，拖拽 / 收放期间降频 | §2.3 | U7.6b e2e（拖拽边界） | 🟡 |
| 浏览器头部用单一 `BrowserHeader` 持有 `activeTabMode` / `refreshDockMode`；分清 transient vs persistent | §2.3 | `scripts/check-renderer-no-status-text-guess.cjs`（已有） | ✅ |
| Renderer tab store 是投影缓存；真实生命周期在 main；browser mode 激活先 `browser.getTabs()` | §2.4 | `scripts/check-task-card-projection-only.cjs`（已有） + U7.6a smoke | ✅ + 🟡 |
| BrowserMode 空态也必须挂 `contentRef`，避免首次 `createTab` 拿不到真实 bounds | §2.5 | U7.6a 启动空态 → createTab smoke | 🟡 |
| 排 BrowserView 边界竞态先看 `ready-browser.log` 的 `createTab/updateBounds/showActive` 时序 | §2.6 | manual diagnostic（日志）| ⚠️ manual |
| 头部瞬时菜单走原生 menu / 不参与布局流；不要塞进 `activePanel` | §2.7 | `scripts/check-renderer-no-status-text-guess.cjs`（已有） | ✅ |
| `window.open` 必须先发回 renderer 接管 tab，再让 main 承载页面 | §2.8 | U7.6b popup e2e | 🟡 |
| 拖拽边界冻结整块浏览器区域，不只冻内部网页；结束后保留冻结一小段 | §2.9 | U7.6b 拖拽 e2e | 🟡 |
| 浏览器切回过渡层在标签栏下面（不盖顶部）；冻结截图同样缩到内容区 | §2.10 | manual at U release（视觉）| ⚠️ manual |
| Widget 更新目标不能污染下一条普通提问；执行层必须二次保险拒绝未授权工具 | §2.11 | U7.8 widget target 污染回归 + `check-tool-error-shape.cjs`（U1.1） | 🟡 + 🟡 |
| 新本地会话摘要可继续给模型参考，但工具开放只看当前请求 + 环境 | §2.12 | `check-message-capability-filter-wired-both-paths.cjs`（已有） | ✅ |

## 4. Browser Agent V7（LESSONS §3.1-§3.7）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| 链接是资源不是动作；附件先入资源层，不伪造文本 | §3.1, §3.2 | U7.3 remote attachment + scope isolation e2e | 🟡 |
| 浏览器任务按证据推进；执行器不临场改方向 | §3.3 | U7.1a/b Browser Agent V7 e2e | 🟡 |
| 利用连续性上下文（当前页 / 近期动作 / skill 结果 / 附件）减少兜圈子 | §3.4 | U7.1a/b e2e | 🟡 |
| 视频输入不能一刀切关 tools；显式 skill / 手动阶段 / embedded python / 活跃 execution 必须保留 | §3.5 | `scripts/check-vision-tool-capability-gated.cjs`（已有） + `check-view-image-followup-injection.cjs`（已有） | ✅ |
| Browser 阶段直接暴露给用户（任务卡 + 刷新后保留最近摘要） | §3.6 | `check-task-card-projection-only.cjs`（已有） + U7.1b 重开测试 | ✅ + 🟡 |
| ~~浏览器统一层先立合同再迁逻辑~~ (Y0.6 retired 2026-05-23 — see release-handoff §4 R1) | §3.6b | 本计划 Phase 4 / Phase 5 整体策略 | ~~🟡~~ retired |
| 结构化浏览器 task payload 与人读阶段文案并行 | §3.6c | `check-task-card-projection-only.cjs`（已有） | ✅ |
| 浏览器诊断复用执行真相，不另起猜测 | §3.6d | `scripts/check-renderer-no-status-text-guess.cjs`（已有） | ✅ |
| 先补 `RunCoordinator` 单轮执行 owner，再拆大文件 | §3.6e | 已在 V2 实现（agent-control/run-coordinator.ts） | ✅ |
| 自动记忆保守：首版只自动写 `user_preference` / `summary`，允许撤销 | §3.7 | `src/__tests__/memory-lifecycle*` 既有测试 | ✅ |

## 5. 远程 IM（LESSONS §4.1-§4.2）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| "已连接" 不等于真在线 — sidecar 需真实心跳 + 错误回传 | §4.1 | `src/__tests__/remote-channel-event-detector.test.ts`（既有） | ✅ |
| 远程会话遵守 scope 隔离 / 附件资源化 / 工具日志不进正文 | §4.2 | U7.3 三维 scope + 工具日志不入 transcript（C-6/C-7） | 🟡 + 🟡 |

## 6. 设计模块 / tldraw（LESSONS §5.1-§5.3）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| tldraw `SIZE_TO_FONT_SIZE` 映射 + CSS 覆盖显示 / 编辑模式 | §5.1 | manual at U release（设计模块视觉）| ⚠️ manual |
| tldraw 文本编辑用 contenteditable（`.tiptap` / `.ProseMirror`），不是 textarea | §5.2 | manual at U release | ⚠️ manual |
| 调试设计模块用 DevTools 检查真实 DOM；不要假设实现 | §5.3 | manual workflow（开发约定）| ⚠️ manual |

## 7. 协作与文档（LESSONS §6.1-§6.8）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| 跨 main / preload / renderer 改动必须同步文档：概览、开发、经验、进展、模块图、依赖图、结构快照 | §6.1 | `scripts/check-claude-md-claims.cjs`（已有） + Stage U PR 模板"受影响消费方"含文档 | ✅ + 🟡 |
| 复杂模块文档要写入口文件 / 日志 / 状态边界 / 关键限制 | §6.2 | manual review at U release | ⚠️ manual |
| 视觉排障先截 Electron 窗口（`screencapture -l <windowId>`），不要靠浏览器开 `localhost` | §6.3 | manual diagnostic 约定 | ⚠️ manual |
| 视觉 "没变化" 要同时检查激活底色 + 图标层级 | §6.4 | manual at U release | ⚠️ manual |
| 下拉菜单先排查 `overflow-hidden` 壳层裁切，再动 BrowserView | §6.5 | manual diagnostic | ⚠️ manual |
| 修左栏菜单不要让 BrowserView 退掉 | §6.6 | manual at U release | ⚠️ manual |
| 任何会展开的下拉菜单不挂在会被动画裁切的头部层；用顶层浮层 | §6.7 | manual at U release（视觉回归）| ⚠️ manual |
| 半透明工作区底色只选一个 "承载层"，不多层叠加；空态必检 | §6.8 | manual at U release | ⚠️ manual |

## 8. 架构原则（`.claude/architectural-principles.md`）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| ~~先合同后代码：架构 PR 必须有可机器验证合同~~ (Y0.6 retired 2026-05-23 — see release-handoff §4 R2; now enforced by CLAUDE.md §0.5 rule 1) | 原则 1 | Stage U §9 全部 25+ gate | ~~🟡（整 Stage U）~~ retired |
| ~~修根因不修症状：bug 必须归类，不留 follow-up~~ (Y0.6 retired 2026-05-23 — see release-handoff §4 R3; now in CLAUDE.md §0.5 rule 2) | 原则 2 | Stage U §11 PR 模板"受影响消费方"清单 | ~~🟡~~ retired |
| 拒绝 legacy 兼容分支：删除是合同一部分 | 原则 3 | U1.2 删 legacy agent IPC + U8.3 删 settings legacy key + `check-no-skill-executions-resurrection.cjs` | ✅ + 🟡 + ✅ |
| 形态意识：抄外部模式前问需求形态是否一致 | 原则 4 | manual review at PR 时 | ⚠️ manual |
| CI 强制 > 文档约束 > 人审 | 原则 5 | Stage U §0.5 + §0.7 配对表 | ✅ |
| 跨边界状态显式建模 | 原则 6 | U2.1-U2.4 fire-and-forget 全部修 + `check-no-fire-and-forget.cjs` | 🟡 |

## 9. 工具错误契约（LESSONS §-1）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| Dispatch 层吞异常 → 结构化 ToolExecutionOutput 回灌；只 Abort / HostUnavailable 冒泡 | §-1 Phase 1 | U1.1 `check-tool-error-shape.cjs` + 4 类拒绝路径行为测试 | 🟡 |
| 102 个工具入口 `safeParse`；46 schema + 31 测试 golden snapshot | §-1 Phase 2 | `scripts/check-tool-input-sanitizer-single-source.cjs`（已有） | ✅ |
| `agent:error` payload `{ errorKind, recoverable, toolName? }`；用侧字段 `softError` 不动 phase | §-1 Phase 3 | U1.1 配套 `renderer-soft-failure-capsule-tool-not-registered.test.tsx` | 🟡 |
| `PRAGMA foreign_keys = ON` 默认 OFF；跨表清理显式处理子表 | §-1 踩坑 | `scripts/check-better-sqlite3-electron-abi.cjs`（已有） + manual review | ✅ + ⚠️ |
| `INSERT ... ON CONFLICT DO UPDATE` 是静默覆盖；身份行用预检或不可覆盖路径 | §-1 踩坑 | manual review at migration PR | ⚠️ manual |
| Recoverable 路径零副作用（不动 phase / error / blockedReason 等 10+ 下游） | §-1 踩坑 | `scripts/check-projection-is-view-only.cjs`（已有） | ✅ |
| `emitRuntimeError(error: string)` 是反模式；用 `(error: unknown, options?)` | §-1 踩坑 | `scripts/check-emit-output-done-event-type.cjs`（已有） | ✅ |
| Metric 枚举 value 保持原字符串；rename key 不动 value | §-1 踑坑 | manual review at metric PR | ⚠️ manual |

## 10. Stage 10 Transitional Bridge Retirement（LESSONS §-2）

| 规则 | 出处 | 验收方式 | 状态 |
|---|---|---|---|
| `SkillToolAuthorization` 三层分离 + `'not_set'` 兼容短路必须删 | §-2 | `scripts/check-no-not-set-authorization.cjs`（已有） + `scripts/check-authorization-undefined-passthrough.cjs`（已有） | ✅ |
| `resolvePrimitiveSkillId` 不再 cascade | §-2 | `scripts/check-resolve-primitive-skill-id-shape.cjs`（已有） | ✅ |
| `turn-engine-authorization-rearm-order` 固化 | §-2 | `scripts/check-turn-engine-authorization-rearm-order.cjs`（已有） | ✅ |

## 11. 统计汇总

| 类别 | 数量 |
|---|---|
| 总规则数 | 约 70 |
| ✅ 已有 CI gate / 测试覆盖 | 26 |
| 🟡 Stage U 计划中即将覆盖 | 28（其中约 20 个跨多条规则共用 Stage U gate / e2e） |
| ⚠️ Manual at U release | 16 |
| ❌ Pending | 0 |

## 12. Stage U release 前必跑清单

按执行顺序：

```bash
# 1. 全套 CI gate（含 Stage U 新增）
npm run typecheck
npm run lint:check
npm run verify              # 完整 verify chain
npm run verify:native       # SQLite ABI
npm run verify:cloud        # release-grade

# 2. Phase smoke gate（U0.4 + U7.7）
node scripts/phase-smoke-runner.cjs --phase 0
node scripts/phase-smoke-runner.cjs --phase 1
node scripts/phase-smoke-runner.cjs --phase 2
node scripts/phase-smoke-runner.cjs --phase 3
node scripts/phase-smoke-runner.cjs --phase 4
node scripts/phase-smoke-runner.cjs --phase 5
node scripts/phase-smoke-runner.cjs --phase 6
node scripts/phase-smoke-runner.cjs --phase 7
node scripts/phase-smoke-runner.cjs --phase 8

# 3. Live provider smoke（U7.5b，opt-in）
READY_LIVE_PROVIDER_KEYS=1 npm run verify:release-smoke

# 4. Windows CI matrix（U8.6）
# 在 Windows runner 跑：
#   npm run typecheck && npm run verify:a0 && npm run verify:native && npm run build && npm run verify:c

# 5. Manual at U release（16 项）
# 按本文档 §1-§7 标 ⚠️ manual 的条目逐项目视
```

## 13. 备注

- 本清单是 `LESSONS_LEARNED.md` 与 Stage U 计划的桥梁；任何一方变动必须同步本清单。
- Stage U 结束时（U8.7 land 后），所有 🟡 标记必须升级为 ✅；任何 🟡 未升级表示该 Stage U PR 实际未交付。
- 16 项 manual 都是视觉 / 性能 / 诊断约定，无法机器化；release 时由 owner 走查。
- 任何在 Stage U 之后新增的 LESSONS_LEARNED 段必须立刻补本清单，并标 🟡 / ❌ 状态。
