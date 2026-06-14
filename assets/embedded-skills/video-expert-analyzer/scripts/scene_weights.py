#!/usr/bin/env python3
"""场景加权评分的唯一权威实现。

此前 scoring_helper_enhanced / host_batching / ai_analyzer 各自维护一套
权重公式，TYPE-A 的 aesthetic/fun 权重互相矛盾、TYPE-C 的维度组合不同、
缺失分默认值也不一致（0 vs 5）——同一个场景在不同阶段会算出不同的
weighted_score。三处现已全部委托到这里。

软混合：有效权重 = (1-α)·类型档位 + α·均匀权重。
- α 默认 0.4（VNEXT_TYPE_WEIGHT_SOFTENING 可调，设 0 还原旧的硬切换）
- 每个维度的有效权重 ≥ α/5：修复 fun/credibility 在部分类型下权重为 0、
  却仍要求模型打分的逻辑矛盾
- TYPE 来自模型自判且无验证，软混合给误判的伤害设上界：类型档位只决定
  (1-α) 部分的倾斜，误判不再让单一维度归零

百分位：weighted_score 的绝对值受打分模型口径影响，跨视频不可比；
weighted_percentile 是视频内排名（0-100），跨视频对比与精选兜底用它。
"""

from __future__ import annotations

import os
from typing import Dict, List, Sequence

DIMENSION_KEYS = (
    "aesthetic_beauty",
    "credibility",
    "impact",
    "memorability",
    "fun_interest",
)

UNIFORM_WEIGHTS: Dict[str, float] = {key: 0.2 for key in DIMENSION_KEYS}

# 类型档位沿用 host_batching / ai_analyzer 一致的那套（两条生产路径的共识）
TYPE_WEIGHT_PROFILES: Dict[str, Dict[str, float]] = {
    "TYPE-A": {"impact": 0.40, "memorability": 0.30, "aesthetic_beauty": 0.20, "fun_interest": 0.10, "credibility": 0.0},
    "TYPE-B": {"credibility": 0.40, "memorability": 0.30, "aesthetic_beauty": 0.20, "fun_interest": 0.10, "impact": 0.0},
    "TYPE-C": {"aesthetic_beauty": 0.50, "impact": 0.20, "memorability": 0.20, "credibility": 0.10, "fun_interest": 0.0},
    "TYPE-D": {"credibility": 0.40, "memorability": 0.40, "aesthetic_beauty": 0.20, "impact": 0.0, "fun_interest": 0.0},
}

_TYPE_KEYWORDS = (
    ("TYPE-A", ("TYPE-A", "Hook", "Kinetic")),
    ("TYPE-B", ("TYPE-B", "Narrative", "Emotion")),
    ("TYPE-C", ("TYPE-C", "Aesthetic", "Vibe")),
    ("TYPE-D", ("TYPE-D", "Commercial", "Info")),
)

DEFAULT_TYPE_WEIGHT_SOFTENING = 0.4


def resolve_type_key(scene_type: object) -> str:
    text = str(scene_type or "")
    for type_key, keywords in _TYPE_KEYWORDS:
        if any(keyword in text for keyword in keywords):
            return type_key
    return ""


def type_weight_softening() -> float:
    try:
        value = float(os.environ.get("VNEXT_TYPE_WEIGHT_SOFTENING", str(DEFAULT_TYPE_WEIGHT_SOFTENING)))
    except (TypeError, ValueError):
        value = DEFAULT_TYPE_WEIGHT_SOFTENING
    return min(1.0, max(0.0, value))


def effective_weights(scene_type: object, softening: float | None = None) -> Dict[str, float]:
    type_key = resolve_type_key(scene_type)
    if not type_key:
        return dict(UNIFORM_WEIGHTS)
    alpha = type_weight_softening() if softening is None else min(1.0, max(0.0, softening))
    profile = TYPE_WEIGHT_PROFILES[type_key]
    return {
        key: (1.0 - alpha) * profile.get(key, 0.0) + alpha * UNIFORM_WEIGHTS[key]
        for key in DIMENSION_KEYS
    }


def weighted_score(scene: Dict, softening: float | None = None) -> float:
    scores = scene.get("scores", {}) or {}
    weights = effective_weights(scene.get("type_classification", ""), softening=softening)
    total = 0.0
    for key in DIMENSION_KEYS:
        raw = scores.get(key, 0)
        try:
            value = float(raw or 0)
        except (TypeError, ValueError):
            value = 0.0
        total += value * weights[key]
    return round(total, 2)


def selection_label(weighted: float, scores: Dict) -> str:
    values = [value for value in (scores or {}).values() if isinstance(value, (int, float))]
    if weighted >= 8.5 or any(value == 10 for value in values):
        return "[MUST KEEP]"
    if weighted >= 7.0:
        return "[USABLE]"
    return "[DISCARD]"


def annotate_percentiles(scenes: Sequence[Dict]) -> None:
    """为已评分场景写入 weighted_percentile（视频内排名 0-100，含并列）。"""
    scored: List[Dict] = []
    for scene in scenes:
        try:
            value = float(scene.get("weighted_score", 0) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            scored.append(scene)
        else:
            scene.pop("weighted_percentile", None)
    if not scored:
        return
    values = sorted(float(s.get("weighted_score", 0) or 0) for s in scored)
    count = len(values)
    for scene in scored:
        score = float(scene.get("weighted_score", 0) or 0)
        at_or_below = sum(1 for value in values if value <= score)
        scene["weighted_percentile"] = round(100.0 * at_or_below / count, 1)
