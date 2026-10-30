---
title: Ready Next M3 文档内核实施合同
date: 2026-10-31
status: in-progress
enforce: true
---

# Ready Next M3 文档内核实施合同

## 1. 范围与依据

本文依据以下材料：
- 整合计划 `2026-10-30-ready-next-integration-implementation.md` 中的 §3.3、§3.4、M3 里程碑，以及合同 C4、C12；
- 2026-10-31 的只读调研 D3。调研结论已经并入本文，原始报告不入库。

**M3 交付：**
- 页面视角侧栏；
- 区间块编辑器；
- 页面头部；
- 统一的"保存到…"；
- Main 管理的草稿。

**M3 不交付：**
- 数据库视图、模板、评论和速览，留给 M5；
- 画板文档卡的真实回读，留给 M4，因为它依赖画板消费者。

正文的正本始终是资料库中的 Markdown 文件。Inkwell 只提供交互参考，它的块数据库和持久化方式不进入 Ready。

## 2. 已定决定

### M3-1 解析器

可编辑区间的解析使用 `mdast-util-from-markdown`、`micromark-extension-gfm` 和 `mdast-util-gfm`。仓库已经在 RSS 和 Widget 解析中使用这套组件。

`note-preview-parser` 只保留展示职责，可编辑区间改为读取共享解析结果。

理由：现行预览区间建立在换行统一之后的字符串上。D3 实测发现两个问题：
- 编辑后，未改动的字节没有保持原样；
- 已失效的区间没有被拒绝。

### M3-2 区间单位

每个区间同时给出两种位置，都是半开区间 `[start, end)`：
- **UTF-16 下标**：用于在缓冲上执行操作，与现有的 `replaceRange` 一致；
- **UTF-8 字节区间**：用于保真比较和对外报告。

每份原文只建立一次两者之间的映射。切断代理对的区间一律拒绝。

不是合法 UTF-8 的文件不开放块编辑，只能用源码模式；因为解码时会把非法字节换成替换字符，写回就会改变字节。

理由：解析器给出的是 UTF-16 位置。实测同一位置在 UTF-16 下是 7，在 UTF-8 下是 11，所以不能直接把它当作字节。

### M3-3 分栏格式

分栏使用 HTML 注释标记（见 §3.1），不使用代码围栏。整合计划 §3.4 中"`ready-columns` 围栏"的写法相应改为注释标记。

理由：其他编辑器（Obsidian、GitHub、Notion 导入）会按顺序正常渲染各栏内容；放进代码围栏，正文会被显示成源码。

### M3-4 编辑面分工

| 组件 | 在 M3 后的角色 |
| --- | --- |
| 新块编辑器 | 替换预览内的 textarea 编辑 |
| MarkdownEditor | 保留为源码模式，以及加载、保存的容器 |
| NotePreview | 保留只读预览、媒体、Widget 和导出 |
| TipTap | 不进入新的生产链 |

旧的预览修改函数退役，不能作为第二条写入路径。

### M3-5 排序、收藏与最近访问

同级排序、收藏、最近访问存 ready.db，按对象 id 记录。手动排序不跨机器同步。

理由：界面状态归 ready.db（见整合计划 §3.4 的表）。拖动一次排序不应改写一批 Markdown 文件。

### M3-6 回收站

回收站放在资料库内的 `.ready/trash/<操作 id>/`，每次删除附一份清单。对象新增 `trashed` 状态，这需要新迁移。永久删除是单独的一步。

理由：恢复时要保持对象 id 和原位置。系统回收站无法承担清单，也无法保持身份。

### M3-7 草稿

草稿正文存 ready.db（位于隔离的 userData 中）。Main 提交并回读之后，草稿才算得到确认。关闭标签不再意味着丢弃草稿。

理由：合同 C12 要求持久确认，而现行 localStorage 草稿没有这一步。

### M3-8 画板草稿的默认位置

来自画板 `X.canvas` 的草稿，默认保存到同名文件夹 `X/`。这是对整合计划中"画板旁"的统一解释，与 D7 的同名文件夹规则一致。

### M3-9 文档书本模式与书房分页

两者不合并，各自职责见 §6。

