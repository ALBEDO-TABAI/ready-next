#!/usr/bin/env python3
"""每条路线的「导读」价值配方。

导读回答的不是固定的"这片做得好不好"，而是该类型观众带着进来的那个问题：
访谈观众想知道聊出了什么，知识片观众想知道讲了什么思路，MV 观众想知道
音画配合最出彩的段落在哪。配方给出三样东西：

- value_question：导读必须回答的价值问题（默认值；用户在对话里表达过
  关注点时以用户意图为准，配方退为兜底）
- evidence_priority：回答这个问题应优先采用的证据流（语言主导类型以
  台词/转写原话为主，评分只是辅助）
- transcript_heavy：True 时分镜表上下文给台词留更长的引用配额

价值取向本身不做机器校验——"微妙"的部分留在 prompt 层和对话层；
校验层只管结构与反注水（字数上限、场景引用、术语黑名单）。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

SUMMARY_SECTION_TITLE = "导读"
SUMMARY_SECTION_HEADING = f"## {SUMMARY_SECTION_TITLE}"

# 导读是写给普通观众的，框架内部术语出现即打回。
SUMMARY_JARGON_BLACKLIST = (
    "双轴",
    "路由",
    "冯·雷斯托夫",
    "Restorff",
    "加权分",
    "维度评分",
)

_DEFAULT_RECIPE: Dict[str, Any] = {
    "value_question": "这条视频最值得看的内容是什么、出现在哪里？",
    "audience": "想快速判断这条视频值不值得花时间看完的观众",
    "evidence_priority": ["高分场景与其画面内容", "台词/旁白要点", "节奏与结构"],
    "transcript_heavy": False,
}

# key = 分类结果里的子类型 type_key（与 chart/file-Prompt 的 raw prompt 一一对应）
VALUE_FOCUS_RECIPES: Dict[str, Dict[str, Any]] = {
    "talking_head": {
        "value_question": "这期对谈/口播里最值得听的内容是什么？最精彩的表达或交锋出现在哪里？",
        "audience": "想知道这期聊了什么、有没有干货的观众",
        "evidence_priority": ["台词/转写原话（直接引用 + 时间码）", "问答交锋的节点", "高分场景"],
        "transcript_heavy": True,
    },
    "video_essay": {
        "value_question": "这期解说提出了什么观点？论证里最有说服力（或最薄弱）的一环在哪里？",
        "audience": "想知道这期讲了什么观点、值不值得听完的观众",
        "evidence_priority": ["解说词原话（直接引用 + 时间码）", "论证结构的关键转折", "配画面的证据力"],
        "transcript_heavy": True,
    },
    "explainer": {
        "value_question": "这片讲明白了什么知识或方法？核心思路能否一句话带走？",
        "audience": "想知道能学到什么、讲得清不清楚的观众",
        "evidence_priority": ["讲解文本的知识点（引用 + 时间码）", "图示/演示画面", "讲解节奏"],
        "transcript_heavy": True,
    },
    "documentary": {
        "value_question": "这部片记录了什么？最打动人或信息量最大的真实瞬间在哪里？",
        "audience": "想知道这部片拍了什么、真不真实的观众",
        "evidence_priority": ["真实瞬间的画面与同期声", "解说/采访原话（引用 + 时间码）", "高分场景"],
        "transcript_heavy": True,
    },
    "narrative_short": {
        "value_question": "故事讲了什么？最打动人的段落（剧情转折、表演或画面）在哪里？",
        "audience": "想知道故事好不好看的观众",
        "evidence_priority": ["剧情关键转折与对应场景", "表演/台词的高光", "美术与摄影的记忆点"],
        "transcript_heavy": False,
    },
    "narrative_trailer": {
        "value_question": "这支预告立住了什么卖点？最勾人的悬念或画面在哪里？",
        "audience": "想判断正片值不值得期待的观众",
        "evidence_priority": ["悬念节点与对应画面", "卖点镜头", "节奏铺排"],
        "transcript_heavy": False,
    },
    "mood_montage": {
        "value_question": "这条片的氛围和质感靠什么立起来？最迷人的画面段落在哪里？",
        "audience": "想感受画面氛围、找视觉参考的观众",
        "evidence_priority": ["氛围峰值的画面段落", "色彩/光影的记忆点", "剪辑节奏"],
        "transcript_heavy": False,
    },
    "concept_mv": {
        "value_question": "这支 MV 的概念是什么？音乐与画面配合最出彩的段落在哪里？",
        "audience": "想知道这支 MV 看点在哪的观众",
        "evidence_priority": ["概念意象的关键画面", "音乐段落与画面的配合", "视觉风格"],
        "transcript_heavy": False,
    },
    "performance_mv": {
        "value_question": "这支表演视频最有感染力的段落在哪里？表演与镜头的配合好在哪？",
        "audience": "想看表演高光的观众",
        "evidence_priority": ["表演高光段落", "镜头调度", "节奏配合"],
        "transcript_heavy": False,
    },
    "rhythm_remix": {
        "value_question": "这条混剪剪得爽不爽？卡点和素材选择最妙的段落在哪里？",
        "audience": "想看剪辑技巧和节奏感的观众",
        "evidence_priority": ["节奏峰值段落", "素材衔接的巧思", "高分场景"],
        "transcript_heavy": False,
    },
    "live_session": {
        "value_question": "这场现场最有感染力的段落在哪里？现场感靠什么传递？",
        "audience": "想感受现场气氛的观众",
        "evidence_priority": ["现场高潮段落", "演出者状态", "镜头与氛围"],
        "transcript_heavy": False,
    },
    "cinematic_vlog": {
        "value_question": "这支 vlog 记录了什么？最值得看的画面和瞬间是什么？",
        "audience": "想跟着镜头体验一段经历的观众",
        "evidence_priority": ["叙事主线的关键瞬间", "画面质感", "讲述者的表达"],
        "transcript_heavy": False,
    },
    "reality_record": {
        "value_question": "这段记录里最真实、信息量最大的瞬间是什么？",
        "audience": "想知道发生了什么的观众",
        "evidence_priority": ["关键事件瞬间", "现场同期声", "画面信息"],
        "transcript_heavy": False,
    },
    "meme_viral": {
        "value_question": "梗是什么？笑点立不立得住、最好笑的瞬间在哪里？",
        "audience": "想知道好不好笑的观众",
        "evidence_priority": ["笑点时机与对应画面", "反差与梗的来源", "节奏"],
        "transcript_heavy": False,
    },
    "motion_graphics": {
        "value_question": "这支动态图形最妙的视觉设计在哪里？传达的信息或情绪是否到位？",
        "audience": "想找设计参考、看视觉创意的观众",
        "evidence_priority": ["设计语言的高光段落", "运动与转场的巧思", "信息传达效率"],
        "transcript_heavy": False,
    },
    "infographic_motion": {
        "value_question": "这支信息动画把什么讲明白了？信息设计最清晰的段落在哪里？",
        "audience": "想快速获取信息、看信息设计的观众",
        "evidence_priority": ["核心信息点及其图示", "信息层级与节奏", "视觉辅助的有效性"],
        "transcript_heavy": True,
    },
    "event_promo": {
        "value_question": "这支宣传片把活动/事件的什么亮点立住了？最有感染力的段落在哪里？",
        "audience": "想判断要不要参与/关注的观众",
        "evidence_priority": ["亮点画面", "情绪推进", "信息传达"],
        "transcript_heavy": False,
    },
    "ad_brand_campaign": {
        "value_question": "这支广告把什么卖点或品牌情绪立住了？最有效的一击在哪里？",
        "audience": "想看广告创意、判断传达效果的观众",
        "evidence_priority": ["卖点镜头", "情绪铺垫与转折", "记忆点"],
        "transcript_heavy": False,
    },
    "experimental": {
        "value_question": "这支实验影像提供了什么独特的视听体验？最特别的段落在哪里？",
        "audience": "想看新鲜表达方式的观众",
        "evidence_priority": ["最具辨识度的视听段落", "形式实验的核心手法", "感受曲线"],
        "transcript_heavy": False,
    },
}

# raw_prompt_adapter._RAW_PROMPT_ALIASES 的同义 key
_ALIASES = {
    "commentary_remix": "video_essay",
    "documentary_essay": "documentary",
    "brand_film": "ad_brand_campaign",
}


def get_value_focus(type_key: str) -> Dict[str, Any]:
    key = (type_key or "").strip()
    key = _ALIASES.get(key, key)
    recipe = VALUE_FOCUS_RECIPES.get(key)
    if recipe is None:
        return dict(_DEFAULT_RECIPE)
    merged = dict(_DEFAULT_RECIPE)
    merged.update(recipe)
    return merged


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return default


def summary_max_chars() -> int:
    return _env_int("AUDIOVISUAL_SUMMARY_MAX_CHARS", 400)


def summary_min_scene_evidence() -> int:
    return _env_int("AUDIOVISUAL_SUMMARY_MIN_SCENE_EVIDENCE", 2)


def summary_validation_rules() -> Dict[str, Any]:
    return {
        "summary_section": SUMMARY_SECTION_HEADING,
        "summary_max_chars": summary_max_chars(),
        "summary_min_scene_evidence": summary_min_scene_evidence(),
        "summary_jargon_blacklist": list(SUMMARY_JARGON_BLACKLIST),
    }


def build_summary_prompt_block(type_key: str) -> List[str]:
    """生成 user message 里的「导读」写作要求块。"""
    recipe = get_value_focus(type_key)
    max_chars = summary_max_chars()
    min_refs = summary_min_scene_evidence()
    evidence = "；".join(str(item) for item in recipe.get("evidence_priority") or [])
    jargon = "、".join(SUMMARY_JARGON_BLACKLIST)
    return [
        "",
        "## 导读（正文第一个模块，必须出现）",
        "",
        "正文的第一个 `##` 模块必须是 `## 导读`，写给普通观众的总-分速读，不是给同行看的分析：",
        "",
        f"- 它要回答的价值问题（默认）：**{recipe.get('value_question')}**",
        f"- 假想读者：{recipe.get('audience')}。",
        "- **若用户在对话中明确表达过自己的关注点（例如\"想看看访谈里聊了什么观点\"），导读以用户的问题为准，上述默认问题退为兜底。**",
        f"- 优先采用的证据：{evidence}。",
        "",
        "结构（总-分）：",
        "",
        "1. 开头 2-3 句白话：这条视频是什么、对上面价值问题的直接回答。允许否定或中性结论（\"最有信息量的交锋在 X，但整场大部分时间在寒暄\"），不要强行夸。",
        "2. 之后 2-4 条亮点列表，每条一行：`- **一句话结论**（Scene NNN，MM:SS）`——结论 + 场景编号/时间码定位，让读者能直接跳到那里。",
        "",
        "硬约束（脚本会机器校验）：",
        "",
        f"- 导读全模块正文不超过 **{max_chars}** 字（这是上限不是下限；导读不受其它模块 ≥700 字的下限约束）。",
        f"- 至少引用 **{min_refs}** 个不同的 Scene 编号或时间码。",
        f"- 禁止出现这些框架内部术语：{jargon}——导读必须说人话。",
        "- 不要 `###` 子条目，不要表格。",
    ]
