# Codex 瞬时失败续接与上游会话亲和

## 已验证事实

- 2026-10-04 的失败回合（`req-1791126534182-eabqwr`，ChatGPT OAuth、`gpt-6-astra`）前三次请求成功，读了 3 个工具；第 4 次请求上游连续返回 HTTP 500，网关按策略重试后在 57.5 秒把 500 交给 Codex，Codex 统一显示 `internalServerError`（“high demand”）。Ready 没有记录上游原文，只留下 `gateway_upstream_http_500`。
- 该回合因含 commentary 与工具被判为 `diverged / partial_assistant`，Ready 退回上一个已接受前缀并 `thread/fork`，失败回合的读取结果全部丢弃，界面要求用户完整重述并重新附加资源。即便失败发生在首个请求，旧规则也只放行 400/429，5xx 与传输失败一律分叉。
- 同一账号同一模型，官方 Codex 应用（WebSocket 会话）每次请求约 98% 命中 prompt cache；Ready 历史会话命中 0–10%，同一回合内前缀只增不减的连续请求也是 0。Codex 发往网关的请求带 `session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`，网关转发上游时全部丢弃。（更正：本机 OAuth 代理并不透传请求头，见下文“第二轮”。）
- 官方应用对失败回合的处理：`internalServerError`、`serverOverloaded`、连接/流断开、重试耗尽等视为可恢复，同一 thread 保留，发送键变为“继续”，以空输入 `turn/start` 续接；不分叉、不要求重述。
- 真实固定 0.149 二进制探针：工具轮完成后下一请求 500，失败回合的用户项、commentary 与工具调用/结果在重启后仍保留，并且在下一轮恰好回放一次（`thread/read` 不投影动态工具调用，以线路回放为准）；首请求 408/425/429/500/502/503/504/520–524 失败同样只保留用户项一次；运行时不静默重试。

## 本轮合同

1. 新增历史 seam `failed_after_completed_rounds_v1`：失败回合中此前每个网关请求都已完成且工具结果已发布，只有 commentary、已结束的工具与推理项，最后一个请求在连接/首部阶段、零事件零字节时以瞬时线失败。此时保留同一 thread，用户项映射与 `failed_user_only_no_suffix_v1` 相同。
2. `failed_user_only_no_suffix_v1` 的失败线从 400/429 扩到同一组瞬时线。瞬时线只认探针驱动过的 HTTP 码与三种网关传输原因码；401、501、505、599、请求转发失败等仍按未探测处理。
3. 部分最终回答、未结束工具、发布分叉、压缩、非 product 请求、用户停止都不改变原判定。探针收据升级为 `continuation-safe-probe-receipt-v3.json`，旧事实中的 v2 摘要继续有效。
4. 失败文案按原生错误种类区分“模型服务暂时出错”，仅当历史保留时提示发送“继续”；Retry 资格不变，不新增按钮。
5. 网关对 Responses 上游附带 Codex 会话身份头（取自已校验的 `client_metadata`，不合法则不发）；Chat/Messages 上游不发。上游失败以无正文的诊断写入 `ready-directchat.log`，终态事实仍只存原因码。

## 验证

- 真实二进制：`codex-failed-turn-continuity.e2e.ts`（工具轮后 500、12 种首请求瞬时码、两次重启），并入 `verify:codex-input-continuity`。
- 判定单测：两条 seam 的正例与 401/501/505/599、阶段/字节、部分回答、未结束工具、发布分叉、用户停止、压缩等反例。
- 网关合同：Responses 上游收到四个会话头、Chat 上游不收；失败诊断含去凭证的 provider 错误与上游 request id，重试恢复不记失败。
- `verify:history-continuation`、`verify:codex-turn-delivery`、`verify:codex-runtime-e2` 的单元与原生部分、真实 sidecar 网关 e2e、类型检查。`codex-sidecar-crash-recovery` 与 `codex-sidecar-process-lease` 两个真实 e2e 在未改动的 HEAD 上同样以 `continuation_contract_unavailable` 失败，与本轮无关。
- 缓存命中改善需在新版本的真实对话中读 rollout `cached_input_tokens` 确认；本轮未用用户账号做线上 A/B。

