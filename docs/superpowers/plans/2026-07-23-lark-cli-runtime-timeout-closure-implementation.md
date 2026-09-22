---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# 飞书 CLI 运行链与超时收口实施合同

> 日期：2026-07-23
> 状态：implementation
> 范围：本地 CLI 技能执行、飞书渠道意图分流、Dynamic Delivery 工具执行时钟、超时可见收口

## 1. 已证实的现象

目标运行 `req-1784794339577-0k3h9f` 先把“飞书 CLI”解释成
`channel_feishu`。本地会话没有配置 Feishu sidecar，因此能力冲突提醒把它描述成
“本地运行环境不可用”，模型进一步误写成“没有安装/登录飞书 CLI”。

真实机器状态与该说法相反：

- `lark-cli` 已安装，版本为 `1.0.76`；
- `lark-cli auth status --json --verify` 返回 `verified: true`；
- 用户身份拥有 `search:message`、`im:message:readonly`、`im:chat:read`；
- `lark-cli im +messages-search ...` 已真实返回消息和下一页游标。

用户批准安装/配置后，第一条安装命令成功；第二条
`lark-cli config init --new` 没有返回。CLI 自身帮助明确说明该命令会阻塞，直到用户在
浏览器完成新应用创建。它不是当前已登录环境的健康检查，也不该在已有有效配置时运行。

运行时的 adaptive 无进展窗口为 120 秒，而 `run_setup_command` 的命令超时为 180 秒。
确认卡恢复后，工具开始执行没有刷新或接管外层时钟，因此外层先中止整轮。命令执行器来不及
返回包含 stdout/stderr 尾部的具体超时错误，最终收口又把上下文丢成
“任务因运行时间达到上限而停止”。

## 2. 根因层级

### 2.1 能力身份混淆

`channel_feishu` 代表 Ready 已连接的 Feishu sidecar/channel 工具，调用需要
`channel_id`。它不代表本机 `lark-cli`。只要文本出现“飞书/lark”，现有意图层就会申请
`channel_feishu`，从而制造错误的环境缺失解释。

### 2.2 Agent Skill 标准缺了一种可执行面

`~/.agents/skills` 的飞书技能声明 `metadata.requires.bins: ["lark-cli"]`。Ready 可以只读
发现并由用户导入这些技能，但当前只把 `scripts/` 目录视为可执行面：

- 没有 `scripts/` 就不开放 `skill_run_shell`；
- shell 同意开关也不会显示；
- `lark-cli` 不进入当前技能的临时命令白名单。

因此技能即使导入，也只能给模型看方法论，不能调用它声明的本地程序。

### 2.3 工具执行时钟没有进入 Dynamic Delivery 的进展合同

Dynamic Delivery 只把文本、推理增量、用户输入恢复和工具结果算作进展；工具开始到工具结果
之间没有执行态。只要单个合法工具自身的超时大于 120/240 秒，外层就可能先将整轮误杀。

### 2.4 超时收口丢失最后执行现场

deadline abort 只输出固定句子，没有保留正在执行的工具、开始时间、预期上限和安全参数摘要。
用户无法区分“模型停住”“工具等待人工交互”“命令自身超时”或“运行被新消息接管”。

### 2.5 安装命令入口常驻，诱导模型绕过技能

`run_setup_command` 虽然合同只允许安装和配置，但 `command_exec` 在所有本地对话默认可见。
修复前三项后，真实运行不再申请错误的飞书渠道，却仍把只读的
`lark-cli auth status --json` 送进安装命令确认卡。该入口会与 `use_skill` 竞争，导致模型
绕过已导入技能，并把普通读取误报成会修改本机环境的安装操作。

### 2.6 同轮激活漏接技能声明的兄弟只读依赖

`lark-im/SKILL.md` 明确链接 `../lark-shared/SKILL.md`，要求先读取认证和权限规则。Ready 已有
“显式引用兄弟技能时只增加只读根”的安全合同，但它只在开轮前处理用户附件引用；
`use_skill` 在同一轮动态激活后没有补入技能文档声明的兄弟根。因此模型能读 `lark-im`，
却把合法的 `lark-shared` 链接判成沙箱外路径。

## 3. 实施合同

### 3.1 飞书渠道与本地 CLI 严格分流

1. 明确出现“飞书 CLI / lark-cli / Feishu CLI / 飞书命令行”的本地会话，不得仅因
   `feishu` 域词申请 `channel_feishu`。
2. 远程渠道会话和显式 capability floor 保持现有行为。
3. 不得用“检测到 lark-cli”伪造 `feishuConnected`，因为两组工具的参数与执行后端不同。

### 3.2 导入技能可声明受控本地程序

1. 从标准 SKILL.md frontmatter 读取 `metadata.requires.bins`。
2. 只接受不含路径和 shell 元字符的程序名；破坏性命令不能成为声明程序。
3. reference/advisory 技能在没有 typed action 时，只要有 `scripts/` 或合法声明程序，
   就拥有“可执行面”。
4. 合法声明程序在技能激活后直接可用，不增加 Ready 专属开关；custom 自带的任意脚本仍沿用
   既有脚本同意，embedded 技能仍走默认信任。
5. 未获得脚本同意时，有效 allowlist 只包含该技能声明的程序，不继承 `bash`、`curl` 等
   通用命令，也不继承 `host_requirements` 扩展。
