---
name: fastnote
description: 笔记快捷模式路由方法论。把 IM-style 混合输入（短文本 / 链接 / 图片 / 视频 / 音频 / 文件）按触发深度档位分发到合适的下游能力（剪藏 → study-notes / image-analysis-router / video-copy-analyzer / video-expert-analyzer），并落到用户指定的工作区。Use when the user uses `-/:` / `-/2:` quick-mode triggers in chat or remote IM channels, or asks you to "快速记一笔 / 深度学这条 / 把这条 IM 消息处理成笔记". Do not use for direct content generation, single-tool calls without dispatch logic, or workflow already managed by another orchestrator.
---

# FastNote

FastNote 是**路由方法论**，不是分析器。它的职责是：合并相邻 IM 事件 → 构造一个 job → 选 quick / deep 模式 → 按规则分发到正确的下游 skill → 把产物写入用户工作区 → 标注完成或 blocked 状态。

**不要在 FastNote 内部重新实现剪藏、OCR、ASR、图像批评、视频分析或 study-notes 综合**——每个能力都有专属 skill。

## 触发语法

| 触发 | 模式 | 含义 |
| --- | --- | --- |
| `-/：` 或 `-/:` | quick | 快速捕获：剪藏 / 摘要 / 标签 / 路由 / 索引，不做深度分析；从不反问 |
| `-/2：` 或 `-/2:` | deep | 深度学习：在 quick 基础上调用 study-notes / image-analysis-router / video-* 生成深度产物；dispatch 不安全时可问一次 |

多个触发出现在同一合并窗口时：**最新显式触发胜出**。早期附近媒体只有在强证据下才挂给最新触发。

## 期望输入

FastNote 接受以下载荷形态，未知形态 → 落 `Inbox/Needs Review` source-only。

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `trigger_text` | yes | string | 显式的 `-/:` 或 `-/2:` 行 |
| `nearby_items` | 可选 | `{kind, value, timestamp?}[]` | `kind ∈ {text, link, image, video, audio, file}` |
| `chat_context` | 可选 | string | 会话 / 发送者上下文 |
| `user_goal` | 可选 | string | 自由文本意图（例如 "我要看构图"） |
| `workspace_root` | 可选 | string | 工作区绝对路径；缺省时取调用方默认值 |
| `runtime_context` | 可选 | `{has_timestamps: bool, has_chat_history: bool}` | 控制合并 fallback |

## 合并窗口规则

- **有真实 timestamp**：合并 same-sender、same-conversation 的 `[anchor − 30s, anchor + 30s]` 内消息。
- **无 timestamp**（多数 LLM 前端的现状）：
  1. trigger 作为 anchor。
  2. **相邻**定义：trigger 之上用户最近的连续相同 sender / 同意图消息，最多 3 条。
  3. 用户显式引用 "前面那张图 / 上面的链接 / 刚才那段"：包含被指认项，即使超出 3 条上限。
  4. 只有 trigger 本身在 scope 内：job 没有附加上下文，在 `merge_rationale` 里写明。
- **归属不清**：不要吞掉额外项，从显式 trigger 构造 job，并在 `merge_rationale` 写明排除项。

合并时必须按以下模板记录 `merge_rationale`：

```text
merge_rationale: "anchor=<trigger>, included=<kinds>, excluded=<kinds + reason>, window=<timestamps|adjacent>"
```

## 路由分发矩阵

| 内容形态 | quick (`-/:`) | deep (`-/2:`) |
| --- | --- | --- |
| 短文本 / 普通链接 | source note + summary + tags + route | 同 quick |
| 长文 / 长文章页 | 剪藏先行 → source note 引用剪藏正文 | 剪藏 → `study-notes` |
| 纯图 / 长图文混合页 | 剪藏先行 | 剪藏 → `study-notes` |
| 密集文字图片 | OCR 进入 source note 正文 | OCR → `study-notes` |
| 图像（截图 / 海报 / 摄影 / 设计 / 空间） | source note 引用图片 | source note → `image-analysis-router` |
| 视频（文案 / 钩子 / 转化向） | 链接保留 + tag | `video-copy-analyzer` |
| 视频（镜头 / 剪辑 / 场景向） | 同上 | `video-expert-analyzer` |
| 视频意图含混 | quick 不问 | deep：问一次 copy vs expert |
| 音频 / 语音 | 转写到能摘要的程度 | 转写 → `study-notes` |
| 混合（文本 + 图像 + 视频） | quick：按主要类型路由 | deep：按主要意图分多个产物 |

