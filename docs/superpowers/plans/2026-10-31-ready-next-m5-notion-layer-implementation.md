---
title: Ready Next M5 Notion 层实施合同
date: 2026-10-31
status: in-progress
enforce: true
---

# Ready Next M5 Notion 层实施合同

## 1. 范围与依据

依据[整合计划](2026-10-30-ready-next-integration-implementation.md) §4、M5 及 D5 调研已采纳决定。A 交付文件模型、查询、Main 服务与书房定义升级；B–F 和真实窗口验收不能由 A 的命令行测试替代。遵守 C2/C3/C4/C5/C12/C15。

## 2. 已定决定

- `库.md` frontmatter 的 `ready_database` 必有 `version: 1`、`source`、`fields`、`views`。source 为同级目录名，默认同名 `库/`；`recursive` 默认 false，仅收直属 Markdown。书房升级明确设 true，保留嵌套来源页范围。
- fields 的键是实际存储键；每项有稳定 `id`、显示 `name` 与 `type`。显示名不改行，存储键改名保留 id，必须经可恢复迁移。视图及公式用字段 id，不用显示名。`$title`、`$id` 是只读系统列；标题改名归页面服务。
- 行身份复用对象 id；关联引用目标按现有身份服务写入 ready_id。视图有稳定 id、库内唯一名称；内联语法 `![[库#视图名]]`。不存在、重名和循环均明确失败。
- 字段、视图、筛选、排序、分组、列计算、可见列、卡片字段写库文件；列宽、当前视图和滚动位置属于 ready.db 个人状态。
- 未知 frontmatter、定义扩展、正文、注释及换行保留。已声明字段不合法返回带行 id、字段 id 的错误；不能默默变空。公式和汇总结果只在查询快照存在，禁止写回行。
- Renderer 只经 Main 服务操作，不能直接读写文件。Main 复用对象登记、页面草稿/回收站及文档写入服务；`merged_dirty` 返回 `unsaved`，不发已保存回执。

## 3. 文件格式与查询

| 类型 | 值与规则 |
| --- | --- |
| text / number | 字符串 / 有限数；缺失、null、0 分开 |
| select / multi_select | 字符串 / 不重复字符串列表；声明 options 时必须属于选项 |
| date | YYYY-MM-DD 或带时区 ISO 时间；范围 `{start,end}` 两端包含、同类且 start≤end，全天日期不转 UTC |
| checkbox / url | 布尔 / 合法 http(s) URL；缺失与 false 分开 |
| relation | 去重的 `[[页面]]` 列表；不接受别名、片段或任意对象；复用关系索引，缺失、回收、歧义明确返回错误 |
| rollup | `relation` 指关联字段 id，`target` 指目标 frontmatter 键，`operation` 为 count/sum/average/min/max/unique；关联集合被截断或未解析时返回 incomplete，不生成貌似完整的数值 |
| formula | `expression`：字面量、括号、算术/比较/逻辑、prop("字段id")、if/coalesce/abs/round/min/max；无 eval、属性访问或任意函数；语法、循环、除零分别报告 |

七类视图：table、board、calendar、timeline、gallery、list、bookshelf。视图包含 filters（全部满足）、sorts、groupBy、calculations、visibleFields、cardFields，时间视图用 dateField。先计算行派生值，再筛选、稳定排序、分组与列计算，最后分页；列计算覆盖完整筛选集合。多选按各选项入组，同值排序以对象 id 收尾。书架只投影 `类型: 书` 来源行。日期移动和看板拖动由 B 调用同一字段写入口，不创建日程。

查询缓存按对象 id、修订号、文件状态失效；目录成员和关联目标也参与重新核对。热查询不重复读取全部正文。关联查询若达到索引接口上限，必须标明不完整。热查询 1000 行 p95≤100ms；已有索引首屏≤500ms，冷读另记；真实滚动与输入延迟由 Claude 验证。

## 4. 操作、恢复与回执

