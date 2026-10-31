---
title: Ready Next M7 AI 编织设计调研
date: 2026-10-31
status: proposal
enforce: false
---

# Ready Next M7 AI 编织设计调研

> 状态：只读调研结论（2026-10-31，基于当时的 ready-next 代码，行号会随代码变化）。
>
> 取舍：§6 的待定项先按"推荐"列执行，均可逆，用户可随时改：
> - 访问范围只限明确选择的对象，不默认整库；
> - 普通持久写复用对话档位，但逐个登记确认规则；删除、覆盖仍逐次确认（M2），日历维持现状；
> - 遇到未保存内容：能安全合并则保持未保存，否则报冲突；
> - 多对象任务每项独立回执；
> - AI 对关闭对象的写入提供受版本保护的撤销；
> - 来源只记录本次贡献；
> - 首批评论只读，导入和数据库结构修改不开放。
>
> 实施顺序：先做只读的 M7-A（结构化资源与准入）和 M7-B（只读能力），写入类 M7-C～F 在它们通过后再做。

结论：**M7 可以沿现有产品动作桥接入，但目前只接通了当前文档的部分操作和日历等旧有产品能力。页面、数据库、画板、书籍及关系查询，还不能因为各自界面已经可用，就直接视为 AI 已可调用。**

建议把 M7 拆为六项交付：先补结构化资源和授权，再分别接页面、数据库、画板、日历，最后以真实产物和来源回读验收。无需恢复 DomainAdapter，也无需新增模型循环。

本次没有修改任何文件。以下明确区分“当前实现”和“建议新增”。

**一、现状：现有链路能做什么**

1. **产品桥当前的动作范围**

当前精确映射包括：

- 当前文档：读区段、列出/插入/更新/删除 Widget、精确替换、保存当前标签。
- RSS：添加来源、刷新、选择条目、分析及查询分析结果、捕获当前状态。
- 日历：查询时间窗口、新建、修改、删除事件、捕获当前状态。
- 便签、Tag Forge 的两个受限动作、展示文件。

没有页面创建、数据库字段修改、画板操作、书籍读取或关系查询映射。尤其是注册表中虽然存在 `document_append_content` 等名称，**产品桥并未允许它们执行**。

依据：[动作映射第 1–27 行](../../../src/main/modules/agent-control/codex-runtime/codex-product-action-map.ts:1)、[文档工具注册第 211–228 行](../../../src/main/modules/agent-control/tools-runtime/tool-registry.ts:211)。

2. **注册、授权、冻结、执行是不同步骤**

| 步骤 | 当前机制 | M7 必须保留的边界 |
|---|---|---|
| 注册 | 产品工具由注册表和输入结构登记；技能动作另从 manifest 解析 | 名字存在不等于本轮可用 |
| 技能授权 | `SkillToolAuthorization` 分别保存允许的具体动作和 primitive | 不得借技能描述开放整组写工具 |
| 准入冻结 | `resolveReadyToolTurnSnapshot` 校验工具结构，冻结线程工具面和本轮允许集合 | 旧线程缺少新工具时不能临时补入 |
| 产品面组合 | 当前文档、目录、日历等在同一快照上组合 | 保留其他已授权能力；排他任务遵守自身合同 |
| 执行检查 | 先检查工具存在、授权、允许集合和参数，再进入行动确认 | 确认不能替代授权 |
| 产品桥 | 检查当前工具是否允许调用这个**精确动作**，并核对本轮身份 | 不接受按名称前缀授权 |
| 结果收口 | 动作回执进入账本，运行结果经生命周期适配器收口 | 工具返回或模型说完成，不等于最终成功 |

关键位置：

