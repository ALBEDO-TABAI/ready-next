# ready-human-touch-card-skill

双风格社交信息卡生成 skill（小红书 3:4 图组 + 微信公众号 21:9/1:1 封面对）：

- **风格 R · Ready 点阵理性** —— 暖纸白 + 橘红点阵字标/点网底/点阵图表 + mono 标签 + 玻璃压图。
- **风格 H · Human Touch 温感人文** —— 蛋壳白 + 水木明体 + 直角零阴影 + 琥珀点图 + 竖排引导语。

## 特性

- 厚种子模板：三种画板（`.xhs` 1080×1440 / `.square` 1080×1080 / `.wide` 2100×900）、微信封面对合成预览、全部组件类与点阵图表 JS 内置；只在 `POSTERS_HERE` 区填卡。
- 渲染确定性：无动画、静态点网/纸纹，`render-cards.mjs` 按 poster id 逐卡出像素精确 PNG。
- **DOM 实测校验器**（C0–C6）：占位残留、溢出、越界与底部空带、最小字号 18px 红线、3:4 密度（闭合量法 ≥52% + 空洞检查，为"让位型"设计语言校准）、风格红线（Human Touch 圆角/阴影，Ready 衬线）、槽位协议。FAIL 退出码 1。
- **图片槽位协议**：同 PPT skill，槽位 id=`{posterId}-{语义}`，空槽铭牌 + `--only` 单卡重渲染。

## 安装与使用

```bash
# Ready 内按 SKILL.md：skill_read_artifact 读模板 → skill_write_artifact 写 cards/index.html
node "$CLAUDE_SKILL_DIR/scripts/list-image-slots.mjs" cards/index.html
# Playwright/Chrome 已可用时再截图和 DOM 校验；不可用则交付 HTML
node "$CLAUDE_SKILL_DIR/scripts/render-cards.mjs" cards/index.html cards/output
node "$CLAUDE_SKILL_DIR/scripts/validate-cards.mjs" cards/index.html
```

## 目录

```
SKILL.md                          工作流与硬规则（入口）
assets/template-ready-card.html   风格 R 卡片种子
assets/template-human-touch-card.html     风格 H 卡片种子
references/                       设计语言×2 / 配方 RC01-RC10 & HC01-HC10 / 平台规格 / 图表 / 槽位 / 清单
scripts/                          render-cards / validate-cards / list-image-slots
local-tests/demo-ready/           演示卡组（4 张 xhs + 微信封面对，含真实截图卡）
local-tests/demo-human-touch/             演示卡组（3 张 xhs + 微信封面对）
```

## 已验证

- 两组 demo 共 11 张卡渲染（尺寸像素精确）+ 校验全绿（0 FAIL 0 WARN）+ 人工目检。
- 密度阈值 52% 为经验校准值：目检成立的卡闭合占用 ≥54%，嫌空的 ≤48%。
- 图表配色沿用已过六检的双风格结论；微信封面对合成预览可用。
