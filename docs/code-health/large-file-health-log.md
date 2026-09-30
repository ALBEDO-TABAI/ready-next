# 代码行数健康度台账

> 更新时间：2026-10-01

## 2026-10-01 RSS 完整资料目录

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/migrations.ts` | 3384 | 2 | 健康 | 只登记独立 085 迁移；职责未扩大 |
| `src/main/modules/tools/tool-executor.ts` | 1270 | 3 | 一般 | 只注入目录读取与已有诊断；2026-11-01 复查域路由 |
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1547 | 1 | 一般 | 只登记目录读工具；2026-11-01 复查域注册 |

## 2026-10-01 RSS 分析历史与报告保存

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/rss-engine/item-analysis-manager.ts` | 1109 | 15 | 一般 | 报告身份校验与分页留在 analysis-report；宿主只负责启动、队列与发布，2026-11-01 复查媒体 helper 边界 |
| `src/main/modules/rss-engine/ipc-handler.ts` | 1241 | 1 | 一般 | 仅显式启动分析恢复，2026-11-01 复查组装 |
| `src/main/modules/tools/tool-executor.ts` | 1267 | 1 | 一般 | 只注入报告读取，2026-11-01 复查域路由 |
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1546 | 1 | 一般 | 只登记报告读工具，2026-11-01 复查域注册 |

## 2026-10-01 RSS 段落引用与定位

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1545 | 1 | 一般 | 仅登记选区读取；2026-11-01 复查域注册 |
| `src/preload/index.ts` | 1566 | 1 | 一般 | 选区只读 API 透传；2026-11-01 复查分域组装 |
| `src/renderer/components/rss/RSSFeed.tsx` | 1037 | 1 | 一般 | 只声明引用定位参数，DOM 转换和引用按钮留在小模块；2026-11-01 复查 |
| `src/renderer/types/electron.d.ts` | 4006 | 1 | 健康 | 使用共享选区合同，不复制字段 |

未新增正文副本或锚点资料库；引用定位使用既有工作区过渡，未新建全局导航器或浏览器控制路径。

