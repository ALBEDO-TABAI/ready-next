---
title: Ready Next 浏览器助手提速实施计划
date: 2026-11-18
status: implemented
enforce: true
---

# Ready Next 浏览器助手提速：少等、少往返、少重复、读得全

来自 [收尾清单](../audits/2026-11-12-ready-next-open-items.md) A8：对照 agent-browser、ego lite、Lightpanda 之后，浏览器助手最该补的四项。用户 2026-11-18 决定按“连续动作 → 等待 → 结果 → 读网页”的顺序做。后台工作面（A5）不在本计划内，等用户在可见窗口确认。

## 1. 现状（都在代码里核对过）

- **一次模型往返只能做一个动作。** 固定的 Codex 运行时不允许一次回复里带多个工具调用（网关 `gateway_parallel_tool_calls_forbidden`），而每个页面动作之后模型还要再调一次观察工具才能看到结果。点一下、等一下、看一眼就是三次往返。
- **每步有固定等待。** 导航成功后无条件等 1.5 秒（`browser-act-navigation.ts`）；每次点击之后轮询 2.6 秒看有没有新标签，没有新标签时等满（`waitForActionFollowedTab`）；按引用点击时“动作后稳定”做了两遍。
- **结果重复。** 工具结果把同一份数据以排版后的文字和结构化对象各发一次（`browser-action-executor.ts`、`codex-tool-output-mapper.ts`），动作结局也有两份（`outcome` 与 `browserActionOutcome`）。
- **读网页不全。** `browser_read` 读的是纯文字，整页文字在 3 万字处截断且不提示（`automation-service.ts` 的 `getPageContent`），不带链接；正文转 Markdown 只用在界面的阅读视图里。

## 2. 合同

### Q 连续动作（`browser_sequence`）

- **Q1 只是按顺序各调用一次。** 一个连续动作就是把列出的公开浏览器工具按顺序各调用一次，输入只有 `steps`（每步是 `{ tool, args }`）。每一步与模型单独调用该工具走同一条执行路径：同样的参数校验、本轮授权、来源写入确认判断、对话框检查、动作登记与写租约、回执与观察记录；目标标签页也按单独调用的规则决定（步骤自己带 `tab_id`，否则跟随任务当前的工作标签）。连续动作做不到单独调用做不到的事，自己不登记动作、不占写租约、不改写任何一步的登记内容。
- **Q2 能放进去的步骤；整份清单先过一遍。** 只能是本轮冻结工具面里已有、且在下列清单上的工具：`browser_click`、`browser_type`、`browser_press_key`、`browser_select`、`browser_hover`、`browser_scroll`、`browser_fill_form`、`browser_search`、`browser_navigate`、`browser_wait`、`browser_snapshot`、`browser_find`、`browser_read`。不能嵌套自己；标签管理、上传、下载、对话框、状态声明、采集、归档、研究、网页自带工具和高级工具都不能作为步骤。执行第一步之前先检查整份清单：有一步不在清单上、本轮不可用、不在本轮冻结的工具合同内、参数过不了该工具自己登记的 schema，或观察步骤没放在最后（Q5），整个连续动作一步都不执行。
- **Q3 停在第一处没成功的地方。** 最多 6 步。任何一步失败、需要确认、需要用户处理、遇到对话框、引用失效、等待的条件没出现、输入没有送达页面，就停在那一步：后面的步骤不执行、不重试、不回滚；结果写明停在第几步、原因，并列出没执行的步骤。已经执行的步骤照常留下各自的记录。成败只看这一步结果里的类型化字段，不解读页面文字或旧工具的自由文本。
  - 输入是否送达读不回来、但页面已经换了文档或打开了新标签（回车提交、点链接跳转就是这样）算成功，继续。
  - 输入是否送达读不回来、也没有看到变化时，这一步记为“不确定”：之后的等待和收尾的观察照常执行，会改动页面的步骤不再执行，连续动作停在第一个这样的步骤之前。没有送达探针的悬停、滚动属于这种情况。
  - 某一步被单次工具的硬超时（60 秒）打断时，整个调用按超时处理，与单独调用一致；模型需要重新观察页面。
