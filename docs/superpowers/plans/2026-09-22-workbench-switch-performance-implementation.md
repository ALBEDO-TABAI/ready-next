# 四模块切换卡顿：安装版诊断与修复计划

> 日期：2026-09-22；状态：修复已安装，用户确认明显改善并要求提交收尾；`enforce: true`。
> 首轮为安装版诊断；用户随后授权修复。下方保留修复前证据，末节记录实施与验收。

## 1. 结论

已确认两条叠加原因：RSS 全量页面负担，以及切换时对长会话/技能目录的重复同步读取（补充证据见 §7–8）。其中 **RSS 一次挂载全部 5506 条记录，形成 192713 个 DOM 元素**。四模块使用同一个 Renderer，RSS 从隐藏变可见或退出时，大列表的样式计算、合成提交占住主线程，其他模块也必须等待。

文档离场保存滚动位置的同步几何读取是一个已抓到的触发点：页面刚切换就读取 scrollTop / scrollHeight / clientHeight，迫使浏览器立即计算包含 RSS 的整棵页面。它放大了大列表的成本，但不能用删掉阅读位置保存来代替修复。

**优先方案：RSS 只挂载视口附近的条目；文档离场使用已采集的阅读位置。保留四模块驻留与原生浏览器交接，不重写工作台、不改数据库、不缩短动画掩盖阻塞。**

## 2. 当前安装版证据

- 目标：`/Applications/Ready.app`，版本 0.8.0，app.asar 修改时间 2026-09-15 17:18；进程 1319，工作台 Renderer 2195，启动于 2026-09-19。
- app.asar SHA-256：`793d42ffd345729fa101d3e6358774f4dc152fd9df4b52740ef277cf9c820e7e`。
- 安装版 `App-CVBxFXtZ.js` 与本地 `out/renderer/assets/App-CVBxFXtZ.js` 字节一致；另核对安装版 RSS、Document 编译入口与下述源码调用链。当前源码这三个相关文件最近改动为 2026-09-10 的 `1e9585c3`。
- 当前页面共 199405 个元素：Browser 160、Document 799、RSS 192713、Calendar 257，其余为聊天和工作台。RSS 隐藏时是 `display:none`，元素仍全部保留。
- 通过安装版 DevTools Performance、Long Task / Long Animation Frame 观察器和模块状态属性采样；没有重启、刷新页面或清空历史。记录时未启用降速，未采集截图或资源正文。

### 实测对照

| 场景 | 结果 | 解释 |
|---|---:|---|
| 文档 → 日历 | entering → current 297 ms | 接近既定 280 ms 动画和收尾 |
| 文档 → 浏览器 | entering → current 308 ms | 该次不包含 RSS 离场 |
| 浏览器 → 日历 | 点击 → current 433 ms；entering → current 310 ms | 原生交接加动画，未出现秒级阻塞 |
| 日历 → RSS，原始 5506 行 | entering → current 2235 ms | 连续长任务 770 / 1267 / 220 / 708 ms |
| 仅临时隐藏第 31 行以后，日历 → RSS | entering → current 382 ms | 仍保留全部数据和 DOM，仅减少参与布局的条目 |
| 同一临时条件，RSS → 日历 | entering → current 396 ms | 退出同样恢复到接近动画耗时 |
| 移除临时样式，再次日历 → RSS | entering → current 2111 ms | 长任务重新出现：772 / 1214 / 669 ms |
| 原始 RSS → 浏览器 | 点击 → current 1362 ms | 进入浏览器也会被 RSS 离场拖住 |
| 安装版 rss.getItems，连续三次 | 26 / 25 / 24 ms；均返回 5506 条 | 当前数据规模下，秒级成本不在本地读取 |

计时边界：`entering → current` 是模式状态变化到页面恢复正常交互资格，不等于每次点击的完整响应时间。长任务包含部分状态变为 current 之后的工作。表中不是统计 P95，也不宣称覆盖了所有 12 个方向。DevTools 停靠会改变可用窗口宽度；A/B/恢复对照使用同一尺寸。

对照只证明大量条目参与布局是主因；临时 CSS 不是修复，不具备完整滚动访问能力。测试后已移除，回读仍有 5506 行。

### 性能轨迹里的具体阻塞