理由：合并会把书籍排版规则带进文档预览，增加保真和定位的风险。

## 3. 文件格式

### 3.1 分栏

```markdown
<!-- ready:columns widths=1,1 -->
第一栏的 Markdown 块

<!-- ready:column -->
第二栏的 Markdown 块

<!-- ready:columns-end -->
```

- 每个标记独占一行，并且位于顶层，不在列表、引用或代码围栏里面。代码里出现的同名文字不生效。
- `widths` 是逗号分隔的正数，个数等于栏数；不写时各栏等宽。
- 以下情况整段按普通块显示，标为"分栏格式需修复"，不自动改写：
  - 标记不成对；
  - 分栏嵌套；
  - `widths` 的个数和栏数不一致。
- 栏内是普通 Markdown 块。它们的区间仍是整篇原文中的区间。

### 3.2 页面属性（frontmatter）

| 键 | 值 | 说明 |
| --- | --- | --- |
| `title` | 字符串 | 显示标题。不写时用文件名去掉扩展名；文件名含非法字符时，在这里保存原标题。 |
| `icon` | Emoji、`lucide:<图标名>`，或资料库内的相对图片路径 | 页面图标 |
| `cover` | 资料库内的相对图片路径（优先放在同级 `.assets/`），或 https URL | 页面封面 |
| `ready_page` | 映射，见下文 | 只影响显示 |
| `ready_id` | 由对象服务按规则写入 | 页面视角不显示 |

`ready_page` 的字段：

| 字段 | 取值 |
| --- | --- |
| `font` | `sans`、`serif` 或 `mono` |
| `small_text` | 布尔值 |
| `full_width` | 布尔值 |
| `cover_y` | 0 到 1 之间的数 |

未知键原样保留。修改单个键时只用 `setFrontmatterFields` 做局部修改，不重写整段 YAML。

### 3.3 行内样式与引用

- 粗体、斜体、删除线、行内代码用标准 Markdown。行内代码的反引号要足够长，不能截断内容。
- 下划线写成 `<u>…</u>`。
- 颜色写成 `<span style="color: …">` 或 `background-color`，颜色值只能取 Ready 色板中的令牌名（色板在 T1 中固定）。富文本不生成其他 HTML。
- 页面引用写成 `[[路径或标题#锚点]]`；其他对象用 ReadyRef 链接。
- 遇到无法表达的行内结构，保留原文片段，或转为源码编辑，不能悄悄丢掉。
- 没有实质修改的块直接沿用原文，不重新输出。

### 3.4 页面与文件

- 同一目录中的 `A.md` 和 `A/` 合并为一个页面，`A/` 里的内容成为它的子项。
- 只有 `A/`、没有 `A.md` 时，显示为普通文件夹，不自动创建 `A.md`。
- `A.assets/` 收在页面的附件入口里；文件视角下显示实际目录。
- 合并按实际文件名和目录判断，不按显示标题。大小写或多个候选造成歧义时不合并，并给出提示。
- 新建子页面只在 `A/` 中建文件，不修改 `A.md`。
- 文件名中的非法字符由 Main 统一处理，包括跨平台非法字符、控制字符、末尾空格或点、保留设备名、空名称。不允许路径分隔符和 `..`，也不允许借符号链接越出目标目录。

## 4. 状态与回执

### 4.1 草稿

- 状态流转：`editing → finalizing → finalized`，以及 `editing → discarded`。基础磁盘版本发生变化时，任何状态都转为 `conflict`。
- 重启时，没有对应标签的 `editing` 草稿列为"待恢复"。
- 确认回执是 `{ draftId, revision, contentHash }`，在 ready.db 提交并回读之后才返回。旧的确认不能把更新过的正文标为已保存。
- 空字符串草稿和"没有草稿"是两种不同状态。
- 现行的 Renderer 草稿只做一次迁移：用稳定的迁移键和内容哈希导入，导入结果回读一致后才删除旧数据。迁移完成后，生产代码只从 Main 恢复草稿。

### 4.2 保存到…（定稿）

