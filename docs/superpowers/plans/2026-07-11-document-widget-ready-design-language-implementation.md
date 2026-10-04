> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# 文档 Widget Ready 设计语言与图谱骨架实施计划

> 日期: 2026-07-11
> 状态: implementation
> enforce: true
> 范围: 文档模式信息卡/widget 的设计语言统一（Ready 点阵理性）、图表引擎点阵化、关系图/流程说明图一等公民化、映射降级修复。

## 1. 背景与目标

用户诉求：文档模式生成的信息卡/图表要有 Ready 设计风格；架构更好、效率更高；覆盖更多需求形态（人物关系图、科普流程说明图等）。

诊断结论（全链路证据）：

1. **两套编译系统并存**：生成/插入走 OpenUI 21 组件编译器（`src/renderer/modules/agent/document-actions/execute.ts:125` → `document-widget-openui.ts` `compileByComponent`），编辑抽屉走 9 骨架编译器（`WidgetEditDrawer.tsx:152` → `document-widget-skeletons.ts`），中间靠 `document-widget-skeleton-mapping.ts` 适配。
2. **风格脱节的根因**：App 主题 `theme-tokens.css` 本身就是 Ready 令牌信源（`--color-ready-orange:#FF4B2B` :79、`--font-mono` :5、暖纸白/hairline 全套），但 widget 层没有消费——`widget-css-bridge.ts:46` 把 accent 错接到 `--color-blue`；两套编译器内部硬编码 Tailwind 冷灰蓝 pastel（`WIDGET_RAMPS` 六色、`#0f172a`/`#2563eb`/`#e2e8f0` 等），并使用饼图/彩虹/emoji 图标——均违反 Ready 图表纪律（参考 `assets/embedded-skills/ready-human-touch-card/references/style-ready.md`、`dot-charts.md`）。
3. **图类需求二等公民**：`relationship_graph` 组件存在但骨架映射缺 case（编辑抽屉直接失败）；`flow_diagram` 映射降级成 `vertical_timeline`（图结构丢失，`skeleton-mapping.ts:77`）；`chart_focus` 的 `stacked_bar`/`scatter` 在 enum 中但静默降级成 bar（`skeletons.ts:402-406`）。
4. **效率**：结构化管线一张卡 2~3 次串行 LLM 调用；schema 不合法触发 reprompt 追加一次。确定性编译覆盖面越大、prompt 两套词汇越一致，reprompt 与 freeform 兜底越少。

目标（本计划交付）：

- T1 设计令牌单一来源：两套编译器 + iframe 基线 CSS 同源消费 Ready 令牌；accent 收敛为品牌橘红，标签/数字走 mono。
- T2 图表引擎点阵化：单 accent + 退避灰、unit 图例 + 真值直标、禁饼图/彩虹/emoji/双轴；`stacked_bar`/`scatter` 真实现，新增 `hbar`/`waffle`。
- T3 关系图/流程说明图一等公民：共享渲染器 + 新骨架 `relation_map`/`process_flow`，生成与编辑两路同源；映射不再降级。
- T4 不改 LLM 调用结构（insight+draft 管线保持），效率收益来自：确定性覆盖面扩大（图类不再落 freeform）、prompt 词汇对齐减少 reprompt、共享类样式缩减 widget_code 体积。

非目标（显式出圈）：两套编译系统的最终合并、骨架仲裁接入生产管线（`pipeline-locate-skips-arbitrate.test.ts` 合同保持）、导出/预览双 runtime 统一、LLM 管线阶段结构调整。

## 2. 设计决策

