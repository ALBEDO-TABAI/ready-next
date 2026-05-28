#!/usr/bin/env python3
"""
智能字幕提取脚本 - 自适应转录引擎
非音乐视频默认先听人声，再补画面文字；音乐视频优先保留歌词/OCR 路径。
"""

from __future__ import annotations

import subprocess
import sys
import os
import re
import shutil
import tempfile
import importlib.util
from pathlib import Path
import json


MUSIC_KEYWORDS = (
    "music video",
    "mv",
    "lyric",
    "lyrics",
    "歌词",
    "official audio",
    "official mv",
)

TRUSTED_SUBTITLE_MODES = {
    "bilibili_api",
    "bilibili_api_fallback",
    "embedded",
    "embedded_fallback",
    "platform_subtitles",
}

FUNASR_NANO_MODEL_ID = os.environ.get("READY_FUNASR_NANO_MODEL_ID", "FunAudioLLM/Fun-ASR-Nano-2512")
FUNASR_FALLBACK_MODEL_ID = "paraformer-zh"
FUNASR_NANO_REQUIRED_FILES = ("model.pt", "config.yaml")
FUNASR_FALLBACK_ASR_MODEL_ID = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
FUNASR_FALLBACK_VAD_MODEL_ID = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
FUNASR_FALLBACK_PUNC_MODEL_ID = "iic/punc_ct-transformer_cn-en-common-vocab471067-large"


def choose_subtitle_strategy(title: str = "", url: str = "") -> str:
    haystack = f" {title.lower()} {url.lower()} "
    if any(keyword in haystack for keyword in MUSIC_KEYWORDS):
        return "music_first"
    return "asr_first"


def transcript_quality_is_poor(segments: list[dict]) -> bool:
    if not segments:
        return True

    texts = [str(segment.get("text", "")).strip() for segment in segments if str(segment.get("text", "")).strip()]
    if not texts:
        return True

    full_text = " ".join(texts)
    if re.search(r"(.)\1{20,}", full_text):
        return True

    punctuation_only = sum(1 for text in texts if re.fullmatch(r"[\W_!！?？。．、，\s]+", text))
    tiny_segments = sum(1 for text in texts if len(text) <= 1)
    if punctuation_only / len(texts) >= 0.3:
        return True
    if tiny_segments / len(texts) >= 0.4:
        return True

    meaningful_chars = sum(1 for ch in full_text if ch.isalnum() or "\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff")
    if meaningful_chars / max(len(full_text), 1) < 0.3:
        return True
    return False


def build_onscreen_text_path(output_srt: str) -> str:
    path = Path(output_srt)
    return str(path.with_name(f"{path.stem}_onscreen_text.srt"))


def build_subtitle_source_path(output_srt: str) -> str:
    path = Path(output_srt)
    return str(path.with_name(f"{path.stem}_subtitle_source.json"))


