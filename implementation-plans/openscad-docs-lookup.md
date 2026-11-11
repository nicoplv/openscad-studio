# Offline OpenSCAD documentation lookup

## Goal

Give the web and desktop copilot on-demand access to concise OpenSCAD signatures and examples through its existing tool registry. Keep common syntax and Studio-specific workflow guidance in the system prompt.

## Approach

- Bundle 24 sourced entries in `apps/ui/src/services/openscadDocs.json`.
- Add deterministic local lookup to `apps/ui/src/services/aiService.ts` and reduce the quick reference in its system prompt.
- Verify tool results in `apps/ui/src/services/__tests__/aiService.test.ts` and compare model behavior if a configured provider is available.

## Checklist

- [x] Add the documentation entries and source links.
- [x] Register the tool and shorten the system prompt.
- [x] Add and run focused tests and the UI type check.
- [x] Check model availability and record the comparison outcome.

All 33 AI service tests and the UI type check passed. The bundled reference contains 24 entries, and the prompt's quick reference went from 1,023 to 261 characters. The local Studio browser session showed no configured AI provider, so the live prompt comparison was skipped.
