---
title: 文件涌现阅读意图与分区优化方案
date: 2026-06-08
status: draft-for-implementation
owner: 白
executor: Codex
enforce: true
related:
  - docs/superpowers/plans/2026-06-08-file-emergence-implementation.md
  - AGENTS.md §0（开工前）
  - AGENTS.md §0.5（先合同，后代码）
  - AGENTS.md §6（测试与验证）
---

# 文件涌现阅读意图与分区优化方案

## 0. 本轮目标

这份文档承接文件涌现 v1 实装后的真实使用反馈。目标不是重做 UI，也不是把所有文件重新索引一遍，而是修正“哪些东西应该涌现、应该出现在哪一类、应该用什么名字出现”的判断方式。

本轮明确新增一个核心判断：**阅读时长、阅读间隔、阅读进度**。它们不是普通加分项，而是用来区分以下几类完全不同的状态：

- 我今天只是点到过它。
- 我最近持续在看它，今天大概率还会继续。
- 我前几天看了很多，现在停了两三天，应该提醒我继续。
- 我已经看完或告一段落，应该进入过去。
- 我很久没碰，但投入很多、仍然有价值，应该进入未来或遥远，而不是消失。

完成标准：

1. 能解释用户反馈里的每个错例为什么发生。
2. 明确哪些数据没采到，哪些权重误判，哪些分区规则不合理。
3. 区分“已有但未汇聚”的阅读进度信号，和“确实需要新增”的阅读时长/空闲信号。
4. 给出阅读时长、阅读间隔、阅读进度的子算法。
5. 给出新的四类分区逻辑和验收用例。
6. 后续施工能按本文直接拆工作包和写测试。

非目标：

- 本文不直接修改代码。
- 本文不引入黑箱模型排序。
- 本文不要求第一步就做复杂个性化学习；先用可解释、可测试的规则。
- 本文不推倒文件涌现 v1。目录锚定、语义锚定、资格优先分桶、TTL 缓存等 v1 合同继续保留。
- 本轮 A3 只补文档/阅读器类进度信号，覆盖 Markdown、PDF、EPUB；代码和其他非文档类文件仍先按 open/save 处理。

## 0.1 关键修正

上一版文档把问题概括成“缺注意力模型”，方向对，但优先级还不够准。进一步核对后，真实根因应拆成两层：

1. Ready 已经有不少阅读进度和当前文档状态信号，但它们停留在 renderer 和 localStorage，没有进入 file-emergence 的显示决策。
2. Ready 仍然缺少有效阅读时长、空闲暂停、持续阅读节奏这部分信号，这些才需要新增采集。

因此本轮不能按“从零建立阅读采集”开工。正确顺序是先接现成信号，再补新增信号：

1. 当前文档现场：active tab、open tabs、dirty 状态。
2. 文档命名：先用文件名主体和 frontmatter title；H1 是可选增量，不是现成字段。
3. 已有阅读进度汇聚：Markdown/PDF/EPUB。
4. 阅读时长与空闲判断。
5. 连续性打分、系列聚类、future 延续护栏。

## 1. 用户反馈复盘

### 1.1 置身钉内

现象：

- `置身钉内` 这条出现是对的。
- 但项目名称不对，至少应该出现与 `置身钉内` 相关的文本描述。

说明：

这不是“是否命中”的问题，而是“命中之后怎么命名”的问题。当前规则更容易把父文件夹、路径段或单个文件名当成项目名，缺少对文档标题、正文首段、一级标题、当前文档状态的理解。

应修正为：

- 如果文件本身是明确文本对象，显示名优先来自文件名主体、frontmatter title、文档标题、最近编辑/阅读上下文。H1 可作为后续增强，但当前索引没有现成 H1 字段。
- 父目录只作为归属线索，不能压过更具体的文档名。
- 对单文稿类项目，项目名可以是 `置身钉内`，解释文案再补 `最近打开的文稿`、`来自文档模式`、`最近持续阅读` 等信息。

### 1.2 淘金小镇

现象：

- `淘金小镇` 放在过去或遥远都有可能。
- 但它不应该放在今天，因为已经很久没翻看过。

说明：

当前规则把“近期或某次打开/记录”过度解释为“今天要处理”。这说明 today 的门槛太低，尤其没有区分：

- 主动连续阅读。
- 偶然打开。
- 被涌现区自己点击过。
- 索引或历史记录里出现过。

应修正为：

- today 不能只看有没有最近事件。
- 需要结合当天真实停留时长、当前打开状态、连续阅读节奏、当天保存/编辑、今天日程。
- 单次短打开、来自涌现区的点击、旧浏览痕迹，都不能单独把项目推进 today。

### 1.3 白痴

现象：

