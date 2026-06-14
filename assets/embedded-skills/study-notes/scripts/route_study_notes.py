#!/usr/bin/env python3
"""Deterministic routing prior for the study-notes skill.

Use this script to estimate content type, study goal, complexity, and whether
the input should exit the normal note-taking path. Treat the output as a prior,
not as the final judgment.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Bucket:
    name: str
    keywords: tuple[str, ...]
    filename_patterns: tuple[str, ...] = ()
    regex_patterns: tuple[str, ...] = ()


ROUTES: tuple[Bucket, ...] = (
    Bucket(
        "knowledge-tutorial",
        (
            "如何",
            "怎么做",
            "怎么用",
            "教程",
            "指南",
            "技巧",
            "经验",
            "原理",
            "解释",
            "why",
            "how to",
            "guide",
            "tips",
            "best practice",
            "playbook",
        ),
        regex_patterns=(
            r"(步骤|做法|建议|误区|实操)",
            r"(教你|带你|学会)",
        ),
    ),
    Bucket(
        "opinion-commentary",
        (
            "我认为",
            "我怀疑",
            "在我看来",
            "评论",
            "观点",
            "批评",
            "真正危险的",
            "问题在于",
            "不是因为",
            "而是因为",
            "should",
            "i think",
            "opinion",
            "commentary",
            "critique",
        ),
        regex_patterns=(
            r"(我越来越怀疑|真正的问题|真正危险的)",
            r"(作者|评论者).*(认为|主张)",
        ),
    ),
    Bucket(
        "narrative-story",
        (
            "故事",
            "经历",
            "那天",
            "后来",
            "当时",
            "第一次",
            "复盘",
            "突然",
            "终于",
            "回头看",
            "scene",
            "story",
            "experience",
        ),
        regex_patterns=(
            r"(那天|后来|当时|结果|直到|忽然|突然)",
            r"(我第一次|我当时|我站到|我才意识到)",
        ),
    ),
    Bucket(
        "data-report",
        (
            "报告",
            "调研",
            "样本",
            "研究",
            "数据显示",
            "研究显示",
            "同比",
            "环比",
            "增长",
            "下降",
            "百分点",
            "survey",
            "report",
            "sample",
            "dataset",
            "findings",
        ),
        regex_patterns=(
            r"(\d+(?:\.\d+)?%|百分之|\d+个?百分点)",
            r"(样本|n\s*=|样本量|调研了)",
        ),
    ),
    Bucket(
        "news-brief",
        (
            "发布",
            "宣布",
            "通报",
            "记者",
            "当地时间",
            "新规",
            "政策",
            "生效",
            "回应",
            "官方表示",
            "according to",
            "announced",
            "reported",
            "statement",
        ),
        regex_patterns=(
            r"(\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)",
            r"(发布新规|宣布|通报|回应称|细则尚未公布)",
        ),
    ),
    Bucket(
        "framework-methodology",
        (
            "框架",
            "模型",
            "原则",
            "方法论",
            "底层逻辑",
            "系统",
            "清单",
            "三件事",
            "三个关键",
            "三层",
            "三步",
            "五个",
            "组成部分",
            "framework",
            "model",
            "principles",
            "checklist",
            "playbook",
        ),
        regex_patterns=(
            r"(第[一二三四五六七八九十]|[1-9][0-9]?[、.)])",
            r"(建立词汇表|建立规则|建立信任)",
        ),
    ),
    Bucket(
        "unsuitable-input",
        (
            "```",
            "import ",
            "def ",
            "class ",
            "select ",
            "create table",
            "参数",
            "规格",
            "型号",
            "安全须知",
            "使用说明",
            "第1条",
            "第一条",
            "甲方",
            "乙方",
            "合同",
            "协议",
        ),
        # Filename patterns are heuristic — a .docx may carry a readable article,
        # so they only contribute a small weight in score_bucket via filename_score().
        # `.docx` was removed from the strong list; treat it as ambiguous.
        filename_patterns=(
            r"\.py$",
            r"\.js$",
            r"\.ts$",
            r"\.sql$",
            r"\.csv$",
            r"\.xlsx$",
        ),
        regex_patterns=(
            r"```[\s\S]*?```",
            # Require code-shape, not just English prose starting with these tokens.
            # `def foo(` / `class Foo` / `import x` / `from x import y` / `return ...;`
            r"(?m)^\s*(def\s+\w+\(|class\s+\w+\b|import\s+\w+|from\s+\w+\s+import\b|return\s+.+;|return\s+\w+\(|public\s+(static\s+)?\w+)",
            r"(?m)^\s*第[一二三四五六七八九十0-9]+条",
            r"(?m)^\s*\|.+\|",
            r"(参数表|规格书|使用说明|注意事项|额定电压)",
        ),
    ),
)


def _assert_routes_consistent() -> None:
    """Guard: route names in routes.json must match ROUTES tuple + 'mixed-content'.

    references/routes.json is the single source of truth for the route LIST;
    ROUTES holds the route-specific scoring data. We assert they don't drift.
    """
    routes_json = Path(__file__).resolve().parent.parent / "references" / "routes.json"
    if not routes_json.exists():
        return  # tolerated for partial installs; validator will flag missing file separately
    declared = {bucket.name for bucket in ROUTES} | {"mixed-content"}
    expected = set(json.loads(routes_json.read_text(encoding="utf-8")).get("routes", []))
    if expected and expected != declared:
        raise RuntimeError(
            f"Route drift detected: routes.json={sorted(expected)}, "
            f"route_study_notes.py ROUTES + mixed-content={sorted(declared)}"
        )


_assert_routes_consistent()


GOALS: tuple[Bucket, ...] = (
    Bucket(
        "background-understanding",
        (
            "了解",
            "看懂",
            "背景",
            "怎么回事",
            "发生了什么",
            "梳理",
            "overview",
            "summary",
            "understand",
        ),
    ),
    Bucket(
        "direct-application",
        (
            "怎么做",
            "实操",
            "落地",
            "拿来用",
            "应用",
            "操作",
            "建议",
            "实践",
            "apply",
            "actionable",
            "checklist",
            "防御建议",
            "设防",
        ),
    ),
    Bucket(
        "secondary-creation",
        (
            "拆结构",
            "仿写",
            "写法",
            "表达方式",
            "论证方式",
            "二次创作",
            "改写",
            "structure",
            "argumentation",
        ),
    ),
    Bucket(
        "memory-review",
        (
            "复习",
            "记忆",
            "背诵",
            "备考",
            "提纲",
            "记一下",
            "review",
            "memorize",
        ),
    ),
    Bucket(
        "decision-support",
        (
            "判断",
            "决策",
            "策略",
            "值不值得",
            "要不要",
            "经营",
            "研判",
            "decision",
            "strategy",
            "evaluate",
        ),
    ),
)


DEFAULT_GOAL_BY_ROUTE = {
    "knowledge-tutorial": "direct-application",
    "opinion-commentary": "background-understanding",
    "narrative-story": "background-understanding",
    "data-report": "decision-support",
    "news-brief": "background-understanding",
    "framework-methodology": "direct-application",
    "mixed-content": "background-understanding",
    "unsuitable-input": "direct-application",
}


GENERIC_NOTE_REQUESTS = (
    "帮我做笔记",
    "做个笔记",
    "做笔记",
    "提取重点",
    "提炼重点",
    "生成学习笔记",
    "生成笔记",
    "帮我总结",
    "总结成笔记",
    "总结一下",
    "总结下",
    "总结",
    "帮我看看",
    "帮我整理",
    "整理一下",
    "整理下",
    "梳理一下",
    "梳理下",
    "summary",
    "summarize",
    "summarise",
    "make notes",
    "take notes",
)


UNSUITABLE_FORMAT_BY_KIND = {
    "code": "code-walkthrough",
    "table": "data-digest",
    "legal": "clause-digest",
    "manual": "spec-checklist",
    "generic": "specialized-summary",
}


def normalize(parts: list[str]) -> str:
    return " ".join(part for part in parts if part).casefold()


def keyword_matches(keyword: str, corpus: str) -> bool:
    folded = keyword.casefold()
    if re.fullmatch(r"[a-z0-9_. -]+", folded):
        pattern = rf"(?<![a-z0-9_]){re.escape(folded.strip())}(?![a-z0-9_])"
        return re.search(pattern, corpus) is not None
    return folded in corpus


def count_regex(pattern: str, text: str) -> int:
    pattern = pattern.replace("(?m)", "")
    return len(re.findall(pattern, text, re.IGNORECASE | re.MULTILINE))


def score_bucket(bucket: Bucket, corpus: str, raw_text: str, file_names: list[str]) -> dict[str, object]:
    score = 0
    matched: list[str] = []

    for keyword in bucket.keywords:
        if keyword_matches(keyword, corpus):
            score += 2
            matched.append(keyword)

    for pattern in bucket.filename_patterns:
        regex = re.compile(pattern, re.IGNORECASE)
        if any(regex.search(name) for name in file_names):
            score += 3
            matched.append(f"pattern:{pattern}")

    for pattern in bucket.regex_patterns:
        hits = count_regex(pattern, raw_text)
        if hits:
            score += min(hits, 2) * 2
            matched.append(f"regex:{pattern}")

    return {"name": bucket.name, "score": score, "matched": matched}


IMAGE_EXTS = r"\.(png|jpg|jpeg|webp|gif|bmp|heic|tiff)$"
# PDF is its own modality: a text-layer PDF needs extraction (not OCR), a scanned PDF needs OCR.
PDF_EXTS = r"\.pdf$"
# Binary / non-text formats that study-notes cannot accept directly.
# These should trigger modality_mismatch unless extracted text is also provided.
BINARY_EXTS = r"\.(mp3|wav|m4a|flac|ogg|opus|aac|mp4|mov|mkv|avi|webm|zip|tar|gz|7z|rar|epub|mobi|psd|fig)$"
URL_RE = re.compile(r"https?://[^\s)\]>，。、；]+", re.IGNORECASE)


def detect_modality(texts: list[str], files: list[str], hints: list[str], prompt: str) -> str:
    texts = texts or []
    hints = hints or []
    files = files or []
    image_like = any(re.search(IMAGE_EXTS, name, re.IGNORECASE) for name in files)
    pdf_like = any(re.search(PDF_EXTS, name, re.IGNORECASE) for name in files)
    binary_like = any(re.search(BINARY_EXTS, name, re.IGNORECASE) for name in files)
    prompt_mentions_image = any(token in prompt for token in ("截图", "图片", "照片", "OCR", "扫描"))
    # Tighter binary detection: only fire when the prompt names the input as the binary,
    # not when the topic merely mentions video/audio (e.g. "短视频平台" should not trigger).
    prompt_binary_phrases = (
        "这段音频", "这段录音", "这段视频", "这个视频", "这个音频",
        "这份录音", "上传的音频", "上传的视频", "上传的录音",
        "音频文件", "视频文件", "录音文件",
        "请转写", "帮我转写", "转写下", "转写一下",
        "transcribe this", "transcribe the", "this audio", "this video", "this recording", "this podcast",
        "the recording", "the audio", "the video", "the mp3", "the mp4", "attached recording", "attached audio",
        # Common topic phrases that strongly imply binary media as the input artifact:
        "这期播客", "这期节目", "这个播客", "这个节目",
        "网课回放", "课程回放", "直播回放", "录像", "podcast", "网课",
        "this program", "online course replay", "livestream replay", "live stream replay",
        "course replay", "stream replay",
    )
    prompt_mentions_binary = any(token.casefold() in prompt.casefold() for token in prompt_binary_phrases)
    has_text = any(item.strip() for item in [prompt, *texts, *hints])

    if files and pdf_like and not image_like and not binary_like:
        # A PDF with extracted text or an excerpt hint can proceed; a bare PDF cannot.
        return "mixed" if has_text and (texts or hints) else "pdf"
    if (files and image_like) or prompt_mentions_image:
        # Image can be reasonably paired with an OCR hint, so a hint counts as material.
        return "mixed" if has_text and (texts or hints) else "image"
    if (files and binary_like) or prompt_mentions_binary:
        # Binary (audio / video / archive) needs a real transcript, not just a caption hint.
        # Require texts (a structured transcript) to escape modality_mismatch; hints alone aren't enough.
        return "mixed" if any(t.strip() for t in texts) else "binary"
    if not files:
        # Bare URL with no extracted body: the page still needs fetching or clipping.
        joined = " ".join([prompt, *texts, *hints])
        if URL_RE.search(joined):
            remaining = re.sub(r"\s+", "", URL_RE.sub(" ", joined))
            if len(remaining) < 40:
                return "unfetched_url"
    return "text"


def prompt_instruction(prompt: str) -> str:
    stripped = prompt.strip()
    if not stripped:
        return ""
    first_line = next((line.strip() for line in stripped.splitlines() if line.strip()), stripped)
    for marker in ("：", ":"):
        if marker in first_line:
            return first_line.split(marker, 1)[0].strip()
    return first_line


def is_generic_note_request(text: str) -> bool:
    compact = re.sub(r"\s+", "", text)
    return compact in GENERIC_NOTE_REQUESTS


def prompt_has_embedded_material(prompt: str) -> bool:
    stripped = prompt.strip()
    for marker in ("：", ":"):
        if marker in stripped:
            remainder = stripped.split(marker, 1)[1]
            return len(re.sub(r"\s+", "", remainder)) >= 20
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    if len(lines) >= 2:
        return len(re.sub(r"\s+", "", "\n".join(lines[1:]))) >= 20
    return False


def has_extracted_material(texts: list[str], hints: list[str]) -> bool:
    return any(item.strip() for item in [*texts, *hints])


PROSE_SIGNAL_PATTERN = (
    r"如何|教你|带你|学会|技巧|误区|原理|为什么|比如|例如|举个|换句话说|这意味着|核心思想"
    r"|how to|for example|in other words|this means"
)

CODE_LINE_PATTERN = re.compile(
    r"\s*(?:def\s+\w+\(|class\s+\w+\b|import\s+\w+|from\s+\w+\s+import\b|return\b|@\w+\b|[\w.\[\]'\"]+\s*=\s*\S)"
)


def detect_features(raw_text: str) -> dict[str, int | float]:
    compact = re.sub(r"\s+", "", raw_text)
    char_count = len(compact)
    digit_count = len(re.findall(r"\d", raw_text))
    percent_hits = count_regex(r"\d+(?:\.\d+)?%|百分点|百分之", raw_text)
    citation_hits = count_regex(r"\[\d+\]|\bdoi\b|\bet al\b|\bn\s*=", raw_text)
    acronym_hits = count_regex(r"\b[A-Z]{2,}\b", raw_text)
    numbered_hits = count_regex(r"(?m)^\s*(?:第[一二三四五六七八九十0-9]+|[0-9]+[、.)])", raw_text)
    date_hits = count_regex(r"\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}", raw_text)
    # Tighter code detection: backticks or python/java-shape constructs (not bare English words like "From" / "If").
    code_hits = count_regex(
        r"```|(?m)^\s*(?:def\s+\w+\(|class\s+\w+\b|import\s+\w+|from\s+\w+\s+import\b|return\s+\w+\(|return\s+.+;|public\s+(?:static\s+)?\w+)",
        raw_text,
    )
    legal_hits = count_regex(r"(?m)^\s*第[一二三四五六七八九十0-9]+条|甲方|乙方|应当|不得|本办法", raw_text)
    manual_hits = count_regex(r"参数|规格|型号|安全须知|使用说明|安装|注意事项|额定", raw_text)

    non_empty_lines = [line for line in raw_text.splitlines() if line.strip()]
    line_total = max(len(non_empty_lines), 1)

    table_line_hits = 0
    outside_table_chars = 0
    for line in non_empty_lines:
        stripped = line.strip()
        pipe_count = stripped.count("|")
        comma_count = stripped.count(",")
        tab_count = stripped.count("\t")
        numeric_cells = len(re.findall(r"\d+(?:\.\d+)?", stripped))
        if pipe_count >= 2 or tab_count >= 2:
            table_line_hits += 1
        elif comma_count >= 2 and numeric_cells >= 2:
            table_line_hits += 1
        else:
            outside_table_chars += len(re.sub(r"\s+", "", stripped))

    # Dominance signals: distinguish "the material IS code/table/legal" from
    # "the material talks ABOUT code/table/legal inside prose".
    prose_signal_hits = count_regex(PROSE_SIGNAL_PATTERN, raw_text)
    legal_line_hits = count_regex(r"(?m)^\s*第[一二三四五六七八九十0-9]+条", raw_text)
    fence_free = re.sub(r"```[\s\S]*?```", "", raw_text)
    outside_code_chars = len(re.sub(r"\s+", "", fence_free))
    code_line_hits = sum(1 for line in non_empty_lines if CODE_LINE_PATTERN.match(line))

    story_hits = count_regex(r"那天|后来|当时|结果|直到|突然|第一次|复盘|我才意识到", raw_text)
    judgment_hits = count_regex(r"我认为|我怀疑|在我看来|问题在于|真正危险的|作者认为|评论", raw_text)

    return {
        "char_count": char_count,
        "digit_count": digit_count,
        "digit_ratio": digit_count / max(char_count, 1),
        "percent_hits": percent_hits,
        "citation_hits": citation_hits,
        "acronym_hits": acronym_hits,
        "numbered_hits": numbered_hits,
        "date_hits": date_hits,
        "code_hits": code_hits,
        "legal_hits": legal_hits,
        "manual_hits": manual_hits,
        "table_hits": table_line_hits,
        "table_line_ratio": table_line_hits / line_total,
        "outside_table_chars": outside_table_chars,
        "prose_signal_hits": prose_signal_hits,
        "legal_line_hits": legal_line_hits,
        "outside_code_chars": outside_code_chars,
        "code_line_ratio": code_line_hits / line_total,
        "story_hits": story_hits,
        "judgment_hits": judgment_hits,
    }


def mentioned_length_hint(corpus: str) -> int:
    # Chinese: 3000 字 / 三千字 (only the numeric form is supported here)
    cn = re.search(r"([0-9]{1,3}(?:[,，][0-9]{3})+|\d{3,6})\s*字", corpus)
    if cn:
        return _parse_length_number(cn.group(1))
    # English words: "3500 words" / "3,500 words"
    en_words = re.search(r"([0-9]{1,3}(?:,[0-9]{3})+|\d{3,6})\s*words?\b", corpus, re.IGNORECASE)
    if en_words:
        return _parse_length_number(en_words.group(1))
    # "5k words" / "8k 字"
    short_k = re.search(r"(\d+(?:\.\d+)?)\s*k\b\s*(?:words?|字)?", corpus, re.IGNORECASE)
    if short_k:
        try:
            return int(float(short_k.group(1)) * 1000)
        except ValueError:
            pass
    return 0


def _parse_length_number(raw: str) -> int:
    cleaned = raw.replace(",", "").replace("，", "")
    try:
        return int(cleaned)
    except ValueError:
        return 0


def has_mixed_layer_signals(corpus: str) -> bool:
    layer_terms = (
        "混合材料",
        "新闻事实",
        "评论判断",
        "执行清单",
        "执行建议",
        "事实层",
        "评论层",
        "数据层",
        "方法层",
        "故事层",
        "同时包含",
        "前半",
        "后半",
    )
    has_news_layer = any(token in corpus for token in ("新闻", "发布", "宣布", "新规", "政策"))
    has_data_layer = any(token in corpus for token in ("数据", "样本", "调研", "报告", "%", "同比", "环比"))
    has_framework_layer = any(token in corpus for token in ("框架", "模型", "方法论", "原则", "清单", "三层", "三步"))
    has_story_layer = any(token in corpus for token in ("故事", "经历", "复盘", "第一次", "后来"))
    has_opinion_layer = any(token in corpus for token in ("评论", "作者认为", "判断", "观点", "不是单纯"))
    has_layer_label = any(token in corpus for token in layer_terms)
    layer_count = sum((has_news_layer, has_data_layer, has_framework_layer, has_story_layer, has_opinion_layer))
    if has_story_layer and has_framework_layer and any(token in corpus for token in ("总结出", "原则", "复盘")):
        return True
    if has_data_layer and has_framework_layer and any(token in corpus for token in ("支撑", "证据", "框架", "调研数据")):
        return True
    if has_data_layer and has_opinion_layer and any(token in corpus for token in ("立场", "解读", "认为", "评论", "判断")):
        return True
    if has_framework_layer and has_opinion_layer and any(token in corpus for token in ("但", "却", "反驳", "争议")):
        return True
    if has_news_layer and has_data_layer and layer_count >= 2:
        return True
    return has_opinion_layer and layer_count >= 2 and (
        has_layer_label or any(token in corpus for token in ("但作者", "同时", "又提出", "总结出"))
    )


def detect_unsuitable_kind(features: dict[str, int | float]) -> str | None:
    """Dominance-gated: fire only when the material IS code/table/legal/manual,
    not when prose-led material merely mentions, quotes, or embeds it
    (e.g. a tutorial with code examples, or an article about reading contracts)."""
    prose_led = int(features["prose_signal_hits"]) >= 2
    if int(features["code_hits"]) >= 2:
        fenced_only = int(features["outside_code_chars"]) < 80
        unfenced_dominant = float(features["code_line_ratio"]) >= 0.3 and not prose_led
        if fenced_only or unfenced_dominant:
            return "code"
    if (
        int(features["table_hits"]) >= 2
        and float(features["table_line_ratio"]) >= 0.4
        and int(features["outside_table_chars"]) < 120
    ):
        return "table"
    if int(features["legal_line_hits"]) >= 2 or (int(features["legal_hits"]) >= 4 and not prose_led):
        return "legal"
    if int(features["manual_hits"]) >= 3 and not prose_led:
        return "manual"
    return None


def apply_route_heuristics(
    route_scores: list[dict[str, object]],
    features: dict[str, int | float],
    corpus: str,
    unsuitable_kind: str | None,
) -> None:
    score_map = {item["name"]: item for item in route_scores}

    # digit_ratio is meaningless on tiny denominators ("这篇5000字的长文" alone
    # yields ratio 0.2), so it only counts once there is real material.
    if int(features["percent_hits"]) >= 2 or (
        float(features["digit_ratio"]) >= 0.08 and int(features["char_count"]) >= 120
    ):
        score_map["data-report"]["score"] = int(score_map["data-report"]["score"]) + 3
        score_map["data-report"]["matched"].append("heuristic:dense-numeric")

    if int(features["date_hits"]) >= 1 and any(token in corpus for token in ("发布", "宣布", "通报", "回应", "新规")):
        score_map["news-brief"]["score"] = int(score_map["news-brief"]["score"]) + 3
        score_map["news-brief"]["matched"].append("heuristic:dated-event")

    if int(features["story_hits"]) >= 2 and any(token in corpus for token in ("我", "他", "她")):
        score_map["narrative-story"]["score"] = int(score_map["narrative-story"]["score"]) + 3
        score_map["narrative-story"]["matched"].append("heuristic:story-sequence")

    if int(features["judgment_hits"]) >= 2:
        score_map["opinion-commentary"]["score"] = int(score_map["opinion-commentary"]["score"]) + 3
        score_map["opinion-commentary"]["matched"].append("heuristic:explicit-judgment")

    if int(features["numbered_hits"]) >= 3 and any(token in corpus for token in ("框架", "逻辑", "原则", "三件事", "五个", "组成")):
        score_map["framework-methodology"]["score"] = int(score_map["framework-methodology"]["score"]) + 3
        score_map["framework-methodology"]["matched"].append("heuristic:structured-framework")

    if int(features["numbered_hits"]) >= 2 and any(token in corpus for token in ("如何", "怎么做", "步骤", "技巧", "建议")):
        score_map["knowledge-tutorial"]["score"] = int(score_map["knowledge-tutorial"]["score"]) + 2
        score_map["knowledge-tutorial"]["matched"].append("heuristic:instructional-steps")

    if unsuitable_kind:
        score_map["unsuitable-input"]["score"] = int(score_map["unsuitable-input"]["score"]) + 6
        score_map["unsuitable-input"]["matched"].append(f"heuristic:unsuitable-{unsuitable_kind}")
    elif int(score_map["unsuitable-input"]["score"]) > 0:
        # Code/legal/table tokens appear inside prose-led material: the text is ABOUT
        # them, not made of them. Remove unsuitable-input from contention so it cannot
        # win on keyword count alone or drag a close call into mixed-content.
        score_map["unsuitable-input"]["score"] = 0
        score_map["unsuitable-input"]["matched"].append("heuristic:prose-dominant-demotion")


def infer_goal(prompt: str, route: str, texts: list[str] | None = None) -> tuple[str | None, list[dict[str, object]]]:
    instruction = prompt_instruction(prompt)
    # Also peek at the body's first paragraph: users sometimes state the goal in the text rather than the prompt
    # (e.g. "本文目的是教你 X" / "本报告希望帮助决策" / "I'll walk you through how to ...").
    body_lead = ""
    if texts:
        for raw in texts:
            if not raw:
                continue
            for line in raw.splitlines():
                trimmed = line.strip()
                if len(trimmed) >= 8:
                    body_lead = trimmed[:280]
                    break
            if body_lead:
                break
    corpus = normalize([instruction, body_lead])
    raw_text = " ".join([instruction, body_lead])
    goal_scores = [score_bucket(bucket, corpus, raw_text, []) for bucket in GOALS]
    goal_scores.sort(key=lambda item: (-int(item["score"]), str(item["name"])))

    top = goal_scores[0]
    if int(top["score"]) > 0:
        return str(top["name"]), goal_scores
    if route == "framework-methodology" and any(token in instruction for token in ("截图", "看到", "概念")):
        return "background-understanding", goal_scores
    return DEFAULT_GOAL_BY_ROUTE[route], goal_scores


def upgrade_complexity(current: str) -> str:
    if current == "short":
        return "standard"
    if current == "standard":
        return "layered"
    return "layered"


def detect_complexity(
    prompt: str,
    texts: list[str],
    hints: list[str],
    route: str,
    features: dict[str, int | float],
) -> tuple[str, str, int]:
    char_count = int(features["char_count"])
    hinted_count = mentioned_length_hint(normalize([prompt, *texts, *hints]))
    effective_length = max(char_count, hinted_count)

    if effective_length < 300:
        complexity = "short"
    elif effective_length > 3000:
        complexity = "layered"
    else:
        complexity = "standard"

    density_score = 0
    if int(features["percent_hits"]) >= 2 or (
        float(features["digit_ratio"]) >= 0.08 and int(features["char_count"]) >= 120
    ):
        density_score += 1
    if int(features["citation_hits"]) >= 1 or int(features["acronym_hits"]) >= 5:
        density_score += 1
    if int(features["numbered_hits"]) >= 4:
        density_score += 1
    if route == "data-report" and effective_length >= 800:
        density_score += 1

    if density_score >= 2 and complexity != "layered":
        complexity = upgrade_complexity(complexity)

    if route == "data-report" and complexity == "short":
        complexity = "standard"

    if route == "mixed-content" and complexity == "short":
        complexity = "standard"

    if route == "unsuitable-input" and effective_length < 500:
        complexity = "short"

    density = "high" if density_score >= 3 else "medium" if density_score >= 1 else "low"
    return complexity, density, effective_length


def choose_route(route_scores: list[dict[str, object]], corpus: str) -> tuple[str, str, list[str]]:
    sorted_scores = sorted(route_scores, key=lambda item: (-int(item["score"]), str(item["name"])))
    top = sorted_scores[0]
    runner_up = sorted_scores[1] if len(sorted_scores) > 1 else {"name": None, "score": 0}

    notes = ["Treat this result as a routing prior, then verify by reading the actual source."]
    pair = {str(top["name"]), str(runner_up["name"])}
    gap = int(top["score"]) - int(runner_up["score"])

    if str(top["name"]) == "unsuitable-input" and int(top["score"]) >= max(6, int(runner_up["score"]) + 1):
        confidence = "high" if int(top["score"]) - int(runner_up["score"]) >= 4 else "medium"
        notes.append("Detected signals that the input should avoid the normal note template.")
        return "unsuitable-input", confidence, notes

    if has_mixed_layer_signals(corpus):
        notes.append("The material explicitly asks to preserve fact, commentary, and action layers.")
        return "mixed-content", "medium", notes

    if int(top["score"]) <= 0:
        notes.append("No route scored above zero; use knowledge-tutorial only as a low-confidence starting point.")
        return "knowledge-tutorial", "low", notes

    if pair == {"knowledge-tutorial", "framework-methodology"}:
        if any(token in corpus for token in ("如何", "怎么做", "怎么用", "技巧", "guide", "tips")):
            notes.append("Close tutorial/framework split, but the wording leans toward use-oriented teaching.")
            return "knowledge-tutorial", "medium", notes
        if any(token in corpus for token in ("框架", "模型", "原则", "底层逻辑", "组成", "三件事", "五个")):
            notes.append("Close tutorial/framework split, but the wording leans toward a structural framework.")
            return "framework-methodology", "medium", notes

    if pair == {"news-brief", "opinion-commentary"} and int(top["score"]) >= 4 and int(runner_up["score"]) >= 4 and gap <= 2:
        notes.append("The material mixes event facts with explicit commentary; keep both layers instead of collapsing them.")
        return "mixed-content", "medium", notes

    if int(top["score"]) >= 4 and int(runner_up["score"]) >= 4 and gap <= 1:
        notes.append(
            f"Top routes are close ({top['name']} vs {runner_up['name']}); split the material instead of forcing one lens."
        )
        return "mixed-content", "low", notes

    confidence = "high" if gap >= 4 else "medium" if gap >= 2 else "low"
    if confidence != "high":
        notes.append(f"Runner-up route is {runner_up['name']}; keep that alternative in mind.")
    return str(top["name"]), confidence, notes


def classify(prompt: str, texts: list[str], files: list[str], hints: list[str]) -> dict[str, object]:
    corpus = normalize([prompt, *texts, *files, *hints])
    raw_text = "\n".join([prompt, *texts, *hints, *files])
    file_names = [name.casefold() for name in files]
    modality = detect_modality(texts, files, hints, prompt)

    # Binary (audio / video / archive) needs a structured transcript, not just a caption hint.
    # Image can still accept hint-only because OCR-as-caption is a reasonable fallback.
    binary_blocked = modality == "binary" and not any((t or "").strip() for t in texts)
    image_blocked = modality == "image" and not has_extracted_material(texts, hints)
    pdf_blocked = modality == "pdf" and not has_extracted_material(texts, hints)
    url_blocked = modality == "unfetched_url"
    if binary_blocked or image_blocked or pdf_blocked or url_blocked:
        mismatch_notes = {
            "pdf": (
                "An unextracted PDF was provided. Text-layer PDFs need text extraction; scanned PDFs "
                "need OCR. Pass the extracted text back to study-notes."
            ),
            "unfetched_url": (
                "Only a bare URL was provided. Fetch or clip the page into extracted text first, "
                "then pass it back to study-notes."
            ),
        }
        default_note = (
            "Raw image, audio, video, archive, or other binary inputs require OCR, transcription, "
            "or extracted text before using study-notes. See SKILL.md ## Modality Mismatch Output for the response schema."
        )
        return {
            "status": "modality_mismatch",
            "modality": modality,
            "content_type": None,
            "confidence": "low",
            "study_goal": None,
            "complexity": None,
            "density": "low",
            "unsuitable": False,
            "unsuitable_kind": None,
            "recommended_format": None,
            "effective_length": 0,
            "route_scores": [],
            "goal_scores": [],
            "features": {},
            "notes": [mismatch_notes.get(modality, default_note)],
        }

    if (
        not files
        and not has_extracted_material(texts, hints)
        and is_generic_note_request(prompt_instruction(prompt))
        and not prompt_has_embedded_material(prompt)
    ):
        return {
            "status": "insufficient_text",
            "modality": modality,
            "content_type": None,
            "confidence": "low",
            "study_goal": None,
            "complexity": None,
            "density": "low",
            "unsuitable": False,
            "unsuitable_kind": None,
            "recommended_format": None,
            "effective_length": 0,
            "route_scores": [],
            "goal_scores": [],
            "features": {},
            "notes": ["No source material was provided; ask the caller to provide extracted text before writing a note."],
        }

    features = detect_features(raw_text)
    unsuitable_kind = detect_unsuitable_kind(features)

    route_scores = [score_bucket(bucket, corpus, raw_text, file_names) for bucket in ROUTES]
    apply_route_heuristics(route_scores, features, corpus, unsuitable_kind)
    route_scores.sort(key=lambda item: (-int(item["score"]), str(item["name"])))

    route, confidence, notes = choose_route(route_scores, corpus)
    goal, goal_scores = infer_goal(prompt, route, texts)
    complexity, density, effective_length = detect_complexity(prompt, texts, hints, route, features)

    hinted_length = mentioned_length_hint(corpus)
    if hinted_length >= 1000 and int(features["char_count"]) < min(300, hinted_length // 5):
        notes.append(
            f"length-hint mismatch: stated length (~{hinted_length} chars) is far larger than the provided "
            f"text ({int(features['char_count'])} chars). Confirm the full material was pasted; if only an "
            "excerpt exists, write from the excerpt and mark the note as partial."
        )

    recommended_format = None
    if route == "unsuitable-input":
        recommended_format = UNSUITABLE_FORMAT_BY_KIND.get(unsuitable_kind or "generic")

    result = {
        "status": "ok",
        "modality": modality,
        "content_type": route,
        "confidence": confidence,
        "study_goal": goal,
        "complexity": complexity,
        "density": density,
        "unsuitable": route == "unsuitable-input",
        "unsuitable_kind": unsuitable_kind,
        "recommended_format": recommended_format,
        "effective_length": effective_length,
        "route_scores": route_scores,
        "goal_scores": goal_scores,
        "features": features,
        "notes": notes,
    }
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Route content for the study-notes skill.")
    parser.add_argument("--prompt", default="", help="User request or leading instruction.")
    parser.add_argument(
        "--text",
        dest="texts",
        action="append",
        default=[],
        help="正文或节选。可重复传入。",
    )
    parser.add_argument(
        "--file",
        dest="files",
        action="append",
        default=[],
        help="文件名或路径。可重复传入。",
    )
    parser.add_argument(
        "--hint",
        dest="hints",
        action="append",
        default=[],
        help="OCR、图注或补充说明。可重复传入。",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Emit only the core decision fields (content_type / confidence / complexity / study_goal / status). Drops route_scores, goal_scores, features, notes.",
    )
    return parser.parse_args()


QUIET_FIELDS = (
    "status",
    "modality",
    "content_type",
    "confidence",
    "study_goal",
    "complexity",
    "density",
    "unsuitable",
    "unsuitable_kind",
    "recommended_format",
)


def main() -> None:
    args = parse_args()
    result = classify(args.prompt, args.texts, args.files, args.hints)
    if args.quiet:
        result = {k: result.get(k) for k in QUIET_FIELDS if k in result}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
