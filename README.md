# Tackback

**Anchored comments for any web page.** Attach a comment to a *place* — a block element, a selected
text phrase, or a rectangle drawn over an image, diagram, or other non-text content — persist it
locally, and **export it as JSON or hook it into a backend** (per comment or all at once). It works on
any HTML, including Markdown rendered to HTML.
**No backend required, no network, no runtime dependencies** — it runs from a single offline page.

**▶ Try the live demo: https://brainworker-org.github.io/tackback/** — right-click text to comment, right-drag over an image/diagram to comment a region, switch language/theme from the bottom-left bar.

> The hosted demo runs the **last published release** (it loads the package from a CDN), so it lags
> this branch during pre-1.0 staging. To exercise what is in the source right now — the flat
> multi-participant timeline, actor colors, attention, and the Save/Send scenarios — run
> `demo/demo.html`: `npm run build`, serve the package root over http, and open it.

> **Version 0.9.7 (staging).** Pre-1.0: the API is functional and tested but may still change before
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
const panel = attachPanel(tb, {
  theme: 'auto', locale: 'en',        // theming / reactions / i18n are all customizable
  controls: { docLane: true },        // pick which controls show; all but `import` are on by default
});

panel.destroy();                      // hands back everything it took, except the ids below
```

**One panel per document.** `attachPanel` writes state under a `tb-` namespace on the document root,
so attaching a second panel to the same document is not supported — call `destroy()` before
re-attaching. `destroy()` releases everything the panel took: its listeners on the document, window,
viewport and media queries, its observer, any queued repaint, any pointer capture an unfinished
gesture held, its nodes, its stylesheets, and the classes it put on your elements. It is idempotent,
and every method on the panel becomes a no-op afterwards.

One thing it deliberately leaves behind: the **ids** it assigned to elements that had none, and the
identity marks on region surfaces. Those are how a stored comment finds its place again — a comment
names its element by id, so removing those would orphan the anchors that depend on them. Everything else
it wrote onto your elements, including the `data-tb-anchor` and `data-tb-section` marks it uses to
find what is commentable, is restored to whatever was there before — unless you changed it
yourself while the panel was alive, in which case your value stays.

> **PDF is optional and not a focus.** A region surface can be *any* non-text content (image, `<canvas>`,
> SVG, diagram). A PDF page is just one such surface: an optional `@brainworker/tackback/pdf` adapter
> (bring your own pdf.js) is included as a small sample integration — see the post-v1 PDF preview block
> in `demo/demo.html`. The core and panel never depend on pdf.js.

> **Try it in a browser:** `demo/demo.html` is a single page that exercises the whole tool — a
> single-`<script>` UMD drop-in that renders as a live, commentable page (block/range/region over text,
> an inline SVG, an image, and a marked surface). Build the bundle (`npm run build`), serve the package
> root over http, and open it. The bottom-left bar is **not** part of Tackback — it drives the options
> an integrator passes in, one axis at a time (colour scheme, reaction set, language, which panel
> buttons show, and whether a transport is attached), so you can see what is customizable and what
> each one changes. The bottom-right panel lists comments and exports/imports JSON. The page
> also shows an optional **post-v1** PDF region preview (pdf.js from a CDN; degrades to a note offline).

## The four anchor types
- **block** — a whole element (heading / paragraph / list item / cell). Right-click it.
- **range** — a text phrase, stored as a W3C `TextQuoteSelector` (exact + prefix/suffix + offset).
  Re-resolves across edits/reflow; on drift it **fails loud** (`anchor:orphaned`) and never silently
  re-points. Painted via the CSS Custom Highlight API (no DOM mutation).
- **document** — the document *as a whole*, rather than any place inside it. It has no coordinates and
  no badge, because there is nowhere on the page that means "all of this". It lives in a **lane**: a bar
  across the bottom of the viewport with a composer you can type into without opening anything, which
  expands to show the thread (`controls: { docLane }`, on by default; `panel.toggleDocumentLane()`).
  The lane floats — it never shifts the host's layout. It sits beside the panel when there is room to
  do so and still be worth typing into, and moving above it and taking the available width — up to its own
  maximum — when there is not. Which of the two applies is measured, not guessed at a breakpoint. A host with its own bottom chrome tells the lane where it
  may sit with `--tb-lane-left` / `--tb-lane-right`, and can watch for the `tb-lane-stacked` class on
  the root element to move out of the way. With the lane off, `panel.openDocumentThread()` opens the
  same thread as an ordinary Pane. One per instance.
- **region** — a rectangle over any non-text surface (an image/diagram in a `<figure>`, a marked
  `[data-tb-surface]` element, or a PDF page), stored as a normalized rect, so it is
  **zoom-independent** (overlay = normalized × current surface size). The surface set is configurable
  via `attachPanel(core, { regionSurfaces })`; the drawn rectangle stays visible while you type.
  To re-resolve after a **reload**, the surface needs a stable identity — a `[data-tb-surface]` mark,
  a PDF page, or its own `id`; an unmarked, id-less surface is annotatable in-session only.

## Customization
Four independent axes, all on the default panel — every one of them a plain option, so an integrator
re-skins and re-labels Tackback without forking it or overriding its CSS:

- **Reactions** — replace the whole set. The built-in default is three plain sentiments (👍 `agree` /
  👎 `disagree` / ❓ `question`) with no domain meaning; yours can be any size, with your own ids,
  icons and per-locale labels. Comments store the **id**, so swapping icons never touches stored data.
- **Colors** — `--tb-*` theme tokens (a partial map layers over the OS light/dark base), plus
  `actorColors` for the participant tints.
- **Language** — `setLocale()` at runtime; English and Japanese ship, bring your own bundle.
- **Controls** — `controls: { author, export, import, theme, marks, clear, docLane }` chooses what
  renders; every one except `import` is on by default. `docLane` is the document thread's own bar
  across the bottom of the viewport, and doubles as its mark: the utterance count and the attention
  tint sit on its head, visible without expanding it.

Hiding a control does not hide the *data* behind it, but what remains reachable differs:

| control | with the button hidden |
|---|---|
| `theme` / `marks` / `docLane` | `panel.setTheme()` / `panel.toggleMarks()` / `panel.openDocumentThread()` (a Pane when the lane is off) |
| `author` | `core.setAuthor()` — the same state the field edits |
| `export` / `import` | `core.exportEnvelope()` / `core.importEnvelope()` — the data path; the paste-and-load *dialogs* are the panel's own and have no API form |
| `clear` | no equivalent. The button is more than a loop over `deleteComment`: it confirms first, closes an open Pane and drops an uncommitted region rect. Drive `core.deleteComment()` yourself and decide those for your UI. |

```js
const panel = attachPanel(tb, {
  reactions: [                                    // your set, not a variation of the default one
    { id: 'ship',    icon: '🚀', label: { en: 'Ship it', ja: '出そう' } },
    { id: 'rework',  icon: '🔁', label: { en: 'Rework',  ja: '要再考' } },
    { id: 'blocker', icon: '🛑', label: { en: 'Blocker', ja: '障害'  } },
  ],
  theme: { '--tb-accent': '#0f766e', '--tb-pin-bg': '#0f766e', '--tb-attention': '#b45309' },
  actorColors: { reviewer: '#0f766e', assistant: '#b45309' },
});
panel.setReactions(otherSet);      // …or swap any of them at runtime
panel.setTheme('auto');
panel.setActorColors(otherMap);
```

`demo/demo.html` flips all of these live from its bottom-left bar.

## Deleting
Deletion is an **anchor-level** act: right-click an anchor → *Delete anchor* removes that whole
conversation. The thread Pane offers no per-utterance delete — a reply belongs to its comment and goes
with it, so removing one row would silently take a whole side of the conversation away. The
programmatic seam (`deleteComment`) is unchanged for integrators that want their own rules.

## Many participants in one thread
A thread can hold utterances from several participants — people, and whatever else you wire into the
`addReply` seam. The panel renders them as **one flat, time-ordered timeline** (no reply indent tree):
every comment and reply is its own row, labelled and colored by who wrote it. An anchor badge counts
**every utterance** under it — comments and replies alike — so a thread that drew three answers reads
as busy from the page, without opening it. A thread that is **open** keeps up: an answer arriving
through `addReply` is appended to the Pane in place, without disturbing what you are typing.

Attach a transport descriptor and the Pane becomes a conversation rather than a note-taking box:

```js
tb.setTransport({ interactive: true });   // a DESCRIPTOR — Tackback never transports anything itself
// the commit button now reads "Send", the Pane stays open after a send with a pending marker, and
// your sent utterance appears in the timeline immediately. Answer it whenever your backend replies:
tb.on('comment:add', (c) => myBackend.send(c).then((answer) =>
  tb.addReply(c.id, { body: answer, author: { id: 'helper', kind: 'assistant' } })));
