---
name: W0-current-truth-freeze-implementation
stage: W0
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_review: docs/superpowers/audits/2026-05-22-ready-recent-change-review-and-next-roadmap.md
---

# W0 — Current-truth freeze implementation plan

## 0. Scope

W0 is a pure documentation + snapshot phase. It produces 6 artifacts in one PR so W1 can start immediately.

In scope: snapshot current verification outputs, write Stage V closeout note, publish gate taxonomy v0, publish W1 lint gate semantic, create reusable verify-bundle.sh, commit and link.

Out of scope: any production code change, lint cleanup, test changes, or `verify:*` script edits.

## 1. Success criteria

W0 closes when all 6 deliverables in roadmap § 3 (steps 1-6) are present, committed, and reviewed by Codex per roadmap § 2.2:

1. `docs/superpowers/audits/2026-05-22-verification-snapshot/` directory with 7 `.out` + 7 `.exit` files.
2. `docs/superpowers/audits/2026-05-22-stage-v-closeout-note.md`.
3. `docs/superpowers/operations/verify-gate-taxonomy-v0.md`.
4. `docs/superpowers/operations/w1-lint-gate-semantic.md`.
5. `docs/superpowers/audits/2026-05-22-stage-w-closeout/verify-bundle.sh` (executable).
6. W0 PR linking the above and noting "W0 complete, W1 unblocked."

## 2. Step-by-step (exec from repo root)

### Step 1 — Snapshot current verification outputs

```bash
mkdir -p docs/superpowers/audits/2026-05-22-verification-snapshot
SNAP=docs/superpowers/audits/2026-05-22-verification-snapshot
set -o pipefail
npm run typecheck 2>&1 | tee "$SNAP/typecheck.out"; echo "${PIPESTATUS[0]}" > "$SNAP/typecheck.exit"
npm run lint:check 2>&1 | tee "$SNAP/lint-check.out"; echo "${PIPESTATUS[0]}" > "$SNAP/lint-check.exit"
node scripts/check-eslint-baseline.cjs 2>&1 | tee "$SNAP/baseline.out"; echo "${PIPESTATUS[0]}" > "$SNAP/baseline.exit"
npm run verify:native 2>&1 | tee "$SNAP/verify-native.out"; echo "${PIPESTATUS[0]}" > "$SNAP/verify-native.exit"
node scripts/check-silent-catch.cjs 2>&1 | tee "$SNAP/silent-catch.out"; echo "${PIPESTATUS[0]}" > "$SNAP/silent-catch.exit"
npm run verify:ipc-contract 2>&1 | tee "$SNAP/verify-ipc-contract.out"; echo "${PIPESTATUS[0]}" > "$SNAP/verify-ipc-contract.exit"
npm run test 2>&1 | tee "$SNAP/test.out"; echo "${PIPESTATUS[0]}" > "$SNAP/test.exit"
```

Use bash (not zsh) for `${PIPESTATUS[0]}` semantics. If running under zsh, prepend `setopt pipefail` and use `${pipestatus[1]}`.

Expected `.exit` values on 2026-05-22 branch HEAD:

- typecheck: `0`
- lint-check: non-zero (25 errors)
- baseline: non-zero (19 new / 16 stale)
- verify-native: `0`
- silent-catch: `0`
- verify-ipc-contract: `0`
- test: `0`

If any value diverges from above, document the divergence in `$SNAP/README.md` before continuing.

### Step 2 — Stage V closeout note

Write `docs/superpowers/audits/2026-05-22-stage-v-closeout-note.md` (≤ 1 page) covering:

- Which Stage V V1-V6 items landed (cite commit hashes from `git log main..HEAD --oneline`).
- Which Stage V items deferred to Stage W (e.g., V3.3b.3-5 → W4 per audit § G5.1).
- Link to roadmap W as the planning entry point.
- Explicit statement: "The locked Stage V plan is historical implementation guidance; do not edit. This closeout is the current-state source of truth."

### Step 3 — Gate taxonomy v0

Write `docs/superpowers/operations/verify-gate-taxonomy-v0.md` with one table:

| script | bucket | rationale |
| --- | --- | --- |
| `verify` | merge | top-level merge gate (slim) |
| `typecheck` | merge | part of slim gate |
| `lint:check` | merge | W1 target (zero rule errors) |
| `verify:native` | merge | required for SQLite paths |
| `verify:ipc-contract` | merge | Stage V V5 gate |
| ... | ... | one row per current `package.json` `verify:*` script |

