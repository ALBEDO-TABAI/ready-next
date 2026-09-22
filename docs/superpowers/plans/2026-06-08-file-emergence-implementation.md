---
title: 文件涌现实施计划
date: 2026-06-08
status: draft-for-review
owner: 白
executor: Codex 起草，Claude 复审后再施工
enforce: false
related:
  - AGENTS.md §0（开工前）
  - AGENTS.md §0.5（先合同，后代码）
  - AGENTS.md §6（测试与验证）
  - .claude/architectural-principles.md（跨边界状态显式建模、CI 强制优先）
references_current_ready:
  - src/renderer/components/layout/FilesPanel.tsx
  - src/renderer/components/layout/FileTree.tsx
  - src/renderer/stores/useWorkspace.ts
  - src/main/modules/search-engine/adapters.ts
  - src/main/modules/search-engine/indexer.ts
  - src/main/modules/repositories/calendar-repository.ts
  - src/main/modules/repositories/browser-repository.ts
  - src/main/modules/repositories/chat-repository.ts
  - src/main/modules/database.ts
  - src/preload/index.ts
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# 文件涌现实施计划

> 本文是给 Claude 复审和后续施工用的计划文档。当前阶段只定义产品边界、现有事实、数据模型、算法、UI 接入、工作包和验收方式，不实现功能。
>
> 施工前必须先读 §1-§5，确认本功能不是“新建真实文件夹”，而是一个在文件管理顶部显示的 **虚拟智能分组**。任何实现必须先补可机器验证的合同，再改代码。

---

## 0. 一句话

在文件管理的搜索框下方、用户添加的文件夹上方，新增一个默认开启但可在设置关闭的 **“涌现”** 区域。它根据日历日程、文件活跃记录、最近 agent 聊天内容和浏览记录，动态推断用户近期可能关心的工作/生活项目，并按 **未来 / 今天 / 过去 / 遥远** 四类展示虚拟折叠卡。每个类目最多 10 个项目卡；卡片下只挂真实文件入口，不移动、不复制、不创建用户文件。

---

## 1. 前因后果

### 1.1 用户提出的功能形态

用户希望文件管理不只是静态文件夹列表，而能在顶部“涌现”出近期真正相关的项目：

- **未来**：用户接下来日程中即将发生、可能需要准备资料的项目。
- **今天**：用户今天打开应用时最可能要处理的项目。
- **过去**：用户最近刚结束、可能需要整理或复盘的项目。
- **遥远**：很久没碰，但重要性较高、未来可能偶尔需要回看的项目。

视觉上，用户已经选定方案 3 的方向：它像文件树原生长出来的一块智能区域，而不是卡片仪表盘。后续修订要求：

1. 标题只叫 **“涌现”**，不是“文件涌现”。
2. 整个涌现区有一圈很细的低对比外框。
3. 内部的“未来 / 今天 / 过去 / 遥远”不使用大量边框和分隔线，只靠间距与 hover 背景表达交互。
4. 字号和比例只比普通文件夹略大一点，不能像独立 dashboard。
5. 右侧图钉图标不要出现。

本轮补充要求：

6. 用户在文件夹名称、日历日程里对“项目名称”的描述可能很抽象，涌现最终显示的项目名不能只是原文截取，而应是综合上下文后的 **可识别项目名**：既保留用户抽象原意，又更准确表达项目内容。
7. 涌现必须评估刷新性能，明确是实时刷新、固定时间刷新，还是用户手动刷新；第一版不能因为智能区拖慢文件面板打开。

### 1.2 为什么这个功能适合 Ready

Ready 已经不是一个单纯文件浏览器。它同时承载：

- 文件管理和全文索引；
- 日历日程；
- 浏览器和浏览历史；
- agent 聊天、任务和技能执行；
- RSS、书签等外部信息来源。

这意味着 Ready 有能力回答一个普通文件浏览器回答不了的问题：

> “这些文件夹里，哪些东西现在对我最有用？”

“涌现”的价值不在于替用户重新整理文件，而在于把用户近期真实活动和文件系统重新连起来。它应该像一个会观察上下文的“智能文件置顶区”，但仍保持文件管理的低干扰心智。

### 1.3 不应该做成真实文件夹

本功能的核心边界：

- 不创建“未来 / 今天 / 过去 / 遥远”真实目录。
- 不移动用户文件。
- 不重命名用户文件。
- 不在用户目录写入隐藏索引文件。
- 不让 agent 模型直接决定最终排序或文件操作。

正确形态是 **虚拟分组 + 真实文件引用**：

- “涌现”卡片只是投影。
- 卡片内文件仍然是原路径。
- 点击文件复用现有打开文件逻辑。
- 右键、拖拽、删除等危险操作第一版不从涌现卡片开放，避免误以为在操作虚拟项。

---

## 2. 当前 Ready 事实观察

> 以下基于 2026-06-08 对当前 checkout 的只读调查。施工前仍需重新打开对应文件确认，因为工作树可能已变化。

### 2.1 文件管理 UI

- `src/renderer/components/layout/FilesPanel.tsx` 负责文件面板头部、工具栏、搜索框、筛选、视图切换和把 `query / filters / viewMode` 传给 `FileTree`。
- `src/renderer/components/layout/FileTree.tsx` 负责树形和网格内容渲染、文件打开、选择、多选、拖拽、删除确认、上下文菜单。
- `src/renderer/stores/useWorkspace.ts` 保存 `workspaceRoot / pinnedFolders / selectedFile / expandedDirs / dirChildren` 等状态，并有 `revealFile(path)`、`loadDirChildren(path)`、`refreshFiles()` 等现成入口。
- 之前文件树多选工作已经证明：文件管理相关改动应局部收敛在 `FileTree.tsx` 和小型 helper 中，避免扩大 `useWorkspace` 全局状态。

结论：涌现 UI 应该作为 `FileTree` 顶层内容前的独立小组件渲染，而不是把“未来 / 今天 / 过去 / 遥远”塞进真实 `files` 或 `pinnedFolders`。

### 2.2 搜索索引已有多来源底座

`src/main/modules/search-engine/adapters.ts` 已有 shared-scope adapters：

- `BookmarkAdapter` -> `sourceType = 'bookmark'`
- `RssAdapter` -> `sourceType = 'rss'`
- `CalendarAdapter` -> `sourceType = 'calendar'`
- `AgentMessageAdapter` -> `sourceType = 'agent'`

