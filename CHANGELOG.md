# Changelog

All notable changes to `@brainworker/tackback` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses [SemVer](https://semver.org/)
(pre-1.0: the public **JavaScript** API may still change before 1.0).

## [Unreleased]

## [0.9.1] — 2026-08-05
Multi-party rendering polish (a patch on the 0.9 Pane-thread work). All changes are generic library
mechanism — no domain meaning (who is "AI", what "approval" or "unread" mean) is baked into Tackback;
those stay with the integrator, supplied via options / read off the model.

### Added
- **`core.setAnchorAttention(commentId, on?)` + `core.hasAttention(commentId)`** — a generic, live
  ATTENTION flag on an anchor, driven by the integrator (emits `attention:change`). SESSION-only: never
  persisted, never written into the export envelope. The panel paints a flagged anchor with the new
  `--tb-attention` token (a generic "needs-notice" tint). Tackback attaches no meaning to the flag.
- **`attachPanel({ actorColors })`** (+ `panel.setActorColors(map)`) — an optional map from an author
  *category* (`author.kind`, an opaque string to Tackback) to a CSS color, e.g.
  `{ ai: '#2563eb', human: '#db2777' }`. An anchor is tinted by its **last speaker's** category using
  the injected map; with no map it falls back to a generic per-identity hue. No categories or colors
  are hard-coded in the library.
- Theme token **`--tb-attention`** (default orange, light/dark), overridable like any other token.

### Changed
- **Reduced `DEFAULT_REACTIONS`** to a focused three (👍 `agree` / 👎 `disagree` / ❓ `question`) —
  fewer icons read faster. Ids/labels stay generic sentiments; a review workflow assigns its own meaning
  by reading `comment.reaction`, or replaces the set via the `reactions` option. Unknown ids still render
  literally, so stored comments referencing removed ids are unaffected.
- **Flat Pane timeline** — comments and replies now render as individual, chronologically-ordered rows
  (no reply nesting/indent); each row carries its actor color + label so who-said-what stays legible.
- **Commit button disables** (greys out) while the Pane input is empty — no body text and no reaction —
  and re-enables the instant either is present.

### Compatibility
- No breaking API changes. `attachPanel` / `deriveBlockId` / resolution / `setTransport` /
  export-import are unchanged. Existing stored comments and exports round-trip as before.

## [0.9.0] — 2026-06-16
Initial public-prep release (staging). Standalone extraction of the Tackback library.

### Features
- **Anchored comments** on any rendered web content: **block** (whole element), **range** (text
  phrase via a W3C TextQuoteSelector), and **region** (a normalized rectangle over images, diagrams,
  inline SVG, or any non-text DOM content) — one consistent anchor model.
- **Region interaction**: right-drag to create (dashed preview → solid on save); move by dragging the
  anchor icon; resize via a hover-revealed top-left handle; non-intrusive overlays that never shift the
  host layout; an append-only move/resize history; right-click an anchor to delete it.
- **Document-region content-anchoring**: a region on the document is anchored to the content under its
  origin, so changes elsewhere on the page (e.g. an embedded PDF re-rendering at a different zoom) never
  move it.
- **Surface-bound regions are visually distinguished**: a region bound to a sub-surface (image / figure /
  `<canvas>` / PDF page — content with its own coordinate space) shows a double-frame border, vs a single
  line for a free document region.
- **Headless zero-dependency core** (state, anchors, events, import/export) + an optional **panel** UI
  (theming / reactions / i18n, EN+JA) + an optional **pdf** adapter (bring-your-own pdf.js).
- **Self-describing export**: a single JSON envelope (`schemaVersion`, document source + revision hash,
  reactions legend, comments, raster `surfaces[]` descriptors) — no backend, no network, fully offline.
- Distribution: npm subpath exports (`.`, `/panel`, `/pdf`) + a single UMD min file usable from one
  offline page with no build step; tree-shakeable ESM. A self-contained single demo (`demo/demo.html`).

### Notes
- Pre-1.0 staging: the API is functional and tested but may change before 1.0.
- **PDF / raster surfaces are post-v1**: v1 region surfaces are DOM-rendered content (images, figures,
  SVG, diagrams). The `pdf` adapter ships as an optional sample, not a v1 focus.
- Reply threads, connected-transport / AI-in-the-loop, and multi-author import/replay are present in
  the codebase but are post-v1 (the Interplay track) and not part of the v1 product surface.

### License
- [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0): free for any use
  including commercial, except to provide a product that competes with Tackback.

[Unreleased]: https://github.com/brainworker-org/tackback/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.0
