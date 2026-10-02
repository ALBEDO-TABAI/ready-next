---
status: implemented-reviewed
enforce: true
---

# RSS 施工前的历史 IPC 合同清理

## 范围与根因

用户授权先提交历史工作并清理过期/冗余内容。存储拆分已提交为 `4fc3f510`；本清理独立提交，不混入 RSS 新功能。

历史 38 项报警来自三个明确边界：

- 六个 Agent 调用实际存在于 Preload，但通用调用包装使静态检查漏掉真实频道。
- 十二个事件转发点依赖按行号登记的过期豁免，登记的 `channels[]` 没有进入生产者/接收者对账，已漏掉几个真实频道。
- `document:cancelReindex` 没有 Preload 或 Renderer 消费者，下游独立 worker 命令也只有该入口与测试引用。

## 已采用方案

1. Preload 在调用点显式执行字面量 `ipcRenderer.invoke`，通知包装只负责等待请求成功再通知。使用 thunk 保留原异步异常语义。
2. 服务声明其真实输出频道的有限字面量类型；中心转发器消费这些类型。检查器通过 TypeScript 判断频道，有限联合中的每个成员全部进入既有发送/接收对账，开放字符串仍失败。
3. 删除非字面量转发豁免机制及全部过期条目，不能重新用行号豁免绕过下游检查；也没有延期白名单。
4. 移除孤立的取消重建 IPC/worker 命令和只为它存在的测试，保留真实使用的 worker shutdown 取消与待处理请求收口。

## 完成合同

| 合同 | 验证 |
|---|---|
| 真实调用可见 | Agent 六个调用的字面量进入 invokeHandled/invokeUsed 对账，无新增空调用入口 |
| 字段有正式消费者 | 有限联合的每个频道进入 pushEmitted，缺接收器时检查必须失败 |
| 无旧豁免后门 | string/any/unknown/开放联合拒绝；non_literal_push 配置退役 |
| 真生命周期保留 | shutdown 发给 worker、等待应答、终止 worker，并拒绝仍待处理的请求 |
| 原功能行为不变 | 编译检查及受影响的服务/Preload/索引测试；不删除仍在使用的任务取消能力 |

当前焦点检查：`node --test scripts/__tests__/check-ipc-finite-forwarders.test.cjs`、`npm run verify:ipc-contract`、类型检查，以及索引/分组注册/关闭行为测试。独立对抗复核只读审查同一 diff，发现问题先修再关闭本项。

## 验证与对抗复审结果

- 3 项检查器反例测试通过：有限联合正常纳入对账、缺失接收方失败、开放类型失败，未跳过。
- 实际 IPC 检查通过：调用 372/372、发送 5/5、推送 49/49、公开方法 33/33；豁免 0，历史 38 项已消除。
- 索引、变更事件、注册/注销及 worker 关闭行为 18 项通过，无跳过；类型检查通过。
- 具名只读复审 `storage_review` 未发现阻塞问题，并独立重跑上述 3 项反例和实际 gate。复审指出的 shutdown 旧注释已清理。
- 关闭行为测试验证桥接请求能结束；不把替身测试夸大为真实 worker 内部取消验收。实际 worker 的 shutdown abort 代码保持原样，删除的单独取消命令没有生产消费者。