`SearchEngine.search(...)` 在指定 workspace root 时，会把安全工作区和 `@shared` 一起查，因此同一次搜索可以同时拿到文件、日历、agent、RSS、书签等来源。

但要注意：

- 浏览 **书签** 已进入 shared search。
- 浏览 **历史** 目前主要在 `browser_history`，没有进入 shared search adapter。
- 日历 adapter 把 `startTime / endTime / location` 写入 `sourceMeta`，适合做时间归类。
- agent adapter 以最近对话为单位，每个 conversation 聚合最近 40 条消息，适合提取项目候选。

结论：涌现第一版可以复用搜索索引做少量“语义项目 -> 相关文件”的反查；浏览历史第一版直接读 `BrowserRepository.getHistory(limit)`，不要新增 BrowserHistoryAdapter 把全量历史灌进 shared FTS。

### 2.3 日历数据可用

`src/main/modules/repositories/calendar-repository.ts` 暴露：

- `getEvents(startTime, endTime)`
- `getRecurringEventsAndOverrides(startTime, endTime)`

`src/main/modules/calendar-engine/rrule-engine.ts` 已经导出纯函数 `expandEventList(...)`，`src/main/modules/calendar-engine/ipc-handler.ts` 也是通过它展开 recurring events。涌现如果需要正确处理重复日程，应直接复用：

- `CalendarRepository.getEvents(startTime, endTime)` 读取普通日程；
- `CalendarRepository.getRecurringEventsAndOverrides(startTime, endTime)` 读取重复日程和 override；
- `expandEventList(...)` 生成窗口内实例。

结论：未来 / 今天 / 过去 的时间归类应以日历事件窗口作为强信号，尤其是未来和今天。

### 2.4 Agent 聊天数据可用

`src/main/modules/repositories/chat-repository.ts` 可读：

- conversation 列表；
- conversation messages；
- conversation attachments。

底层 `database.ts` 已有 `chat_messages_fts`，agent shared adapter 也会把最近 conversation 聚合进搜索索引。

结论：agent 聊天适合产出“项目名候选”和“意图词”，但不应由模型直接黑箱排序。第一版优先用 deterministic 关键词、标题、时间和跨来源一致性；LLM 仅作为后续可选的“项目名归并/润色”工具。

### 2.5 浏览记录可用，但未完全进入统一索引

`src/main/modules/repositories/browser-repository.ts` 和 `BrowserDataService` 可读：

- `getHistory(limit)`
- `searchHistory(query)`
- `getBookmarks()`

浏览器导航会写入 `browser_history`，并带有 `visited_at / domain / title / url / visit_count / session_id` 等字段。

结论：浏览历史是“今天”和“过去”的有效信号，但第一版不要依赖它进入 FTS；直接读最近 N 条即可。

### 2.6 文件活跃记录不够完整，需要补最小表

现在能拿到：

- 文件索引里的 `mtime`；
- 文件树当前选择；
- 文档 tabs 当前打开状态；
- 文件系统 watcher 的目录变更；
- `document:write` 成功后的 write-index hook。

但这些不足以可靠回答“用户最近主动打开/看过哪些文件”。只用 `mtime` 会把外部批量改动误判成用户关注；只用当前 tabs 又不能跨重启。

结论：本功能第一期应新增轻量 `file_activity_events` 表，记录少量用户可解释事件。表结构可以预留更多事件类型，但 v1 只写入 `open` 和 `save`：

- `open`：用户从文件树、涌现、文档模式打开文件。
- `save`：Ready 内写入文件成功。
- `select`：第一版不写入，只作为表枚举预留；点击选中噪音太高。
- `external_change`：第一版不写入，只作为表枚举预留；外部批量修改容易刷分。

`document:write` 成功后已有 `setDocumentWriteIndexHook(...)` 这条保存后拦截面，但当前实现是单槽 setter：再次调用会覆盖搜索引擎现有增量索引 hook。施工时不要在别处再次调用 `setDocumentWriteIndexHook(...)`。正确改法是把它升级为可叠加监听：

```ts
addDocumentWriteListener(fn): () => void
```

`file-io-group.ts` 和 `parser-group.ts` 两个调用点遍历所有 listener；搜索引擎从现有单槽注册迁移到 listener；file-emergence 独立订阅记录 `save`。这样不会让搜索模块依赖 file activity，也不会让 file-emergence 覆盖全文索引。

---

## 3. 产品设计边界

### 3.1 UI 结构

涌现区位于：

```text
文件管理标题
工具栏
搜索文件...
涌现  [细外框包住整块]
用户添加的文件夹列表
```

第一版只在树形模式显示；网格模式隐藏涌现区。若 query 非空，第一版隐藏涌现区，把空间让给搜索结果，避免用户搜索时被智能区干扰。当前筛选条件不进入 main 快照缓存，renderer 只在 view model 里对文件行做过滤或淡化。

视觉规则：

- 外层：1px 低对比细边框，8px 或更小圆角，轻背景。
- 标题：`涌现`，左侧可用小蓝色 folder/spark 图标，右侧只放总数或刷新状态，不放图钉。
- 右侧可以放一个轻量刷新图标按钮，用于用户手动“重新涌现”；它不是置顶图钉，不改变文件夹顺序。
- 类目行：`未来 / 今天 / 过去 / 遥远`，无内部边框，hover 时出现轻背景。
- 展开态：默认展开 `今天`；若今天为空，按 `未来 -> 过去 -> 遥远` 的顺序展开第一个非空类目。
- 项目行：折叠卡的视觉应接近文件树 row，字号只比普通文件夹大 1-2px。
- 文件行：文件图标、文件名、轻量来源说明；点击打开真实路径。
- 空态：如果四个桶都没有超过最低门槛的项目，整块涌现区隐藏，不留空描边盒子。

### 3.2 数量规则

用户已确认：

- **每个类目最多 10 个项目卡**。
- 每个项目卡第一版最多显示 3 个相关文件。
- 卡片总数无需跨类目合并限额。

建议默认显示策略：

- 每类 collapsed 时只露出前 1 个项目名和数量。
- 展开某一类时显示该类最多 10 个项目。
- 每个项目默认折叠；点击项目后展开文件列表。

### 3.3 设置开关

用户已确认：

- 功能默认开启。
- 设置里提供关闭入口。

建议设置项：

```ts
file_emergence_enabled = 'true' | 'false'
```

该 key 走现有 settings 通道，不新增 file-emergence 专用设置 IPC：