## 第二轮：长工具调用断流、流中断续接与缓存路由（2026-10-05）

### 已验证事实

- 新版本上的失败回合 `req-1791140207824-d77uzw`（37 个请求，前 36 个完成，平均约 8 秒）：最后一个请求在 8 秒时输出一段 commentary，随后模型生成一个长工具调用。网关为“工具结果须在有效终态后才准入”扣留了工具调用之后的全部事件（`codex-model-gateway-native-stream.ts` 的 hold），300 秒内向 Codex 只写 0 个事件，上游此时持续到达（共 2.5 MB）。Codex 以 `stream disconnected before completion: idle timeout waiting for SSE`（`codexErrorInfo: other`）结束该流；网关记 `gateway_native_stream_failed / stream-after-item`。Chat 路径的工具参数同样只在末尾发出。
- 真实 0.149 二进制：静默流与 SSE 注释都会在 `stream_idle_timeout_ms` 后断开；未知类型事件 `ready.keepalive` 被忽略且重置空闲计时，工具照常执行。
- 真实 0.149 二进制：流在响应开始后中断（网关 `response.failed`，或运行时空闲超时）时，此前完成的工具轮与本请求已完成的 commentary 恰好保留一次，未完成的半截项不进历史；重启后“继续”正确回放，运行时不静默重试。该失败原被判 `diverged / partial_assistant`，导致 36 轮读取被丢弃并要求重述。
- 缓存：该回合请求前缀逐字节稳定（输入摘要逐个为前缀、指令与工具摘要不变），命中仍只有 5/36。本机 OAuth 代理 `openai-oauth` 的 `handleResponsesRequest` 只发送 `Content-Type`，会话头未到达 chatgpt.com；后端在回合首个响应返回 `x-codex-turn-state`，真实 0.149 会在同一回合后续请求带回，而网关两个方向都未转发。

### 本轮合同

1. 网关下游保活：读到上游数据而下游 15 秒未写时发送 `ready.keepalive`；上游停滞不发。原生（含 Messages 转换）与 Chat 两条路径相同。
2. 新 seam `failed_mid_stream_v1`：此前请求都已完成，最后一个请求在 `stream-before-item | stream-after-item | terminal-validation` 失败，回合只有用户项、commentary、推理与已结束工具，且无最终回答增量。`post-terminal`（上游声明的失败）不属于该 seam。探针收据升级为 v4，旧摘要继续有效。失败文案写明“模型的回复中途断开”并提示“继续”。
3. 缓存路由：网关双向转发 `x-codex-turn-state`（仅 Responses + openai 协议）；OAuth 代理以 `AsyncLocalStorage` 按请求把五个路由头补到发往 `/responses` 的请求，认证仍由 `openai-oauth` 覆盖；`x-oai-request-id` 计入上游 request id。

### 验证

- 真实二进制：`codex-gateway-wire.e2e.ts`（静默/注释/保活三种流，turn-state 回合内回传）并入 `verify:codex-runtime-e3`；`codex-failed-turn-continuity.e2e.ts` 新增两种流中断线路。
- 网关：`codex-model-gateway-keepalive.test.ts`（原生扣留与 Chat 工具参数期间发保活、上游停滞不发且由 idle 收口、turn-state 校验），合同测试新增 turn-state 双向与 `x-oai-request-id`。
- 代理：`chatgpt-oauth-routing.test.ts` 走真实 `openai-oauth` 处理器与本地伪造凭证，证明五个头到达上游、本机代理密钥与无关头不出本机、上游令牌回到网关；去掉转发时同一测试失败。
- 判定：`codex-terminal-facts.test.ts` 以该失败的原始证据为正例，覆盖首请求中断、`post-terminal`、最终回答增量、未结束工具、用户停止、压缩等反例。
- 缓存命中需重新打包后在真实对话的 rollout `cached_input_tokens` 中确认；未使用用户账号做线上测试。

