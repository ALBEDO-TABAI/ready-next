---
title: Ready Next 启动动画：液态玻璃与点成字
date: 2026-11-19
status: implemented
enforce: true
---

# 启动动画：一块液态玻璃，橙红色的点构成 Instrument Serif 的 Ready

用户的要求：启动动画还是旧 Ready 的（白卡片上的点阵扫描）；改成一块液态玻璃做底，用摸鱼工坊 DevDay 视频工程（devday-claude）里的点阵效果：先出现橙红色的点，再由它们构成 Instrument Serif 的 Ready 字标，更有未来感，也更有自己的特点。

本文是这项改动的合同。先合同，后代码；每条都对应一个可运行的检查。

## 1. 不变的约束

- **窗口仍不透明。** macOS 上透明窗口的出帧耦合主进程主线程，启动期的实心同步块会把动画整段冻住（`startup-splash-window.ts` 注释里的逐帧截屏实证）。所以玻璃不是借桌面的真透明，而是页面自己画的：玻璃底下有一层很淡的冷暖色场（左上冷、右下暖），玻璃本身是渐变面、上亮下暗的边缘厚度和一圈锥形渐变的高光边。Electron 45 也没有原生“液态玻璃”接口（只有旧式 vibrancy）。
- **只动 opacity 和 transform。** 所有运动都是 CSS 关键帧或过渡，合成器独立播放，主线程被启动重活占住时也不卡。页面里唯一的脚本只在“就绪”信号到来时跑一次，不逐帧。
- **加载期间不揭示完整字标**（旧合同保留）：字标只在“就绪”之后才出现。
- 启动顺序、最短可见 900ms、窗口整体渐隐退场、隐藏启动（`READY_START_HIDDEN=1`）不显示启动窗，全部不变。

## 2. 画面（S1–S5）

**S1 底。** 650×190 的玻璃板占满窗口。外观跟随系统（设置库此时还没打开，读不到应用自己的主题）：浅色是白玻璃，深色是烟色玻璃；窗口底色等于页面底色，首帧不闪。

**S2 点出现。** 160ms 后，48 个橙红色的点（浅色 `#ff5a1f`，深色 `#ff6a2c`，即 `--rn-accent`）从左到右依次弹出，散在玻璃板上的一张抖动网格里，各自缓慢漂浮，一道明暗的波从左往右扫过它们——这是“正在加载”。玻璃上同时划过一道光。

**S3 构成字标。** “就绪”信号一到，点按列从左到右汇聚到字标的拐角上（每个字母 7 个锚点；多出的点落在已有锚点上，和它合成一个）；随后每个字母的发丝轮廓沿着轮廓线画出来，再填实；点缩小消失，玻璃上再划过一道光。字形是 Instrument Serif 的真实轮廓（`scripts/generate-startup-splash-glyphs.py` 从应用自带的字体文件生成 `src/shared/startup-splash-glyphs.ts`），字距与外壳顶栏的字标相同（字偶距 + `-0.01em`），视觉中心在玻璃板中线上。

**S4 收尾。** 字标立住、点散尽（就绪后约 1.15s），停 0.42s，主进程把整窗在 0.28s 内渐隐后关闭。时间表只有一份：`STARTUP_SPLASH_FINISH`，页面和窗口都读它。

**S5 减少动态效果。** 系统开了“减少动态效果”时，没有点、光和轮廓，字标从第一帧就在。

## 3. 代码位置

| 内容 | 位置 |
| --- | --- |
| 页面（纯函数，无 Electron、无 DOM） | `src/shared/startup-splash-markup.ts` |
| 字形数据（生成，勿手改） | `src/shared/startup-splash-glyphs.ts` ← `scripts/generate-startup-splash-glyphs.py` |
| 启动窗口：主题、尺寸、底色、退场时间 | `src/main/startup-splash-window.ts` |
| 预览：同一份页面放在同尺寸的框里循环播放 | `#/startup-preview`（`src/renderer/pages/StartupPreview.tsx`；`?theme=light\|dark`，`?loop=0` 只播一次、不发就绪信号） |

删除：`src/main/startup-splash-html.ts`（旧点阵页）、`src/renderer/components/startup/ReadyStartupSplash.tsx`（旧动画的 React 复刻，只供预览页）和 `src/renderer/styles/startup-preview.css`。`ready-wordmark.svg` 与 `ready-logo-dots.ts` 仍被浏览器外壳与欢迎面板使用，保留。

## 4. 验收

- `node --import tsx --test src/__tests__/startup-splash-markup.test.ts`：每个点都落在字标拐角上、每个拐角都有点；点起始位置铺满玻璃板且不出边；字标水平居中、视觉中心在中线上；样式里只有 opacity / transform 的关键帧和过渡，脚本里没有逐帧调用；窗口底色等于页面底色，渐隐晚于字标立住。
- `npm run verify:ready-next-splash`（隐藏窗口，不显示、不联网，HOME/TMPDIR 在临时目录）：在与启动窗同尺寸同底色的隐藏 Electron 窗口里打开同一份页面，两种主题各 7 项——首帧只有玻璃；加载中有 ≥36 个点、铺开 ≥70% 宽度、字标未出现；就绪后点收拢；立住后没有一个橙色像素，字标和“用 Instrument Serif 字体文件在同一位置排出的 Ready 文字”重合度 ≥0.85；运行时实际在动的属性只有 opacity 和 transform、没有 requestAnimationFrame；不暂停时钟的实时播放到同样的结尾；减少动态效果时第一帧就是字标。每 150ms 一帧的截图留在临时目录供人看。
- 不能自动验证、需要真机看的：启动窗在真实桌面上的圆角与玻璃高光边是否贴合（系统窗口圆角由 macOS 决定，页面按 16px 画）；启动期重活下的出帧（沿用不透明窗口 + 合成器动画的既有结论，本次没有可见窗口实测）。

## 5. 不做的事

- 不改成透明窗口或原生毛玻璃（见 §1）。
- 不读取桌面壁纸来模拟折射。
- 不新增设置项；不为应用主题与系统外观不一致的情况另存一份主题缓存（启动窗跟随系统外观，主窗口随后按应用设置）。