```

With no transport the button reads "Save" and the Pane closes on commit — the offline shape.

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

> Since 0.9.7 you no longer need attention to mean "unread" — Tackback tracks and paints that itself
> (below). Attention is back to being a flag with no meaning of its own.

### What this reader has not got to yet

Somewhere in the document there is something new, and a reader needs to see **where** — and needs the
mark to go away once they have read it. A mark that never clears says "everything", which is the same
as saying nothing.

```js
tb.unreadCount('block:intro');   // → how many utterances in that thread they have not seen
tb.unreadThreads();              // → [{ threadKey, count }] — only threads with something in them
tb.on('unread:change', ({ threads }) => {/* the whole picture, every time */});
```

The panel draws it for you: an anchor holding something unread gets a **ring** in `--tb-unread`, and
the document lane's count gets one when the document thread does. Attention fills, unread outlines —
an anchor that is both wears both, so neither can hide the other.

**New means new HERE.** Tackback numbers utterances in the order they reach this environment and never
looks at `createdAt`. An utterance written a year ago that reaches this reader now is new to them,
which is the only sense of "new" a reader can act on. Editing a body or receiving the same utterance
again is not an arrival; a reply is.

**Read means it was on screen.** A thread counts as read up to the newest utterance that was in an
open thread area — a Pane that is open, or the document lane expanded. That is a fact the library can
actually establish. What it deliberately does not claim:

- it is **not** "a person read it" — only that it was displayed;
- the viewport and your own CSS are not consulted, so a panel you have hidden still counts as showing;
- there is **no** screen-reader text or sound for unread in this version — the distinction is carried
  by colour *and* by shape (ring or no ring), and that is an accepted limit, not an oversight.

Both records belong to **this environment** — the browser profile, not the person and not the server.
They go through the storage adapter you already provide, and they are **never** in the export
envelope: what one reader has read is not part of a shared file.

Progress is a **second record** with its own pair of adapter methods. It is never folded into the
document write, and that separation is the guarantee — an instance that has only *read* cannot write
a comment, so it can never undo what another one wrote:

```js
const mine = {
  load: () => theDocument,          save: (doc) => { theDocument = doc; },
  loadProgress: () => theProgress,  saveProgress: (p) => { theProgress = p; },   // optional
};
```

Leave the progress pair out and unread simply is not durable — it lives as long as the instance and
starts fresh next time. That is the safe way to be incomplete; your comments are never at risk either
way. The built-in adapters implement both.

Two requirements come with progress: **one storage belongs to one environment** (sharing it between
viewers would make one person's reading everybody's), and **arrival numbering assumes one live
instance at a time** per environment. A `readOnly` mount calls `saveProgress` and never calls `save` —
`readOnly` means the document does not change, not that the reader leaves no trace.

### Which threads a reader can see

A flag like attention is only half of it: something has to decide when to *clear* it. That takes
knowing which threads are actually in front of the reader right now, and Tackback reports it as a
**settled snapshot** rather than as open/close edges you would have to keep balanced yourself:

```js
tb.on('thread:visibility', ({ visible, opened, closed }) => {
  // visible: [{ threadKey, anchor, comments: [id, …] }] — everything readable right now
  // opened / closed: the difference from the last report, computed for you
  //
  // Resolve read state from `visible`, not from `opened`. A thread the reader is watching while it
  // grows is reported with `opened` and `closed` both empty — that is the case an open/close pair
  // cannot express, and reading only `opened` walks straight past it.
  for (const t of visible) markRead(t.comments);
});

