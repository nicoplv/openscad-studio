# Position-based viewer comments

## Goal

Attach instructions at OpenSCAD model coordinates from either preview to the AI draft, without creating images or sending a request automatically.

## Approach

- Add Comment immediately after Annotate, including compact toolbars.
- Share a temporary pin/form session; pick model surfaces in 3D and drawing-plane points in 2D.
- Capture unrounded OpenSCAD coordinates, unit label, and displayed render identity at placement.
- Keep comments as typed draft/message objects and serialize them as labeled text JSON for providers.
- Reuse AI setup/busy handling; remove the temporary pin only after successful attachment.
- Preserve existing image attachment behavior, conversation lifetime, and editing tools.

## Affected Areas

Preview tool registries/interactions, shared comment UI, workspace wiring, AI draft/message types, provider serialization, composer/transcript rendering, targeted tests.

## Checklist

- [x] Add comment types, coordinate helpers, and shared form/session.
- [x] Integrate comments into draft actions, submission, provider messages, and transcript/composer.
- [x] Wire displayed render identity and attachment handling through the workspace.
- [x] Integrate 2D/3D picking, toolbars, navigation, reset behavior, and analytics.
- [x] Add and run focused regression tests and TypeScript checks for both entry points.
- [ ] Inspect the existing running app in narrow/wide layouts and light/dark themes when available.

## Validation

Use focused Jest coverage for coordinates/picking, comment form/session, and AI submission/lifecycle. Run UI and web TypeScript checks and checks on changed files only. Do not start or stop servers or run production builds.

Completed checks:

- Focused Jest checks passed for viewer comments, SVG interactions, 3D tool registration/analytics, AI composer/transcript, AI agent submission/retry/cancellation, and provider serialization (six test files).
- `pnpm --filter ui type-check` and `pnpm --filter web exec tsc --noEmit` passed.
- ESLint passed for all changed TypeScript files; formatting and whitespace checked only for changed files.
- Pin projection follows the captured model position when preview dimensions change; the form stays within narrow preview bounds.

Manual visual verification is pending: the browser access host was unavailable, and computer access to Google Chrome was not approved. No servers or production builds were started. Full test suites and browser E2E were not run, following the requested focused validation scope.
