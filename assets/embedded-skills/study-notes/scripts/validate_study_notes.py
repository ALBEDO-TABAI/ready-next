#!/usr/bin/env python3
"""Structural and routing validation for the study-notes skill."""

from __future__ import annotations

import json
import re
import shutil
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

REQUIRED_FILES = (
    "SKILL.md",
    "CHANGELOG.md",
    "evals/evals.json",
    "evals/README.md",
    "references/route-matrix.md",
    "references/complexity-rules.md",
    "references/output-contract.md",
    "references/study-goals.md",
    "references/routes.json",
    "references/method-knowledge-tutorial.md",
    "references/method-opinion-commentary.md",
    "references/method-narrative-story.md",
    "references/method-data-report.md",
    "references/method-news-brief.md",
    "references/method-framework-methodology.md",
    "references/method-mixed-content.md",
    "references/method-unsuitable-input.md",
    "references/examples.md",
    "scripts/route_study_notes.py",
)


def _load_routes() -> set[str]:
    path = ROOT / "references" / "routes.json"
    if not path.exists():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return set(data.get("routes", []))


REQUIRED_ROUTES = _load_routes() or {
    "knowledge-tutorial",
    "opinion-commentary",
    "narrative-story",
    "data-report",
    "news-brief",
    "framework-methodology",
    "mixed-content",
    "unsuitable-input",
}


# Single list for all example-coverage checks; check_examples and
# check_route_consistency both consume it so the two can't drift apart.
EXAMPLE_LABELS = (
    "Knowledge Tutorial",
    "News Brief",
    "Data Report",
    "Opinion Commentary",
    "Narrative Story",
    "Mixed Content",
    "Unsuitable Input",
    "Raw Image Mismatch",
    "Layered Mixed Content",
    "Layered Data Report",
)