- [技能授权类型：30–56 行](../../../src/main/modules/agent-control/skills/skill-tool-authorization.ts:30)。
- [准入冻结：571–618 行](../../../src/main/modules/agent-control/codex-runtime/codex-tool-surface.ts:571)。
- [产品面组合：73–101 行、193–209 行](../../../src/main/modules/agent-control/codex-runtime/codex-tool-surface-composition.ts:73)。
- [执行检查：410–554 行](../../../src/main/modules/tools/tool-executor.ts:410)。
- [生产接线：176–200 行](../../../src/main/modules/agent-control/codex-runtime/composition/runtime-start.ts:176)。
- [生命周期执行与收口：389 行、463–489 行](../../../src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts:463)。

3. **行动确认已经可复用，但新增写工具必须明确登记**

当前顺序是：授权与参数检查通过 → 确认策略 → 冻结具体参数 → 用户确认 → 用原参数重新进入执行检查。

现有规则：

- 当前文档的缓冲区编辑可见、可撤销；保存原文件属于 M3，`ask` 询问，`auto/full` 可代决。
- 日历新建、修改当前落入 `known-write-default`，属于 **M2，逐次确认**。
- 日历删除属于 M2。
- **未列入规则的普通工具默认 M4 放行。** 因此 M7 不能只注册新写工具而忘记补确认规则。

依据：[确认入口：603–716 行](../../../src/main/modules/tools/tool-executor.ts:603)、[冻结参数：99–121 行](../../../src/main/modules/agent-control/safety/frozen-call-confirmation.ts:99)、[保存规则：338–344 行](../../../src/main/modules/agent-control/safety/action-confirmation-policy.ts:338)、[默认规则：513–527 行](../../../src/main/modules/agent-control/safety/action-confirmation-policy.ts:513)。

4. **已有回执保护，但不能代替各写入口自身的防重复能力**

产品桥会记录动作身份；同一已确认动作可返回原结果，结果未知则拒绝自动重试。可是底层写入完成、产品桥尚未记录结果时仍可能中断，所以底层也必须识别同一次操作。

当前差异：

- 页面操作已有持久 `operationId` 和回执。
- 画板已有持久操作记录、版本检查、恢复与回执。
- 文档写入有前后版本、回读和缓冲协调，但输入没有持久 `operationId`。
- 数据库 `setFields` 有版本检查，但没有操作编号；创建行已有编号。
- 日历底层返回撤销数据，当前 AI 动作结果没有把它完整交出去。

依据：[产品桥防重复与未知结果：67–101 行、120–167 行](../../../src/main/modules/agent-control/codex-runtime/codex-product-action-requester.ts:67)、[文档输入与回执：8–17 行](../../../src/main/modules/document-engine/document-write-service.ts:8)、[数据库请求结构：7–17 行](../../../src/shared/document-database/requests.ts:7)。

**二、能力清单与写入归属**

下表是建议的 M7 首批范围，不表示已经接通。

确认约定：

- **读**：低风险，不弹行动确认；仍须具有对象及范围授权。
- **普通持久写**：中风险，建议新增明确 M3 规则；`ask` 确认，`auto/full` 仅在规则明确允许时代决。
- **删除、覆盖、批量破坏性修改**：高风险，M2 逐次确认。
- 日历沿用当前 M2，不在 M7 顺带放宽。