def write_subtitle_source_metadata(output_srt: str, mode: str) -> None:
    metadata_path = Path(build_subtitle_source_path(output_srt))
    metadata = {
        "mode": mode,
        "trusted": mode in TRUSTED_SUBTITLE_MODES,
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def _funasr_device() -> str:
    import torch

    return "cuda:0" if torch.cuda.is_available() else "cpu"


def _preload_funasr_nano_runtime() -> tuple[bool, str]:
    try:
        import funasr
    except ImportError as exc:
        return False, str(exc)

    package_root = Path(getattr(funasr, "__file__", "")).resolve().parent
    nano_dir = package_root / "models" / "fun_asr_nano"
    model_py = nano_dir / "model.py"
    if not model_py.exists():
        return False, f"missing {model_py}"

    nano_dir_text = str(nano_dir)
    if nano_dir_text not in sys.path:
        sys.path.insert(0, nano_dir_text)

    module_name = "_video_expert_funasr_nano_model"
    if module_name in sys.modules:
        return True, ""

    try:
        spec = importlib.util.spec_from_file_location(module_name, model_py)
        if spec is None or spec.loader is None:
            return False, f"cannot load spec from {model_py}"
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return True, ""
    except Exception as exc:
        sys.modules.pop(module_name, None)
        return False, str(exc)


def _configured_funasr_nano_model_path() -> str:
    for env_name in ("READY_FUNASR_NANO_MODEL_DIR", "FUNASR_NANO_MODEL_DIR"):
        raw = os.environ.get(env_name, "").strip()
        if not raw:
            continue
        model_dir = Path(raw).expanduser()
        missing = [name for name in FUNASR_NANO_REQUIRED_FILES if not (model_dir / name).is_file()]
        if not missing:
            return str(model_dir)
        print(f"   ⚠️  FunASR Nano 本地目录缺少文件 {missing}: {model_dir}")
    return ""


def _allow_funasr_nano_download() -> bool:
    value = os.environ.get("READY_FUNASR_NANO_AUTO_DOWNLOAD", "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _modelscope_cache_root():
    raw = os.environ.get("MODELSCOPE_CACHE", "").strip()
    if raw:
        return Path(raw).expanduser()
    runtime_root = os.environ.get("READY_PACKAGED_SKILL_RUNTIME_ROOT", "").strip()
    if runtime_root:
        return Path(runtime_root).expanduser() / "cache" / "modelscope"
    return None


def _local_modelscope_model_path(model_id: str) -> str:
    root = _modelscope_cache_root()
    if root is None:
        return ""
    model_dir = root / "models" / model_id
    if (model_dir / "model.pt").is_file() and (model_dir / "config.yaml").is_file():
        return str(model_dir)
    return ""


def _load_funasr_model():
    from funasr import AutoModel

    device = _funasr_device()

    try:
        local_model = _configured_funasr_nano_model_path()
        if local_model:
            model_py = Path(local_model) / "model.py"
            kwargs = {
                "model": local_model,
                "hub": "hf",
                "trust_remote_code": True,
                "device": device,
                "disable_update": True,
            }
            if model_py.is_file():
                kwargs["remote_code"] = str(model_py)
            model = AutoModel(**kwargs)
            return model, "Fun-ASR-Nano-2512", device

        if not _allow_funasr_nano_download():
            raise RuntimeError("FunASR Nano model is not prepared; configure a local model dir or use the Ready download button")

        preload_ok, preload_error = _preload_funasr_nano_runtime()
        if preload_ok:
            print("   ✅ 已预加载 FunASR Nano 本地实现")
        elif preload_error:
            print(f"   ⚠️  FunASR Nano 预加载失败，继续尝试 HF 模型: {preload_error}")

        model = AutoModel(
            model=FUNASR_NANO_MODEL_ID,
            hub="hf",
            trust_remote_code=True,
            device=device,
            disable_update=True,
        )
        return model, "Fun-ASR-Nano-2512", device
    except Exception as exc:
        print(f"   ⚠️  Fun-ASR-Nano-2512 当前环境不可直接使用: {exc}")
        print("   ↩️  自动回退到稳定版 paraformer-zh")
        fallback_model = _local_modelscope_model_path(FUNASR_FALLBACK_ASR_MODEL_ID) or FUNASR_FALLBACK_MODEL_ID
        fallback_vad = _local_modelscope_model_path(FUNASR_FALLBACK_VAD_MODEL_ID) or "fsmn-vad"
        fallback_punc = _local_modelscope_model_path(FUNASR_FALLBACK_PUNC_MODEL_ID) or "ct-punc"
        model = AutoModel(
            model=fallback_model,
            vad_model=fallback_vad,
            punc_model=fallback_punc,
            device=device,
            disable_update=True,
        )
        return model, FUNASR_FALLBACK_MODEL_ID, device


def _load_quality_segments(srt_path: Path) -> list[dict]:
    if not srt_path.exists():
        return []

    content = srt_path.read_text(encoding="utf-8", errors="ignore").strip()
    if not content:
        return []

    segments: list[dict] = []
    for block in re.split(r"\r?\n\r?\n", content):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        timestamp_line = lines[1] if len(lines) > 1 and "-->" in lines[1] else lines[0]
        if "-->" not in timestamp_line:
            continue
        text_lines = lines[2:] if timestamp_line == lines[1] else lines[1:]
        text = " ".join(text_lines).strip()
        if text:
            segments.append({"text": text})
    return segments


def _guess_platform_language_preferences(title: str = "", url: str = "") -> list[str]:
    haystack = f"{title} {url}"
    preferences: list[str] = []

    if re.search(r"[\uac00-\ud7af]", haystack):
        preferences.extend(["ko", "ko-kr", "korean"])
    if re.search(r"[\u3040-\u30ff]", haystack):
        preferences.extend(["ja", "ja-jp", "japanese"])
    if re.search(r"[\u4e00-\u9fff]", haystack):
        preferences.extend(["zh", "zh-hans", "zh-cn", "cmn-hans", "chinese"])

    preferences.extend(["orig", "original", "ko", "ja", "zh", "en"])

    ordered: list[str] = []
    for item in preferences:
        if item not in ordered:
            ordered.append(item)
    return ordered


def _rank_subtitle_language(language: str, preferences: list[str]) -> tuple[int, int, str]:
    normalized = language.lower()
    if "live_chat" in normalized:
        return (len(preferences) + 5, 1, normalized)

    rank = len(preferences) + 1
    for index, prefix in enumerate(preferences):
        if normalized == prefix or normalized.startswith(prefix + "-") or normalized.startswith(prefix + ".") or prefix in normalized:
            rank = index
            break
    original_bonus = 0 if ("orig" in normalized or "original" in normalized) else 1
    return (rank, original_bonus, normalized)


def _load_platform_subtitle_manifest(video_url: str) -> dict:
    if not video_url or not re.match(r"^https?://", video_url):
        return {}
    if shutil.which("yt-dlp") is None:
        return {}

    cmd = [
        "yt-dlp",
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        video_url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=True)
        return json.loads(result.stdout or "{}")
    except (subprocess.CalledProcessError, json.JSONDecodeError, OSError, subprocess.TimeoutExpired):
        return {}


def _select_platform_subtitle_request(manifest: dict, title: str = "", url: str = "") -> tuple[str, list[str], str]:
    preferences = _guess_platform_language_preferences(title=title, url=url)
    manual_langs = list((manifest.get("subtitles") or {}).keys())
    auto_langs = list((manifest.get("automatic_captions") or {}).keys())

    for langs, flag, mode in (
        (manual_langs, "--write-subs", "platform_subtitles"),
        (auto_langs, "--write-auto-subs", "platform_auto_subtitles"),
    ):
        filtered = [lang for lang in langs if lang and "live_chat" not in lang.lower()]
        if not filtered:
            continue
        ranked = sorted(filtered, key=lambda item: _rank_subtitle_language(item, preferences))
        return flag, ranked[:3], mode

    return "", [], ""


def _pick_platform_subtitle_file(download_dir: Path, title: str = "", url: str = "") -> Path | None:
    candidates = [path for path in download_dir.rglob("*.srt") if path.is_file()]
    if not candidates:
        return None

    preferences = _guess_platform_language_preferences(title=title, url=url)
    scored: list[tuple[tuple[int, tuple[int, int, str], int, int, str], Path]] = []
    for candidate in candidates:
        segments = _load_quality_segments(candidate)
        if transcript_quality_is_poor(segments):
            continue

        joined = " ".join(str(segment.get("text", "")).strip() for segment in segments)
        meaningful_chars = sum(
            1
            for ch in joined
            if ch.isalnum()
            or "\u4e00" <= ch <= "\u9fff"
            or "\u3040" <= ch <= "\u30ff"
            or "\uac00" <= ch <= "\ud7af"
        )
        lang_token = candidate.stem.split(".")[-1] if "." in candidate.stem else ""
        score = (
            0,
            _rank_subtitle_language(lang_token, preferences),
            -meaningful_chars,
            -len(segments),
            candidate.name.lower(),
        )
        scored.append((score, candidate))

    if not scored:
        return None

    scored.sort(key=lambda item: item[0])
    return scored[0][1]


def get_platform_subtitles(video_url: str, output_srt: str, *, title: str = "") -> tuple[bool, str]:
    manifest = _load_platform_subtitle_manifest(video_url)
    write_flag, langs, mode = _select_platform_subtitle_request(manifest, title=title, url=video_url)
    if not write_flag or not langs:
        return False, ""

    print(f"   🌐 尝试平台字幕: {', '.join(langs)}")
    with tempfile.TemporaryDirectory() as tmpdir:
        download_dir = Path(tmpdir)
        output_template = str(download_dir / "subtitle.%(ext)s")
        cmd = [
            "yt-dlp",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            write_flag,
            "--sub-format",
            "srt",
            "--convert-subs",
            "srt",
            "--sub-langs",
            ",".join(langs),
            "-o",
            output_template,
            video_url,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.TimeoutExpired):
            return False, ""

        if result.returncode != 0:
            return False, ""

        selected = _pick_platform_subtitle_file(download_dir, title=title, url=video_url)
        if not selected:
            print("   ⚠️ 平台字幕可用，但内容质量不足，继续尝试其他来源")
            return False, ""

        shutil.copyfile(selected, output_srt)
        return True, mode


# ============================================================
# L0: B站 API 字幕获取（最高优先级）
# ============================================================

def extract_bvid(video_url_or_path: str) -> str:
    """从 URL 或文件名中提取 B站 BV 号"""
    # 匹配 BV 号模式（BV + 10位字母数字）
    match = re.search(r'(BV[a-zA-Z0-9]{10})', video_url_or_path)
    if match:
        return match.group(1)
    return ""


def get_bilibili_subtitle(bvid: str, output_srt: str) -> bool:
    """
    通过 B站 API 获取字幕
    自动从浏览器读取 cookies，无需手动配置

    优先级: yt-dlp cookies > browser_cookie3 > 配置文件/环境变量
    """
    # 调用独立的字幕获取脚本
    script_dir = os.path.dirname(os.path.abspath(__file__))
    fetch_script = os.path.join(script_dir, "fetch_bilibili_subtitle.py")

    if os.path.exists(fetch_script):
        try:
            cmd = [sys.executable, fetch_script, bvid, output_srt]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            print(result.stdout)
            if result.stderr:
                print(result.stderr)

            if result.returncode == 0 and os.path.exists(output_srt):
                # 检查文件是否有实际内容
                if os.path.getsize(output_srt) > 10:
                    return True
            return False
        except subprocess.TimeoutExpired:
            print("   ⚠️ 字幕获取超时")
            return False
        except Exception as e:
            print(f"   ⚠️ 调用字幕获取脚本失败: {e}")
            return False
    else:
        print(f"   ⚠️ 未找到 fetch_bilibili_subtitle.py 脚本")
        # 回退到简单的无 cookies 尝试
        return _simple_bilibili_fetch(bvid, output_srt)


def _simple_bilibili_fetch(bvid: str, output_srt: str) -> bool:
    """简单的 B站字幕获取（无 cookies，通常会失败但不影响流程）"""
    try:
        import requests
    except ImportError:
        return False

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.bilibili.com",
    }

    try:
        resp = requests.get(
            f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}",
            headers=headers, timeout=10
        )
        data = resp.json()
        if data.get("code") != 0 or not data.get("data"):
            return False

        cid = data["data"][0]["cid"]
        resp = requests.get(
            f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
            headers=headers, timeout=10
        )
        aid = resp.json()["data"]["aid"]

        resp = requests.get(
            f"https://api.bilibili.com/x/player/wbi/v2?aid={aid}&cid={cid}",
            headers=headers, timeout=10
        )
        subtitles = resp.json().get("data", {}).get("subtitle", {}).get("subtitles", [])

        if not subtitles:
            return False

        sub_url = subtitles[0].get("subtitle_url", "")
        if sub_url.startswith("//"):
            sub_url = "https:" + sub_url

        resp = requests.get(sub_url, headers=headers, timeout=10)
        body = resp.json().get("body", [])

        if not body:
            return False

        with open(output_srt, 'w', encoding='utf-8') as f:
            for i, item in enumerate(body, 1):
                start = format_timestamp(item.get("from", 0))
                end = format_timestamp(item.get("to", 0))
                content = item.get("content", "").strip()
                if content:
                    f.write(f"{i}\n{start} --> {end}\n{content}\n\n")

        return True
    except Exception:
        return False


