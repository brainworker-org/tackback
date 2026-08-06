# Changelog

All notable changes to `@brainworker/tackback` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses [SemVer](https://semver.org/)
(pre-1.0: the public **JavaScript** API may still change before 1.0).

## [Unreleased]

## [0.9.6] — 2026-08-06
Two seams an integrator asked for, so it can stop reaching into the library's DOM and stop losing
deletions. Mechanism only, as ever: the library reports what happened and attaches no meaning to it.

### Added
- **`thread:open` / `thread:close`** — a thread's surface became visible, or went away. Payload:
  `{ threadKey, anchor, comments }`. Both surfaces report: an anchored thread opening as a Pane, and
  the document thread when its lane is expanded. They are `thread:*` and not `popup:*` on purpose —
  a thread has more than one surface now, and naming the event after the popup would leave exactly
  one thread invisible to anything watching. Whether opening a thread means it has been *read* is the
  integrator's to decide; the library only says it was shown. The lane's composer being on screen is
  not the thread being open — expanding is. A surface is reported once its thread can be **addressed**:
  `anchor` is always present and `threadKey` is never null. A place is addressable before anyone has
  spoken there, so a Pane over an untouched block opens with `comments: []`; a freshly drawn region,
  whose identity *is* its first comment, is a draft until that comment commits, and an abandoned one
  reports nothing at all. Both events fire once the surface has settled, so a handler may reply into
  the thread, open another from a close, or destroy the panel; a reply sent synchronously from
  `thread:open` settles the send it answers, as one from `comment:add` already did.
- **`core.deleteComments(ids)`** — deleting a whole anchor, or clearing a document, is one act.
  Each comment still emits its own `comment:delete`, so nothing listening today changes, but the
  operation emits **`comments:delete`** once and commits once. From N indistinguishable events an
  integrator could not tell where one act ended.
- **`importEnvelope` honours a `deleted[]` array in the incoming envelope.** A `merge` only ever
  added, so an integrator polling a server resurrected everything the server had deleted on the next
  sync. The envelope can now say what is gone. The client keeps **no tombstones** — the party that
  knows about a deletion is the one that recorded it, and a list that only grows is not something to
  make every mounted instance carry. Removals are reported on the same seam as any other deletion —
  the same `{ id, previous }` payload, with `ids[i]` describing `previous[i]` — and `importEnvelope`
  returns how many it applied. It is honoured in **`merge` only**: a `replace` already states the whole
  set, so a tombstone there could only restate it. Envelopes given as a JSON string carry `deleted`
  exactly as object ones do.

### Compatibility
Additive. An envelope without `deleted` behaves exactly as before, `deleteComment` is unchanged, and
every existing event fires as it did.


## [0.9.5] — 2026-08-06
Hands-on corrections, from using 0.9.4 rather than reviewing it.

### Fixed
- **The lane's composer no longer carries a resize grip.** A bar fixed to the bottom of the viewport
  has just measured its own place there; a corner the reader can drag is an invitation to fight that.

### Docs / demo
- The hosted demo loads **0.9.4**, so the lane is finally visible there — it had been pinned at 0.9.2.
- The demo's Japanese reaction labels read like a dictionary rather than like a person: *Ship it* was
  「出そう」, *Idea* 「案」, *Cut* 「削る」, *Blocker* 「障害」. They are now 「OK!!」「アイデア」「カット」
  「ブロッカー」.
- Two descriptions corrected: the stacked lane takes the *available* width, not the full width (it
  keeps its maximum), and the placement decision does not compare the two candidate widths.

### Note on 0.9.4
The package published to npm as 0.9.4 was built from tag `v0.9.4` **plus** the resize fix above,
which arrived minutes after the tag was cut. The published artifact is slightly ahead of its tag
rather than behind it. 0.9.5 restores the invariant that a tag marks exactly the tree npm received —
vendor 0.9.5, not 0.9.4, where byte-identity to a tag matters.


## [0.9.4] — 2026-08-06

### Added
- **The document lane** — the conversation about the document as a whole now lives in a bar across the
  bottom of the viewport (`controls: { docLane }`, on by default). Its composer is there whether or not
  the thread is expanded, so you can say something without opening anything; expanding adds the history
  above it. It is about no particular place, so it has no mark to hang on: the lane doubles as its mark,
  carrying the utterance count and the attention tint on its head, which is a real button and announces
  whether it is expanded. It **floats** — the library still never shifts the host's layout — sitting
  beside the panel when that leaves a lane worth typing into and moving above it and taking the available width, up to its own maximum,
  when it does not — measured rather than guessed at a breakpoint. A host with its own bottom chrome declares
  it with `--tb-lane-left` / `--tb-lane-right` and can watch for `tb-lane-stacked` on the root element.
  `env(safe-area-inset-bottom)` and the visual viewport keep it clear of a home indicator and above a
  software keyboard.
- Because a host that never dies has no death to hide behind, three things the popup relied on are now
  explicit: committing **always** resets the composer and dismissal is the host's own decision;
  reconciliation **removes** rows for utterances that left the thread, not only adds new ones; and every
  conversation on screen — not just an open popup — follows a transport change, a locale change and a
  new participant colour map.
- **`panel.toggleDocumentLane(force?)`** — expand or collapse it; returns the resulting state.
- **`transport:change`** — `setTransport` now announces a real change of descriptor. A UI that decides
  "Save or Send" when it opens went stale the moment the descriptor moved; an open Pane re-derives, so
  both the button and close-vs-stay-open follow. Equality is by descriptor *field*, so re-setting the
  same descriptor — in any property order — stays quiet. The core still transports nothing.

### Changed
- **`controls.docThread` is replaced by `controls.docLane`.** 0.9.3 reached the document thread from a
  button in the panel; hands-on use said it belongs at the bottom of the screen instead, so the button
  is gone rather than duplicated. `panel.openDocumentThread()` remains, and opens the thread as an
  ordinary Pane when the lane is switched off. A 0.9.3 integrator passing `docThread: false` now
  silently has no effect — pass `docLane: false`. The label key `panel.docThread` is likewise
  `panel.docLane`.
- Tackback's own chrome is now excluded from region anchoring: a right-press starting on the lane (or
  the panel, or a popup) begins no gesture, and a document region no longer anchors itself to the
  chrome its top-left corner happens to land on.