- **Q4 不在连续动作里弹确认。** 某一步按现有规则需要用户确认时，连续动作在这一步之前停下（不弹卡、不登记动作、不占租约），说明这一步要单独调用；确认流程本身不变。
- **Q5 结果紧凑；观察只能收尾。** 每个执行过的步骤一条记录：序号、工具名、成功与否；会动页面的步骤再带送达与变化状态、步骤结束时页面的地址，以及打开的新标签或弹出的对话框；失败的步骤带原因。记录里没有页面内容。观察步骤（`browser_snapshot` / `browser_find` / `browser_read`）只能是最后一步，它成功时结果数据原样带回一份。放在中途的观察不被接受：参数是事先定好的，中途看到什么都用不上；而且快照是相对上一次快照的差异，中途的快照不带回模型，之后的快照就会以模型没见过的内容为基准。连续动作提前停下时没有观察内容，但让它停下的那一步的结果原样带回（与单独调用这一步看到的一样），模型据此决定怎么补救，需要时自己再看一眼页面。结果的形状由 `src/shared/browser-sequence.ts` 定义，写入和读取都用它。
- **Q6 按会写页面的工具对待。** 在 `browser-capability-registry` 登记，作为公开工具名与执行边界的唯一真值；声明的效果是可入列工具效果的并集；只读窗口和最后一个观察位里与其它写页面的工具一样被拒绝；一次连续动作在回合的工具调用计数里算一次。
- **Q7 旧对话。** 工具面多了一个工具，按现有规则，升级前开始的浏览器对话下一次发消息会提示开始新上下文。不为旧对话另做兼容分支。
- **Q8 完成证据不因合并而丢失。** 收尾时，连续动作里每个成功的步骤与单独调用留下同样的工具结果证据，不论后面的步骤是否让连续动作停下。作为“读过的内容”计入来源的，只有随结果带回模型的那次收尾读取。

### W 等待

- **W1 导航。** 导航成功后不再无条件等 1.5 秒：页面可读就返回，最长仍是 1.5 秒。
- **W2 点击之后等新标签。** 等待期间出现由这次动作带出的新标签，处理不变。页面安静下来（没有在途请求，内容至少半秒没有变化，即现有 `network_idle` 的判定）就结束等待；拿不到这个信号（网络跟踪不可用、页面脚本不可执行）时保持原来的 2.6 秒上限。任何情况下都不超过 2.6 秒。
- **W3 动作后稳定只做一次。** 一次点击只做一遍动作后稳定等待。

### R 结果

- **R1 同一份数据只发一次。** 工具结果的文字如果只是它的结构化数据的 JSON 写法，发给模型时只带结构化数据，不再附一份转义后的文字。文字与数据不同的结果（文字是给人看的摘要）不变。
- **R2 动作结局只出现一次。** 页面动作的结局只以 `outcome` 出现，不再同时带一份内容相同的 `browserActionOutcome`。
- **R3 只改发给模型的内容。** 动作登记、回执、观察记录、任务面板与复核读取的 Main 侧数据不变。

目标引用的长度（约 120 个字符）这次不动：引用里编码了标签、物理页面、帧、文档和快照版本，缩短它等于换一套引用身份，单独立项。

### D 读网页（`browser_read`）

- **D1 整页读取给出带结构的正文。** 不指定目标时，返回页面当前渲染内容的 Markdown：标题、段落、列表、表格、代码保留结构，链接带地址（相对地址转成绝对地址），图片保留说明文字；脚本、样式、隐藏元素不进正文。转换在页面里一次完成，不重新请求网址，不依赖正文抽取（搜索结果、列表、应用界面同样可读）。各层子帧照旧并入，带上帧的地址。
- **D2 截断要说出来，并且能接着读。** 结果带 `totalChars`、`returnedChars`；内容超过 `max_chars` 时带 `truncated: true` 和下一段的 `nextOffset`。新增可选参数 `offset`（默认 0）从指定位置继续读。同一页面没有变化时，分段读到的内容拼起来等于完整内容。
- **D3 没有隐藏的上限。** 整页读取只受 `max_chars`（上限 200000）约束，不再先在 3 万字处截断。
- **D4 密码框。** 按选择器或目标读取命中密码框时不带出其中的内容。
- **D5 读不出来要明说。** 转换失败时返回明确的失败原因，不把空内容或部分内容当成功；现有的验证页判断、帧读取失败的处理不变。

## 实现（连续动作）