- **D1 令牌层**：新建 `src/shared/document-widget-theme.ts`：亮/暗两套 hex 令牌（源自 style-ready.md 与 App theme-tokens）、图表三色（`dc-on:#FF4B2B` 亮暗恒定、退避灰/未填充灰分亮暗）、radius 16/18/12/pill、字体栈。导出 `widgetVar(name)`（`var(--widget-x, fallback)`，令编译产物脱离 bridge 也可渲染）与 `buildWidgetBaseStyleCss()`（`.title/.label/.num/.badge/.dot/...` 类层）。`widget-css-bridge.ts` 改为消费该模块：accent→`--color-ready-orange`、透传 `--font-mono`、注入图表变量与类层。
- **D2 ramp 兼容收敛**：`RAMP_IDS` 枚举保留（存量 spec 兼容），语义重映射为 Ready 色调：`emerald→ok`、`amber/rose→accent-soft 暖染`、`indigo/sky/slate→neutral`。橘红预算由编译代码执掌（状态点"进行中"、hot 项、delta 强调），模型/用户选色只影响 neutral/ok/accent-soft 三档，无法造出彩虹。
- **D3 图表纪律进代码**：`pie` 作为输入保留接受，渲染端改为合规比例形态（单值→waffle，多值→按值排序 hbar + 百分比直标）；`accent` 数据项字段接受但忽略。调色经 dataviz 校验脚本验证（#FF4B2B 于 #F6F5F1/#FFFFFF/#202124 三面全 PASS；退避灰按救济规则强制直标+图例）。
- **D4 关系图身份表达**：连线身份 = 标签 chip + 线型 + 图例，颜色只作强调（emotion/主角=accent；alliance=ok；其余墨灰阶+线型区分）——遵守"无第二 accent"且色觉安全（身份从不只靠颜色）。
- **D5 流程说明图**：纵向编号步骤（mono 两位数字标）+ hairline 导轨 + 可选分支 chips（decision 节点）+ 可选 outcome 卡；纯 HTML/CSS 确定性布局，模型只给 steps/branches 文本。openui `flow_diagram`（nodes/edges）在共享渲染器内确定性转换（出度≥2 的节点展开为分支），不再摊平成时间线。
- **D6 新骨架不设触发词**：`relation_map`/`process_flow` 与 A-G 同级自由使用；freeform H1/H2 触发词合同不变。

## 3. 工单

- W1 令牌层与基线：`document-widget-theme.ts`（新）、`widget-css-bridge.ts`、`tiptap.css` widget 卡壳（外投影→hairline+内高光，上限 0 1px 3px）。
- W2 点阵图表引擎：`document-widget-dot-charts.ts`（新）；接入 `skeletons.ts` chart_focus（schema 扩展 `type+=hbar/waffle`、datum `x?/parts?`、`unit?/hot?`）与 `openui.ts` bar_chart/line_chart。
- W3 关系图共享化：`document-widget-relation-graph.ts`（新，自 openui 提取 + Ready 化）；openui 委托；新骨架 `relation_map`；映射补 `relationship_graph` case。
- W4 流程图共享化：`document-widget-process-flow.ts`（新）；openui `flow_diagram` 委托；新骨架 `process_flow`；映射改指向（去时间线降级）。
- W5 存量骨架与 openui 编译 Ready 化：ramp→tone、标题 600、mono 标签/数字、状态点语义（橘=进行中/绿=完成/灰=未开始）、去 emoji 图标、冷灰蓝硬编码→`widgetVar()`。
- W6 提示词对齐：骨架清单动态数量 + 新骨架条目；`widget-guidance.ts` flow/relation 家族提示更新；风格基线补 Ready 纪律一句（单 accent/点阵/禁饼图彩虹）。
- W7 合同与生成物：测试更新+新增（见 §4）；重跑 `scripts/generate-document-widget-openui-artifacts.ts` 刷新 docs 生成物；抽屉字段表补两骨架最小条目；CLAUDE.md/AGENTS.md §4 widget 句同步；CHANGELOG；大文件健康度台账复核。

## 4. 机器可验证合同

新增 `src/__tests__/document-widget-ready-theme.test.ts` + 更新既有测试，断言全部为行为断言（编译输出/映射结果）：

- C1 令牌单源：A-G+新骨架编译输出不含 legacy pastel 十六进制（`#EEF2FF/#C7D2FE/#818CF8/#2563eb/#0f172a` 等清单）；accent 槽输出引用 `--widget-accent`；数字/标签类输出引用 mono 类或 `--widget-font-mono`。
- C2 图表真形态：`stacked_bar` 与 `bar` 输出结构可区分（含分段行）；`scatter` 输出散点 SVG（含 x/y 定位圆点）；`pie` 输出不含扇形 `<path d="M...A...Z">`（渲染为 waffle/hbar）；bar/line 输出含 unit 图例与逐项真值直标；输出不含 emoji 图标字符。
- C3 关系图一等：`mapComponentSpecToSkeletonSpec({component:'relationship_graph'})` 返回 `relation_map` 骨架 spec；骨架编译输出包含全部合法节点、跳过非法边并输出警示；openui 与骨架两路输出同一渲染器指纹（共享 class 标记）。
- C4 流程图不降级：`mapComponentSpecToSkeletonSpec({component:'flow_diagram'})` 返回 `process_flow`（非 `vertical_timeline`）；分支节点（出度≥2）输出分支结构；步骤按序编号。
- C5 触发词合同不变：`widget-skeleton-trigger-keyword.test.ts` 全绿；新骨架 `widgetSkeletonRequiresTriggerKeyword === false`。
- C6 兼容：六个 legacy ramp id 经骨架 schema 校验通过并编译成功；chart `pie`/datum `accent` 输入仍被接受。
- C7 骨架数量与清单：`WIDGET_SKELETON_IDS.length === 11`；prompt 骨架清单含 `relation_map`/`process_flow` 且数量文案与常量一致（动态生成）。

