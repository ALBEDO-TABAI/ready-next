---
kind: implementation
status: completed
enforce: false
date: 2026-07-12
scope: file-emergence-p1
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 文件涌现与 Tag Forge：P1 项目身份与可靠命名实施合同

## 1. 阶段边界

本阶段建立稳定的文件身份、项目身份和统一标题解析。它接入已经存在的结构信号，但不建设 P2 长期注意力、future/distant 新资格，也不运行模型消歧。

P1 完成必须同时证明：

1. 展示名变化不会改变 `projectKey`；
2. Ready 内部文件或目录移动后 `fileKey`、项目成员和旧 activity/reading 的归属保持连续；
3. 外部模糊移动不靠相同内容自动合并；
4. 项目标题按用户、显式 metadata、命名 tab group、任务/产物/附件、目录共同支持的顺序解析；
5. 哈希、UUID、BV 编号、图片资源名、纯时间戳、超长商品式标题不能抢占项目名；
6. 单文件标题或语义短句不能把两个不同目录合并；
7. 文件树、snapshot 和后续意图投影使用同一个共享 `projectKey` 合同；
8. 用户能在文件树纠正项目名和文件归属，刷新与重启后仍保持。

## 2. 数据合同

### 2.1 FileIdentity

新增单一真值表，至少保存：

- `file_key`：随机稳定 id，不由 path 或 hash 派生；
- `workspace_root/current_path/status`；
- `observed_since/last_verified_at`；
- 可选 `content_hash` 只作校验，不自动决定外部移动合并。

Ready 内部 `document:rename` 与 `document:move` 成功后必须在同一主进程收口调用身份迁移，生成持久 move receipt：

- `receipt_id/file_key/old_path/new_path/moved_at/kind`；
- 文件夹移动要更新其下全部已知成员；
- 同一 old/new 重试幂等；
- 身份迁移失败时文件操作返回失败，不允许 UI 已移动而身份账本静默断裂。

已有 activity/reading 不改写历史行；identity resolver 通过 move receipt 把旧路径归到当前 `fileKey`。

### 2.2 ProjectIdentity

新增单一真值表和成员表，至少保存：

- `project_key`：随机稳定 id；
- `workspace_root/display_name/source/confidence/status`；
- `anchor_path/aliases_json/evidence_json`；
- `created_at/updated_at`；
- member 的 `file_key/source/confidence/created_at/updated_at`。

权威顺序固定为：

1. 用户改名或归属纠正；
2. `ready_project`；
3. 用户命名的 document tab group；
4. task expected output / artifact / conversation attachment；
5. 至少两个成员或两类行为支持的稳定目录；
6. 有边界的结构共识；
7. 单文件/目录 fallback。

项目改名只更新 display name 与 aliases，不创建新项目。隐藏、延后和合并状态留给后续阶段，本阶段不提前实现。

### 2.3 共享输出

`FileEmergenceProject` 必须显式包含 `projectKey`；旧的候选 `id` 只作本次 snapshot 行 id，不再承担稳定身份语义。所有交互 payload 使用 `projectKey`。

## 3. 标题解析合同

### 3.1 候选必须带来源与支持

标题 resolver 输入不是字符串数组，而是结构化候选：

- label/source；
- 支持该 label 的不同 `fileKey` 数；
- 支持来源集合；
- 是否由用户或显式 metadata 给出；
- 是否只描述一份文件。

共同支持和来源质量优先于长度。旧的 `label.length / 18` 奖励必须删除。

### 3.2 硬拒绝

以下候选不得成为多文件项目标题：

- UUID、十六进制 hash、长数字/时间戳；
- `BV...`、图片或导出资源编号、扩展名残片；
- 超过 48 个字符且只被一份文件支持的商品式/网页式标题；
- `src/assets/output/docs/资料/项目` 等通用容器；
- 只由 browser history 或一次 Agent 短句支持、没有文件/项目锚点的名称。

### 3.3 真实噪声回放

固定 fixture 必须包含：

- 宝矿力 vs `04-代表广告与项目拆解`；
- 多看书 vs 超长《卡拉马佐夫兄弟》商品式书名；
- pin vs `5ecdf91a6a98532ba0fec7ec22d35dc4`；
- 品牌广告 vs `BV..._文字稿`；
- 服装研究 vs webp hash；
- 2026 世界杯 vs `2018-logo-1`。

期望均保留可读项目名，不被单文件噪声抢占。

## 4. 已有强信号接入

- 文档索引：读取 `frontmatter.ready_project`；
- document tab group：renderer 把命名组和成员路径作为 snapshot 的结构化 context 传入 main；
- task projection：只读取 expected outputs、recent artifact 和明确标题，不扫描聊天正文；
- conversation attachment：只读取本地 workspace path/name/time；
- 所有路径先经过 workspace 边界校验；
- 一个信号不能凭相似字符串跨目录合并，必须命中已有 member/file identity 或明确 anchor。

## 5. 用户纠正

- 项目行提供“重命名”入口，提交空值/超长值失败并显示原因；
- 文件行提供“调整归属”入口，只能选择当前 snapshot 中同 workspace 的项目或新建一个明确命名项目；
- main 再次验证 project/file/workspace 边界并持久化；
- 修改成功后只标脏受影响缓存并强制刷新；
- 用户来源永远高于自动 resolver，自动刷新不得覆盖。

## 6. 验证门

独立 `verify:file-emergence` 增加：

- migration 新建/升级/重复运行；
- file identity ensure、内部文件移动、目录移动、幂等 receipt；
- 相同 hash 的两个外部文件不误合并；
- project create/rename/alias/member reassign；
- 六组真实噪声标题回放；
- ready_project、tab group、task artifact、attachment 的优先级与 workspace 边界；
- service snapshot 输出稳定 projectKey；
- renderer rename/reassign 行为与失败提示；
- Electron 原生数据库测试无 skip；
- 真实 Ready 文件管理中完成一次项目改名和一次内部移动，重启后读回不变。

## 7. 不采用

- 不用展示标题 hash 当 `projectKey`；
- 不用 content hash 自动关联外部移动；
- 不保留 path-key 与 fileKey 双真值；
- 不在 renderer 自建第二套项目 id；
- 不在本阶段调用模型；
- 不因 P1 顺手调整 future/distant 资格或排序权重。

## 8. 2026-07-12 验收结果

- 新增稳定 FileIdentity、move receipt、ProjectIdentity 与唯一成员归属账本；
- Ready 内部 rename/move 在身份写入失败时回滚文件系统，不产生“文件已移动但身份断裂”的半状态；
- 六组当前真实噪声回放均保留可读项目名，旧长度奖励已删除；
- `ready_project`、命名 tab group、task output/artifact、conversation attachment 已进入同一结构化标题入口；
- 项目改名、改派到已有项目、从文件新建项目均有 main 二次边界校验与持久化；
- `npm run verify:file-emergence` 通过：71 条功能检查与 15 条 Electron 原生数据库检查全部成功，无 skip；
- `npm run typecheck`、迁移连续编号和 whitespace 检查通过；
- 隔离 Ready dev 中实际完成 `seed.md -> renamed-seed.md`，move receipt 的 `fileKey` 保持不变；
- 项目从 `seed` 改为 `P1 持续阅读项目` 后 `projectKey` 保持不变，重启应用后名称与新文件路径均正确读回；
- 真机使用 `/private/tmp/ready-file-emergence-p1-live` 隔离数据目录，没有改动用户现有 Ready 数据。
