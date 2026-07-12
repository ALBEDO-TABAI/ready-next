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

## 验证入口

- `tag-forge-folder-capability.test.ts`
- `capability-floors.test.ts`
- `tag-forge-batch.test.ts`（Electron ABI）
- `dynamic-delivery-deadline.test.ts`
- `dynamic-delivery-verifier-contract.test.ts`
- `dynamic-delivery-task-card.test.ts`
- `stale-projection-finalizer.test.ts`
- `file-management-zod-golden-snapshot.test.ts`
- `check-capability-gate-enforced-in-arbitration.cjs`

## 非目标

- 不开放任意文件写入或 shell。
- 不改变 Tag Forge 词表、facet 配额和标签判断方法。
- 不修改用户已有标签；默认跳过已有 tag/frontmatter 的文档。