验证入口：`npm run verify:widget-ready`（= ready-theme/skeletons/mapping/openui/trigger-keyword/guidance/drawer-contract/describe-props 八个焦点测试）+ `npm run typecheck`。

> 实施完成（2026-07-11）：W1-W7 全部落地，verify:widget-ready 全绿、typecheck 绿、css 级联层 gate 绿；真浏览器亮暗双主题视觉验收通过（点阵图表/关系图连线路由/流程分支/OUTCOME 卡）。openui.ts 1561→1163 行（关系图提取共享化）。
>
> 追加 W8（2026-07-11 dogfood 修复）：模型在工具面含 insert_widget 时仍用 replaceExact 把 md 表格写进正文冒充"信息卡"——根因是 buildToolGuidance 映射表只有"交互图表/组件→insert_widget"、无"信息卡"映射。修复=映射表/骨架规则片段/info_card 家族三处硬指令 + buildToolGuidance 行为测试（verify:widget-ready 106 断言）。
>
> 追加 W10e（2026-07-12 dogfood 第七例，协同 Codex）：抽屉 portal 到 body（消除包含块/堆叠劫持导致的点击不可达，真机验收）；single_focus 补 kicker/footer schema（字段表早有、schema 缺席=编辑被静默丢弃）并 Ready 化（橘点+mono 身份行/hairline 脚注行）；卡壳混色暖化+内边距收紧。合同：kicker/footer 编译在场 + portal 源钉（158 断言）。
>
> 追加 W10d（2026-07-11 dogfood 第六例，props 可见性）：iframe 渲染与位置均已正常（widget_state 回传为证），卡仍是文字墙——根因=componentSpec 的 props 结构对模型不可见（describe 只进 docs 生成物/管线），模型盲猜出错误字段名与长 body。修复=live 指引注入 describeApprovedWidgetProps（核心七组件+命中家族）+ info_card 家族"速览必须 facts"硬指令，合同 C3b；真浏览器 A/B 对照确认卡片 chrome 正常、缺口仅内容形态。
>
> 追加 W10c（2026-07-11 dogfood 第五例，CSP nonce + 内容形态）：widget 交互预览自诞生即被 CSP 拦死——script-src 的 nonce 使 unsafe-inline 失效且全仓无盖章代码，接收器脚本静默被拒、恒降级静态回退（旧合同测试钉的正是坏状态）。修复=WIDGET_SCRIPT_NONCE 单一常量盖章三处（接收器/净化内联与白名单脚本/导出 DOM 注入），合同 `widget-script-nonce.test.ts`（含与 index.html CSP 逐字一致性），真浏览器探针验证 ready/state/resize 到达。内容形态：info_card 新增 facts 键值速览行（mono 标签 + hairline 分行）+ schema describe 引导，映射折叠同步。
>
> 追加 W10b（2026-07-11 dogfood 第四例，位置语义）：守卫/componentSpec 链路验证成功后暴露最后一环——插入位置词汇只有 append_end/after_section，"开头"不可表达且未知值被静默强转 append_end，widget 落文末而宣告称开头。修复=prepend_start 位置语义（execute.ts 纯函数 + schema description + live 指引映射）+ 未知 position 响亮报错 + 结果文案如实回报位置；合同 `document-widget-insert-position.test.ts` 挂 verify:widget-ready。
>
> 追加 W10（2026-07-11 dogfood 三次修复，全链自愈）：全链深挖（两路 Explore + 日志/run_meta 取证）确认 8 个链上问题（P1 技能 token 误选与 30min 粘滞 hint、P2 buildToolGuidance 生产死代码=硬指令从未进 live prompt、P3 守卫指令/修复文案与工具面无共享合同、P4 open-guard 死锁（openToolDefinition 在地板兜底前早绑）、P5 读写不对称、P6 完成守卫→修复死循环→无文案终因+finalText 丢弃、P7 skill_export_artifact 无确认覆写侧门、P8 目录规则不在自由循环 prompt）。修复：F1 守卫开/存工具缺失时 executor 从注册表自愈（`document_target_guard_tool_recovered` 日志，免疫收窄与早绑时序）；F2 守卫指令/修复文案对齐自动开存现实并携带 widget 硬指令（live 必注入通道）；F3 insert_widget/replace_text/replace_exact 工具 description 加禁止冒充约束（schema=模型必看通道）；F4 新增 `buildDocumentSurfaceGuidance` live 通道（以"最终工具面含 insert_widget"为事实信号注入映射+OpenUI 目录+家族基线；与 buildToolGuidance 共享唯一文案信源）接进 `agent-sdk-turn-input-assembly`；F5 `blocked_tool_error` 登记用户文案 + 9 处守卫 error 终态保留 finalText（交付复核 2 处刻意不保留）；F6 `skill_export_artifact` overwrite=true 并入 M2"覆盖即销毁"确认规则。合同：`document-target-guard-selfheal.test.ts`（守卫自愈/文案/live 通道 8 case）+ run-collector-error-copy/action-confirmation-policy 扩展 + agent-sdk-runtime 锚点测试更新至保留语义；`verify:widget-ready` 挂入新测试；C4 豁免登记。P1（技能粘滞 UX）与 P5（path-based 写工具）在 F1/F2 落地后无害化，留观察不修。
>
> 追加 W9（2026-07-11 dogfood 二次修复，floors 语义修订）：真机复现第二例——技能 selected 轮（floors=skill_selected:obsidian-web-clip + local_document_resource + current_document_context）最终面只有 8 个工具，`document_insert_widget` 物理不在场，模型在硬指令下仍只能用 `skill_export_artifact` 整文件覆写（bytesWritten 证据），markdown 表格复现，且暴露"能整文件覆写却不能插 widget"的失衡写面。修订合同：**`current_document_context`（当前打开的文档）地板从单一 `document_read_section` 升级为文档编辑面** `document_read_section + document_list/insert/update/remove_widget + document_replace_exact + document_save_tab`——用户正在其中工作的文档，任何轮（含技能 selected 轮）都必须保有精准编辑与 widget 通道；**`local_document_resource`（@提及文件）保持只读地板不变**（提及≠授写，沿用 skill-envelope 写面隔离立场）。变更点唯一：`computeCapabilityFloors` 纯函数（三个 live 消费点与 dormant parity 自动同源），`capability-floors.test.ts` 正交矩阵同步，gate `check-capability-gate-enforced-in-arbitration.cjs` 不变仍绿。

