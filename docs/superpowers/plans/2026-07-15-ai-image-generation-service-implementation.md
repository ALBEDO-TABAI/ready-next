> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# AI 生图服务与跨区域图片交互实施计划

> 日期: 2026-07-15
> 状态: implementation
> enforce: true
> 范围: 外部服务中的 GPT Image / Gemini Image 配置、Agent 生图工具、参考图次序、聊天图片预览与跨区域拖放。

## 1. 目标与完成标准

本次交付只有一条生产主链：用户用自然语言或 `/imag` 提出生图请求，Agent 选择 `generate_image`，主进程读取已启用的生图服务和本轮有序参考图，生成结果先写入 Ready 临时图片目录，再以结构化图片产物回到聊天区。用户把图片拖到文档、网页或文件管理区时，目标区域分别负责复制到文档 `assets`、上传到网页、或保存到目标目录。

完成必须同时满足：

1. 设置页“外部服务”有独立的“AI 生成服务”区域，内置 GPT Image 与 Gemini Image 两个配置；密钥继续使用既有加密保存、遮罩回读和草稿测试链路。
2. GPT Image 走 OpenAI Images 接口；Gemini Image 走 `generateContent` 接口；两者都真实解析远程返回的图片，不把远程 URL 当最终产物。
3. 自然语言与 `/imag` 共用 `generate_image`，不新增关键词路由、第二套会话状态或 Renderer 直连模型的旁路。
4. 本轮图片附件按用户添加顺序标成“参考图 1…N”；工具只接受序号，不接受模型提供的本机路径；主进程按序号从 RequestEnvelope 解析真实路径。
5. 生成图片只先写入 `os.tmpdir()/ready-image-generation`；缓存按寿命和数量回收；只有拖放落地才复制出正式文件。
6. 聊天图片可点击放大，右键可复制、可作为下一轮参考图；拖到文档、网页、文件区均有真实行为和明确失败提示。
7. 两组用户提供的配置都走真实请求验证：可用配置完成文生图与参考图生图；被上游账户/分组拒绝的配置保留为停用状态并显示原始原因，不得伪报成功。密钥不写入源码、日志、测试快照或提交。
8. 专项测试、`verify:native`、类型检查、生产构建和真实 Electron 操作验收全部通过。

## 2. 边界合同

### C1 配置合同

- `ExternalServiceKind` 新增唯一种类 `image-generation`；两个默认 profile 仅通过 `options.protocol` 区分 `openai-images` 与 `gemini-generate-content`。
- 运行必填项为：启用、服务地址、API Key、模型名、协议。设置页只能读到密钥是否存在和尾部遮罩，不能读到明文。
- 草稿测试调用与正式生成使用同一个协议客户端；测试会真实生成最小测试图并立即丢弃，不以 `/models` 成功冒充生图可用。
- 仍复用 `external_service_profiles_v1`，不新建设置表、第二份密钥存储或兼容旧分支。

### C2 协议合同

- OpenAI 无参考图：`POST {base}/v1/images/generations`，JSON 包含 `model/prompt/n/size`。
- OpenAI 有参考图：`POST {base}/v1/images/edits`，multipart 中参考图按序重复追加，包含 `model/prompt/n/size`。
- Gemini：`POST {base}/v1/models/{model}:generateContent`，`contents[0].parts` 固定为提示词在前、参考图按序在后；生成参数包含 `responseModalities:["TEXT","IMAGE"]` 和图片配置。
- OpenAI 同时支持 `b64_json` 和 `url`；Gemini 读取 `candidates[].content.parts[].inlineData`。URL 返回必须下载并转为本地字节，响应 MIME 与大小都必须校验。
- 网络请求受 AbortSignal、超时、单图大小和参考图总大小上限约束；错误只返回可理解的服务/协议/响应原因，不泄露 Key 或完整上游响应。

### C3 参考图合同

- RequestEnvelope 中 `kind=attachment`、`source=user_attachment|explicit_reference` 且后缀/MIME 为图片的资源，按 `order` 升序形成唯一参考图真值。
- `generate_image.reference_image_orders` 是可选的一基序号数组；省略代表使用本轮全部图片，重复、越界或非整数必须被代码拒绝。
- 聊天附件标记、工具解析和上游请求共同消费同一排序结果；模型不能传任意文件路径，也不能重排未明确选择的参考图。

### C4 临时文件与落地合同

- 每张生成图以随机 id 原子写入缓存目录；结构化产物只暴露 id、文件名、MIME、服务名、模型名、提示词摘要、参考图标签和临时路径。
- 所有复制/读取操作先确认源文件真实路径位于 Ready 生图缓存根；拒绝符号链接逃逸、目录源、超限源和不存在的源。
- 文档落地复制到目标文档同级 `assets/`，使用不覆盖的唯一文件名，并插入相对 Markdown 图片路径。
- 文件管理落地复制到目标文件夹，使用不覆盖的唯一文件名。
- 拖拽起手时先隐藏原生 BrowserView，再显示 Renderer 落点，避免系统文件拖拽与文档/文件树的 HTML 拖拽互相取消。落到网页时复用现有 BrowserView 本地媒体上传链，不创建第二套网页上传器；上传终态显示后恢复 BrowserView。