## 2026-10-01 RSS 日报与范围简报

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/index.ts` | 1237 | 4 | 一般 | 绑定日报启动、恢复与退出；2026-11-01 复查生命周期组装 |
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1544 | 1 | 一般 | 只登记刊物读取；2026-11-01 复查 |
| `src/main/modules/migrations.ts` | 3382 | 2 | 健康 | 仅登记独立 084 迁移 |
| `src/main/modules/rss-engine/ipc-handler.ts` | 1240 | 12 | 一般 | 刊物 IPC 独立实现，宿主只接目录选择与依赖；2026-11-01 复查 |
| `src/main/modules/tools/tool-executor.ts` | 1266 | 1 | 一般 | 注入刊物只读存储；2026-11-01 复查域路由 |
| `src/preload/index.ts` | 1565 | 10 | 一般 | 五个 API 和一项变更通知；2026-11-01 复查分域组装 |
| `src/renderer/components/rss/RSSFeed.tsx` | 1036 | 1 | 一般 | 仅增加明确的引用版本标识，读取仍在共享阅读器；2026-11-01 复查 |
| `src/renderer/types/electron.d.ts` | 4005 | 6 | 健康 | 复用共享刊物合同；IPC 对账覆盖 |

刊物保存、调度接入、渲染、IPC、界面分别留在小模块。没有新增聊天调度、模型复核或独立计时实现；复用既有文件独占发布与读回。

## 2026-10-01 RSS 事件与结果恢复

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1543 | 1 | 一般 | 仅登记事件只读工具；2026-11-01 复查域注册 |
| `src/main/modules/migrations.ts` | 3380 | 4 | 健康 | 登记独立 082/083，顺序与升级回滚有验证 |
| `src/main/modules/rss-engine/ipc-handler.ts` | 1228 | 6 | 一般 | 事件分组独立实现；2026-11-01 复查组装 |
| `src/main/modules/tools/tool-executor.ts` | 1265 | 1 | 一般 | 注入事件只读存储；2026-11-01 复查域路由 |
| `src/preload/index.ts` | 1555 | 10 | 一般 | 事件 API 和已查看通知透传；2026-11-01 复查分域组装 |
| `src/renderer/components/rss/RSSFeed.tsx` | 1035 | 7 | 一般 | 仅接入独立事件展开组件，事件操作仍在阅读面；2026-11-01 复查列表宿主 |
| `src/renderer/types/electron.d.ts` | 3999 | 6 | 健康 | 引用共享事件/查询合同；IPC 对账覆盖 |

事件存储、IPC、展开与纠正组件均独立；分类结果只存一份，旧自动判断字段已删除。未增加单独保存连接、模型复核循环或任务调度器。

## 2026-10-01 RSS 自动整理

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/index.ts` | 1233 | 3 | 一般 | 仅绑定启动、模型设置和退出等待；2026-11-01 复查生命周期接线 |
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1542 | 1 | 一般 | 登记只读整理状态工具；2026-11-01 复查域注册归属 |
| `src/main/modules/migrations.ts` | 3376 | 2 | 健康 | 仅登记独立 081 迁移，连续编号检查覆盖 |
| `src/main/modules/rss-engine/ipc-handler.ts` | 1222 | 8 | 一般 | 新处理分组独立实现，宿主仅组装；2026-11-01 复查 |
| `src/main/modules/tools/tool-executor.ts` | 1264 | 4 | 一般 | 仅注入读取能力与当前模型配置检查；2026-11-01 复查 |
| `src/preload/index.ts` | 1545 | 6 | 一般 | 六个明确调用入口；2026-11-01 复查分域组装 |
| `src/renderer/types/electron.d.ts` | 3993 | 6 | 健康 | 引用共享整理合同，不复制字段定义 |

整理任务存储、判断方法、执行、IPC 与 UI 分别放在小模块；未把分类流程放进 Agent 调度宿主或既有文案/视觉分析管理器。

## 2026-10-01 RSS 自定义栏目与分类保存

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/migrations.ts` | 3374 | 2 | 健康 | 仅登记独立 080 迁移，编号检查已覆盖导入的常量名称 |
| `src/preload/index.ts` | 1539 | 9 | 一般 | 四个保存/读取入口及失效通知；2026-11-01 复查按域组装 |
| `src/renderer/components/rss/RSSFeed.tsx` | 1028 | 5 | 一般 | 只消费 Main 分类标签，管理和纠正 UI 已在独立组件；后续事件组卡须另设组件，2026-11-01 复查 |
| `src/renderer/types/electron.d.ts` | 3987 | 4 | 健康 | 共享分类合同的跨进程声明；移除旧分类选项与固定导出枚举 |

旧关键词分类器已删除，RSSStore 的 SQL 仍按内容与归属分工；新增组织存储、迁移和 UI 组件均未扩张既有大宿主。

## 2026-09-30 RSS 引用与只读能力

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1136 | 3 | 一般 | 仅消费统一 RSS 资源地板；2026-10-30 复查工具面组装 |
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1541 | 1 | 一般 | 登记单一引用读取工具；2026-10-30 复查注册表分组 |
| `src/main/modules/tools/tool-executor.ts` | 1260 | 2 | 一般 | 将本轮结构化引用交给 RSS 处理器；2026-10-30 复查跨域接线 |
| `src/renderer/stores/useAgent.ts` | 2115 | 1 | 一般 | 只向消息组装传本机会话事实，不放入 RSS 业务判断；2026-10-30 复查发送入口边界 |

RSS 引用协议、当前视图引用和预览均留在独立小模块；删除 SDK 重复上下文标记表与空指令全文回退，避免两处解析产生不同权限事实。

## 2026-09-30 RSS 保存笔记与范围导出

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/rss-engine/ipc-handler.ts` | 1217 | 12 | 一般 | 仅组装目录选择和独立 IPC 分组，文件保存逻辑在 workspace-files；2026-10-30 复查 |
| `src/preload/index.ts` | 1530 | 2 | 一般 | 两个具名入口，2026-10-30 复查按域组装 |
| `src/renderer/types/electron.d.ts` | 3983 | 2 | 健康 | 仅引用共享请求/回执类型，IPC 与类型检查覆盖 |