### Fixed
- **`popup.send` / `popup.pending` were in neither label bundle.** They reached the screen through
  literal fallbacks, so a Japanese reader saw "Send" and "sent — awaiting reply…" in English from the
  moment the transport seam shipped.

### Internal
- The conversation — timeline rows, input, reactions, commit button, send/pending state machine, and
  the reconciliation that keeps an open thread current — moved out of the popup's closure into a
  factory the popup merely hosts. A thread is not a popup, and a second surface is coming. No
  behaviour change; the suite passed unchanged, which is the signal that refactor is meant to give.

### Demo
- Both demo pages present the bottom-left bar as **the customization axes an integrator drives**,
  rather than a pile of toggles: colours, reactions, language, which panel controls show, and whether
  a transport is attached.
- **Colour is one axis.** It read as two — one control changed colours, the other changed whether the
  theme *button* was shown. Panel tokens and participant colours now move together; the button's
  visibility belongs to the axis about which controls show.
- **"Simulate a reply" is gone.** With the scenario toggle carrying Save vs Send, the simulated
  participant already answers every send; the button only did anything in local mode, where a reply
  implies the backend that local mode is defined as not having.

## [0.9.3] — 2026-08-06
The second Interaction shape: a conversation about the **document as a whole**, alongside the
per-anchor threads that were already there. Still mechanism only — the library supplies the thread
and the hook, never a server and never a meaning.

### Added
- **A fourth anchor kind, `document`.** A comment anchored to `{ type: 'document' }` is about the
  whole document rather than a place inside it. It reuses everything the anchored threads use: the
  flat multi-participant timeline, actor colors, reactions, the attention flag, the transport seam
  (Save vs Send, the pending marker, live arrival of replies), export/import.
  Its *place* is the document surface, so it takes part in the ordinary resolve/orphan lifecycle
  rather than needing an exception carved out of it.