Buckets: `merge` / `manual-deep` / `release-only` / `debt-dashboard` / `archive`. Any script not classifiable gets `archive`.

Generate the row inventory with `node -e "const p=require('./package.json'); for(const k of Object.keys(p.scripts).filter(k=>k.startsWith('verify')||k==='typecheck'||k==='lint:check'||k==='test')) console.log(k)"`.

### Step 4 — W1 lint gate semantic

Write `docs/superpowers/operations/w1-lint-gate-semantic.md` (≤ ½ page):

> **W1 "lint green" definition**
>
> `npm run lint:check` exits with no rule-level errors. The current warning count (~769 as of 2026-05-22) is W2 scope, not W1. A W1 PR that touches warnings but not errors is out of scope. A W1 PR that resolves errors and accidentally reduces warning count is fine but must not increase warnings beyond the snapshot baseline.

### Step 5 — verify-bundle.sh

Create `docs/superpowers/audits/2026-05-22-stage-w-closeout/verify-bundle.sh` (executable: `chmod +x`).

**Important**: macOS default `/bin/bash` is 3.2 and does **not** support associative arrays (`declare -A`). The script below uses parallel arrays so it runs on macOS default bash 3.2 and bash 4+. The `#!/usr/bin/env bash` shebang forces the bash interpreter even when the developer's login shell is zsh; do not invoke the file as `zsh verify-bundle.sh` because zsh arrays are 1-indexed and this script uses 0-indexed loops.

```bash
#!/usr/bin/env bash
# Used by Stage W closeout per roadmap § 2.1.
# Re-runs each captured command and asserts exit code matches stored .exit.
# Compatible with bash 3.2 (macOS default) and bash 4+. Must be invoked via
# bash (the shebang handles this); do not run with `zsh` because the array
# loop is 0-indexed.

SNAP="$(cd "$(dirname "$0")/../2026-05-22-verification-snapshot" && pwd)"
cd "$(git rev-parse --show-toplevel)"

NAMES=(typecheck lint-check baseline verify-native silent-catch verify-ipc-contract test)
CMDS=(
  "npm run typecheck"
  "npm run lint:check"
  "node scripts/check-eslint-baseline.cjs"
  "npm run verify:native"
  "node scripts/check-silent-catch.cjs"
  "npm run verify:ipc-contract"
  "npm run test"
)

fail=0
i=0
while [ $i -lt ${#NAMES[@]} ]; do
  name="${NAMES[$i]}"
  cmd="${CMDS[$i]}"
  expected_exit="$(cat "$SNAP/$name.exit" 2>/dev/null || echo missing)"
  if [ ! -s "$SNAP/$name.out" ]; then
    echo "MISSING $SNAP/$name.out"
    fail=1
    i=$((i+1))
    continue
  fi
  eval "$cmd" >/dev/null 2>&1
  actual_exit=$?
  if [ "$expected_exit" = "$actual_exit" ]; then
    echo "OK    $name (exit=$actual_exit)"
  else
    echo "DRIFT $name (expected=$expected_exit actual=$actual_exit)"
    fail=1
  fi
  i=$((i+1))
done
exit $fail
```

Verify the script runs on the developer's local bash before committing:

```bash
bash --version
bash docs/superpowers/audits/2026-05-22-stage-w-closeout/verify-bundle.sh
```

### Step 6 — W0 PR

Commit all of the above in one PR titled `W0 — current-truth freeze`. PR description links the 5 deliverable files and notes: "W0 complete, W1 unblocked. Next: W1 lint errors + baseline drift per `docs/superpowers/plans/2026-05-22-W1-...md`."

## 3. Final verification

After Step 5 created the script, run:

```bash
bash docs/superpowers/audits/2026-05-22-stage-w-closeout/verify-bundle.sh
```

It should print 5 `OK` (typecheck, verify-native, silent-catch, verify-ipc-contract, test) and 2 `OK` for lint-check/baseline (because they match the captured non-zero exit). `DRIFT` indicates the snapshot is stale and should be re-captured.

## 4. Codex review

Per roadmap § 2.2:

- Plan review: this document, before W0 step 1 is started.
- W0 exit review: after PR is up, Codex runs the 5-question checklist plus reruns `verify-bundle.sh` and confirms zero `DRIFT`.

W0 is closed when both reviews return 0-异议 per roadmap § 2.2 definition.