1. 持久保存草稿和定稿意图：操作 id、父对象、目标文件名。
2. 预留目标文件名。重名时返回候选名称；提交时再检查一次，绝不覆盖已有文件。
3. 发布文件和附件，逐项回读。
4. 由对象服务登记身份，并确认索引。
5. 更新画板文档卡并回读。这一步在 M4 实现，消费者接好之前不显示这个选项。
6. 返回回执：`{ operationId, draftId, revision, objectId, path, contentHash, parentObjectId }`。

同一个操作 id 重试，返回的是同一个文件。任何一步失败，草稿都要保留。

### 4.3 页面操作

- 新建、改名、移动、回收、恢复，每个都是一次持久操作。
- `A.md`、`A/`、`A.assets/` 三者一起成功；失败时一起回滚，或进入可恢复状态。
- 全部完成后，统一发布一次变化通知（带对象 id 和修订号），再修复引用。
- 删除之前，先持久保存未保存的缓冲内容；保存失败就不删除。
- 恢复默认回到原位置。原父目录已不存在或出现重名时，要求用户另选位置，不覆盖。
- 回收站里的内容不进入普通索引，也不会被扫描器重新当作活跃页面。

### 4.4 编辑缓冲与保存

- Renderer 拥有当前的编辑缓冲，Main 拥有持久保存的状态。
- 撤销和重做由文档缓冲统一管理，不按块各管一套：
  - 一次拖动、拆分或粘贴是一条历史记录；
  - 一次输入法组合输入不拆开；
  - 外部修改也经过同一个缓冲入口；
  - 历史与当前版本不一致时，保留内容并明确报告冲突。
- 普通保存、首次保存、草稿定稿都走同一条带回读的写入流程。
- `merged_dirty` 只表示修改已进入缓冲，不能显示为"已保存"。

## 5. 验收合同

| 合同 | 内容 | 测试与入口 |
| --- | --- | --- |
| C4 Markdown 保真 | 在黄金语料（§5.1）上执行真实的编辑命令，然后比较 UTF-8 字节：<br>• 目标块按预期变化；<br>• 其他片段逐字节不变；<br>• 撤销后恢复原字节；<br>• 失效版本、失效区间、相互重叠的多区间都被拒绝。<br>不能用"解析后再序列化"的结果当作预期答案。 | `src/__tests__/ready-markdown-roundtrip.test.ts`，夹具放在 `src/__tests__/fixtures/ready-markdown/` |
| C12 草稿与层级 | 同整合计划的 C12；画板文档卡部分在 M4 验收。 | `src/__tests__/ready-draft-hierarchy-native.test.ts`；`scripts/verify-ready-next-draft-restart.mjs`；接入 `npm run verify:native` |
| M3-P1 页面树 | 用临时资料库导出的页面树与实际文件一致，覆盖合并规则、歧义、排除 `.ready/`；没有根目录时，不发出任何目录读取。 | `src/__tests__/ready-page-tree.test.ts`，包含 Renderer 在没有根目录时的行为 |
| M3-P2 页面操作 | • 新建子页面时父文件不动；<br>• 改名、移动后三件套一致，对象身份不变；<br>• 回收后不进入普通索引；<br>• 恢复回到原位，重名不覆盖；<br>• 中断后重试不会重复。 | `src/__tests__/ready-document-pages-native.test.ts`；接入 `npm run verify:native` |
| M3-E 编辑器 | 用真实组件完成输入、拆分合并、拖拽、粘贴多块、撤销，之后检查 Markdown 字节。Widget 和 Mermaid 块只整体替换各自的源码区间。 | `src/__tests__/ready-block-editor.test.tsx` |
| M3-T6 公共接线 | 真实页面头部、编辑器、草稿控件与标签 store 完成新建、改标题/图标、块输入、源码往返及撤销、保存和草稿存为子页；源码/书本/资料库外不展示页面头部；页面、文件和 ReadyRef 复用对象标签。拖拽只预选保存位置，确认前不发布文件，取消保留草稿。 | `src/__tests__/ready-next-m3.test.tsx`、`src/__tests__/untitled-doc-tab-save.test.ts`；真实窗口 `scripts/verify-ready-next-m3.cjs` |

### 5.1 黄金语料

