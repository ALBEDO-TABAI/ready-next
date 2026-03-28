# 2026-03-15 Document Widget Phase Backlog

## T0

### 目标
- 让生成式 UI widget 在文档里不仅能插入，还能被列出、更新、删除。
- 让 agent 对已有 widget 的维护从“整篇替换”升级为“按 widget 粒度维护”。

### 已纳入 T0 的任务
- 新增 `document_list_widgets`
- 新增 `document_update_widget`
- 新增 `document_remove_widget`
- direct-chat 补充 widget 维护 guidance
- 文档动作层补齐 widget 目标解析、按标题/序号定位、更新与删除
- `/doc` 命令补充 `list-widgets / update-widget / remove-widget`
- 回归测试补齐 widget 维护能力

### T0 完成标准
- agent 可以列出当前文档 widget
- agent 可以按标题或序号更新已有 widget
- agent 可以按标题或序号删除已有 widget
- 这些操作不会误伤其他正文

## T1

### 目标
- 把编辑态从“原始 fence 文本”升级为“可理解的 widget 占位块”。

### 计划任务
- 编辑态 widget 占位块
- 查看源码
- 删除 widget
- 复制源码
- 直接跳预览
- 编辑态与预览态定位对齐

## T2

### 目标
- 提升通用适用性、视觉质量和端到端稳定性。

### 计划任务
- 更硬的 tool-choice / 写入后自动校验与重试
- 多类型 widget 基线样例与回归
- 更完整的错误态和调试日志
- 视觉统一和多 widget 混排优化

### 当前完成情况
- widget 任务已按 `create / inspect / update / remove` 区分并收窄工具集
- 查询型 widget 工具结果会直接交付用户，不再只说“调用了工具”
- widget 写入失败会触发一次运行时纠偏提示
- 编辑态 widget 卡片补齐：预览、查看源码、复制源码、删除确认、让 agent 更新、展开状态记忆
- 新文档另存为与草稿持久化已接入
- widget 基线文档已补齐，供生成 prompt 和回归使用
