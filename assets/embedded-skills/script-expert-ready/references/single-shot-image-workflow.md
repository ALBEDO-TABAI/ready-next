# 单镜生图与 Markdown 回填流程

用于用户要求“生成某个镜的分镜图 / 参考帧 / line art / shot image / 给 Shot 06 生图 / 把图插回分镜”时。

目标：读取指定镜号下的信息卡内容，使用用户已配置好的生图 API 生成图片，然后把图片 Markdown 链接插回该镜号 `### 5. 参考帧` 字段的独立代码块内。

## 触发场景

进入本流程：

- 用户要求“生成某个镜的分镜图”。
- 用户说“把 Shot 06 生成参考帧 / line art / 图片”。
- 用户要求“读取镜号下所有信息来生图”。
- 用户要求“生成后把图片链接插回镜号下方”。

如果用户只要求写分镜，不生图，使用 `shot-card-format.md` 或 `shotlist-template.md`，不要调用生图 API。

## 前置条件

执行前确认：

1. 已存在分镜信息卡文件，或当前会话中有指定镜号的信息卡内容。
2. 用户指定了镜号，如 `Shot 06`、`镜 6`、`第 6 镜`。
3. 用户配置好的生图 API 在当前环境可用，或已有 workspace 的 media-generation / image API 工作流。
4. 若没有可用 API 或凭据，不要编造图片；标记为 blocker，并说明需要用户配置或授权。

## 读取镜号信息

从指定镜号的信息卡读取以下字段：

- 镜号 + 时长
- 画面
- 镜头
- 动作
- 视频提示词
- 参考帧现有路径或要求
- 保留项
- 避免项目

优先使用 `视频提示词` 作为主 prompt。若视频提示词偏视频运动，生成静态参考帧时要转成静态图 prompt：保留主体、构图、镜头、光线、材质、保留项和避免项，减少“连续 5s”等视频时长语句。

## 生成 prompt 组装规则

### 静态参考帧 prompt

包含：

- Shot 编号和用途：reference frame / storyboard line art / concept frame。
- 主体：角色 / 道具 / 空间 / 动作瞬间。
- 构图：景别、机位、角度、可见身体范围。
- 光线：光源方向、明暗、质感。
- 风格：若用户要 line art，明确 black-and-white line art / clean storyboard sketch / low-detail tonal shading。
- 保留项：从信息卡第 6 项提取。
- 避免项目：从信息卡第 7 项转成 negative prompt。

### Line art 默认 prompt 增强

当用户没有指定风格但效果图方向是分镜线稿时，使用：

```text
clean cinematic storyboard line art, black and white pencil line drawing, minimal shading, clear subject silhouette, accurate perspective, 16:9 frame, production storyboard, no color, no text overlay
```

### 负面 prompt

从“避免项目”提取，并补充通用负面：

```text
no extra limbs, no distorted hands or feet, no face drift, no age drift, no extra characters, no text overlay, no logo, no watermark, no wrong costume, no wrong location, no exaggerated fisheye unless specified
```

## 输出路径规则

默认保存到当前项目资产目录：

```md
assets/shotXX-line-art-v1.png
```

如果已有项目目录，则放入该项目目录的 `assets/`：

```md
项目名/assets/shot06-line-art-v1.png
```

版本规则：

- 初版：`shot06-line-art-v1.png`
- 迭代：`shot06-line-art-v2.png`
- 彩色概念帧：`shot06-concept-v1.png`
- 关键帧：`shot06-keyframe-v1.png`

不要覆盖已有图片。

## Markdown 回填位置

生成图片后，把链接插入指定镜号信息卡的 `### 5. 参考帧` 字段代码块内。保持该镜头原有的 `---` 分割线 + Shot 标题大块结构，不要插到 Shot 大块外部、文件末尾，或把整个 Shot 改成一个代码块 / `<details>`。

回填格式：

````md
### 5. 参考帧
```md
![Shot 06 line art](assets/shot06-line-art-v1.png)

时长：5s
主动作：脚步带动鞋体高速向前，镜头低位同步后撤，风压和粒子被拉开。
镜头运动：low tracking retreat
音频：强风切，节奏重击
```
````

如果 `参考帧` 字段代码块内原来已有纯路径：

```md
assets/shot06-line-art-v1.png
```

在该字段代码块内替换为 Markdown 图片链接，并保留后续时长、主动作、镜头运动、音频信息。

## 工具调用原则

- 使用用户配置好的生图 API 或 workspace 的媒体生成能力。
- 不在 skill 文档里硬编码 API key、账户、私密 endpoint。
- 若需要读取环境变量或配置文件，先使用现有安全配置；不要要求用户在聊天中贴密钥。
- 生图失败时，保留信息卡，并在 `### 5. 参考帧` 字段代码块内写明失败原因和下一步，例如“等待生图 API 配置”。

## 完成后的返回

会话中只返回简短摘要：

```md
已生成并回填 Shot 06 参考帧：
- 图片：`项目名/assets/shot06-line-art-v1.png`
- 已更新：`项目名_第X场逐镜头信息卡.md`
```

如果不能生成：

```md
暂时无法生成 Shot 06 参考帧：当前环境没有可用的生图 API 配置。信息卡已保留，下一步需要配置生图 API 或提供可调用的媒体生成工具。
```

## 质量检查

回填前检查：

- 图片是否对应正确镜号。
- 主体、场景、道具、保留项是否一致。
- 是否出现避免项目里的错误。
- 图片路径是否相对当前 Markdown 文件可访问。
- Markdown 链接是否在该 Shot 的 `参考帧` 字段代码块内，而不是 Shot 大块外部或文件末尾。
