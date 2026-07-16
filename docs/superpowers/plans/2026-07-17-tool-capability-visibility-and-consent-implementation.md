# 工具能力可见性与开启同意链路实施合同

> Date: 2026-07-17
> Status: implemented
> Enforce: true

## 目标

修复用户明确要求浏览器、文档等工具能力时，OpenAI-compatible 配置因工具调用处于保守关闭态而静默退化成纯文本回答的问题；同时保证能力默认值不被放宽、用户设置不被静默修改、模型看到的解释与真实工具面一致、工具账单与实际线上请求一致。

## 事件与独立复核结论

事发轮次位于 2026-07-16T18:16:30Z 与 18:16:55Z。真实日志证明：

- 采集与浏览器工作流意图均已命中；问题不在意图识别。
- 活跃配置为 OpenAI-compatible，`toolUseMode=auto`；共享能力层按合同把它解析为不支持工具。
- capability resolver 因此把所有模型可见能力组标成 `provider_disabled_tools`，最终工具面只剩资源地板，或完全为空。
- 第一轮在「智识」会话，后两轮在「运营」的新会话；这是既有会话隔离合同，但不是工具面归零的原因。

原草案有三处需要纠正：

1. `provider_wire_request_bill.toolSchemaCount=17/19` 不证明 17 个工具绕过裁决。SDK 会在模型调用前执行每个工具的 `isEnabled`；错误来自 Ready 账单使用了注册全集。实际线上工具只能从 provider 边界的 `ModelRequest.tools` 取值，统计不得再次执行动态裁决。
2. 独立新增一套 Renderer 提示卡与 24 小时去重状态不是闭环所必需。模型侧精确提醒、设置页真实语义和现有 `ask_user_questions` 确认卡已经覆盖用户可见性与同意；不再创建第二套卡片状态机。
3. 跨 Agent 会话提示与本故障没有因果关系。本轮不改变会话隔离，也不顺带设计上下文携带；后续若要做，应作为独立产品合同。

## 强制合同

### C1. 设置页展示真实生效值

- 「工具调用」的 `auto` 选项必须显示当前解析结果，而不是只写“自动”。
- OpenAI-compatible + `auto` 必须显示“当前=关闭”，并明确说明：若端点支持 function calling，可选择“强制开启”。
- 该展示复用 `resolveAIConfigCapabilities()`，不得在 Renderer 再造一套 provider 判断。

### C2. 意图冲突成为结构化运行时事实

- `CapabilityResolution` 必须区分“本轮意图请求的能力组”与“最终可见能力组”。
- 只有意图值明确为 `true` 的能力才进入 `requestedButSuppressed`；默认目录曝光、未请求能力和 `run_intent_suppressed` 不得制造冲突。
- 否定表达必须先于浏览器工作流与最近意图兜底生效；“不要打开浏览器”“无需网页工具”等消息不得被标成浏览器请求，也不得继承上一轮浏览器工具面。
- 每条冲突至少包含稳定 group id、用户可读 label 和 resolver 的真实 reason。
- SDK executor 计算出的同一份 resolution 必须通过本轮准备结果传给提醒与同意链路；禁止在调度层用第二套关键词重新猜冲突。

### C3. 模型必须知道真实阻断原因

- `requestedButSuppressed` 非空时，经 `SystemReminderRegistry` 注入能力冲突提醒。
- `provider_disabled_tools` 的提醒必须说明当前模型配置关闭工具调用，以及设置路径；`disabled_by_config`、`environment_unavailable` 等原因使用各自真实解释。
- 提醒必须明确禁止声称“已收到授权”“稍后会挂载”或建议无效重试。
- 无冲突时不注入；提醒不得写入持久会话历史。

### C4. 口头开启走代码侧确认，不由模型改设置

- 只有同时满足以下条件才弹确认卡：
  - 本轮存在 `provider_disabled_tools` 冲突；
  - 当前共享能力解析为 `supportsToolCalls=false`；
  - 用户原文同时包含明确的工具对象与肯定的开启、允许或授权表达，且不含否定表达。
