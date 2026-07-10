# 代码行数健康度台账

> 更新时间：2026-07-11

这份台账记录“任务给代码文件增加行数后，文件总行数已超过 1000 行”的健康度评估。它不是按行数自动要求拆分，而是把真正影响维护、验证和协作的风险持续留下来。

## 触发与更新

1. 任务收尾前，用本次差异找出有新增行的代码文件，并检查修改后的物理总行数。
2. 总行数不超过 1000 行，不进入台账；超过 1000 行，必须评为危险、一般或健康，并新增或更新记录。
3. 生成物、锁文件、第三方 vendored 文件不参与评估；如果任务修改了生成器源码，评估生成器本身。
4. 同一文件以后再次触发时，更新总行数、判断和行动；不能只沿用旧结论。

## 分档标准

- 危险：文件已经混合多个独立职责，或体量正在明显妨碍定位、验证、并行修改和提交边界。当前任务不顺手大拆，但任务结束时必须提醒用户可能需要拆分重构，并在台账留下建议边界。
- 一般：文件仍有清楚的主职责和可验证边界，但继续增长会放大维护成本。必须写明计划复查日期和复查目标。
- 健康：文件虽超过 1000 行，但主要是单一职责的声明、映射、合同或机械聚合，且有可靠自动检查；拆分收益不足。记录结论即可，不安排处理。

## 当前记录