- **`controls: { docThread }`** (default **on**) — the panel control that opens it. Every other
  thread advertises itself with a badge on the thing it is about; this one has nowhere on the page to
  sit, so the control is its mark: it shows the same utterance count and wears the same attention
  tint. New label keys `panel.docThread` / `anchor.document` (EN + JA).
- **`panel.openDocumentThread()`** — the same action on the PanelInstance, so hiding the control
  never removes the capability.

### Fixed
- **Anchor dispatch no longer guesses.** An anchor kind a build did not recognise used to borrow
  another kind's handling: `resolveAnchorDom` fell through to the region path (resolving against
  `surfaces.get(undefined)`, failing, and getting **stamped as orphaned**), `threadKeyOf` produced
  `block:undefined` so every such comment collapsed into one imaginary shared thread, and
  `anchorLabelOf` rendered `📍 undefined`. Each now returns nothing for a kind it does not know.

### Compatibility
- Additive: `schemaVersion` is unchanged, because nothing reads it — the envelope's anchor field is a
  union and this adds a member.
- **Older consumers drop document comments on import.** 0.9.2 and earlier reject
  `anchor.type:'document'` as invalid: a `merge` import silently skips them (counted in the returned
  `dropped`), a `replace` import throws `IMPORT_INVALID` unless `allowPartial: true`. A 0.9.2 build
  reading 0.9.3 *storage* will also stamp them as orphaned; returning to 0.9.3 clears that stamp.

### Known limitation
- **`importEnvelope` is still not document-bound**, and a document anchor cannot fail to resolve — so
  importing an envelope from a *different* document merges its document thread into this one silently,
  where a block/range/region anchor would have orphaned visibly. Match the document yourself before
  importing.

## [0.9.2] — 2026-08-05
Corrections from hands-on use of 0.9.1. Same rule as before: mechanism only — what a participant *is*,
what a reaction *means*, and which colors stand for what all stay with the integrator.

### Changed
- **An anchor badge counts every utterance under it**, replies included. It counted root comments only,
  so a thread that had drawn three answers still read as "1" from the page — the conversation was
  invisible until you opened it. The panel's total now counts the same way, so the two agree.
- **The thread Pane no longer offers a per-utterance delete.** A reply belongs to its comment and is
  removed with it, so a per-row ✕ presented a granularity the model does not have: deleting one comment
  could take a whole side of the conversation away with no warning. Deletion is an **anchor-level** act
  — right-click an anchor → *Delete anchor*. `core.deleteComment` is unchanged for integrators with
  their own rules.

- **A sent utterance stops saying "awaiting reply" once it is answered.** The pending marker is
  settled by another utterance landing in the thread, and only the latest send carries one — they used
  to outlive the answer they were waiting for and stack up, one per send. Two things deliberately do
  not settle it: an anchor being moved or resized (nobody said anything), and the send's own utterance.
  An answer sent synchronously from a `comment:add` handler settles it too — that arrives before the
  commit call has even returned.
- **An open thread keeps up with the conversation.** Utterances that arrive while the Pane is showing —
  an answer through the `addReply` seam, a comment committed elsewhere on the same anchor — are appended
  in place instead of waiting for the next open. Rows already on screen are skipped by key, and the
  input box, its draft and the reaction selection are untouched.

### Docs / demo
- README: the customization section now shows, in one snippet, how to replace the reaction set, the
  theme tokens and the participant colors — the axes an integrator is expected to drive. New *Deleting*
  section states the anchor-level model.
- The demo gained a **Scenario** toggle: *local (Save)* — no transport, the popup closes on commit, the
  backend-free shape — versus *conversation (Send)* — an interactive transport descriptor, so the popup
  stays open and the simulated participant answers a beat after each Send. Simulating a reply against a
  Save button was telling the wrong story about what the mode is.