语料要保留真实换行，不经过格式化工具。每份语料包含原文、要执行的操作和预期结果。至少覆盖：

- **来源与 frontmatter：** Obsidian 和 Notion 的导出；YAML 中的注释、引号、多行值。
- **换行与编码：** CRLF、LF、混合换行、BOM、文件末尾没有换行。
- **文字：** 中文、Emoji、组合字符、重复段落。
- **链接：** Wiki 链接、嵌入、块引用、相对路径。
- **结构：** 嵌套列表、任务、引用、callout、分栏（§3.1，包括格式需修复的情况）。
- **特殊块：** HTML、Widget、Mermaid、长围栏、表格。
- **拒绝情况：** 失效版本、失效区间、相互重叠的多区间、空文档。

## 6. 文档书本模式与书房的分工

| 文档书本模式 | 书房 |
| --- | --- |
| 当前文本或 DOCX 编辑缓冲的只读阅读方式 | 导入电子书后的专用阅读入口 |
| 定位用文档块、源码行和块内位置 | 定位用章节、书内位置和标注 |
| 按原文块做 CSS 分栏测量 | 测量章节 HTML，切分页面，生成目录和书籍前后页 |
| Widget 只显示静态投影 | 为书籍排版和阅读标注服务 |
| 不修改正文，也不另存一份书的正文 | 不接管普通文档的编辑缓冲 |

两边都不能新增与对方重叠的用途。不要为了共享几段测量代码而建立通用分页框架。

## 7. 任务与顺序

| 任务 | 内容 | 依赖与并行 |
| --- | --- | --- |
| T1 原文区间与编辑命令 | 新建 `src/shared/document-blocks/`，扩展 `document-operations` 的多区间操作；单块行内输出；撤销基础；C4 黄金语料 | 依赖本合同。可与 I2、R1、L4 并行。 |
| T2 页面树、页面操作、可靠保存 | 新建 `src/main/modules/document-pages/` 和 `src/shared/document-pages.ts`；为对象服务增加 `trashed` 状态和"三件套"操作组；统一用户保存的回读流程；M3-P1 的 Main 部分和 M3-P2 | 依赖 T1 的操作合同。对象服务的公共文件要等 R1 合入后再改。 |
| T3 Main 草稿与迁移 | 新建 `src/main/modules/document-drafts/`、`src/shared/document-drafts.ts` 和 Renderer 的草稿接入；修改关闭标签的语义；完成 C12 中与画板无关的部分 | 改 `useDocTabs.ts` 要等 I2 合入；数据库和协议部分可以先做。 |
| T4 块编辑界面 | 新建 `src/renderer/modules/document/block-editor/`；接入 NotePreview 和 MarkdownEditor；退役旧的预览写入路径；M3-E | 依赖 T1、T3 的缓冲保存接口，以及 L4 的引用卡与共享打开函数。 |
| T5 页面侧栏、页面头部与保存选择 | 新建 `src/renderer/modules/document/page-ui/`；修改 FilesPanel、FileTree、useWorkspace；修复没有根目录时列出 `/` 的问题 | 依赖 T2、T3。 |
| T6 公共接线与 M3 验收 | 修改 DocumentMode、preload、electron.d.ts、迁移登记、检查入口；编写 `scripts/verify-ready-next-draft-restart.mjs`；真实窗口验收 | 在 T1–T5、I2、R1、L4 全部完成之后。 |

公共文件同一时间只交给一个任务：
- preload、electron.d.ts、migrations.ts 按任务顺序串行修改；
- 新增的模块目录归各自任务独占。

## 8. 交付状态

- 2026-10-31：本合同冻结。T1（区间内核与编辑命令，C4 黄金语料）与 T3a（Main 草稿服务，迁移 140）完成并合入 ready-next；T2、T3b 开工。

### T6 公共接线与总验收（2026-10-31）

T1–T5、T3c、T4a/T4b 已合入。本次完成公共接线，**M3 总验收仍待真实窗口证据与下列范围外检查问题解除**。