- 用户最近明明经常看 `白痴`。
- 系统没识别到这是最近在看的书。

说明：

这是跨层信号汇聚的缺口。系统记录了 open/save，阅读器也已经保存了一部分进度，但 file-emergence 服务没有拿到这些信息，所以仍然没有理解“阅读中”：

- 没有持续阅读时长。
- 没有阅读间隔。
- 已有阅读进度没有汇聚到 main / 涌现服务。
- 没有把当前文档模式打开的 tab 当作强信号。
- 没有从书名、文件名、文档标题中识别“这是一本文本/书，而不是普通项目文件”。

应修正为：

- 文档模式当前打开的文件必须进入涌现候选。
- Markdown/PDF/EPUB 已有阅读进度要先接入涌现判断。
- 阅读型文件再补 active reading session，用于时长和间隔判断。
- `白痴` 这类书名即使没有保存，也应该因为持续阅读而进入 today。
- 如果连续几天没读，但已读时长和进度很高，应进入 future，表达“可能该继续读”，而不是 past 或 distant。

### 1.4 宝库系列与当前打开文档

现象：

- 宝库系列相关内容、文档模式中当前打开的不少文档，都应该在 today 或 past 里出现，但没有出现。

说明：

当前候选来源太依赖 file_activity 表，而 file_activity 并不等于“用户正在看的上下文”。文档模式里的当前 tab、最近切换的 tab、未关闭的工作现场，本身就应该是强信号。

应修正为：

- 增加“当前工作现场”来源：document tabs、active tab、最近 focus 的文件、未保存内容、最近阅读位置。
- 对同一系列文件做聚类，例如 `宝库`、`品牌空间`、`Aesop`、`门店图片数据库`，不要每个文件孤立打分。
- 系列项目的显示名要来自共同主题，而不是随机抽一个文件名。

### 1.5 未来为空

现象：

- future 现在什么都没有。
- 甚至没有根据最近看的东西猜一下，这不符合直觉。

说明：

当前 future 太依赖未来日历和显式未来词。现实里“未来”不只是日程，也包括被中断但大概率会继续的东西：

- 最近每天都读的书。
- 已经读了很多但停了几天的书。
- 做到一半但没有完成的项目。
- 最近反复打开、还没有收尾的资料库。

应修正为：

- future 加入“延续意图”。
- 高阅读时长 + 高阅读进度 + 短暂停顿，应该进入 future。
- 高近期投入但今天没有活动，不应该默认进入 past。

## 2. 问题层级

### 2.1 第一层：索引不是主因

这轮问题不能简单归因于“没有新建索引”。索引能让系统找到文件，但不能回答：

- 用户是不是正在看这个文件？
- 用户看了多久？
- 用户是不是连续几天在看？
- 用户看到了什么进度？
- 今天出现是因为真的要继续，还是只是被误点了一下？

所以主因不是缺少全文索引，也不是 v1 的分桶框架整体失败，而是 **阅读/当前现场信号没有进入涌现服务**。更准确地说：

- 当前文档 tab 状态在 renderer。
- Markdown/PDF/EPUB 阅读进度在 renderer localStorage。
- file-emergence main 服务只看到了 open/save、日历、聊天、浏览、搜索。
- 因此 main 侧只能用离散事件猜注意力，猜错是必然的。

### 2.1.1 v1 不需要推倒重来

v1 的骨架应继续保留：

- 目录锚定 + 语义锚定双轨。
- 语义候选并入目录候选。
- bucket 资格优先，而不是四类分数直接互比。
- snapshot TTL、跨自然日失效、手动刷新。
- search_index 只做相关文件召回。

本轮优化是在 v1 之上补信号和后处理，不要把问题扩大成重写涌现模块。

### 2.2 第二层：活动记录太粗

当前 file-emergence 只能稳定看到 open/save 这类离散动作。阅读行为的意义来自持续性：

- 读 10 秒和读 2 小时不是同一种信号。
- 连续 5 天每天读和一个月前点开一次不是同一种信号。
- 从 5% 读到 55% 和停在第一页不是同一种信号。

如果涌现服务只拿到 open/save，就会同时发生两个错误：

- 淘金小镇被一次旧事件误推到 today。
- 白痴这种持续阅读对象没有足够强的证据上榜。

### 2.3 第三层：today 被“最近性”污染

today 应该表示“今天最可能继续处理”。当前更像“近期出现过”。这会让噪音项目进来，也会让真正持续的项目被稀释。

today 的强信号应该是：

- 当前文档模式 active tab。
- 今天有效阅读时长。
- 今天保存或编辑。
- 今天日程。
- 昨晚到今天早晨的连续活动。

today 的弱信号应该是：

