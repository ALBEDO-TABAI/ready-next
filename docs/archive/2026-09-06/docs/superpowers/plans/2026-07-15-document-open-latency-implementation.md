---
title: 文件管理器打开文档延迟收口
date: 2026-07-15
status: implemented
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 文件管理器打开文档延迟收口

## 1. 已证实的根因

1. `ready-doc-tabs-v2` 把标签元数据和未保存正文放在同一个 `localStorage` JSON 中。标签激活、打开或磁盘回读都会同步序列化并重写整个对象；真实安装态快照约 890 KB，其中单个未保存标签正文约 43 万字符，因此点击处理函数会在发出工作面切换请求前阻塞 Renderer。
2. 磁盘回读先把内容标成 dirty，再单独标成 saved，制造两次状态更新和一次本不该存在的巨大临时持久化。
3. 文件打开沿用普通人工模式切换的 ritual 与 280 ms 场景动画。Browser 离场还必须等待 `hide-all` ack，所以正确性等待和装饰等待被串成一条链。
4. split secondary 从 Browser 替换为其他 mode 时，旧入口直接写 `splitMode`，绕过 BrowserView 的离场 hide/ack 合同；BrowserMode 被直接卸载时也缺少最后一道 hide 防线。
5. 已隐藏但曾激活的 DocumentMode 仍会响应文件树 selection，重复 stat/open/activity。文件树与 DocumentMode 同时登记一次 open，又触发一次强制 emergence snapshot，放大主线程和 Main 的竞争。
6. 保存等待磁盘写入时继续输入，旧保存结果会把更新后的正文覆盖回旧快照，并错误删除最新草稿。
7. Browser 离场等待 ack 或 ritual 时，如果用户快速发出第二个同 mode 请求，旧请求仍可能晚提交，或让 BrowserView 保持隐藏且工作面一直处于未稳定状态。
8. FileTree 的涌现上下文订阅了整份 tab 对象；正文、dirty 和激活时间的每次变化都会重建空闲调度并重复发出 snapshot/reading-progress IPC。
9. 新 clean 文本标签的空内存正文会被 DocumentMode 与 MarkdownEditor 在同一轮各读一次；文件涌现生成期间的失效也可能被旧生成结果覆盖为 fresh。

## 2. 机器可验证合同

### C1 文档状态持久化

- 标签元数据与可恢复草稿分开持久化；元数据记录不得包含大正文。
- 只激活或复用标签时，不得重写未变化的草稿正文。
- 草稿正文写入可合并、可延后到空闲期，但页面隐藏或退出前必须同步冲刷最新值。
- 旧 `ready-doc-tabs-v2` 快照首次读取必须无损恢复，随后自然迁移到新布局。
- 磁盘读取落入标签时必须一次性写成 clean 内容，不得经过 transient dirty 状态。
- 保存完成只允许提交与发起保存时正文完全一致的快照；若期间又有输入，磁盘结果不得覆盖新正文或删除新草稿。

### C2 文件打开切换

- 文件树打开模式采用 `immediate` 呈现：不等待 ritual，不播放场景滑动；普通模式按钮和快捷键保持现有动画。
- 任何转换只要 Browser 从可见 mode 集合中离开，都必须先发 `hide-all` 并等待匹配 ack，最多等待现有 100 ms 上限，然后才能提交 mode。
- split 替换与 primary 切换必须经过同一个 Workbench 协调入口，Renderer 叶子组件不得直接绕过该合同。
- BrowserMode 卸载时必须幂等补发 `hide-all`，作为竞态和异常路径的最后防线。
- 模式请求采用 latest-wins；新请求必须取消旧 ack waiter 与 mode ritual。若旧请求已经隐藏 Browser 而新决定仍需显示 Browser，必须主动恢复可见性和稳定状态。

### C3 单一文件打开副作用

- DocumentMode 仅在当前可见时响应文件树 selection。
- 同一次文件树打开只登记一次 open activity；后台 emergence 刷新不得阻塞模式切换或文档呈现。
- FileTree 的涌现查询只由 workspace、group、tab id/group/path 等结构事实变化触发；正文、dirty 与激活时间变化不得重建调度或发 IPC。
- 首次 clean/empty-memory 文本加载只由 MarkdownEditor 读取一次；父级激活刷新只处理已有内存正文，目录变化仍可刷新空缓存。
- 文件涌现生成捕获失效代次；生成期间出现新活动时，旧结果不得写成 fresh，下一次查询必须重新生成。

## 3. 验收

- 行为测试覆盖：旧快照恢复、大草稿与元数据分离、激活不重写草稿、空闲合并写、退出冲刷、磁盘 clean hydrate。
- 行为测试覆盖：保存期间继续输入时，新正文和草稿仍保留。
- 行为测试覆盖：file-open 请求为 immediate；primary Browser 离场和 secondary Browser 离场都先 hide/ack 后 commit；普通模式切换仍走原动画；卸载补 hide。
- 行为测试覆盖：后发模式请求取消旧 ritual，并在决定留在 Browser 时恢复显示；正文/dirty/激活更新不触发涌现查询；首次空缓存只读盘一次；生成中失效不会被吞。
- 真实安装态或等价 Electron 打包态验证：43 万字符 dirty 标签存在时，点击文件不再在事件处理阶段同步写入约 650–890 KB；Browser → Document 可见切换不再叠加 ritual/场景动画。
- `npm run typecheck`、文档/Workbench/BrowserView 专项测试、`npm run verify:native` 与最终 DMG smoke 全部通过。

## 4. 2026-07-15 打包态验收

- 在 0.7.1 DMG 的全新用户数据中创建两份约 100 KB Markdown 文档，全程通过真实文件树点击。
- Browser → Document 首次完整内容可见耗时 954.1 ms；Document → 新文档内容可见耗时 1037.8 ms。
- 最终工作面与活动标签均指向第二份文档，没有超时、空白或退回 Browser。
