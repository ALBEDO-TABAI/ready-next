# Ready Next Phase Plan - 2026-03-08

## 当前执行前提
1. agent/runtime 拆分已落地。
2. browser main-process service 化与 renderer shell 拆分已落地。
3. repository 基线已落地，并清掉了旧 `database.ts` 告警。
4. design/video/rss/calendar 的 module handler 已从页面组件中抽离。
5. RSS runtime、diagnostics、benchmark、browser-backed acquisition 基线已落地。

## 接力执行顺序
1. RSS 三条源收尾。
- Weibo：把 Chromium/session 默认恢复路径做稳。
- Xiaohongshu：继续以 app browser acquisition 为主线，完成应用内真实刷新链签收。
- Douyin：继续以 app browser acquisition 为主线，完成账号作品区 extractor 与 UI 刷新结果的一致性签收。

2. 工作台顶部三行与 tabs 视觉基线收口。
- 严格对齐用户标出的左右边界。
- 第一行保持紧凑，不再额外放宽。
- 第二行 tab rail 与第三行 toolbar rail 必须在 browser/document/design/calendar 下都共线。
- tabs 视觉继续以 browser baseline 为准。

3. Design inspector 高频能力补齐。
- 圆角
- 字号
- 字重
- 行高
- 对齐
- 常用版式与基础布局控制

4. Browser orchestration 与 diagnostics lab。
- 继续收紧 browser controller 剩余 orchestration。
- 把当前 diagnostics panel 逐步提升为真正 lab 入口。

5. `PromptAssemblyService + L0/L1/L2 memory`。
- 这是下一条尚未启动的主线，不再和前面的 UI/RSS 收尾混做。

6. `Feishu capability replacement`。
- 等 memory 路线起稳后再接入。

## 默认约束
- RSS 主链继续保持 `lets-go-rss / native / RSSHub`。
- Scrapling 仍然只是候选 fallback，不是默认主链。
- `Weibo / Xiaohongshu / Douyin` 的 browser-backed acquisition 继续优先复用应用内 browser controller/session。
- 不要重新引入外部 cookie 方案作为小红书主路径。
- 不要回头重复做已经完成的 runtime/repository/browser-service 重构。
