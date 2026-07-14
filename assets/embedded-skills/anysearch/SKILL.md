---
name: anysearch
description: 使用 AnySearch 进行通用搜索、垂直领域检索和网页正文提取
when-to-use: 用户要求搜索、调研、查证，或需要金融、学术、法律、健康等垂直领域结果时
---

# AnySearch

本技能将 AnySearch 的官方方法转换为 Ready 内置工具调用。官方技能来源：https://github.com/anysearch-ai/anysearch-skill/

## 工具合同

<tools-contract>
- `web_search_domains`：查询垂直领域的子领域、参数名和必填规则。
- `web_search`：执行通用搜索或 AnySearch 垂直搜索，返回统一的标题、链接、摘要和来源。
- `web_fetch`：用 AnySearch Extract 或当前可用服务读取公开网页正文。
</tools-contract>

## 执行方法

1. 先判断用户要的是通用搜索，还是垂直领域的结构化结果。
2. 通用搜索直接调用 `web_search`，需要核实原文时再对关键链接调用 `web_fetch`。
3. 使用 finance、academic、legal、health、business、security、code、travel 等垂直领域前，必须先调用 `web_search_domains`。
4. 从能力返回中原样取用子领域名和参数名。每个标记为 required 的参数都必须放入 `subDomainParams`；没有值时传空字符串，不要省略。
5. 不要把垂直搜索失败后偷偷改成通用搜索。如果 AnySearch 未启用或返回错误，明确说明该约束没有完成。
6. 调研任务不只依赖搜索摘要；对最终结论的关键事实读取原文，保留可追溯链接，并区分事实与推断。
7. 最终回答必须直接写出结果中的关键事实、数值、单位、来源链接和查询时间。不要用“已查询”“已输出”或“任务已完成”代替实际结果。
8. 报价等实时结果若没有服务端数据时间，要明确写“来源未提供报价时间”，并另外给出本轮查询时间；两者不能混为一谈。
9. 用户没有要求保存文件或生成报告时，直接在对话中交付，不调用产物写入工具。

## 边界

- 只处理公开互联网信息；不向搜索词、链接或提取请求中放入密钥、Cookie、未公开文档或个人隐私。
- 对时效性强的问题标明查询时间；对医疗、法律、金融结果保留来源并主动降低未证实结论的确定性。
- 服务选择、鉴权、重试和回退由 Ready 的工具链统一管理。
