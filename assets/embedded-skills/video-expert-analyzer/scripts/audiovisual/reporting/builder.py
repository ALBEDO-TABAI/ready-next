#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Sequence

from audiovisual.reporting import markdown as _markdown
from audiovisual.reporting import raw_prompt_adapter as _raw_prompt_adapter
from audiovisual.reporting import template_engine as _template_engine
from audiovisual.reporting import value_focus as _value_focus
from audiovisual.reporting.handoff import AudiovisualHandoffCoordinator
from audiovisual.rendering.pdf import load_storyboard_context_rows, write_audiovisual_report_pdf
from audiovisual.routing.enrich import enrich_audiovisual_layers
from audiovisual.shared import (
    _analysis_rows,
    _markdown_media_path,
    _normalize_markdown_image_links,
    _safe_text,
    _scene_desc,
    _scene_screenshot,
)
from classification_summary import build_classification_summary_payload, classification_summary_hash


def _resolve_runtime_config() -> Dict[str, Any]:
    from ai_analyzer import resolve_auto_scoring_config

    return resolve_auto_scoring_config()


def _env_truthy(name: str) -> bool:
    value = os.environ.get(name, "")
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _require_new_route_contract(data: Dict[str, Any]) -> str:
    route = data.get("audiovisual_route") or {}
    classification_result = data.get("classification_result") or {}
    classification = classification_result.get("classification") if isinstance(classification_result, dict) else {}

    type_key = ""
    if isinstance(classification, dict):
        type_key = _safe_text(classification.get("type"))
    if not type_key and isinstance(route, dict):
        type_key = _safe_text(route.get("child_type"))

    if not type_key:
        raise RuntimeError("视听剖析要求子类型路由结果，拒绝旧的 framework-only 路线")

    if not _raw_prompt_adapter.raw_prompt_available_for_data(data, route):
        raise FileNotFoundError(f"新路线缺少 raw prompt，无法继续生成视听剖析：{type_key}")

    return type_key


def _classification_cache_status(
    data: Dict,
    video_dir: Path,
) -> tuple[Dict[str, Any] | None, str]:
    route_result_path = video_dir / "classification_result.json"
    if not route_result_path.exists():
        return None, "absent"

    cached = json.loads(route_result_path.read_text(encoding="utf-8"))
    if not isinstance(cached, dict):
        return None, "unverifiable"

    cached_summary_source = cached.get("summary_source") or {}
    cached_hash = _safe_text(cached_summary_source.get("summary_hash")) if isinstance(cached_summary_source, dict) else ""
    if not cached_hash:
        return None, "unverifiable"

    current_hash = classification_summary_hash(build_classification_summary_payload(data))
    if cached_hash != current_hash:
        return None, "stale"
    return cached, "fresh"


def build_audiovisual_report_markdown(
    data: Dict,
    report_dir: Path | None = None,
    runtime_config: Dict[str, Any] | None = None,
    request_fn: Callable[[str, str], str] | None = None,
) -> str:
    original_enrich = _markdown.enrich_audiovisual_layers
    _markdown.enrich_audiovisual_layers = enrich_audiovisual_layers
    try:
        return _markdown.build_audiovisual_report_markdown(
            data,
            report_dir=report_dir,
            runtime_config=runtime_config,
            request_fn=request_fn,
        )
    finally:
        _markdown.enrich_audiovisual_layers = original_enrich


def _resolve_raw_prompt_source(data: Dict, route: Dict[str, Any]) -> str | None:
    prompt_path = _raw_prompt_adapter.resolve_raw_prompt_path_for_data(data, route)
    if prompt_path is None:
        return None
    project_root = Path(__file__).resolve().parents[3]
    try:
        return prompt_path.resolve().relative_to(project_root).as_posix()
    except ValueError:
        return prompt_path.name