- renderer 写入：`window.electronAPI.settings.set('file_emergence_enabled', 'true' | 'false')`
- renderer 读取：`window.electronAPI.settings.getAll()` 或 `settings.get(key)`
- main 侧判断：`getSetting('file_emergence_enabled') !== 'false'`

默认值：缺省视为 `true`。关闭后：

- UI 不显示涌现区。
- 后台不再生成新的涌现投影。
- 已有 file activity 记录是否继续写入需要产品决定；建议第一版关闭后也停止写入文件活跃事件，减少隐私疑虑。

### 3.4 隐私和解释性

因为涌现默认读取 agent 聊天和浏览历史，UI 和设置必须保持可解释：

- 设置项名称建议：`文件涌现`
- 描述建议：`根据日程、文件活动、最近对话和浏览记录，在文件管理顶部显示可能相关的项目。`
- 卡片可选显示“为什么出现”的简短 tooltip 或 hover popover，例如：
  - `来自今天日程 + 最近打开 3 个相关文件`
  - `来自最近 agent 对话 + 浏览记录`
  - `很久未打开，但历史活动和文件规模较高`

第一版 tooltip 可后置，但数据结构应保留 `evidence[]`。

---

## 4. 数据模型

### 4.1 新增 shared wire 类型

新增：

```text
src/shared/file-emergence.ts
```

建议类型：

```ts
export type FileEmergenceBucket = 'future' | 'today' | 'past' | 'distant'

export interface FileEmergenceFileRef {
  path: string
  name: string
  kind: 'folder' | 'document' | 'code' | 'image' | 'video' | 'audio' | 'spreadsheet' | 'design' | 'other'
  score: number
  reason: string
  modifiedAt?: number | null
}

export interface FileEmergenceEvidence {
  source: 'calendar' | 'file_activity' | 'agent' | 'browser_history' | 'search_index'
  label: string
  score: number
  timestamp?: number | null
  ref?: string | null
}

export interface FileEmergenceProject {
  id: string
  bucket: FileEmergenceBucket
  title: string
  rawLabels: string[]
  anchorType: 'directory' | 'semantic'
  anchorPath?: string | null
  titleSource: 'directory' | 'calendar' | 'agent' | 'browser_history' | 'rule_refined' | 'llm_refined'
  score: number
  confidence: 'low' | 'medium' | 'high'
  status?: 'upcoming' | 'active' | 'recently_finished' | 'dormant_important'
  files: FileEmergenceFileRef[]
  evidence: FileEmergenceEvidence[]
  updatedAt: number
}

export interface FileEmergenceSnapshot {
  generatedAt: number
  nextRefreshAt?: number | null
  refreshReason?: 'initial' | 'stale' | 'manual' | 'source_changed' | 'scheduled'
  workspaceRoots: string[]
  enabled: boolean
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>
  degraded?: Array<{ source: string; reason: string }>
}
```

### 4.2 新增 DB 表：文件活跃事件

在 `src/main/modules/migrations.ts` 中新增 migration。当前 checkout 最新 migration 是 `045_seed_default_agent_personas`，因此本功能应使用 `046_file_activity_events`，并保持 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 幂等：

```sql
CREATE TABLE IF NOT EXISTS file_activity_events (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  workspace_root TEXT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_activity_path_time
  ON file_activity_events(path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_activity_workspace_time
  ON file_activity_events(workspace_root, created_at DESC);
```

字段含义：

- `event_type`: `open | save | select | external_change`
- `source`: `file_tree | document_mode | emergence | watcher | document_write`
- `weight`: 事件基础权重，便于 select 低权重、save/open 高权重。
- `meta_json`: 可存 tabId、bucket、projectId、extension 等非必要信息。

保留策略：

- 第一版只保留最近 90 天或最近 10,000 条。
- 清理可在涌现生成时顺手做一次轻量 `DELETE WHERE created_at < cutoff`。

### 4.3 可选 DB 表：用户反馈

第一版可以不做，但如果要支持“隐藏这个项目”，建议预留：

```sql
CREATE TABLE IF NOT EXISTS file_emergence_feedback (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT
);
```

第一期若不做隐藏/置顶，先不要建这张表，避免提前扩展。

---

## 5. 算法设计

### 5.1 总体流程

```text
读取设置 -> 若关闭，返回 enabled=false
读取安全 workspace roots
读取数据源窗口
  - 日历：过去 30 天 ~ 未来 60 天
  - 文件活跃：最近 30 天
  - agent 对话：最近 50 个 conversation / 每个最近消息摘要
  - 浏览历史：最近 200 条
  - 搜索索引：文件候选反查
抽取项目候选
  - 轨道 A：目录锚定项目
  - 轨道 B：语义锚定项目
归并候选项目
生成可识别项目显示名
按 bucket 打分
为每个项目召回相关文件
输出每类 top 10
```

第一版的核心判断：**项目的主锚点优先放在目录上，而不是抽取出来的字符串上。**

- 轨道 A（主干）：目录锚定。项目 = 安全 workspace / pinned root 下近期有 open/save 活跃、或历史重要性高的目录子树。它最适合 today / past / distant。
- 轨道 B（补充）：语义锚定。项目来自日历标题、agent conversation title、浏览标题等语义文本，再用少量 FTS 召回文件。它最适合 future，因为未来项目可能还没有稳定文件夹。

这样做的原因：

- 文件管理里最稳定的项目信号通常是文件夹。
- 目录锚定天然可解释：这个文件夹为什么出现，可以追溯到打开、保存、日历提及和历史活跃。
- 语义文本只在没有目录锚点、或需要给目录补充含义时发挥作用，避免聊天和浏览碎词直接“造项目”。

### 5.2 项目候选来源

#### 日历候选

从事件 title、description、location 提取候选项目名。

权重建议：

- 未来 0-7 天：强信号。
- 今天：最强信号。
- 过去 0-7 天：past 强信号。
- 过去 8-30 天：past 中信号。
- 超过 30 天：只作为 distant 的辅助证据。

#### 文件活跃候选

从 `file_activity_events.path` 的路径段、文件名、父目录名提取目录锚点。v1 只写入并使用 `open`、`save`；`select` 和 `external_change` 保留枚举但不参与生成。

权重建议：

- `open`: 1.0
- `save`: 1.2
- `select`: v1 不写入
- `external_change`: v1 不写入

同一文件短时间重复事件要合并，避免打开一次 PDF 触发多次记录造成刷分。

#### Agent 对话候选

从最近 conversation 的 title 和最近消息正文抽取候选词：

- 优先 conversation title。
- 其次用户消息里的名词短语、文件名、项目名形态。
- 工具输出、长日志、错误堆栈要降权或过滤。