6. 技能中心的同意开关只为技能自带脚本显示，不为声明的本机 CLI 显示。
7. `use_skill` 返回声明程序的直接调用提示，避免模型先用 `bash/sh`、管道或重定向包装后
   产生一次可避免的拒绝。
8. `~/.agents/skills` 仍只读发现，绝不自动导入或写回。

### 3.3 工具执行成为显式运行态

1. 每次模型工具调用在 dispatch 前登记 `{toolName, startedAt, expectedTimeoutMs}`，settle 后注销。
2. 工具执行期间，Dynamic Delivery 外层窗口不得早于该工具登记的执行上限。
3. 多工具并发时按最晚合法执行上限重臂；工具结束后恢复普通 120/240 秒滚动窗口。
4. 用户确认卡的 suspend/resume 与工具执行态可以叠加，任一等待用户输入时不计时。
5. 工具自己的 abort/超时仍是第一责任边界；外层只处理工具超出登记上限后仍未 settle 的失控。

### 3.4 超时必须说明停在哪

1. deadline 中止工具时保存最近被中断的工具快照。
2. 最终用户文案至少说明：
   - 正在执行哪类操作；
   - 若安全，可显示命令名和非秘密参数；
   - 等待了多久以及 Ready 是否已停止；
   - 没有结果不能视为成功。
3. 无工具现场时才使用普通“连续无进展”文案，禁止再用不解释原因的固定句。

### 3.5 安装命令只在明确安装意图下出现

1. `command_exec` 不再作为所有本地对话的常驻工具。
2. 只有用户文本同时包含安装/配置/初始化/升级/授权等动作，以及 CLI、命令行、本地程序、
   包管理器或运行环境等命令目标时才开放。
3. 显式 capability floor 仍可打开该组，已有确认卡续接不受影响。
4. “用飞书 CLI 查消息”只能通过技能目录选择进入；不得把普通读取送进安装命令。
5. “有没有登录”“为什么安装超时”等状态查询或诊断也不得开放安装命令；用户明确要求
   修复、重装或继续配置时才恢复该入口。

### 3.6 技能声明的兄弟依赖只读接通

1. 只识别当前技能 `SKILL.md` 中形如 `../<skill-id>/SKILL.md` 的显式 Markdown 链接。
2. 目标必须已由用户导入/注册，且是 reference/advisory 技能；不自动导入外部目录。
3. `use_skill` 同轮激活时把目标技能根加入 `activeReadOnlyRoots`，不得进入可写根。
4. 不接受绝对路径、`../../`、任意文件链接或未注册目录。

## 4. 行为验证

### 4.1 纯合同

- “飞书 CLI 查消息”不申请 `channel_feishu`；
- “飞书 CLI 查消息”不曝光 `run_setup_command`，“安装并配置飞书 CLI”仍曝光；
- “查看登录状态”“为什么安装超时”不曝光 `run_setup_command`；
- “发到飞书群/更新飞书文档”在 sidecar 可用时仍申请 `channel_feishu`；
- `metadata.requires.bins: ["lark-cli"]` 被解析，非法程序名和破坏性命令被丢弃；
- custom + 声明程序 + 无脚本同意仍开放该声明程序；
- 未获脚本同意时，`bash`、`curl` 等通用命令不随声明程序一起开放；
- `lark-cli` 只在该技能激活轮进入有效 allowlist；
- 同轮激活 `lark-im` 后可只读访问已注册的 `lark-shared/SKILL.md`，但不可写入兄弟目录；

### 4.2 时钟合同

- 20ms 无进展窗口下，登记 80ms 工具后不会在 20ms 被中止；
- 工具 settle 后恢复 20ms 普通窗口；
- 工具超过登记上限后整轮会中止；
- 用户输入 suspend 与工具执行态叠加时不误触发；
- 被中断的 `run_setup_command` 生成包含安全命令摘要的用户文案。

### 4.3 真机闭环

1. 导入本机 `lark-im` 技能，不设置额外执行开关；
2. Ready 真运行中激活该技能，确认最终工具面包含 `skill_run_shell`；
3. 运行 `lark-cli auth status --json --verify`，确认 `verified: true`；
4. 运行本周消息检索，确认返回真实消息与分页事实；
5. 确认日志没有 `channel_feishu environment_unavailable`；
6. 运行专项测试、`npm run typecheck`、`npm run verify:stability`；
7. 涉及设置数据库读写路径，补跑 `npm run verify:native`。

当前已完成 4.1、4.2、类型检查、稳定性验证与 Electron 原生环境验证。本机
`lark-cli 1.0.76`、登录校验和一页消息检索已再次回读成功。Ready 真运行中已新建对话，
在没有安装、配置或执行开关的前提下直接激活 `lark-im`，完成登录校验和消息搜索，并返回
`2026-07-23 17:29｜打工牛马学习群`。本轮四次工具调用全部完成，日志中没有新增
`channel_feishu environment_unavailable`、`cmd_not_allowlisted` 或工具拒绝记录。

## 5. 非目标

- 不把 `lark-cli` 伪装成 sidecar；
- 不自动导入 `~/.agents/skills`；
- 不扩大任意 shell 权限；
- 不为飞书硬编码业务命令或消息搜索流程；
- 不靠延长 adaptive 固定时长掩盖工具生命周期缺失。