| 模块与动作 | 风险、确认 | 现有入口、版本与回执要求 | 撤销 |
|---|---|---|---|
| 资料库：列出授权范围内页面、文件夹 | 低；无需确认 | 复用对象登记和页面树读模型；M7 增加范围限制、分页、快照版本 | 不适用 |
| 页面：读正文、区段、选区 | 低；无需确认 | 当前文档沿用精确读取；其他页面由 Main 按对象定位，返回范围、版本、摘要及读取回执 | 不适用 |
| 页面：建页、生成笔记 | 中；普通持久写 | `DocumentPageService.operate(create)` → 草稿落盘；保留操作编号；检查父位置和目标不存在；返回页面回执 | 将本次新页移入回收站；已有后续修改时先提示 |
| 页面：追加块、精确改块、插入引用 | 中；仅缓冲修改沿用可见撤销，落盘按普通持久写 | `commitDocumentOperation`；强制期望版本，补持久操作编号；区分未保存与已保存 | 打开的页面走编辑历史；关闭对象需新增带版本保护的反向操作 |
| 页面：改属性、改名、移动 | 中；普通持久写；覆盖为高风险 | 属性走 `patchProperties`；标题/移动走 `operate(rename/move)`；不得直接改路径 | 保存旧属性或原位置，通过同一入口反向修改 |
| 数据库：读定义、查询视图和行 | 低；无需确认 | `DocumentDatabaseService.read/query`；限制授权数据库和行数，保留定义及行版本 | 不适用 |
| 数据库：新建行、修改字段 | 中；普通持久写 | `request(createRow/setFields)`；字段继续由数据库规则校验；补定义版本检查及字段写操作回执 | 新行回收；字段按旧值反向修改，拒绝覆盖后续编辑 |
| 数据库：删除行 | 高；M2 | `request(deleteRow)` → 页面回收；当前缺少删除时版本条件，开放前补齐 | 页面恢复入口 |
| 画板：读选中卡片、布局及连接 | 低；无需确认 | `CanvasService.open/read`；Main 持有句柄，绑定画板、选区和版本；引用卡不自动授权读取被引用正文 | 不适用 |
| 画板：加卡、连线、改卡片文字、移动/分组 | 中；普通持久写 | `CanvasService.write`；对象、句柄、期望版本、操作编号齐全；只接受允许的命令 | 打开画板走一次编辑历史；关闭画板需新增受版本保护的撤销入口 |
| 画板：回收卡片 | 高；M2 | 经句柄执行 `trash`，不默认开放物理删除 | 经句柄执行 `restore` |
| 画板：选区转提纲/文档 | 中；普通持久写 | 纯 AI 提纲：读选区后走页面创建；需要草稿卡、附件和成文联动时复用 `CanvasCompositionService` | 新文档回收；联动卡片按对应操作恢复 |
| 来源页、当前书：读来源说明、章节、标注 | 低；无需确认 | 来源页按页面读；书籍按书 ID、资产版本、章节/范围读取；新增受限读取接线 | 不适用 |
| 来源页：生成读书笔记、追加引用 | 中；普通持久写 | 已存在来源页走文档写入服务；需要创建来源页时才调用 `SourceDocumentService.ensure` | 同页面操作 |
| 关系：查询出链、反链 | 低；无需确认 | `ObjectLinkRepository.outgoing/incoming`，外层加资料库及对象授权过滤、数量和完整性说明 | 不适用 |
| 日历：读窗口、“这一天” | 低；无需确认 | 日程用现有 list；跨图层当天汇总复用 `CalendarLinkageService.day`，新增带时区和版本的资源读取 | 不适用 |
| 日历：建事件、改时间/字段、删除 | 中/高；当前均 M2 | 继续 `CalendarStore.mutate`；更新/删除保留 revision、原始重复实例和范围；将结果与撤销信息接入产品回执 | `restore(delta, expectedVersions)`；当前 AI 侧尚未接出 |
| 联动：卡片安排日程、页面关联事件 | 中；M2 | 卡片复用 `CalendarLinkageService.schedule`；事件和关联一次提交；页面关联复用日历 link 命令 | 撤回本次事件及关联，保留其他关联 |
| 日期字段、待办日期调整 | 中；普通持久写 | `CalendarLayersService.move` 按实际归属调用数据库或文档入口；不另造日历事件 | 恢复对应字段/文字；阅读足迹保持只读 |

以上写入口的主要依据：

