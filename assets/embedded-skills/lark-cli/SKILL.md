---
name: lark-cli
version: 1.0.0
description: "通过本机全局 lark-cli 读写飞书中的在线文档、电子表格和云空间，查询日历日程，并在 Ready Agent 对话中完成用户授权。"
metadata:
  requires:
    bins: ["lark-cli"]
---

# Lark CLI for Ready

只使用本机全局 `lark-cli`，通过 Ready 本轮授权的 `skill_run_shell` 执行。不要使用 Browser 代替 CLI，不要绕过 Ready 的工具授权。

## 认证

1. 先执行 `lark-cli skills read lark-shared`，读完认证和最小权限规则，再执行 `lark-cli auth status --json --verify`。只有 `verified` 的用户登录态才可继续。
2. 不要预先申请 drive、docs、sheets 全域权限。先执行当前任务的第一条最小读取；若返回 `missing_scopes`，只选择其中满足当前动作的一项，用 `lark-cli auth login --scope "<exact-scope>" --no-wait --json` 发起增量授权。错误没有给出具体 scope 时停止并说明，不能改用业务域批量授权。
3. 对返回的 `verification_url` 执行 `lark-cli auth qrcode "<verification_url>" --ascii`，把原始链接和命令输出的字符二维码一起显示在当前 Agent 对话里；不要让用户进设置页或调试菜单，不要向用户索要密码、Cookie、Token 或验证码。
4. 用 `skill_ask_user` 等待用户确认已在飞书完成授权。收到用户确认后，才执行 `lark-cli auth login --device-code "<device-code>" --json` 并通过 Ready 的确认卡写入本机凭据，然后自动继续原任务；不要在展示链接的同一时刻阻塞轮询。
5. 不要创建、切换、重命名或删除 CLI profile，不要执行 `lark-cli config`、`lark-cli update` 或 `lark-cli auth logout`；Ready 使用用户已安装的全局 CLI 配置。
6. 专用通道只允许 `drive`、`docs`、`sheets` 和日历只读查询，以及其匹配的最小授权；不要读取其他业务 skill，不要调用其他业务域或 `lark-cli api`。Ready 会在代码侧拒绝越界命令、日历写操作、广域 scope 和不属于当前会话授权流程的句柄。
7. 本通道只操作已经在飞书中的在线资源，不接收本地文件上传或导入；这类请求改走 Ready 的普通附件工作流。

## 执行前必读

- 认证前已经执行并读完 `lark-cli skills read lark-shared`；后续严格遵守其中的最小 scope、split-flow 和退出码 10 规则。
- 文档、表格和云空间任务按需执行 `lark-cli skills read lark-drive`、`lark-cli skills read lark-doc`、`lark-cli skills read lark-sheets`。日历查询执行 `lark-cli skills read lark-calendar`。
- 继续读完这些技能正文指定的相关 reference；不要凭记忆猜命令或参数。

## 任务规则

- 个人文档、表格和云空间操作都显式使用 `--as user`。
- 查询日历时显式使用 `--as user`；“本周还有哪些安排”这类请求用 `lark-cli calendar +agenda --start <本周开始> --end <本周结束后一天> --as user`。当前日历能力只读，不创建、修改、删除或回复日程。
- 始终让 `lark-cli` 作为命令首项直接执行，不套 `bash -c`；普通含空格参数使用双引号，JSON/XML 参数可以使用单引号包成一个 argv，不能拼接管道、重定向或多个命令。
- 本地文件输入一律不支持，改走 Ready 的普通附件工作流；只有下载/导出的输出路径可以使用当前技能产物目录内的相对路径，不能使用绝对路径、`..` 或符号链接。大段正文/JSON 使用 `skill_run_shell.stdin` 配合对应参数的 `-`，不要通过本地文件中转。
- Ready 会冻结全局安装的 `lark-cli` 文件身份并通过绝对路径执行；不要传绝对路径、包装器、`env` 或其他同名程序。
- 用户只给标题时，先按 `lark-drive` 的搜索合同定位资源；同名且无法唯一确定时，用 `skill_ask_user` 让用户选择。
- 根据真实资源类型分别遵守 `lark-doc` 或 `lark-sheets` 的完整合同。
- 写入只做用户明确要求的最小改动；不删除、覆盖或重命名无关内容。表格只在已确认目标为空时使用 `+cells-set --allow-overwrite=false`；已有值的覆盖必须交给 Ready 逐次确认。文档的小范围润色可以使用默认 XML 的 `+update --command str_replace --pattern ... --content ...`，但该命令是全文查找替换，没有绑定当前版本和唯一命中证据时必须由 Ready 逐次确认；不要用 Markdown 跨段匹配代替精确修改。
- 每条外部写入先带 `--dry-run` 预览；确认目标和参数无误后再调用不带 `--dry-run` 的原始命令。Ready 根据当前对话的授权档位决定普通小操作是否显示确认卡；模型不能声称某项已获确认，也不能绕过删除、覆盖、批量、敏感外发和本地文件上传的逐次确认。
- 高风险命令返回退出码 10 时，不得自动追加 `--yes`。只有再次调用同一 argv 加 `--yes` 并通过 Ready 的确认卡后才能执行。
- 表格新增行列时先读结构和样式，依合同继承样式；文档润色先读原文，优先精准修改。
- 每次写入后必须用对应读命令回读验证；只有真实结果符合用户要求才能报告完成。
