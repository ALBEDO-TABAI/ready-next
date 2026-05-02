# Let's Go RSS 🛰️ 全平台 RSS 订阅管理器

> **AI-Powered Universal RSS Subscription Manager | AI 驱动的全平台 RSS 订阅管理器**

A lightweight RSS aggregator designed to work as a **Claude Skill** inside AI-powered IDEs and agents. Add subscriptions from 7 platforms（YouTube, Vimeo, Behance, Bilibili, Weibo微博, Douyin抖音, Xiaohongshu小红书）, auto-update with deduplication, and get digest reports — all through simple CLI commands that your AI assistant can run for you.

一个轻量级 RSS 聚合工具，设计为 **Claude Skill** 在 AI IDE 和 Agent 中运行。支持 7 个平台（YouTube, Vimeo, Behance, Bilibili, Weibo微博, Douyin抖音, Xiaohongshu小红书）的订阅管理、自动更新去重、智能摘要推送——通过简单的命令行指令，让你的 AI 助手自动完成。

---

## 💡 Why This Project? | 为什么做这个？

### The Problem | 问题

We are trapped inside algorithms. The average internet user spends **2 hours 23 minutes per day** on social media (DataReportal 2024), of which **80-90% is passive zombie scrolling**. Research from UPenn shows that only **30 minutes** of daily social media use is genuinely beneficial — every second beyond that has diminishing or even negative returns.

我们被困在算法里。全球网民平均每天花 **2 小时 23 分钟**刷社交媒体（DataReportal 2024），其中 **80-90%** 是无意识被动浏览。宾夕法尼亚大学研究表明，每天社交媒体使用超过 **30 分钟**后的每一秒，边际效益都在递减甚至变为负值。

### The Science | 科学依据

- **Dunbar's Number (150)** — Oxford anthropologist Robin Dunbar proved that humans can maintain at most ~150 stable relationships. Indiana University's analysis of Twitter confirmed: even users following thousands of accounts only actively interact with **100-200 people**. Following more than 150 accounts means you're consuming data streams, not maintaining relationships.

- **Miller's Law (7±2)** — Cognitive psychology tells us our working memory holds ~7 items. The brain can deeply process only **5-9 quality sources per day**. Hundreds of subscriptions trigger decision fatigue, forcing your brain into shallow scanning mode.

- **邓巴数（150）**—— 牛津大学人类学家邓巴证明，人类最多维持约 150 段稳定社交关系。印第安纳大学对 Twitter 的大数据分析确认：即使关注数千人，活跃互动圈依然卡在 **100-200 人**。超过 150 个关注，你消费的是数据流，而非社交关系。

- **米勒定律（7±2）**—— 认知心理学表明，短时记忆容量约 7 个单位。大脑每天能深度消化的高质量信源通常不超过 **5-9 个**。关注几百个账号的结果是"决策疲劳"，大脑放弃深度处理，转为浅层扫描。

### The Coming Storm | 即将到来的风暴

With AIGC's marginal cost approaching zero, the internet is heading toward a reality where **90%+ of content is AI-generated**. The "Dead Internet Theory" is becoming fact. Social platforms are splitting from "Social Media" into "Recommendation Media" — AI feeds content, humans secrete dopamine. Real human connection is retreating into private, verified circles (**Dark Forest socialization**).

随着 AIGC 边际成本趋零，互联网正走向 **90% 以上内容由 AI 生成**的现实。"死互联网理论"正在成真。社交平台正从"社交媒体"裂变为"推荐媒体"——AI 负责投喂，人类负责分泌多巴胺。真人社交正撤退至私密的、经过验证的小圈子（**黑暗森林化**）。

### The Solution | 解决方案

**Take back control.** Stop handing your attention to "guess what you like" algorithms. Build your own information moat:

**夺回控制权。** 别再把注意力交给"猜你喜欢"。建立你自己的信息护城河：

