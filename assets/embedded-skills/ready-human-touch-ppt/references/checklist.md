# 质检清单（交付前逐项过）

先跑机器检查，再做人眼核对。机器绿了不等于版式舒服——**必须渲染截图逐页看**。

```bash
node "$CLAUDE_SKILL_DIR/scripts/validate-deck.mjs" ppt/index.html          # 合同校验，exit 0 才继续
node "$CLAUDE_SKILL_DIR/scripts/list-image-slots.mjs" ppt/index.html       # 槽位清单核对
node "$CLAUDE_SKILL_DIR/scripts/render-deck.mjs" ppt/index.html ppt/renders # Playwright 可用时静态截图逐页看
```

## 🔴 P0（违反=整页报废）

- **[必填] 全部替换**：`grep -c '\[必填\]' index.html` 必须为 0（含 `<title>`）。
- **每页 data-layout 已登记**：validator 强制；不许发明 R15/H14 之外的结构（确需实验，先在文档里登记）。
- **风格红线**：
  - Ready：任何位置出现衬线字体=错；渐变大底=错；外部暗阴影=错；点阵场出现在正文页=错。
  - Human Touch：非 0 圆角=错；box-shadow=错；mono 等宽=错；dotword/玻璃面板=错；amber 渐变页 >1=错。
- **图片槽位协议**：本地图必须住 `.img-slot` + 唯一 `data-image-slot` + 标准比例类；照抄原图奇葩比例=错。
- **图表诚实**：数据真实有来源；bar/hbar 有 unit 图例；waffle 只表百分比；无双轴/彩虹/多色系列。
- **中文标题行长**：Ready 每行 ≤8 字（h-display-zh 档），Human Touch 每行 ≤12 字；放不下先改文案。
- **底部安全区**：任何内容（含图注/图例）最低点不进 8vh nav 区——截图看每页最底元素。

## 🟡 P1（排版与节奏）

- 版式多样性：7–8 页 ≥5 种版式；不许连续 3 页同版式。
- 节奏页：≥8 页 deck 至少 1 个 dark（R03/R13 或 H03/H12/H13）；hero 位每 3–4 页一个。
- accent 纪律：Ready 每页橘红元素 ≤5；Human Touch 每页红 ≤1 处、琥珀强调 ≤3 处。
- 正文投屏下限：正文 ≥16px 实际渲染（模板 max() 已兜底，但 inline 覆盖时注意）；图表点径 ≥12px。
- 图文同组一致：多图同页必须同比例同高；`object-position` 逐张指定。
- 空槽铭牌：等图的槽位保持 `is-empty`，不要拿色块 div 冒充。

## 🟢 P2（打磨）

- 动效语义化：图表页用 chart、图片页用 image-hero，不要全 deck 一个 recipe。
- 按 `B` 验证静态模式：内容一次全亮、无残影；Human Touch 静态时气质零损失。
- `ESC` 索引页：每页缩略图可辨认；layout 标签正确。
- 逐页对照两问：这页的一个主角是谁？删掉哪个元素页面反而更好？（有答案就删）
- Ready：mono 标签大小写与字距统一（大写 + .08em）；数字 tabular 对齐。
- Human Touch：正文行距 ≥1.7；英文没有全大写；明体没有加粗到 500+。

## 渲染核对姿势

1. `render-deck.mjs` 默认静态模式（动画终态、确定性）；改 `--dynamic` 检查入场编排是否稳定。
2. 截图后逐页看：标题换行、图片主体、图表可读性、底部安全区、留白是否失衡。
3. 有问题回 HTML 改，再渲染对应页：`--slides 3,7`。