> 追加 W11（2026-07-11 全模块复审收口）：专项测试全绿后继续按生成→映射→编辑→围栏→再次更新的真实链路审查，确认六个未覆盖缺口：info_card 的 `facts` 在 componentSpec→single_focus 映射时被压成长正文；抽屉保存同时保留旧 componentSpec，形成两个会互相覆盖的真值源；抽屉仅接在已退出生产入口的 TiptapEditor，真实 MarkdownEditor 预览编辑不可达；data_table 仍有 legacy 冷灰硬编码；line 图只标最高点和末点却被合同误称逐项直标；计划板/习惯卡映射仍注入 Emoji。修复：single_focus 原生保留并渲染 facts/points，抽屉可编辑 facts；抽屉保存后只保留 skeletonSpec；真实文档预览编辑接入同一抽屉和围栏替换；表格走 theme tokens；折线逐点交错标值；映射只用状态点。新增对应行为断言。独立 userData 的 Ready 真机文档同时加载五张卡并逐张启用预览，五个 iframe、关系图脚本与流程步骤均正常；再从真实预览打开速览卡编辑，确认原有键值回填，保存后只保留 skeletonSpec 且 facts 与结构化标记不丢失。

> 追加 W12（2026-07-12 信息卡复审与真机收口）：用户截图中的“仍像表格”不是设计工作未做，而是四层实现把设计抵消了：运行时继续优先显示围栏里的旧 `widget_code`，新编译器样式只在重新保存后才出现；iframe bridge 又用应用的 `#F1F5FB/#EEF3FA` 功能蓝表面覆盖 Ready 暖纸白令牌；外层卡壳重复绘制边框/背景形成双层框；脚注未设字号，继承为 16px，反而大于 13px 的事实正文。编辑抽屉的初始化 effect 依赖父层每次重建的 `input` 对象，任意父层刷新都会把未保存选择复位；进一步审查还发现字段映射与 schema 漂移、六个色板只有三种真实语义、尺寸值只有元数据没有布局效果、部分骨架仍带 Emoji。修复：结构化 spec 成为预览与导出的运行时真值，旧代码仅回退；bridge 只向 legacy/freeform 透传应用变量，结构化 widget 固定消费 Ready 明暗令牌；两路信息卡编译共享单一构图（身份行、结论色块、响应式事实网格、12px 补充说明），外壳只保留操作栏；尺寸获得真实比例；抽屉按逻辑卡片 id 初始化并使用与 schema 对齐的专用编辑器和三种有效语气。真机在临时文档副本上修改标题/尺寸/透明背景/语气，强制父层刷新后不回跳，保存落盘并重开仍完整；用户原文哈希保持不变。同期修复三条运行暗路径：宿主主题 bootstrap 漏盖 nonce 的启动报错；结构化重编译后预览预算仍按旧缓存误判；CSP 已使原生 `onclick/oninput/onchange` 失效但接收器未转发常见带参调用。事件现改写为 `data-ready-on*` 并由 receiver 安全解析具名函数与有限参数，静态回退/HTML 导出剥净事件属性；真机点击 `switchTab(1)` 成功且控制台零报错。最终真机色值为白卡 `#FFFFFF`、暖灰 `#F0EFED`、hairline `#E8E5DE`、橘红 `#FF4B2B`。
>
> W12 验收：`npm run verify:widget-ready` 196 项（195 pass，1 项 host Node ABI skip）+ capability gate 通过；该 skip 已由同轮 `npm run build` 的 Electron ABI 146 native check 覆盖，typecheck 与 production build 全绿。亮/暗真机分别确认 `#FFFFFF/#F0EFED/#E8E5DE/#FF4B2B` 与 `#202124/#232427/#333538/#FF6345`，无 CSP、页面或卡片运行错误。

