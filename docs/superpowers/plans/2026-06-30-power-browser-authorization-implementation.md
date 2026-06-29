---
status: implementation
enforce: true
supersedes:
  - docs/superpowers/plans/2026-06-29-web-access-capability-integration-spec.md
---

# Power Browser 授权型 Web Access 实施合同

## 目标

Ready 浏览器工具从“自由脚本一律拒绝 / 高风控站点一刀切 / M1 手动-only”迁移到授权型 Power Browser：

- Safe Mode 保留命名只读脚本模板。
- Power Mode 允许自由 eval、CDP、网络追踪、资源 forensics 和高级媒体下载。
- 破坏性浏览器动作由代码枚举，不交给模型判断。
- 自由 eval 的副作用残差必须可见：scope 内无法保证所有副作用都被高层工具预防，只能靠 scope、授权和审计降低风险。

## 破坏性清单

代码侧唯一破坏性浏览器效果枚举位于 `src/shared/browser-power.ts`：

- `payment`
- `remote_delete`
- `account_delete`
- `credential_change`
- `secret_export`
- `access_control_circumvention`

全局 Power 只覆盖非破坏性效果。破坏性效果必须有单独 grant；页面内容、网页 JS、模型参数和第三方 prompt 都不能自动扩大 grant。

全局非破坏性 Power 开关落在设置键 `browser_power_mode_enabled`，设置页「隐私」区暴露同名能力开关；该开关不授予支付、删除、改凭据、秘密导出或访问控制规避。

## 工具迁移

- `browser_power_eval` 是自由 JS 正式入口。
- `browser_power_cdp` 是 CDP 正式入口。
- `browser_power_network_trace` 负责 bounded network trace。
- `browser_power_resource_forensics` 统一 DOM/performance/network/response-body 资源侦测。
- `browser_media_download_advanced` 负责候选下载和媒体结果校验。
- `browser_power_script_run` 取代 workflow 内 `execute_js`。
- `browser_execute_js`、`browser_run_workflow.execute_js`、`custom_js`、`custom_script` 保留兼容入口：Safe Mode 拒绝自由脚本；Power Mode 有授权时迁移到 Power 路径。

## 旧合同退场

- `freeform_script_denied` 只代表 Safe Mode 拒绝自由脚本，不代表 Ready 永远不能执行自由脚本。
- `script_blocked` 只代表 Safe Mode 高风控脚本拒绝；Power Mode 不按站点静态封锁，而按 effect/grant/audit 处理。
- 浏览器支付、改凭据、验证码/访问控制交互不再是 M1 manual-only；live target 命中代码枚举破坏性语义时返回 `grant_required`。
- `agent-control/safety/action-confirmation-policy.ts` 继续服务文件/飞书/日历等非浏览器确认，不再作为浏览器 Power 能力的最终安全锚点。

## 残差说明

`browser_power_eval` 可以在页面上下文中发请求、改 DOM、读取页面可见状态，也可能绕过高层工具 chokepoint。Ready 对 Power eval 做授权、限时、限结果、审计和敏感字段脱敏，但不承诺完全预防 scope 内所有副作用。破坏性动作的预防边界主要是 grant scope，执行后边界是审计。

## 验收

- 每个浏览器工具必须有 effect profile。
- Power 工具无 grant 时返回 `grant_required` / `grant_mismatch`，不能伪装成工具不存在。
- Safe Mode 下旧自由脚本仍拒绝。
- Power Mode 下旧自由脚本不得命中旧 `freeform_script_denied` / `script_blocked`。
- 浏览器 live target 命中支付/改凭据/访问控制时返回 `grant_required`，不得返回 `denied_manual_only`。