# ============================================================
# L1: 内嵌字幕检测
# ============================================================

def check_embedded_subtitle(video_path: str) -> tuple[bool, str]:
    """
    检查视频是否包含内嵌字幕流
    返回: (是否有内嵌字幕, 字幕文件路径或错误信息)
    """
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)

        streams = data.get("streams", [])
        subtitle_streams = [s for s in streams if s.get("codec_type") == "subtitle"]

        if subtitle_streams:
            output_srt = video_path.rsplit(".", 1)[0] + "_embedded.srt"
            cmd = [
                "ffmpeg", "-y", "-i", video_path,
                "-map", f"0:s:0", output_srt
            ]
            subprocess.run(cmd, capture_output=True, check=True)
            return True, output_srt
        else:
            return False, "无内嵌字幕流"
    except Exception as e:
        return False, f"检测失败: {e}"


# ============================================================
# L2: 烧录字幕检测与提取 (RapidOCR)
# ============================================================

def capture_frame(video_path: str, timestamp: str = "00:00:05") -> str:
    """截取视频指定时间的帧"""
    frame_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            frame_path = tmp.name

        cmd = [
            "ffmpeg", "-y", "-ss", timestamp, "-i", video_path,
            "-vframes", "1", "-q:v", "2", frame_path
        ]
        subprocess.run(cmd, capture_output=True, check=True)
        return frame_path
    except Exception:
        if frame_path:
            Path(frame_path).unlink(missing_ok=True)
        return ""


