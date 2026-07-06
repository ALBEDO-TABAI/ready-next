# 平台规格与交付约定

## 输出尺寸（由 `.poster` 类保证，截图零配置）

| 画板类 | 尺寸 | 比例 | 用途 |
|---|---|---|---|
| `.poster.xhs` | **1080 × 1440** | 3:4 | 小红书图文（封面 + 内容页） |
| `.poster.square` | **1080 × 1080** | 1:1 | 微信公众号方封面 |
| `.poster.wide` | **2100 × 900** | 21:9 | 微信公众号主封面 |

`deviceScaleFactor=1` 渲染，像素即设计像素。文字多用 PNG；纯照片在意体积可转 JPEG。

## 安全区（画板 padding 已内置，不要再挤边）

- xhs：上 96 / 侧 88 / 下 96（`.content` 已给）；关键文字再留 24px 余量。
- square：四周 88。
- wide：上下 88 / 侧 120；标题放中左带，避免空心中部。

## 小红书组包

- 1 封面（钩子）+ 4–8 内容页 + 可选 1 收束页；大多数帖子 5–9 张。
- 每张只讲一件事；nuance 留给正文文案，卡片承载钩子/对比/清单/锐结论。
- id 命名 `xhs-01`、`xhs-02`…（封面固定 01）。

## 微信封面对

- **必须成对**：21:9 主封面 + 1:1 方封面，同一 HTML 内并排构建，`pair-preview` 合并审查。
- 21:9 保留完整长标题 + 副题 + 一个视觉锚点。
- 1:1 用**短标题**：从长标题提炼「核心对象 + 动作」4-8 字（例：`开源了一个 Skill，让 AI 接管你屏幕边那张便签纸` → `AI 接管便签纸`）；默认无图、大字居中、不塞副题。
- **禁止**把 21:9 裁成 1:1 交差；两张分开构图。

## 文件命名

```text
output/xhs-01-cover.png
output/xhs-02-<topic>.png
output/wechat-21x9-cover.png
output/wechat-1x1-cover.png
output/wechat-pair-preview.png   ← 仅审查用，非交付件
```

（渲染脚本按 poster id 出 `<id>.png`，交付时按上表改名或直接沿用 id。）

## 任务目录形状

```text
cards/                         ← Ready 默认 artifact 子目录；或用户指定的输出目录
  index.html                   ← 从种子模板复制
  assets/                      ← 源图（命名=槽位 id）
  output/                      ← 渲染产物
```

**禁止**把任务文件夹、渲染图落在 skill 根目录旁。

## 校验尺寸

```bash
sips -g pixelWidth -g pixelHeight output/*.png    # macOS
```