## 5. 风险与回滚

- 存量文档渲染：有 `skeleton_spec` / `component_spec` 的卡片会按当前编译器获得设计升级；只有缺少结构化 spec 的纯 `widget_code` 旧卡继续走兼容回退，避免猜测性改写。
- ramp 语义收敛后旧卡重编译观感变化：属目标内的设计统一；schema 兼容保证不失败。
- openui 生成物 docs 变更为机械再生成，diff 大但可审。
- 回滚单元：W1-W6 各自独立 revert；令牌层无消费方时为死代码不伤运行时。

> 追加 W13（2026-10-04 文档预览与信息卡视觉统一）：真实 Electron（隔离 userData）逐卡截图复审发现：预览排印仍用功能蓝（引用、链接、代码复制、标签芯片）与斑马纹表格；卡片外壳的标题+常驻按钮抢内容；文档出现 ≥4 张卡（或单卡 ≥5000 字符，关系图恒触发）时全部退化为空白“启用预览”按钮，PDF 导出还会印出这句提示；关系图 `@media (max-width:720px)` 恰好吞掉文档 720px 栏宽下的全部连线，且未指定位置的分组全部堆进中列；固定画幅（4:5/1:1/16:9）内容顶在上方、下方留大片空白；折线是阶梯状点阵、尾值被裁；流程图把分支终点重复成步骤。修复：新增 `document-widget-chassis.ts` 统一身份行/标题块/页脚，两套编译器全部改用；`document-preview.css` 只作用于 `.note-preview-shell` 的 Ready 排印（三线表、点阵引用与分隔、中文着重号）；外壳改为 figure + “FIG 编号 · 名称”图注，操作悬停浮现；`WidgetStaticProjection` 以书本同源净化 + ShadowRoot 渲染休眠态与 iframe 就绪前占位，交互卡在图注给启用入口，导出按声明式 shadow DOM 序列化；关系图改为确定性 SVG（宽版分列 + 窄版弧线，容器查询切换，标签避让）；骨架默认画幅改 `doc_block`，固定画幅用 `data-fill` 分布内容；折线沿真实线段等弧长落点；`accentWash` 令牌收敛大面积橘红；Mermaid 套 Ready 明暗主题变量。合同：`document-widget-stage.test.tsx` 以真实挂载替代旧的 WidgetRenderer 源码 grep 测试，关系图测试改钉“无脚本 + 宽版 SVG 连线数”。验收：`verify:widget-ready` 163 项、`verify:document-reading` 66 项、`verify:document-perf` 166 项、typecheck 与 CSS 级联层 gate 全绿；真实 Electron 明暗双主题原生窗口截图、书本阅读与 PDF 导出（Chromium 渲染导出 HTML，10 张静态卡全部还原）复核通过。

