---
enforce: true
status: implemented
date: 2026-07-12
---

# Tag Forge + Boost 文件夹批量打标四层收口合同

## 完成条件

1. typed `folder_reference` 在 SDK live 能力面与 dormant parity 面均被识别为本地文档资源。
2. 显式选择 `tag-forge` 且存在文件夹资源时，最终工具面只额外保留批次准备与批次受控写回；盘点和正文读取由准备工具内部完成，不向模型开放通用盘点、全文提取、shell 或通用文件写面。
3. 批次准备必须返回完整 Markdown 正文、代码计算的 revision 与不透露主机路径的 `itemId`；批次写回只接受同一批次的 `itemId`，并逐文件做 revision CAS、原子写入、磁盘回读与索引回读。
4. 批次进度必须持久化；已完成文件不重复处理，失败或冲突文件保留并可在下一轮重新准备，单轮工具预算不再与文件数线性绑定。
5. Dynamic Delivery 无进展计时在 pending user input 期间暂停；用户输入解除后重新计时。
6. 独立复核的输出合同必须显式给模型；任何非合同输出安全降级为 block 并落可追踪指纹，不得抛错后遗留 pending。
7. stale projection 收口前必须合并 `run_meta.continuationRef`；存在真实 durable handle 时恢复 projection，不得清空续跑入口。
8. 终态任务卡不得显示“等待独立复核”。
9. Tag Forge 四个受控工具必须同时注册在 `file_management`、解析为 `file` 执行域并按写操作串行；模型只暴露 prepare/apply，review 由宿主内部执行，统一工具入口不得把它们送进 system handler。
10. `degraded_visible` 只能保留至少满足一条完成判据的部分成果；多步任务即使产生了失败工具回执或盘点结果，只要完成判据满足数为 0，就不得写成成功或完成。
11. 显式打标先写入已确定标签；置信度不低于 0.92、文内证据直接出现标签名的新 domain/entity/use，只受单文档内容标签总上限 6 约束并直接采用。其余存疑项在文件夹扫描结束后汇总到 Agent 对话；同一 folder run 最多一张、最多 35 项，超出容量的低置信候选直接忽略，不制造第二张卡或无卡等待状态。用户回答后由宿主自动续跑原 `batchId`。
12. 封闭 facet 的未知值在自动模式仍拒绝；在用户显式打标模式中必须进入对话反问。用户忽略的精确 proposal id 只对原批次和文档生效，同一审核卡重放必须幂等。
13. 显式打标本轮自动负责的内容标签必须有且仅有一个 form，并包含 domain 或 entity；用户手工标签原样保留，不转为自动标签或全局词表项。当前文档已有且能由受控词表标签或别名确定 facet 的手工标签直接在该文档内满足覆盖，不依赖模型重复提案且不重复询问。其他必要覆盖可以由待确认提案补齐，但 `waiting_review` 不得产生完成证明。
14. 新文档自动打标不得以缺少 form 或主题标签的稀疏结果完成；每条标签证据必须从最终将落盘的正文中精确回查，正文变化或回读不一致必须拒绝完成并沿原回执重试。

## 验证入口

- `tag-forge-folder-capability.test.ts`
- `capability-floors.test.ts`
- `tag-forge-batch.test.ts`（Electron ABI）
- `run-finalizer-checkin.test.ts`
- `dynamic-delivery-deadline.test.ts`
- `dynamic-delivery-verifier-contract.test.ts`
- `dynamic-delivery-task-card.test.ts`
- `stale-projection-finalizer.test.ts`
- `file-management-zod-golden-snapshot.test.ts`
- `check-capability-gate-enforced-in-arbitration.cjs`

## 非目标

- 不开放任意文件写入或 shell。
- 不开放任意新建 form 或工作流状态，不用代码代替模型做语义选择。
- 不删除用户手工标签；但只有状态标签、内容覆盖不完整或与新策略版本不一致的文档必须重新筛查。
