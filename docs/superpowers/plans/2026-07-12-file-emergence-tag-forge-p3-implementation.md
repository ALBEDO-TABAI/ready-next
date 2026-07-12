---
title: Tag Forge P3 Controlled Tagging and New Artifact Enrichment
date: 2026-07-12
status: completed
enforce: true
---

# P3 implementation contract

## Completion definition

P3 is complete only when the application, not prompt memory, owns these invariants:

1. The bundled `tag-forge` copy and `/Users/user/实验田/skill-fac/tag-forge` authoring source are parity-checked. Relative references resolve; the unimplemented `tf` alias and writes to the bundled lexicon are removed.
2. One machine policy defines facet openness, quotas, blacklist, automatic state, pending behavior, and version. A validator resolves aliases only inside the proposed facet, rejects unknown closed-facet values, rejects model-proposed privileged state/project values, and never promotes pending terms.
3. Seed lexicon, user overlay, pending proposals, assignments, and artifact creation receipts have separate durable stores. Seed upgrades never overwrite the overlay.
4. Automatic tagging is eligible only for a Markdown file with a durable receipt minted by a real create action in the same run and completed by a final-save hash receipt. Existing files and ordinary edits are ineligible.
5. The hardened writer rejects symlinks and boundary escape, requires revision CAS, uses an atomic replace, merges existing frontmatter, removes duplicate top tag lines, preserves manual tags, and only replaces tags previously owned by automation.
6. A successful operation is not complete until disk, parsed frontmatter, durable assignment, and search-index readback agree. Fewer than three trustworthy active tags is `completed_sparse`, not failure. A retryable automatic failure preserves the body; an explicit tagging failure remains a delivery failure.
7. Ordinary document saves, external changes, and reindex completion deterministically reconcile frontmatter with assignments without an LLM or file rewrite. Manual deletion of an automatic tag is remembered and not restored on retry.
8. Settings exposes the automatic-tagging switch and pending review. File-emergence refresh neither invokes a model nor writes a file.

## Machine-verifiable data shapes

- `tag_lexicon_overlays`: user-approved additions/aliases/deprecations, keyed independently of bundled version.
- `tag_pending_proposals`: facet/label/evidence/status with bounded text; no document body.
- `file_tag_assignments`: `fileKey + tagId`, source and ownership, validation/write/readback timestamps, suppression state.
- `artifact_creation_receipts`: `sourceRunId`, stable file identity, created-in-run fact, final save hash/time, enrichment status and retry error.

## Verification gates

- `npm run verify:tag-forge`: parity, lint, policy/alias/quotas, pending/overlay, secure writer, CAS, idempotence, receipt eligibility, reconciliation, index readback, no-shell exposure.
- `npm run verify:file-emergence`, `npm run typecheck`, native SQLite tests, and a real Electron workflow with a fresh profile.
- Package/resource inspection proves the bundled skill and references are present.

## Closeout evidence

- Author source and bundled copy parity passed across five shared files; all relative links resolve, skill lint passes, `tf` and writable bundled-lexicon promises are absent.
- `npm run verify:tag-forge` passed: 60 focused behavior tests plus 20 real Electron/SQLite repository and end-to-end tool tests, zero skips or failures. Migration sequence 1–70 passed.
- `npm run verify:file-emergence` remained green: 74 behavior tests plus the same 20 native tests. Typecheck, native ABI check, production build, and ad-hoc signing passed.
- A fresh real Electron profile displayed the new “文档标签” settings section, enabled automatic-tag switch, and empty pending-review state.
- A newly built `exports/mac-arm64/Ready.app` contains `SKILL.md`, `ready-skill.json`, the machine policy lexicon, and all three reference files. After rebuilding dependencies from `package-lock.json`, the packaged app applied migration 070 and reached `main-window-ready-to-show` successfully.
- The first packaged attempt exposed a polluted dependency tree and failed at startup. `npm ci` repaired generated dependencies; the rebuilt package was the artifact accepted above. No source or lockfile change was made by that repair.
