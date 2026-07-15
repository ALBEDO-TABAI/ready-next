# Worked Example：18 个候选归一为 12 个独立连接标签

一份现代中世纪室内设计作品包含这些候选：3dsmax、Corona Renderer、Adobe Photoshop、interior design、design、3д、artwork、CGI、architecture、archviz、house、Render、3D Art、Architecture Visualization、mid-century、minimal、raw textures、soft light。

标签数量不是问题本身。真正要处理的是同义重复和宽泛词，同时保留风格、空间、材质、光线、制作方式和工具等互补连接维度。

## 归一

| 候选组 | 结果 | 理由 |
|---|---|---|
| artwork、design | 不单独保留 | 太宽泛，已有更具体的室内设计和灵感采集 |
| 3д、CGI、Render、3D Art | `CG制作` | 属于同一制作方式，只留一个归一标签 |
| archviz、Architecture Visualization | `建筑可视化` | 英文缩写和全称归一 |
| 3dsmax | `3ds Max` | 软件名称归一 |
| interior design、mid-century、house | `室内设计`、`现代中世纪`、`住宅空间` | 分别提供专业领域、风格和空间类型连接 |
| raw textures、soft light、minimal | `材质表现`、`柔和光线`、`极简设计` | 分别提供材质、光线和设计语言连接 |
| Corona Renderer、Adobe Photoshop | 原名保留 | 主要制作工具，未来可跨作品检索 |

## 写回

```yaml
tags:
  - 灵感采集
  - 室内设计
  - 现代中世纪
  - 住宅空间
  - 建筑可视化
  - CG制作
  - 材质表现
  - 柔和光线
  - 极简设计
  - 3ds Max
  - Corona Renderer
  - Adobe Photoshop
ready_state: 待整理
```

结果是 12 个内容标签。它没有为了“简洁”被压成 5 个，也没有保留 6 个互相重复的渲染词。每个标签都提供一条不同的检索路径。

若原文档已经带有导入或手工标签，Ready 原样保留，不替用户删除。模型读取这些标签后，只补充尚未覆盖的独立维度，不重复提交同义词，也不因已有标签较多而停止补充可靠连接。

这个例子说明三件事：

1. 丰富文档拥有 11-15 个标签是正常结果，不需要机械收敛到 6 个以内
2. 增加连接依靠互补维度，而不是同义词堆叠
3. 数量达到安全上限后直接停止，不把纯容量问题交给用户确认
