---
name: W6-release-gate-reconciliation-implementation
stage: W6
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_phase: docs/superpowers/plans/archive/2026-05-22-W0-current-truth-freeze-implementation.md
---

# W6 — Release gate reconciliation implementation plan

## 0. Scope

W6 takes the W0 gate taxonomy v0 and formalizes it against the actual `package.json` + any CI artifacts. It produces a single cross-reference table that future agents read once and never have to re-derive.

In scope: classify every `verify:*` script in current `package.json` into one of {`merge`, `manual-deep`, `release-only`, `debt-dashboard`, `archive`}; rename or remove scripts that no longer make sense; align CI labels/env if any exist for this branch.

Out of scope: introducing new verify scripts, changing the behavior of any existing script, blocking on dogfood items (W5 owns that).

## 1. Preconditions

- W0 closed: `verify-gate-taxonomy-v0.md` exists and W1 ran against its semantics.
- W1 closed (so the merge bucket actually passes).
- W6 may run in parallel with W0/W1 in principle, but the actual reconciliation needs at least W0 v0 to amend.

## 2. Success criteria

1. `docs/superpowers/operations/verify-gate-taxonomy.md` (v1, not v0) exists with one row per script.
2. Each row has columns: `script`, `bucket`, `rationale`, `delta-from-v0`.
3. `docs/superpowers/operations/w6-scripts-diff.md` exists showing `git diff main..HEAD -- package.json` filtered to the `scripts:` block.
4. Every `verify:*` / `lint:*` / `typecheck` / `test*` script in current `package.json` is classified (no script left unbucketed).
5. Any script renamed or removed in W6 has the rename/removal commit linked.
6. If GitHub Actions / CI exists for this branch, the labels/env match the taxonomy buckets.

## 3. Step-by-step

### W6.1 — Inventory all verification scripts

```bash
node -e "const p=require('./package.json'); for(const k of Object.keys(p.scripts)) if(/^(verify|lint|typecheck|test)/.test(k)) console.log(k)" \
  > docs/superpowers/operations/w6-script-inventory.txt
```

Open `w6-script-inventory.txt` — should list every script the W6 taxonomy needs to classify.

### W6.2 — Diff v0 against current

Read `docs/superpowers/operations/verify-gate-taxonomy-v0.md`. For each script in the inventory:

- If v0 already classified it: copy bucket + rationale.
- If v0 missed it (added since W0 capture): assign a bucket, write rationale.
- If v0 classified a script that no longer exists (removed since W0): mark for removal note in v1.

### W6.3 — Write v1 taxonomy

Create `docs/superpowers/operations/verify-gate-taxonomy.md`:

```md
# Verify gate taxonomy (v1, supersedes v0)

Buckets:

- **merge** — must pass before every PR merge. The slim merge gate.
- **manual-deep** — opt-in deep checks; run before release branches, big refactors.
- **release-only** — run on release candidates only; not on every PR.
- **debt-dashboard** — tracks debt growth (e.g., lint warning budget); fails only on regression.
- **archive** — historical, kept for reference; not run by anyone routinely.

| Script | Bucket | Rationale | Delta from v0 |
| --- | --- | --- | --- |
| `verify` | merge | top-level merge gate (slim) | unchanged |
| `typecheck` | merge | … | unchanged |
| `lint:check` | merge | W1 target | unchanged |
| `verify:native` | merge | required for SQLite | unchanged |
| `verify:ipc-contract` | merge | Stage V V5 | unchanged |
| `test` | merge | full parallel suite | unchanged |
| ... | ... | ... | ... |
| `verify:lint-budget` | debt-dashboard | added in W2 | new |
| `verify:a0` | archive | Stage A0 historical | unchanged |
```

Every row must be present. Use `delta-from-v0` to mark `new` / `bucket-changed` / `renamed` / `removed` / `unchanged`.

### W6.4 — Script renames / removals (optional)

If any script is mis-named for its bucket (e.g., `verify:foo` that is actually a debt dashboard), propose a rename in this PR. Document each rename in a separate commit linked from `verify-gate-taxonomy.md`.

Removals: if any `verify:*` script has not been run in 3+ months and its bucket is `archive`, propose removal. Linked commit.

### W6.5 — CI alignment (conditional)

Detect CI presence first:

```bash
test -d .github/workflows && ls .github/workflows || echo "NO .github/workflows"
```

**Current state (verified 2026-05-22)**: `.github/workflows` does **not** exist on this branch. The default path is documentation-only.

If GitHub Actions exists at W6 time:

- Open each workflow file.
- Confirm only `merge` bucket scripts are gating merge.
- Confirm `release-only` scripts trigger only on release branches or tags.
- Confirm `manual-deep` / `debt-dashboard` are either on-demand workflows or scheduled.

If no CI exists (default): add a one-line note "No CI present on this branch as of <date>; taxonomy is documentation-only and must be re-aligned when CI is introduced" in the v1 doc.

### W6.6 — Scripts diff record

```bash
git diff main..HEAD -- package.json | grep -A1 '"scripts"' > docs/superpowers/operations/w6-scripts-diff.md
```

Plus a small narrative explaining each `scripts:` change since `main`.

## 4. Final verification

```bash
# every script in inventory has a taxonomy row
node -e '
const fs=require("fs"); const p=require("./package.json");
const tax=fs.readFileSync("docs/superpowers/operations/verify-gate-taxonomy.md","utf8");
const scripts=Object.keys(p.scripts).filter(k=>/^(verify|lint|typecheck|test)/.test(k));
for(const s of scripts) if(!tax.includes("`"+s+"`")) { console.error("MISSING in taxonomy:", s); process.exit(1); }
console.log("OK: all "+scripts.length+" scripts classified");
'
```

A reviewer should be able to: pick any `verify:*` script name, find its bucket in `verify-gate-taxonomy.md` within 10 seconds.

## 5. Codex review

Per roadmap § 2.2:

- Plan review before W6.1.
- W6 exit review: Codex spot-checks 3 random scripts and confirms bucket is correct per rationale. Codex also confirms `delta-from-v0` entries are accurate.

W6 closes when exit review returns 0-异议. W6 then makes the gate taxonomy referenceable from Stage W closeout.