def load_router():
    path = ROOT / "scripts" / "route_study_notes.py"
    spec = spec_from_file_location("route_study_notes", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load route_study_notes.py")
    module = module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def check_required_files(errors: list[str]) -> None:
    for relative in REQUIRED_FILES:
        if not (ROOT / relative).exists():
            errors.append(f"Missing required file: {relative}")


def check_workflow_sequence(errors: list[str]) -> None:
    skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    match = re.search(r"## Workflow\n\n(.*?)(?:\n## |\Z)", skill_text, re.DOTALL)
    if not match:
        errors.append("Could not find the Workflow section in SKILL.md")
        return

    workflow_text = match.group(1)
    step_matches = re.findall(r"(?m)^### Step ([0-9]+): (.+)$", workflow_text)
    numbers = [int(value) for value, _ in step_matches]
    if not numbers:
        errors.append("Workflow section does not contain explicit Step headings")
        return

    expected = list(range(1, len(numbers) + 1))
    if numbers != expected:
        errors.append(f"Workflow numbering is not contiguous: found {numbers}, expected {expected}")

    expected_labels = {
        1: "输入格式",
        2: "学习目标",
        3: "内容类型",
        4: "适不适合",
        5: "输入复杂度",
        6: "可信度",
        7: "按内容类型选择结构并起草",
        8: "输出契约",
    }
    for number, label in expected_labels.items():
        if not any(step_number == number and label in title for step_number, title in ((int(n), t) for n, t in step_matches)):
            errors.append(f"Workflow is missing the expected Step {number} focus: {label}")


def check_examples(errors: list[str]) -> None:
    examples_text = (ROOT / "references" / "examples.md").read_text(encoding="utf-8")
    example_count = len(re.findall(r"^## Example", examples_text, re.MULTILINE))
    output_count = len(re.findall(r"^### Output$", examples_text, re.MULTILINE))
    if example_count < 7:
        errors.append(f"Expected at least 7 worked examples, found {example_count}")
    if output_count != example_count:
        errors.append(f"Every example must include a full Output section: examples={example_count}, outputs={output_count}")

    for label in EXAMPLE_LABELS:
        if label not in examples_text:
            errors.append(f"Examples are missing required coverage for: {label}")


def check_output_contract(errors: list[str]) -> None:
    contract_text = (ROOT / "references" / "output-contract.md").read_text(encoding="utf-8")

    required_sections = (
        "## Analogy policy",
        "## Fact anchor policy",
        "## Low-confidence output",
        "## Language policy",
    )
    for snippet in required_sections:
        if snippet not in contract_text:
            errors.append(f"Output contract is missing required section: {snippet}")

    if "study-goals.md" not in contract_text:
        errors.append("Output contract does not reference study-goals.md")


def check_method_structure(errors: list[str]) -> None:
    for route in REQUIRED_ROUTES:
        path = ROOT / "references" / f"method-{route}.md"
        text = path.read_text(encoding="utf-8")
        required_sections = (
            "### `short`",
            "### `standard`",
            "### `layered`",
            "## Analogy policy",
            "## Route-specific failure modes",
        )
        for snippet in required_sections:
            if snippet not in text:
                errors.append(f"{path.relative_to(ROOT)} is missing required section: {snippet}")


def check_study_goals(errors: list[str]) -> None:
    """study-goals.md must define every goal the router can emit, and SKILL.md must wire it in."""
    router = load_router()
    goals_text = (ROOT / "references" / "study-goals.md").read_text(encoding="utf-8")
    goal_names = {bucket.name for bucket in router.GOALS}
    goal_names.update(router.DEFAULT_GOAL_BY_ROUTE.values())
    for goal in sorted(goal_names):
        if goal not in goals_text:
            errors.append(f"study-goals.md does not cover goal: {goal}")

    skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    if "study-goals.md" not in skill_text:
        errors.append("SKILL.md does not reference study-goals.md")


def check_route_consistency(errors: list[str]) -> None:
    router = load_router()
    script_routes = {bucket.name for bucket in router.ROUTES} | {"mixed-content"}
    if script_routes != REQUIRED_ROUTES:
        errors.append(
            "Route mismatch between validator and route_study_notes.py: "
            f"validator={sorted(REQUIRED_ROUTES)}, script={sorted(script_routes)}"
        )

    skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    route_matrix = (ROOT / "references" / "route-matrix.md").read_text(encoding="utf-8")
    for route in REQUIRED_ROUTES:
        if f"`{route}`" not in skill_text:
            errors.append(f"SKILL.md does not mention route: {route}")
        if f"`{route}`" not in route_matrix:
            errors.append(f"route-matrix.md does not mention route: {route}")


def run_router_evals(errors: list[str]) -> None:
    router = load_router()
    evals_path = ROOT / "evals" / "evals.json"
    data = json.loads(evals_path.read_text(encoding="utf-8"))
    evals = data.get("evals", [])
    covered_routes = {item.get("expected_route") for item in evals}

    missing_routes = sorted(route for route in REQUIRED_ROUTES if route not in covered_routes)
    if missing_routes:
        errors.append(f"Evals do not cover all required routes: {', '.join(missing_routes)}")

    for item in evals:
        result = router.classify(
            item.get("prompt", ""),
            item.get("texts", []),
            item.get("files", []),
            item.get("hints", []),
        )
        case_prefix = f"Eval {item.get('id')} ({item.get('name', 'unnamed')})"

        expected_keys = {
            "content_type": "expected_route",
            "study_goal": "expected_goal",
            "complexity": "expected_complexity",
            "modality": "expected_modality",
            "status": "expected_status",
            "confidence": "expected_confidence",
        }
        for key, expected_key in expected_keys.items():
            expected = item.get(expected_key)
            if expected is not None and result.get(key) != expected:
                errors.append(f"{case_prefix}: expected {key}={expected}, got {result.get(key)}")

        expected_unsuitable = item.get("expected_unsuitable")
        if expected_unsuitable is not None and result.get("unsuitable") != expected_unsuitable:
            errors.append(
                f"{case_prefix}: expected unsuitable={expected_unsuitable}, got {result.get('unsuitable')}"
            )


def _safe_run(label: str, fn, errors: list[str]) -> None:
    try:
        fn(errors)
    except FileNotFoundError as exc:
        errors.append(f"{label}: missing dependency file: {exc}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{label}: unexpected error: {exc!r}")


def report_manual_checks() -> None:
    """E3: surface manual_checks + prior_notes/topic_thread from evals as TODO output.

    Format note: each TODO line is prefixed with INFO/TODO so a downstream consumer
    can filter by line prefix without breaking on multi-line content. The terminal
    `study-notes validation passed` line remains the unambiguous pass marker.
    """
    evals_path = ROOT / "evals" / "evals.json"
    if not evals_path.exists():
        return
    try:
        data = json.loads(evals_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return
    todos = []
    extra_context = []
    for item in data.get("evals", []):
        manual = item.get("manual_checks")
        if manual:
            todos.append((item.get("id"), item.get("name"), manual))
        # prior_notes / topic_thread are LLM-side conventions; the router doesn't see them.
        # Surface them so a reviewer knows these evals are NOT covered by router_evals.
        if item.get("prior_notes") or item.get("topic_thread"):
            extra_context.append((item.get("id"), item.get("name"), sorted(
                k for k in ("prior_notes", "topic_thread") if item.get(k)
            )))
    if todos:
        print("INFO: manual_checks (require LLM/human review, not auto-validated):")
        for id_, name, items in todos:
            print(f"TODO  Eval {id_} ({name}):")
            for line in items:
                print(f"TODO    - {line}")
    if extra_context:
        print("INFO: evals carrying LLM-only fields (router never inspects these):")
        for id_, name, fields in extra_context:
            print(f"TODO  Eval {id_} ({name}): fields={','.join(fields)}")


def main() -> None:
    errors: list[str] = []
    try:
        # Aggregate errors across checks instead of bailing on the first failed prerequisite.
        check_required_files(errors)
        _safe_run("workflow_sequence", check_workflow_sequence, errors)
        _safe_run("examples", check_examples, errors)
        _safe_run("output_contract", check_output_contract, errors)
        _safe_run("method_structure", check_method_structure, errors)
        _safe_run("study_goals", check_study_goals, errors)
        _safe_run("route_consistency", check_route_consistency, errors)
        _safe_run("router_evals", run_router_evals, errors)

        if errors:
            for error in errors:
                print(f"ERROR: {error}")
            raise SystemExit(1)

        report_manual_checks()
        print("study-notes validation passed")
    finally:
        shutil.rmtree(ROOT / "scripts" / "__pycache__", ignore_errors=True)


if __name__ == "__main__":
    main()