- 单次短打开。
- 涉及涌现自身的点击。
- 旧浏览历史。
- 只有全文搜索命中。

### 2.4 第四层：future 只认日程，不认延续

future 不是“日历即将发生”的同义词。它还应该包括“我已经投入很多，但今天没有继续，系统判断我可能需要被带回去”的内容。

例如 `白痴`：

- 如果每天都读几十分钟或几个小时，第二天大概率继续，应在 today。
- 如果第三天、第四天没读，但阅读时长和进度都已经很高，更像“被搁置的延续项”，应在 future。
- 如果已经读完或明确写了总结，才更适合 past。
- 如果很久没碰且没有继续迹象，但历史投入很高，可以进入 distant。

### 2.5 第五层：项目命名没有理解对象

涌现的显示名不能只取路径段。文件系统里很多路径段是容器，不是项目本体：

- `测试`
- `资料`
- `工作内容`
- `文档`
- `lib-a`

而真实对象可能是：

- 一本书：`白痴`
- 一篇文稿：`置身钉内`
- 一个系列：`宝库数据库`
- 一个空间项目：`Aesop 上海旗舰店设计`

命名应先判断对象类型，再选择显示名来源。

### 2.6 已有阅读信号清单

施工前必须先复用这些现成信号：

- Markdown / 文本：`documentScrollAnchor.ts` 已保存滚动比例、锚点标题、section 进度，key 为 `ready-document-reading-positions-v1`。
- PDF：`PdfViewer.tsx` 已保存滚动比例，并通过可见页追踪当前页。
- EPUB / 电子书：`EbookViewer.tsx` 已保存 `fraction` 和 `index`，key 为 `ready-ebook-reading-state-v1`。
- 文档现场：`useDocTabs.ts` 已持有 `activeTabId`、`tabs[]`、`splitTabId`、`isDirty`。
- 文档模式：`DocumentMode.tsx` 已把 PDF / EPUB / 图片 / 视频 / 文本路由到不同阅读器。

这些信号的问题不是不存在，而是还没有汇聚给涌现。第一批优化应优先接这些现成信号。

### 2.7 缓存冲突

v1 的 snapshot 缓存 key 只按 `workspaceRoots` 计算，这是合理的。当前 active tab 会频繁变化，如果直接进入 main snapshot 生成，会出现两个坏结果：

- 每次切 tab 都击穿缓存，导致重算太频繁。
- 或者缓存命中旧 snapshot，active 文档不能及时反映。

因此新增规则：

- main snapshot 继续按 `workspaceRoots` 缓存，负责稳定的基础项目集。
- 当前文档现场只参与 post-cache 后处理。
- 如果 active/open 文档不在基础 snapshot 中，后处理层必须 ensure-present，并在 today 中置顶或提高权重。
- 如果 active tab 文件已经落在某个已上榜目录项目的子树内，不新建单文档项目；改为把该目录项目 ensure-present 到 today 并置顶，同时把 active 文件在该项目文件列表里置顶或高亮。
- 只有当 active tab 文件不属于任何已上榜目录项目时，才注入独立单文档项目。
- ensure-present 不能突破每类 10 项上限；today 已满时，active tab 顶替最低分项目并置顶。
- query/filter 仍不进入 main 缓存 key。

这个规则必须写进合同测试：切换 active tab 只能触发轻量 re-rank / ensure-present，不能触发全量重新生成。

## 3. 新的核心模型

文件涌现不是“最近文件列表”，而是一个轻量的注意力预测器。

每个候选项目先判断它属于哪种状态：

1. **正在进行**：今天或最近连续投入，今天大概率继续。
2. **即将发生**：未来有日程、截止、准备动作。
3. **暂停但值得继续**：投入多、进度高、间隔短到中等，但今天没有继续。
4. **刚结束**：最近完成、交付、复盘、读完。
5. **久远但重要**：很久没碰，但历史投入、文件规模、系列关系或重要词都很强。
6. **噪音**：短打开、低停留、低进度、无跨来源证据。

四个 UI 分区应由状态推导：

- `今天`：正在进行。
- `未来`：即将发生 + 暂停但值得继续。
- `过去`：刚结束。
- `遥远`：久远但重要。

## 4. 阅读三要素子算法

### 4.1 阅读时长

阅读时长只计算有效停留，不计算窗口开着但人不在的时间。

建议采集：

- 文档 tab 获得焦点时间。
- 文档 tab 失焦时间。
- 滚动、翻页、选区、光标移动、页面切换等阅读行为。
- 应用窗口是否前台。
- 空闲超时，建议 90 秒到 180 秒无交互后暂停计时。

建议派生指标：