- 最长 `UpdateLayoutTree`：**763.984 ms，elementCount=199056**。
- 强制布局栈：Document 编译入口 `findCurrentScrollElement` → `captureDocumentScrollScope` → `captureVisibleDocumentScrollPositions` → effect cleanup → React passive unmount / commit。
- 随后的 `Commit`：**1257.205 ms**；所在主线程任务 **1360.561 ms**。
- 49.13 秒轨迹总览：Rendering 3692 ms、Painting 2018 ms、Scripting 1081 ms。不能把所有耗时概括成 React 重渲染；浏览器样式与图形提交是已测出的主要尖峰。
- 本地原始记录：`/tmp/ready-switch-audit/Trace-20260922T150322.json.gz`；系统采样同目录。原始记录留在本机，不加入 Git；临时目录可能被系统清理，关键测量已记于本文。

## 3. 根因链与影响边界

1. `src/main/modules/database.ts:754` → `rss-engine/ipc/item-group.ts:85` → `rssWarmLoader.ts:14`：读取完整可见/收藏列表。
2. `src/renderer/components/rss/RSSFeed.tsx:1113`：对 filteredItems 全量 map。行组件虽然 memo，且第 319 行使用 contentVisibility:auto，但这不限制 DOM 数量，也未阻止实测的样式与合成成本。
3. `src/renderer/components/layout/WorkbenchModeOutlet.tsx`：默认四模块全部挂载，切换时旧、新场景同时参与过渡；`styles/ritual-overlay.css:241` 控制显隐和动画。保持状态本身合理，问题是被保留的列表没有规模上限。
4. `src/renderer/pages/modes/DocumentMode.tsx:545-614`：失活 effect 和滚动监听 cleanup 都可能同步采集位置；`documentScrollRuntime.ts:166` 通过几何读取寻找滚动目标，在切换提交中触发全页计算。
5. `RSSMode.tsx:282-312` 每次进入应用缓存后再刷新；`applyRSSSnapshot` 替换列表，`handleMarkItemRead` 依赖 items，又参与行 memo 比较。它增加更新工作，是次级放大因素；没有证据要求另建缓存、数据库分页或后台同步系统。

补充边界：初次观察有较高空闲 CPU，控制台也有历史 mode-switch-ack-timeout。它们不能直接当成这次秒级卡顿的独立根因。随后浏览器 → 日历复测有回执，点击到状态提交 123 ms、到 current 433 ms。保留 hide-all + 匹配回执合同；不延长超时、不加重试，也不把所有卡顿归为浏览器交接。

## 4. 最小实施顺序

### A. 先限制 RSS 实际挂载行数

- 只在 RSSFeed 的滚动列表引入视口窗口：可见行加有限缓冲，其他行用占位高度表示；支持现有可变行高、缩放与分栏尺寸。
- 全部数据继续可筛选、可定位、可滚动访问；保留选中项、滚动锚点、拖拽、已读/收藏/删除和分析状态。禁止用截断前 N 条、删除历史或固定错误行高换取速度。
- 保持 RSSMode、预览、后台刷新与现有 store 所有权；不把四个模块改成每次销毁重建，不新增全局列表框架。
- 先单独实测此改动。只有新轨迹仍显示数据替换/回调变化有显著阻塞，才在原组件中稳定引用与减少无变化更新；不预先扩展后端协议。

### B. 消除文档离场的同步几何采样

- 在当前可见滚动容器的滚动/阅读交互中维护位置快照；只读取该容器，不全局搜索其他文档场景。
- 离场、监听 cleanup、pagehide、退出时保存最后有效快照，不在新模块已进入之后重新寻找并测量隐藏容器。
- 保留最后一次滚动未过 220 ms 就立刻切走、顶部位置、长文锚点、双文档与书籍阅读的正确性。不能简单删除 flush 或延迟到隐藏后采集。
- 不建立第二份持久位置账本，继续使用现有阅读位置存储。

### C. 同一包体完成复测

- 用安装版当前相近的数据规模和窗口大小复测；另用隔离的 10000 条合成数据验证上界。
- 改源码、测试、构建、安装候选及真实交互分别记录。源码检查通过不代表当前安装版已经解决。

## 5. 实施前先写的可执行验收

