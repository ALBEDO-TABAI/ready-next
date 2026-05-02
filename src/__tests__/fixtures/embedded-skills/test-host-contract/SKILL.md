---
name: test-host-contract
description: >
  Architectural smoke fixture exercising the full Skill Host Contract surface
  (spawn_context with a config_file + secondary_file, shell_allowlist_extensions,
  default_action_timeout_ms, status_detection with a non-default json_field name,
  lifecycle.on_uninstall_remove). Used purely by
  src/__tests__/skill-host-controller-fixture-skill.test.ts to prove that adding
  a new skill requires zero changes to Ready core code.
when-to-use: |
  Never invoked from product code. This skill exists only to drive the
  contract-layer end-to-end test that proves the host is purely manifest-driven.
---

# Test Host Contract Fixture

This skill is consumed by the architectural proof test. It declares the full
host_requirements surface so the SkillHostController can be exercised end-to-end
against a single manifest.

## Action

The single declared action runs `scripts/echo.py`, which prints a short JSON
status line to stdout. The action is intentionally tiny — the point is the
manifest, not the script.
