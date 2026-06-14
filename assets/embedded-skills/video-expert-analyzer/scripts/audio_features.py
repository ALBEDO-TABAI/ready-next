#!/usr/bin/env python3
"""真实音频信号特征提取（零新增依赖：ffmpeg + numpy）。

这是音频轴分类与"音画同步/节奏"分析的数据地基：
- ffmpeg 把音轨解码成 16kHz 单声道 PCM
- numpy STFT → 谱通量 onset 包络 → onset 时间点
- onset 包络自相关 → BPM 估计（含置信度）
- BPM + 相位拟合 → beat 网格 → 切镜卡拍率（±80ms）
- RMS 能量曲线 → 响度弧线 / 静音段 / 动态范围

所有失败路径都落到 status=unavailable 的占位结果，绝不抛出——
没有音频特征时路由退回字幕/标题启发式，不阻塞主流程。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

AUDIO_FEATURES_VERSION = "audio-features-v1"
AUDIO_FEATURES_FILENAME = "audio_features.json"

SAMPLE_RATE = 16000
STFT_FRAME = 1024
STFT_HOP = 512
RMS_WINDOW_SECONDS = 0.5
BEAT_TOLERANCE_SECONDS = 0.08
BPM_MIN, BPM_MAX = 60.0, 200.0
LOUDNESS_ARC_POINTS = 60
AUDIO_EXTENSIONS = (".m4a", ".wav", ".mp3", ".aac", ".flac", ".opus", ".ogg")


def _unavailable(reason: str) -> Dict[str, Any]:
    return {"version": AUDIO_FEATURES_VERSION, "status": "unavailable", "reason": reason}


def find_audio_file(video_dir: Path, video_id: str = "") -> Optional[Path]:
    if video_id:
        for ext in AUDIO_EXTENSIONS:
            candidate = video_dir / f"{video_id}{ext}"
            if candidate.exists():
                return candidate
    candidates = [
        path
        for ext in AUDIO_EXTENSIONS
        for path in sorted(video_dir.glob(f"*{ext}"))
        if path.is_file()
    ]
    return candidates[0] if candidates else None


def _decode_pcm(audio_path: Path, sample_rate: int = SAMPLE_RATE):
    import numpy as np

    cmd = [
        "ffmpeg", "-v", "error",
        "-i", str(audio_path),
        "-ac", "1", "-ar", str(sample_rate),
        "-f", "s16le", "-",
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 解码失败: {result.stderr.decode('utf-8', 'replace')[:200]}")
    samples = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def _onset_envelope(samples, sample_rate: int = SAMPLE_RATE):
    """谱通量 onset 包络（半波整流、按峰值归一），帧率 = sample_rate / hop。"""
    import numpy as np

    if samples.size < STFT_FRAME * 2:
        return np.zeros(0, dtype=np.float32)
    frame_count = 1 + (samples.size - STFT_FRAME) // STFT_HOP
    indices = np.arange(STFT_FRAME)[None, :] + STFT_HOP * np.arange(frame_count)[:, None]
    frames = samples[indices] * np.hanning(STFT_FRAME)[None, :]
    magnitude = np.abs(np.fft.rfft(frames, axis=1))
    flux = np.diff(magnitude, axis=0)
    np.clip(flux, 0.0, None, out=flux)
    envelope = flux.sum(axis=1)
    peak = float(envelope.max()) if envelope.size else 0.0
    if peak > 0:
        envelope = envelope / peak
    return envelope.astype(np.float32)


def _pick_onsets(envelope, sample_rate: int = SAMPLE_RATE) -> List[float]:
    """局部极大 + 自适应阈值（滑动均值 + 偏移）。返回秒级时间点。"""
    import numpy as np

    if envelope.size < 8:
        return []
    frame_rate = sample_rate / STFT_HOP
    window = 16
    kernel = np.ones(window) / window
    moving_avg = np.convolve(envelope, kernel, mode="same")
    onsets: List[float] = []
    last_frame = -int(0.05 * frame_rate) - 1
    for i in range(3, envelope.size - 3):
        if envelope[i] != envelope[i - 3 : i + 4].max():
            continue
        if envelope[i] < moving_avg[i] + 0.03:
            continue
        if i - last_frame <= int(0.05 * frame_rate):
            continue
        onsets.append(round(i / frame_rate, 4))
        last_frame = i
    return onsets


def _comb_score(envelope, frame_rate: float, lag_frames: float) -> float:
    """节拍网格评分：网格点上的平均能量减去反拍位置的平均能量。

    纯周期信号在整数倍周期上的自相关一样高，但反拍惩罚能区分
    "每拍都有 onset"（真拍速）和"隔拍对齐"（半速误判）。
    """
    import numpy as np

    if lag_frames < 2:
        return -1.0
    best = -1.0
    for step in range(16):
        offset = lag_frames * step / 16.0
        on_positions = np.arange(offset, envelope.size - 1, lag_frames)
        if on_positions.size == 0:
            continue
        on_energy = float(envelope[on_positions.astype(int)].mean())
        off_positions = on_positions + lag_frames / 2.0
        off_positions = off_positions[off_positions < envelope.size - 1]
        off_energy = float(envelope[off_positions.astype(int)].mean()) if off_positions.size else 0.0
        best = max(best, on_energy - off_energy)
    return best


def _estimate_bpm(envelope, sample_rate: int = SAMPLE_RATE) -> Tuple[float, float]:
    """onset 包络自相关估 BPM。返回 (bpm, confidence∈[0,1])，失败 (0, 0)。

    自相关 argmax 给出粗滞后；抛物线插值消除整数滞后的量化偏差；
    再用梳状评分在 {L/2, L, 2L} 三个倍速候选里挑真拍速。
    """
    import numpy as np

    frame_rate = sample_rate / STFT_HOP
    min_lag = int(round(frame_rate * 60.0 / BPM_MAX))
    max_lag = int(round(frame_rate * 60.0 / BPM_MIN))
    if envelope.size < max_lag * 2 or min_lag < 2:
        return 0.0, 0.0
    centered = envelope - float(envelope.mean())
    auto = np.correlate(centered, centered, mode="full")[centered.size - 1 :]
    if auto[0] <= 0:
        return 0.0, 0.0
    auto = auto / auto[0]
    search = auto[min_lag : max_lag + 1]
    best_offset = int(np.argmax(search))
    best_lag = min_lag + best_offset
    confidence = float(max(0.0, search[best_offset]))

    # 抛物线插值：周期常落在两个整数滞后之间，长滞后反而对齐更好，
    # 不插值会系统性偏向慢速档
    lag = float(best_lag)
    if 0 < best_lag < auto.size - 1:
        y0, y1, y2 = float(auto[best_lag - 1]), float(auto[best_lag]), float(auto[best_lag + 1])
        denominator = y0 - 2.0 * y1 + y2
        if abs(denominator) > 1e-9:
            shift = 0.5 * (y0 - y2) / denominator
            if -0.5 <= shift <= 0.5:
                lag = best_lag + shift

    candidates = [lag]
    if lag / 2.0 >= min_lag:
        candidates.append(lag / 2.0)
    if lag * 2.0 <= max_lag:
        candidates.append(lag * 2.0)
    lag = max(candidates, key=lambda value: _comb_score(envelope, frame_rate, value))

    bpm = 60.0 * frame_rate / lag
    return round(bpm, 1), round(min(1.0, confidence), 3)


def _beat_grid(bpm: float, envelope, duration: float, sample_rate: int = SAMPLE_RATE) -> List[float]:
    """从 BPM 出发拟合相位（让 beat 落在 onset 能量最高处），生成 beat 时间点。"""
    import numpy as np

    if bpm <= 0 or duration <= 0 or envelope.size == 0:
        return []
    frame_rate = sample_rate / STFT_HOP
    period = 60.0 / bpm
    steps = 24
    best_offset, best_score = 0.0, -1.0
    for step in range(steps):
        offset = period * step / steps
        positions = np.arange(offset, duration, period)
        frames = np.clip((positions * frame_rate).astype(int), 0, envelope.size - 1)
        score = float(envelope[frames].sum())
        if score > best_score:
            best_score, best_offset = score, offset
    return [round(t, 4) for t in np.arange(best_offset, duration, period)]


def _rms_curve(samples, sample_rate: int = SAMPLE_RATE):
    """非重叠 RMS 窗口曲线，返回 (times, rms_values)，未归一（绝对振幅 0~1）。"""
    import numpy as np

    window = int(RMS_WINDOW_SECONDS * sample_rate)
    if samples.size < window:
        window = max(1, samples.size)
    usable = samples[: (samples.size // window) * window]
    if usable.size == 0:
        return np.zeros(0), np.zeros(0)
    blocks = usable.reshape(-1, window)
    rms = np.sqrt((blocks * blocks).mean(axis=1))
    times = (np.arange(rms.size) + 0.5) * (window / sample_rate)
    return times, rms


def _silence_segments(times, rms) -> Tuple[List[List[float]], float]:
    import numpy as np

    if rms.size == 0:
        return [], 1.0
    threshold = max(0.004, 0.08 * float(np.percentile(rms, 90)))
    silent = rms < threshold
    segments: List[List[float]] = []
    start: Optional[float] = None
    half = RMS_WINDOW_SECONDS / 2
    for i, flag in enumerate(silent):
        if flag and start is None:
            start = float(times[i]) - half
        elif not flag and start is not None:
            segments.append([round(max(0.0, start), 2), round(float(times[i]) - half, 2)])
            start = None
    if start is not None:
        segments.append([round(max(0.0, start), 2), round(float(times[-1]) + half, 2)])
    ratio = float(silent.mean())
    return segments, round(ratio, 3)


def _scene_bounds(scene: Dict[str, Any]) -> Optional[Tuple[float, float]]:
    start = scene.get("start_time_seconds")
    end = scene.get("end_time_seconds")
    try:
        if start is not None and end is not None and float(end) > float(start):
            return float(start), float(end)
    except (TypeError, ValueError):
        pass
    return None


def extract_audio_features(
    audio_path: Path,
    scenes: Sequence[Dict[str, Any]] = (),
) -> Dict[str, Any]:
    try:
        import numpy as np
    except ImportError:
        return _unavailable("缺少 numpy")

    try:
        samples = _decode_pcm(audio_path)
    except FileNotFoundError:
        return _unavailable("未找到 ffmpeg")
    except Exception as exc:
        return _unavailable(f"音频解码失败: {exc}")

    duration = samples.size / SAMPLE_RATE
    if duration < 1.0:
        return _unavailable(f"音频过短（{duration:.2f}s）")

    envelope = _onset_envelope(samples)
    onsets = _pick_onsets(envelope)
    bpm, bpm_confidence = _estimate_bpm(envelope)
    beats = _beat_grid(bpm, envelope, duration) if bpm_confidence >= 0.1 else []
    times, rms = _rms_curve(samples)
    silence_segments, silence_ratio = _silence_segments(times, rms)

    rms_peak = float(rms.max()) if rms.size else 0.0
    rms_mean = float(rms.mean()) if rms.size else 0.0
    rms_p20 = float(np.percentile(rms, 20)) if rms.size else 0.0
    rms_p95 = float(np.percentile(rms, 95)) if rms.size else 0.0

    # 响度弧线：降采样到 ≤LOUDNESS_ARC_POINTS 个点，按全局峰值归一
    arc: List[Dict[str, float]] = []
    if rms.size:
        bucket = max(1, rms.size // LOUDNESS_ARC_POINTS)
        for i in range(0, rms.size, bucket):
            chunk = rms[i : i + bucket]
            arc.append(
                {
                    "t": round(float(times[min(i + bucket // 2, times.size - 1)]), 2),
                    "rms": round(float(chunk.mean()) / rms_peak, 3) if rms_peak > 0 else 0.0,
                }
            )

    beats_arr = np.asarray(beats) if beats else np.zeros(0)
    onsets_arr = np.asarray(onsets) if onsets else np.zeros(0)

    scene_stats: List[Dict[str, Any]] = []
    cuts_total = 0
    cuts_on_beat = 0
    for scene in scenes:
        bounds = _scene_bounds(scene)
        if bounds is None:
            continue
        start, end = bounds
        span = max(end - start, 1e-6)
        start_idx = int(start / RMS_WINDOW_SECONDS)
        end_idx = max(start_idx + 1, int(np.ceil(end / RMS_WINDOW_SECONDS)))
        scene_rms = rms[start_idx:end_idx]
        scene_onsets = int(((onsets_arr >= start) & (onsets_arr < end)).sum()) if onsets_arr.size else 0
        cut_on_beat: Optional[bool] = None
        if beats_arr.size and start > 0.2:
            cuts_total += 1
            on_beat = bool(np.min(np.abs(beats_arr - start)) <= BEAT_TOLERANCE_SECONDS)
            cuts_on_beat += int(on_beat)
            cut_on_beat = on_beat
        scene_stats.append(
            {
                "scene_number": int(scene.get("scene_number", 0) or 0),
                "start": round(start, 3),
                "end": round(end, 3),
                "rms_mean": round(float(scene_rms.mean()) / rms_peak, 3) if scene_rms.size and rms_peak > 0 else 0.0,
                "rms_peak": round(float(scene_rms.max()) / rms_peak, 3) if scene_rms.size and rms_peak > 0 else 0.0,
                "onset_density": round(scene_onsets / span, 2),
                "cut_on_beat": cut_on_beat,
            }
        )

    return {
        "version": AUDIO_FEATURES_VERSION,
        "status": "ok",
        "audio_file": audio_path.name,
        "sample_rate": SAMPLE_RATE,
        "duration_seconds": round(duration, 2),
        "global": {
            "bpm": bpm,
            "bpm_confidence": bpm_confidence,
            "beat_count": int(beats_arr.size),
            "onset_count": int(onsets_arr.size),
            "onset_rate": round(onsets_arr.size / duration, 2) if duration > 0 else 0.0,
            "rms_mean": round(rms_mean, 4),
            "rms_peak": round(rms_peak, 4),
            "rms_p20": round(rms_p20, 4),
            "rms_p95": round(rms_p95, 4),
            "silence_ratio": silence_ratio,
            "silence_segments": silence_segments[:40],
            "loudness_arc": arc,
        },
        "beat_alignment": {
            "tolerance_ms": int(BEAT_TOLERANCE_SECONDS * 1000),
            "cuts_total": cuts_total,
            "cuts_on_beat": cuts_on_beat,
            "ratio": round(cuts_on_beat / cuts_total, 3) if cuts_total else 0.0,
        },
        "scenes": scene_stats,
    }


def _scene_signature(scenes: Sequence[Dict[str, Any]]) -> List[Tuple[int, float, float]]:
    signature: List[Tuple[int, float, float]] = []
    for scene in scenes:
        bounds = _scene_bounds(scene)
        if bounds is None:
            continue
        signature.append((int(scene.get("scene_number", 0) or 0), round(bounds[0], 2), round(bounds[1], 2)))
    return signature


def generate_audio_features_file(
    video_dir: Path,
    scenes: Sequence[Dict[str, Any]],
    video_id: str = "",
    force: bool = False,
) -> Dict[str, Any]:
    """计算（或复用缓存的）audio_features.json。任何失败都返回 unavailable，不抛出。"""
    output_path = Path(video_dir) / AUDIO_FEATURES_FILENAME
    signature = _scene_signature(scenes)

    if output_path.exists() and not force:
        try:
            cached = json.loads(output_path.read_text(encoding="utf-8"))
            cached_signature = [
                (int(item.get("scene_number", 0)), round(float(item.get("start", 0)), 2), round(float(item.get("end", 0)), 2))
                for item in cached.get("scenes", [])
            ]
            if (
                isinstance(cached, dict)
                and cached.get("version") == AUDIO_FEATURES_VERSION
                and cached.get("status") == "ok"
                and cached_signature == signature
            ):
                return cached
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass

    audio_path = find_audio_file(Path(video_dir), video_id)
    if audio_path is None:
        payload = _unavailable("目录下未找到音频文件")
    else:
        try:
            payload = extract_audio_features(audio_path, scenes)
        except Exception as exc:  # 防御：特征提取绝不阻塞主流程
            payload = _unavailable(f"特征提取异常: {exc}")

    try:
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass
    return payload


def attach_audio_features(data: Dict[str, Any], video_dir: Path, force: bool = False) -> Dict[str, Any]:
    """把全局特征挂到 data['audio_features']，逐场景特征挂到 scene['audio_features']。"""
    scenes = data.get("scenes") or []
    payload = generate_audio_features_file(
        Path(video_dir),
        scenes,
        video_id=str(data.get("video_id", "") or ""),
        force=force,
    )
    data["audio_features"] = {key: value for key, value in payload.items() if key != "scenes"}
    per_scene = {int(item.get("scene_number", 0)): item for item in payload.get("scenes", [])}
    for scene in scenes:
        stats = per_scene.get(int(scene.get("scene_number", 0) or 0))
        if stats:
            scene["audio_features"] = {
                key: value for key, value in stats.items() if key not in {"scene_number", "start", "end"}
            }
    return data


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="为已有的 scene_scores.json 生成/刷新 audio_features.json")
    parser.add_argument("scores_path", type=Path, help="scene_scores.json 路径")
    parser.add_argument("--force", action="store_true", help="忽略缓存强制重算")
    args = parser.parse_args()

    scores_path = args.scores_path.expanduser().resolve()
    data = json.loads(scores_path.read_text(encoding="utf-8"))
    payload = generate_audio_features_file(
        scores_path.parent,
        data.get("scenes") or [],
        video_id=str(data.get("video_id", "") or ""),
        force=args.force,
    )
    print(json.dumps({key: value for key, value in payload.items() if key != "scenes"}, ensure_ascii=False, indent=2))
    return 0 if payload.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