- [页面服务：68–85 行、196–255 行](../../../src/main/modules/document-pages/service.ts:196)。
- [文档提交：87–155 行](../../../src/main/modules/document-engine/document-write-service.ts:87)。
- [数据库字段写入：148–184 行；建行/回收：279–295 行](../../../src/main/modules/document-database/service.ts:148)。
- [画板写入：112–163 行；完成回执：302–305 行](../../../src/main/modules/board-engine/canvas-service.ts:112)。
- [画板结果及撤销类型：25–44 行](../../../src/shared/ready-canvas/operations.ts:25)。其中 `restoreSnapshot` 明确属于内部历史，不能直接开放给模型。
- [来源页创建及标注：22–66 行](../../../src/main/modules/library-engine/source-documents.ts:22)。
- [关系读取：33–44 行](../../../src/main/modules/search-engine/object-links.ts:33)。
- [日历修改的实例及版本检查：298–335 行](../../../src/main/modules/agent-control/codex-runtime/codex-product-action-handlers.ts:298)、[底层撤销回执：68–145 行](../../../src/main/modules/database/calendar-store.ts:68)。
- [卡片安排日程：18–40 行](../../../src/main/modules/calendar-linkage/service.ts:18)、[日期按归属写入：86–109 行](../../../src/main/modules/calendar-layers/service.ts:86)。

另外建议保留以下范围边界：

- 评论可先开放读取。新增、回复、删除评论有独立存储与修订号，不能伪装成正文写入；开放写评论前还需补操作编号和撤销。见[评论服务：22–55 行](../../../src/main/modules/document-annotations/service.ts:22)。
- 模板可开放列出和按模板建页，复用模板服务及页面回执；模板内容也要冻结版本。`expand` 会准备并发布附件，不能标成纯读取。见[模板服务：31–73 行](../../../src/main/modules/document-templates/service.ts:31)。
- 首批不开放永久删除、任意文件写入、数据库字段迁移、批量导入或隐式网络抓取。

**三、manifest action 还是 primitive**

这里需要区分：**现有内置产品工具不等同于 `skill_*` primitive。** 仓库本来就存在产品工具、manifest 动作和技能 primitive 三种来源。

推荐分配如下：

| 能力 | 推荐接入 |
|---|---|
| 上表所有页面、数据库、画板、来源、关系读写 | 宿主内置、参数受限的产品工具，通过产品桥调用现有服务 |
| 现有日历、当前文档工具 | 保留名称和桥接路径，补齐需要的资源与回执合同 |
| “资料库约定”技能 | reference/advisory；manifest 不承载业务写动作 |
| 读书笔记、画板转提纲、文档转日程 | 技能说明方法，当前同一回合组合调用上述工具 |
| 通用 shell、脚本、任意路径读写 | 不因 M7 开放 |

这比为每个模块增加一套可执行技能更简单，也符合“关系查询独立准入”的计划要求。[整合计划 §3.9](../../../docs/superpowers/plans/2026-10-30-ready-next-integration-implementation.md:217)

防止工具面扩大的具体规则：

1. 选中资料库技能，只获得方法论；不会自动获得全库读取或写入权限。
2. 显式页面/选区资源建立最小读取地板；读取附件不附带写权限。
3. 写动作必须同时具备：本轮工具授权、目标对象授权、允许的操作、有效版本以及必要确认。
4. 关系查询作为独立只读能力。查到一个链接，不代表可以继续读目标正文。
5. Main 在准入前完成组合和冻结；执行中不补挂技能、不改工具集合。
6. 当前文档、日历和网页能力采用加性组合，不互相覆盖。排他技能的冲突在准入时解决。
7. 新工具必须有明确确认规则，避免落入默认放行。

**四、上下文怎样作为资源进入回合**

当前实现已有一部分基础，也有明确缺口：

