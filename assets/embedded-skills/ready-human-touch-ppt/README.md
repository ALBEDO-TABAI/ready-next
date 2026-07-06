# ready-human-touch-ppt-skill

双风格单文件网页 PPT 生成 skill（横向翻页 deck）：

- **风格 R · Ready 点阵理性** —— 暖纸白 `#F6F5F1` + 橘红 `#FF4B2B` 点阵字标/点阵场/点阵图表 + mono 标签 + 玻璃浮层。token 逆向自 Ready 应用真实代码。
- **风格 H · Human Touch 温感人文** —— 蛋壳白 `#F4F3ED` + 水木明体 + 直角零阴影 + 琥珀 `#C85B1E` 点图 + 竖排引导语。提炼自"有温度的生活质感"设计语言。

## 特性

- 单文件 HTML：翻页引擎（←→/滚轮/触屏/ESC 索引/`?slide=N`）、WAAPI 动效（零依赖三级兜底）、`B` 键低功耗静态模式、prefers-reduced-motion 尊重。
- **点阵组件**：5×7 dotword 字标（复刻 Ready 启动画面几何：点径=格距 75%、逐列 86ms 点亮）、点阵呼吸场（hero 页专用，离屏降帧）、bar/hbar/waffle/line 四种点阵图表（单位图例+精确直标的量化诚实契约，配色过 CVD 校验）。
- **图片槽位协议**：`data-image-slot` 唯一 id + 空槽自带铭牌 + 枚举脚本——为"后期让 agent 换图"设计，换图 playbook 见 `references/image-slots.md`。
- 版式登记制：R01–R14 / H01–H13，校验器强制。

## 安装与使用

```bash
# Ready 内按 SKILL.md：skill_read_artifact 读模板 → skill_write_artifact 写 ppt/index.html
node "$CLAUDE_SKILL_DIR/scripts/validate-deck.mjs" ppt/index.html
node "$CLAUDE_SKILL_DIR/scripts/list-image-slots.mjs" ppt/index.html
# Playwright/Chrome 已可用时再截图；不可用则交付 HTML + validator 结果
node "$CLAUDE_SKILL_DIR/scripts/render-deck.mjs" ppt/index.html ppt/renders
```

## 目录

```
SKILL.md                    工作流与硬规则（入口）
assets/template-ready.html  风格 R 种子（完整可运行）
assets/template-human-touch.html    风格 H 种子
references/                 设计语言规范×2 / 版式登记×2 / 图表手册 / 槽位协议 / 质检清单
scripts/                    validate-deck / render-deck / list-image-slots
local-tests/demo-ready/     演示 deck（9 页，含真实截图与换图演示）
local-tests/demo-human-touch/       演示 deck（8 页，含空槽铭牌演示）
```

## 已验证

- 两套模板 + 两套 demo（9 页 / 8 页）经 Playwright(msedge) 逐页渲染并人工目检。
- 图表配色过 `validate_palette` 六检（`#FF4B2B` / `#C85B1E` 于各自亮暗面全 PASS）。
- 校验器可拦截：占位残留、未登记版式、风格红线（衬线/圆角/阴影/mono 越界）、槽位协议违规、图表缺 unit。
- 换图协议端到端演示：`local-tests/demo-ready` 第 7 页由空槽升级为真实截图。