第一版建议不用 LLM 抽取，先用规则：

- 中文连续词段；
- 带年份、客户名、品牌名、项目后缀的短语；
- 文件名和目录名；
- `提案 / 项目 / 发布 / 对标 / 数据库 / 方案 / 复盘 / 计划 / 检查 / 门店 / 品牌` 等项目词邻近片段。

后续可加 LLM，但输出必须是候选，不是最终真相。

#### 项目显示名：原始锚点和最终名称分离

用户可能会把文件夹或日程写得很抽象，例如 `资料`、`门店`、`方案`、`6月会`。涌现 UI 不应该直接显示这些低识别度词，而应生成一个更准确的 `title`。

设计上分两层：

- `rawLabels`：原始证据里的目录名、日程名、conversation title、浏览标题。
- `title`：综合证据后的显示名。

显示名生成规则：

1. 优先保留用户原意，不把项目改写成模型臆造的新概念。
2. 优先选更具体的来源，例如 `2026 门店图片数据库` 优于 `门店`，`品牌空间案例观察` 优于 `案例`。
3. 若目录名抽象，但日历或 agent title 更具体，则用更具体标题作为显示名，目录名保留在 evidence。
4. 若多个来源表达同一项目，显示名可组合最少必要限定词：时间、品牌、客户、地点、交付物类型。
5. 规则无法稳定命名时，项目降 confidence；低于门槛不上榜，不为了凑满 10 个而显示垃圾名称。

LLM 可在后续用于 `rule_refined -> llm_refined` 的命名润色，但只能基于已有 `rawLabels` 和 evidence 生成显示名，不能新增文件路径或改变 bucket 排序。

#### 浏览历史候选

从最近 history 的 title、domain、url path 里抽取。

权重建议：

- 同一 domain 多次访问加权，但要封顶。
- 搜索引擎结果页只取 query，不把 `google.com` / `baidu.com` 当项目。
- 与日历/agent/file 活跃同名时加跨来源分。

### 5.3 归并规则

新增纯函数：

```text
src/main/modules/file-emergence/project-normalizer.ts
```

核心职责：

- 统一大小写、全半角、空白、破折号。
- 去掉无意义后缀：`v1 / v2 / final / copy / 备份 / 新建文件夹` 等。
- 从路径中保留更像项目名的父目录，而不是文件扩展名。
- 对短标题做去噪，例如 `会议`、`资料`、`方案` 单独出现不成项目。

项目 key 不能只用标题。目录锚定和语义锚定要分流，否则两个不同目录都叫 `资料` 会被错误合并，而同一项目从日历和目录两路进入时又可能合不到一起。

```ts
directoryProjectKey = `dir:${normalizeRealPath(anchorPath)}`
semanticProjectKey = `semantic:${stableHash(normalizedTitle)}`
```

归并顺序：

1. 先生成目录锚定项目，key 使用规范化后的真实目录路径。
2. 再生成语义候选，key 使用规范化标题。
3. 对每个语义候选，尝试匹配已有目录项目：
   - 语义标题命中目录名、父目录名、文件名或 rawLabels；
   - 语义关键词命中目录项目下的文件名或搜索摘要；
   - 日历/agent/browser evidence 与目录 activity 时间窗口接近。
4. 命中时，语义候选不新建项目，而是并入目录项目的 evidence，并可用于提升显示名和 bucket 资格。
5. 未命中任何目录时，才保留为语义锚定项目，主要服务 future。

同一个 projectKey 下合并多来源 evidence，但跨轨合并必须走上述协调步骤，不能靠标题 hash 硬撞。

### 5.4 Confidence 与上榜门槛

`confidence` 不能是 UI 随手标注，必须由可测试规则推出。

建议推导：

```text
evidenceSourceCount = 独立来源数量(calendar/file_activity/agent/browser_history/search_index)
normalizedScore = 当前 bucket 内归一分
anchorConfidence =
  directory anchor with existing files -> 0.35
  semantic anchor with linked files -> 0.20
  semantic anchor without files -> 0.10

confidenceRaw =
  anchorConfidence
  + min(evidenceSourceCount, 3) * 0.15
  + normalizedScore * 0.35
```

建议阈值：

- `high`: `confidenceRaw >= 0.75`
- `medium`: `confidenceRaw >= 0.50`
- `low`: `confidenceRaw >= 0.35`
- `< 0.35`: 不上榜

上榜规则：

- v1 只显示 `medium` 和 `high`。
- `low` 可保留在 snapshot 内用于调试或后续 UI，但不显示。
- 任何 bucket 都不能为了凑满 10 个把低 confidence 项目显示出来。

### 5.5 Bucket 判定

不要直接比较四个 bucket 的原始分数。四个公式量纲不同，`futureScore > todayScore` 这类比较不稳定。

第一版采用 **资格优先，分数排序**：

1. 先用资格规则判断项目可进入哪些 bucket。
2. score 只用于同一个 bucket 内排序。
3. 多 bucket 命中时，用确定性归属规则决定最终显示在哪一类。

v1 每个项目只出现在一个 bucket。多 bucket 归属优先级：

1. `today`：今天有日程或今天有 open/save/agent/browser 集中活动。
2. `future`：未来 60 天内有日程或强未来意图，且没有 today 资格。
3. `past`：最近 30 天内已结束或有完成/复盘意图，且没有 today/future 资格。
4. `distant`：满足遥远硬门槛，且没有 today/future/past 资格。

这样可以避免不同量纲的分数互相比较，也让 WP0 的边界测试稳定。

#### future

适合条件：

- 有未来 60 天内的日历事件；
- 或 agent/browser 出现“准备 / 下周 / 明天 / 即将 / 发布 / 截止”等未来意图；
- 或文件活跃很新且日历未来相关。

核心公式：

```text
futureScore =
  upcomingCalendarScore * 0.55
  + recentFileActivityScore * 0.20
  + agentIntentScore * 0.15
  + browserIntentScore * 0.05
  + crossSourceBonus * 0.05
```

#### today

适合条件：

- 今天有日程；
- 今天打开或保存过相关文件；
- 今天 agent 对话或浏览历史集中出现；
- 昨天晚间到今天早晨有连续活动。

核心公式：

```text
todayScore =
  todayCalendarScore * 0.35
  + todayFileActivityScore * 0.30
  + recentAgentScore * 0.20
  + recentBrowserScore * 0.10
  + crossSourceBonus * 0.05
```

#### past

适合条件：