- 写入请求含数据库对象 id、行对象 id（适用时）、expectedVersion；定义编辑另校验字段身份。新增行/删除行使用持久 operationId，重试复用页面服务回执。
- 存储键迁移：持久记录请求、逐文件原文/目标哈希和对象身份 → 按期望版本逐项改对应键 → 最后更新库定义 → 回读和索引确认 → committed。中断保留 prepared/recovery_required；重试只接受原版本或已写目标版本，拒绝覆盖后来修改。相同 id 不同输入拒绝；进行中禁止该库其他写入及查询，避免暴露半迁移。
- 视图改名写入持久待修复引用记录，回执明确 `pending_reference_repair`，由整合入口消费修复结果；不能声称引用已修复。
- 书房一次升级先保留原文件备份及持久计划，按同一恢复规则发布并回读。旧 `来源` 结构保持为 metadata；可编辑文本列迁至 `来源说明`（显示名仍为来源），由原 kind/ref/url 提供初值；新导入同时提供此文本列。已有字段、视图及自定义扩展保留，旧格式不进入正常查询路径。

## 5. 可执行验收合同

| 合同 | 验证 |
| --- | --- |
| DB1 格式、字段/视图/行往返、未知内容、具体错误、公式不落盘 | ready-database-roundtrip.test.ts |
| DB2 安全表达式、循环/除零、筛选排序分组/全量列计算、截断汇总、七视图与内联 | ready-database-roundtrip.test.ts |
| DB3 真实 SQLite、临时资料库、局部字段写、版本冲突、迁移中断/重试、回收站、缓存失效 | ready-database-native.test.ts，加入 verify:native；开头 skipIfSqliteUnavailable，Electron 无 skip 才算通过 |
| DB4 1000 行查询，记录 p95 | ready-database-performance.test.ts |
| DB5 阅读定义备份、恢复、回读及往返，自定义字段/视图和嵌套来源保留 | ready-database-native.test.ts |
| DB6 导入保真（整合计划 §4） | M5-E 的 ready-library-import.test.ts：层级、正文、字段、视图、附件逐项一致；源不变，缺失明确，中断可恢复，重试不重复；A 不宣称完成导入 |

## 6. 顺序与公共文件负责人

1. M5-A 与 M6-A 可并行，M5-C/D/F 先做独立服务。
2. A 冻结格式后 B 做七视图；A/D 合同齐备后 E 做 Notion/Inkwell 一次导入。
3. M3 T4/T6 后接编辑器、内联、评论和日期提及；M4 B–F 交接后接完整画板联动。
4. M5-F 收口来源页与 M5；M6-D 收口时间轴；M7 随功能复用当前 Codex 产品动作桥，不恢复旧 DomainAdapter。

| 范围 | 唯一负责人 |
| --- | --- |
| 格式、查询和本模块服务 | M5-A |
| 七视图及内联 | M5-B |
| 速览、⌘K、关联面板 | M5-C |
| 模板、持久块锚点、同步块、评论 | M5-D；M6-C 复用锚点 |
| Notion/Inkwell 预检与一次导入 | M5-E |
| 来源页统一及总接线 | M5-F |
| main/index、preload、electron.d.ts、migrations、package.json | 同一整合负责人串行接线；本次 A 只新增自身迁移和 verify 登记，模块导出注册函数 |
| DocumentMode、NotePreview、MarkdownEditor、块编辑挂载、快捷键公共入口 | 同一整合负责人 |
| object-links、关系抽取/重建、open-ready-ref | M4 B/F 交接后由同一整合负责人修改 |
| 阶段验收汇总和大文件台账 | 整合负责人，A 提供实际行数及风险 |

## 7. 交付状态

A 的格式、查询、服务、书房升级和持久恢复已实现；公共 Main 注册仍由 M5-F 调用 `registerDocumentDatabaseIPC` 并提供资料库授权与恢复屏障。本次只增加 preload/types 透传及 145 迁移登记，未改 Main 入口。

- `ready-database-roundtrip` 与性能测试通过；8 项真实 SQLite 测试通过且无 skip，其中包含子进程发布一行后退出、重开 SQLite 再恢复。
- CRLF 关联尚未通过：`ready-database-relations.test.ts` 固定复现现有 `search-engine/object-link-extract.ts` 截取 YAML 时留下孤立 CR 的缺陷。该公共文件不在 A 允许范围，未修改、未旁路；修复前 A 不宣称完整完成。
- 完整原生检查仍有范围外失败：旧 `library-engine.test.ts` 要求旧定义的精确断言；两项文件监听测试受环境 `EMFILE` 阻塞。旧断言需由整合负责人按新合同更新。
- 视图改名记录待修复引用并在 read 回执公开，引用修复由公共接线负责人收口；新建行先创建页面，关联随后经 setFields 单独校验与补身份。
- B–F、导入保真、已有索引首屏 500ms 及真实窗口验收待对应负责人完成。纯查询性能不能替代 Main 首次读取或界面性能证据。