不要为同一资源同时调两个 video 分析器，除非用户明确要两份输出。

## Unsafe Dispatch 定义

满足以下任一情形即视为 **unsafe**，**不得**静默替换工具：

1. 所需 sibling skill 缺失。
2. deep 视频请求没有 copy-vs-expert 线索：deep 问一次；quick 仅保留 source note。
3. OCR / 文本抽取失败，但 deep 步骤需要该文本。
4. 用户意图在 text 与 visual 之间分裂且无明显主线。
5. `confidence == low` 且 prompt 没有分类线索。

行为：
- **quick**：从不问。落 `Inbox/Needs Review`，`confidence: low`，无 deep 产物。
- **deep + prompt 有信息**：问一次澄清，**不**先建 deep 产物。
- **deep + prompt 无信息**：source note `status: "blocked"`，写 `blocked_step` 与 `blocked_reason`，**不**用替代工具伪造 deep 产物。

## 工作区写入语义

FastNote 不自己决定工作区根路径。调用方（远程 IM channel 适配器、UI 触发器、agent 用户消息）通过 `workspace_root` 参数注入。

工作区内子目录规则（路径相对 `workspace_root`）：

| 意图 + 置信度 | 子目录 |
| --- | --- |
| low confidence | `Inbox/Needs Review/` |
| todo / 提醒 | `Tasks/` |
| idea / 问题 | `Ideas/` |
| bookmark / article / page clip | `Reading/` 或 `Knowledge/` |
| 长期 reference / snippet / extracted learning | `Knowledge/` |
| 日志 / 个人记录 | `Journal/` |
| 显式项目命中 | `Projects/<project-slug>/` |

如果剪藏 / 下游 skill 已经写好正文，**enrich** 该产物（追加 metadata / 链接 / 标签）即可，不要重写。

## Source Note 契约

source note 是产物的 system of record。**始终**保留：

- 原始 trigger 文本
- canonical source URL 与附件路径
- OCR / transcript 证据（用到的时候）
- 工具选择与路由理由（不显然时）
- `status / blocked_step / blocked_reason`（deep 不安全时）
- `merge_rationale`（合并附近项时）

frontmatter 至少包含：`status ∈ {complete, source-only, blocked}`、`route`、`mode ∈ {quick, deep}`、`workspace`、`created`。

## Batch Handling

同 job 携带多个媒体项时：
- **同意图**（如同房间 3 张照片）：合并一个 job、一个 source note、可选一个 deep 产物。
- **不同意图 / 不同形态**：拆成 N 个 job，每个一份 source note。Batch Report 是人类可读的包装，**不**替代 per-item 产物。

```markdown
## Batch Report

### Item 1 — <route> — <source_note_path>
<short summary>

### Item 2 — <route> — <source_note_path>
<short summary>

### Cross-batch synthesis
<one paragraph: 共同点与差异>
```

## Handoff Payload（给下游 skill）

这些字段是 prompt-side 约定，不是运行时 schema：

- `study-notes`：`extracted_text`、`user_goal`、`source_note_path`、`source_urls`、`ocr_or_transcript_evidence`
- `image-analysis-router`：`image_paths`、`user_goal`、`source_note_path`、`source_urls`、`optional_ocr_hint`
- 视频分析器：`video_path_or_url`、`analysis_type`、`user_goal`、`source_note_path`

**不要**给 `study-notes` 发未提取的 binary；**不要**让 `image-analysis-router` 自己建 source note，FastNote 必须先建好。

## Guardrails

- 不要捏造源材料 / OCR / 转写 / 剪藏正文之外的事实。
- quick 不要做深度分析，除非用户显式升级。
- 不要在视频分析器已经覆盖时重复 OCR / ASR 栈。
- 不要因为做 polished note 而丢失 raw 源材料。
- 不要把不安全 deep job 静默降级为另一工具的产出。

## Recommended Response Pattern

执行 FastNote 时显式说明：
1. 触发了哪个模式
2. 哪些附近项被合并进同 job（哪些被排除 + 原因，写在 `merge_rationale`）
3. 每一步由哪个外部能力负责
4. 创建了哪些 note 产物
5. 校验通过 / 或精确的 blocked step 与 reason