- 最近 30 天内有已结束日程；
- 最近活跃后突然停止；
- agent 对话中出现“完成 / 结束 / 复盘 / 交付 / 总结”等。

核心公式：

```text
pastScore =
  recentlyEndedCalendarScore * 0.35
  + decayedFileActivityScore * 0.25
  + agentCompletionScore * 0.20
  + browserRecentScore * 0.10
  + crossSourceBonus * 0.10
```

#### distant

用户已确认“遥远”含义：**很久没碰但重要**。

适合条件：

- 最近 30 天无 open/save 活跃；这是硬门槛，不是软扣分。
- 曾经高活跃；
- 文件数量多、文件体量大或出现在多个来源；
- 有重要性词：`品牌 / 合同 / 提案 / 数据库 / 案例 / 模板 / 资产 / 发布 / 客户 / 门店 / 研究`；
- 曾被日历/agent 多次提到。

核心公式：

```text
distantScore =
  historicalImportanceScore * 0.40
  + dormantAgeScore * 0.25
  + fileClusterStrength * 0.20
  + crossSourceMemoryScore * 0.10
```

`historicalImportanceScore` 使用 0-1 归一值，v1 初始阈值为 `0.50`。它至少应综合历史 open/save 次数、历史活跃跨度、文件簇规模、重要性词命中和跨来源提及；没有达到 0.50 的 dormant 项目不上榜。

硬规则：

- `lastOpenOrSaveAt >= now - 30d`：直接不能进入 distant。
- `historicalImportanceScore < 0.50`：直接不能进入 distant。

注意：distant 不能变成垃圾堆。近期仍活跃的项目不应出现在遥远里；低重要低活跃的项目也不应出现。

### 5.6 相关文件召回

每个项目最多显示 3 个文件，但内部可召回 top 20 用于排序。

召回来源：

1. 文件活跃事件中直接关联的路径。
2. 目录锚点下最近打开、保存或修改的文件。
3. 路径父目录名匹配项目 key。
4. 搜索索引按项目标题搜索 `source:document`。
5. 搜索索引按项目关键词搜索 `source:document`。

FTS 召回应成为补充，不是主循环：

- 目录锚定项目优先走目录扫描 + activity event，不对每个项目做多轮 FTS。
- 语义锚定项目才使用 FTS 召回，且每个项目限制 query 数量和 top N。
- 同一 snapshot 内对相同 query 做内存去重，避免 4 个 bucket 最坏 80 次 FTS。

文件排序：

```text
fileScore =
  directActivityMatch * 0.35
  + searchNameMatch * 0.25
  + pathSegmentMatch * 0.20
  + recencyScore * 0.10
  + fileTypeUsefulness * 0.05
  + sourceDiversityBonus * 0.05
```

去重：

- 同一路径只出现一次。
- 若文件不存在，过滤。
- 若路径不在安全 workspace roots 或 pinnedFolders 下，过滤。
- 若用户当前筛选隐藏某类文件，renderer view model 对文件行做过滤或淡化；main snapshot 不因筛选变化重新生成。

### 5.7 LLM 的位置

第一版不需要 LLM 参与排序。

v1 不调用 LLM 做项目改名。原因：

- 每次刷新都调用外部模型会和性能目标冲突。
- 命名错误会直接破坏用户对文件区的信任。
- 规则版命名已经可以覆盖“抽象原名 -> 更可识别标题”的第一期需求。

允许后续引入 LLM 的两个位置：

1. 把多个候选标题归并成更自然项目名。
2. 给 evidence 生成一句人话解释。

禁止：

- 让 LLM 决定读取哪些文件。
- 让 LLM 决定最终能否显示某个私密项目。
- 让 LLM 直接返回文件路径并被 UI 信任。

### 5.8 刷新策略与性能判断

不建议第一版做“后台实时全量刷新”。原因：

- 文件面板是高频入口，实时全量刷新会让打开面板变慢。
- open/save 事件可能很密集，实时重算会放大噪音。
- 默认读取日历、agent、浏览历史，实时后台读取会增加隐私压力。

也不建议只做“每日固定时间刷新”。原因：

- 用户今天刚打开或保存的文件需要较快反映到 today。
- 临近日程和刚结束项目可能在一天内变化，固定时间会显得迟钝。

第一版采用 **懒加载缓存 + 手动刷新 + 轻量失效**：

1. 文件管理面板首次可见时请求 snapshot。
2. main 侧缓存 snapshot，TTL 初始取 10 分钟；后续只根据真实生成耗时和用户感知陈旧度调整。
3. open/save 只记录 activity 并标记缓存 stale，不立即全量重算。
4. 当面板再次可见且缓存 stale，异步刷新；UI 先显示旧 snapshot 和轻量刷新状态。
5. 标题右侧提供刷新图标按钮，用户点击时调用 `getSnapshot({ workspaceRoots, forceRefresh: true })`。
6. 每天首次启动或跨日期后第一次打开文件面板，可视为 `scheduled` 刷新；不需要固定凌晨后台跑。

stale 判定必须显式满足以下任一条件：

- TTL 过期。
- open/save activity 标记缓存为 stale。
- `generatedAt` 所属本地自然日与当前本地自然日不同。

性能验收目标：

- 打开文件面板不等待全量涌现计算。
- 缓存命中路径应接近普通 IPC 读取，不触发搜索扇出。
- 强制刷新可以异步显示 loading，但不能阻塞文件树基础渲染。

---

## 6. 实现路径

### 6.1 新模块：main 侧涌现服务

新增目录：

```text
src/main/modules/file-emergence/
```

建议文件：

```text
types.ts
project-normalizer.ts
candidate-extractors.ts
scoring.ts
file-linker.ts
service.ts
ipc-handler.ts
```

职责：

- `candidate-extractors.ts`：从 calendar / file activity / agent / browser history 生成候选。
- `scoring.ts`：纯函数，负责 bucket 和 score。
- `file-linker.ts`：用 SearchEngine + activity events 找相关文件。
- `service.ts`：组合依赖，生成 `FileEmergenceSnapshot`。
- `ipc-handler.ts`：注册 renderer IPC。

### 6.2 新 repository：文件活跃

新增：

```text
src/main/modules/repositories/file-activity-repository.ts
```

接口：

```ts
recordEvent(input: {
  path: string
  workspaceRoot?: string | null
  eventType: 'open' | 'save' | 'select' | 'external_change'
  source: 'file_tree' | 'document_mode' | 'emergence' | 'watcher' | 'document_write'
  weight?: number
  meta?: Record<string, unknown>
  createdAt?: number
}): void

listRecent(options: {
  workspaceRoots: string[]
  since: number
  limit: number
}): FileActivityEvent[]

prune(cutoff: number, maxRows: number): void
```