> 追加 W13b（2026-10-04 用户评审后的版式修订）：用户评审指出排版“不讲究”——缺少网格体现、线框过多、层级冗余、文首拥挤、结论灰底抢视觉热点，固定画幅卡把条目拉散后留大片空白。修订：基线类层新增 12 栏网格（`.grid` + `.span-N`，标签栏 2 / 内容栏 10，容器查询窄宽堆叠）与 8px 竖向节奏；`buildWidgetBaseStyleCss({ surface })` 区分文档开放式图版（无外框无底色、顶部单条 hairline、画幅不生效）与导出纸面（无描边白纸、固定画幅成组居中）；指标、对比、时间线、流程、清单、看板、周程等全部去掉外框、圆圈与大块底板，只保留网格对齐与必要的单条线；`canvas` 令牌改为极淡墨色（亮 3.5% / 暗 4.5%），`accentWash` 收到 5%；横向点条与进度共用同一节距的点行并落在标签栏网格；关系图节点与标签去描边。文档预览：顶部留白加大，首个 H1 与紧随引言组成文首并以 hairline 与正文分隔；列表、序号、任务勾选与引用线悬挂在左边距，渲染块以内边距 + 负外边距避开 content-visibility 的绘制裁剪。验收：`verify:widget-ready` 163、`verify:document-reading` 66、`verify:document-perf` 166 项与 typecheck、CSS 级联层 gate 全绿；真实 Electron 明暗双主题原生截图复核。

> 追加 W13c（2026-10-04 第二次评审）：用户澄清“卡”要保留——卡片是无描边的色块，而不是去掉外壳的开放图版；列表标记悬挂在左边距被视为对齐出界。修订：文档表面卡片改为 `--widget-doc-card` 暖灰色块（亮 #F2F1EE / 暗 #222327，圆角 16，无描边），卡内嵌板 `--widget-doc-inset` 改为比色块更浅的纸白（亮 #FFFFFF / 暗 #2B2C30），结论区因此更浅不抢热点；关系图去掉分组底板，节点改为色块上的纸白嵌块，同列关系一律向右画弧，首列与卡片正文左缘对齐。文档预览的无序/有序/任务列表与引用点阵线改为落在正文左缘的 24px 标记槽内（序号 mono 右对齐），条目文字统一从槽后起排；移除渲染块负外边距。验收同 W13b 三个 gate 全绿。

> 追加 W13d（2026-10-04 第三次评审）：卡片色块由暖米色改为与工作台外框同色的中性浅灰（亮 #EDEDED，实测外框 #ECECEC；暗 #3A3B3E），色块上的 hairline、点阵底点与退避点改用同一中性灰阶（`--widget-doc-line/rest/off`），嵌板仍为更浅的纸白。

> 追加 W13e（2026-10-04 第四次评审）：用户认为浅灰色块仍偏灰，改为液态玻璃观感。卡片玻璃面移到宿主 `.ready-doc-widget-card-preview`（iframe 无法采样页面背景），沿用聊天输入框的材质参数：白纱渐变底、顶缘 inset 高光、0.5px 极淡轮廓与柔影、遮罩成 1px 环的斜向边缘光、`backdrop-filter: blur(20px) saturate(1.4)`；暗色用深色白纱与更强的边缘光。iframe/静态投影内 `.card` 改为透明，嵌板改为极淡内凹墨色（亮 3.5% / 暗白 4.5%），点阵与线改为偏冷中性灰。卡片不叠在滚动内容上，折射无可见对象，未逐卡挂 LiquidLens，避免多卡文档的合成开销。