tb.visibleThreads();   // → the same array, answered on the spot
```

`comments` carries every utterance id in the thread, replies included — the ids you would resolve a
read cursor against. A thread the reader is *watching while it grows* is reported again when its
contents change, even though it never opened or closed: that is the case a plain open/close pair
cannot express, and the reason this is a snapshot.

Reports settle at the microtask boundary from a state that has finished moving, so several changes in
one turn arrive as one report, and nothing is ever announced while a Pane or the lane is still changing. A
thread with no identity yet — an uncommitted region — is simply **absent**, and appears once its first
commit gives it one.

Because it is a snapshot, **same-turn transients are coalesced away**: open a thread and close it
before the boundary and nothing is emitted. This reports settled visibility; it is not a lossless
interaction log. If you need to count impressions, count them from your own handlers.

The panel is what can see its own Panes and lane, so it is the panel that answers — attach one and the
reports begin; a core with no panel reports nothing and `visibleThreads()` is empty. If you show
threads some other way, you can answer instead of it (below).

If the display cannot be read at all, the core does not guess: no report is delivered and the last
state anyone actually observed stands, rather than a question about now being answered with something
from before. The two ways of asking say so differently, and each says it once:

- **A pull refuses.** `visibleThreads()` throws `TackbackError('ADAPTER_FAILED')` — you asked, so you
  are told directly. It emits nothing; the exception is the answer.
- **A scheduled report goes quiet, then hands the failure back.** The core looks again a few times on
  its own first, so a display that is unreadable for a moment and readable by the next look costs
  nobody anything. When those are spent, **one** `error` is emitted. It stays one for as long as the
  situation is one: later changes re-ask and find the same thing, and do not report it again. A
  successful look, or a different display, starts the count over.

```js
let readable;
try { readable = tb.visibleThreads(); }
catch { /* unknown right now — keep the last known and wait for the next report */ }
```

Recovery is the display's to signal. Every store mutation already asks for a fresh look, so an
integration that keeps writing recovers on its own; if nothing is being written, call
`tb.reportThreadVisibility()` when the display becomes readable again. The core cannot know when the
condition that made a display unreadable has passed.

**Answering it yourself.** The panel registers as a display; anything else that puts threads on screen
can do the same. The provider is asked at the moment an answer is needed and its return value is never
kept as truth, so it may be a plain projection of whatever is currently shown:

```js
const stopAnswering = tb.registerThreadVisibility(() => myOpenThreads.map((t) => ({
  threadKey: t.key,             // the thread's identity, as `visible` reports it
  anchor: t.anchor,             // where it points — a valid anchor, never null
  comments: t.utteranceIds,     // every utterance id the reader can see in it, replies included
})));