1. 通过真实 RSSFeed 渲染 10000 条夹具：在 768 px 高度下同时挂载条目不超过 80；滚到末尾能访问最后一条，切换再回来保留锚点。窄宽度、长标题、筛选后回滚均无跳位或空洞。
2. 验证未读/收藏筛选、选择、单条操作和分析状态在窗口移进移出后仍作用于正确 ID；不发起真实外部分析任务。
3. 文档滚动后不足 220 ms 立即切走，再返回/重开：位置正确；失活和 cleanup 不读取隐藏容器的 scrollHeight/clientHeight，不覆盖有效快照。
4. 保留 Browser hide-all 回执和快速连点最后选择生效的行为验证，覆盖 Browser 分栏显隐；不能因提速出现原生网页压住其他页面。
5. 实机测全部 12 个切换方向，每方向至少 5 次，单列首次进入：热切换点击到可交互 P95 ≤ 500 ms，且无切换相关 > 100 ms 主线程任务。超过阈值继续查看新轨迹，不能只缩短动画或放宽阈值。

执行检查：`npm run typecheck`、`npm run verify:workbench-performance`、受影响 RSS 行为与 document-scroll-anchor 测试；阅读位置持久化变更须跑 `npm run verify:native`。更新对应 §1 运行时合同，不重写无关文档。代码文件净增行数时按现有规则检查大文件健康记录。

现有 workbench 性能 gate 主要覆盖浏览器标签引用、原生 host 与 bounds；RSS 行比较测试只证明比较函数。它们没有覆盖数千条真实列表在 Electron 的布局/合成成本，这就是已有优化仍漏掉本次问题的验收缺口。


## 6. 实施与数据增长判断

- RSSFeed 现在使用项目依赖树已有的 rc-virtual-list 3.19.2（声明为直接固定依赖），只挂载视口内条目；按实际行高测量，隐藏时保留最后有效视口高度。旧 `contentVisibility` 延后绘制方案退出该列表。
- 真正滚动容器继续暴露 RSS 玻璃面板的 source 标记；筛选切换重置列表窗口，刷新通过条目 ID 保留滚动锚点，远程选中的未挂载条目可定位进入视口。
- 文档滚动事件先采集轻量位置，停下 220 ms 后再补充章节锚点；离场和退出仅冲刷已采集值。手动切换编辑模式/文档前仍可主动采集，查找限定在所属 Document 根节点。
- 新行为检查加入 `verify:workbench-performance`：10000 条真实 RSSFeed 的挂载上界、末尾访问、正确条目收藏、收藏筛选、隐藏后恢复，以及滚动后立即离场不读取隐藏几何。
- 数据增长核对：当前 RSS 5506 条，标题/摘要/链接合计 656062 个字符，摘要最长 498 字符；`dbstat` 显示 rss_items 表 1638400 字节，rss_sources 表 4096 字节（不含索引）。已有 upsert 按稳定 ID 去重；新条目会继续积累。
- 本轮实现渐进显示，不声称数据库已经分页读取。现有全量读取实测 24–26 ms，暂不改读取协议。压缩约 1.6 MB 的表无法解决页面卡顿，且会增加查询/解压路径。未自动删除、截断或压缩用户历史；如果以后实际查询/传输成为瓶颈，再基于新测量引入数据库分页及全量计数，不能把已加载页数当成总数。
- 已通过：类型检查、19 项 workbench 专项、18 项滚动/行比较/交接检查、6 项 RSS 外观/布局合同、181 项 native 检查（无 skip）、CSS 层级检查、版本同步、生产构建。源码与安装证明分开，安装验收结果另补。


## 7. 用户回测后的第二根因（首轮安装未闭环）

用户明确报告：RSS → Calendar 长时间卡住，再切 Document / Browser 继续卡。第一轮 10000 条空白会话测试不能覆盖这一场景，不作为整个问题关闭依据。