- `todayReadingMinutes`：今天有效阅读分钟数。
- `recentReadingMinutes`：近 7 天有效阅读分钟数。
- `maxSingleSessionMinutes`：最长单次阅读时长。
- `shortOpenCount`：短打开次数，低于 60 秒只算弱信号。

解释：

- 今天读了几十分钟或几个小时，是 today 强信号。
- 只打开几秒，不应推到 today。
- 长阅读时长即使没有保存，也比 open/save 更能代表关注。

### 4.2 阅读间隔

阅读间隔用来判断“接下来是否可能继续”。

建议派生指标：

- `[A] lastReadAt`：最后一次有效阅读时间，可先由 localStorage 进度记录的 `updatedAt` 推导。
- `[A] daysSinceLastRead`：距上次阅读天数，可由 `now - updatedAt` 推导。
- `[B] readingStreakDays`：连续阅读天数，需要阅读会话历史。
- `[B] averageReadIntervalDays`：最近几次阅读之间的平均间隔，需要阅读会话历史。
- `[A+B] continuationProbability`：可解释的延续概率，不需要模型；批次 A 先用进度和 lastReadAt，批次 B 再补时长和 streak。

建议规则：

- `[A] daysSinceLastRead <= 1` 且文档当前打开或今天有进度更新时间：today。
- `[A] daysSinceLastRead` 为 2 到 4 天，且进度高：future 延续型候选。
- `[B] daysSinceLastRead <= 1` 且近 7 天读过多次：today。
- `[B]` 连续阅读天数越高，today 或 future 的资格越强。
- `[A+B] daysSinceLastRead` 超过 7 天，且没有未来/继续信号：past 或 distant。

解释：

每天读 `白痴` 几十分钟，第二天大概率继续，所以应在 today。第三天第四天没读时，它不是“过去完成”，而是“可能需要继续”，所以更适合 future。

### 4.3 阅读进度

阅读进度用来判断“是否值得继续”和“是否已经结束”。

现有进度来源：

- Markdown / 文本：滚动比例、锚点标题、section 进度。
- PDF：滚动比例、当前可见页。
- EPUB / 电子书：`fraction` 进度和章节 index。

第一批不应重新采集这些进度，而应把 renderer localStorage 中已有数据汇聚到 file-emergence 后处理层。只有缺口明显的格式，再补轻量采集。

建议派生指标：

- `[A] progressRatio`：当前阅读进度，0 到 1，可由 EPUB `fraction` 或滚动 `ratio` 推导。
- `[B] progressDelta7d`：近 7 天进度变化，需要历史会话或多次进度记录。
- `[A] hasReachedEnd`：是否接近末尾，例如大于 0.9。
- `[A] isStalledHighProgress`：进度高但几天没继续，可由 `progressRatio + daysSinceLastRead` 先行推导。

建议规则：

- `[B]` 进度持续增长：today 或 future。
- `[A]` 进度很高但未完成，且停了 2 到 4 天：future 延续型候选。
- `[A+B]` 进度接近结束，且最近出现完成/总结/归档信号：past。
- `[A+B]` 进度低、时长低、间隔长：不上榜，除非有其他强证据。

### 4.4 三要素合成

建议新增一个独立分数：

```text
readingContinuityScore =
  durationScore * 0.35
  + cadenceScore * 0.30
  + progressScore * 0.25
  + currentTabBonus * 0.10
```

其中：

- `[B] durationScore` 由今天和近 7 天有效阅读时长推导。
- `[A+B] cadenceScore` 批次 A 先由 `daysSinceLastRead` 推导，批次 B 再加入连续天数和平均间隔。
- `[A+B] progressScore` 批次 A 先由进度比例推导，批次 B 再加入近 7 天进度变化。
- `[A] currentTabBonus` 只在文档当前打开或最近 focus 时加分。

这个分数用于判断“延续意图”，不是直接替代所有分区。

批次 A 已能支持一个轻量版延续判断：`progressRatio` 高、`daysSinceLastRead` 在 2 到 4 天内、且没有 today 强信号时，可以进入 future 延续型。批次 B 再用阅读时长和连续天数提高准确性。

## 5. 四个分区的新规则

### 5.1 今天

today 应表示“今天最可能继续处理”。

进入 today 的强资格：

- 今天有效阅读时长达到阈值。
- 当前 document mode active tab。
- 今天有保存、编辑、标注、进度推进。
- 今天日程直接指向该项目。
- 昨晚到今天早晨形成连续阅读或工作节奏。

降权规则：

- 来自涌现区自身的打开，不能单独制造 today。
- 少于 60 秒的短打开，只能作为弱证据。
- 没有时长、没有进度、没有当前 tab 的旧项目不能进 today。

用户反馈映射：