### 6.3 IPC 与 preload

新增 IPC：

```text
fileEmergence:getSnapshot
fileEmergence:recordActivity
```

注意：

- 如果遵循现有分组风格，可让 `file-emergence/ipc-handler.ts` 自己注册并在 main composition root 接入。
- 设置读写不新增 IPC，复用现有 `settings:get` / `settings:set` / `settings:getAll`。
- `recordActivity` 必须只接受 renderer 已经可访问的本地文件路径，并在 main 侧校验属于安全 root 或 pinned root。
- path 校验不能把文件路径当 workspace root 调 `validateWorkspaceRoot(path)`。正确流程：
  1. renderer 传入 `workspaceRoots`，来源应是 `computeDesiredRoots({ workspaceRoot, pinnedFolders })`。
  2. main 对每个 root 再调 `validateWorkspaceRoot(root)` 做边界防御。
  3. main 对目标文件做绝对路径、`realpath`、`relative()` 包含性检查，参考 `file-management-tools.ts` 里的 `isPathInsideRoot(...)` / `resolveExistingPathInsideRoot(...)` 范式。
  4. 文件真实路径必须落在至少一个安全 root 的真实路径之内，防 symlink 逃逸。
- `recordActivity` 属于 best-effort telemetry，不是关键持久状态；但 handler 仍必须返回结构化 IPC response，不能 silent catch。
- `getSnapshot` 输入只包含当前 `workspaceRoots` 和 `forceRefresh?`。query/filter 不进入 main，也不进入缓存 key。
- main snapshot 缓存 key 只按规范化后的 `workspaceRoots` 计算；renderer 在 `fileEmergenceViewModel.ts` 里处理 query 隐藏和当前 filter 对文件行的过滤/淡化。

preload 增加：

```ts
export interface FileEmergenceGetSnapshotPayload {
  workspaceRoots: string[]
  forceRefresh?: boolean
}

export interface FileEmergenceRecordActivityPayload {
  path: string
  eventType: 'open' | 'save'
  source: 'file_tree' | 'document_mode' | 'emergence'
  workspaceRoots: string[]
  meta?: Record<string, unknown>
}

fileEmergence: {
  getSnapshot(payload: FileEmergenceGetSnapshotPayload): Promise<IPCResponse<FileEmergenceSnapshot>>
  recordActivity(payload: FileEmergenceRecordActivityPayload): Promise<IPCResponse>
}
```

`recordActivity` handler 用 `workspaceRoots[]` 做安全校验和归属定位；落库时写入命中的单个 `workspace_root`。main 侧 `document_write` 保存事件不走 renderer IPC，直接通过 file activity repository 写入 `source = 'document_write'`。

同步 `src/renderer/types/electron.d.ts`。

### 6.4 Renderer UI

新增：

```text
src/renderer/components/layout/FileEmergenceSection.tsx
src/renderer/components/layout/fileEmergenceViewModel.ts
```

接入点：

- 在 `FileTree.tsx` 的 tree content 顶部渲染，而不是 `FilesPanel` 的搜索框内部。
- 只在 `viewMode === 'tree'` 时第一版显示；grid mode 第一版隐藏。
- `queryLower` 非空时隐藏。
- `pinnedFolders.length === 0 && !workspaceRoot` 时不显示。
- snapshot 四个 bucket 都为空时不显示，不渲染空外框。

交互：

- 点击类目：展开该类，其他类可保持折叠。
- 点击项目：展开/折叠项目文件列表。
- 点击文件：调用现有 `handleOpenFile` 或 `revealFile` + `openTab` 链路；同时记录 `recordActivity(... source: 'emergence', eventType: 'open')`。
- 点击刷新图标：调用 `getSnapshot({ workspaceRoots, forceRefresh: true })`；按钮只触发刷新，不改变置顶、排序或文件夹状态。
- hover：轻背景，不加内部边框。

样式：

- 复用 `PANEL_TOKENS`、`var(--bg-hover)`、`var(--border-default)`、`var(--text-muted)`。
- 外框：`1px solid var(--border-default)` 或更浅。
- 内部行高接近 `FileTreeItem`。

### 6.5 Settings 开关

在 `src/renderer/pages/Settings.tsx` 增加一个开关。建议放在存储/隐私相邻分组，而不是藏到高级调试区；施工时按当前 `Settings.tsx` 实际结构选择最近的现有分组。

读写方式：

- 复用 `persistBridgeSetting(key, value)` 和 `window.electronAPI.settings.*`。
- 不新增 `fileEmergence:setEnabled` / `fileEmergence:getSettings`。

文案：

```text
文件涌现
根据日程、文件活动、最近对话和浏览记录，在文件管理顶部显示可能相关的项目。
```

默认：

- `settings` 表无 key 时视为开启。
- 用户关闭后，FileTree 不请求 snapshot。
- 设置切换不做实时监听；v1 在下次文件面板可见或 FileTree 重新挂载时重新读取设置并生效。

### 6.6 文件活动埋点

第一版最小埋点：

1. `FileTree` 中 `handleOpenFile` 成功打开文件后记录 `open / file_tree`。
2. `DocumentMode` 因 `selectedFile` 自动打开文件后记录 `open / document_mode`。
3. `document:write` 成功后 main 侧记录 `save / document_write`。该路径必须先把现有单槽 `setDocumentWriteIndexHook(...)` 升级为 `addDocumentWriteListener(fn): dispose`，搜索索引和 file-emergence 分别订阅；不要把 file activity 写入塞进 search-engine 的 hook body。
4. `document:directoryChanged` 或 search watcher 对外部变化可先不记，避免第一版噪音过高；后续再加入 `external_change`。

涉及文件：

- `src/main/modules/document-engine/ipc-handler.ts`
- `src/main/modules/document-engine/ipc/file-io-group.ts`
- `src/main/modules/document-engine/ipc/parser-group.ts`
- `src/main/modules/search-engine/ipc-handler.ts`
- `src/main/modules/file-emergence/*`

不要记录：

- 文件夹 hover。
- 搜索输入。
- 每次 render。
- 同一路径短时间重复 open。

---

## 7. 工作包

### WP0 - 合同与类型

目标：先定义 wire 类型、score 输入输出、bucket 行为和默认设置语义。

改动：