- “打开网页”“当前打开的标签页”“使用浏览器工具”等任务动作不等于修改设置；“开启/打开/启用”只有明确指向工具调用、权限、能力或开关时才算设置意图。
- 复用现有 `ask_user_questions` 持久化、单 pending、提交校验和恢复通道；这是 host 直接发起的确认，不依赖已被压制的 `agent_interaction` 工具曝光。
- 这张卡只能由本机 Renderer 作答：远程绑定会话不得发起本机设置确认，卡片不得转发到远程渠道，提交核心也必须在写库前拒绝远程答案。
- 选“开启工具调用”后，仅把当前活跃配置的 `toolUseMode` 写为 `on`。写入前必须核对 active profile id + provider/baseUrl/model 指纹，防止卡片等待期间切换到内容相同的另一配置后改错对象。
- AI workspace、当前配置与兼容镜像必须在同一数据库事务内写入；任一步失败全部回滚，不得留下三份设置互相矛盾的半写状态。
- 写入成功后记录 scope、run、agent、card id、旧值和真实确认入口；本轮在旧工具面上启动，不伪装成已经执行原任务，明确提示用户重发上一条任务。
- 选“保持关闭”不写设置；卡片取消、被新消息替代、超时和持久化失败都必须有确定终态，不能挂死运行。
- 禁止聊天文本直接写设置，禁止给模型设置写权限。

### C5. 工具账单必须使用实际 ModelRequest

- `provider_request_bill` 与 `provider_wire_request_bill` 的 `toolSchemaCount` 必须从 provider 边界收到的同一个 `ModelRequest.tools` 读取；不得为了统计再次执行动态 `isEnabled`，也不得用 Agent 注册全集近似。
- 可额外记录注册工具总数与关闭数量用于诊断，但不得把注册全集命名为 wire 工具数。
- 每次实际请求的 instructions、input 与 tools 必须在同一边界成对记录；压缩前诊断账单和线上账单可区分，但工具数都必须来自该次实际请求。
- `toolCallTransport='none'` 且无 capability floor 时，实际 provider request 与 wire bill 都必须是零工具；有地板时两者必须等于地板工具数。动态启用判断即使每次返回不同结果，实际请求与账单也必须严格相等且只判断一次。

### C6. 保守能力合同不变

- 不把任意 OpenAI-compatible 的 `auto` 默认改成开启。
- 不为浏览器、文档或技能添加绕过 capability resolver 的后门。
- 不新增自动探测请求。本次只修可见性、同意和统计；能力探测需另立失效、成本与误判合同。

### C7. 当前运营 Agent 工作不被覆盖

- 工作区现有的 `operator` 身份、迁移 079/080、内置 `social-media-ops` 技能及其测试属于同一轮未提交成果，需独立验证后保留。
- 迁移 079 必须把任何占用保留 slug、但不完全等于内置身份与内置人格的记录视为用户冲突，包括顶层 active agent；先无损改名和搬迁人格，再补内置运营身份。
- 迁移 080 只修复历史 064 已经造成、且能由迁移账本和精确占位人格唯一证明的错绑；用户改过或证据含糊的状态保持不动。
- 社媒运营技能不得把仅返回缓存坐标证据的截图工具写成可供主模型视觉判断；页面视觉判断使用能返回分析结果的现有入口。
- `.DS_Store`、构建缓存和临时验证产物不得进入提交。
- 运营 Agent 是否存在不影响工具能力裁决；测试必须分别证明“身份可用”和“工具总闸门可解释/可开启”。

## 实施范围

1. 设置页工具调用文案与纯函数测试。
2. capability resolver 冲突事实、SDK live 传递、metric 与 SystemReminderRegistry 提醒。
3. host-owned 工具开启确认卡、本机回答限制、完整配置身份核对、原子持久化与审计。
4. provider 账单在实际 ModelRequest 边界读取 tools，不重复动态裁决。
5. 运营 Agent、社媒运营技能与 fresh/upgrade/历史修复迁移闭环。
6. 更新 `docs/architecture/current-runtime-contracts.md` 的 Provider/工具面合同与本计划实测记录。

## 明确不做

- 不改变按 agent 隔离会话的合同。
- 不新增“携带上一 Agent 消息”入口。
- 不自动把现有本机配置改成 `on`；真实用户确认仍由应用内确认卡完成。
- 不把 OpenAI-compatible 能力探测塞进保存配置或首轮请求。
- 不修改运营 Agent 的人格与方法论内容，除非验证发现确定缺陷。

## 验收

### 焦点行为

