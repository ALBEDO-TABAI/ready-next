---
enforce: true
status: implemented
date: 2026-07-12
---

# Tag Forge + Boost 文件夹批量打标四层收口合同

## 完成条件

1. typed `folder_reference` 在 SDK live 能力面与 dormant parity 面均被识别为本地文档资源。
2. 显式选择 `tag-forge` 且存在文件夹资源时，最终工具面必须包含只读盘点、正文读取、批次准备与批次受控写回；不得因此开放通用 shell 或通用文件写面。
3. 批次准备必须返回完整 Markdown 正文与代码计算的 revision；批次写回只接受同一批次路径，并逐文件做 revision CAS、原子写入、磁盘回读与索引回读。
4. 批次进度必须持久化；已完成文件不重复处理，失败或冲突文件保留并可在下一轮重新准备，单轮工具预算不再与文件数线性绑定。
5. Dynamic Delivery 无进展计时在 pending user input 期间暂停；用户输入解除后重新计时。
6. 独立复核的输出合同必须显式给模型；任何非合同输出安全降级为 block 并落可追踪指纹，不得抛错后遗留 pending。
7. stale projection 收口前必须合并 `run_meta.continuationRef`；存在真实 durable handle 时恢复 projection，不得清空续跑入口。
8. 终态任务卡不得显示“等待独立复核”。
9. Tag Forge 三个受控写入工具必须同时注册在 `file_management`、解析为 `file` 执行域并按写操作串行；统一工具入口不得把它们送进 system handler。
10. `degraded_visible` 只能保留至少满足一条完成判据的部分成果；多步任务即使产生了失败工具回执或盘点结果，只要完成判据满足数为 0，就不得写成成功或完成。
11. 显式打标遇到任何未审核新词时不得写回或关闭文件项；结果必须进入 `waiting_review`，给出“设置 > 文档标签”审核位置和原 `batchId` 的续跑参数。
12. 封闭 facet 的未知值在自动模式仍拒绝；在用户显式打标模式中必须进入待审核，只有用户转正后才可成为 active 标签。用户废弃的同 facet/label 不得在重试时再次进入待审核。
13. 显式打标在没有 active 标签且也没有待审核项时必须失败且不改文件；`completed_sparse` 至少包含一个已批准 active 标签。

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
- 不改写内置 Tag Forge 词表，不改变 facet 配额和语义判断方法。
- 不修改用户已有标签；默认跳过已有 tag/frontmatter 的文档。
