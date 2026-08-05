# Tackback

**Anchored comments for any web page.** Attach a comment to a *place* — a block element, a selected
text phrase, or a rectangle drawn over an image, diagram, or other non-text content — persist it
locally, and **export it as JSON or hook it into a backend** (per comment or all at once). It works on
any HTML, including Markdown rendered to HTML.
**No backend required, no network, no runtime dependencies** — it runs from a single offline page.

**▶ Try the live demo: https://brainworker-org.github.io/tackback/** — right-click text to comment, right-drag over an image/diagram to comment a region, switch language/theme from the bottom-left bar.

> **Version 0.9.1 (staging).** Pre-1.0: the API is functional and tested but may still change before
> the 1.0 stable release. The public API is the **JavaScript** API called in the browser (not an HTTP API).

## Install

```sh
npm install @brainworker/tackback
```

Or drop in the pre-built UMD bundle (exposes a global `Tackback`, no build step):

```html
<script src="https://unpkg.com/@brainworker/tackback/dist/tackback.umd.js"></script>
```

## Quick taste

**Headless core** — state, anchors, events, import/export, no DOM:
```js
import { Tackback } from '@brainworker/tackback';

const tb = Tackback.mount({ document: { id: 'my-doc', title: 'Design notes' } });
tb.on('change', ({ comments, changes, source }) => {/* one seam to sync elsewhere; source ∈ local|import|storage */});

const c = tb.addComment({ anchor: { type: 'block', elementId: 'para-3' }, body: 'unclear', reaction: 'question' });
tb.updateComment(c.id, { body: 'still unclear after the edit' });
const envelope = tb.exportEnvelope();            // → portable JSON (the seam)
tb.importEnvelope(envelope, { mode: 'merge' });  // also accepts older exports (auto-migrated)
```

**With the default UI** — right-click a block, or select text + right-click to pin a phrase:
```js
import { Tackback } from '@brainworker/tackback';
import { attachPanel } from '@brainworker/tackback/panel';

const tb = Tackback.mount({ document: { id: 'my-doc', title: 'Design notes' } });
attachPanel(tb, {
  theme: 'auto', locale: 'en',        // theming / reactions / i18n are all customizable
  controls: { theme: true },          // pick which panel buttons show; the theme switch is hidden by default
});
```

> **PDF is optional and not a focus.** A region surface can be *any* non-text content (image, `<canvas>`,
> SVG, diagram). A PDF page is just one such surface: an optional `@brainworker/tackback/pdf` adapter
> (bring your own pdf.js) is included as a small sample integration — see the post-v1 PDF preview block
> in `demo/demo.html`. The core and panel never depend on pdf.js.

> **Try it in a browser:** `demo/demo.html` is a single page that exercises the whole tool — a
> single-`<script>` UMD drop-in that renders as a live, commentable page (block/range/region over text,
> an inline SVG, an image, and a marked surface). Build the bundle (`npm run build`), serve the package
> root over http, and open it. The bottom-left "Try it" bar flips locale, swaps the reaction set, and
> toggles the theme switch; the bottom-right panel lists comments and exports/imports JSON. The page
> also shows an optional **post-v1** PDF region preview (pdf.js from a CDN; degrades to a note offline).

## The three anchor types
- **block** — a whole element (heading / paragraph / list item / cell). Right-click it.
- **range** — a text phrase, stored as a W3C `TextQuoteSelector` (exact + prefix/suffix + offset).
  Re-resolves across edits/reflow; on drift it **fails loud** (`anchor:orphaned`) and never silently
  re-points. Painted via the CSS Custom Highlight API (no DOM mutation).
- **region** — a rectangle over any non-text surface (an image/diagram in a `<figure>`, a marked
  `[data-tb-surface]` element, or a PDF page), stored as a normalized rect, so it is
  **zoom-independent** (overlay = normalized × current surface size). The surface set is configurable
  via `attachPanel(core, { regionSurfaces })`; the drawn rectangle stays visible while you type.
  To re-resolve after a **reload**, the surface needs a stable identity — a `[data-tb-surface]` mark,
  a PDF page, or its own `id`; an unmarked, id-less surface is annotatable in-session only.

## Customization
Three independent axes, all on the default panel:
- **Theming** — `--tb-*` CSS variables; `theme: 'auto'` follows the OS light/dark preference live.
- **Reactions** — a fully replaceable set of `{ id, icon, label }` (per-locale labels). The default set is
  three plain sentiments (👍 `agree` / 👎 `disagree` / ❓ `question`) with no domain meaning attached.