## 第三轮：文档工具空转、收尾挂起与停止续接（2026-10-05）

### 已验证事实

- 失败回合 `req-1791203666294-3vfj2v`（“在文档中做一些信息卡”）：附加的回顾 md 以 `local_file` 只读资源进入，本轮没有当前文档锚点，但工具面仍提供 16 个 `document_*` 工具；其中 9 个在 Codex 产品动作桥无映射（`product_action_tool_mismatch`），7 个缺锚点（`product_action_document_anchor_missing`）。
- 模型在 12:35:58 给出最终回答（未修改文件）；Codex 引擎终态完成并结算效果，但发布检查返回 `incomplete:artifact_staged_receipt_missing`（模型此前声明了保存该文件）。`classifyCodexProductRecoveryFailure` 把所有 `codex_tool_publication_incomplete:*` 归为暂时状态，收尾每秒重试，任务保持“进行中”约 10 分钟，直到用户停止；停止时因引擎已完成被强制判为分叉，要求重述。
- 真实 0.149：用户停止时（流中途或工具执行中），已完成项恰好保留一次，半截项丢弃，未结束的工具调用被补上 `aborted by user` 结果，下一轮开头带 `<turn_aborted>` 提示，重启后续接正确且不静默重试。

### 本轮合同

1. 没有当前文档锚点时，工具面去掉全部 `document_*` 工具。
2. 引擎已完成后的六类义务缺口（声明输出未暂存/未导出、输出意图回执缺失、产品动作义务缺失、当前文档读取缺失或无回执）归为本轮失败：`settleEngineTerminalFailure` 以 `blocked_external` 收尾，只结算效果（不按成功发布标准复核），文案说明缺了什么；工具回执仍在途的 `incomplete` 继续视为暂时状态。
3. 新 seam `interrupted_after_completed_items_v1`；探针收据升级为 v5。

### 验证

- `codex-undelivered-closeout-native.test.ts`：生产组合的实时收尾循环在 1.4 秒内以未交付关闭，不发布未经核实的回答；去掉分类修正后同一测试等待超时。
- `codex-tool-surface-union.test.ts`：无锚点时无 `document_*` 工具，文件与正式导出工具保留。
- `codex-failed-turn-continuity.e2e.ts`：新增流中途停止与工具执行中停止，两次重启续接。
- 判定单测覆盖停止 seam 正反例；`verify:codex-input-continuity`、`verify:history-continuation`、`verify:codex-turn-delivery` 单元与原生部分、网关 sidecar e2e、停止收尾原生测试通过。

## 第四轮：确认覆盖后仍不保存、未交付轮丢弃回答（2026-10-06）

### 已验证事实

- 失败回合 `req-1791216045982-842utx`（同一“信息卡”请求，已含第三轮修复）：模型用 `skill_write_artifact` 暂存三段新版本（47872 字节），再以 `overwrite: true` 调用 `skill_export_artifact` 覆盖原文件。行动确认 M2 规则 `m2-overwrite-existing-file` 弹出确认卡，用户 8 秒内确认，冻结调用放行；但 Codex 交付路径没有把 `overwrite` 传给 `ArtifactMaterializer.exportVersion`，后者对不同内容的已有目标一律 `artifact_target_conflict`，所以确认后照样失败，原文件未改。
- 模型如实回答“保存时工具拒绝覆盖同名文件，原文档尚未改动”，并询问是否另存为新文件；第三轮的未交付收尾在 1 秒内关闭，但用固定失败文案替换了这段回答并强制历史分叉，用户只能看到失败文案和“请完整重述、重新附加资源”。
- 对照 Codex 桌面端：用户批准的动作按批准的参数原样执行；拒绝或失败由模型在同一回合内回应，回合正常结束，thread 继续。

