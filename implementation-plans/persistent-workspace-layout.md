# Persistent AI-First Workspace

## Goal

Replace workspace presets with one persistent AI-first dock layout, make panels closable and recoverable from a Window menu, and remove share presentation modes and obsolete header links.

## Approach

- Keep Dockview as the layout source of truth and persist its serialized state per desktop/mobile mode.
- Centralize the user-facing panel definitions so web/native Window actions open or activate the same singleton panels.
- Convert Files into a Dockview panel so it shares the same move, resize, close, persistence, and Window-menu behavior as every other workspace tab.
- Simplify share routing to identify only the share id and ignore legacy mode parameters.

## Affected Areas

- Dock layout store and workspace startup
- Web and Tauri menus/event bridge
- Dock tab header and appearance settings
- Share dialog, routing, and share-entry state
- Focused unit/component/E2E coverage

## Checklist

- [x] Implement AI-first defaults and per-mode layout persistence/restoration
- [x] Add closable dock tabs and Window menu panel commands
- [x] Convert Files to a dock panel and remove its collapse/+ header controls
- [x] Remove preset selectors and obsolete header links
- [x] Remove share presentation modes while accepting legacy URLs
- [x] Update focused tests
- [x] Run targeted verification
- [x] Add a separated Window → Reset workspace command for web and desktop
- [x] Set the desktop default proportions to 20% Files, 40% AI, and 40% Preview
- [x] Place Customizer below Files with an equal 50/50 sidebar height split

