#!/usr/bin/env python3
"""
B Phase 3 — Compat adapter for legacy production callers.

The skill-runtime invokes Python actions with the contract:
    python <entry> [...baseArgs] --payload-json '{"key":"value",...}'

Two legacy actions stay alive for non-LLM callers (RSS visual analysis in
`src/main/modules/rss-engine/item-analysis-manager.ts`):
    - video_expert_pipeline    : { url, outputDir?, sceneThreshold?, bestThreshold? }
    - video_expert_ai_analyze  : { sceneScoresPath, mode? }

This adapter maps that JSON payload onto the vnext orchestrator
(`scripts/orchestrate_vnext.py`) which uses positional + flag CLI args.

LLM-driven callers go through SKILL.md (reference action) and pick
flags themselves — they never reach this adapter.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
ORCHESTRATOR = HERE / "orchestrate_vnext.py"


class CompatError(Exception):
    def __init__(self, message: str, exit_code: int = 2) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def _parse_args(argv: list[str]) -> tuple[str, dict]:
    action = ""
    payload: dict = {}
    if "--action" in argv:
        idx = argv.index("--action")
        if idx + 1 < len(argv):
            action = argv[idx + 1]
    if "--payload-json" in argv:
        idx = argv.index("--payload-json")
        if idx + 1 < len(argv):
            try:
                payload = json.loads(argv[idx + 1])
            except json.JSONDecodeError as exc:
                raise CompatError(f"ready_compat: invalid --payload-json: {exc}")
    return action, payload


def _build_pipeline_cmd(payload: dict) -> list[str]:
    source = (payload.get("url") or payload.get("source") or "").strip()
    if not source:
        raise CompatError("ready_compat: video_expert_pipeline requires `url`")
    cmd: list[str] = [sys.executable, str(ORCHESTRATOR), source]
    output_dir = payload.get("outputDir")
    if output_dir:
        cmd += ["-o", str(output_dir)]
    if payload.get("sceneThreshold") is not None:
        cmd += ["--scene-threshold", str(payload["sceneThreshold"])]
    if payload.get("bestThreshold") is not None:
        cmd += ["--best-threshold", str(payload["bestThreshold"])]
    return cmd


def _build_ai_analyze_cmd(payload: dict) -> list[str]:
    scores = (payload.get("sceneScoresPath") or payload.get("source") or "").strip()
    if not scores:
        raise CompatError("ready_compat: video_expert_ai_analyze requires `sceneScoresPath`")
    # vnext orchestrator auto-detects scene_scores.json source and
    # picks `--mode auto` internally; legacy `mode` payload is ignored.
    return [sys.executable, str(ORCHESTRATOR), scores]


def _empty_outputs() -> dict[str, str]:
    return {
        "outputDir": "",
        "sceneScoresPath": "",
        "runStatePath": "",
        "deliveryReportPath": "",
    }


def _safe_read_json(path: Path) -> dict[str, Any]:
    try:
        if not path.is_file():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _candidate_from_output(text: str) -> Optional[Path]:
    patterns = [
        r"Output Dir:\s*(.+)$",
        r"所有文件保存在:\s*(.+)$",
        r"评分文件:\s*(.+?scene_scores\.json)\s*$",
        r"交付报告:\s*(.+?delivery_report\.json)\s*$",
    ]
    for line in reversed(text.splitlines()):
        for pattern in patterns:
            match = re.search(pattern, line.strip())
            if not match:
                continue
            path = Path(match.group(1).strip())
            if path.name in {"scene_scores.json", "delivery_report.json", "run_state.json"}:
                return path.parent
            return path
    return None


def _is_video_output_dir(path: Path) -> bool:
    return (
        (path / "scene_scores.json").is_file()
        and (path / "run_state.json").is_file()
        and (path / "delivery_report.json").is_file()
    )


def _find_video_output_dir(output_root: Path, started_at: float) -> Optional[Path]:
    if _is_video_output_dir(output_root):
        return output_root
    if not output_root.exists():
        return None

    candidates: list[tuple[float, Path]] = []
    for scores_path in output_root.rglob("scene_scores.json"):
        candidate = scores_path.parent
        if not _is_video_output_dir(candidate):
            continue
        newest_mtime = max(
            (candidate / "scene_scores.json").stat().st_mtime,
            (candidate / "run_state.json").stat().st_mtime,
            (candidate / "delivery_report.json").stat().st_mtime,
        )
        if newest_mtime + 1 < started_at:
            continue
        candidates.append((newest_mtime, candidate))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _resolve_output_dir(action: str, payload: dict, stdout: str, stderr: str, started_at: float) -> Optional[Path]:
    if action == "video_expert_ai_analyze":
        scores = (payload.get("sceneScoresPath") or payload.get("source") or "").strip()
        return Path(scores).expanduser().resolve().parent if scores else None

    detected = _candidate_from_output(f"{stdout}\n{stderr}")
    if detected and _is_video_output_dir(detected.expanduser().resolve()):
        return detected.expanduser().resolve()

    output_root = payload.get("outputDir")
    if output_root:
        found = _find_video_output_dir(Path(str(output_root)).expanduser().resolve(), started_at)
        if found:
            return found

    return detected.expanduser().resolve() if detected else None


def _build_outputs(output_dir: Optional[Path]) -> dict[str, str]:
    outputs = _empty_outputs()
    if not output_dir:
        return outputs
    outputs["outputDir"] = str(output_dir)
    outputs["sceneScoresPath"] = str(output_dir / "scene_scores.json")
    outputs["runStatePath"] = str(output_dir / "run_state.json")
    outputs["deliveryReportPath"] = str(output_dir / "delivery_report.json")
    return outputs


def _message_from_state(run_state: dict[str, Any], stderr: str, fallback: str) -> str:
    for key in ("last_error", "error", "message"):
        value = run_state.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    stderr = stderr.strip()
    return stderr if stderr else fallback


def _validate_delivery_report(report_path: Path) -> tuple[bool, str]:
    report = _safe_read_json(report_path)
    if not report:
        return False, "delivery_report.json is missing or invalid"

    status = str(report.get("status") or "").strip().lower()
    if status not in {"completed", "success", "done"}:
        return False, f"delivery_report status is not completed: {status or '(missing)'}"

    list_checks = [
        "missing_outputs",
        "missing_screenshot_scenes",
        "missing_sample_scenes",
        "blocked_batches",
        "incomplete_scene_numbers",
    ]
    for key in list_checks:
        value = report.get(key)
        if not isinstance(value, list):
            return False, f"delivery_report missing list field: {key}"
        if value:
            return False, f"delivery_report {key} is not empty"

    required_outputs = report.get("required_outputs")
    if not isinstance(required_outputs, dict):
        return False, "delivery_report missing required_outputs"
    for name, metadata in required_outputs.items():
        if isinstance(metadata, dict) and metadata.get("ok") is False:
            return False, f"delivery_report required output is not ok: {name}"

    verification = report.get("verification")
    if isinstance(verification, dict) and verification.get("passed") is False:
        return False, "delivery_report verification did not pass"

    return True, ""


def _classify_result(return_code: int, output_dir: Optional[Path], stderr: str) -> tuple[bool, str, str]:
    if not output_dir:
        return False, "failed", stderr.strip() or "ready_compat: output directory was not resolved"

    run_state_path = output_dir / "run_state.json"
    delivery_report_path = output_dir / "delivery_report.json"
    run_state = _safe_read_json(run_state_path)
    raw_status = str(run_state.get("status") or "").strip().lower()

    if raw_status in {"blocked", "pending_review", "awaiting_input"}:
        return False, "blocked", _message_from_state(run_state, stderr, raw_status)
    if raw_status in {"failed", "error"}:
        return False, "failed", _message_from_state(run_state, stderr, raw_status)
    if return_code != 0:
        return False, "failed", _message_from_state(run_state, stderr, f"process exited with code {return_code}")
    if not raw_status:
        return False, "failed", _message_from_state(
            run_state,
            stderr,
            "run_state.json is missing required status",
        )

    if raw_status in {"completed", "success", "done"}:
        ok, reason = _validate_delivery_report(delivery_report_path)
        if ok:
            return True, "success", ""
        return False, "failed", reason

    return False, raw_status or "failed", _message_from_state(run_state, stderr, raw_status or "incomplete")


def _write_structured_result(
    *,
    ok: bool,
    status: str,
    outputs: dict[str, str],
    error_message: str,
    stdout: str,
    stderr: str,
) -> None:
    result_path = os.environ.get("READY_SKILL_RESULT_PATH")
    if not result_path:
        return
    payload = {
        "ok": ok,
        "status": status,
        "outputs": outputs,
        "artifacts": [],
        "error": {"message": error_message},
        "logs": {
            "stdout": stdout,
            "stderr": stderr,
        },
    }
    try:
        target = Path(result_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        sys.stderr.write(f"ready_compat: failed to write READY_SKILL_RESULT_PATH: {exc}\n")


def main() -> int:
    stdout = ""
    stderr = ""
    outputs = _empty_outputs()
    try:
        action, payload = _parse_args(sys.argv[1:])
        if action == "video_expert_pipeline":
            cmd = _build_pipeline_cmd(payload)
        elif action == "video_expert_ai_analyze":
            cmd = _build_ai_analyze_cmd(payload)
        else:
            raise CompatError(
                f"ready_compat: unsupported --action {action!r}; "
                "expected video_expert_pipeline | video_expert_ai_analyze"
            )

        started_at = time.time()
        completed = subprocess.run(
            cmd,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        output_dir = _resolve_output_dir(action, payload, stdout, stderr, started_at)
        outputs = _build_outputs(output_dir)
        ok, status, error_message = _classify_result(completed.returncode, output_dir, stderr)
        _write_structured_result(
            ok=ok,
            status=status,
            outputs=outputs,
            error_message=error_message,
            stdout=stdout,
            stderr=stderr,
        )
        if stdout:
            sys.stdout.write(stdout)
        if stderr:
            sys.stderr.write(stderr)
        return completed.returncode
    except CompatError as exc:
        stderr = f"{exc}\n"
        _write_structured_result(
            ok=False,
            status="failed",
            outputs=outputs,
            error_message=str(exc),
            stdout=stdout,
            stderr=stderr,
        )
        sys.stderr.write(stderr)
        return exc.exit_code
    except Exception as exc:
        message = f"ready_compat: {type(exc).__name__}: {exc}"
        stderr = f"{message}\n"
        _write_structured_result(
            ok=False,
            status="failed",
            outputs=outputs,
            error_message=message,
            stdout=stdout,
            stderr=stderr,
        )
        sys.stderr.write(stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