- The demo's alternative reaction set is now genuinely distinct (🚀🔁✂️💡🛑, five ids of its own) instead
  of the default three plus one, and a new **Colors** toggle swaps the participant colors and the panel
  theme tokens together — so both replaceability axes are visible in one page.

## [0.9.1] — 2026-08-05
*Git release only — never published to npm; superseded the same day by 0.9.2, which is the first
published version carrying this work.*

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
- **`core.getAuthor()`** — read back the author new comments are attributed to, so a UI can edit the
  name without replacing (and thereby flattening) a `{ id, kind }` provenance object.

### Changed
- **Reduced `DEFAULT_REACTIONS`** from eight to a focused three (👍 `agree` / 👎 `disagree` /
  ❓ `question`) — fewer icons read faster. Ids/labels stay generic sentiments; a review workflow assigns
  its own meaning by reading `comment.reaction`, or replaces the set via the `reactions` option.
  **Upgrade note:** `concern` / `cut` / `good` / `rethink` / `add` are gone from the default set. A stored
  comment that references one is never lost or altered — but the panel has only the id to render, so it
  shows as the bare id text (`concern note…`) instead of its old icon. An export carries a reaction legend
  only when the integrator mounted with a `reactions` option, so a default-mount envelope cannot restore
  its own icons. To keep them, pass the previous set explicitly: `attachPanel(core, { reactions: [...] })`.
- **Flat Pane timeline** — comments and replies now render as individual, chronologically-ordered rows
  (no reply nesting/indent); each row carries its actor color + label so who-said-what stays legible.
- **Commit button disables** (greys out) while the Pane input is empty — no body text and no reaction —
  and re-enables the instant either is present. Cmd/Ctrl+Enter obeys the same rule.
- **A conversation shows what you just sent.** With an `interactive` transport the popup stays open; the
  sent utterance is now echoed into the timeline as its own row (followed by its pending marker) instead
  of only appearing the next time the thread is opened.
- An anchor's attention flag now flips as a **targeted class toggle** instead of a full mark re-render,
  so raising a notice can no longer interrupt an in-progress region move/resize.
- `attachPanel` **copies** the reaction set it is given, so `panel.setReactions()` can no longer rewrite
  the exported `DEFAULT_REACTIONS` for every other consumer on the page.

### Fixed
- **Deleting a comment now removes its replies from the open thread.** In the flat timeline a reply is a
  sibling row, not a child, so deleting its comment left the reply rows on screen until the popup closed.
- **Commit button state after an interactive send.** With an `interactive` transport the popup stays open;
  clearing the text box fires no `input` event, so the button stayed enabled over an empty box and the
  next click dismissed the conversation. The text, the reaction and the button state now all reset.
- **Attention flags no longer outlive their comment.** A wipe (clear-all / `replace` import) drops the
  flags of comments that went away, so re-importing the same comment id starts unflagged instead of
  resurrecting a stale notice. `setAnchorAttention` also refuses to run on a destroyed instance.
- **The panel's name field no longer destroys `author.kind`.** It patches the author's `id` and keeps the
  rest of the provenance object, so typing a name cannot silently disable `actorColors`.
- **Fallback author hues are disjoint from `actorColors`.** The generic per-identity palette excludes any
  color the injected category map claimed, so an unmapped author can never be painted as a mapped one.
- `panel.setActorColors()` re-tints an open thread popup, not just the anchors.

### Compatibility
- No breaking API changes. `attachPanel` / `deriveBlockId` / resolution / `setTransport` /
  export-import are unchanged. Existing stored comments and exports round-trip as before.
- The one behavioral trim is the shorter default reaction set (see the upgrade note above); pass your own
  `reactions` to keep any of the removed ids rendering as icons.

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

[Unreleased]: https://github.com/brainworker-org/tackback/compare/v0.9.5...HEAD
[0.9.5]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.5
[0.9.4]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.4
[0.9.3]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.3
[0.9.2]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.2
[0.9.1]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.1
[0.9.0]: https://github.com/brainworker-org/tackback/releases/tag/v0.9.0
