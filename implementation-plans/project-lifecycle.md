# Project lifecycle and AI conversation history

## Goal

Open directly into the editor, recover the last working workspace on web and desktop, and let users save and reopen portable projects with all AI conversations.

## Approach

1. Define the versioned archive and recovery snapshot. Verify source, editor state, and conversations round-trip.
2. Wire project commands and platform file access. Verify imported files preserve the current project and exports preserve source paths.
3. Connect AI conversation switching and checkpoint restoration. Verify prior conversations can continue against current source.
4. Verify startup and recovery, run targeted validation, and prepare the handoff.

## Affected Areas

- Shared project and workspace stores, ZIP codec, and platform file access
- Web and desktop bootstrap, File menus, and editor workspace
- AI panel, conversation history, and checkpoints

## Checklist

- [x] Archive codec, destination handling, and recovery
- [x] Direct editor startup and project/file commands
- [x] Project-scoped AI conversation history and checkpoint restoration
- [x] Targeted unit tests, TypeScript checks, lint, and Rust formatting
- [x] Chromium verification against the existing web server
- [ ] Native desktop relaunch and archive verification
- [ ] Draft PR and preview handoff

## Validation

- 161 targeted unit tests passed. Coverage includes archive validation and legacy imports, save cancellation and revision tracking, browser file handle reuse, AI conversation switching, and file-specific checkpoint restoration.
- Chromium covered direct startup, project replacement, source and folder import, recovery, portable save and reopen, and export. The round trip retained two AI conversations, an image, and a non-default render target.
- The web and shared UI type checks, changed-file ESLint checks, and formatting checks passed. Native desktop runtime verification requires an updated running Tauri app.
- The draft PR workflow is blocked because GitHub CLI is unavailable.