- `白痴` 如果今天或昨天持续读，应进 today。
- `淘金小镇` 很久没读，不应进 today。
- 当前打开的宝库文档应有 today 资格。

### 5.2 未来

future 应表示“接下来可能要处理”，包括日程型和延续型。

进入 future 的强资格：

- 未来日程、截止、准备、发布。
- 最近投入很多，但今天没继续。
- 阅读进度较高但未完成，停顿 2 到 4 天。
- 系列项目近期有多次活动，但当前没有 today 资格。

延续型 future 必须加护栏：

- 必须同时满足高连续性分和短间隔，建议 `daysSinceLastRead <= 4`。
- future 内延续型单独限额，建议最多 3 到 5 个，避免挤掉日程型项目。
- 延续型不能只靠单次 open 或 search_index 命中进入。
- UI 解释文案必须区分“未来日程”和“可能继续”，例如 `最近读了很多，已停 3 天`，不能伪装成有日程。

用户反馈映射：

- `白痴` 如果连续读过很多，第三天第四天没读，更适合 future。
- future 不能因为没有日历就为空。

### 5.3 过去

past 应表示“最近结束或需要整理”。

进入 past 的强资格：

- 最近日程已结束。
- 最近保存/编辑后出现完成、交付、复盘、总结、归档信号。
- 阅读进度接近结束，且有读完或总结迹象。
- 最近活跃过，但延续概率低。

用户反馈映射：

- `淘金小镇` 如果只是很久前看过，past 可以成立。
- 但如果它既久远又重要，distant 也可能成立。

### 5.4 遥远

distant 应表示“很久没碰但重要”，不是垃圾堆。

进入 distant 的强资格：

- 很久没有有效阅读或打开。
- 历史阅读时长高、文件规模大、系列关系强。
- 名称或内容含重要词，如宝库、数据库、案例、品牌、合同、资产。
- 没有 today/future/past 的更强资格。

用户反馈映射：

- `淘金小镇` 如果长期未读，但历史投入或主题重要，可以进 distant。
- 低时长低进度的旧文件不应为了凑数进入 distant。

## 6. 权重优化方向

### 6.1 来源权重重新排序

建议把信号强度从高到低调整为：

1. 当前 active document tab。
2. 今天有效阅读时长。
3. 阅读进度推进。
4. 连续阅读节奏。
5. 今天保存/编辑。
6. 今天日程。
7. 最近 agent 对话。
8. 最近浏览历史。
9. 单次 open。
10. 全文搜索命中。

重点变化：

- open 从强信号降为入口信号。
- reading session 成为文档/书籍类项目的核心信号。
- search_index 只用于找相关文件，不应该单独决定分区。

### 6.2 文件打开来源降噪

不同来源的 open 权重应不同：

- `document_mode`：较强，因为用户正在阅读或编辑。
- `file_tree`：中等，需要结合停留时长。
- `emergence`：低，避免涌现区点击反向污染 today。
- `document_write`：强，但偏向工作/编辑，不等同阅读。

### 6.3 系列聚类

对宝库、品牌空间、Aesop、门店、图片数据库等内容，应先聚成项目，再决定分区。

聚类依据：

- 共同路径前缀。
- 共同主题词。
- 文件名 token 重合。
- 最近活动时间接近。
- 同时出现在当前 document tabs 或 agent 对话中。

聚类后的项目名优先选：

- 最具体的目录名。
- 多个文件共同的主题词。
- 文件名、frontmatter title，或可选 H1。
- 日历/agent 中更具体的表达。

## 7. 数据与结构调整建议

### 7.1 当前文档现场后处理

第一批先不改变 main snapshot 缓存模型。renderer 在拿到基础 snapshot 后，构造 `currentDocumentContext` 做后处理：

```text
base snapshot from main
+ current document context from renderer
+ local reading progress from renderer localStorage
=> displayed emergence view model
```

`currentDocumentContext` 至少包括：

- 当前 active tab path。
- 打开的 tab paths。
- 最近 focus 的 tab。
- split pane tab。
- 当前阅读进度。
- 是否有未保存内容。
- tab title。

处理规则：

- active tab 若不在基础 snapshot 中，必须 ensure-present 到 today。
- active tab 文件若已被某个已上榜目录项目覆盖，不新建单文档项目；置顶该目录项目，并置顶/高亮其文件列表里的 active 文件。
- active tab 文件未被任何已上榜项目覆盖时，才作为独立单文档项目注入。
- ensure-present 后 today 仍最多 10 项；active tab 顶替最低分项目。
- open tabs 可进入 today 候选，但低于 active tab。
- dirty tab 是编辑/工作强信号。
- current context 不进入 main 缓存 key。
- `file_emergence_enabled = false` 时，current context 后处理和 localStorage 进度读取也必须停止。
- renderer 后处理必须有纯函数测试，证明切 tab 只改变 displayed view model，不要求 main 重算。