新增保存服务、转换器和按钮均小于 130 行；共享 Widget 解析删除重复扫描后净减 53 行，没有引入来源专用的第二套文档渲染器。

## 2026-09-30 RSS 网页分析统一原文

| 文件 | 当前行数 | 净增 | 判断 | 后续 |
|---|---:|---:|---|---|
| `src/main/modules/rss-engine/ipc-handler.ts` | 1243 | 3 | 一般 | 只传 Main 来源提示，新增业务继续留在现有分组；2026-10-30 复查 |
| `src/main/modules/rss-engine/item-analysis-manager.ts` | 1094 | 25 | 一般 | 新网页分析与版本校验已移到 article-analysis 叶子模块，宿主只排队和发布；2026-10-30 复查媒体 helper 与队列边界 |
| `src/main/modules/tools/tool-executor.ts` | 1258 | 2 | 一般 | 只接 RSS 状态读取，无本地重判；2026-10-30 复查 |
| `src/renderer/components/rss/RSSFeed.tsx` | 1087 | 4 | 一般 | 仅消费来源提示；按既定 P2 将导航、资讯流、任务面板分开，2026-10-30 复查 |
| `src/renderer/types/electron.d.ts` | 4023 | 2 | 健康 | 只声明既有分析消息的新展示字段 |

RSS 模型请求改走共享 SDK 后，subagent-runner 删除专用 HTTP/解析代码，净减 139 行；旧 content-extractor 101 行已删除。没有以搬走行数为由引入第二条正文保存路径。

## 2026-09-30 RSS 共享内容读取基础

以下仅增加入口接线/声明，新增持久化与提取逻辑分别在 `rss-content-store.ts`、`content-service.ts`、`content-schema.ts`，未继续堆入宿主。