### 本轮合同

1. Codex 交付导出把 `overwrite === true` 作为 `replaceExisting` 传给 Materializer。`overwrite=true` 在 `invoker: 'model'` 下必经 M2 逐次确认，所以处理器只信任经确认门的参数，与非 Codex 导出路径一致。替换：临时文件写满并 fsync，替换前再核对目标仍是被确认的那份普通文件（哈希与 inode 不变、非链接），保留原权限后 `rename`，回读并记 `replaced`；`replaceExisting` 进入动作摘要，重放只返回原回执。
2. 导出成功后广播目标目录变化，已打开的无脏文档标签从磁盘刷新。
3. 未交付收尾不再强制分叉：结果仍为 `error / blocked_external`，可见文案为“经核实的缺口 + 模型最终回答”；历史按既有 `completed_product_accepted_v1` 判定（原生最终消息与候选一致时保留同一 thread），下一轮无未提交尾项。

### 验证

- `artifact-materializer.test.ts`：经 Codex 导出处理器，未带或带 `overwrite: false` 时拒绝并保留原文件；`overwrite: true` 时替换内容、保留 0644 权限、回执 `replaced`、重放一次；指向链接的确认覆盖仍拒绝。
- `codex-undelivered-closeout-native.test.ts`（已接入 `verify:native`）：生产组合 1 秒内关闭；可见文案为缺口说明后接模型回答；`terminal_facts` 为 `error + continuation_safe(completed_product_accepted_v1)`；thread 未退役、未阻断，`readLiveUncommittedUserTail` 为空。
- `verify:native`（193/193）、`verify:history-continuation`、`verify:codex-input-continuity`、`verify:codex-turn-delivery`（仅两条既有 `continuation_contract_unavailable` 真实 app-server 失败，与本轮无关）、类型检查、受影响文件 lint。

## 第五轮：信息卡没有走 Ready 组件（2026-10-06）

### 已验证事实

- 回合 `req-1791220302558-1tpuxe` 成功覆盖原文件，但卡片是 Markdown 引用块，不是 Ready Widget。冻结 ingress 显示 `workbenchMode: document`，却没有当前文档锚；27 个授权工具里没有任何 `document_*`，模型只能走 `file_read_excerpt → skill_write_artifact → skill_export_artifact(overwrite)`。
- 原因在 Main：Renderer 捕获的锚只有在 `hasExplicitCurrentDocumentAccessIntent` 命中或带 `widget_target` 时才激活。“试着在文档中做一些信息卡来让内容更加可读”既没有“这篇/当前文档”，也没有“动词 + 文档”的词序，所以锚被丢弃；写意图规则也不认“做一些信息卡”。用户随消息附上的文档标签就是这篇打开的文档，却只作为只读 `local_file` 进入本轮。
- 上一轮信息卡样式提交 `0deeaff2` 在当前分支 `codex/cod-ready`（不在 `main`），已在打包产物中（`note-preview-shell` 与 liquid-card 样式存在）；截图里的点线引用样式正是它的预览排版，问题不在样式未落地。

### 本轮合同

1. `resolveCurrentDocumentActivation`（`codex-product-turn-authorization.ts`）统一判定：锚存在且未被明确排除时，`widget_target`、附件路径摘要等于锚 `pathDigest`、或措辞指向当前文档，三者任一即激活；写权限仍只看写意图措辞。等于当前文档的附件从本轮资源中移除，由当前文档资源代替。
2. 指向当前文档的措辞补充“在/往 + 文档/笔记 + 里/中/内”；写意图补充“做/加/添/放/画 + 信息卡/卡片/图表/组件/时间线/关系图/流程图”。“这张信息卡是什么意思？”“在线查资料，整理为一份文档输出”仍不激活写或锚。