| 上下文 | 当前状态 | M7 接法 |
|---|---|---|
| 当前文档 | 已捕获标签、分栏、版本、内容摘要、路径摘要；不发送全文 | 复用；补页面对象 ID、资料库身份及块编辑器缓冲版本 |
| 文档选区 | `quoted_text` 会把摘录正文直接加入模型输入 | 改为选区资源：对象/草稿 ID、版本、块或范围、选区摘要；正文按需读取 |
| 画板选区 | 发送资源类型中没有画板选区 | 新增画板资源：画板 ID、选中节点、版本；打开缓冲还需标签实例和缓冲版本 |
| 当前书/章节 | 发送资源类型中没有书籍资源 | 新增书籍位置资源：书 ID、资产版本、章节、引用范围；书籍资产和来源页分别授权 |
| 日历当天 | 窗口已有无正文资源；“这一天”目前仍是文本附件 | 新增当天资源，冻结日期、显示时区、汇总范围；读取时返回有版本的结果 |
| ReadyRef | 可导航，不自行授权 | Main 解析后落到上面具体资源类型，拒绝失效、歧义及未授权对象 |

现有依据：

- [当前文档锚：95–130 行](../../../src/renderer/modules/agent/codexCurrentDocumentAnchor.ts:95)。
- [发送资源类型：325 行起](../../../src/shared/ipc-contracts/agent-runtime.ts:325)。
- [日历窗口与引用正文处理：335–418 行](../../../src/main/modules/agent-control/codex-runtime/codex-explicit-resources.ts:335)。
- [“这一天”文本附件：11–18 行](../../../src/renderer/modules/calendar/linkage/attachments.ts:11)。
- [当前文档先读后写及绑定回执：453–575 行](../../../src/main/modules/agent-control/codex-runtime/codex-product-turn-authorization.ts:453)。

模型开场只需看到资源名称、身份、范围、版本和可调用的读取方式。实际内容通过读取结果提供；材料中的指令不能转化为新的授权。

所有读取还应遵守：

- 发送后切换标签，不改变本轮对象。
- 人工编辑后旧版本失效；同一回合自己产生的新版本可沿已确认回执继续读取。
- 选中群组是否包含子卡片，在发送时明确冻结。
- 只允许读选区时，不能因卡片引用、同步块或反链继续展开其他正文。
- 无文件身份的草稿使用草稿资源，不能假装成已保存页面。

来源记录建议由 Main 根据真实会话和运行填写，不能由模型填写任意对话地址。新文档按计划写 `ready_source`；画板可复用已有 `ready.sources`；同时记录输入材料的版本与范围。画板已有来源结构，见[第 38–48 行](../../../src/shared/ready-canvas/schema.ts:38)。正文 frontmatter 的 ReadyRef 已可进入关系索引，见[第 32–46 行](../../../src/main/modules/search-engine/object-link-extract.ts:32)。

**五、M7-A…M7-F 任务拆分**

下面是建议的未来修改范围，本次均未修改。每项先固定行为合同，再接代码；新增测试、文件名和 M7 gate 均为建议。

**M7-A：结构化资源与准入**

- **范围**：`src/shared/ipc-contracts/agent-runtime.ts`；`src/main/modules/agent-control/contracts/request-envelope.ts`；`codex-runtime/` 中显式资源、准入准备、工具面组合；Renderer 的 `codexCurrentDocumentAnchor.ts`、发送编排及日历附件入口。
- **依赖**：M1 对象身份、M3 缓冲身份、M4 画板身份、M6 实例身份。
- **合同与检查**：建立计划中的 `ready-ref-agent-resources.test.ts`。测试伪造引用、跨库对象、旧版本、标签关闭、无身份草稿、选区越界、工具地板缺失；断言拒绝时没有内容泄漏和写入调用。检查实际构造的模型输入不含资源全文。回归 `codex-explicit-resources`、`codex-product-resource-envelope`、`codex-tool-surface`。
- **真实窗口验收**：分别附加文档选区、画板选区、书籍章节和当天；发送后切换标签或修改内容，确认只读原目标或明确提示版本变化。

**M7-B：只读能力、资料库技能与来源合同**