| 文件 | 当前行数 | 净增 | 判断 | 处理 |
|---|---:|---:|---|---|
| `src/main/index.ts` | 1230 | 1 | 一般 | 退出等待加入正文任务；2026-10-30 复查生命周期装配增长 |
| `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1540 | 2 | 一般 | 两个正式只读工具登记；2026-10-30 复查组定义职责 |
| `src/main/modules/migrations.ts` | 3372 | 2 | 健康 | 只注册独立迁移函数，保持迁移顺序的单一职责 |
| `src/main/modules/rss-engine/ipc-handler.ts` | 1240 | 10 | 一般 | 只组装 contentGroup，正文 handler 已独立；2026-10-30 复查 |
| `src/main/modules/tools/tool-executor.ts` | 1256 | 1 | 一般 | 只传共享 reader 与会话权限事实，不在执行器实现 RSS 规则；2026-10-30 复查 |
| `src/preload/index.ts` | 1544 | 3 | 一般 | 三个具名 API；2026-10-30 复查按域组装 |
| `src/renderer/types/electron.d.ts` | 4021 | 3 | 健康 | 仅引用共享 RSS 类型，不另行定义正文或查询事实 |

## 2026-09-30 RSS 改版首个基础修复

- `src/main/modules/database.ts`：2955 行，本轮净增 3 行，评为 **危险**。沿用多产品数据库入口过度集中的判断；本次仅接通已有 RSS 分类字段的保存，未扩展领域职责，Electron 内存库写入/读回与分类导出已验证。后续正文、分类关系、事件和日报的新增存取逻辑应放在各自 RSS 仓储模块，不继续堆入本文件；拆分须与真实数据库行为验证配对，不能为减少行数扩大本次修复。

## 2026-09-30 数据保存职责拆分（后续状态）

- `src/main/modules/database.ts`：由 2955 行降为 254 行，当前评为 **健康**，取代上条风险的当前状态。六域 106 个方法下沉为独立 Store，原方法体保持一致；总管理器只保留连接生命周期和组装，原产品方法已移除。各新文件 39–797 行，未将同一大文件转移到另一处。
- `src/main/modules/calendar-engine/ipc-handler.ts`：1093 行，净增 1 行；**一般**。仅领域记录类型入口调整，无行为增长；2026-10-30 复查继续新增 handler 时是否应下沉。
- `src/main/modules/rss-engine/ipc-handler.ts`：1230 行，净增 1 行；**一般**。仅存储调用/类型接线调整，继续利用已有 IPC 分组，RSS 新功能不得继续向宿主堆积；2026-10-30 复查。
- `src/__tests__/tag-forge-batch.test.ts`：1059 行，净增 1 行；**一般**。仅连接类型导入调整，未新增场景；2026-10-30 复查下一次增加场景是否应按批次合同分文件。

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
| 2026-07-15 | 兼容模型能力与迟到错误收口 | `src/renderer/modules/agent/runtimeDriver.ts` | 1942 | 净 +6 | 一般 | 只给已恢复回答的迟到错误去重记录增加固定上限，不扩张事件职责；沿用 2026-08-11 的 scope-run 事件映射拆分复查。 | 已排期：2026-08-11 |
| 2026-07-15 | 兼容模型能力收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7547 | 净 +2 | 危险 | 仅把两条确实依赖文本工具桥的场景改为显式开启工具；共享 SDK 宿主测试仍明显过大，后续应把 provider/text-bridge 场景迁入独立集成套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 兼容模型能力收口 | `src/__tests__/agent-sdk-product-acceptance.test.ts` | 1006 | 净 +1 | 一般 | 仅让兼容接口文本桥验收明确声明工具能力，仍保持产品级验收单一职责；2026-08-15 复查是否按工具、技能与交付面拆分。 | 已排期：2026-08-15 |
| 2026-07-15 | 文档打开延迟收口 | `src/renderer/components/layout/FileTree.tsx` | 1954 | 净 +10 | 危险 | 文件树仍同时承担树/网格、拖放、剪藏占位和文件涌现接线；本轮已把空闲合并调度与稳定结构签名下沉独立叶子，正文、dirty 和激活时间不再触发涌现刷新，但真实卡顿再次证明宿主职责密度正在妨碍性能定位。后续优先把文件涌现状态与 pending clip 生命周期整体移出。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 文档打开延迟收口 | `src/renderer/pages/modes/DocumentMode.tsx` | 1090 | 净 +10 | 一般 | 只让隐藏 keep-alive 页面停止响应文件选择，去除同一打开动作的重复 stat/open/activity，并把空缓存首次读盘留给编辑器单一入口；磁盘 clean hydrate 已走 store 叶子。沿用 2026-08-11 复查，优先迁出阅读会话或滚动锚点。 | 已排期：2026-08-11 |
| 2026-07-15 | 历史错误终态修复 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1040 | 净 +34 | 一般 | 只统一“直接回答”在结束时的任务类型、验收条件和用量记录，并保留明确研究、浏览及续跑任务的原有要求；沿用 2026-08-15 复查终态事实解析是否应拆出。 | 已排期：2026-08-15 |
| 2026-07-15 | 历史错误终态修复 | `src/main/modules/migrations.ts` | 3370 | 净 +6（Migration 077） | 健康 | 只注册一次性历史修复；识别、修复和反例保护均在独立叶子模块，并由真实 Electron SQLite 幂等测试覆盖。 | 无需处理 |
| 2026-07-15 | 偏好与本地会话身份闭环 | `src/main/modules/agent-control/prompt-assembly.ts` | 1524 | 净 +8 | 一般 | 用户画像、Agent 语气和运行指令改为 L0 不可丢核心，格式化已下沉独立叶子模块；沿用 2026-08-15 复查静态触发、预算报告与资产装配的拆分空间。 | 已排期：2026-08-15 |
| 2026-07-15 | 偏好与本地会话身份闭环 | `src/main/modules/database.ts` | 2952 | 净 +1 | 危险 | 本轮只让本地旧入口显式绑定默认用户，并在更新时保留既有归属；多产品域数据操作仍集中在单一管理器，后续应把会话持久化下沉到独立仓储。 | 待拆分规划；交付时提醒 |
| 2026-07-15 | 偏好与本地会话身份闭环 | `src/main/modules/migrations.ts` | 3370 | 净 +12（Migration 078） | 健康 | 只追加顺序迁移 078，修复本地会话空用户归属；连续编号、幂等、远程隔离和真实 Electron SQLite 均有门禁。 | 无需处理 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/__tests__/agent-sdk-runtime.test.ts` | 7545 | 净 +61 | 危险 | 本轮补了“显式采集后切换到普通账号分析也不能继承写权限”的真实运行时回归；共享宿主测试继续膨胀，后续应把浏览器意图与工具面场景迁入独立集成套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/types/electron.d.ts` | 4017 | 净 +3 | 健康 | 只补齐浏览器任务停止入口的跨进程声明，类型检查和 IPC 合同测试覆盖。 | 无需处理 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/__tests__/stores.test.ts` | 3123 | 净 +78 | 危险 | 本轮补齐“空消息可补全、已有流式正文不得重复追加”的真实 store 顺序回归；文件已聚合多个 store 产品域，后续应把回答交付与持久化场景迁入独立套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/__tests__/browser-tools.test.ts` | 2745 | 净 +30 | 危险 | 本轮把状态查询锁为纯读取并补任务归属；浏览器工具测试仍把采集、下载、查询与接力混在同一套件，后续应先拆出采集生命周期合同。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/browser-engine/ipc-handler.ts` | 2668 | 净 +16 | 危险 | 本轮只移除查询触发采集并接入 source-aware 停止；浏览器控制器和跨进程装配仍集中，后续应把采集控制 facade 与 IPC 注册继续下沉。 | 待拆分规划；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/stores/useAgent.ts` | 2116 | 净 +4 | 一般 | 只收紧后端正文补全规则，避免覆盖已流式显示的回答；沿用 2026-08-11 的发送与交付编排下沉复查。 | 已排期：2026-08-11 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/browser-engine/content-task-runner.ts` | 1908 | 净 +51 | 危险 | 本轮补齐任务归属、执行绑定和输出路径投影，但可见发现、逐篇采集、卡片循环与投影组装仍共存；后续应先迁出投影元数据组装和各任务种类 runner。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/tools/browser-collection-tools.ts` | 1762 | 净 +78 | 危险 | 本轮将查询改为紧凑纯读取并传递任务归属；状态控制、确认、发现、下载与采集启动仍集中在一个大分派器，后续应先拆出状态/生命周期与采集启动两个边界。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/preload/index.ts` | 1539 | 净 +1 | 一般 | 只增加浏览器任务停止透传；沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/tools/tool-executor.ts` | 1255 | 净 +6 | 一般 | 统一入口只把当前 Agent、run、父任务与执行绑定交给浏览器工具，生命周期判断留在浏览器域；沿用 2026-08-14 的全局工具入口复查。 | 已排期：2026-08-14 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/components/agent/ChatPanel.tsx` | 1156 | 净 +2 | 一般 | 仅把停止采集处理器传给既有任务卡子树，展示和交互均留在叶子组件；沿用 2026-08-11 的宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1133 | 净 +15 | 一般 | 本轮把普通页面观察与持久采集工具面分开，未在宿主内加入站点特例；2026-08-15 复查工具面组装是否可继续下沉。 | 已排期：2026-08-15 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/components/agent/chat-panel/task/TaskCard.tsx` | 1010 | 净 +131 | 危险 | 本轮补齐固定卡边界、停止与清除分离、右滑清除和结果入口；文件已同时承担状态摘要、进度、产物、记忆、反馈及多类任务动作，后续应先拆出产物区与动作区，再收缩主卡壳。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1006 | 净 +8 | 一般 | 文件刚过线，本轮只让明确采集轮承担采集验收条件，非采集浏览器分析不再被误判；2026-08-15 复查终态事实解析是否应拆出。 | 已排期：2026-08-15 |
| 2026-07-15 | 工具真实可见性验收统一 | `src/__tests__/agent-sdk-product-acceptance.test.ts` | 1005 | 净 +1 | 一般 | 仅改用共享的真实工具可见性判定，避免把运行时已禁用的潜在工具误算为可用；文件刚过线且仍是产品级验收单一职责，2026-08-15 复查是否按工具、技能与交付面拆分。 | 已排期：2026-08-15 |
| 2026-07-15 | Ready 系统提示词生产接入 | `src/main/modules/agent-control/prompt-assembly.ts` | 1516 | 净 +17 | 一般 | 本轮只接入版本化常驻核心、按需产品背景和统一的本地日历日期，并移除虚假的工具索引；记忆、预算和领域片段仍沿原分层组装。2026-08-15 复查静态触发、预算报告和资产装配能否继续下沉到独立层。 | 已排期：2026-08-15 |
| 2026-07-15 | SQLite 测试覆盖声明收口 | `src/__tests__/tag-forge-batch.test.ts` | 1058 | 净 +31 | 一般 | 只在每个真实 SQLite 测试块入口增加统一环境保护，未继续混入新场景；沿用 2026-08-15 的容量、归属和审核恢复拆分复查。 | 已排期：2026-08-15 |
| 2026-07-15 | Tag Forge 丰富标签低干预收口 | `src/__tests__/tag-forge-batch.test.ts` | 1027 | 净 +924 | 一般 | 首次过线；文件仍只覆盖 Tag Forge 批量写入这一条真实链路，但场景与临时数据库夹具已经较密。2026-08-15 复查是否按容量、手工归属和审核恢复拆成并行测试文件。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/main/index.ts` | 1229 | 净 +2 | 一般 | 仅装配独立生图 IPC，生成、缓存与复制均留在叶子服务；沿用 2026-07-25 的组合根复查。 | 已排期：2026-07-25 |
| 2026-07-15 | AI 生图服务闭环 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1538 | 净 +16 | 一般 | 只注册一项生图工具和投影整形，生成行为在独立服务；2026-08-15 复查跨域注册表是否需要按能力拆分。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/main/modules/tools/tool-executor.ts` | 1249 | 小幅接线 | 一般 | 统一入口只转发生图请求，校验、调用与缓存全部下沉；沿用 2026-08-14 的全局工具入口复查。 | 已排期：2026-08-14 |
| 2026-07-15 | AI 生图服务闭环 | `src/preload/index.ts` | 1538 | 小幅接线 | 一般 | 仅增加生图测试、复制与拖存的跨进程透传；沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/components/document/MarkdownEditor.tsx` | 1054 | 净 +68 | 一般 | 首次过线；只让编辑和预览两种已有文档表面共享同一图片拖入处理，复制逻辑在独立服务。2026-08-15 复查拖入编排是否应下沉。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/components/layout/FileTree.tsx` | 1944 | 净 +38 | 一般 | 仅在现有外部拖放分支接入生图缓存文件的保存与刷新，并明确了失败会向用户显示而不会冒充成功；沿用 2026-08-11 的文件树拖放职责复查。 | 已排期：2026-08-11 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/pages/modes/BrowserMode.tsx` | 1422 | 净 +37 | 一般 | 只在生图拖动期间隐藏原生网页层并复用既有网页上传链；2026-08-15 复查原生层可见性编排是否需要继续下沉。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/types/electron.d.ts` | 4014 | 小幅接线 | 健康 | 机械补齐生图测试、缓存复制与拖存声明，类型检查和真实应用验收覆盖。 | 无需处理 |
| 2026-07-14 | Tag Forge 打包版低干预收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7500 | 净 +418 | 危险 | 本轮只追加显式选技、自然选技、续跑恢复和文本桥连续批处理的真实工具面回归；共享 SDK 宿主测试已明显过大，后续应把 Tag Forge 场景迁入独立集成套件。 | 待独立测试拆分合同 |
| 2026-07-14 | Tag Forge 打包版低干预收口 | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1218 | 净 +1 | 一般 | 仅把已选技能身份交给现有工具授权计算，Tag Forge 特例判断保留在独立 skill-intent 叶子模块；2026-08-14 复查 SDK 组装根接线密度。 | 已排期：2026-08-14 |
| 2026-07-14 | Tag Forge 打包版低干预收口 | `src/renderer/stores/useAgent.ts` | 2112 | 净 +8 | 一般 | 发送入口只把本轮实际引用的历史文件夹复用为可信附件，不新增授权状态或第二套附件池；沿用 2026-08-11 的发送编排下沉复查。 | 已排期：2026-08-11 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1112 | 净 +19 | 一般 | 本轮只补齐已选只读研究技能的能力地板与工具面收窄，避免显式 AnySearch 请求同时暴露无关浏览器和文件工具；2026-08-14 复查 SDK 工具面组装是否需要继续下沉。 | 已排期：2026-08-14 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/main/modules/skills-runtime/runtime-manager.ts` | 1166 | 净 +1 | 一般 | 仅把内置技能 manifest 的 `allowed_tools` 传入现有运行时描述，未增加新的加载分支；沿用 2026-08-11 的技能运行时装配复查。 | 已排期：2026-08-11 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/main/modules/tools/tool-executor.ts` | 1251 | 净 +30 | 一般 | 本轮只在统一工具入口解析已选技能的搜索/正文服务绑定并透传配置，搜索、垂直领域和回退行为都在独立叶子模块。沿用 2026-08-14 的全局工具入口路由复查。 | 已排期：2026-08-14 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/renderer/types/electron.d.ts` | 4000 | 净 +1 | 健康 | 只在外部服务类型合同中增加 AnySearch 枚举值，类型检查和 IPC 合同检查均已覆盖。 | 无需处理 |
| 2026-07-14 | RSS 重复内容修复 | `src/main/modules/migrations.ts` | 3352 | 净 +6 | 健康 | 只注册顺序 migration 076，具体身份归一和历史合并留在 RSS 叶子模块；连续编号、真实 Electron SQLite 和用户数据库副本迁移均已验证。 | 无需处理 |
| 2026-07-14 | RSS 重复内容修复 | `src/main/modules/rss-engine/ipc-handler.ts` | 1229 | 净 +16 | 一般 | 仅在统一抓取出口归一文章身份，让新增、单源刷新和全部刷新共用同一规则；沿用 2026-08-13 的 RSS IPC 组合根复查。 | 已排期：2026-08-13 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/tools/file-management-tools.ts` | 2037 | 净 +465 | 危险 | 批次全量扫描、不透明 item id、持久续跑、集中确认、真实路径复核与幂等审核都仍与搜索、读取、整理共存一文件，已明显妨碍定位和并行修改。下一步应整体迁出 Tag Forge batch executor 与状态存储；本轮不在交付前混入无行为收益的大规模搬移。 | 已于 2026-07-15 拆分至 819 行并收口 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/tools/tool-executor.ts` | 1221 | 净 +32 | 一般 | 全局入口只保留 Tag Forge 宿主确认调用，具体流程已下沉到 `tag-forge-host-review.ts`；2026-08-14 复查文件域路由与结果整形是否还能继续下沉。 | 已排期：2026-08-14 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/migrations.ts` | 3336 | +37 | 健康 | 只追加顺序 migration 074，把存疑提案改为批次、文档与 scope 隔离；连续迁移和真实 Electron SQLite 门禁覆盖。 | 无需处理 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1863 | +4 | 一般 | 只为自动创建标签的存疑提案补齐创建凭证作为隔离身份；沿用 2026-08-13 的 IPC 入口装配密度复查。 | 已排期：2026-08-13 |
| 2026-07-14 | 知识图谱动态浏览 | `src/preload/index.ts` | 1526 | 6 | 一般 | 仅增加索引完成事件的订阅透传；仍是跨进程 API 汇总面，沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-14 | 知识图谱动态浏览 | `src/renderer/types/electron.d.ts` | 4003 | 2 | 健康 | 只补齐索引完成事件的类型声明，类型检查与索引通知行为测试覆盖。 | 无需处理 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2645 | 净 +343 | 危险 | 调度判断、时间计算、恢复判断和队列均已下沉，但 runtime 宿主仍新增了较多定时任务装配、专用会话和运行回流接线，继续扩大已会妨碍定位。后续应把 schedule runtime facade 整体移到定时任务域，只保留生产主链调用入口。 | 待独立拆分；交付时提醒 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/migrations.ts` | 3299 | 206 | 健康 | 只追加顺序 migration 073，完成结构化任务、occurrence 账本、旧数据迁移和旧表退役；原生 SQLite 连续迁移测试已通过。 | 无需处理 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1859 | 净 +19 | 一般 | 只装配定时任务 IPC 与生命周期清理，业务判断留在 schedule group/runtime。2026-08-13 复查入口装配密度。 | 已排期：2026-08-13 |
| 2026-07-13 | Agent 定时任务 | `src/preload/index.ts` | 1520 | 约 +22 | 一般 | 只增加结构化定时任务读写与失效通知透传；沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-13 | Agent 定时任务 | `src/renderer/components/agent/ChatPanel.tsx` | 1155 | 净 +15 | 一般 | 只保留圆形时钟入口和受控开关接线，独立工作界面已移到 Workbench 宿主。沿用 2026-08-11 宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-13 | Agent 定时任务 | `src/main/index.ts` | 1227 | 约 +8 | 一般 | 只在数据库与 Agent runtime 可用后启动调度器，并在休眠恢复和退出时走同一生命周期；沿用 2026-07-25 组合根拆分复查。 | 已排期：2026-07-25 |
| 2026-07-13 | RSS Main 自动刷新 | `src/main/index.ts` | 1219 | 净 +63 | 一般 | 只组装独立 RSS 调度器、设置变更回调和有序退出清理，调度判断留在叶子模块；主进程组合根继续沿用 2026-07-25 的菜单与协议拆分复查。 | 已排期：2026-07-25 |
| 2026-07-13 | RSS Main 自动刷新 | `src/main/modules/rss-engine/ipc-handler.ts` | 1213 | 净 +43 | 一般 | 仅增加自动刷新设置读取、最近完成时间读取、完成通知和现有 `fetchAll` 入口导出；抓取与调度逻辑分别留在 fetch group 和独立调度器。2026-08-13 复查组合根增长。 | 已排期：2026-08-13 |
| 2026-07-13 | RSS Main 自动刷新 | `src/preload/index.ts` | 1505 | 净 +7 | 一般 | 仅增加自动刷新状态查询和完成事件透传；仍是跨进程 API 汇总面，沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-13 | RSS Main 自动刷新 | `src/renderer/types/electron.d.ts` | 4020 | 净 +3 | 健康 | 只补齐 RSS 自动刷新状态与事件的跨进程类型声明，类型检查与 IPC 合同 gate 覆盖。 | 无需处理 |
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