> 🎯 Curate ≤150 accounts → 📡 Let RSS pull updates → 🤖 Let AI filter noise → ☕ Reclaim your 2 hours
>
> 🎯 精选 ≤150 个关注 → 📡 让 RSS 拉取更新 → 🤖 让 AI 过滤噪音 → ☕ 夺回你的 2 小时

**From FOMO to JOMO** — embrace the joy of missing out. 99% of information is noise. Your attention is the last scarce resource in the age of AI.

**从 FOMO 到 JOMO** —— 拥抱「错过的快乐」。99% 的信息都是噪音。在 AI 时代，你的注意力是最后的稀缺资源。

<details>
<summary>📚 References | 参考文献</summary>

1. Dunbar, R. I. M. (1992). *Neocortex size as a constraint on group size in primates.* Journal of Human Evolution, 22(6), 469–493.
2. Gonçalves, B., Perra, N., & Vespignani, A. (2011). *Modeling Users' Activity on Twitter Networks: Validation of Dunbar's Number.* PLoS ONE, 6(8), e22656. (Indiana University)
3. Miller, G. A. (1956). *The Magical Number Seven, Plus or Minus Two.* Psychological Review, 63(2), 81–97.
4. Hunt, M. G., Marx, R., Lipson, C., & Young, J. (2018). *No More FOMO: Limiting Social Media Decreases Loneliness and Depression.* Journal of Social and Clinical Psychology, 37(10), 751–768. (UPenn)
5. Kemp, S. (2024). *Digital 2024: Global Overview Report.* DataReportal / We Are Social / Meltwater.
6. GWI (2024). *Social Media Trends Report.* GlobalWebIndex.

</details>

---


## 🤖 Designed for AI IDEs | 为 AI IDE 设计

This Skill is built to be used with AI-powered coding environments:

本 Skill 设计为配合以下 AI 编程环境使用：