- **范围**：产品工具定义与执行接线；`tools-runtime/tool-registry.ts`；现有能力目录；`search-engine/object-links.ts`；来源/书籍读取接口；新增 `assets/embedded-skills/<资料库技能>/SKILL.md` 和 `ready-skill.json`；来源显示及 `open-ready-ref.ts`。
- **依赖**：M7-A。
- **合同与检查**：授权范围内可读，范围外不可读；关系查询不自动授权正文；分页结果说明是否完整；来源身份来自当前运行；删除会话后保留产物但显示来源不可用。运行 `skills:lint`、相关消费者测试及工具面组合测试。
- **真实窗口验收**：从书籍引用生成仅聊天中的笔记提纲；从页面查看反链；点击真实来源可回到正确位置，未授权关联材料不可被读取。

**M7-C：页面、块写入与安全撤销**

- **范围**：`document-write-service.ts`、`document-pages/`、必要的草稿接线；产品桥映射及处理器；确认策略；Renderer 文档动作、块编辑历史和保存入口。
- **依赖**：M7-A、B。
- **合同与检查**：追加/替换使用精确读取版本；同一操作重放不重复追加；未保存内容不被覆盖；回读失败不得报成功；撤销不覆盖后续编辑；创建产物包含真实来源。复用 `document-write-service-native.test.ts`、`ready-document-pages-native.test.ts`、块历史与保存测试。合同覆盖 C2/C3/C4/C12。
- **真实窗口验收**：在未保存页面中追加内容，保留人工修改；一次撤销；确认保存后关闭重开；并发外部修改必须保留双方内容或明确冲突。

**M7-D：数据库读写**

- **范围**：`src/shared/document-database/requests.ts`、`document-database/service.ts`、对应工具及处理器；必要的字段变化反馈。
- **依赖**：M7-A、B；写回执和撤销依赖 C。
- **合同与检查**：同时检查数据库定义和目标行版本；拒绝错误字段类型、计算字段写入、跨库行；关系字段不绕过目标权限；重复建行只有一页；字段写结果区分保存与未保存。复用 `ready-database-native.test.ts`、`ready-database-read-native.test.ts`、往返及关系测试。
- **真实窗口验收**：指定视图批量读取、改单行字段、新建一行；人工同时改字段触发冲突；正文和数据库视图读回一致。

**M7-E：画板、FastCard 引用与成文**

- **范围**：`board-engine/canvas-service.ts`、`src/shared/ready-canvas/operations.ts`、`canvas-composition/`、画板选区与历史接线、对应产品工具。
- **依赖**：M7-A、B；生成文档依赖 C。
- **合同与检查**：句柄不能跨画板；未选中节点不被修改；重放不重复卡片；未保存缓冲不报已落盘；节点、附件、关系均回读；撤销遵守后续版本。复用 `ready-canvas-write-native.test.ts`、`ready-canvas-composition-native.test.ts`、FastCard 转画板测试。合同覆盖 C3/C10/C12/C13。
- **真实窗口验收**：选三张卡生成提纲、添加引用卡、调整分组；同时编辑其中一张卡验证冲突；重开后检查来源、附件及撤销。

**M7-F：日历联动与四条完整使用链路**

- **范围**：产品桥日历处理器、`calendar-linkage/`、`calendar-layers/`、必要的日历回执接线；现有工作台 gate 和整合计划的验收记录。
- **依赖**：M7-A、B；文档转日程依赖 C，数据库日期依赖 D，卡片安排日程依赖 E。
- **合同与检查**：日期/时区及重复实例不丢；事件与关联一次提交；中断重试不重复创建；撤销恢复关联；提醒不重复；来源正确。复用 `calendar-union-native.test.ts`、`calendar-linkage-native.test.ts`、`calendar-event-links-native.test.ts`、日期提醒测试。
- **真实窗口验收**：完成“引用式读书笔记、画板转提纲、文档转日程、整理画板”四条链路。每条均检查实际产物、来源跳转、确认取消、撤销、重开后的结果。

后续代码交付共同要求：

