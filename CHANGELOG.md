# Change Log

## [0.1.0] — 2026-06-25

First public release.

### Features
- **Relation Graph** (bottom panel, Source Insight style): place the cursor on a
  C function and see its callers (right) and callees (left) in one bidirectional
  tree that follows the cursor.
- **Variables mode**: place the cursor on a global/static variable or `#define`
  macro to see which functions reference it.
- Lazy, arbitrarily deep expansion (click ▸/◂).
- Node labels show the call-site line; double-click jumps to it.
- Drag to pan, scroll to zoom.
- **D3 force-directed graph** (right-click → *Show Call Graph*) for a global view.
- **Automatic + incremental indexing** of `.c`/`.h` files (re-indexes only
  changed files on save).
- Handles `static` functions, `extern "C"` blocks, function-pointer/callback
  registrations, and cross-file call resolution by name.
- **Zero native dependencies**: parsing via web-tree-sitter, storage via sql.js
  (pure WebAssembly). One `.vsix` runs on every platform and VS Code version.