- 新增 `src/shared/file-emergence.ts`。
- 新增纯测试 `src/__tests__/file-emergence-scoring.test.ts`。
- 新增纯测试 `src/__tests__/file-emergence-normalizer.test.ts`。

验收：

- `future/today/past/distant` 的边界样例明确。
- distant 样例必须证明“久未活跃但重要”能上榜，“久未活跃但低重要”不上榜。
- distant 样例必须证明最近 30 天有 open/save 的项目直接不能进入 distant。
- normalizer 样例必须证明抽象 raw label 能生成更可识别的显示名，例如从 `门店` + 日历/agent 证据生成更具体项目名。
- 合同必须区分 `anchorType = directory | semantic`。
- 合同必须证明目录锚定 key 不会因为两个目录同名而误合并。
- 合同必须证明语义候选命中目录项目时会并入目录 evidence，而不是新建重复项目。
- 合同必须定义 bucket 资格规则，不允许直接跨 bucket 比原始分数。
- 合同必须定义 confidence 推导和显示门槛。

### WP1 - DB 与 file activity repository

目标：建立可靠文件活跃记录，不再靠临时 UI 状态猜。

改动：

- `src/main/modules/migrations.ts`
- `src/main/modules/repositories/file-activity-repository.ts`
- 测试 `src/__tests__/file-activity-repository.test.ts`

验收：

- migration 使用 `046_file_activity_events`，不能与当前 `045_seed_default_agent_personas` 撞号。
- `CREATE TABLE` / `CREATE INDEX` 必须使用 `IF NOT EXISTS`。
- open/save 能写入并按时间读取。
- select/external_change 可作为枚举存在，但 v1 不写入、不参与涌现生成。
- prune 能按时间或最大行数清理。
- SQLite 测试按 `skipIfSqliteUnavailable` 规约处理。

### WP2 - 涌现服务和算法

目标：main 侧能生成稳定 `FileEmergenceSnapshot`。

改动：

- `src/main/modules/file-emergence/*`
- 可选扩展 `SearchEngine` 或 repository 读取能力，但不要把 UI 逻辑放 main。

验收：

- 用 fake repositories 输入固定日历、活动、聊天、浏览记录，输出确定。
- 每个 bucket 最多 10 项。
- 每项最多 3 个文件。
- 关闭设置时返回 `enabled=false` 且不做重查询。
- 搜索索引失败时返回 degraded，不让 UI 崩。
- bucket 先走资格规则，再在桶内排序。
- 目录锚定项目不依赖多轮 FTS。
- 语义锚定项目 FTS query 数量有上限。
- 低 confidence 项目不上榜，不为了填满 10 个槽降质。
- distant 项目必须满足 `historicalImportanceScore >= 0.50`。
- 缓存 key 只包含规范化后的 workspaceRoots，不包含 query/filter。
- 快照生成日与当前本地自然日不同则视为 stale，即使 TTL 未过期。
- 缓存命中不重新扫日历、agent、浏览历史和 FTS。
- `forceRefresh` 能绕过缓存但不阻塞文件树基础渲染。

### WP3 - IPC / preload / 类型

目标：renderer 能请求 snapshot、记录 activity；设置开关继续走现有 settings 通道。

改动：

- `src/main/modules/file-emergence/ipc-handler.ts`
- main 注册入口
- `src/preload/index.ts`
- `src/renderer/types/electron.d.ts`
- IPC contract 相关测试

验收：

- `npm run verify:ipc-contract` 通过。
- handler 重复注册在 dev reload 下不会残留旧 handler。
- getSnapshot payload 只包含 `workspaceRoots` 和 `forceRefresh?`。
- recordActivity payload 包含 `path`、`eventType`、`source`、`workspaceRoots`、可选 `meta`。
- recordActivity 校验 path 范围，非法路径返回结构化错误。
- recordActivity 落库时存命中的单个 `workspace_root`。
- recordActivity 返回结构化 IPC response；不能 silent catch，也不能留下未说明的 fire-and-forget。
- preload 顶层 `fileEmergence` 与 `Window.electronAPI` 类型字段完全一致。

### WP4 - Renderer 涌现 UI

目标：在文件树顶部显示最终视觉形态。

改动：

- `src/renderer/components/layout/FileEmergenceSection.tsx`
- `src/renderer/components/layout/fileEmergenceViewModel.ts`
- `src/renderer/components/layout/FileTree.tsx`

验收：

- 标题为“涌现”。
- 整块有细外框。
- 内部类目无明显分隔线和重边框。
- 字号只略大于普通文件夹。
- 每类最多 10 个项目。
- grid mode 第一版隐藏涌现区。
- query 非空时隐藏涌现区。
- 四个 bucket 都为空时隐藏整块，不显示空外框。
- filter 变化只影响 renderer 文件行展示，不触发 main snapshot 重新生成。
- 点击文件复用真实打开逻辑。
- 刷新按钮只做手动刷新，不显示为图钉、置顶或固定。
- 缓存刷新中不遮挡普通文件树。

### WP5 - Settings 开关

目标：默认开启，可关闭。

改动：

- `src/renderer/pages/Settings.tsx`
- main service 直接通过现有 settings 读取 `file_emergence_enabled`。

验收：

- 默认无 key 时 UI 显示开启。
- 关闭后文件管理不显示涌现区。
- 设置切换在下次文件面板可见或 FileTree 重新挂载时生效，不做实时监听。
- 重新打开应用后设置保持。
- 保存失败不显示成功。
- 不新增 fileEmergence 专用 settings IPC。

### WP6 - 文件活动埋点

目标：把 open/save 的真实行为接入 file activity。

改动：

- `FileTree.tsx` 打开文件路径。
- `DocumentMode.tsx` 自动打开 selected file 路径。
- `document:write` 成功路径。

验收：

- 从文件树打开文件会写一条 open。
- 从涌现打开文件会写 source=emergence。
- 保存文档会写 save。
- document write 监听必须改成 additive listener，不能覆盖现有搜索索引刷新。
- search-engine 和 file-emergence 通过各自 listener 订阅，不让 search-engine 依赖 file activity。
- 短时间重复打开同一路径被降噪或合并。

### WP7 - 回归与可视验证

目标：确保功能可用、不扰乱现有文件管理。

验收命令：

```bash
npm run verify:native
npm run typecheck
npm run verify:ipc-contract
node scripts/check-migration-numbering-sequential.cjs
node scripts/check-migration-fresh-upgrade-idempotent.cjs
node scripts/check-no-fire-and-forget.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/file-emergence-*.test.ts src/__tests__/file-activity-repository.test.ts
git diff --check
```

