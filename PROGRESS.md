# Ready 开发进展

> 更新时间: 2026-03-07

## 本轮完成
1. AI 供应商能力层收口
- 统一引入 `agentProtocol / wireApi / toolUseMode / visionMode / nativeVideoMode`
- 设置页可显式控制 Agent 接口、OpenAI API 形式、工具调用、网页视觉
- `gpt-5.4` 已补入模型选项

2. OpenAI 兼容工具降级链路
- `fox / code.newcli.com/codex/v1` 已按 `responses` 通道识别
- 修复 `responses` 事件流解析与消息序列化兼容
- 新增文本工具桥接与桥接纠偏逻辑，避免在不支持原生 tools 的通道直接失效

3. Browser Agent V7 主链继续稳定
- 任务图、页面证据、附件资源化与结果复核仍是当前主线
- 连续性上下文已接入浏览器决策与 planner，目标是减少重复搜索与重复跳转

4. 技能中心与运行时保持可用
- 系统级 embedded skills 与用户导入 custom skills 并行存在
- 技能说明、默认命令、运行时调度和计划任务链路已具备基础能力

5. 协作文档刷新
- 根目录所有核心项目文档已统一按当前代码状态重写并对齐

## 当前可用主模块
- Browser
- Document
- Design
- Video
- RSS
- Calendar
- Agent
- Skills
- Settings

## 当前已知待优化
- Browser Agent 在复杂网页中的上传、输入、提交证据判定仍在收口
- 文本工具桥接能兜底，但仍受供应商模型是否遵守桥接协议影响
- 远程 IM 的断线恢复与附件消费体验仍需继续增强
- Design / Video 的交互细节与导出链路仍需持续迭代

## 下一步建议
1. 为 Browser Agent 建立更可重复的 smoke 回归样例
2. 继续增强“当前页面可复用”的识别与 planner 约束
3. 对文本工具桥接增加更强的首步动作引导与失败分类
4. 继续完善技能中心、远程 IM 与浏览器工作流之间的上下文贯通
