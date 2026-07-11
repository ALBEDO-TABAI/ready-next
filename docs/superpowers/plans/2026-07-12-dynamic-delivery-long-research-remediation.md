# Dynamic Delivery 长研究任务根因修复计划

> 日期: 2026-07-12
> 状态: complete
> enforce: true
> 范围: 研究能力保真、技能选择、长任务进度时限、真实来源/多文件验收、失败恢复与任务卡状态。

## 1. 事故事实

复现请求为“调研宝矿力广告史，覆盖变化/不变、人物、作品、案例与风格，整理为多份文件和索引，存到显式文件夹”。同一真实 run 的数据库、metrics、工具日志和产物目录共同证明：

1. 意图层先得到 `primaryDomain=research`，默认工具面含 `general_research` 与 browser 组；随后泛化技能匹配把请求错误选成仅适用于 GitHub 仓库的 `github-deep-research`，技能收窄和偶然存在的当前文档上下文又删除了研究工具。
2. adaptive 总墙钟在 120 秒准点中断；中断前已经连续写出 4 个文件，说明它杀死的是仍有进展的任务，不是无进展挂起。
3. 索引承诺 8 个文件，实际只生成 4 个；文件没有导出到用户指定目录，正文没有真实 URL，`report_sources` 却被任意 artifact/tool proof 满足，最终 Check-in 为 2/2。
4. `delivery_failed` 被 undelivered-answer recovery 改写成 `success=true`，重放内容只是行动宣告；候选未通过独立复核仍进入用户可见消息。
5. 重启恢复只看 delivery state 中的 pending verifier，不看 parent 已是终态 error，导致超时失败被改写成“应用退出时中断，可继续”。
6. UI 对未完成复核统一写“已启用独立复核”，对所有 checkpoint 统一写“本轮等待中”，任务卡又重复展示已在会话列表时间旁出现的负责人。

## 2. 用户需求合同

- R1 研究先取证：系统化研究必须保有 `web_search/web_fetch` 或等价 browser research 能力，选中参考技能不得删除由当前 research intent 明确要求的能力。
- R2 技能选择分层：每个技能以 `id + name + description` 摘要进入模型可见目录，模型通过 `use_skill` 做语义选择；代码只识别用户明确写出的技能名/别名，不得用“调研/项目/资料”等普通词自动激活。激活后，同一 request 的下一次模型迭代必须真的获得选中技能的获准工具，不能等用户再说一次。
- R3 长任务续命：120/240 秒是连续无进展窗口，不是整个任务寿命；只有成功文本或成功工具结果会刷新窗口，`Error:` 与结构化失败不能续命。真正无进展才中断，已有进展不得伪装成完成。
- R4 真实来源：`report_sources` 必须同时有“发现来源”与“读取正文”两类回执，且回执必须带真实 URL、时间、摘要与 digest；页面 map、异步任务句柄、写了 Markdown 或只调过搜索均不能证明已取证。异步研究只有在读取并验证终态结果包后才可成为正文证明。
- R5 真实交付：多文件任务必须能够调用 `declare_completion_criteria` 声明最终文件；成功 auto-export 必须记录目标路径证明；发布前由宿主只按 current run 证明真实打开文件，检查目标目录、数量、非空、已声明交付项和索引链接。中间 outputs、旧任务或同 task 旧 run 的文件均不等于本轮交付。
- R6 候选隔离：error/blocked/timeout 候选不得经“结果没显示”路径改写成成功；非 done Check-in 永不 accept，也不得进入学习。
- R7 恢复如实：只有非终态 parent 才参加 app-restart delivery reconciliation；终态失败保留真实病因。
- R8 UI 如实：复核显示计划中/进行中/已通过/未通过；“等待中”只用于真 checkpoint 且存在 continuation/等待对象；负责人只在会话历史时间旁显示一次。
- R9 协作不造证据：无工具 worker 只能分析用户本轮明确提供且已有足够正文的资源。taskType 或 intentDomains 只要含 research，都受同一门槛约束；缺少真实资源时只走 Owner 取证＋终局独立复核，不得在取证前派 worker 生成“事实”。