- 安装版 `e3bdd82e…` 中 RSS 已降为 384 个元素，真实聊天区仍有 5379 个元素。Renderer 轨迹没有对应秒级计算，但同一轨迹中的 **Main** 有 5900.3、6006.8、6264.7、6503.2 ms 的同步任务。
- 原始证据 `/tmp/ready-switch-audit/Trace-20260922T155907.json.gz`。必须检查进程 55623 的 ProfileChunk，不能只看 Renderer 的 INP。
- 栈一：`readProductTurnPresentations → readProductTurnActionContext → resolveHeadContractBlocker → resolveDefaultContinuation → skill/tool surface resolution → listCustomSkills → loadCustomSkill → getManagedCustomSkill → listManagedCustomSkills → readFileSync`。N 个技能的列表读取触发 N+1 次完整目录扫描。25 个技能夹具实测 26 次，修复后 1 次；用户真实 27 个技能修复后热读 7–8 ms。
- 栈二：每条历史回复分别重复读取同一个当前 head、未消费输入尾、生命周期与 coverage。长会话会反复解析相同的较大 ingress JSON。
- 修复：SkillLoader 列表直接编译已经读出的记录，不再次查整个目录；历史回执批读在既有同一 SQLite 读事务中，按 `head thread binding + trusted workbench mode` 共享 head 读取结果。每条历史自己的 owner/source/origin 校验继续独立执行。
- 共享范围只限一次同步批读，下一次读取重新计算；不把展示快照用于 action admission，不加跨请求缓存，不跳过授权或历史事实核验。原生测试逐条读取与批读结果深度相等，批内 head resolver 一次，下一批再次调用。
- 新增/补充行为测试先在旧实现失败（目录扫描 26≠1、head resolver 2≠1），修复后通过；181 项 native 检查再次通过，无 skip。最终安装验证尚待完成，不能沿用首轮合成数据结果宣称真实长会话已流畅。


## 8. 连续点击的剩余排队与收口

第二包 `43c1e613…` 的真实界面过渡为 RSS 456 / Calendar 336 / Document 333 / Browser 392 ms，但旁路只读 IPC 仍观察到 495–949 ms 等待，快速连点也仍有排队，故不以单次过渡变快宣告完成。

进一步修复：纯模式刷新先读取 Main 当前 head；精确 head 不变且 Main 已明确签发来源不可重试阻断的旧回执，只保留旧版本下界，不再全量读取正文/工具。它们仍被旧模式检查隐藏，绝不复用来开放操作。可恢复的模式阻断、未知结果、新 head、记忆/任务更新与会话加载仍完整读取。现有 hydration 队列携带 modeOnly 标记，任一完整失效会覆盖模式优化。Lifecycle 查询改为只取其实际需要的状态列，避免为状态查询搬运所有历史的 ingress 大文本。

新增失败→通过检查覆盖：纯切换不重读不可重试旧记录；旧模式投影不能开放动作；记忆变化即使 head 相同也完整重读；新 head 不能复用旧阻断。全部原有模式往返、晚到旧回执和版本下界检查保留。


## 9. 最终交付与用户验收

- `/Applications/Ready.app` 已更新并正常启动，版本仍为 0.8.0。最终 app.asar SHA-256：`4534e9e8aa538072e6314e1bb5976099de737a906e431d8c8e0e753750765580`。
- 已核验签名，以及包内全部 136 个 out 应用资源与测试构建输出逐字节一致；空 seed 未导入额外账号配置。原有 5506 条 RSS、收藏/已读计数、会话与标签保留。
- 用户真实长会话、文件侧栏、双浏览器页面环境下，最终普通序列点击到页面过渡结束：RSS 415 ms、Calendar 334 ms、Document 339 ms、Browser 398 ms；再次操作为 415 / 336 / 333 / 399 ms。快速连点最终落点为 Browser，没有留在中间模块。
- 后台只读 IPC 仍可出现数百毫秒往返，未达到早期计划中所有线程都小于 100 ms 的理想指标；不把视图结束计时或空白会话测试冒充主进程完全无阻塞。用户在实际使用后明确反馈“我用着好多了”，要求 commit 并结束，本轮据此收尾。
- 最后变更后：30 项 action-surface/回执检查、18 项 scope 检查、181 项 native 检查、类型检查和生产构建通过。此前 RSS 窗口/滚动位置/技能目录、44 项技能与动作专项、签名和安装资源核对的证据仍有效。无测试 skip 作为通过。
- 临时页面诊断监听已移除，开发工具已关闭。没有清空历史、压缩正文或自动删除旧 RSS。原始诊断与中间应用备份留在本机 `/tmp/ready-switch-audit/`，不进入提交。
- 本节为安装验收后补记；包内源码清单保留构建时快照，补记未改变业务代码或包体。