- **Language** — `setLocale()` at runtime; English and Japanese ship, bring your own bundle.
- **Panel controls** — `controls: { author, export, theme, marks, clear }` chooses which buttons
  render. The theme switch is hidden by default (`auto` already follows the OS).

## Many participants in one thread
A thread can hold utterances from several participants — people, and whatever else you wire into the
`addReply` seam. The panel renders them as **one flat, time-ordered timeline** (no reply indent tree):
every comment and reply is its own row, labelled and colored by who wrote it.

Tackback assigns **no meaning** to who a participant is. It reads an opaque `kind` off the author and
looks it up in a map *you* supply — it ships no categories and no colors of its own:

```js
attachPanel(tb, {
  actorColors: { assistant: '#2563eb', reviewer: '#db2777' },   // your categories, your colors
});
// an anchor is tinted by its LAST speaker's category; unmapped authors get a generic per-identity
// hue, always distinct from the colors you mapped. Change the map live:
panel.setActorColors({ assistant: '#7c3aed', reviewer: '#059669' });

const tb = Tackback.mount({ author: { id: 'kei', kind: 'reviewer' } });   // kind is yours to define
tb.addReply(commentId, { body: 'here is my read', author: { id: 'helper', kind: 'assistant' } });
```

**Attention** is the same shape — a generic "this anchor wants a look" flag whose meaning is yours
(unread, needs-review, whatever you track):

```js
tb.setAnchorAttention(commentId);          // paints the anchor with --tb-attention (orange by default)
tb.setAnchorAttention(commentId, false);   // back to its normal actor tint
tb.hasAttention(commentId);                // → boolean
tb.on('attention:change', ({ id, on }) => {/* … */});
```

The flag is **session-only**: never persisted, never written into the export envelope, so a per-viewer
UI state can't leak into a shared file. It lives as long as its comment — deleting or wiping the comment
drops it, and re-importing that comment id starts unflagged. Restyle it via the `--tb-attention` token.

## Modules
| import | responsibility |
|---|---|
| `@brainworker/tackback` | `Tackback.mount` → instance: CRUD, replies, typed events, import/export, media-adapter coordination, lifecycle, `anchor:orphaned`, session-only anchor attention |
| `@brainworker/tackback/panel` | `attachPanel` — control panel (configurable via `controls`), anchored marks, comment popup with the flat multi-participant timeline, gesture capture (right-click block, select+right-click range, right-drag region), theming/reactions/actor colors/i18n |
| `@brainworker/tackback/pdf` | `createPdfAdapter` — an **optional** PDF adapter (renders pages to surfaces; pdf.js is a peer the consumer provides). PDF/raster surfaces are a post-v1 sample, not a v1 focus. |

The two real entry points are the **core** and the **panel**; the **pdf** adapter is optional. Everything a typical integrator needs — the storage adapters (`localStorageAdapter` / `memoryAdapter`), the envelope helpers (`buildEnvelope` / `parseEnvelope`), and the model/migration helpers — is **re-exported from the main `@brainworker/tackback`** entry, so there are no separate `/anchor`, `/model`, or `/storage` subpaths to learn.

Type declarations (`.d.ts`, generated from JSDoc) ship with the package.

## Tests
```sh
npm test     # node --test — 164 tests, zero external deps
```
`node:test` + `node:assert` are built into Node ≥ 18 — no install needed, matching the library's
runtime zero-dependency ethos. DOM/PDF rendering is verified in the browser via the single bundled
demo (`demo/demo.html`): run `npm run build`, serve the package root over http, and open it. (Append
`?raf-shim` when verifying in a headless/background tab so pdf.js can finish rendering.)

## License
[PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0) (see [LICENSE](./LICENSE)).

Use it for **any purpose, including commercially** — **except** to provide a product or service that **competes** with Tackback (or with a product Brainworker provides using Tackback). For a competing use, or anything the license doesn't allow, contact **contact@brainworker.org**.

PDF support uses [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) but **does not bundle it** —
you inject your own pdf.js into `createPdfAdapter`, so nothing of pdf.js is redistributed here.

## Caveats
- **One instance per document.** A single `Tackback` instance + panel per document is the supported
  shape; multiple panels in one document share the `tb-range` CSS highlight registration and would interfere.
- **`importEnvelope` is not document-bound.** It does not check the envelope's `document.id`/revision
  against the current document — callers are responsible for matching. A partially-invalid `replace`
  import is refused (throws `IMPORT_INVALID`) unless `allowPartial: true`, so a malformed file can't
  silently wipe existing comments.
- **`ready` resolves, never rejects.** Initialization/adapter failures surface on the `error` event
  (fail-soft); don't treat `await ready` as an all-adapters-mounted signal.