### 7.2 已有阅读进度汇聚

第一批先读取 renderer 已有 localStorage：

- `ready-document-reading-positions-v1`
- `ready-ebook-reading-state-v1`

汇聚规则：

- 只读当前 workspace roots 内的路径。
- path 必须经过与 file activity 一致的安全 root 过滤。
- path 不存在、已删除、已移动，必须过滤；不要把 localStorage 残留记录重新涌现出来。
- 进度记录可作为 current context 的一部分传给 view model。
- 对 EPUB 的 `fraction`，直接映射为 `progressRatio`。
- 对 Markdown/PDF 的 `ratio`，先映射为粗略 `progressRatio`；PDF 当前页可作为解释补充。
- 这些进度第一批不必落 main DB；若后续需要跨窗口、跨进程统一，再加轻表。

### 7.3 阅读会话记录

阅读时长、空闲判定、连续性仍然需要新增采集，但不应做高频采样写库。

建议新增或扩展为阅读会话表：

```text
document_reading_sessions
```

建议字段：

- `id`
- `path`
- `workspace_root`
- `source`
- `started_at`
- `ended_at`
- `active_ms`
- `progress_start`
- `progress_end`
- `progress_kind`
- `meta_json`

硬约束：

- idle / visibility / foreground 判断放在 renderer，不在 main 新建窗口 focus 监听。
- renderer 内存里累计 session。
- 只在失焦、切 tab、窗口隐藏、pagehide、beforeunload、before-quit flush 时写一行。
- 不允许每秒或每 100ms 写库。
- 短于 30 秒的片段可以丢弃或合并。
- before-quit flush 必须走现有 bounded cleanup 思路，不能 fire-and-forget。

保留策略：

- 近 90 天或最近 10,000 条。
- 清理在生成或写入时轻量执行。

### 7.4 文档标题提取

对文本、Markdown、PDF、ebook 类文件，显示名应优先尝试：

1. 文件名主体。
2. 文档 metadata title。
3. frontmatter title。
4. Markdown H1 或正文首个高信息标题。
5. 父目录名。

父目录名只有在它比文件名更像项目名时才优先。

事实边界：

- `documents` 表已有 `name` 和 `frontmatter_json`，所以文件名主体、frontmatter title 便宜可用。
- 当前搜索索引没有派生 title/H1 列。
- `parseDocumentGraph` 当前返回 body、tags、links、frontmatter、widgetText，不暴露 `firstHeading`。
- H1 提取不能放到 renderer post-cache 热路径里重读文件。

施工建议：

- A2 是 main 侧基础 snapshot 的命名改进，不是 renderer post-cache。title 对文件稳定，适合吃 roots-only 缓存。
- A2 第一步只做文件名主体 + frontmatter title，就能修 `置身钉内` 这类文件名本身有效的反馈。
- H1 是 A2 的可选增量：若确有“文件名是泛词但正文有好标题”的需求，再给解析路径补 `firstHeading` 字段并让索引带上，或在 main 侧从已索引 body 中提取首个标题。
- 不允许在 view model 中为命名而重读文件。
- EPUB metadata title 优先来自电子书 reader 或 ebook import 解析结果。
- 不新增模型命名；规则无法稳定命名时降置信，不硬编。

## 8. 工作包建议

### WP0 - 反馈合同与夹具

目标：先把用户反馈变成可测试合同。

必须覆盖：

- `白痴` 连续两天每天阅读 60 分钟，进入 today。
- `白痴` 阅读进度 60%，停 3 天，进入 future。
- `淘金小镇` 30 天未读，不进入 today。
- `置身钉内` 当前打开，显示名包含 `置身钉内`。
- 当前 document tabs 中的宝库文档进入 today 或 past 候选。
- search_index 命中不能单独生成 today。
- emergence 来源 open 不能单独推高 today。
- 切换 active tab 只改变 displayed view model，不触发 main snapshot 全量重算。
- 延续型 future 有单独限额，且解释文案不同于日程型 future。
- active tab ensure-present 后 today 仍最多 10 项。
- active tab 已被目录项目覆盖时，不新建重复单文档卡。
- 关闭文件涌现后，不读取 current tabs / localStorage 进度做后处理。
- localStorage 里已不存在的路径不会重新涌现。

### 批次 A - 便宜、确定性、优先落地

目标：先用已有信号修掉最明显错例，不新增重型采集系统。

#### A1 - 当前工作现场后处理

目标：涌现能看到当前文档模式正在打开什么。

验收：

