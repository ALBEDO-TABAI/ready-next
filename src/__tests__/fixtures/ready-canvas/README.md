# M4-A 合成夹具

全部为手工构造的非用户资料，无网络依赖。`valid/all-types.canvas` 包含四种标准节点、全部 Ready kind、两条边、回收项和三类图形；child.canvas 为对应子画板。invalid 中每份只破坏一种规则，文件名即原因。

readyboard.json 按仓内 ReadyBoardState 构造；stillroom.json 按 Stillroom space.json 的 notes 顺序与字段构造（crop.x/y 是 0–100 的 object-position，w/h 为 1）；plain.json 为无 Ready 扩展的 JSON Canvas。

测试用 TextEncoder 生成可重复的附件字节，只验证复制清单、哈希、引用与去重，不冒充真实图片/音视频解码或磁盘导入验收。生成的 SVG 是实际可解析图形。可通过修改这些小型 JSON 直接重建夹具，无需生成器。

运行：`npm run verify:canvas-format`。脚本分别要求 valid 全部通过、invalid 全部被拒；测试另覆盖只读版本、路径变体、跨画板关系及命令行退出码。