def assemble_audiovisual_report_markdown(
    data: Dict,
    report_dir: Path | None = None,
    runtime_config: Dict[str, Any] | None = None,
    coordinator: AudiovisualHandoffCoordinator | None = None,
) -> tuple[str, Dict[str, Path]]:
    route = data.get("audiovisual_route") or {}
    body_request_fn: Callable[[str, str], str] | None = None
    if coordinator is not None:
        body_prompt_source = _resolve_raw_prompt_source(data, route)

        def body_request_fn(system_prompt: str, user_message: str) -> str:
            return coordinator.request_body(
                system_prompt,
                user_message,
                prompt_source=body_prompt_source,
            )
    markdown = build_audiovisual_report_markdown(
        data,
        report_dir=report_dir,
        runtime_config=runtime_config,
        request_fn=body_request_fn,
    )
    diagram_assets: Dict[str, Path] = {}

    if report_dir is None:
        return markdown, diagram_assets

    diagram_request_fn: Callable[[str, str], str] | None = (
        coordinator.request_diagram if coordinator is not None else None
    )
    overview_request_fn: Callable[[str, str], str] | None = (
        coordinator.request_overview if coordinator is not None else None
    )

    generated: Dict[str, Any] = {}
    if _template_engine.child_type_supports_svg_diagram(data, route):
        generated = _template_engine.generate_child_type_svg_diagram_assets(
            markdown,
            data,
            route,
            report_dir,
            runtime_config=runtime_config,
            request_fn=diagram_request_fn,
        )
        image_path = generated.get("png")
        if image_path:
            markdown = _template_engine.prepend_report_diagram(
                markdown,
                image_path,
                generated.get("title") or "视频结构图",
                generated.get("summary") or "",
                report_dir=report_dir,
            )
    elif _template_engine.route_supports_mv_overview(route):
        generated = _template_engine.generate_mv_overview_assets(
            markdown,
            data,
            route,
            report_dir,
            runtime_config=runtime_config,
            request_fn=overview_request_fn,
        )
        image_path = generated.get("png")
        if image_path:
            markdown = _template_engine.prepend_mv_overview(
                markdown,
                image_path,
                generated.get("title") or "视频内容架构总览",
                generated.get("summary") or "",
                report_dir=report_dir,
            )

    diagram_assets = {key: value for key, value in generated.items() if isinstance(value, Path)}
    return markdown, diagram_assets


def _iter_analysis_rows(data: Dict) -> List[Dict[str, Any]]:
    try:
        return _analysis_rows(data)
    except Exception:
        return []


