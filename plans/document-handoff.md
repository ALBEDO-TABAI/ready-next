# ready-cowork Project Handoff

> Refresh auto-generated sections with `$project-handoff-sync`.

## Project Goal
- Keep Document mode as a reliable authoring and review surface inside Ready, with:
- semantic preview for metadata-heavy notes
- stable local editing for Markdown/docx-derived content
- agent-assisted document editing that can target the original file precisely instead of creating detached drafts
- portable project handoff material that another Codex instance or platform can use to continue implementation with minimal re-discovery

## Current Scope
- document mode
- agent document editing
- portable handoff for another agent or platform
- document quote references inside chat
- preview ergonomics for metadata, tags, local media, and embedded YouTube

## Constraints And Invariants
- Document mode must keep the existing split model: `edit` and `preview` are view states on the same tab, not separate sessions.
- The editor path is renderer-local for interactive editing, but real file persistence still goes through `window.electronAPI.document.writeFile`.
- Binary formats remain segregated:
- PDF uses `PdfViewer`
- images/videos use `FilePreview`
- spreadsheets use `UniverSheet`
- text/docx-derived content uses `MarkdownEditor`
- Preview enhancement must not require new Main / Preload IPC unless absolutely necessary.
- YouTube embed support is constrained by renderer CSP; current implementation explicitly allows `youtube.com` and `youtube-nocookie.com` frames in `src/renderer/index.html`.
- Document quote references must not keep polluting later chat turns:
- `document-quote` attachments are transient input context
- they must not linger in `filePool`
- they should be removed from current input context after send
- Agent-side “real edit” flows should prefer targeted document mutation tools over whole-file overwrite when the user provides precise source text or a quoted span.

## Recent Implemented Work
- Replaced the old Markdown preview string-regex renderer with a structured note preview pipeline:
- YAML frontmatter support
- top-of-file semi-structured metadata extraction
- tags / related chips
- section heading promotion for `About` / `Description`-style blocks
- local image and Obsidian-style local video embeds
- embedded YouTube player with metadata card treatment
- Hardened preview parsing:
- malformed frontmatter now falls back to loose parsing instead of collapsing into a noisy “parse failed” experience
- fixed YouTube iframe layout so the player respects the 16:9 container
- Improved document editing ergonomics:
- normalized markdown round-trip syncing in `TiptapEditor`
- removed placeholder text leaking into newly created empty paragraphs
- Added document quote workflow into chat:
- right-click “引用到输入框”
- quote attachments rendered as IDE-like chips
- hover summary includes section / lines / excerpt
- click jumps back into Document mode and reveals the quoted source with a temporary highlight
- Added precise agent editing toolchain:
- `document_replace_exact`
- occurrence-aware exact replacement in renderer-side document actions
- direct-chat guidance updated so the model prefers exact replacement when the user provides explicit quoted source text
- Created reusable skill `$project-handoff-sync` in `~/.codex/skills/project-handoff-sync` to generate/update portable handoff markdown files from repo docs and recent plan files.

## Next Steps
- Add a renderer-level interaction test for document quote references:
- create a quote attachment
- verify chip metadata renders
- verify click switches to Document mode and sets reveal state
- Add a regression test for editor reveal behavior:
- selection-based reveal
- line-based fallback reveal
- Evaluate whether document quote chips should expose a compact inline action menu:
- copy source text
- open file in system
- remove quote
- Improve `document_replace_exact` follow-up ergonomics:
- let the agent prefer exact replacement automatically when a `document-quote` attachment is present
- include better failure summaries when the quoted source no longer matches the current file
- Expand semantic preview parsing to more note conventions if needed:
- `source`, `author`, `series`, `season`, `episode`, `status`
- Consider preserving a faint residual highlight after reveal instead of removing all visual context after the initial flash.

## Acceptance Notes
- Another Codex instance should be able to read only this handoff plus the listed source docs and understand:
- what Document mode now supports
- how quote references flow into chat and back into source documents
- how precise editing differs from whole-file overwrite
- Running `npm run typecheck` must stay clean after document-mode changes.
- Existing parser tests must stay green:
- `src/__tests__/note-preview-parser.test.ts`
- `src/__tests__/document-actions-precise-edit.test.ts`
- Manual sanity checks for future document work should include:
- right-click quote -> chip appears with section / line metadata
- send quote-only message -> quote is consumed and does not remain in current input context
- click quote chip in chat -> matching doc opens and highlighted source is revealed
- exact-replace flow updates the original file/tab instead of creating a detached draft

<!-- BEGIN AUTO-GENERATED:PROJECT_META -->
## Auto Metadata
- Project root: `/Users/user/Documents/ready-cowork`
- Output file: `/Users/user/Documents/ready-cowork/plans/document-handoff.md`
- Refreshed at: 2026-03-15 14:11
- Focus:
- document mode
- agent document editing
- portable handoff for another agent or platform
<!-- END AUTO-GENERATED:PROJECT_META -->

<!-- BEGIN AUTO-GENERATED:SOURCE_INVENTORY -->
## Source Inventory
- `AGENTS.md` (updated 2026-03-14 22:43)
- `PROJECT_OVERVIEW.md` (updated 2026-03-15 11:13)
- `DOCUMENTATION.md` (updated 2026-03-15 11:13)
- `LESSONS_LEARNED.md` (updated 2026-03-15 11:13)
- `PROGRESS.md` (updated 2026-03-15 11:13)
- `FEATURE_MODULE_MAP.md` (updated 2026-03-08 18:40)
- `DEPENDENCY_MAP.md` (updated 2026-03-08 18:40)
- `PROJECT_STRUCTURE_SNAPSHOT.md` (updated 2026-03-08 18:40)
- `CHANGELOG.md` (updated 2026-03-15 13:36)
<!-- END AUTO-GENERATED:SOURCE_INVENTORY -->

<!-- BEGIN AUTO-GENERATED:RECENT_PLANS -->
## Recent Plans
- `plans/2026-03-15-ui-recent-changes.md` (updated 2026-03-15 12:33)
- `plans/2026-03-15-document-mode-improvements-and-plan.md` (updated 2026-03-15 12:33)
<!-- END AUTO-GENERATED:RECENT_PLANS -->