### 验证

- `codex-product-resource-envelope.test.ts`：用真实 Renderer 锚构建器打开同一路径文档，附件 + 原话激活锚、可写、只替换该附件；只附件不写；其他文件、明确排除、无锚都不激活；按判定结果组合的工具面包含 `document_read_section / document_insert_widget / document_save_tab`。
- `verify:codex-workbench-surface`、`verify:widget-ready`、`verify:codex-runtime-e3/e6`（除两条既有 `continuation_contract_unavailable` 真实 app-server 失败外，其后步骤单独补跑全部通过）、类型检查、受影响文件 lint。
- 未在真实窗口用真实模型复跑（不使用用户 ChatGPT 凭据）。

## 第六轮：调用候选工具时运行时被重启（2026-10-06）

### 已验证事实

- 回合 `req-1791224413251-f9ghvl`（“把文档中这些引用块卡片换成 Ready 信息卡”）：附上的文档标签已按第五轮合同激活为当前文档，模型成功 `document_read_section`；但写意图规则不认“换成”，本轮只授权读取，没有任何 Widget 写工具。
- 模型随后调用本轮已授权的候选原语 `skill_run_shell`（lark-cli 候选，`mode:'none'`）。工具桥执行前用 `getToolDefinitionsForGroup('skills', …)` 复核，注册表在会话技能门关闭时经 `getToolDefinitionForExecution` 补入候选原语，该查找不带输入 schema；而线程冻结工具面来自 `listToolDefinitions()`（完整 schema）。二者比对为 `native_tool_definition_changed`，报 `tool_execution_surface_drift`，按协议故障关闭 sidecar 并重启，本轮中断，历史被丢弃并要求重述。`skill_ask_user` 同样受影响；`skill_write/read/export_artifact` 走宿主导出分支，不受影响。
- 2026-08-21 曾“统一候选技能原语的准入/执行面”，但注册表循环仍用执行查找，准入补齐仍用完整列表，两边来源不同。

### 本轮合同

1. 注册表为已授权候选原语解析定义时，先取 `getToolDefinition`（与线程冻结面同源），再回退执行查找。准入与执行复核从此用同一份定义。
2. 写意图动词表补充“换成/改成/改为/转成/转为/变成/加上/加入/添加/新增/去掉/删去/美化/优化/精简”，与“如何/怎么/建议/方案/讨论 + 动词”的问法排除共用同一列表；指向当前文档的位置短语补充“把文档中”。

### 验证

- `codex-tool-bridge.test.ts`：用真实注册表，线程冻结的 `skill_run_shell / skill_ask_user` 条目经执行复核不再报漂移；撤掉修复时同一测试以 `skill_run_shell` 失败。
- `codex-product-resource-envelope.test.ts`：“换成 Ready 信息卡”“改成时间线”为写意图；“怎么把引用块换成信息卡？”“建议我如何优化这篇文档”保持只读；“把文档中…”指向当前文档。
- `verify:codex-runtime-e4`（两条既有真实 app-server 失败后的步骤单独补跑全部通过）、`verify:tag-forge`、`verify:send-im-l1`、`verify:codex-workbench-surface`、`verify:widget-ready`、类型检查、受影响文件 lint。

## 安装版证明随迁（2026-10-09）

2026-10-09 更正：F01/F02 改为注入网关会重试、但未经探针确认可保留历史的 HTTP 599（500 等已探明的零输出失败现在保留原线程，由 `codex-failed-turn-continuity.e2e.ts` 覆盖）；F01 改在关闭全部标签页的 Browser 模式下发送，因为 Document 模式总会带上聚焦文档（至少是空白“新文档”），尾部只能是“需重附资源”。重新打包后安装版续接证明首次全程通过（含 F01、F02 三轮与重启），原 Codex home 摘要前后一致。