| 评估日期 | 任务 | 文件 | 总行数 | 本次新增 | 结论 | 判断与后续动作 | 状态 |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/components/document/note-preview-parser.ts` | 1457 | 153 | 一般 | 仍是"笔记结构化预览解析"单一职责；本次新增的块级源码区间必须与解析逻辑同步演进，故留在同文件（合同由 note-preview-source-ranges.test.ts 钉住）。下次增长时优先把 parseBodyBlocks 分段阶段拆为独立模块。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/pages/modes/DocumentMode.tsx` | 1078 | 34 | 一般 | 文档工作台编排页（标签/分栏/滚动锚点/阅读会话/模式状态）；本次仅 +34 行接线（previewEditActive、外观映射、untitled 拖拽载荷）。继续增长时优先把阅读会话跟踪或滚动锚点管理拆出。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/components/layout/FileTree.tsx` | 1889 | 43 | 一般 | 文件树容器：树渲染、拖放调度、剪藏占位、菜单仍聚在一处，但拖放判定/载荷解析已在 fileTreeExternalDrop/drag-utils 等叶子模块；本次沿现有分支缝隙加 untitled-doc-tab 直存分支（落盘逻辑在 modules/document/untitledDocSave.ts）。下次增长优先把 pendingClips 占位生命周期拆出。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/styles/markdown.css` | 1091 | 172 | 健康 | 首次过线：markdown/笔记预览域的单一用途平铺样式表（本次新增预览内编辑的块壳/编辑器/落点线样式段），无逻辑分支，css 级联层 gate 在位；拆分收益不足。 | 无需处理 |
| 2026-07-11 | 启动动画秒出（主进程微入口拆分 + 抗冻结让步点） | `src/main/index.ts` | 1146 | 净 -155（移出 splash 与 pre-ready 块；whenReady 各阶段加 yieldToPresentation 让步点） | 一般 | 主进程组合根：窗口生命周期、菜单、协议 handler、IPC 装配仍聚在一处，本次已把 splash 窗口与 pre-ready 配置拆出（boot-entry / startup-splash-window）。继续增长时优先把菜单与 local-file 协议 handler 移出。2026-07-25 复查增长趋势。 | 已排期：2026-07-25 |
| 2026-07-11 | 启动提速：embedded 技能同步记忆化 | `src/main/modules/skills-runtime/runtime-manager.ts` | 1165 | 15 | 一般 | 技能运行时管理器仍聚合 sync/loader/pipeline/scheduler 装配；本次仅加进程内同步缓存（含启动风暴根因注释）。继续增长时优先把 embedded sync 簇拆到独立模块。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-10 | 浏览器数据 / Cookie 设置页 | `src/main/modules/browser-engine/ipc-handler.ts` | 2652 | 6 | 危险 | 浏览器宿主控制、服务装配与跨进程入口仍集中在同一文件；建议后续把服务装配和入口注册继续移出宿主控制文件。任务结项需提醒。 | 待拆分规划 |
| 2026-07-10 | 浏览器数据 / Cookie 设置页 | `src/main/modules/database.ts` | 3027 | 24 | 危险 | 多个产品域的数据操作集中在单一管理器中；建议后续把浏览历史与下载数据边界下沉到独立持久化模块，并保留现有仓储入口。任务结项需提醒。 | 待拆分规划 |
| 2026-07-10 | 浏览器数据 / Cookie 设置页 | `src/preload/index.ts` | 1463 | 10 | 一般 | 仍是清晰的跨进程 API 汇总面，但持续增长会增加冲突和人工同步成本；2026-07-24 复查是否按产品域拆分定义与组装。 | 已排期：2026-07-24 |
| 2026-07-10 | 工具事件 L3 详情 + Skill 输出上限 | `src/renderer/types/electron.d.ts` | 3983 | 3 | 健康 | 单一用途的 renderer 跨进程声明合同，且 IPC/typecheck 一致性检查在位；本日累计增加 tool trace 两字段和 `maxOutputTokensOverride` 一字段。 | 无需处理 |
| 2026-07-10 | 任务卡/工具调用 activity-capsule 重设计 | `src/renderer/components/agent/chat-panel/task/TaskCard.tsx` | 843 | 重设计 +144 后拆分 −186（885→1029→843） | 一般（已按预留缝拆分收口） | 同日 L3 扩展任务把 `ToolTimeline`/`ToolTimelineRow`/`CapsuleChevron` 拆到 `ToolTimeline.tsx`（209 行），placement 合同 grep 已同步retarget；TaskCard 回到 1000 行以内。后续再增长按新总行数重新评估。 | 已拆分收口（2026-07-10） |
| 2026-07-10 | 工具事件 L3 详情（main 侧结构扩展） | `src/renderer/modules/agent/runtimeDriver.ts` | 1921 | 12 | 一般 | 主职责单一（agent 运行时事件 → store 的桥接枢纽），行为由 runtime-driver-*、agent-stream-segmentation 等多组测试覆盖；但监听器体量持续增长会妨碍定位。若下次任务再加行，优先把 onScopeRunEvent 大闭包与快照 meta 构建器拆成独立模块。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | 工具事件 L3 详情（main 侧结构扩展） | `src/renderer/components/agent/ChatPanel.tsx` | 1113 | 10 | 一般 | Stage V 已把大块区域抽到 chat-panel/* 子模块，剩余是宿主接线与两个序列化解析器（后者被 source-grep 合同钉在本文件）；本次仅类型字段与解析映射 +10 行。继续增长时优先评估把 Serialized* 类型与解析器移到独立模块并同步 chat-task-projection 合同锚点。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/migrations.ts` | 2798 | 9 | 健康 | 按版本顺序聚合的数据库迁移表，单一职责且 `verify:native` 真实加载验证在位；本轮仅增加 completion declaration 两列迁移。 | 无需处理 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/tools/tool-executor.ts` | 1182 | 1 | 一般 | 仍是统一工具调度入口，本轮只把验收声明更新为结构化 patch；继续增长时优先把独立工具 handler 路由下沉到现有分组模块。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2092 | 16 | 一般 | B8 后仍为 runtime 宿主与服务接线面，本轮仅接入统一 closeout wrapper；新终态逻辑已留在独立 finalizer。下次增长时复查 stale/manual closeout 编排能否继续下沉。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/tools/skills-tools.ts` | 3076 | 33 | 危险 | 技能工具注册、调度、读根分类仍集中；本轮已把真实路径派生和沙箱执行留在独立叶子模块，本文件只传递只读根与种类。进一步拆分被明确阻塞于“需要独立合同重锚全工具授权/执行 gate”，不在本轮收尾阶段扩大搬移面。 | 待独立拆分合同（阻塞原因已记录） |
| 2026-07-10 | Skill 模块复审收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 6975 | 2291 | 危险 | 集成级 SDK 共享宿主与大量状态场景仍集中。本轮已把输出上限、预算、准入和终态优先级的新独立域分流到专项测试文件；剩余用例依赖共享 singleton 宿主，继续搬移需先建立隔离 fixture，否则会伪造并发通过。 | 待独立测试拆分合同（阻塞原因已记录） |
| 2026-07-10 | Skill 真实 Electron 验收 | `scripts/run-agent-panel-mimo-acceptance.mjs` | 1200 | 90 | 一般 | 仍是面板验收入口与套件调度器；本轮增加独立双技能套件与文件真值检查。若再增加套件，优先把各 suite 的 prompt/assertions 拆到独立定义模块。2026-08-10 复查。 | 已排期：2026-08-10 |