- `typecheck`、受影响行为测试、`verify:codex-workbench-surface`。
- 涉及持久化时执行项目要求的 `verify:native`。
- 可以新增薄的 M7 汇总 gate，只串联真实行为测试，不用源码文字匹配代替结果验证。
- 真实窗口检查由 Claude 在隔离 Ready Next 数据和测试资料库中执行。现有 `verify:ready-next-canvas/sources/timeline` 是窗口验收入口，不是命令行测试的替代品。

**六、接入前必须处理的风险与待定选项**

| 问题 | 选项 | 推荐 |
|---|---|---|
| 全库访问范围 | 默认整库 / 明确选择的对象或范围 | **明确范围**。需要整库任务时一次授权具体资料库，不从当前页面推导 |
| 普通本地写入确认 | 所有操作逐次询问 / 复用对话档位 | **复用档位，但逐个登记规则**；删除、覆盖仍 M2，日历先保持现状 |
| 遇到未保存内容 | 自动保存 / 合并后保持未保存 / 拒绝 | **能安全合并则保持未保存，否则冲突**，不替用户保存其他修改 |
| 多对象任务 | 承诺全部成功或全部撤销 / 每项独立回执 | **每项独立回执**；仅已有服务支持的事件+关联、附件+画板等保持其原子边界 |
| 撤销范围 | 仅当前窗口历史 / 持久撤销 | 打开对象复用历史；AI 对关闭对象的持久写入应提供**持久、受版本保护的撤销** |
| AI 修改既有页面的来源 | 把整页标成 AI 生成 / 只记录本次贡献 | **只记录本次贡献**；新生成整页才使用整页生成标识 |
| 评论、导入、数据库结构修改 | 首批全部开放 / 分期 | **首批评论只读、导入及结构迁移暂不开放** |

另有四项源码层面的接入条件：

- **文档保存链需补传读取时的版本。** 现有 AI 保存调用 `writeFile(targetPath, contentToSave)` 没有传期望版本，而下层参数是可选的。M7 必须验证“读取后磁盘被别人修改”这一边界，不能只依赖缓冲区摘要。[现有调用](../../../src/renderer/modules/agent/document-actions/execute.ts:1182)、[下层入口](../../../src/main/modules/document-engine/document-editable-text.ts:103)。
- **动作编号应由 Main 贯通。** 产品桥已经产生动作身份，但目前处理器只收到动作名和参数。新增写入口要内部携带该身份，不让模型随意重造编号来绕过防重复。
- **“读接口”不一定纯读取。** `LibraryEngine.get/findBook` 会经过升级扫描；来源页 `ensure` 会创建文件；页面树会登记对象。AI 只读工具应使用受限读路径，不能顺带升级正文或创建来源页。[书房扫描](../../../src/main/modules/library-engine/library-engine.ts:56)。
- **已合并不等于已保存。** 文档返回 `merged_dirty`，画板也有同名结果；回执、任务卡和最终说明必须保留这个区别。

**七、本次检查结果及未完成项**

修改文件：**无**。未执行提交、切换分支、安装依赖、构建、测试或窗口启动；未访问日常 Ready 数据。

完成了规则正文比对、分支/工作区检查、源码调用链阅读、测试与脚本登记核对。只读检查的关键输出：

```text
AGENTS_CLAUDE_BODY_EQUAL=True
EXISTING_GATES=7/7
M7_RESOURCE_TEST_EXISTS=False
NATIVE_GATE_REBUILDS=True
M7_GATES=[]
<worktree>
```

结束时 `git status --short` 无输出。

这些结果只证明规则同步、脚本存在及当前源码状况，**不代表行为测试通过**。`verify:native` 包含原生依赖重编，窗口脚本会创建夹具和证据，因此本次只读调研没有执行它们。一次只读检查使用的 heredoc 被沙箱因临时文件限制拒绝，随后改为不生成文件的 `python3 -B -c` 完成。

调研已完成。尚未完成的是上述 M7 实施、行为测试及 Claude 的真实窗口验收；计划中指定的 `ready-ref-agent-resources.test.ts` 当前尚不存在，不能把整合计划中的 M7 完成条件视作已兑现。