- active tab 是 today 强信号。
- open tabs 是 today / past 候选来源。
- dirty tab 有更高权重。
- active tab 若不在基础 snapshot 中，会被 ensure-present。
- active tab 若已被已上榜目录项目覆盖，不新增重复单文档卡；改为置顶目录项目并置顶/高亮 active 文件。
- current context 不进入 main cache key。

#### A2 - 文件名/frontmatter 命名，H1 可选增量

目标：减少路径段误命名，先修 `置身钉内`。

验收：

- `置身钉内.md` 显示为 `置身钉内` 或明显相关标题。
- 父目录 `测试`、`资料`、`lib-a` 不压过具体文档名。
- frontmatter title 可作为命名来源。
- H1 不作为 A2 第一步前置；若要做，必须在 main 侧解析/索引层补字段，不能在 renderer post-cache 重读文件。
- EPUB metadata title 可作为书名来源。

#### A3 - 已有阅读进度汇聚

目标：把 Markdown/PDF/EPUB 已有进度纳入涌现，不从零采集进度。

验收：

- EPUB `fraction` 能让 `白痴` 被识别为阅读对象。
- Markdown/PDF localStorage 进度能进入 current context。
- localStorage `updatedAt` 能推导 `lastReadAt` 和 `daysSinceLastRead`。
- 进度只影响相关文档，不跨 workspace root 泄漏。
- 已不存在路径会被过滤。
- 非文档类文件本轮不补阅读进度信号，仍按 open/save 和其他来源判断。
- 没有 today 活动但高进度短暂停顿的阅读对象可进入 future 延续型候选。

### 批次 B - 较重、补完整注意力模型

批次 B 只有在批次 A 仍不能稳定表达“持续阅读”时全量推进。

#### B1 - 阅读会话采集

目标：补上有效阅读时长、空闲暂停、阅读间隔。

验收：

- 文档前台有效阅读会累计 active_ms。
- 空闲不会继续涨时长。
- 只在 session 结束或 flush 时写入，不高频写库。
- 短打开不会被误判为长阅读。
- window hidden / pagehide / beforeunload 能 flush。

#### B2 - 阅读连续性打分

目标：实现 readingContinuityScore，并接入 today/future 判定。

验收：

- 连续阅读进入 today。
- 高投入短暂停顿进入 future 延续型。
- 延续型 future 最多 3 到 5 个。
- 低投入旧文件不上榜。

#### B3 - 系列聚类

目标：提升宝库、品牌空间、Aesop、门店等系列内容识别。

范围：

- B3 只处理跨目录、跨锚点的系列聚类。
- 同一目录子树内的文件已由 v1 目录锚定覆盖，不在 B3 重做。
- 若 B3 聚类命中已有目录项目，应并入或提升既有项目，不新建竞争卡片。

验收：

- 当前或近期打开的宝库相关文档可聚成一个项目。
- 系列项目名来自共同主题，而不是随机文件名。
- 聚类不能把无关但同父目录的文件强行合并。

#### B4 - 分区与解释文案

目标：每个项目为什么出现、为什么在这个分区，可解释。

验收：

- today 项目能解释“今天正在读/当前打开/今天编辑”。
- future 日程型能解释“未来日程/截止/准备”。
- future 延续型能解释“最近读了很多但几天没继续”。
- past 项目能解释“最近完成/结束/复盘”。
- distant 项目能解释“很久没碰但历史投入或重要性高”。

### 真实应用验证

目标：用 dev 应用验证用户反馈路径。

验收：

- 打开 dev 应用后，涌现不再只有 past。
- future 在没有日历时也能出现合理延续项。
- `淘金小镇` 不会因旧记录进入 today。
- `白痴` 类持续阅读对象能被识别。
- UI 展开/折叠、刷新、空态正常。

## 9. 验收用例清单

### 用例 A：连续阅读的书

数据：

- `白痴.epub` 或 `白痴.md`
- 昨天有效阅读 90 分钟。
- 今天有效阅读 20 分钟。
- 进度从 30% 到 45%。

期望：

- 出现在 today。
- 理由包含持续阅读或今天阅读。
- 不依赖保存事件。

### 用例 B：高投入但停顿

数据：

- `白痴`
- 近 7 天累计阅读 5 小时。
- 进度 65%。
- 最近 3 天没有阅读。

期望：

- 出现在 future。
- 不出现在 past。
- 理由是最近投入高、可能需要继续。
- 作为延续型 future 计入单独限额。
- 解释文案不能暗示有未来日程。

### 用例 C：旧浏览/旧打开

数据：

- `淘金小镇`
- 30 天前打开过。
- 今天没有阅读、没有 tab、没有日程、没有保存。

期望：

- 不出现在 today。
- 若历史投入一般，可不上榜或进入 past。
- 若历史投入高且重要，可进入 distant。