- **[Claude Code](https://claude.ai/code)** — Anthropic's AI coding agent (recommended)
- **[Cursor](https://cursor.sh)** — AI-first code editor
- **[Windsurf](https://codeium.com/windsurf)** — AI-powered IDE by Codeium
- **[OpenClaw](https://github.com/nicepkg/openclaw)** — Open-source Claude Code alternative

Just share this repo's URL with your AI assistant, and it will read `SKILL.md` to understand how to manage your RSS subscriptions automatically.

只需将本仓库 URL 分享给你的 AI 助手，它会读取 `SKILL.md` 并自动帮你管理 RSS 订阅。

---

## ✨ Features | 功能特性

| Feature | 功能 | Description |
|---------|------|-------------|
| 📡 7-Platform Support | 7 平台支持 | YouTube, Vimeo, Behance, Bilibili, Weibo, Douyin, Xiaohongshu |
| 🔄 Incremental Updates | 增量更新 | SQLite-based dedup, only fetches new content |
| 📋 Digest Mode | 摘要模式 | `--digest` shows latest 1 item per account |
| 🤖 AI Classification | AI 分类 | Optional Claude-powered topic categorization |
| 📰 Standard Output | 标准输出 | RSS 2.0 XML + Markdown reports |
| ⏰ Schedulable | 可定时 | Works with crontab for automated updates |

---

## 🚀 Quick Start | 快速开始

### Install | 安装

```bash
# Core dependencies | 核心依赖
pip install httpx yt-dlp
```

### Basic Usage | 基本使用

```bash
# Add subscriptions | 添加订阅
python3 scripts/lets_go_rss.py --add "https://www.youtube.com/@MatthewEncina"
python3 scripts/lets_go_rss.py --add "https://vimeo.com/xkstudio"
python3 scripts/lets_go_rss.py --add "https://www.behance.net/yokohara6e48"

# Update all | 更新全部
python3 scripts/lets_go_rss.py --update --no-llm

# Digest mode (1 item per account) | 摘要模式（每账号 1 条）
python3 scripts/lets_go_rss.py --update --no-llm --digest --skip-setup

# Read cached report (bot push) | 读取缓存报告（Bot 推送）
python3 scripts/lets_go_rss.py --status

# List subscriptions | 查看订阅
python3 scripts/lets_go_rss.py --list
```

---

## 🏗️ Architecture | 架构

```
┌──────────────────────────────────────────────────┐
│  Tier 1: Native RSS (zero dependency)            │
│  Vimeo / Behance → httpx reads RSS directly      │
├──────────────────────────────────────────────────┤
│  Tier 1b: yt-dlp (pip install)                   │
│  YouTube → yt-dlp extracts metadata              │
├──────────────────────────────────────────────────┤
│  Tier 2: RSSHub Proxy (optional Docker)          │
│  Weibo / Douyin / Bilibili / XHS → local RSSHub  │
└──────────────────────────────────────────────────┘
```

## 📊 Platform Support | 平台支持

| Platform | Method | Dependency | Ready? |
|----------|--------|------------|:------:|
| YouTube | yt-dlp | `pip install yt-dlp` | ✅ |
| Vimeo | Native RSS | `httpx` | ✅ |
| Behance | Native RSS | `httpx` | ✅ |
| Weibo 微博 | RSSHub | Docker | ⚠️ |
| Douyin 抖音 | RSSHub | Docker | ⚠️ |
| Bilibili B站 | RSSHub | Docker | ⚠️ |
| Xiaohongshu 小红书 | RSSHub | Docker | ⚠️ |

---

## 🇨🇳 Chinese Platforms Setup | 中国平台配置

For Weibo, Douyin, Bilibili, and Xiaohongshu, you need a self-hosted [RSSHub](https://docs.rsshub.app/):

使用微博、抖音、B站、小红书需要自建 [RSSHub](https://docs.rsshub.app/)：

```bash
docker run -d --name rsshub -p 1200:1200 diygod/rsshub:chromium-bundled
export RSSHUB_BASE_URL="http://localhost:1200"

# Optional: tighter network timeout for bot timeout limits
export RSS_HTTP_TIMEOUT="10"
export RSS_HTTP_RETRIES="2"
export RSS_XHS_TIMEOUT="6"
export RSS_XHS_RETRIES="1"
export RSS_YTDLP_TIMEOUT="12"
```

---

## 📂 Project Structure | 项目结构

```
lets-go-rss/
├── SKILL.md              # Claude Skill entry point | AI 技能入口
├── README.md             # This file | 本文件
├── requirements.txt      # Python deps | Python 依赖
├── scripts/
│   ├── lets_go_rss.py    # Main entry | 主入口
│   ├── rss_engine.py     # Core engine | 核心引擎
│   ├── scrapers.py       # Platform scrapers | 平台爬虫
│   ├── database.py       # SQLite manager | 数据库
│   ├── classifier.py     # AI classification | AI 分类
│   ├── rss_generator.py  # XML generation | XML 生成
│   ├── report_generator.py # Markdown reports | 报告生成
│   ├── run_update_cron.sh # Stable update command | 稳定更新命令
│   └── run_status_push.sh # Stable status command | 稳定推送命令
└── assets/               # Runtime data (gitignored) | 运行时数据
```

## ⏰ Scheduled Updates | 定时更新

```bash
# Recommended stable commands
cd /path/to/lets-go-rss && bash scripts/run_update_cron.sh
cd /path/to/lets-go-rss && bash scripts/run_status_push.sh

# crontab -e — update at :55 every 2 hours, push at every even hour
55 */2 * * * cd /path/to/lets-go-rss && bash scripts/run_update_cron.sh >> /tmp/rss_cron.log 2>&1
0 */2 * * * cd /path/to/lets-go-rss && bash scripts/run_status_push.sh
```

The engine now uses `assets/.update.lock` to prevent overlapping update jobs.

## 🤝 AI Classification (Optional) | AI 分类（可选）

```bash
pip install anthropic
export ANTHROPIC_API_KEY="your-key"

# Update with AI classification | 使用 AI 分类更新
python3 scripts/lets_go_rss.py --update
```

## License

MIT