### C5 聊天产物合同

- `generate_image` 返回 `projectionPatch.recentArtifacts` 中 `kind=generated_image` 的单一图片产物；聊天消息从任务快照读取，不把 base64 写进消息或数据库。
- 图片点击复用现有附件预览；右键复制由主进程读取缓存图后写系统剪贴板；“作为参考图”复用现有附件入口。
- 拖动只写 `application/x-ready-generated-image` 与既有 Ready 文件拖放载荷；不写 `text/plain`，防止文档外层把路径误当普通文本或打开成新标签。

### C6 Agent 主链合同

- 新增 `image_generation` capability group 与唯一工具 `generate_image`；仅 local chat 默认可用，由模型根据工具说明做语义选择。
- `/imag` 只是一条输入捷径，补全为 `/imag ` 后仍按普通用户消息提交；不得在 Renderer 直接调用生图服务。
- 工具域串行执行、支持取消，并通过既有 run 终态与 projection 机制落回聊天；不另建任务状态机或 fire-and-forget 工作。

## 3. 机器可验证合同

新增 `npm run verify:image-generation`，至少覆盖：

- P1 两个默认 profile 存在、密钥遮罩、协议与必填项规范化。
- P2 OpenAI generations/edits 的 URL、请求形态、参考图顺序，以及 `b64_json`/URL 两种响应。
- P3 Gemini URL、Bearer 请求、`parts` 顺序、`inlineData` 解析和缺图错误。
- P4 超时/取消、响应过大、非法 MIME、无启用服务、参考图越界与源路径逃逸。
- P5 缓存原子写入、过期清理、文档 assets 唯一复制、文件夹唯一复制。
- P6 `generate_image` 在注册表、OpenAI/Anthropic schema、串行策略和执行分发中一致存在。
- P7 任务快照图片提取、点击预览输入、右键引用输入、拖放载荷解析。
- P8 文档编辑/预览面都产生相对 `assets/...` Markdown；FileTree 与 Browser 上传消费同一生成图片载荷；Browser 行为测试必须观测到当前 tab 收到缓存图片。
- P9 `/imag` 补全不创建 skill 引用，自然语言与命令都只依赖同一 `generate_image` 工具。

收尾验证：`npm run verify:image-generation`、`npm run verify:native`、`npm run typecheck`、`npm run build`，再用独立 userData 启动真实 Electron，逐项验证设置、可用服务生图、无权限服务的明确失败、预览、复制、引用与三处拖放。

### 3.1 用户配置的真实服务证据

- Gemini 配置的 `generateContent` 文生图成功，返回 1024×1024 JPEG；再把该结果作为“参考图 1”提交，参考图生图成功。
- GPT 配置对 Images API 返回“当前平台不支持 Images API”；按 NovaCode 工具调用文档改测 Responses API后，服务端返回“当前分组仅限 Claude Code 客户端使用（仅支持 /v1/messages）”；继续测试唯一允许的 Messages API 与 `gpt-image-2`，服务端返回“当前分组中没有可支持模型 gpt-image-2 的账号”。因此这组账户在本次验收时不具备生图权限，必须停用，不能由客户端协议兼容掩盖。

### 3.2 真实 Electron 拖放证据

- 生成图拖到 FileTree 的 `/tmp` 目录后，产生不覆盖副本，界面回读“已保存…到 tmp”且文件 stat 成功。
- 生成图拖到 Markdown 预览面后，同级 `assets/` 出现副本，预览即时显示图片，保存后原文档包含相对 `assets/...` 链接。
- 生成图拖到本地测试网页后，Ready 显示上传成功，页面的 `input[type=file]` 回读文件数量 1 和生成图文件名。

## 4. 非目标与取舍

- 不实现批量多图、图层编辑、历史素材库、云端图库或服务自动故障转移；这些都不属于当前需求。
- 不把 GPT 与 Gemini 抽象成任意插件系统；两个轻量协议适配器共享下载、校验、缓存和落地代码即可。
- 不在启动阶段扫描缓存；首次生图时做一次有界清理，后续按低频门槛清理，避免启动和常用文件路径被阻塞。
- 不把用户测试 Key 写入默认配置；真实验收只写入隔离测试数据并在验收后删除。用户以后在正式应用设置页保存的 Key 仍走既有加密存储。

## 5. 受影响的权威入口

- 配置与运行时：`src/shared/external-services.ts`、`src/main/modules/settings-engine/external-service-store.ts`。
- 生图与缓存：`src/main/modules/image-generation/`、对应 preload/Renderer 合同。
- Agent：能力组、工具注册、工具执行与任务图片产物。
- 交互：外部服务设置面板、聊天消息、附件参考顺序、文档编辑器、BrowserView 上传、FileTree 落地。
- 架构说明：`docs/architecture/current-runtime-contracts.md` 只追加本合同的生产真值入口，不复制本计划全文。
