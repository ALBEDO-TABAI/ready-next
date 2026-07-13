# 代码行数健康度台账

> 更新时间：2026-07-13

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
| 2026-07-13 | Agent 定时任务 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2645 | 净 +343 | 危险 | 调度判断、时间计算、恢复判断和队列均已下沉，但 runtime 宿主仍新增了较多定时任务装配、专用会话和运行回流接线，继续扩大已会妨碍定位。后续应把 schedule runtime facade 整体移到定时任务域，只保留生产主链调用入口。 | 待独立拆分；交付时提醒 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/migrations.ts` | 3299 | 206 | 健康 | 只追加顺序 migration 073，完成结构化任务、occurrence 账本、旧数据迁移和旧表退役；原生 SQLite 连续迁移测试已通过。 | 无需处理 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1859 | 净 +19 | 一般 | 只装配定时任务 IPC 与生命周期清理，业务判断留在 schedule group/runtime。2026-08-13 复查入口装配密度。 | 已排期：2026-08-13 |
| 2026-07-13 | Agent 定时任务 | `src/preload/index.ts` | 1520 | 约 +22 | 一般 | 只增加结构化定时任务读写与失效通知透传；沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-13 | Agent 定时任务 | `src/renderer/components/agent/ChatPanel.tsx` | 1155 | 净 +15 | 一般 | 只保留圆形时钟入口和受控开关接线，独立工作界面已移到 Workbench 宿主。沿用 2026-08-11 宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-13 | Agent 定时任务 | `src/main/index.ts` | 1227 | 约 +8 | 一般 | 只在数据库与 Agent runtime 可用后启动调度器，并在休眠恢复和退出时走同一生命周期；沿用 2026-07-25 组合根拆分复查。 | 已排期：2026-07-25 |
| 2026-07-13 | Tag Forge 统一入口与终态修复 | `src/__tests__/run-finalizer-checkin.test.ts` | 1278 | 净 +46 | 一般 | 只增加“失败回执不能冒充完成”的终态回归，并补强原有部分完成对照；沿用 2026-08-12 按来源证明与终态验收拆分复查。 | 已排期：2026-08-12 |
| 2026-07-13 | Tag Forge 待审核续跑 | `src/main/modules/tools/file-management-tools.ts` | 1572 | 净 +8 | 危险 | 只补充批次的待审核状态、审核位置和原批次续跑回执；批次职责仍应整体迁出此文件。 | 待独立拆分；交付时提醒 |
| 2026-07-12 | Tag Forge + Boost 文件夹批量打标四层收口 | `src/main/modules/tools/file-management-tools.ts` | 1564 | 约 116 | 危险 | 本轮专用批次准备、断点与受控写回直接复用文件盘点和授权边界，避免另造一套越界判断；但该文件再次承担批次状态，已明显跨越搜索、读取、整理和打标职责。后续应把 Tag Forge batch executor 与状态存储整体移入独立模块，只保留工具路由。 | 待独立拆分；交付时提醒 |
| 2026-07-12 | 文件涌现与 Tag Forge 对抗复审 | `src/main/modules/migrations.ts` | 3093 | 37 | 健康 | 追加 071 反馈账本和 072 不可变评估快照头、成员键与诊断字段；仍是顺序迁移注册表，已由 72 段连续检查和真实 Electron SQLite 验证。 | 无需处理 |
| 2026-07-12 | 文件涌现与 Tag Forge 对抗复审 | `src/preload/index.ts` | 1498 | 8 | 一般 | 反馈、本地评估和真实创建回执只增加跨进程透传；沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | 文件涌现与 Tag Forge 对抗复审 | `src/renderer/types/electron.d.ts` | 4017 | 5 | 健康 | 机械补齐反馈、评估与创建回执声明，类型检查和行为测试覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P4 双投影 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1840 | 2 | 一般 | 仅把文件 intent card 数据源接入现有 Agent feed 组装；业务判断在独立 group/service。2026-08-11 复查组装根密度。 | 已排期：2026-08-11 |
| 2026-07-12 | 文件涌现 P4 双投影 | `src/renderer/types/electron.d.ts` | 4012 | 3 | 健康 | 只补齐 `projectKey` 和文件打开定位的跨进程类型，由类型检查、行为测试和真应用验收覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P4 Tag Forge 拆分 | `src/main/modules/tools/file-management-tools.ts` | 1416 | 1 | 危险 | Tag Forge 执行已移至独立 `tag-forge-tool.ts`，本文件不再承担其校验、写回与对账；但仍集中搜索、读取、分类、移动和批量整理，后续应按剩余工具域继续拆分。 | Tag Forge 危险已解除；剩余文件级危险待单独重构 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/renderer/components/layout/FileTree.tsx` | 1906 | 13 | 一般 | 仅组装命名标签页组并传给现有涌现入口；沿用 2026-08-11 的涌现状态/文件树职责拆分复查。 | 已排期：2026-08-11 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/main/modules/migrations.ts` | 2938 | 61 | 健康 | 只追加一次性 068 身份账本迁移，文件是顺序迁移注册表；已由连续编号、重复运行和原生 SQLite 行为测试覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P2 长期注意力 | `src/main/modules/migrations.ts` | 3056 | 118 | 健康 | 只追加一次性 069 长期注意力、明确意图和低敏预测账本；顺序迁移表职责未扩散，并由真实 Electron SQLite 测试覆盖。 | 无需处理 |
| 2026-07-12 | Tag Forge P3 | `src/main/modules/migrations.ts` | 3055 | 117 | 健康 | 只追加一次性 070 受控词表、待审核、标签归属和创建回执表；顺序迁移表职责未扩散，原生 SQLite 连续迁移已通过。 | 无需处理 |
| 2026-07-12 | Tag Forge P3 | `src/main/index.ts` | 1156 | 2 | 一般 | 仅增加 Tag Forge IPC 组装；主进程组合根继续沿用既定拆分复查。 | 已排期：2026-07-25 |
| 2026-07-12 | Tag Forge P3 | `src/preload/index.ts` | 1490 | 10 | 一般 | 新增 Tag Forge 创建、校验、回执和审核透传；仍是跨进程 API 汇总面，沿用按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | Tag Forge P3 | `src/renderer/types/electron.d.ts` | 4009 | 8 | 健康 | 仅补齐 Tag Forge 跨进程类型合同，类型检查与真实界面读回通过。 | 无需处理 |
| 2026-07-12 | Tag Forge P3 | `src/main/modules/tools/file-management-tools.ts` | 1448 | 30 | 危险 | 文件搜索、读取、分类、移动、批量整理和 Tag Forge 执行继续集中；本轮仅接入受控打标，但文件已跨多个独立职责。 | P4 前先把 Tag Forge executor 移入独立服务，避免继续增长 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/preload/index.ts` | 1480 | 7 | 一般 | 只增加项目重命名、文件归属和从文件新建项目三条 IPC 透传；沿用 2026-07-24 按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/renderer/types/electron.d.ts` | 4001 | 6 | 健康 | 机械补齐三条身份交互的类型声明，已由类型检查与行为测试覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P0 信号修复 | `src/renderer/components/layout/FileTree.tsx` | 1893 | 4 | 一般 | 只在现有涌现刷新入口并行重读阅读进度，没有继续扩张文件树职责；沿用 2026-08-11 的 pendingClips/涌现状态拆分复查。 | 已排期：2026-08-11 |
| 2026-07-12 | 浏览器标签浮层跨窗口停留修复 | `src/preload/index.ts` | 1471 | 2 | 一般 | 仅新增浮层鼠标位置核对的 invoke 透传；仍是跨进程 API 汇总面。沿用 2026-07-24 按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | 浏览器标签浮层跨窗口停留修复 | `src/renderer/types/electron.d.ts` | 3995 | 1 | 健康 | 机械跨进程声明，新增单一位置核对方法，已由类型检查与行为测试覆盖。 | 无需处理 |
| 2026-07-11 | Boost 60 秒误停修复 | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1023 | 16 | 一般 | 仅增加按 requestId 查询活跃运行的无副作用入口，不承担业务判断。2026-08-11 复查编排入口密度。 | 已排期：2026-08-11 |
| 2026-07-11 | Boost 60 秒误停修复 | `src/renderer/modules/agent/runtimeDriver.ts` | 1936 | 15 | 一般 | 只将 60 秒看门狗改为活性查询并处理 active 回执，事件桥职责未扩张。沿用 2026-08-11 的 scope-run 事件映射拆分复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Boost 模式一次性发送加固 | `src/renderer/components/agent/ChatPanel.tsx` | 1140 | 11 | 一般 | 仅增加同步锁存，保证点击 Boost 后立即发送也会消费 thorough；沿用 2026-08-11 宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2303 | 小幅接线 | 一般 | 仅增加启动中断收口、模式转发和活动计划会话持久化接线，判断均在叶子模块。沿用 2026-08-11 复查，优先继续下沉宿主编排。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/renderer/stores/useAgent.ts` | 2104 | 小幅接线 | 一般 | 仅在发送入口读取持久模式并转发；状态仍集中但职责边界偏重。2026-08-11 复查发送编排能否继续下沉。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1217 | 小幅接线 | 一般 | 只作为 coordinator 组装 owner、贡献学习和活动计划持久层的接线点，核心逻辑均在叶子模块。2026-08-11 复查 composition 接线密度。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1007 | 小幅接线 | 一般 | 首次略过线，仅透传 typed mode；不在此加入业务判断。2026-08-11 复查参数对象化是否能降低位置参数风险。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/renderer/components/agent/ChatPanel.tsx` | 1136 | 小幅接线 | 一般 | 仅持有一次性彻底模式并在发送时消费，行为函数已下沉。沿用 2026-08-11 解析器拆分复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/preload/index.ts` | 1469 | 1 | 一般 | 仅增加 deliveryMode 参数透传；仍是跨进程 API 汇总面。沿用 2026-07-24 按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-11 | Dynamic Delivery | `src/renderer/types/electron.d.ts` | 3994 | 2 | 健康 | 机械跨进程声明，新增 typed mode 字段且类型检查和 wire 测试覆盖。 | 无需处理 |
| 2026-07-11 | info_card 键值速览行（W10c） | `src/shared/document-widget-openui.ts` | 1187 | 24 | 一般 | 21 组件的 schema+编译器+目录三合一聚合面；今日大重构已净缩 ~400 行（关系图/流程图/图表提取共享模块），本次仅 info_card facts 字段与渲染。继续增长时优先把 componentSchemas 与 catalog 元数据拆出（编译函数留守）。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | widget 插入位置语义（W10b） | `src/renderer/modules/agent/document-actions/execute.ts` | 1897 | 30 | 一般 | renderer 文档动作执行器聚合了全部 document.* 动作分支与纯文本变换 helper；本次新增 prepend_start 分支与未知 position 响亮报错（纯函数已导出供行为测试）。继续增长时优先把 insertWidgetIntoDocument/upsert 等纯文本变换层拆到独立模块（与 target-resolve/write-locks 同级）。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-12 | Boost 长任务与技能选取收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7082 | 净 +44 | 危险 | 单套件继续聚合 SDK runtime 的共享宿主与大量状态场景，本轮只补工具面保真回归，但体量已明显妨碍定位和并行修改。后续应先建立可隔离的 runtime fixture，再按目标文档、压缩、provider wire、技能授权拆分。 | 待独立测试拆分合同 |
| 2026-07-12 | Boost 长任务与真实验收收口 | `src/__tests__/run-finalizer-checkin.test.ts` | 1232 | 88 | 一般 | 仍是终态判决与验收回执的单一行为测试域；本轮新增真实来源回执、伪正文反例和非完成态禁验收用例。若继续增长，优先按来源证明与终态验收拆成两个套件。2026-08-12 复查。 | 已排期：2026-08-12 |
| 2026-07-12 | Boost 长任务可见终态收口 | `src/__tests__/runtime-driver-terminal-unlock.test.ts` | 1058 | 净 +22 | 一般 | 仍集中验证 renderer 运行驱动的终态解锁与晚到事件仲裁；本轮只补长任务活性和可见终态回归。若继续增长，优先把活性探测场景拆成独立套件。2026-08-12 复查。 | 已排期：2026-08-12 |
| 2026-07-12 | 模型选技同轮开放 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1093 | 净 +121 | 一般 | 工具面构建与执行仍集中在同一宿主，但本轮同轮激活状态更新已下沉叶子模块，宿主只负责动态可见性和激活结果回灌。若继续增长，优先把 SDK tool 包装与 trace 发布拆开。2026-08-12 复查。 | 已排期：2026-08-12 |
| 2026-07-11 | 文档导出按钮（PDF / MD 压缩包） | `src/renderer/pages/modes/DocumentMode.tsx` | 1080 | 2 | 一般 | 仅 +2 行接线（导入 + 顶栏挂 `DocumentExportButton`）；导出逻辑全部在新叶子模块（DocumentExportButton / document-export-capture / document-export-html）。沿用既有判断：继续增长时优先把阅读会话跟踪或滚动锚点管理拆出。2026-08-11 复查不变。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档导出按钮（PDF / MD 压缩包） | `src/preload/index.ts` | 1467 | 4 | 一般 | 仅新增 exportPdf / exportMarkdownBundle 两条 invoke 包装；仍是跨进程 API 汇总面。沿用 2026-07-24 复查（是否按产品域拆分定义与组装）。 | 已排期：2026-07-24 |
| 2026-07-11 | 文档导出按钮（PDF / MD 压缩包） | `src/renderer/types/electron.d.ts` | 3992 | 9 | 健康 | 单一用途的 renderer 跨进程声明合同；本次新增 document-export 共享类型导入与两个方法签名，IPC/typecheck 一致性检查在位。 | 无需处理 |
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
| 2026-07-11 | Agent 根基修复 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2243 | 154 | 一般 | 本轮只增加冻结身份解析、接管恢复和累计用量的宿主接线，核心判断均已下沉到独立叶子模块；宿主仍偏大。下次增长优先继续下沉 handoff/usage 编排。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/agent-control/prompt-assembly.ts` | 1497 | 净 +51 | 一般 | 本轮将人格、规则和知识改为消费同一冻结 profile，并保留知识目录裁剪提示；文件仍是提示组装单一职责。下次增长优先把 agent 段的格式化移到 profile 叶子模块。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/migrations.ts` | 2868 | 70 | 健康 | 按版本顺序聚合数据库迁移，单一职责；Migration 066 已通过真实 Electron SQLite 连续迁移和数据保全检查。 | 无需处理 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/database.ts` | 3045 | 净 +18 | 危险 | 多产品域数据库入口继续集中；本轮仅接入会话 active Agent 与 handoff generation 的持久化读写。建议后续把 conversation agent state 下沉到独立仓储，避免继续扩大总管理器。 | 待拆分规划 |
| 2026-07-12 | Agent 根基修复与同轮选技 | `src/main/modules/tools/tool-executor.ts` | 1186 | 净 +4 | 一般 | 本轮只把冻结 execution profile 传入工具运行上下文并校正 use_skill 激活说明；统一调度职责未扩张。沿用 2026-08-10 复查，优先下沉独立 handler 路由。 | 已排期：2026-08-10 |
| 2026-07-11 | Agent 根基修复 | `src/renderer/components/agent/ChatPanel.tsx` | 1129 | 净 +20 | 一般 | 本轮只解析并传递任务 owner、执行者与消息身份快照；展示逻辑留在子组件。下次增长优先迁出序列化类型和解析器。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/renderer/modules/agent/runtimeDriver.ts` | 1931 | 25 | 一般 | 本轮只把主进程给出的执行身份写入消息与任务快照；事件桥职责未扩张。下次增长优先拆出 scope-run 事件映射器。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx` | 1535 | 净 +20 | 一般 | 本轮展示代码侧 readiness，并把 RULES / FOUNDATION / 知识卡的编辑器从页面末尾移到被点击内容的原位，未复制保存逻辑。下次增长优先把 roster/detail 或内容提案区拆成纯展示子组件。2026-08-11 复查。 | 已排期：2026-08-11 |
