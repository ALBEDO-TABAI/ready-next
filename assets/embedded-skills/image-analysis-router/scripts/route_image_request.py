#!/usr/bin/env python3
"""Lightweight keyword router for image-analysis-router.

Use this script as a deterministic routing prior from prompt text, file names,
URLs, and optional hints. Always confirm the route with actual visual inspection.

All routing data (keywords, filename patterns, corpus adjustments, goal rules)
lives in references/routes.json. This file is a generic scoring engine over it.

Scoring model:
- keywords score against the natural-language corpus (prompt + hints) only
- filename patterns score against file/URL basenames only (no double counting)
- corpus adjustments and goal rules then shift scores per routes.json
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


ROUTES_JSON = Path(__file__).resolve().parent.parent / "references" / "routes.json"

DEFAULT_PATTERN_WEIGHT = 3
KEYWORD_WEIGHT = 2


class RouterDataError(RuntimeError):
    """references/routes.json is missing, malformed, or inconsistent."""


@dataclass(frozen=True)
class Bucket:
    name: str
    keywords: tuple[str, ...]
    # (compiled regex, weight) pairs, matched against basenames only
    filename_patterns: tuple[tuple[re.Pattern[str], int], ...]


def _compile_patterns(entries: list) -> tuple[tuple[re.Pattern[str], int], ...]:
    compiled = []
    for entry in entries:
        if isinstance(entry, str):
            pattern, weight = entry, DEFAULT_PATTERN_WEIGHT
        else:
            pattern, weight = entry["pattern"], int(entry.get("weight", DEFAULT_PATTERN_WEIGHT))
        compiled.append((re.compile(pattern, re.IGNORECASE), weight))
    return tuple(compiled)


def _load_data() -> tuple[tuple[Bucket, ...], dict, tuple, tuple]:
    if not ROUTES_JSON.exists():
        raise RouterDataError(f"missing routing data file: {ROUTES_JSON}")
    try:
        payload = json.loads(ROUTES_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RouterDataError(f"malformed routes.json: {exc}") from exc

    routes = payload.get("routes")
    if not isinstance(routes, dict) or not routes:
        raise RouterDataError("routes.json must define a non-empty 'routes' object")
    excludes = set(payload.get("router_only_excludes", []))

    buckets = []
    for name, config in routes.items():
        if name in excludes:
            continue
        try:
            buckets.append(
                Bucket(
                    name=name,
                    keywords=tuple(config.get("keywords", [])),
                    filename_patterns=_compile_patterns(config.get("filename_patterns", [])),
                )
            )
        except (KeyError, TypeError, re.error) as exc:
            raise RouterDataError(f"invalid route config for '{name}': {exc!r}") from exc

    names = {bucket.name for bucket in buckets}
    goal_rules = tuple(payload.get("goal_rules", []))
    adjustments = tuple(payload.get("corpus_adjustments", []))
    goals = payload.get("goals", {})
    for rule in goal_rules:
        unknown_routes = set(rule.get("adjust", {})) - names
        if unknown_routes:
            raise RouterDataError(f"goal_rule targets unknown routes: {sorted(unknown_routes)}")
        unknown_goals = (set(rule.get("when", [])) | set(rule.get("unless", []))) - set(goals)
        if unknown_goals:
            raise RouterDataError(f"goal_rule references unknown goals: {sorted(unknown_goals)}")
    for adjustment in adjustments:
        if adjustment.get("route") not in names:
            raise RouterDataError(f"corpus_adjustment targets unknown route: {adjustment.get('route')}")

    return tuple(buckets), goals, goal_rules, adjustments


try:
    ROUTES, GOALS, GOAL_RULES, CORPUS_ADJUSTMENTS = _load_data()
    DATA_ERROR: str | None = None
except RouterDataError as exc:
    # Do not crash at import: emit a structured router_unavailable status from
    # main() so the agent can fall back to visual-only routing.
    ROUTES, GOALS, GOAL_RULES, CORPUS_ADJUSTMENTS = (), {}, (), ()
    DATA_ERROR = str(exc)


FOCUSES: tuple[Bucket, ...] = (
    Bucket("learning-report", ("学习", "怎么学", "study", "learn", "拆解", "临摹", "练习", "improve"), ()),
    Bucket("style-classification", ("风格", "流派", "style", "genre", "归类", "属于什么"), ()),
    Bucket("technical-diagnosis", ("问题", "诊断", "technical", "曝光", "构图", "光线", "材质", "版式"), ()),
    Bucket("commercial-effectiveness", ("转化", "品牌", "传播", "cta", "受众", "营销", "广告"), ()),
)

VISUAL_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp",
    ".heic", ".heif", ".avif", ".jxl", ".svg", ".pdf",
    ".psd", ".ai", ".fig", ".sketch",
    ".dng", ".raw", ".cr2", ".cr3", ".arw", ".nef",
}

# Checked against the PROMPT only: OCR hints and filenames routinely contain
# words like 压缩/裁切 ("JPEG压缩技术大会海报") without meaning the image is unreadable.
INSUFFICIENT_EVIDENCE_TERMS = (
    "看不清", "读不清", "无法辨认", "低清", "糊", "模糊", "裁切", "裁掉", "遮挡",
    "压缩", "马赛克", "分辨率太低",
    "low resolution", "low-res", "lowres", "blurry", "blurred", "cropped",
    "occluded", "blocked", "compressed", "unreadable",
)

AI_CONTENT_TERMS = (
    # Bare "ai" was removed because it matches .ai (Illustrator) filenames.
    "aigc", "midjourney", "stable diffusion", "comfyui",
    "ai生成", "ai 生成", "ai-generated", "ai generated", "ai 出图",
    "真假", "生成感", "手指异常", "文字异常", "伪影",
)

AI_STATED_PHRASES = (
    "ai-generated", "ai generated", "midjourney 生成", "sd 生成", "comfyui 生成",
    "ai 出图", "ai生成的", "这是 ai", "this is ai", "by midjourney", "by stable diffusion",
)

AI_VISIBLE_SIGNAL_PHRASES = (
    "手指异常", "断指", "畸形", "纹理重复", "边缘", "反光异常", "文字异常",
    "broken text", "extra finger", "edge artifact", "uncanny",
)

DEEP_CUES = (
    "深入", "深度", "详细", "完整拆解", "怎么学", "临摹", "学习", "练习",
    "in-depth", "in depth", "deep dive", "detailed", "comprehensive", "thorough",
)
QUICK_CUES = (
    "简单", "快速", "快看", "一句话", "这是什么", "怎么样",
    "quick look", "quickly", "briefly", "one-liner", "tl;dr", "at a glance", "what is this",
)

VISUAL_ATTACHED_PHRASES = (
    "image attached", "attached image", "screenshot attached", "attached screenshot",
    "see the attached", "视觉证据", "图片已附", "截图已附", "图像已附",
    "如图所示", "如图", "见图",
)


def normalize(parts: list[str]) -> str:
    joined = " ".join(part for part in parts if part)
    return re.sub(r"\s+", " ", joined).casefold()


def keyword_matches(keyword: str, corpus: str) -> bool:
    folded = keyword.casefold()
    # ASCII keywords and phrases get word-boundary checks so "this is ai" does
    # not match "this is aimed" and "oil" does not match "soil".
    if re.fullmatch(r"[a-z0-9 _-]+", folded):
        pattern = rf"(?<![a-z0-9]){re.escape(folded)}(?![a-z0-9])"
        return re.search(pattern, corpus) is not None
    return folded in corpus


def has_any(corpus: str, terms: tuple[str, ...]) -> bool:
    return any(keyword_matches(term, corpus) for term in terms)


def compact_len(text: str) -> int:
    return len(re.sub(r"[\s，。！？,.!?：:；;、\"'`~\-_/\\()\[\]{}<>]+", "", text))


def basename_of(path: str) -> str:
    name = path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return name


def url_basename(url: str) -> str:
    stripped = url.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if "://" in stripped:
        stripped = stripped.split("://", 1)[1]
    if "/" not in stripped:
        return ""
    return stripped.rsplit("/", 1)[-1]


def collect_basenames(files: list[str], urls: list[str]) -> list[str]:
    basenames = [basename_of(name) for name in files or ()]
    basenames.extend(name for name in (url_basename(url) for url in urls or ()) if name)
    return [name.casefold() for name in basenames if name]


def has_visual_input(prompt: str, basenames: list[str], hints: list[str]) -> bool:
    # A file/URL basename with a known visual extension counts; notes.txt does not.
    for name in basenames:
        if any(name.endswith(ext) for ext in VISUAL_EXTENSIONS):
            return True
    # The user may have attached an image without a filename — accept hint and prompt mentions.
    combined = normalize([prompt, *(hints or [])])
    return has_any(combined, VISUAL_ATTACHED_PHRASES)


def visual_evidence_insufficient(prompt: str) -> bool:
    return has_any(normalize([prompt]), INSUFFICIENT_EVIDENCE_TERMS)


def _clause_fires(clause: dict, corpus: str) -> bool:
    if "any" in clause:
        return has_any(corpus, tuple(clause["any"]))
    if "all" in clause:
        return all(has_any(corpus, tuple(group)) for group in clause["all"])
    return False


def evaluate_goals(prompt: str, hints: list[str], corpus: str) -> dict[str, bool]:
    scopes = {
        "prompt": normalize([prompt]),
        "prompt_hints": normalize([prompt, *(hints or [])]),
        "corpus": corpus,
    }
    fired = {}
    for name, config in GOALS.items():
        scope = scopes.get(config.get("scope", "prompt"), scopes["prompt"])
        fired[name] = any(_clause_fires(clause, scope) for clause in config.get("clauses", []))
    return fired


def score_bucket(bucket: Bucket, text_corpus: str, basenames: list[str]) -> dict[str, object]:
    matched: list[str] = []
    score = 0

    for keyword in bucket.keywords:
        if keyword_matches(keyword, text_corpus):
            matched.append(keyword)
            score += KEYWORD_WEIGHT

    for regex, weight in bucket.filename_patterns:
        if any(regex.search(name) for name in basenames):
            matched.append(f"pattern:{regex.pattern}")
            score += weight

    return {"name": bucket.name, "score": score, "matched": matched}


def _add_score(route_scores: list[dict[str, object]], route: str, delta: int, reason: str) -> None:
    for item in route_scores:
        if item["name"] == route:
            item["score"] = int(item["score"]) + delta
            matched = list(item["matched"])
            matched.append(f"adjust:{reason}:{delta:+d}")
            item["matched"] = matched
            break


def apply_corpus_adjustments(route_scores: list[dict[str, object]], corpus: str) -> None:
    for adjustment in CORPUS_ADJUSTMENTS:
        require_all = tuple(adjustment.get("require_all", ()))
        require_any = tuple(adjustment.get("require_any", ()))
        forbid_any = tuple(adjustment.get("forbid_any", ()))
        if require_all and not all(keyword_matches(term, corpus) for term in require_all):
            continue
        if require_any and not has_any(corpus, require_any):
            continue
        if forbid_any and has_any(corpus, forbid_any):
            continue
        _add_score(route_scores, adjustment["route"], int(adjustment["delta"]), "corpus")


def apply_goal_rules(route_scores: list[dict[str, object]], fired: dict[str, bool]) -> None:
    for rule in GOAL_RULES:
        if not all(fired.get(goal) for goal in rule.get("when", ())):
            continue
        if any(fired.get(goal) for goal in rule.get("unless", ())):
            continue
        for route, delta in rule.get("adjust", {}).items():
            _add_score(route_scores, route, int(delta), rule.get("reason", "goal"))


def score_routes(prompt: str, files: list[str], hints: list[str], urls: list[str]) -> list[dict[str, object]]:
    basenames = collect_basenames(files, urls)
    text_corpus = normalize([prompt, *(hints or [])])
    full_corpus = normalize([prompt, *(hints or []), *basenames])
    route_scores = [score_bucket(bucket, text_corpus, basenames) for bucket in ROUTES]
    apply_corpus_adjustments(route_scores, full_corpus)
    apply_goal_rules(route_scores, evaluate_goals(prompt, hints, full_corpus))
    route_scores.sort(key=lambda item: (-int(item["score"]), str(item["name"])))
    return route_scores


def choose_route(route_scores: list[dict[str, object]]) -> tuple[str, str, list[dict[str, object]]]:
    top = route_scores[0]
    runner_up = route_scores[1] if len(route_scores) > 1 else {"name": None, "score": 0}
    top_score = int(top["score"])
    top_cluster = [
        item for item in route_scores
        if top_score > 0 and int(item["score"]) >= 3 and top_score - int(item["score"]) <= 1
    ]

    if top_score <= 1:
        top_route = "universal-fallback"
        route_confidence = "low"
    elif len(top_cluster) > 1:
        top_route = "generic-mixed"
        route_confidence = "low"
    else:
        top_route = str(top["name"])
        gap = top_score - int(runner_up["score"])
        route_confidence = "high" if gap >= 4 else "medium" if gap >= 2 else "low"
    return top_route, route_confidence, top_cluster


def score_focuses(prompt: str, hints: list[str]) -> list[dict[str, object]]:
    corpus = normalize([prompt, *(hints or [])])
    focus_scores = [score_bucket(bucket, corpus, []) for bucket in FOCUSES]
    focus_scores = [item for item in focus_scores if int(item["score"]) > 0]
    focus_scores.sort(key=lambda item: (-int(item["score"]), str(item["name"])))
    return focus_scores


def prompt_specificity(prompt: str, focus_scores: list[dict[str, object]], fired: dict[str, bool]) -> str:
    prompt_corpus = normalize([prompt])
    best_prompt_score = max(
        (int(score_bucket(bucket, prompt_corpus, [])["score"]) for bucket in ROUTES),
        default=0,
    )
    if (
        focus_scores
        or best_prompt_score >= 2
        or fired.get("medical-evidence")
        or has_any(prompt_corpus, ("主要", "不是", "按", "从", "对比", "主图", "参考图"))
    ):
        return "high"
    if compact_len(prompt) >= 15:
        return "medium"
    return "low"


def response_depth(prompt: str, focus_scores: list[dict[str, object]], intent_confidence: str) -> str:
    prompt_corpus = normalize([prompt])
    if has_any(prompt_corpus, DEEP_CUES):
        return "deep"
    if focus_scores and str(focus_scores[0]["name"]) == "learning-report":
        return "deep"
    if has_any(prompt_corpus, QUICK_CUES):
        return "quick"
    # A short prompt is only "quick" when it is also unspecific. "看看这张海报的层级"
    # is short but names a concrete dimension, so it deserves a standard report.
    if compact_len(prompt) < 15 and intent_confidence == "low":
        return "quick"
    return "standard"


def study_report_mode(depth: str, focus_scores: list[dict[str, object]]) -> str:
    focus_names = {str(item["name"]) for item in focus_scores}
    if depth == "deep" or "learning-report" in focus_names:
        return "full"
    if depth == "quick" and "learning-report" not in focus_names:
        return "none"
    return "brief"


def classify_one(file_name: str, hints: list[str]) -> dict[str, object]:
    # Per-image priors deliberately exclude the prompt: a strong prompt signal
    # ("拆一下这组海报") would otherwise wash out per-image differences and hide
    # mixed batches (e.g. an xray.png inside a poster batch).
    text_corpus = normalize(list(hints or []))
    basenames = collect_basenames([file_name], [])
    route_scores = [score_bucket(bucket, text_corpus, basenames) for bucket in ROUTES]
    route_scores.sort(key=lambda item: (-int(item["score"]), str(item["name"])))
    top_route, route_confidence, _ = choose_route(route_scores)
    return {
        "file": file_name,
        "top_route": top_route,
        "route_confidence": route_confidence,
        "score": int(route_scores[0]["score"]),
        "route_scores": route_scores[:5],
    }


def detect_batch_type(prompt: str, files: list[str], image_routes: list[dict[str, object]]) -> str:
    prompt_corpus = normalize([prompt, *files])
    if not files and has_any(
        prompt_corpus,
        ("这组", "几张", "多张", "两张", "三张", "几幅", "这几张", "多图", "对比", "before", "after", "reference"),
    ):
        return "unknown"
    if len(files) <= 1:
        return "single"
    # "after"/"v2" alone appear in ordinary prompts ("after the rebrand"); require a
    # comparison pair or an explicitly revision-flavored term.
    if (
        has_any(prompt_corpus, ("前后", "改前", "改后", "revision", "版本", "version"))
        or (has_any(prompt_corpus, ("before",)) and has_any(prompt_corpus, ("after",)))
        or (has_any(prompt_corpus, ("v1",)) and has_any(prompt_corpus, ("v2",)))
    ):
        return "versioned"
    if has_any(prompt_corpus, ("moodboard", "mood board", "参考包", "灵感", "风格板", "reference pack")):
        return "reference_pack"
    # subject_vs_reference requires BOTH a subject role cue AND a reference role cue;
    # "主视觉" is a graphic-design keyword (key visual), not a subject role marker.
    subject_cue = has_any(prompt_corpus, ("主图", "以第一张", "对标", "anchor", "我的图", "我这张"))
    reference_cue = has_any(prompt_corpus, ("参考图", "reference image", "参考图对比", "reference pack"))
    if subject_cue and reference_cue:
        return "subject_vs_reference"
    if reference_cue or has_any(prompt_corpus, ("参考图", "reference")):
        return "reference_pack"
    stable_routes = {
        str(item["top_route"])
        for item in image_routes
        if item["top_route"] not in {"universal-fallback", "generic-mixed", None}
        and item["route_confidence"] in {"medium", "high"}
    }
    if len(stable_routes) > 1:
        return "mixed_domain"
    if len(stable_routes) == 1:
        return "same_series"
    return "unknown"


def batch_size_rule(count: int, batch_type: str) -> str:
    if batch_type == "single":
        return "single"
    if count == 0:
        return "visual-inspection-required"
    if count == 2:
        return "ab-difference"
    if 3 <= count <= 5:
        return "standard-batch"
    return "grouped-batch"


def confidence_summary(status: str, route_confidence: str, intent_confidence: str) -> str:
    if status != "ok":
        return "low"
    if "low" in {route_confidence, intent_confidence}:
        return "low"
    if "medium" in {route_confidence, intent_confidence}:
        return "medium"
    return "high"


def detect_medical_safety(fired: dict[str, bool], basenames: list[str]) -> bool:
    if fired.get("medical-evidence"):
        return True
    # Filename evidence uses the scientific route's specific patterns so that
    # "product-ct.jpg" or "contract-scan.png" do not trip the medical flag.
    scientific = next((b for b in ROUTES if b.name == "scientific-medical-imaging"), None)
    if scientific is None:
        return False
    return any(regex.search(name) for regex, _ in scientific.filename_patterns for name in basenames)


def detect_ai_content_check(corpus: str) -> str:
    # Three tiers matching references/_ai-content-check.md:
    # "stated": the corpus explicitly says the image IS AI-generated
    # "visible": the corpus names visible artifact signals worth checking
    # "not_indicated": nothing points at AI generation
    if has_any(corpus, AI_STATED_PHRASES):
        return "stated"
    if has_any(corpus, AI_VISIBLE_SIGNAL_PHRASES):
        return "visible"
    if has_any(corpus, AI_CONTENT_TERMS):
        return "visible"  # generic AI mention without explicit "stated" or specific signal
    return "not_indicated"


def classify(prompt: str, files: list[str], hints: list[str], urls: list[str] | None = None) -> dict[str, object]:
    if DATA_ERROR is not None:
        raise RouterDataError(DATA_ERROR)
    files = list(files or [])
    hints = list(hints or [])
    urls = list(urls or [])
    basenames = collect_basenames(files, urls)
    full_corpus = normalize([prompt, *hints, *basenames])

    route_scores = score_routes(prompt, files, hints, urls)
    focus_scores = score_focuses(prompt, hints)
    fired = evaluate_goals(prompt, hints, full_corpus)
    top_route, route_confidence, top_cluster = choose_route(route_scores)
    intent_confidence = prompt_specificity(prompt, focus_scores, fired)
    depth = response_depth(prompt, focus_scores, intent_confidence)
    visual_names = files + [url for url in urls if url_basename(url)]
    image_routes = [classify_one(name, hints) for name in visual_names]
    batch_type = detect_batch_type(prompt, visual_names, image_routes)

    status = "ok"
    if not has_visual_input(prompt, basenames, hints):
        status = "visual_input_missing"
        top_route = None
        route_confidence = "low"
    elif visual_evidence_insufficient(prompt):
        status = "visual_evidence_insufficient"
        top_route = None
        route_confidence = "low"
    elif (
        batch_type in {"single", "unknown"}
        and top_route == "generic-mixed"
        and intent_confidence == "low"
    ):
        # Readable image, but tied routes plus an unclear goal: ask first.
        status = "needs_clarification"

    confidence = confidence_summary(status, route_confidence, intent_confidence)

    notes = [
        "Use the result as a routing prior only.",
        "Confirm the chosen route with actual visual inspection before writing the report.",
    ]
    if status == "visual_input_missing":
        notes.append("No visual input was provided to the router; ask upstream for image evidence.")
    elif status == "visual_evidence_insufficient":
        notes.append("Visual evidence appears too limited to route reliably; do not force fallback.")
    elif status == "needs_clarification":
        notes.append("The image can be read, but the user's intended lens is unclear enough to ask first.")
    elif top_route == "universal-fallback":
        notes.append(
            "No named route scored above zero; use the universal-fallback method and keep route guesses provisional."
        )
    elif top_route == "generic-mixed":
        tied_routes = ", ".join(str(item["name"]) for item in top_cluster)
        notes.append(
            f"Multiple routes tie at the top ({tied_routes}); use generic-mixed triage before committing."
        )
    elif route_confidence == "low":
        runner_up = route_scores[1] if len(route_scores) > 1 else {"name": None}
        notes.append(
            f"Top route '{top_route}' is only weakly separated from '{runner_up['name']}'."
        )

    if batch_type != "single":
        notes.append(f"Batch type prior: {batch_type}; verify count and grouping visually.")

    # Only surface routes/focuses that actually scored above 0 as clarification options.
    scored_routes = [str(item["name"]) for item in route_scores if int(item.get("score", 0)) > 0][:3]
    scored_focuses = [str(item["name"]) for item in focus_scores if int(item.get("score", 0)) > 0][:3]
    clarification_options = {
        "routes": scored_routes,
        "focuses": scored_focuses or [
            "learning-report",
            "style-classification",
            "technical-diagnosis",
            "commercial-effectiveness",
        ],
    }

    return {
        "status": status,
        "top_route": top_route,
        "confidence": confidence,
        "route_confidence": route_confidence,
        "intent_confidence": intent_confidence,
        "response_depth": depth,
        "study_report_mode": study_report_mode(depth, focus_scores),
        "batch_type": batch_type,
        "batch_size_rule": batch_size_rule(len(visual_names), batch_type),
        "medical_safety": detect_medical_safety(fired, basenames),
        "ai_content_check": detect_ai_content_check(full_corpus),
        "clarification_options": clarification_options,
        "image_routes": image_routes,
        "route_scores": route_scores,
        "focus_scores": focus_scores,
        "notes": notes,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a routing prior for image-analysis-router."
    )
    parser.add_argument("--prompt", default="", help="User request or question.")
    parser.add_argument(
        "--file",
        dest="files",
        action="append",
        default=[],
        help="File name or path. Repeat for multiple files.",
    )
    parser.add_argument(
        "--hint",
        dest="hints",
        action="append",
        default=[],
        help="Optional OCR, caption, or metadata hint. Repeat as needed.",
    )
    parser.add_argument(
        "--source-note-path",
        dest="source_note_path",
        default="",
        help="Path to a source note owned by an upstream caller (informational; not used by the keyword router).",
    )
    parser.add_argument(
        "--source-url",
        dest="source_urls",
        action="append",
        default=[],
        help="Source URL(s) for the image. URL basenames count as visual input and are scored like filenames.",
    )
    parser.add_argument(
        "--attachment",
        dest="attachments",
        action="append",
        default=[],
        help="Local attachment path; treated like --file for routing.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress route_scores/focus_scores/image_routes from output.",
    )
    parser.add_argument(
        "--strict-files",
        action="store_true",
        help="If set, require every --file/--attachment path to exist on disk (URLs are not checked).",
    )
    parser.add_argument(
        "--strict-exit",
        action="store_true",
        help="If set, exit non-zero on blocking statuses (10/11/12/13). Default: always exit 0.",
    )
    return parser.parse_args()


QUIET_FIELDS = (
    "status",
    "top_route",
    "confidence",
    "route_confidence",
    "intent_confidence",
    "response_depth",
    "study_report_mode",
    "batch_type",
    "batch_size_rule",
    "medical_safety",
    "ai_content_check",
    "clarification_options",
)

# Process exit codes: 0 = ok routing. Non-zero codes give callers a machine-readable
# distinction between blocking conditions without parsing JSON.
STATUS_EXIT_CODES = {
    "ok": 0,
    "needs_clarification": 10,
    "visual_evidence_insufficient": 11,
    "visual_input_missing": 12,
    "router_unavailable": 13,
}


def main() -> int:
    args = parse_args()
    if DATA_ERROR is not None:
        print(json.dumps({
            "status": "router_unavailable",
            "blocked_step": "route",
            "blocked_reason": DATA_ERROR,
            "suggested_action": "Proceed with visual-only routing; the keyword prior is unavailable.",
        }, ensure_ascii=False, indent=2))
        return STATUS_EXIT_CODES["router_unavailable"] if args.strict_exit else 0
    # --attachment is just an extra --file (kept separate so the CLI labels stay clear).
    merged_files = list(args.files) + list(args.attachments)
    if args.strict_files:
        missing = [p for p in merged_files if p and not Path(p).exists()]
        if missing:
            print(json.dumps({
                "status": "visual_input_missing",
                "blocked_step": "file-check",
                "blocked_reason": f"missing file(s): {missing}",
            }, ensure_ascii=False))
            return STATUS_EXIT_CODES["visual_input_missing"] if args.strict_exit else 0
    result = classify(args.prompt, merged_files, args.hints, args.source_urls)
    if args.source_note_path:
        result["source_note_path"] = args.source_note_path
    if args.source_urls:
        result["source_urls"] = args.source_urls
    if args.quiet:
        result = {k: result.get(k) for k in QUIET_FIELDS if k in result}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.strict_exit:
        return 0
    return STATUS_EXIT_CODES.get(str(result.get("status", "ok")), 0)


if __name__ == "__main__":
    import sys as _sys
    _sys.exit(main())