- 页面头部接在资料库 Markdown 页面预览正文上方，源码、文件视角、书本及资料库外不显示。头部修改前保存脏正文，失败不继续写属性；页面变化由既有对象/页面通知刷新。
- 文档加载、保存及源码编辑仍由 `MarkdownEditor` 承担，预览编辑使用已合入的 `ReadyBlockEditor`；共用现有缓冲与历史。本任务没有修改块编辑器内部或 `verify-ready-next-block-editor.cjs` 的断言。
- 草稿、未命名标签拖拽和页面移动使用同一 `SaveToPicker`，旧草稿对话框及拖拽自动挑名逻辑删除。拖拽预选位置，等待确认回执；旧选择器完成不能关闭新请求。位置树刷新不重置正在输入的标题。
- 新增 `verify:ready-next-m3`：`--cli` 运行真实组件/store、真实页面/草稿服务、临时 SQLite 与文件的综合流程；不带参数在相同检查之后运行隔离窗口八步流程，每步保存文件/草稿回读与截图。窗口脚本本次只通过语法检查，不能算窗口验收通过。
- 文档书本模式与书房按 §6 保持独立，已在 `DocumentMode` 注释及运行时合同 §7 同步；没有新增互相接管缓冲或分页的入口。

命令行证据（日志位于本机 `/tmp/ready-m3-*.log`，临时证据不作为持久报告）：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | web/node 均通过 |
| `npm run verify:ready-next-m3 -- --cli` | 14 pass / 0 fail / 0 skipped；覆盖新建、头部标题/图标、块输入、源码往返/撤销、脏正文先保存、子页定稿、移动及三个打开入口去重 |
| `npm run test:ready-next-pages` | 12 pass / 0 fail / 0 skipped |
| 草稿/页面原生与块编辑专项，Electron `--import tsx --test --test-concurrency=1` | 102 pass / 0 fail / 0 skipped（draft-hierarchy、document-pages、draft-tab、drafts-controller、block-editor-save、block-editor、block-editor-interactions） |
| `verify:widget-ready` 同批测试替代执行 | 163 pass / 0 fail / 0 skipped |
| `verify:document-reading` 同批行为测试替代执行 | 66 pass / 0 fail / 0 skipped；typecheck 通过。其窗口图片排版脚本未执行，交 Claude |
| `verify:document-perf` 夹具生成与同批测试替代执行 | 173 pass / 1 fail / 0 skipped；范围外的 `document-preview-performance-contract.test.ts` 导入 database.css 无加载器。仅补临时 CSS 测试加载器重跑该文件：13 pass / 0 fail / 0 skipped，未改仓库中的该测试 |
| `native:check` + `verify:native` 的完整测试清单替代执行 | ABI 146 / Electron 42.3.0 通过；391 tests / 388 pass / 3 fail / 0 skipped。范围外的 calendar-layers-native、library-engine、ready-object-identity-native 文件监听测试均为 `EMFILE: too many open files, watch`，未修改这些模块 |
| IPC / CSS 层级 / 测试归属 / SQLite skip 规约 | 均通过；IPC violations=0，CSS 扫描 43 文件 |
| 改动文件 ESLint / `git diff --check` / 新脚本 `node --check` | 无错误；DocumentMode 保留两个原有未使用变量警告 |

原 npm 专项被沙箱拒绝创建 tsx 管道（`listen EPERM`），改用 `node --import tsx --test`；需要 SQLite 的同批清单改用 `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx --test`。沿用已安装的原生依赖，不重新安装或重编。

允许范围之外的两处消费者仍需后续同步，本次未改：
- `scripts/verify-ready-next-draft-restart.mjs` 仍找旧对话框的“草稿标题 / 选择文件夹 / 确认保存”；应改为新选择器定位。新的 M3 窗口脚本已使用新界面并包含强制退出恢复。
- `src/renderer/components/layout/FileTree.tsx` 将所有非 not-untitled 返回显示为失败通知；现在用户取消拖拽保存会显示“保存失败：已取消保存，草稿已保留”。应将 cancelled 作为正常取消且更新旧的“直接落盘”注释，不能为绕过该消费者伪报保存成功。

`DocumentMode.tsx` 1175 行、本次净 +9，仅做接线；健康度“一般”，已登记 2026-11-30 复查。未执行提交、推送、切分支或安装依赖，未访问日常 Ready 数据。
