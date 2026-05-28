#!/usr/bin/env python3
"""
智能字幕提取脚本 - FunASR + RapidOCR 版本
流程：B站API字幕 → 内嵌字幕 → 烧录字幕检测(RapidOCR) → FunASR语音转录

技术栈：
- B站 API: 直接获取平台字幕（需 cookies）
- RapidOCR (ONNX): 轻量级 OCR，用于提取烧录字幕
- FunASR: 中文语音转录，配合 VAD 分段和标点模型
"""

import subprocess
import sys
import os
import re
import tempfile
from pathlib import Path
import json


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
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            frame_path = tmp.name

        cmd = [
            "ffmpeg", "-y", "-ss", timestamp, "-i", video_path,
            "-vframes", "1", "-q:v", "2", frame_path
        ]
        subprocess.run(cmd, capture_output=True, check=True)
        return frame_path
    except Exception as e:
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
    配合 VAD 分段模型 + 标点模型，正确处理长音频

    调用方式参照 FunASR 官方 demo:
    https://github.com/modelscope/FunASR/blob/main/examples/industrial_data_pretraining/paraformer/demo.py
    """
    try:
        from funasr import AutoModel

        print("🎤 使用 FunASR 进行语音转录...")
        print("   ASR 模型: paraformer-zh (含 VAD + 标点)")
        print("   发行包应已预置模型缓存，若长时间停在这里请检查发行运行时")

        # 提取音频
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            audio_path = tmp.name

        if not extract_audio(video_path, audio_path):
            return False

        # 加载 FunASR 模型（官方推荐的短名称 + VAD + 标点）
        model = AutoModel(
            model="paraformer-zh",
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 60000},
            punc_model="ct-punc",
            disable_update=True,
        )

        # 转录（VAD 自动分段，标点自动恢复，cache={} 是官方推荐参数）
        result = model.generate(
            input=audio_path,
            batch_size_s=300,
            cache={},
        )

        # 生成 SRT
        subtitle_count = 0
        with open(output_srt, 'w', encoding='utf-8') as f:
            for res in result:
                text = res.get('text', '').strip()
                timestamps = res.get('timestamp', [])
                sentence_info = res.get('sentence_info', [])

                if sentence_info:
                    # 方案A: 使用句级时间戳（最佳，如果模型返回了）
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
        print("❌ Ready 发行运行时缺少 FunASR / ModelScope / TorchAudio")
        return False
    except Exception as e:
        print(f"❌ FunASR 转录失败: {e}")
        import traceback
        traceback.print_exc()
        return False


# ============================================================
# 主流程
# ============================================================

def smart_subtitle_extraction(video_path: str, output_srt: str, video_url: str = "") -> tuple[bool, str]:
    """
    智能字幕提取主函数
    流程: B站API字幕 → 内嵌字幕 → 烧录字幕(RapidOCR) → FunASR语音转录

    返回: (是否成功, 使用的模式)
    """
    print("=" * 50)
    print("🎬 智能字幕提取 (B站API + RapidOCR + FunASR)")
    print("=" * 50)
    print(f"视频: {video_path}")
    print()

    # 步骤0: 尝试从B站API获取字幕（最优先）
    bvid = extract_bvid(video_url) or extract_bvid(video_path)
    if bvid:
        print("步骤 0/4: 尝试B站API字幕获取...")
        if get_bilibili_subtitle(bvid, output_srt):
            return True, "bilibili_api"
        print()

    # 步骤1: 检查内嵌字幕
    print("步骤 1/3: 检查内嵌字幕...")
    has_embedded, result = check_embedded_subtitle(video_path)
    if has_embedded:
        print(f"✅ 发现内嵌字幕，已提取: {result}")
        if result != output_srt:
            import shutil
            shutil.copy(result, output_srt)
        return True, "embedded"
    else:
        print(f"⚠️ {result}")

    # 步骤2: 检测烧录字幕
    print("\n步骤 2/3: 检测烧录字幕 (RapidOCR)...")
    frame_path = capture_frame(video_path, "00:00:05")
    if frame_path:
        has_burned = check_burned_subtitle(frame_path)
        os.unlink(frame_path)

        if has_burned:
            print("✅ 检测到烧录字幕，使用 RapidOCR 提取...")
            if extract_burned_subtitle_ocr(video_path, output_srt):
                return True, "ocr"
        else:
            print("⚠️ 未检测到烧录字幕")

    # 步骤3: 使用 FunASR
    print("\n步骤 3/3: 使用 FunASR 语音转录...")
    if extract_with_funasr(video_path, output_srt):
        return True, "funasr"

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
