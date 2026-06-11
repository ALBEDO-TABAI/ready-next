---
title: 小红书站点经验
description: 采集小红书的反爬、登录墙与选择器经验
confidence: H
tag: knowledge
created: 2026-06-11
status: active
site: xiaohongshu.com
---

- 反爬：脚本检测严格，禁用脚本通道（封号风险）；走视觉/工具通道。
- 登录墙：详情页需登录态；未登录只能看到列表摘要。
- 选择器：feed 卡片为 data-v 动态属性，优先用角色+可访问名或截图坐标，不要依赖类名。
- 限速：连续翻页/快速滚动易触发验证，放慢节奏、分批采集。
- 轮播：图文笔记常为多图轮播，逐帧采集并按 URL 去重。