def _scene_weighted_score(scene: Dict[str, Any]) -> float:
    try:
        return float(scene.get("weighted_score") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _scene_visual_line(scene: Dict[str, Any]) -> str:
    text = _scene_desc(scene) or _safe_text(scene.get("visual_summary"))
    if not text:
        return ""
    first = text.replace("\r\n", "\n").split("\n", 1)[0].strip()
    return first[:80]


def _build_scene_image_catalog(data: Dict, report_dir: Path) -> List[Dict[str, Any]]:
    rows = _iter_analysis_rows(data)
    catalog: List[Dict[str, Any]] = []
    for scene in rows:
        try:
            scene_number = int(scene.get("scene_number", 0))
        except (TypeError, ValueError):
            continue
        if scene_number <= 0:
            continue
        raw_path = _scene_screenshot(scene)
        if not raw_path:
            continue
        absolute = Path(raw_path)
        if not absolute.is_absolute():
            absolute = (report_dir / absolute).resolve()
        if not absolute.exists() or not absolute.is_file():
            continue
        rel_path = _markdown_media_path(str(absolute), report_dir)
        if not rel_path:
            continue
        storyboard = scene.get("storyboard") or {}
        timestamp = _safe_text(
            scene.get("timestamp")
            or scene.get("timestamp_range")
            or storyboard.get("timestamp")
        )
        catalog.append(
            {
                "scene_number": scene_number,
                "timestamp": timestamp,
                "visual": _scene_visual_line(scene),
                "rel_path": rel_path,
                "weighted": _scene_weighted_score(scene),
            }
        )
    return catalog


_IMAGE_LINK_RE = re.compile(r"!\[[^\]]*\]\(<?([^)>]+)>?\)")
_SCENE_REF_RE = re.compile(r"\bScene\s*0*(\d+)\b")


def _extract_image_paths(markdown_text: str) -> List[str]:
    return [match.group(1).strip() for match in _IMAGE_LINK_RE.finditer(markdown_text)]


def _validate_illustrated_markdown(
    illustrated: str,
    original: str,
    catalog: Sequence[Dict[str, Any]],
) -> None:
    allowed_paths = {str(item.get("rel_path", "")).strip() for item in catalog}
    allowed_paths.discard("")
    pre_existing = set(_extract_image_paths(original))
    new_paths = [
        path for path in _extract_image_paths(illustrated) if path not in pre_existing
    ]

    fabricated = [path for path in new_paths if path not in allowed_paths]
    if fabricated:
        raise ValueError(
            "illustrate 输出包含目录外的截图路径："
            + "、".join(sorted(set(fabricated)))
        )

    paragraphs = [block.strip() for block in illustrated.split("\n\n")]
    window: List[str] = []
    for block in paragraphs:
        paths_in_block = [path for path in _extract_image_paths(block) if path not in pre_existing]
        for path in paths_in_block:
            if path in window:
                raise ValueError(f"illustrate 输出在 3 段以内重复插入同一张图：{path}")
        window.extend(paths_in_block)
        if len(window) > 3:
            window = window[-3:]


_TRAILING_BLOCKQUOTE_KEYWORD = "视听对齐度"
_TRAILING_TABLE_KEYWORDS = ("本片在这一维", "这一维在看什么")


def _find_trailing_zone_start(lines: List[str]) -> Optional[int]:
    """Return the line index where the post-body trailing zone begins.

    Trailing zone = the summary blockquote (`> **视听对齐度**：…`) plus the final
    scoring table that follows. No agent-inserted screenshots belong here per
    SKILL rule 14 #4 ("报告首尾、生成时间、表格内部不要插图")."""
    for idx, raw in enumerate(lines):
        s = raw.strip()
        if s.startswith("> ") and _TRAILING_BLOCKQUOTE_KEYWORD in s:
            return idx
        if s.startswith("|") and any(kw in s for kw in _TRAILING_TABLE_KEYWORDS):
            return idx
    return None


def _strip_trailing_orphan_images(illustrated: str, original: str) -> str:
    """Drop agent-inserted screenshots placed inside the trailing zone.

    The illustration step must not treat the summary blockquote's Scene
    list as a body paragraph and insert an image after it. That image lands
    between the summary and the final scoring table where it adds noise.
    Pre-existing images (already in the body) are kept untouched."""
    pre_existing = set(_extract_image_paths(original))
    lines = illustrated.split("\n")
    cutoff = _find_trailing_zone_start(lines)
    if cutoff is None:
        return illustrated

    out: List[str] = lines[:cutoff]
    i = cutoff
    while i < len(lines):
        line = lines[i]
        match = _IMAGE_LINK_RE.search(line.strip())
        if match and match.group(1).strip() not in pre_existing:
            i += 1
            while i < len(lines) and not lines[i].strip():
                i += 1
            if i < len(lines):
                stripped = lines[i].strip()
                if (
                    stripped.startswith("*")
                    and stripped.endswith("*")
                    and not stripped.startswith("**")
                    and "·" in stripped
                ):
                    i += 1
                    if i < len(lines) and not lines[i].strip():
                        i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


_CAPTION_PREFIX = "*Scene "


def _format_image_caption(item: Dict[str, Any]) -> str:
    """Render the small italic caption shown right under an illustrate-inserted screenshot."""
    scene_num = int(item.get("scene_number") or 0)
    visual = str(item.get("visual") or "").strip()
    parts = [f"Scene {scene_num:03d}"]
    timestamp = str(item.get("timestamp") or "").strip()
    if timestamp:
        parts.append(timestamp)
    if visual:
        parts.append(f"画面：{visual}")
    return f"*{' · '.join(parts)}*"


def _is_existing_caption_line(line: str) -> bool:
    return line.lstrip().startswith(_CAPTION_PREFIX)


def _annotate_image_captions(
    illustrated: str,
    original: str,
    catalog: Sequence[Dict[str, Any]],
) -> str:
    """Insert a small italic caption (`*Scene NNN · 画面：…*`) under each newly-inserted image.

    Pre-existing images (from FIGURE blocks, etc.) already carry their own `- 图注：…`
    bullet, so we leave them alone.
    """
    catalog_index: Dict[str, Dict[str, Any]] = {
        str(item.get("rel_path", "")).strip(): item
        for item in catalog
        if str(item.get("rel_path", "")).strip()
    }
    if not catalog_index:
        return illustrated
    pre_existing = set(_extract_image_paths(original))

    lines = illustrated.split("\n")
    out: List[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        match = _IMAGE_LINK_RE.search(line.strip())
        if match:
            path = match.group(1).strip()
            item = catalog_index.get(path)
            if item is not None and path not in pre_existing:
                lookahead = 1
                while i + lookahead < len(lines) and not lines[i + lookahead].strip():
                    lookahead += 1
                next_line = lines[i + lookahead] if i + lookahead < len(lines) else ""
                if not _is_existing_caption_line(next_line):
                    out.append("")
                    out.append(_format_image_caption(item))
        i += 1
    return "\n".join(out)


def _illustration_skip_heading(heading: str) -> bool:
    if heading == _value_focus.SUMMARY_SECTION_HEADING:
        return True
    if heading == "## 路由判断":
        return True
    return any(keyword in heading for keyword in ("视听剖析概览", "视频结构图", "视频内容架构总览", "结构图"))


def _block_is_heading(block_lines: Sequence[str]) -> bool:
    first = next((line.strip() for line in block_lines if line.strip()), "")
    return first.startswith("#")


def _block_is_table(block_lines: Sequence[str]) -> bool:
    non_empty = [line.strip() for line in block_lines if line.strip()]
    return bool(non_empty) and all(line.startswith("|") for line in non_empty)


def _next_nonblank_line(lines: Sequence[str], start: int) -> str:
    for line in lines[start:]:
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _scene_refs_in_text(text: str) -> List[int]:
    refs: List[int] = []
    seen = set()
    for match in _SCENE_REF_RE.finditer(text):
        try:
            scene_number = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if scene_number <= 0 or scene_number in seen:
            continue
        refs.append(scene_number)
        seen.add(scene_number)
    return refs


def _choose_scene_for_block(
    scene_refs: Sequence[int],
    by_scene: Dict[int, Dict[str, Any]],
    recent_paths: Sequence[str],
    pre_existing_paths: set[str],
) -> Dict[str, Any] | None:
    candidates = [
        by_scene[scene_number]
        for scene_number in scene_refs
        if scene_number in by_scene
    ]
    available = [
        item for item in candidates
        if str(item.get("rel_path") or "") not in recent_paths
        and str(item.get("rel_path") or "") not in pre_existing_paths
    ]
    if not available:
        return None
    first = candidates[0]
    if first in available:
        return first
    return max(available, key=lambda item: float(item.get("weighted") or 0.0))


def _render_scene_image_line(item: Dict[str, Any]) -> str:
    scene_number = int(item.get("scene_number") or 0)
    return f"![Scene {scene_number:03d}](<{item['rel_path']}>)"


def _illustrate_scene_screenshots(markdown_text: str, data: Dict, report_dir: Path) -> str:
    catalog = _build_scene_image_catalog(data, report_dir)
    if not catalog:
        return markdown_text
    by_scene = {
        int(item["scene_number"]): item
        for item in catalog
        if int(item.get("scene_number") or 0) > 0 and str(item.get("rel_path") or "").strip()
    }
    if not by_scene:
        return markdown_text

    pre_existing = set(_extract_image_paths(markdown_text))
    lines = markdown_text.split("\n")
    trailing_start = _find_trailing_zone_start(lines)
    out: List[str] = []
    current_heading = ""
    recent_paths: List[str] = []
    in_code_fence = False
    index = 0

    while index < len(lines):
        if not in_code_fence and not lines[index].strip():
            out.append(lines[index])
            index += 1
            continue

        if not in_code_fence and lines[index].strip().startswith("#"):
            heading = lines[index].strip()
            if heading.startswith("## ") and not heading.startswith("### "):
                current_heading = heading
            out.append(lines[index])
            index += 1
            continue

        block_start = index
        block_lines: List[str] = []
        block_has_code = in_code_fence
        while index < len(lines):
            stripped = lines[index].strip()
            if not in_code_fence and not stripped:
                break
            block_lines.append(lines[index])
            if stripped.startswith("```"):
                in_code_fence = not in_code_fence
                block_has_code = True
            index += 1

        first = next((line.strip() for line in block_lines if line.strip()), "")
        if first.startswith("## ") and not first.startswith("### "):
            current_heading = first

        out.extend(block_lines)
        block_text = "\n".join(block_lines)
        if (
            block_start >= (trailing_start if trailing_start is not None else len(lines) + 1)
            or block_has_code
            or _block_is_heading(block_lines)
            or _block_is_table(block_lines)
            or _illustration_skip_heading(current_heading)
            or _IMAGE_LINK_RE.search(block_text)
            or _IMAGE_LINK_RE.search(_next_nonblank_line(lines, index))
        ):
            continue

        scene_refs = _scene_refs_in_text(block_text)
        item = _choose_scene_for_block(scene_refs, by_scene, recent_paths, pre_existing)
        if item is None:
            continue

        path = str(item.get("rel_path") or "").strip()
        if not path:
            continue
        out.extend(["", _render_scene_image_line(item)])
        pre_existing.add(path)
        recent_paths.append(path)
        recent_paths = recent_paths[-3:]

    illustrated = "\n".join(out)
    illustrated = _strip_trailing_orphan_images(illustrated, markdown_text)
    _validate_illustrated_markdown(illustrated, markdown_text, catalog)
    return _annotate_image_captions(illustrated, markdown_text, catalog)


def _try_illustrate_scene_screenshots(markdown_text: str, data: Dict, report_dir: Path) -> str:
    try:
        return _illustrate_scene_screenshots(markdown_text, data, report_dir)
    except Exception as exc:
        print(f"⚠️ 视听剖析场景插图跳过：{exc}", file=sys.stderr)
        return markdown_text


def generate_audiovisual_report_outputs(
    data: Dict,
    video_dir: Path,
    formats: Sequence[str] = ("md", "pdf"),
    runtime_config: Dict[str, Any] | None = None,
) -> Dict[str, object]:
    enriched = dict(data)
    video_id = _safe_text(enriched.get("video_id"), "unknown")
    if runtime_config is None:
        runtime_config = _resolve_runtime_config()

    cache_status = "provided" if isinstance(enriched.get("classification_result"), dict) else "absent"
    if not isinstance(enriched.get("classification_result"), dict):
        cached_result, cache_status = _classification_cache_status(enriched, video_dir)
        if cached_result is not None:
            enriched["classification_result"] = cached_result
    context_rows = load_storyboard_context_rows(video_dir, video_id)
    if context_rows:
        enriched["storyboard_context_rows"] = context_rows
    enriched = enrich_audiovisual_layers(enriched)
    _require_new_route_contract(enriched)
    enriched["_classification_result_cache_status"] = cache_status

    coordinator = (
        AudiovisualHandoffCoordinator(video_dir, video_id)
        if _env_truthy("AUDIOVISUAL_REPORT_HANDOFF")
        else None
    )

    generated: Dict[str, Path] = {}
    normalized = [item.strip().lower() for item in formats if item and item.strip()]
    markdown_text, diagram_assets = assemble_audiovisual_report_markdown(
        enriched,
        report_dir=video_dir,
        runtime_config=runtime_config,
        coordinator=coordinator,
    )
    markdown_text = _try_illustrate_scene_screenshots(markdown_text, enriched, video_dir)
    markdown_text = _normalize_markdown_image_links(markdown_text, video_dir)

    if "md" in normalized:
        md_path = video_dir / f"{video_id}_audiovisual_analysis.md"
        md_path.write_text(markdown_text, encoding="utf-8")
        generated["md"] = md_path

    if "pdf" in normalized:
        pdf_path = video_dir / f"{video_id}_audiovisual_analysis.pdf"
        generated["pdf"] = write_audiovisual_report_pdf(enriched, pdf_path, report_dir=video_dir, markdown_text=markdown_text)

    generated.update(diagram_assets)

    if "md" in generated:
        generated["report_path"] = generated["md"]

    return {
        "data": enriched,
        "report_mode": "template",
        "classification_result_cache_status": cache_status,
        **generated,
    }