tb.reportThreadVisibility();    // "something moved" — the core decides whether that changed anything
stopAnswering();                // at teardown; withdrawing is itself a transition and is reported
```

Registering again **replaces** the previous display rather than joining it, matching the
one-panel-per-document rule above — the replaced one is never asked again, and its withdrawal function
becomes a no-op. Throwing from the provider, or returning an entry whose anchor is missing or of a kind
this build does not know, is treated as a failed look, not as a partial one: nothing is published from
an answer the core could only half use.

**What "readable" does and does not mean.** It means a Pane is on screen showing that thread, or the
document lane is expanded — library state, reported as a settled fact. It does **not** mean a person
looked, and it does not account for the viewport or for host CSS: a panel hidden by your own styles is
still reported as readable. If you use this to mean "read", that gap is yours to decide about. Tearing the panel down is
itself a transition: you are told the thread is no longer readable, which is exactly when a consumer
that raised its update rate needs to hear it.

### Deleting as one act, and a merge that can remove

```js
tb.deleteComments([id1, id2]);   // one act → one `comments:delete`, plus the usual per-comment ones
tb.importEnvelope({ /* … */ comments: [], deleted: [id] }, { mode: 'merge' });
```

Deleting a whole anchor is **one operation**, and now says so. The act commits once and then
narrates: `change` → one `comment:delete` per comment → `comments:delete`. Each `comment:delete`
carries `{ id, previous }` as it always has; the act carries `{ ids, previous }`, with `ids[i]`
describing `previous[i]`.

Because it is atomic, a `comment:delete` handler now sees the collection **after the whole act**, not
midway through it, and the store is persisted once rather than once per comment. An existing
`comment:delete` subscription still gets exactly one event per removed comment. The panel's *delete
anchor* and *clear all* previously looped `deleteComment`, so from a run of N indistinguishable
events you could not tell where one act ended.

A `merge` used to only ever **add**, so an integrator polling a server resurrected everything the
server had deleted on the next sync. An incoming envelope can now say what is gone, and merge honours
it. The client keeps **no tombstones**: the party that knows about a deletion is the one that recorded
it, and a list that only grows is not something to make every mounted instance carry.

A JSON-string envelope carries `deleted` exactly as an object one does.

**If an id appears in both `comments` and `deleted`, the tombstone wins** — in either mode. A
producer emits one envelope, so its meaning must not depend on which mode the reader passes, and the
only way the two arrays realistically disagree is a torn read of an append-only log (the comments
projected, a deletion lands, the tombstones projected), where the tombstone is the fresher fact. A
buried id is therefore never taken in: it is not added, not updated, and contributes to none of the
ingestion counts (`added`, `updated`, `skipped`, `conflicts`). If the
store already held it, it goes — but **how that removal is reported depends on the mode**. Under
`merge` the tombstone does the removing, so it arrives on the ordinary deletion seam:
`comment:delete`, `comments:delete`, and a `deleted` count. Under `replace` the wipe has already
removed it before tombstones are examined, so there are no per-comment deletion events and `deleted`
is `0`; the removal appears only in the aggregate `removed` of the `change`.

`importEnvelope` returns how many tombstones it applied as `deleted`. Under `replace` this is `0`
even when tombstones were honoured — the wipe already accounts for everything the incoming set
omits, so there is nothing left for a tombstone to take.

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
npm test     # node --test — the full suite, zero external deps
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
  against the current document — callers are responsible for matching. This bites hardest on the
  **document** anchor: block/range/region anchors from a foreign envelope fail visibly (they do not
  resolve, so they orphan), but a document anchor always resolves, so a foreign document thread merges
  into this one with no signal at all. A `replace` import whose records cannot be placed is refused
  (throws `IMPORT_INVALID`) unless `allowPartial: true`, so a malformed file can't silently wipe
  existing comments.
- **An import may not change which utterance is which.** Every utterance needs a non-empty id, unique
  across the document, and stays in the thread it was written into. An entry that breaks either — an
  id-less reply, an id already in use, a known utterance carried to another anchor, or one the same
  envelope also buries — is dropped, and an `IMPORT_ENTRY_DROPPED` error names it. A **merge** drops
  the entry and keeps going, because a polling integration would otherwise stop synchronising on the
  first bad row. A **replace** is refused whole (`IMPORT_REPLACE_REJECTED`, document untouched),
  because taking the good half of a complete-state declaration composes a document neither side asked
  for; `allowPartial` does not override this. The one way to move an utterance is to bury the old id
  and create a new one at the new anchor — both in the same envelope is fine.
  A stored document coming back from your adapter is checked the same way.
- **An older build ignores unread rather than corrupting it.** Progress lives in its own record, which
  0.9.6 neither reads nor writes, so the stored document round-trips through it untouched. What an
  older build cannot do is *advance* anything: come back to 0.9.7 and the progress is exactly as it
  was when you left, while whatever arrived meanwhile reads as new.
- **A failed save is not retried on its own.** It is reported, memory keeps what it knows, and the
  next save carries everything again. If nothing further changes and nothing further is read, that
  last state is not written.
- **`ready` resolves, never rejects.** Initialization/adapter failures surface on the `error` event
  (fail-soft); don't treat `await ready` as an all-adapters-mounted signal.