- `src/shared/browser-capability-registry.ts` 登记 `browser_sequence` 的公开身份、写入分类和效果并集，步骤白名单 `BROWSER_SEQUENCE_STEP_TOOL_NAMES` 也在这里；`codex-browser-admission.ts` 只把它加入当前页组，显式只读组不增加工具。
- `src/shared/browser-sequence.ts` 放输入 schema、工具说明和结果的类型与读取函数。schema 只声明 1–6 项 `{ tool, args }`，不复制步骤工具的 schema；接入点 `tools/schemas/browser-tool-schemas.ts`、`tools/browser-tool-catalog.ts` 只导入并登记，不改其它工具，也不改 `discipline.md`。
- `src/main/modules/tools/browser-sequence.ts` 是执行器：先整份清单预检（白名单、本轮授权、该工具已登记的 schema、桥接层的冻结合同），再逐步回到 `executeToolCall`，按 Q3 判断能否开始下一步，最后整理结果。它不调用页面、不登记动作、不改写步骤的调用身份或登记摘要。
- `tool-executor.ts` 只做三件事：把 `browser_sequence` 分派给执行器；连续动作本身不触发“动作开始/结束”计时（每一步各自触发，单步时限与单独调用相同）；步骤需要确认时直接返回、不进入确认流程。上下文新增两个字段：`browserSequenceStep`（执行器写入）和 `assertNestedToolCall`（桥接层提供）。`browser-tools.ts` 只多一道防线：不经执行器直接调用 `browser_sequence` 一律拒绝。
- `codex-tool-bridge.ts` 提供 `assertNestedToolCall`：用本轮冻结的工具面、授权和定义校验一个步骤，与校验一次独立调用用的是同一组函数。
- `quality/proof-collector.ts` 对 `browser_sequence` 的结果按 Q8 逐步取证。
- 浏览器工具说明体积的上限由 6000 调到 6300（`browser-tool-schemas.test.ts`）：原有 31 个工具占 5938，新工具约 280。上限仍是只升不降的棘轮，新工具自己另设 290 的上限。

## 实现（结果与读网页）

- R1 在 `codex-runtime/codex-tool-output-mapper.ts`：发给模型之前，文字解析出来与结构化数据相等时不带文字。工具自己的输出、回执里存的输出和它们的摘要都不变；交付摘要按连接分别登记，升级前后各算各的。
- R2 在 `tools/browser-action-executor.ts`：结果数据里不再带 `browserActionOutcome`。读它的只有已退役的旧运行时一处和测试，已一并改为读 `outcome`。
- D1–D5 在新文件 `tools/browser-page-markdown.ts`：页面里运行的转换脚本（按渲染结果逐块转成 Markdown，穿透打开的 shadow root，一份文档最多 200 万字）、整页读取（主文档加各层 frame）和分段函数。`browser-observe-tools.ts` 的整页读取改为调用它；按目标、按选择器的读取也用同一个分段函数返回长度与续读位置；选择器读取不再带出密码框的内容。验证页、出错页、空壳页仍按原来的方式读一份纯文字作为现场记录。任务取消照常向上抛出，不算读取失败。
- `browser_read` 的参数多了 `offset`，工具说明改为写明返回 Markdown 与续读方法；这是工具定义的变化，与新增 `browser_sequence` 一起只让旧对话提示一次新上下文。

## 3. 验证