若改动触及大量 SQLite-backed 路径，最后补跑：

```bash
npm run test
```

视觉验证：

- 启动 dev app。
- 添加至少一个文件夹。
- 准备日历事件、最近文件活动、最近 agent 对话、浏览记录。
- 打开文件管理，确认涌现区出现在搜索框下方、普通文件夹上方。
- 确认关闭设置后涌现区消失。

---

## 8. 风险与处理

### 8.1 误判项目名

风险：从聊天、浏览标题或抽象文件夹名里得到的项目名可能太碎、太泛，用户无法识别。

处理：

- 项目主锚点优先使用目录。
- `rawLabels` 和最终 `title` 分离。
- 显示名必须由多来源证据收敛，不能直接截取一个泛词。
- 第一版 evidence 必须保留，方便解释和调试。
- 低 confidence 项目不上榜或放低。
- 不让 LLM 直接决定最终排序。

### 8.2 浏览历史隐私

风险：默认读取浏览历史可能让用户意外。

处理：

- 设置默认开但清楚说明数据来源。
- 关闭后停止 snapshot 和活动记录。
- 不把浏览历史内容写入用户文件系统。

### 8.3 文件活动噪音

风险：外部批量修改或 watcher 事件会刷高分。

处理：

- 第一版只记录 open/save，external_change 后置。
- select 低权重或暂不记录。
- 同一路径短时间去重。

### 8.4 性能

风险：每次打开文件面板都扫大量 DB 或搜索索引。

处理：

- snapshot main 侧缓存，TTL 建议 10 分钟；施工时根据真实耗时调整。
- 文件面板 visible 时请求，不在每次 hover/scroll 请求。
- open/save 只标记 stale，不实时全量重算。
- 用户可以手动刷新。
- 每天首次打开文件面板做 scheduled refresh，不做固定后台全量任务。
- 搜索召回限制 top 20。
- 每类输出 top 10。

### 8.5 UI 干扰普通文件夹

风险：涌现区过高，挤压用户真实文件夹。

处理：

- 默认只展开一个类目。
- 内部项目默认折叠。
- query 非空时隐藏/折叠。
- 不做大卡片和强边框。

---

## 9. 红线

1. 不创建真实“未来 / 今天 / 过去 / 遥远”文件夹。
2. 不移动、重命名、复制用户文件。
3. 不把模型输出当成可信文件路径。
4. 不在 renderer 里直接查 SQLite。
5. 不绕过 workspace root 安全校验。
6. 不用 source-grep 充当行为测试。
7. 不把涌现结果混入 `useWorkspace.files` 或 `pinnedFolders`。
8. 不为了该功能重构整个 `FileTree.tsx`。

---

## 10. Claude 复审后的采纳结论与待确认点

### 10.1 已采纳进本文的结论

1. `file_activity_events` 是正确的最小补表；现有 task/session recall 不能表达用户打开/保存文件。
2. migration 应使用 `046_file_activity_events`，并通过 sequential / idempotent gate。
3. 设置开关复用现有 `settings:*` 通道，不新增 file-emergence 专用设置 IPC。
4. 浏览历史第一版直接读 `BrowserRepository.getHistory(limit)`，不新增 BrowserHistoryAdapter。
5. recurring 日程直接复用 `expandEventList(...)`，不复制 calendar IPC 里的展开逻辑。
6. 项目主锚点优先目录，语义候选只做补充。
7. distant 使用硬门槛：最近 30 天有 open/save 的项目直接不能进入 distant。
8. v1 只写 open/save，不写 select/external_change。
9. `recordActivity` 路径校验采用安全 root + realpath + relative 包含性检查，不能用 `validateWorkspaceRoot(path)` 校验文件路径。
10. `FileTree` 顶部渲染是更符合视觉意图的接入点，因为涌现区应跟随文件树滚动。
11. `document:write` 保存埋点必须把单槽 `setDocumentWriteIndexHook(...)` 升级成 additive listener，不能再调一次 setter，也不能把 file activity 写进 search-engine hook body。
12. bucket 判定采用资格优先，不跨 bucket 比原始分数；score 只用于桶内排序。
13. 目录锚定 key 使用规范化真实目录路径；语义锚定 key 使用规范化标题，并通过协调步骤并入目录项目。
14. `confidence` 由锚点可信度、独立证据来源数和桶内归一分推导；v1 只显示 medium/high。
15. main snapshot 缓存 key 只包含 workspaceRoots；query/filter 只在 renderer view model 处理。
16. v1 grid mode 隐藏涌现区；四个 bucket 全空时隐藏整块，不显示空外框。
17. snapshot TTL 初始用 10 分钟；open/save 只标记 stale，面板再开时异步刷新。
18. v1 不调用 LLM 改名；先用规则版显示名，保留 `llm_refined` 通道做后续。
19. 设置入口放在存储/隐私相邻分组，施工时按当前 `Settings.tsx` 结构落位。
20. snapshot stale 判定包含 TTL 过期、activity 标脏、generatedAt 跨本地自然日三种条件。
21. recordActivity IPC payload 使用 `workspaceRoots[]` 校验和定位，落库时写命中的单个 `workspace_root`。
22. distant 的 `historicalImportanceScore` v1 初始门槛为 `0.50`。
23. 设置开关 v1 不做实时监听，下次文件面板可见或 FileTree 重新挂载时生效。

### 10.2 不再阻塞施工的低风险确认

1. WP2 后测一次真实 snapshot 生成耗时；若 10 分钟 TTL 仍显得过短或过长，再按证据调整。
2. WP4 后用实际截图确认涌现区的高度不会挤压普通文件夹。
3. Settings 的具体插入位置按施工时 `Settings.tsx` 的最新分组结构确认，但产品方向已定为存储/隐私相邻。

---

## 11. 建议施工顺序

最稳顺序：

1. WP0：shared 类型 + scoring/normalizer 合同。
2. WP1：file activity repository + migration。
3. WP2：main service 用 fake deps 跑通 snapshot。
4. WP3：IPC / preload / electron.d.ts。
5. WP4：FileEmergenceSection UI 接入。
6. WP5：Settings 开关。
7. WP6：open/save 埋点。
8. WP7：整体验收和视觉回归。

不要先画 UI 再补数据，也不要先埋点再没有投影合同。这个功能的成败在于“为什么这些东西出现”可解释；合同应先把 bucket、score 和 evidence 锁住。