- OpenAI-compatible + `auto` 设置文案显示“当前=关闭”，内置 provider + `auto` 显示实际开启值。
- 浏览器 + 文档请求在工具总闸门关闭时产生对应冲突事实并注入提醒；普通闲聊与否定浏览器请求不产生冲突。
- “我授权你使用浏览器工具”在本机会触发一张确认卡；确认后只写当前 profile 的 `toolUseMode=on`，拒绝不写；profile 或配置指纹变化时拒绝误写，写入失败时三份设置全部回滚。
- 远程绑定会话不能创建或回答本机设置确认卡；普通反问卡的远程回答能力保持不变。
- provider 捕获的 `ModelRequest.tools`、request bill 与 wire bill 三者数量相等；动态 `isEnabled` 只执行 SDK 自身的一次，latent skill tools 不再进入 wire 账单。
- fresh 数据库、既有数据库补种、顶层保留 slug 冲突和历史 064 明确错绑修复均通过真实 SQLite；含糊或用户编辑状态不被迁移覆盖。

### 回归 gate

- 新增焦点测试全部通过。
- `npm run typecheck`
- `npm run verify:streaming`
- `npm run verify:stability`
- capability floor、skill activation、ask-user、Settings 与 provider bill 既有测试通过。
- 因当前工作区包含迁移与 SQLite 行为：`npm run verify:native` 必须零 skip 通过。
- `npm run verify` 与 `npm run build` 通过。
- 真实 Electron 在隔离 userData 下复现“auto 关闭 → 原因可见 → 明确授权 → 确认写入 → 下一轮工具可见”，日志中工具面与 wire 账单一致。

## 完成记录

### 实施结果

- 同一份 live capability resolution 现在同时决定最终工具面、冲突事实、模型提醒与是否进入本机确认；普通闲聊、否定浏览器表达、默认技能目录以及“当前打开了哪些标签页”这类任务动作都不会伪造设置授权。
- 设置页展示 `auto` 的真实生效值；确认卡只有本机 Renderer 可答，远程绑定会话不能发起或代答。确认写入核对 active profile id 与端点指纹，只改单个开关，并把三份设置放在同一事务内。
- provider request/wire 账单直接绑定实际 `ModelRequest`，不再为统计二次执行 `isEnabled`；注册数、关闭数与线上数分开记录。
- 内置运营 Agent、`social-media-ops` 技能、迁移 079 补种与迁移 080 历史精确修复均保留并补齐反例保护。浏览器工具面的另一份审查文档保持 `enforce:false` 独立提案，本轮未把其建议混入生产改动。

### 对抗复审

按要求只启动一个独立 Agent 做对抗性审查。它找出并推动修复了：配置身份核对缺 profile id、远程渠道可修改本机设置、工具统计二次判断、历史迁移无法前向修复、顶层同 slug 用户身份可能被覆盖、否定浏览器表达误报、授权否定词不足、社媒技能误用截图结果，以及设置多键写入不原子。复审后的实机验证又发现“打开的标签页”被误认成“打开工具权限”，已继续修复并加回归测试。

### 自动验证

- 焦点行为：工具冲突/确认/远程拒绝/原子设置/账单/迁移/运营技能测试通过；最终新增授权语义回归 14/14 通过。
- `npm run verify:context-instrumentation`、`npm run verify:streaming`、`npm run verify:stability`、`npm run verify:native` 均通过。
- Electron 原生迁移场景通过，迁移编号检查为 1–80 连续；`npm run skills:lint -- assets/embedded-skills/social-media-ops` 通过。
- 最终 `npm run verify` 通过：原生 ABI、版本、类型、静默异常、移动边界、CSS、IPC、并行/串行/性能测试全部结束为零失败。
- 最终 `npm run build` 通过；`git diff --check` 通过。

### 隔离 Electron 实测

使用临时 userData 与本地假模型，以真实「运营」Agent 完成全链：`auto` 关闭时第一轮线上请求为 0 工具且不误弹授权卡；明确授权后只出现一张本机确认卡，确认本身不调用模型；重发后连续两次实际请求各带 87 个工具并真实调用 `browser_get_tabs`。wire bill 同步记录 `0 / 87 / 87`，注册数为 `17 / 104 / 104`，关闭数均为 17；界面、请求、审计与数据库的 active profile 都回读为一致。临时数据库、配置和进程已全部清除，真实用户数据未触碰。