def _format_time_hms(seconds: int) -> str:
    """将秒数格式化为 HH:MM:SS 格式（用于 ffmpeg 时间戳）"""
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def check_burned_subtitle(frame_path: str) -> bool:
    """使用 RapidOCR 检测画面是否有烧录字幕"""
    try:
        from rapidocr_onnxruntime import RapidOCR

        ocr = RapidOCR()
        result = ocr(frame_path)

        # 如果检测到文字，认为有烧录字幕
        if result and result[0]:
            text_count = len([line for line in result[0] if line])
            # 检测到至少2行文字，认为是字幕
            return text_count >= 2
        return False
    except ImportError:
        print("⚠️ Ready 发行运行时缺少 RapidOCR，跳过烧录字幕检测")
        return False
    except Exception as e:
        print(f"⚠️ OCR 检测失败: {e}")
        return False


def extract_burned_subtitle_ocr(video_path: str, output_srt: str) -> bool:
    """使用 RapidOCR 提取烧录字幕"""
    try:
        from rapidocr_onnxruntime import RapidOCR

        print("🔍 使用 RapidOCR 提取烧录字幕...")

        cmd = [
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        duration = float(result.stdout.strip())

        ocr = RapidOCR()

        # 每隔2秒截取一帧进行 OCR（减少计算量）
        subtitles = []
        for t in range(0, int(duration), 2):
            timestamp = _format_time_hms(t)
            frame_path = capture_frame(video_path, timestamp)
            if not frame_path:
                continue

            result = ocr(frame_path)
            if result and result[0]:
                # 提取文字
                texts = []
                for line in result[0]:
                    if line:
                        text = line[1]
                        confidence = line[2]
                        # 修复: confidence 可能是 str 类型，统一转为 float
                        try:
                            conf = float(confidence)
                        except (ValueError, TypeError):
                            conf = 0.0
                        if conf > 0.7:  # 置信度阈值
                            texts.append(text)

                if texts:
                    start_ts = format_timestamp(t)
                    end_ts = format_timestamp(t + 2)
                    subtitles.append({
                        'index': len(subtitles) + 1,
                        'start': start_ts,
                        'end': end_ts,
                        'text': ' '.join(texts)
                    })

            os.unlink(frame_path)

        # 写入 SRT 文件
        with open(output_srt, 'w', encoding='utf-8') as f:
            for sub in subtitles:
                f.write(f"{sub['index']}\n")
                f.write(f"{sub['start']} --> {sub['end']}\n")
                f.write(f"{sub['text']}\n\n")

        print(f"✅ OCR 提取完成: {len(subtitles)} 条字幕")
        return True

    except Exception as e:
        print(f"❌ OCR 提取失败: {e}")
        return False


# ============================================================
# L3: FunASR 语音转录
# ============================================================

def extract_audio(video_path: str, audio_path: str) -> bool:
    """从视频中提取音频"""
    try:
        cmd = [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le",
            "-ar", "16000", "-ac", "1",
            audio_path
        ]
        subprocess.run(cmd, capture_output=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ 音频提取失败: {e}")
        return False


def format_timestamp(seconds: float) -> str:
    """格式化时间戳为 SRT 格式"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _split_text_by_punctuation(text: str, timestamps: list) -> list:
    """
    按标点符号切分带字级时间戳的文本为自然句
    timestamps: [[start_ms, end_ms], ...] 每个字/词的时间戳
    返回: [{'text': str, 'start_ms': int, 'end_ms': int}, ...]
    """
    # 句末标点
    sentence_endings = set('。！？!?；;…')
    # 次级切分标点（逗号等，仅在句子过长时切）
    clause_breaks = set('，,、')

    sentences = []
    current_chars = []
    current_start_idx = 0
    ts_len = len(timestamps)
    text_len = len(text)

    for char_idx, char in enumerate(text):
        current_chars.append(char)

        # 映射字符位置到时间戳位置
        ts_idx = min(int(char_idx / text_len * ts_len), ts_len - 1) if ts_len > 0 else 0

        is_end = char in sentence_endings
        is_clause = char in clause_breaks and len(current_chars) > 25  # 逗号切分仅在 >25 字时
        is_last = char_idx == text_len - 1

        if is_end or is_clause or is_last:
            sent_text = ''.join(current_chars).strip()
            if sent_text:
                start_ts_idx = min(int(current_start_idx / text_len * ts_len), ts_len - 1) if ts_len > 0 else 0
                end_ts_idx = ts_idx

                start_ms = timestamps[start_ts_idx][0] if ts_len > 0 else 0
                end_ms = timestamps[end_ts_idx][1] if ts_len > 0 else 0

                sentences.append({
                    'text': sent_text,
                    'start_ms': start_ms,
                    'end_ms': end_ms,
                })

            current_chars = []
            current_start_idx = char_idx + 1

    return sentences


def extract_with_funasr(video_path: str, output_srt: str) -> bool:
    """
    使用 FunASR 进行语音转录
    使用 Fun-ASR-Nano-2512 模型 - 新一代高性能模型

    模型特点:
    - 模型大小: 约 2GB
    - 推理速度: 更快
    - 准确率高: 新一代架构
    - 多语言: 支持中文、英文、日文等 30+ 语言
    - 抗噪强: 适合远场拾音和高噪声场景
    """
    try:
        print("🎤 使用 FunASR 进行语音转录...")
        print("   ASR 模型: 优先使用本地 Fun-ASR-Nano-2512；未准备则回退到 paraformer-zh")
        print("   Nano 权重不随应用内置，可在 Ready Skill 配置中下载或指定本地目录")

        # 提取音频
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            audio_path = tmp.name

        if not extract_audio(video_path, audio_path):
            return False

        # 先尝试加载 Nano 2512；命中已知注册问题时自动回退到稳定模型。
        model, resolved_model_name, device = _load_funasr_model()
        print(f"   已加载模型: {resolved_model_name}")
        print(f"   使用设备: {device}")

        # 转录
        print("   开始转录...")
        generate_kwargs = {
            "input": [audio_path],
            "itn": True,
        }
        if resolved_model_name == "Fun-ASR-Nano-2512":
            generate_kwargs["language"] = "中文"
        result = model.generate(**generate_kwargs)

        # 生成 SRT
        subtitle_count = 0
        with open(output_srt, 'w', encoding='utf-8') as f:
            for res in result:
                text = res.get('text', '').strip()

                # Fun-ASR-Nano-2512 返回格式
                # 尝试获取时间戳信息
                timestamps = res.get('timestamp', [])
                sentence_info = res.get('sentence_info', [])

                if sentence_info:
                    # 方案A: 使用句级时间戳
                    for sent in sentence_info:
                        sent_text = sent.get('text', '').strip()
                        if sent_text:
                            subtitle_count += 1
                            start = format_timestamp(sent.get('start', 0) / 1000)
                            end = format_timestamp(sent.get('end', 0) / 1000)
                            f.write(f"{subtitle_count}\n{start} --> {end}\n{sent_text}\n\n")

                elif timestamps and text:
                    # 方案B: 按标点符号切分 + 字级时间戳映射
                    sentences = _split_text_by_punctuation(text, timestamps)
                    for sent in sentences:
                        subtitle_count += 1
                        start = format_timestamp(sent['start_ms'] / 1000)
                        end = format_timestamp(sent['end_ms'] / 1000)
                        f.write(f"{subtitle_count}\n{start} --> {end}\n{sent['text']}\n\n")

                elif text:
                    # 方案C: 无时间戳，仅输出文本
                    subtitle_count += 1
                    f.write(f"{subtitle_count}\n00:00:00,000 --> 00:00:00,000\n{text}\n\n")

        # 清理临时文件
        os.unlink(audio_path)

        print(f"✅ FunASR 转录完成: {subtitle_count} 条字幕")
        return subtitle_count > 0

    except ImportError:
        print("❌ Ready 发行运行时缺少 FunASR / ModelScope")
        return False
    except Exception as e:
        print(f"❌ FunASR 转录失败: {e}")
        import traceback
        traceback.print_exc()
        return False


def extract_with_smart_asr(video_path: str, output_srt: str, *, title: str = "", url: str = "") -> bool:
    """
    智能选择 ASR 引擎
    Ready 内置版本统一使用 FunASR Nano，避免平台分叉和旧本地 ASR 运行时体积。
    """
    print("→ 使用 FunASR Nano")
    return extract_with_funasr(video_path, output_srt)


# ============================================================
# 主流程
# ============================================================

def smart_subtitle_extraction(video_path: str, output_srt: str, video_url: str = "", title: str = "") -> tuple[bool, str]:
    """
    智能字幕提取主函数
    流程: B站API字幕 / 平台字幕 → 内嵌字幕 → 烧录字幕(RapidOCR) → 智能语音转录

    返回: (是否成功, 使用的模式)
    """
    print("=" * 50)
    print("🎬 智能字幕提取 (B站API + RapidOCR + 智能ASR)")
    print("=" * 50)
    print(f"视频: {video_path}")
    print()

    strategy = choose_subtitle_strategy(title=title, url=video_url)
    onscreen_srt = build_onscreen_text_path(output_srt)

    def _return_success(mode: str) -> tuple[bool, str]:
        write_subtitle_source_metadata(output_srt, mode)
        return True, mode

    if strategy == "music_first":
        bvid = extract_bvid(video_url) or extract_bvid(video_path)
        if bvid:
            print("步骤 0/5: 尝试B站API字幕获取...")
            if get_bilibili_subtitle(bvid, output_srt):
                return _return_success("bilibili_api")
            print()

        print("步骤 1/5: 尝试平台字幕...")
        success, mode = get_platform_subtitles(video_url, output_srt, title=title)
        if success:
            print("✅ 平台字幕获取成功")
            return _return_success(mode)

        print("\n步骤 2/5: 检查内嵌字幕...")
        has_embedded, result = check_embedded_subtitle(video_path)
        if has_embedded:
            print(f"✅ 发现内嵌字幕，已提取: {result}")
            if result != output_srt:
                shutil.copy(result, output_srt)
            return _return_success("embedded")
        print(f"⚠️ {result}")

        print("\n步骤 3/5: 检测烧录字幕 (RapidOCR)...")
        frame_path = capture_frame(video_path, "00:00:05")
        if frame_path:
            has_burned = check_burned_subtitle(frame_path)
            os.unlink(frame_path)
            if has_burned:
                print("✅ 检测到烧录字幕，使用 RapidOCR 提取...")
                if extract_burned_subtitle_ocr(video_path, output_srt):
                    return _return_success("ocr")
            else:
                print("⚠️ 未检测到烧录字幕")

    print("\n步骤 4/5: 使用智能语音转录...")
    if extract_with_smart_asr(video_path, output_srt, title=title, url=video_url):
        frame_path = capture_frame(video_path, "00:00:05")
        if frame_path:
            has_burned = check_burned_subtitle(frame_path)
            os.unlink(frame_path)
            if has_burned:
                print("✅ 检测到画面文字，额外写入 onscreen_text 轨道...")
                extract_burned_subtitle_ocr(video_path, onscreen_srt)
        return _return_success("funasr")

    if strategy != "music_first":
        print("\n步骤 5/5: ASR 失败，尝试回退到平台/内嵌字幕...")
        success, mode = get_platform_subtitles(video_url, output_srt, title=title)
        if success:
            return _return_success(mode)
        has_embedded, result = check_embedded_subtitle(video_path)
        if has_embedded:
            if result != output_srt:
                shutil.copy(result, output_srt)
            return _return_success("embedded_fallback")
        bvid = extract_bvid(video_url) or extract_bvid(video_path)
        if bvid and get_bilibili_subtitle(bvid, output_srt):
            return _return_success("bilibili_api_fallback")

    return False, "failed"


def main():
    if len(sys.argv) < 3:
        print("用法: python extract_subtitle_funasr.py <视频路径> <输出SRT路径> [视频URL]")
        print()
        print("参数说明:")
        print("  视频路径  - 本地视频文件路径")
        print("  输出SRT   - 输出的 SRT 字幕文件路径")
        print("  视频URL   - 可选，原始视频URL（用于B站API字幕获取）")
        sys.exit(1)

    video_path = sys.argv[1]
    output_srt = sys.argv[2]
    video_url = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.exists(video_path):
        print(f"❌ 视频文件不存在: {video_path}")
        sys.exit(1)

    success, mode = smart_subtitle_extraction(video_path, output_srt, video_url)

    if success:
        print(f"\n✅ 字幕提取成功！")
        print(f"   模式: {mode}")
        print(f"   输出: {output_srt}")
        sys.exit(0)
    else:
        print(f"\n❌ 字幕提取失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
