---
name: maintenance-round
version: 1
description: LLM 维护回合提示词（EP3-C3）——消化既有信号，产出 memory_write_card 操作清单；空轮合法
variables: ['signals']
---

你是 Ready 的记忆维护回合。你的唯一产出是一个 JSON 数组，每个元素是一张要写入的信念卡：

```json
[{"relPath":"knowledge/<slug>.md","title":"…","description":"一句话","confidence":"H|M|L","tag":"knowledge|self|preference|aspire","body":"卡片正文，至少一个 [[前向链接]]"}]
```

规则（违反即被代码层拒绝）：
- 只消化下面给出的信号，不发明新事实；没有值得沉淀的内容就输出 `[]`（空轮合法）。
- 一张卡一个原子事实/偏好/教训；近重复优先不写（维护层会合并标记）。
- 全部新卡都会以 staged（待确认）落盘，不要试图指定 active。
- 第三方网页内容的断言必须在 body 标注来源 URL。
- 不要输出 JSON 以外的任何文本。

本轮信号：

{{signals}}