- 每条合同对应行为测试（随实现补到这里）：
  - Q1：`src/__tests__/browser-sequence.test.ts` 经真实 `executeToolCall` 跑“输入 → 按键 → 快照”，核对每步是独立的动作、写租约由步骤持有、各有回执和观察记录、连续动作自己不产生动作事件；两个相同的步骤是两条动作记录，登记摘要与单独调用写下的一致。`src/__tests__/codex-tool-bridge.test.ts` 经真实桥接核对每一步都过冻结合同校验、整个调用只有一个外层回执、不能重放。
  - Q2：`browser-sequence.test.ts`：非白名单、嵌套、本轮未授权的步骤，0 步或超过 6 步，参数过不了该工具 schema 的步骤，冻结合同拒绝的步骤，以及不在最后的观察步骤，都是整份清单不执行。
  - Q3：`browser-sequence.test.ts`：第二步未送达、对话框、页面被替换、需要用户处理、等待超时各自停在第二步且后面不执行，停下的原因就是这一步单独调用时给出的原因；回车后页面换了文档算成功并继续执行为新页面安排的步骤；送达不确定且没有变化时，等待和收尾观察继续、写步骤不执行。
  - Q4：`browser-sequence.test.ts`：第二步来源写入需要确认时，在弹卡、租约和动作之前停下，这一步记为未执行；同一步单独调用仍进入原确认流程。
  - Q5：`browser-sequence.test.ts`：步骤记录、停止位置与未执行清单；观察步骤的记录里没有页面内容；收尾的快照或读取随结果带回一份；观察放在中途时整份清单不执行、也不产生模型看不到的快照；提前停下时没有观察内容，停下的那一步的结果与单独调用时的字段一致。
  - Q6：`browser-sequence.test.ts`：只读授权与最后观察位按 click 同样拒绝；声明的效果等于可入列工具效果的并集，不占写租约。`codex-binding-repository-native.test.ts`：真实数据库里六步只计一次工具调用，最后一个观察位继续拒绝它。`browser-tool-schemas.test.ts`：体积上限。
  - Q7：`browser-sequence.test.ts` 调用 `compareReadyToolSurfaceCompatibility`，缺少新工具的冻结面得到 `native_tool_surface_extension_required`。
  - Q8：`browser-sequence.test.ts`：成功的搜索步骤与带回的读取分别留下“发现”和“内容”来源证据，与单独调用 `browser_read` 的证据一致；连续动作在收尾读取之前停下时，搜索的证据保留、没有“内容”证据。
  - R1：`src/__tests__/codex-tool-output-mapper.test.ts`：文字只是数据的 JSON 写法时模型只收到一份数据（键的顺序和空白不算差别）；文字另有内容时保留；只有文字的结果不变；去掉重复文字后敏感值仍被遮蔽、失败仍是失败。
  - R2：`browser-action-executor.test.ts`、`browser-tools.test.ts`、`browser-power-tools.test.ts`、`browser-surface-hardening.test.ts` 改为只读 `outcome`。
  - D1：`src/__tests__/browser-page-markdown.test.ts` 在 jsdom 里运行转换脚本：标题、强调、链接（相对转绝对，页内锚点和非网页协议只留文字）、整张卡片是一个链接时独占一行、列表与嵌套列表、表格、代码、引用、分隔线、图片说明；脚本、样式、未渲染的部分和表单里填的内容不进正文；弹窗后面的页面仍然读得到；非文章页块与块之间的文字不丢；打开的 shadow root。整页读取把各层 frame 接在主文档之后。
  - D2、D3：`browser-page-markdown.test.ts`（分段逐段相接、最后一段不带 `nextOffset`、超出末尾为空）；`browser-semantic-tool-behavior.test.ts`（整页与选择器读取都带长度信息，按 `offset` 续读后拼起来等于完整内容；可读的页面不再走纯文字读取）。
  - D4：`browser-semantic-tool-behavior.test.ts`：按选择器读密码框只得到它的名称，读普通输入框得到内容。
  - D5：`browser-page-markdown.test.ts`、`browser-semantic-tool-behavior.test.ts`：页面脚本无返回、返回失败、抛错，或某个 frame 读不出来，都是带原因的失败；任务取消照常抛出（另见 `browser-abort-signal.test.ts`）。
  - 隐藏真实窗口的工具层评测新增“读网页”一组四项：读到的“下一页”链接带绝对地址并可直接导航；超过上限时分段续读、拼接后与整页一致；表格读成带表头的网格；密码框的内容整页读取和选择器读取都不带出。
  - W2：`src/__tests__/browser-action-followed-tab-wait.test.ts`（页面安静即结束、出现新标签照常跟随并停止观察页面、拿不到安静信号时等满、取消时停止）。
  - W1、W3 是把固定等待换成已有的就绪判断、去掉一次重复等待，没有单独的行为测试；由下面四个浏览器专项回归和隐藏真实窗口检查覆盖。2026-11-18 四个专项在这两处改动后全部通过。
- 浏览器专项：`verify:browser-orchestration`、`verify:browser-surface`、`verify:browser-reliability`、`verify:browser-grounded-orchestration-native`。
- 隐藏真实窗口：`verify:ready-next-browser-shell`（本地替身模型、本地页面）新增 `sequence` 一项，在真实的 Codex 回合里走完整条链：新工具在模型拿到的工具面上；第一个写步骤需要同意时整份清单不执行；这一步单独调用时出现确认卡；同意后四步在一次调用里完成，完成页随结果带回且模型只收到一份数据；表单内容到达本地服务。工具层评测 `scripts/browser-eval/tool-layer/run.mjs`（`verify:browser-surface` 的一部分）新增“连续动作”一组，用真实工具对本地表单页跑三种情况：一次调用里填写、提交、等待并读完成页；第二步等不到条件时停下且后面不执行；不合规的清单一步都不执行。2026-11-18 全部通过（78 项通过、0 失败、14 项未开放，其中连续动作 3 项、读网页 4 项）。
- 真实模型的任务层评测要花模型费用，由用户手动触发（清单 A6）；本计划的提速效果在那之前只有本地替身模型下的往返次数与耗时对比。
