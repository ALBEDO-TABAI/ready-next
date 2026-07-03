---
title: 小红书站点经验
description: 采集小红书的反爬、登录墙与选择器经验
confidence: H
tag: knowledge
created: 2026-06-11
status: active
site: xiaohongshu.com
---

- 反爬：脚本检测严格；Safe Mode 走视觉/工具通道和命名只读模板，Power Mode 可在用户授权下用 eval/CDP 做页面结构、控件定位和网络观察，动作要低频并保留审计。
- 登录墙：详情页需登录态；未登录只能看到列表摘要。
- 发布后台：优先探测 file input、文本编辑区、发布按钮和 disabled/校验状态；每步操作后读回验证，不要只凭截图猜。
- 写长文发布流程（避免在"找发布按钮"上空转耗尽预算）：① 创作页默认停在"上传视频"tab，发文字长文必须先点"写长文"tab 并 read map 确认已切换（页面出现标题输入框 + 正文富文本编辑器，而不是 file input/上传视频）；② 标题为必填项——用户只给正文时，用正文首句或一句话摘要作标题，标题空则发布按钮保持 disabled；③ 正文填入 .tiptap/ProseMirror 编辑器后 read map 读回确认已入文；④ 发布按钮通常在右上角，若 disabled 先 read map 检查标题/正文/封面等必填项缺哪个，不要反复 capture/scroll/eval 盲找；⑤ 点击发布后以成功页信号（发布成功/跳转）作为完成证据。
- 发布页若 DOM 为空或主体在 iframe/OOPIF：转 Power eval/CDP 读 frame tree 与可交互控件，不要重复截图等待。
- 选择器：feed 卡片为 data-v 动态属性，优先用角色+可访问名或截图坐标，不要依赖类名。
- 限速：连续翻页/快速滚动易触发验证，放慢节奏、分批采集。
- 轮播：图文笔记常为多图轮播，逐帧采集并按 URL 去重。