### 用例 D：当前打开文稿

数据：

- 当前 document mode active tab 为 `置身钉内.md`。
- 有短时阅读或编辑。

期望：

- 出现在 today。
- 显示名包含 `置身钉内`。
- 不显示无意义父目录名。
- 不要求 main snapshot 重新生成整张基础项目集。

### 用例 E：系列资料库

数据：

- 多个当前或近期打开文档都属于 `宝库` 相关目录。
- 文件名和路径存在共同主题。

期望：

- 聚成一个宝库相关项目。
- 出现在 today 或 past。
- 不拆成多个低置信文件。

### 用例 F：涌现自污染

数据：

- 用户从涌现里点开一个旧项目 1 次，停留 20 秒。

期望：

- 不因为这次点击进入 today。
- 只作为弱 evidence。

### 用例 G：已有 EPUB 进度

数据：

- `ready-ebook-reading-state-v1` 中有 `白痴` 的 path 和 `fraction = 0.62`。
- 当前 workspace roots 包含该 path。
- 没有保存事件。

期望：

- `白痴` 可被识别为阅读对象。
- 若 active tab 是 `白痴`，进入 today。
- 若停顿 2 到 4 天且无 today 活动，进入 future 延续型。

### 用例 H：缓存后处理

数据：

- main 返回同一份基础 snapshot。
- renderer 依次切换 active tab：`置身钉内.md`、`白痴.epub`。

期望：

- displayed view model 随 active tab 改变。
- main snapshot cache key 不加入 active tab。
- 不触发全量候选重算。

### 用例 I：active tab 注入上限

数据：

- today 基础 snapshot 已有 10 个项目。
- 当前 active tab 不在 today 中。

期望：

- active tab 对应项目进入 today 并置顶。
- today 仍然只有 10 个项目。
- 被替换的是最低分项目。

### 用例 J：关闭开关

数据：

- `file_emergence_enabled = false`。
- renderer 有 active tab 和 localStorage 阅读进度。

期望：

- 不显示涌现区。
- 不读取 current tabs / localStorage 做后处理。
- 不产生新的涌现候选。

### 用例 K：localStorage 残留路径

数据：

- localStorage 中有某个文件的阅读进度。
- 该文件已删除、移动，或不在 workspace roots 内。

期望：

- 该记录被过滤。
- 不进入 today / future / past / distant。

### 用例 L：active tab 与目录项目去重

数据：

- 当前 active tab 为 `置身钉内.md`。
- 基础 snapshot 中已有一个 today 目录项目，其 anchorPath 是 `置身钉内.md` 的父目录或祖先目录。
- 该目录项目的文件列表已包含或可覆盖 `置身钉内.md`。

期望：

- 不新增第二个 `置身钉内` 单文档卡。
- 该目录项目被 ensure-present 到 today 并置顶。
- `置身钉内.md` 在该目录项目文件列表中置顶或高亮。
- today 仍然最多 10 个项目。

## 10. 最终判断标准

本轮优化完成后，涌现应满足：

1. 今天不再等于“最近出现过”。
2. 未来不再只依赖日历。
3. 阅读型对象能靠时长、间隔、进度涌现。
4. 当前文档模式打开的内容不会被漏掉。
5. 单次短打开和涌现点击不会污染 today。
6. 项目名优先表达真实对象，而不是路径容器。
7. 每个分区都有可解释理由。
8. 已有 Markdown/PDF/EPUB 进度被利用，不重复造进度采集。
9. 当前现场只做 post-cache 后处理，不破坏基础 snapshot 缓存。
10. future 延续型有护栏和限额。
11. active tab 注入不突破每类 10 项上限。
12. active tab 与已覆盖它的目录项目不会重复成两张卡。
13. 关闭开关时，current context 和 localStorage 后处理也停。
14. localStorage 残留路径不会重新涌现。
15. 用户反馈中的四类错例都有自动化测试覆盖。

## 11. 施工顺序建议

先做合同和夹具，再做现成信号接入，再决定是否补重型采集。

推荐顺序：

1. WP0：反馈合同与测试夹具。
2. A1：当前工作现场后处理。
3. A2：文件名/frontmatter 命名，H1 可选增量。
4. A3：已有阅读进度汇聚。
5. A 批次 dev 应用验证。
6. B1：阅读会话采集。
7. B2：阅读连续性打分。
8. B3：系列聚类。
9. B4：解释文案。
10. B 批次 dev 应用验证。

不要先调权重去“碰巧让白痴出现”。第一步应先把现有 current tabs 和阅读进度接上；如果仍不足，再补阅读时长和连续性。只靠 open/save 调权重，迟早会再次把淘金小镇这类旧项目误推到 today。
