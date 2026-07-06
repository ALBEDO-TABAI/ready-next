# 卡片质检清单（交付前逐项过）

```bash
node "$CLAUDE_SKILL_DIR/scripts/list-image-slots.mjs" cards/index.html     # 槽位清单
node "$CLAUDE_SKILL_DIR/scripts/render-cards.mjs" cards/index.html cards/output   # Playwright 可用时出图
node "$CLAUDE_SKILL_DIR/scripts/validate-cards.mjs" cards/index.html       # Playwright 可用时 DOM 实测校验（C1-C6）
```

校验器绿了不等于画面舒服——**渲染出来的每张 PNG 都要亲眼看**。

## 🔴 P0（违反=整卡报废）

- **[必填] 全部替换**：`grep -c '\[必填\]' index.html` = 0。
- **C1/C2 溢出与越界**：内容不出画板；`.foot` 用 `margin-top:auto` 钉底（禁止 absolute 压内容）。
- **C3 最小字号**：任何可见文字 ≥18px 红线（目标：正文 ≥28 / 图注 meta ≥20 / 网格 cell 标题 ≥24）。**放不下删字，不缩字号。**
- **C4 密度（3:4）**：闭合量法（组内 ≤48px 间隙算连续）下内容覆盖 ≥52% 画布高，且无相邻空带；禁止 `flex:1` 空 div 夹击；金句/影像 hero 卡加 `data-density-exempt` 且必须有真正的视觉主角。（52% 是"安静但吃满"的经验下限——Ready/Human Touch 的设计性留白不算欠填，细条内容+大空洞才算。）
- **C5 风格红线**：Ready 卡无衬线字体；Human Touch 卡无圆角容器、无阴影、无 mono、无玻璃、无 dotword。
- **C6 槽位协议**：本地图住 `.img-slot` + 唯一 `data-image-slot`；空槽用 `is-empty`；已填图逐张写 `object-position`。
- **图表诚实**：真数据 + 来源；bar/hbar 带 unit 图例；waffle 只表百分比；无双轴/彩虹/多色系列。
- **每卡一件事**：封面是钩子；内容页一页一个论点；说不清主角的卡拆开或删掉。

## 🟡 P1

- 一组卡 chrome/foot 完全一致（栏目、署名、页码格式）。
- 组内版式 ≥3 种形状；不许全组都是"标题+卡片"同构。
- 中文标题分档：1 行 ≤6 字用 display 原档；2 行每行 ≤8 字；再长降 `h-display-sm` 或改文案。
- 微信对：1:1 短标题 4-8 字；两张分开构图；`pair-preview` 里并看气质是否成对。
- accent 纪律：Ready 每卡橘红 ≤4 处；Human Touch 每卡红 ≤1 处。
- 图表点径 ≥16px；bar ≤6 列 / hbar ≤6 行。

## 🟢 P2

- 缩略图测试：PNG 缩到 360px 宽，封面标题仍可读。
- 文字压图卡：先看图的安静区再放字；压不住换图或加局部同色调压暗（不做全幅蒙版）。
- Ready：mono 标签一律大写+字距；数字 tabular 对齐。
- Human Touch：英文无全大写；明体无加粗；行距 ≥1.7。
- 交付回报：输出目录、尺寸核对、空槽清单、图片来源（如有外源图）。