## 3. 机器可验证合同

- C1 用事故原话调用真实技能匹配器：不得返回 `github-deep-research` 或 `okf-bundle`；显式写出技能名仍可命中。
- C2 research + current-document + folder-reference + selected reference skill 的最终 SDK 工具面同时包含 `web_search`、`web_fetch`、`declare_completion_criteria`、skill artifact primitives 与当前文档地板。
- C3 只有成功研究工具结果刷新 Dynamic Delivery 进度窗口；普通 `Error:` 和结构化失败均不刷新；旧定时器不得中断，停止刷新后以明确 timeout 中断。
- C4 `report_sources` 要求带 URL 的 discovery + 已读正文回执；`browser_read_page_map`、后台 collection/research 句柄、`skill_write_artifact`、artifact proof 与只搜未读均不可满足。
- C5 terminalStatus=`error|cancelled` 的 Check-in 不是 accept，`learningDecision.learned=false`。
- C6 `delivery_failed` 不走 undelivered-answer recovery；proof-gap 的已验证浏览器答案兼容路径保持。
- C7 已终态 projection/run_meta 不参与 restart reconciliation；真实 running + pending worker/verifier 才变为 recoverable checkpoint。
- C8 DD 结构化目标只数当前轮显式引用，不把偶然打开的 current document 当交付目标；typed skill 使用 `resource.name`，不得使用 envelope 合成 id。
- C9 TaskCard 不渲染额外负责人行；Dynamic Delivery 摘要按 verifier 状态输出四态；无 continuation 的 error 不显示“等待中”。
- C10 对真实目标目录做读回：只接受 `runId` 匹配的 proof；成功 auto-export 必须铸目标 artifact proof；空目标、旧文件、空文件、缺失已声明文件、多文件数量不足、缺索引、索引指向非本轮文件或索引断链均在 semantic verifier 调用前硬阻断，且不泄露候选草稿。
- C11 `use_skill` 返回后，executor 在同一 request 内刷新 authorization，SDK latent 技能定义于下一次模型迭代按 allow-set 动态开放；描述匹配不再进入 `findExplicitlyRequestedSkills`，完整技能名重叠时只命中最具体的一个。
- C12 taskType 或 intentDomains 含 research 时，pre-owner support 都要求 `groundedWorkerResourceCount > 0`；thorough/Boost 不得越过该证据门。

## 4. 验收入口

先跑新增焦点测试，再跑：

```bash
npm run verify:dynamic-delivery
npm run verify:stability
npm run verify:native
npm run typecheck
```

最后用同一条宝矿力请求做 live seam：必须看到研究工具在场、不会在有工具进展时于 120 秒中断、未完整导出前不会返回成功，且任务卡状态与数据库终态一致。

## 5. Closeout（2026-07-12）

- 对抗复审先实证 3 个 P0 与 3 个 P1：同轮选技未真开放、页面 map/后台句柄伪造正文、auto-export 目标 proof 缺失、普通错误伪续命、旧 run proof 混入、跨域 research 绕过 grounded worker 门。修复后由同一复审代理逐条重放，6/6 关闭，无残留 finding。
- 事故原话、skill 目录/选技、研究＋文档混合工具面、滚动进度、目标 auto-export、current-run 读回、旧文件反例、索引覆盖、来源正文与伪正文、恢复/终态/UI 文案均已有行为测试。
- `npm run verify:dynamic-delivery` 通过：Node 专项 187 项无失败（177 通过，10 个 host ABI 检查由后续原生门覆盖），Electron 原生 9/9；Agent Foundation、所有 gate、真实 SQLite 与双端类型检查均通过。
- `npm run verify:stability` 通过：主稳定性 176 项无失败，Send IM 链 140 项无失败；模块边界 gate 将 turn execution 保持在 900 行以内。
- `npm run build` 通过：原生模块、主进程、preload、renderer 正式构建全部成功；`git diff --check` 无格式错误。
