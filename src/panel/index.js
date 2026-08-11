// @tackback/panel — the default UI. `attachPanel(core, options)` consumes a headless core instance
// and adds: a control panel, place-anchored marks, a comment pane, gesture capture (right-click a
// block, right-drag a PDF region), plus the three customization axes (theming / reactions / i18n).
// It NEVER reaches into core internals — it drives the public API and re-renders on `change`.

import { resolveTheme, buildThemeCSS, buildUnreadInkCSS, PALETTES } from './theme.js';
import { DEFAULT_REACTIONS, resolveReaction } from './reactions.js';
import { LocaleRegistry } from './i18n.js';
import { indexAnnotatable, resolveAnchorDom, clampToViewport } from './dom.js';
import { computeCapture, resolveRegionRect } from '../core/resolution.js';
import { classifyGesture, popupCommit, canCommit, nextSendState, answersSend, applyHandleDrag, resolveLaneLayout } from './interaction.js';
import { actorColorOf as resolveActorColor, claimedColors, authorKey as tbAuthorKey, lastSpeaker } from './actors.js';
import { threadKeyOf, timelineItems, utteranceCount, planInsertions, anchorLabelSpec } from './thread.js';
import { createHost } from './host.js';
import { documentSurface, DOCUMENT_SURFACE_ID } from '../core/media.js';
import { normalizeRegion, buildQuoteSelector, resolveQuoteSelector } from '../core/anchor.js';
import { selectionOffsetsWithin, offsetsToRange, paintHighlights, clearHighlights } from './range.js';

const PANEL_CSS = `
[data-tb-root] { }
.tb-console { position: fixed; right: 16px; bottom: 16px; z-index: 9999; background: #222; color: #fff;
  border-radius: 10px; padding: 10px 12px; font: 13px -apple-system, system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); display: flex; flex-direction: column; gap: 6px; min-width: 200px; }
.tb-console button { font: inherit; cursor: pointer; border: none; border-radius: 6px; padding: 6px 8px; background: var(--tb-accent); color: #fff; }
.tb-console button.tb-sec { background: #555; }
.tb-console input { font: inherit; border: 1px solid #555; border-radius: 6px; padding: 5px 8px; background: #333; color: #fff; }
.tb-console-count { font-weight: 700; }
.tb-console-hint { font-size: 11px; color: #bbb; line-height: 1.45; }
.tb-commentable { background: var(--tb-mark-bg) !important; outline: 1px dashed var(--tb-mark-outline); outline-offset: 1px; }
/* line-height is set EXPLICITLY: a badge is appended inside the surface element, so it would
   otherwise INHERIT the host's line-height — a surface with line-height:0 (e.g. a figure wrapping an
   image/SVG) collapses the pill to 0px tall, leaving only the bare glyph ("white & small"). An explicit
   value makes a badge render identically on every surface. */
.tb-badge { cursor: pointer; font-size: 11px; line-height: 1.6; font-weight: 700; background: var(--tb-badge-bg); color: var(--tb-badge-fg); border-radius: 10px; padding: 0 7px; white-space: nowrap; }
/* badges are absolutely positioned on the document surface overlay (NOT inserted into the DOM) so they
   never shift the page layout — the same surface-overlay model a floating badge uses. */
.tb-badge { position: absolute; z-index: 6; transform: translateY(-50%); }
.tb-region { position: absolute; z-index: 5; border: 2px solid var(--tb-mark-outline); background: var(--tb-mark-bg); border-radius: 3px; pointer-events: none; cursor: default; }
/* the resize handle is a top-left CORNER BRACKET (「), revealed only on hover; the box body is not a
   move target so the anchor icon position stays fixed (Keisuke 2026-06-15). */
.tb-grip { position: absolute; width: 13px; height: 13px; display: none; }
.tb-region:hover .tb-grip { display: block; }
.tb-grip-nw { left: -3px; top: -3px; border-top: 3px solid var(--tb-mark-outline); border-left: 3px solid var(--tb-mark-outline); cursor: nwse-resize; }
/* A badge that floats ON a picture rather than beside text: centred on its point instead of hung
   off a line, lifted by a shadow so it reads against whatever is underneath, and draggable because
   the region it belongs to can be moved. Everything else about it is a badge. */
.tb-badge.tb-floating { transform: translate(-50%,-50%); box-shadow: 0 1px 4px rgba(0,0,0,.3); cursor: move; }
/* A region bound to a sub-surface (an image/figure/canvas/PDF page that owns its own coordinate space)
   reads differently from a free region on the document surface: a DOUBLE frame border says "this is
   locked inside that surface and moves/scales with it". A plain document region keeps the single-line
   border. The badge looks the SAME on both — the distinction lives in the border only, because a
   badge is too small to carry the signal legibly. */
/* the double frame is drawn with an inset box-shadow (outer border + gap + inner line) rather than the
   CSS double border-style, which renders unevenly at subpixel sizes / with border-radius (Keisuke
   2026-06-16: the double line was not drawing stably). box-shadow rings are crisp and follow the radius. */
.tb-region.tb-on-surface { box-shadow: inset 0 0 0 2px var(--tb-bg, #fff), inset 0 0 0 4px var(--tb-mark-outline); }
/* while a comment pane is open the region is locked (REQ-008): hide the hover resize grip and drop the
   move cursor on the icon, so the UI never invites a move/resize that is disabled (Keisuke 2026-06-15). */
.tb-pane-open .tb-region:hover .tb-grip { display: none; }
.tb-pane-open .tb-badge.tb-floating { cursor: default; }
.tb-draw { position: absolute; z-index: 7; border: 2px dashed var(--tb-accent); background: rgba(51,170,119,.12); pointer-events: none; }
.tb-pending { position: absolute; z-index: 6; border: 2px dashed var(--tb-mark-outline); background: var(--tb-mark-bg); border-radius: 3px; pointer-events: none; }
/* Marks OFF hides what the panel PUT ON the page — the badges, and the boxes it drew over an area.
   What it does NOT do is hide the page: tb-commentable sits on the host's OWN paragraph, so hiding
   elements wearing it takes the document's text with it. What that class contributes is a tint and a
   dashed outline, and those are what come off. The distinction is the whole of this rule: a class the
   panel OWNS may be hidden, a class the panel BORROWED may only be undressed.

   It does not change what is unread either: the state goes on being kept while it is out of sight,
   and turning marks back on shows whatever arrived meanwhile. */
.tb-hide .tb-badge, .tb-hide .tb-region { display: none; }
.tb-hide .tb-commentable { background: none !important; outline: none !important; }
:root.tb-hide ::highlight(tb-range) { background: transparent; text-decoration: none; }
::highlight(tb-range) { background: var(--tb-mark-bg); color: inherit; text-decoration: underline dotted var(--tb-mark-outline); }
.tb-badge.tb-orphan { opacity: .7; }
/* A badge holding something this reader has not got to is FILLED and breathes. Reading the thread
   drops the class, and the badge goes back to the colour of whoever spoke last — which the render
   writes inline, so the fill has to outweigh it, and letting go of that weight is what puts the
   speaker's colour back. The ink on top follows the light/dark base and is emitted with the tokens
   (buildUnreadInkCSS) rather than published as a token of its own. */
.tb-badge.tb-unread { background: var(--tb-unread) !important; animation: tb-unread-pulse 2s ease-in-out infinite; }
@keyframes tb-unread-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
/* A pulse that never stops is the kind a reader may have asked their system to spare them. The mark
   stays — it is the movement that goes, not the information. */
@media (prefers-reduced-motion: reduce) {
  .tb-badge.tb-unread, .tb-docbar.tb-unread .tb-docbar-count { animation: none; }
}
/* The document lane: the conversation about the document as a whole, composed from a bar across the
   bottom of the viewport rather than reached from a mark, because it is about no particular place.
   It FLOATS — the library never shifts the host's layout (same reason badges are overlay-positioned)
   — and it is centred with a max-width so the panel (bottom-right) and any host chrome in the other
   corner keep their space. Its z-index sits below the pane so an anchored thread still wins.
   env(safe-area-inset-bottom) and the visualViewport listener keep it off the home indicator and
   above a software keyboard; both are cheap now and awkward to retrofit. */
/* Geometry, since this bar is now permanent chrome rather than something you summon. The panel
   lives in the bottom-right corner; a centred bar wide enough to type into overlaps it on any
   ordinary laptop width, and z-index only decides which one is unreachable. So the lane reserves
   the corners instead of competing for them: it is centred within the space that remains, and on
   narrow viewports it moves ABOVE the panel rather than under it.
   Tackback can only reserve space for chrome it knows about — its own panel. A host with chrome of
   its own at the bottom sets --tb-docbar-left / --tb-docbar-right to tell the lane where it may sit. */
.tb-docbar { position: fixed; z-index: 9998;
  left: var(--tb-docbar-left, 16px);
  /* two reservations, added: the HOST's (public, declared on the root) and the panel's (private,
     measured in placeLane). Writing the measurement into the public one would silently override
     anything a host declared. */
  right: calc(var(--tb-docbar-right, 16px) + var(--tb-console-reserve, 0px));
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  margin-inline: auto; max-width: 680px;
  box-sizing: border-box;
  background: var(--tb-pane-bg); color: var(--tb-pane-fg);
  border: 1px solid var(--tb-border); border-radius: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font: 13px -apple-system, system-ui, sans-serif; padding: 8px 10px; }
.tb-docbar .tb-docbar-head { display: flex; align-items: center; gap: 8px; cursor: pointer; width: 100%;
  font: inherit; color: inherit; background: none; border: 0; padding: 0; text-align: left; }
.tb-docbar .tb-docbar-title { font-weight: 600; flex: 1; }
.tb-docbar .tb-docbar-count { font-size: 11px; opacity: .75; }
/* the shape a count takes once it carries a colour — the same pill the marks below use */
.tb-docbar .tb-docbar-count.tb-tinted { border-radius: 9px; padding: 0 7px; opacity: 1; }
/* The document thread has no mark on the page — the lane's own count IS its mark, so the ring goes
   there. Padding and radius are repeated because the count is otherwise a bare number with nothing
   for a ring to sit around. */
.tb-docbar.tb-unread .tb-docbar-count { background: var(--tb-unread) !important; border-radius: 9px; padding: 0 7px; opacity: 1; animation: tb-unread-pulse 2s ease-in-out infinite; }
.tb-docbar .tb-docbar-composer { margin-top: 8px; }
/* Collapsed is not "closed": the composer stays, because the point of a lane rather than a button
   is that you can type into it without opening anything. Expanding adds the history above it. */
.tb-docbar .tb-docbar-body { display: none; margin-top: 8px; }
.tb-docbar.tb-docbar-open .tb-docbar-body { display: block; }
/* the lane hosts the same conversation the Pane does, so its rows reuse the pane's own styles */
.tb-docbar .tb-timeline { max-height: 40vh; overscroll-behavior: contain; }
.tb-docbar textarea { width: 100%; box-sizing: border-box; min-height: 44px; font: inherit;
  border: 1px solid var(--tb-border); border-radius: 8px; padding: 7px; background: transparent; color: inherit;
  /* no resize grip: this bar has just measured its own place in the viewport, and a corner the
     reader can drag is an invitation to fight that (Keisuke, hands-on 2026-08-06). */
  resize: none; }
.tb-docbar .tb-pane-label { display: none; }   /* the lane's own title already says what it is about */
/* When there is not enough width to sit BESIDE the panel, the lane goes above it and takes the
   available width, up to its own maximum. Which of the two applies is decided by measurement in placeLane, not by a guessed
   breakpoint — the panel's width follows its labels, so no fixed number is right for long. A host
   with its own bottom chrome can watch for the tb-docbar-stacked class on the root element. */
.tb-docbar.tb-stacked { left: var(--tb-docbar-left, 16px); right: var(--tb-docbar-right, 16px); --tb-console-reserve: 0px; }
.tb-pane { position: fixed; z-index: 10000; width: 320px; background: var(--tb-pane-bg); color: var(--tb-pane-fg);
  border: 1px solid var(--tb-border); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35); padding: 11px; font: 13px -apple-system, system-ui, sans-serif; }
.tb-pane .tb-pane-label { font-size: 11px; color: var(--tb-muted); margin-bottom: 4px; }
.tb-pane textarea { width: 100%; box-sizing: border-box; min-height: 52px; font: inherit; border: 1px solid var(--tb-border); border-radius: 6px; padding: 6px; background: transparent; color: inherit; }
.tb-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin: 7px 0; }
.tb-reactions button { cursor: pointer; border: 1px solid var(--tb-border); background: transparent; color: inherit; border-radius: 14px; padding: 3px 9px; font: 12px system-ui; }
.tb-reactions button.on { background: var(--tb-mark-bg); border-color: var(--tb-mark-outline); font-weight: 700; }
.tb-timeline { margin-top: 7px; border-top: 1px solid var(--tb-border); padding-top: 5px; max-height: 130px; overflow: auto; font-size: 12px; }
.tb-timeline .tb-c { padding: 4px 0; border-bottom: 1px dotted var(--tb-border); }
/* a reply renders as its OWN flat row in the timeline — NOT nested/indented under its comment (REQ-704):
   every utterance (comment or reply) is one row appended in chronological order, each carrying its own
   actor color + label so who-said-what stays legible without an indent tree. */
.tb-timeline .tb-c-reply { padding: 4px 0; border-bottom: 1px dotted var(--tb-border); font-size: 12px; }
.tb-timeline .tb-who { font-weight: 700; margin-right: 2px; }
/* a region's move/resize history rendered inline in the thread, alongside comments but NOT deletable (REQ-704/009). */
.tb-timeline .tb-ev { padding: 3px 0; border-bottom: 1px dotted var(--tb-border); color: var(--tb-muted); font-size: 11px; }
/* the marker under a sent-but-unresolved utterance in a conversation (interactive transport, REQ-702):
   the integrator resolves it via its own UI/events — the library never invents an ack. */
.tb-timeline .tb-pending-note { padding: 2px 0 5px; color: var(--tb-muted); font-size: 11px; font-style: italic; }
.tb-acts { display: flex; gap: 6px; justify-content: flex-end; margin-top: 7px; }
.tb-acts button { cursor: pointer; border: none; border-radius: 6px; padding: 6px 14px; }
.tb-save { background: var(--tb-accent); color: #fff; } .tb-cancel { background: #bbb; color: #111; }
/* the save/send button greys out while the input is empty (no text AND no reaction) — a commit needs
   at least one, so an empty commit is never offered (REQ: Principal 2026-08-05). */
.tb-save:disabled { background: #b9bcc0; color: #eef0f2; cursor: not-allowed; opacity: .65; }
/* right-click context menu on an anchor's badge → delete the whole anchor. */
.tb-ctxmenu { position: fixed; z-index: 10001; background: var(--tb-pane-bg); color: var(--tb-pane-fg); border: 1px solid var(--tb-border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.35); padding: 4px; font: 13px -apple-system, system-ui, sans-serif; min-width: 140px; }
.tb-ctxmenu .tb-ctxitem { padding: 7px 10px; border-radius: 6px; cursor: pointer; }
.tb-ctxmenu .tb-ctxitem:hover { background: var(--tb-mark-bg); }
`;

/**
 * @param {import('../core/engine.js').TackbackInstance} core
 * @param {object} [options]  { root?, theme?, reactions?, actorColors?, locale?, labels?, target?, controls? }
 *   `actorColors` maps an author CATEGORY (`author.kind`, opaque to Tackback) to a CSS color, e.g.
 *   `{ ai: '#2563eb', human: '#db2777' }`; an anchor is tinted by its last speaker's category. With
 *   no map, authors fall back to a generic per-identity hue. Tackback ships no categories or colors.
 *   `controls` selects which panel buttons are shown (the rest still work via the API). Defaults:
 *   `{ author: true, export: true, import: false, theme: true, marks: true, clear: true, docBar: true }`.
 *   `docBar` is the conversation about the document AS A WHOLE, composed from a bar across the
 *   bottom of the viewport — it is about no particular place, so it has no mark to hang on. With the
 *   lane off, `panel.openDocumentThread()` opens that same thread as an ordinary Pane. (`clear` is
 *   the one control with no API equivalent — see the README.)
 */
export function attachPanel(core, options = {}) {
  const doc = (options.root && options.root.ownerDocument) || globalThis.document;
  const win = doc.defaultView || globalThis;
  const root = options.root || doc.body;
  const target = options.target || doc.body;
  // COPY the set: `setReactions` mutates this array in place (closures capture its identity), so
  // sharing the exported DEFAULT_REACTIONS singleton would let one panel's setReactions rewrite the
  // library default for every other consumer in the page.
  const reactions = [...(options.reactions || DEFAULT_REACTIONS)];
  // `actorColors` is an OPTIONAL, integrator-supplied map from an author CATEGORY (author.kind — an
  // opaque string to Tackback) to a CSS color, e.g. `{ ai: '#2563eb', human: '#db2777' }`. Tackback
  // ships NO built-in categories or colors: it does not know what 'ai' or 'human' mean — it only tints
  // an anchor by the LAST speaker's category using whatever map the caller injects here. With no map,
  // an anchor falls back to a generic per-identity color (deterministic hash of the author key).
  let actorColors = { ...(options.actorColors || {}) };
  // colors the injected map has claimed — the fallback hues are drawn from the palette MINUS these,
  // so an UNMAPPED author can never be painted the same color as a mapped category (see actors.js).
  let claimed = claimedColors(actorColors);
  const i18n = new LocaleRegistry();
  if (options.labels) for (const [lang, b] of Object.entries(options.labels)) i18n.register(lang, b);
  if (options.locale) i18n.setLocale(options.locale);
  const t = (k, v) => i18n.t(k, v);
  const lbl = (k, fb) => { const v = t(k); return v === k ? fb : v; };   // i18n with a literal fallback

  // ---- ownership -------------------------------------------------------------------------------
  // Every resource this panel takes registers how to give it back, AT THE POINT IT IS TAKEN. Teardown
  // then has nothing to remember: it runs the bag, last acquired first. The previous teardown mirrored
  // some twenty-five acquisition sites by hand in one list, and whatever it missed it missed in
  // silence — a held pointer capture, a class left on a host element, an attribute on the root.
  //
  // What is deliberately NOT given back: the element IDS assigned to elements that had none, and the
  // identity mark on a region's surface. A stored comment names its element by id, so removing those
  // would orphan the anchors that depend on them. They are contract, not litter. Nothing else the
  // panel writes onto a host element is in that category — see the indexing marks below.
  const owned = [];
  const own = (dispose) => { owned.push(dispose); };
  const disposeOwned = () => {
    while (owned.length) { try { owned.pop()(); } catch { /* one bad disposer must not strand the rest */ } }
  };
  const onDoc = (type, fn, capture) => { doc.addEventListener(type, fn, capture); own(() => doc.removeEventListener(type, fn, capture)); };
  const onWin = (type, fn) => { if (!win.addEventListener) return; win.addEventListener(type, fn); own(() => win.removeEventListener?.(type, fn)); };
  const ownNode = (node) => { own(() => node.remove()); return node; };
  /**
   * Subscribe to the core, and register the unsubscribe. The guard is not redundant with it: the
   * emitter snapshots its listeners before invoking them, so unsubscribing DURING a dispatch does not
   * take this panel out of the run already in progress. An integrator that calls `destroy()` from its
   * own `change` handler used to have the panel's handler run afterwards anyway — re-creating marks
   * and writing to host elements after teardown.
   */
  const onCore = (event, fn) => { own(core.on(event, (...a) => { if (!destroyed) fn(...a); })); };
  /**
   * Defer work, and hand back a cancel that matches how it was scheduled. Both the Panes and the
   * repaint used to defer without keeping a handle at all. Where the host has animation frames that
   * merely meant nothing could be cancelled; where it has none the work is a timer, which
   * `cancelAnimationFrame` cannot take back, so it carried straight across teardown.
   */
  const later = (fn) => {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') { const id = raf(fn); return () => globalThis.cancelAnimationFrame?.(id); }
    const id = (globalThis.setTimeout || ((f) => (f(), 0)))(fn, 0);
    return () => globalThis.clearTimeout?.(id);
  };
  /** Defer work that belongs to the PANEL: cancelled when the panel goes. */
  const laterOwned = (fn) => { const cancel = later(fn); own(cancel); return cancel; };
  /** Add a class to something the HOST owns, and take only that class back. */
  const ownClass = (element, cls) => { element.classList.add(cls); own(() => element.classList.remove(cls)); };
  /** Write an attribute on something the host owns; restore it only if it is still what we wrote. */
  const ownAttr = (element, name, value) => {
    const prev = element.getAttribute(name);
    element.setAttribute(name, value);
    own(() => {
      if (element.getAttribute(name) !== value) return;   // the host changed it since; leave theirs
      if (prev == null) element.removeAttribute?.(name); else element.setAttribute(name, prev);
    });
  };

  ownAttr(doc.documentElement, 'data-tb-root', '');
  // Indexing writes three things onto the HOST's own elements, and only one of them is anchor
  // identity. The element `id` is: a stored comment names it as `elementId`, so removing it would
  // orphan that comment. `data-tb-anchor` and `data-tb-section` are not — nothing in anchor
  // resolution reads them; they exist so this panel can find what is commentable and label a thread.
  // So the id stays, and those two are handed back the same way the positioning context is: recorded
  // per element at the moment of writing, and restored only where the value is still the one the
  // panel wrote. Searching the document at teardown instead would miss anything detached since, and
  // would overwrite a value the host changed while the panel was alive.
  const indexed = new Map();
  for (const elx of root.querySelectorAll('[data-tb-anchor],[data-tb-section]') || []) {
    indexed.set(elx, { before: [elx.getAttribute('data-tb-anchor'), elx.getAttribute('data-tb-section')] });
  }
  indexAnnotatable(root);
  for (const elx of root.querySelectorAll('[data-tb-anchor],[data-tb-section]') || []) {
    const rec = indexed.get(elx) || { before: [null, null] };
    rec.written = [elx.getAttribute('data-tb-anchor'), elx.getAttribute('data-tb-section')];
    indexed.set(elx, rec);
  }
  own(() => {
    for (const [elx, rec] of indexed) {
      for (const [i, name] of [[0, 'data-tb-anchor'], [1, 'data-tb-section']]) {
        if (elx.getAttribute(name) !== rec.written?.[i]) continue;   // the host changed it; leave theirs
        const had = rec.before[i];
        if (had == null) elx.removeAttribute?.(name); else elx.setAttribute(name, had);
      }
    }
  });
  // `.tb-commentable` is a class on the HOST's own elements — the teardown sweep could never remove those
  // nodes, and did not think to remove the class either. renderMarks clears them each pass; this is
  // the last one.
  // Released through the ELEMENTS, not through a search of the document. A host that detaches a
  // marked block while the panel is alive would not be found by a search, and re-attaching that
  // element later would bring the panel's class back with it — the same shape the indexing marks
  // needed, and one the outside census cannot see, because the element has left the subtree it walks.
  const marked = new Set();
  const markHost = (element) => { element.classList.add('tb-commentable'); marked.add(element); };
  const unmarkHosts = () => { for (const e of marked) e.classList.remove('tb-commentable'); marked.clear(); };
  own(unmarkHosts);
  // State this panel writes onto the document root, as a namespace rather than as a list of three
  // classes to remember: `tb-hide`, `tb-pane-open`, `tb-docbar-stacked` are all toggled from several
  // places, and one of them survived teardown because the removal was a hand-written line rather
  // than a consequence of having set it. The `tb-` namespace on the root belongs to this library.
  own(() => {
    for (const cls of [...(doc.documentElement.classList || [])]) {
      if (String(cls).startsWith('tb-')) doc.documentElement.classList.remove(cls);
    }
  });
  // A gesture torn down mid-flight kept the pointer capture it took, so the page went on routing
  // pointer events to a panel that no longer exists.
  own(() => {
    for (const id of [draw?.pointerId, handleDrag?.captured ? handleDrag.pointerId : null]) {
      if (id == null) continue;
      try { doc.documentElement?.releasePointerCapture?.(id); } catch { /* ignore */ }
    }
  });

  // The default HTML surface = the document content box (REQ-005): a region can be drawn over the
  // document itself (cross-element, over text + non-text), not only over a figure/PDF page. Register
  // it against the panel's content root so surfaceId:'document' anchors resolve. Idempotent if the
  // core was also mounted with a root (same id overwrites).
  own(core.registerMediaAdapter({
    name: 'tb-document',
    mount: (ctx) => { ctx.registerSurface(documentSurface(root)); },
  }));

  // ---- styles (panel + theme tokens) -----------------------------------------------------------
  const styleEl = doc.createElement('style');
  const themeStyleEl = doc.createElement('style');
  styleEl.textContent = PANEL_CSS;
  doc.head.appendChild(ownNode(styleEl));
  doc.head.appendChild(ownNode(themeStyleEl));

  let mql = null, applyAutoTheme = null;
  function applyTheme(theme) {
    const prefersDark = !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: dark)').matches);
    themeStyleEl.textContent = buildThemeCSS(resolveTheme(theme, prefersDark))
      + '\n' + buildUnreadInkCSS(theme, prefersDark);
    if (mql && applyAutoTheme) { mql.removeEventListener('change', applyAutoTheme); mql = null; applyAutoTheme = null; }
    // 'auto' AND palette/custom-object themes keep the light/dark BASE following the OS live
    // (a palette only overrides accent tokens; its base still flips with the OS).
    const followsOS = theme === 'auto' || theme == null || (theme && typeof theme === 'object');
    if (followsOS && globalThis.matchMedia) {
      mql = globalThis.matchMedia('(prefers-color-scheme: dark)');
      applyAutoTheme = () => {
        themeStyleEl.textContent = buildThemeCSS(resolveTheme(theme, mql.matches))
          + '\n' + buildUnreadInkCSS(theme, mql.matches);
      };
      mql.addEventListener('change', applyAutoTheme);
      // re-registered on every theme change, so the disposer is registered every time too and the
      // stale ones become no-ops rather than being forgotten
      const boundMql = mql, boundFn = applyAutoTheme;
      own(() => boundMql.removeEventListener('change', boundFn));
    }
  }
  let currentTheme = options.theme || 'auto';
  applyTheme(currentTheme);

  // ---- panel chrome ----------------------------------------------------------------------------
  // `controls` chooses which buttons appear. Hiding a button never hides the DATA behind it, but the substitute differs by control:
  // theme/marks/docBar have PanelInstance methods; author/export/import have core equivalents
  // (setAuthor / exportEnvelope / importEnvelope — the dialogs themselves are the panel's own); and
  // `clear` has none, because the button also confirms, closes an open Pane and drops an uncommitted
  // region rect. See the README table.
  // theme: shown by default so a participant can switch the colour scheme (STORY-06); the default theme
  // value is still 'auto' (live OS light/dark follow) — the toggle adds the named palettes on top.
  // `import` is OFF by default — it is the receiver / AI-participant path (STORY-02/04), which is
  // post-v1 scope; enable it explicitly with `controls: { import: true }`. Every control is config-
  // toggleable here, so an integrator can show/hide any menu item (Keisuke 2026-06-15).
  const CONTROL_DEFAULTS = { author: true, export: true, import: false, theme: true, marks: true, clear: true, docBar: true };
  const controls = { ...CONTROL_DEFAULTS, ...(options.controls || {}) };

  // The theme switch (when shown) cycles named "play" themes: default (OS auto) → ocean → passion.
  // Each still follows the OS light/dark base; the palette only re-tints the accent colors.
  const THEME_CYCLE = [
    { key: 'default', value: 'auto' },
    { key: 'ocean', value: PALETTES.ocean },
    { key: 'passion', value: PALETTES.passion },
    { key: 'ochre', value: PALETTES.ochre },
  ];
  let themeIdx = 0;
  const themeLabel = () => t('panel.theme', { mode: t(`theme.${THEME_CYCLE[themeIdx].key}`) });

  const panel = el(doc, 'div', 'tb-console');
  const countEl = el(doc, 'div', 'tb-console-count');
  panel.appendChild(countEl);

  let authorInput = null;
  if (controls.author) {
    authorInput = el(doc, 'input');
    authorInput.placeholder = t('panel.authorPlaceholder');
    const currentAuthor = core.getAuthor?.() ?? null;
    if (currentAuthor) authorInput.value = typeof currentAuthor === 'string' ? currentAuthor : (currentAuthor.id || '');
    // The field edits the author's NAME only. When the integrator mounted with a provenance object
    // (`{ id, kind }`), patch `.id` and keep the rest — replacing the object would drop `kind` and
    // silently disable every category-based rendering the integrator configured.
    authorInput.onchange = () => {
      const name = authorInput.value.trim();
      const cur = core.getAuthor?.() ?? null;
      if (cur && typeof cur === 'object') core.setAuthor({ ...cur, id: name || undefined });
      else core.setAuthor(name || null);
    };
    panel.appendChild(authorInput);
  }
  let exportBtn = null;
  if (controls.export) {
    exportBtn = btn(doc, t('panel.export'));
    exportBtn.onclick = () => openModal(exportModal(doc, core.exportEnvelope()));
    panel.appendChild(exportBtn);
  }
  let importBtn = null;
  if (controls.import) {
    // Import an exported envelope back in — the receiver/AI-participant path (STORY-02/04 via the
    // shared file, no backend). Merge so an incoming envelope ADDS comments (e.g. an AI participant's
    // anchored replies) without wiping the current set; the panel re-renders via the `change` event.
    importBtn = btn(doc, t('panel.import'), 'tb-sec');
    importBtn.onclick = () => openModal(importModal(doc, core, t));
    panel.appendChild(importBtn);
  }
  let themeBtn = null;
  if (controls.theme) {
    themeBtn = btn(doc, themeLabel(), 'tb-sec');
    themeBtn.onclick = () => { themeIdx = (themeIdx + 1) % THEME_CYCLE.length; currentTheme = THEME_CYCLE[themeIdx].value; applyTheme(currentTheme); themeBtn.textContent = themeLabel(); };
    panel.appendChild(themeBtn);
  }
  let marksBtn = null;
  if (controls.marks) {
    marksBtn = btn(doc, t('panel.toggleMarks'), 'tb-sec');
    marksBtn.onclick = () => doc.documentElement.classList.toggle('tb-hide');
    panel.appendChild(marksBtn);
  }
  let clearBtn = null;
  if (controls.clear) {
    clearBtn = btn(doc, t('panel.clearAll'), 'tb-sec');
    clearBtn.onclick = () => {
      if (!globalThis.confirm?.(t('confirm.clearAll'))) return;
      closePopup();   // also drops any in-progress pending region (which is never committed) — bug: it survived clear-all
      core.deleteComments(core.listComments().map((c) => c.id));   // one operation, not one per comment
      doc.querySelectorAll('.tb-pending,.tb-draw').forEach((e) => e.remove());   // belt-and-suspenders: no stray draft rect
    };
    panel.appendChild(clearBtn);
  }
  const hintEl = el(doc, 'div', 'tb-console-hint');
  hintEl.textContent = t('hint.html');
  panel.appendChild(hintEl);
  target.appendChild(ownNode(panel));

  // ---- the document lane -------------------------------------------------------------------------
  // Every other thread is reached from a mark on the thing it is about. This one is about the whole
  // document, so it has no such thing — it gets a bar of its own across the bottom, which doubles as
  // its mark: the count lives on the head, visible without opening anything.
  let lane = null, laneHead = null, laneTitle = null, laneCount = null, laneBody = null, laneComposer = null, laneConv = null;
  let laneHost = null;
  if (controls.docBar) {
    lane = el(doc, 'div', 'tb-docbar');
    // a real <button>: the thing it replaced was one, and focusability, Enter/Space and the
    // announced expanded state come with the element rather than having to be re-created on a div.
    laneHead = el(doc, 'button', 'tb-docbar-head');
    laneHead.setAttribute('type', 'button');
    laneHead.setAttribute('aria-expanded', 'false');
    laneTitle = el(doc, 'span', 'tb-docbar-title'); laneTitle.textContent = t('panel.docBar');
    laneCount = el(doc, 'span', 'tb-docbar-count');
    laneHead.append(laneTitle, laneCount);
    laneBody = el(doc, 'div', 'tb-docbar-body');           // the thread, revealed on expand
    laneComposer = el(doc, 'div', 'tb-docbar-composer');   // …and the input, which never hides
    laneHead.onclick = () => toggleLane();
    lane.append(laneHead, laneBody, laneComposer);
    target.appendChild(ownNode(lane));
  }
  // The conversation is built with the lane, not on first expand: its composer is visible from the
  // start, so it must exist from the start. The timeline it also owns simply stays hidden until
  // asked for.
  function buildLaneConversation() {
    laneConv = createConversation({
      anchorLabel: anchorLabelOf({ type: 'document' }),
      // built before the first render, so it starts empty and is filled by the sync that every
      // renderMarks performs — the same path that keeps it current afterwards
      existing: [],
      draftKey: anchorKey({ type: 'document' }),
      threadKey: 'document',
      anchor: { type: 'document' },
      // the lane is not a pane: committing never dismisses it, so "close" is a no-op here
      onClose: () => {},
      onSave: (body, reaction) => core.addComment({ anchor: { type: 'document' }, body, reaction }),
    });
    laneBody.appendChild(laneConv.timeline);
    laneComposer.append(...laneConv.composer);
    laneHost = createHost({ collapsible: true }, () => core.reportThreadVisibility());
    laneHost.attach(laneConv, lane);
    hosts.add(laneHost);
    // The lane outlives every Pane, so the only end it has is the panel's own. Registering that end
    // here is what makes releaseHost the one path in fact and not just in the comment above it: the
    // lane's node is already given back by the sweep, so without this its host would simply stop
    // being reachable — alive, holding a conversation, and never told.
    own(() => releaseHost(laneHost));
  }
  function laneOpen() { return !!laneHost && laneHost.timelineOpen(); }
  function toggleLane(force) {
    if (!lane || !laneHost) return false;
    const open = laneHost.setOpen(force);
    laneHead.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { laneConv.sync(); laneConv.focus(); }
    return open;
  }
  // The head is the bar's mark: the same utterance count a badge carries, read from where the marks
  // read it, so the two cannot drift apart.
  function refreshLane() {
    if (!lane) return;
    const n = utteranceCount(docComments);
    laneCount.textContent = n ? `💬${n}` : '';
    // The document thread's count is a badge like any other, so it wears what a badge wears: the
    // colour of whoever spoke last. It used to be the one mark that did not, which made "read is the
    // speaker's colour" a rule with an exception nobody could see a reason for. While something is
    // unread the fill above outweighs this, and reading it hands the thread back to its last speaker.
    //
    const laneTint = n ? actorColorOf(lastSpeaker(docComments)) : null;
    laneCount.style.background = laneTint || '';
    laneCount.style.color = laneTint ? '#fff' : '';
    laneCount.classList.toggle('tb-tinted', !!laneTint);
    laneConv?.sync();
  }

  // ---- marks / overlays ------------------------------------------------------------------------
  // the document thread's comments, refreshed by every renderMarks. It has no mark on the page, so
  // the panel control is where its count is shown.
  let docComments = [];
  const orphanedIds = new Set();   // range ids currently orphaned — emit anchor:orphaned only on transition (§6 R1 M5)
  // place a badge on the document surface overlay (absolute within the positioned root) at the
  // top-right of a target rect — NOT inserted into the DOM, so the page layout never shifts (W-DB5V).
  function placeBadge(badge, rect, rootRect) {
    badge.style.left = (rect.right - rootRect.left) + 'px';
    badge.style.top = (rect.top - rootRect.top) + 'px';
    root.appendChild(badge);
  }
  // Resolve an author to its display color: the caller-injected category color (author.kind → color)
  // wins; otherwise a generic, deterministic per-identity hue disjoint from that map (actors.js).
  // Tackback bakes in no category semantics — 'ai'/'human'/etc. are meaningful only if mapped.
  const actorColorOf = (author) => resolveActorColor(author, actorColors, claimed);
  // Paint an anchor's badge at its NORMAL color = the color of the LAST speaker in the
  // thread (the most recent comment OR reply by timestamp) — so an anchor reads as "who touched it last".
  // Pure rendering: the "last speaker" mechanism carries no domain meaning of its own.
  function paintAnchor(node, comments) {
    const col = actorColorOf(lastSpeaker(comments));
    if (col) { node.style.background = col; node.style.color = '#fff'; }
  }
  function renderMarks() {
    const currentOrphans = new Set();
    // collect orphan/resolve decisions during the render and APPLY them after the pass — calling
    // core.reportOrphaned / core.markResolved mid-render would re-emit `change` and re-enter renderMarks
    // while we iterate. Both are idempotent, so the single post-pass re-render converges. (§6 PR #132)
    const toOrphan = [], toResolve = [];
    const markOrphan = (cs) => { for (const c of cs) { currentOrphans.add(c.id); if (!orphanedIds.has(c.id)) toOrphan.push(c); } };
    const clearOrphan = (cs) => { for (const c of cs) if (c.orphan) toResolve.push(c.id); };   // re-resolved → clear serialized orphan (REQ-004)
    regionOverlays = [];   // rebuilt below for handle hit-testing (REQ-008)
    doc.querySelectorAll('.tb-badge,.tb-region').forEach((e) => e.remove());
    unmarkHosts();   // rebuilt below; releasing through the set keeps detached elements accounted for
    ensurePositioned(root, own);                            // badges are absolute within root (the document surface)
    const rootRect = root.getBoundingClientRect();
    // a visible fallback spot for an orphan with no live anchor point — top-left of the surface, so an
    // unresolvable anchor is isolated-but-VISIBLE, never silently hidden (REQ-004).
    const orphanSpot = { right: rootRect.left + 8, top: rootRect.top + 8 };
    const byElement = new Map();   // elementId -> comments[]  (block)
    const byQuote = new Map();     // elementId\0exact\0start -> {anchor, comments[]}  (range)
    const regions = new Map();     // threadId|id -> {anchor, comments[]}
    docComments = [];              // the document thread — it has no place on the page (see below)
    for (const c of core.listComments()) {
      // group by the SINGLE thread identity an open Pane also matches against (thread.js), so a
      // badge and the conversation it opens can never disagree about what belongs together.
      const key = threadKeyOf(c);
      if (c.anchor.type === 'document') {
        // The document thread is about the whole document, so there is nowhere on the page to put a
        // badge — it is reached from the panel instead. It still RESOLVES (to the document surface),
        // so it takes part in the ordinary resolve pass below and any orphan stamped on it by an
        // older build gets cleared rather than lingering forever.
        docComments.push(c);
      } else if (c.anchor.type === 'region') {
        (regions.get(key) || regions.set(key, { anchor: c.anchor, comments: [] }).get(key)).comments.push(c);
      } else if (c.anchor.type === 'range') {
        (byQuote.get(key) || byQuote.set(key, { anchor: c.anchor, comments: [] }).get(key)).comments.push(c);
      } else if (c.anchor.type === 'block') {
        (byElement.get(key) || byElement.set(key, []).get(key)).push(c);
      }
      // an unrecognised kind is grouped nowhere — it is not silently drawn as some other kind
    }
    // the document thread resolves whenever the document surface is registered; clear any orphan an
    // older build stamped on it (a 0.9.2 session reading 0.9.3 storage would have done exactly that).
    if (docComments.length && resolveAnchorDom({ type: 'document' }, doc, core.surfaces)) clearOrphan(docComments);
    // block — badge floats at the element's top-right on the overlay (no DOM insertion → no layout shift)
    for (const comments of byElement.values()) {
      const r = resolveAnchorDom(comments[0].anchor, doc, core.surfaces);
      const badge = el(doc, 'span', 'tb-badge');
      badge.textContent = '💬' + utteranceCount(comments);
      paintAnchor(badge, comments);
      badge.__tbComments = comments;   // for the right-click delete-anchor menu
      badge.onclick = (ev) => { ev.stopPropagation(); openThread(comments, ev); };
      if (!r) {   // unresolvable block → orphaned (REQ-004): never silently dropped, shown dimmed at the surface origin
        markOrphan(comments);
        badge.classList.add('tb-orphan'); badge.title = comments[0].anchor.elementId;
        placeBadge(badge, orphanSpot, rootRect);
        continue;
      }
      clearOrphan(comments);   // resolved again → clear any stale serialized orphan
      markHost(r.element);
      const tgt = r.element.tagName === 'TR' ? (r.element.lastElementChild || r.element) : r.element;
      placeBadge(badge, tgt.getBoundingClientRect(), rootRect);
    }
    // range — resolve the quote against live text; highlight the phrase + badge. Drift → orphaned.
    const liveRanges = [];
    for (const { anchor, comments } of byQuote.values()) {
      const element = doc.getElementById(anchor.elementId);
      const hit = element ? resolveQuoteSelector(element.textContent, anchor.selector) : null;
      const range = hit ? offsetsToRange(element, hit.start, hit.end) : null;
      const badge = el(doc, 'span', 'tb-badge');
      badge.textContent = '💬' + utteranceCount(comments);
      paintAnchor(badge, comments);
      badge.__tbComments = comments;   // for the right-click delete-anchor menu
      badge.onclick = (ev) => { ev.stopPropagation(); openThread(comments, ev); };
      if (range) {
        liveRanges.push(range);
        clearOrphan(comments);   // re-resolved → clear stale serialized orphan
        placeBadge(badge, range.getBoundingClientRect(), rootRect);   // at the highlighted phrase, on the overlay
      } else {
        // drifted → orphaned (REQ-004), reported on TRANSITION only; dimmed badge at the element if present,
        // else at the surface origin — never silently hidden.
        markOrphan(comments);
        badge.classList.add('tb-orphan'); badge.title = anchor.selector.exact;
        placeBadge(badge, element ? element.getBoundingClientRect() : orphanSpot, rootRect);
      }
    }
    paintHighlights(win, liveRanges);
    for (const [, group] of regions) {
      const r = resolveAnchorDom(group.anchor, doc, core.surfaces);
      if (!r || !r.rect) {   // unresolvable region (surface gone / rect uncomputable) → orphaned (REQ-004), not silently hidden
        markOrphan(group.comments);
        const obadge = el(doc, 'span', 'tb-badge tb-orphan');
        obadge.textContent = '💬' + utteranceCount(group.comments);
        paintAnchor(obadge, group.comments);
        obadge.__tbComments = group.comments;
        obadge.title = group.anchor.surfaceId || 'region';
        obadge.onclick = (ev) => { ev.stopPropagation(); openThread(group.comments, ev); };
        placeBadge(obadge, (r && r.element) ? r.element.getBoundingClientRect() : orphanSpot, rootRect);
        continue;
      }
      clearOrphan(group.comments);   // re-resolved → clear stale serialized orphan
      // resolveAnchorDom is the single region resolver — its rect is already fallback-aware
      // (REQ-005/007), overlay px = normalized × current surface size, zoom/scroll/reflow independent.
      const px = r.rect;
      // A region bound to a sub-surface (an image/figure/canvas/PDF page that owns its own
      // coordinate space) is visually distinct from a free region on the document surface: the
      // former moves & scales WITH its surface, the latter follows the document. (Keisuke 2026-06-16)
      const boundToSurface = !!group.anchor.surfaceId && group.anchor.surfaceId !== DOCUMENT_SURFACE_ID;
      const box = el(doc, 'div', 'tb-region' + (boundToSurface ? ' tb-on-surface' : ''));
      Object.assign(box.style, { left: px.x + 'px', top: px.y + 'px', width: px.width + 'px', height: px.height + 'px' });
      // the box is hit-testable ONLY so a hover reveals the NW resize grip — clicking the body does
      // nothing (the thread opens from the anchor icon, Keisuke 2026-06-15) and it is not a move target.
      box.style.pointerEvents = 'auto';
      const grip = el(doc, 'span', 'tb-grip tb-grip-nw');   // top-left only; revealed on hover (CSS)
      box.appendChild(grip);
      // The same badge every other anchor gets, floating: left-CLICK opens the thread, left-DRAG moves
      // the region (REQ-008). It looks the same on every surface — a badge is too small to carry the
      // binding legibly, so the region border and this tooltip say it instead.
      const badge = el(doc, 'span', 'tb-badge tb-floating');
      if (boundToSurface) badge.title = `bound to surface "${group.anchor.surfaceId}" — moves & scales with it`;
      badge.textContent = '💬' + utteranceCount(group.comments);
      paintAnchor(badge, group.comments);
      badge.__tbComments = group.comments;   // for the right-click delete-anchor menu
      Object.assign(badge.style, { left: (px.x + px.width) + 'px', top: (px.y + px.height) + 'px' });
      // NOTE: opening the thread on a plain icon click is handled in endHandleDrag (a no-move pointerup),
      // not via onclick — a left-down on the badge starts a (possible) move drag, and renderMarks would
      // otherwise destroy this element before its click event fired (the "icon click does nothing" bug).
      ensurePositioned(r.element, own);
      r.element.append(box, badge);
      regionOverlays.push({ box, badge, surfaceEl: r.element, comments: group.comments });
    }
    countEl.textContent = t('panel.count', { n: utteranceCount(core.listComments()) });   // utterances, so the panel total agrees with the badges
    refreshLane();
    // The badges were just rebuilt, so whatever ring they had went with them. Asked again rather than
    // carried over — the answer lives in one place and this is a redraw, not a second opinion. Once is
    // enough: the core settles arrival and observation together, so what it answers during a redraw is
    // the settled picture rather than the middle of a turn.
    syncUnread();
    orphanedIds.clear(); for (const id of currentOrphans) orphanedIds.add(id);   // transition set for the next render (all kinds)
    // apply the collected orphan/resolve mutations AFTER the render pass (no mid-iteration re-entry).
    // reportOrphaned is idempotent + transition-guarded; markResolved is a no-op on a non-orphan — so the
    // single `change`-driven re-render this triggers converges (REQ-004; §6 PR #132 gpt-5.5 finding).
    for (const c of toOrphan) core.reportOrphaned(c);
    for (const id of toResolve) core.markResolved(id);
  }

  // ---- pane -----------------------------------------------------------------------------------
  // Everything a thread is currently shown in. One question — timelineOpen() — is asked of each,
  // rather than each kind of host being asked in its own way somewhere else.
  const hosts = new Set();
  /**
   * The ONLY way a host ends. Releasing has three parts that must not come apart: the host dies, it
   * leaves the set, and its root leaves the page. A dead host still in the set would report itself
   * unreadable forever and no test would notice, so the path is one path rather than a rule.
   */
  function releaseHost(host) {
    if (!host) return;
    const el = host.dispose();
    hosts.delete(host);
    el?.remove();
  }
  let pane = null;
  let popupCleanup = null;
  let popupHost = null;    // the host wrapping the open Pane, if any
  let popupConv = null;    // the conversation the open Pane hosts, if any
  // Every conversation currently on screen. It used to be three singleton slots, which encoded
  // "at most one, and it dies" — so adding a second, persistent host meant hand-editing every
  // broadcast site, and two of the four were missed. A registry makes the next host correct by
  // construction: hosts register, broadcasts iterate.
  const conversations = new Set();
  const broadcast = (fn) => { for (const c of [...conversations]) fn(c); };
  const drafts = new Map();   // anchor key -> { body, reaction } — unsaved input preserved across dismiss
  function anchorKey(a) {
    if (!a) return null;
    if (a.type === 'document') return 'document';
    if (a.type === 'region') return `region:${a.surfaceId}:${a.pageIndex}:${a.rect ? `${a.rect.x},${a.rect.y},${a.rect.width},${a.rect.height}` : ''}`;
    if (a.type === 'range') return `range:${a.elementId}:${a.selector?.exact ?? ''}:${a.selector?.start ?? ''}`;
    if (a.type === 'block') return `block:${a.elementId}`;
    return null;
  }
  // The pending region's lifetime IS the pane's: closing the pane (outside-click, Escape, Cancel,
  // empty save) removes the dashed rect, so no orphaned region ever lingers (Keisuke 2026-06-15).
  function closePopup() {
    popupCleanup?.(); popupCleanup = null;
    releaseHost(popupHost); popupHost = null; popupConv = null; pane = null;
    if (pendingRegionEl) { pendingRegionEl.remove(); pendingRegionEl = null; }
    doc.documentElement.classList.remove('tb-pane-open');   // region affordances (resize grip / move cursor) re-enabled
    core.reportThreadVisibility();
  }

  /**
   * What this panel is showing a reader RIGHT NOW, projected from live state each time it is asked.
   *
   * Deliberately not a ledger kept up to date at each transition: a projection that is asked one
   * moment late is merely late, while a ledger that missed one transition is wrong until something
   * else happens to correct it. Every path that changes a host only has to say "something moved",
   * and even forgetting that costs a delayed report rather than a false one.
   *
   * The registered conversations are NOT the answer — the lane keeps its conversation registered
   * while it is folded away, so that set includes a thread the reader cannot see. What is readable is
   * a Pane that is open, and a lane that is expanded.
   */
  function visibleThreads() {
    const out = [];
    const add = (key, anchor, remember) => {
      // A conversation with no identity yet — an uncommitted region — is absent rather than present
      // with nulls. It appears in the report after its first commit gives it a thread to belong to.
      if (!key || out.some((e) => e.threadKey === key)) return;
      // The OPEN SURFACE is the fact being reported; its comments are what it currently holds, and
      // holding none is an ordinary state. A block the reader has just opened has never been written
      // in, and deleting the last comment from an expanded lane does not fold the lane away — reading
      // presence out of the store would call both of those "not readable" while the reader is looking
      // straight at them, and would report the second as a closing that never happened.
      const ids = [];
      let live = null;
      for (const c of core.listComments()) {
        if (threadKeyOf(c) !== key) continue;
        if (!live) live = c.anchor;
        ids.push(c.id);
        for (const r of c.replies || []) ids.push(r.id);
      }
      // Where a thread POINTS is the store's to say for as long as the store has anything to say
      // about it: a region that was moved, or a comment replaced under the same key by an import,
      // changes its place without changing its identity, and a remembered anchor would go on naming
      // where it used to be. So it is read here, on every look, and only remembered as the answer for
      // afterwards — when the last comment is gone there is nowhere else the surface's place could
      // come from. Remembering it at a few known moments instead would mean naming every path that
      // can move an anchor, and missing one is the whole class this projection exists to avoid.
      if (live) remember?.(live);
      out.push({ threadKey: key, anchor: live || remember?.() || anchor, comments: ids });
    };
    // ONE question, asked of every host. Which kind of host it is no longer decides how to ask.
    for (const host of hosts) {
      if (!host.timelineOpen()) continue;
      add(host.identity(), host.anchorOf(), host.anchorMemo);
    }
    return out;
  }
  // ---- the conversation view --------------------------------------------------------------------
  // One thread, rendered and composed: the timeline rows, the input, the reactions, the commit
  // button, the send/pending state machine, and the reconciliation that keeps an OPEN thread up to
  // date. It lives here rather than inside the pane because a thread is not a pane — the document
  // thread gets a second surface, and both host the same conversation.
  //
  // The host supplies only what is genuinely its own: how to close, and what to clean up after a
  // commit. Everything a conversation knows about itself stays in here.
  function createConversation({ anchorLabel, existing, onSave, draftKey, threadKey: initialThreadKey = null,
                                anchor: initialAnchor = null,
                                onClose = () => {}, afterCommit = () => {} }) {
  // the thread this Pane belongs to (thread.js). A brand-new region has none until its first
  // comment exists — it is adopted below, on commit.
  let threadKey = initialThreadKey;
  // What this Pane POINTS AT, held by the surface rather than looked up from whatever comments are
  // left. A thread the reader has open is open whether or not anything is written in it yet, and
  // stays open when its last comment is deleted — so neither its identity nor its place can be
  // reconstructed from the store.
  let anchor = initialAnchor;
  let lastAuthoritative = null;   // where the store last said this thread points, for when it empties
  const draft = (draftKey != null && drafts.get(draftKey)) || null;
  let reactionId = draft?.reaction || '';
  const anchorEl = el(doc, 'div', 'tb-pane-label'); anchorEl.textContent = '📍 ' + anchorLabel;
  const ta = doc.createElement('textarea'); ta.placeholder = t('pane.placeholder');
  if (draft?.body) ta.value = draft.body;          // restore preserved input
  const rwrap = el(doc, 'div', 'tb-reactions');
  for (const def of reactions) {
    const b = doc.createElement('button');
    const { icon, label } = resolveReaction(reactions, def.id, i18n.active);
    b.textContent = `${icon} ${label}`; b.title = label;
    if (def.id === reactionId) b.classList.add('on');   // restore preserved reaction
    b.onclick = () => { reactionId = reactionId === def.id ? '' : def.id; [...rwrap.children].forEach((x) => x.classList.toggle('on', x === b && !!reactionId)); updateSaveState(); };
    rwrap.appendChild(b);
  }
  let commit = popupCommit(core.getTransport());   // save vs send + close vs stay-open (REQ-702/703)
  const exwrap = el(doc, 'div', 'tb-timeline');
  // Render the thread inline as ONE flat, TIME-ORDERED timeline (REQ-704): every utterance —
  // comment or reply — is its own row carrying its actor color + label, interleaved with the
  // region's move/resize history (REQ-009), which is an immutable record of how the anchor was
  // repositioned (Keisuke 2026-06-15).
  // NOTHING in the timeline is deletable from here (Keisuke 2026-08-05, hands-on): a per-row ✕ made
  // "delete one utterance" look like the granularity of the model, when a reply belongs to its
  // comment and goes with it — so removing a comment silently took a whole side of the conversation
  // away. Deletion is an ANCHOR-level act: right-click the anchor → Delete anchor. The core
  // deleteComment API is untouched; it is simply not an affordance the Pane offers.
  // rows re-tint live when the injected category map changes (setActorColors), so an open pane
  // never keeps showing colors from the previous map.
  const tinted = [];
  const applyTint = (r) => {
    const col = actorColorOf(r.author);
    r.row.style.borderLeft = col ? `3px solid ${col}` : '';
    r.row.style.paddingLeft = col ? '6px' : '';
    if (r.who) r.who.style.color = col || 'inherit';
  };
  const tintRow = (row, who, author) => { const r = { row, who, author }; tinted.push(r); applyTint(r); };
  const whoLabel = (author) => {
    const key = tbAuthorKey(author);
    if (!key) return null;
    const wl = el(doc, 'span', 'tb-who'); wl.textContent = `${key}: `;
    return wl;
  };
  const commentRow = (c) => {
    const row = el(doc, 'div', 'tb-c');
    const { icon } = c.reaction ? resolveReaction(reactions, c.reaction, i18n.active) : { icon: '' };
    const wl = whoLabel(c.author);
    if (wl) row.appendChild(wl);
    row.append(doc.createTextNode(`${icon ? icon + ' ' : ''}${c.body || t('pane.emojiOnly')}`));
    tintRow(row, wl, c.author);
    return row;
  };
  const replyRow = (rep) => {
    const row = el(doc, 'div', 'tb-c-reply');
    const wl = whoLabel(rep.author);
    if (wl) row.appendChild(wl);
    row.append(doc.createTextNode(rep.body || ''));
    tintRow(row, wl, rep.author);
    return row;
  };
  const eventRow = (evt) => { const er = el(doc, 'div', 'tb-ev'); er.textContent = t('event.' + evt.type); return er; };
  const events = (existing && existing[0] && existing[0].anchor && existing[0].anchor.events) || [];
  // ONE flat, time-ordered timeline (REQ-704): every comment AND every reply is its own row, appended
  // in chronological order and interleaved with the region's move/resize history — replies are NO
  // longer nested/indented under their comment; each row stands alone, attributed by actor color+label.
  // The rows on screen, in display order — the state a re-render reconciles against (thread.js
  // decides WHAT goes WHERE; this only performs the DOM insertion it asks for).
  const rows = [];              // [{ key, t, el }] in display order
  const rowByKey = new Map();
  const buildRow = (item) => (item.kind === 'event' ? eventRow(item.evt)
    : item.kind === 'reply' ? replyRow(item.rep) : commentRow(item.c));
  // REQ-702: a sent utterance is PENDING until the conversation answers it. Exactly one marker
  // exists at a time — it belongs to the latest send — and it is settled by the only resolution
  // signal the panel can observe on its own: another utterance landing in this thread (the
  // integrator can still drive its own, richer resolution through the seam).
  //
  // Timing is the whole difficulty. `addComment` delivers `change` and `comment:add` SYNCHRONOUSLY,
  // so an integrator that answers inside its `comment:add` handler has already replied by the time
  // the commit call returns — before the marker is raised. Rows drawn during a commit are therefore
  // recorded and judged once the marker exists, instead of being missed for good.
  let sendState = null;      // null | 'pending' | 'failed'
  let pendingNote = null;
  let inFlight = null;       // rows drawn while a commit is in progress
  const markSent = () => {
    pendingNote?.remove();
    pendingNote = el(doc, 'div', 'tb-pending-note');
    pendingNote.textContent = lbl('pane.pending', 'sent — awaiting reply…');
    exwrap.appendChild(pendingNote);
    sendState = 'pending';
  };
  const settleSend = (signal) => {
    if (sendState !== 'pending') return;
    sendState = nextSendState(sendState, signal);
    if (sendState === 'ok') { pendingNote?.remove(); pendingNote = null; sendState = null; }
  };
  // Rows for utterances that are no longer in the thread have to GO. Reconciliation was
  // insertion-only, which the pane survived because both destructive paths close it first; a
  // host that persists would have shown a deleted comment forever.
  const prune = (items) => {
    const live = new Set(items.map((i) => i.key));
    for (let i = rows.length - 1; i >= 0; i--) {
      if (live.has(rows[i].key)) continue;
      rows[i].el.remove();
      rowByKey.delete(rows[i].key);
      rows.splice(i, 1);
    }
  };
  const draw = (items) => {
    prune(items);
    const plan = planInsertions(rows, items);
    const drawn = plan.map((p) => p.item);
    if (inFlight) inFlight.push(...drawn);            // judged after the marker is raised
    else if (answersSend(drawn)) settleSend('reply');  // an utterance — not an anchor move — answers
    for (const { item, beforeKey } of plan) {
      const node = buildRow(item);
      const beforeEl = beforeKey ? rowByKey.get(beforeKey) : null;
      if (beforeEl) exwrap.insertBefore(node, beforeEl); else exwrap.appendChild(node);
      rowByKey.set(item.key, node);
      const at = rows.findIndex((r) => r.t.localeCompare(item.t) > 0);
      const rec = { key: item.key, t: item.t, el: node };
      if (at === -1) rows.push(rec); else rows.splice(at, 0, rec);
    }
    return plan.length;
  };
  draw(timelineItems(existing, events));
  // An OPEN thread keeps up with the conversation. Utterances arriving while the Pane is showing —
  // an answer from another participant through the addReply seam, a comment committed elsewhere in
  // the same thread — are drawn in place, at their chronological position. Rows already on screen
  // are matched by key, so this is safe to run on every change; the input box, its draft and the
  // reaction selection are never touched.
  const sync = () => {
    if (threadKey == null) return;   // nothing to group by yet (an uncommitted region)
    const group = core.listComments().filter((c) => threadKeyOf(c) === threadKey);
    // Where this thread points, captured every time the store speaks rather than only when someone
    // asks what is visible. A value that has to outlive its source must be taken no later than the
    // source disappears: move a thread and empty it before anyone looks, and reading it at looking
    // time finds nothing and falls back to a place the thread had already left. Reconciliation runs
    // on every change, so this is the last moment the answer still exists.
    if (group[0] && group[0].anchor) lastAuthoritative = group[0].anchor;
    const evts = (group[0] && group[0].anchor && group[0].anchor.events) || [];
    // an emptied thread means "remove everything", not "there is nothing to do"
    if (draw(timelineItems(group, evts))) exwrap.scrollTop = exwrap.scrollHeight;
  };
  // NOTE: there is still no inline reply BOX (Keisuke 2026-06-15: "Reply はちょっと Too Much") — a
  // reply enters through the seam (core.addReply), driven by the integrator. What changed in 0.9.1
  // is the DISPLAY: replies now render as flat, actor-labeled rows in this timeline (REQ-704), for
  // the multi-party conversation the Interplay track drives.
  const acts = el(doc, 'div', 'tb-acts');
  const cancel = btn(doc, t('pane.cancel'), 'tb-cancel');
  const save = btn(doc, commit.action === 'send' ? lbl('pane.send', 'Send') : t('pane.save'), 'tb-save');
  // The commit button greys out (disabled) whenever the input is empty — no body text AND no reaction
  // — and re-enables the instant either is present. A commit needs at least one, so an empty commit is
  // never offered (pure UX; no domain meaning). Hoisted so the reaction handlers above can call it.
  function updateSaveState() { save.disabled = !canCommit(ta.value, reactionId); }
  // Clearing what was just committed is the conversation's business. Whether the HOST then goes
  // away is the host's. These used to be one step, which was only correct while every host died on
  // commit: a host that stays kept the committed text sitting in an enabled box, ready to be sent
  // again.
  const resetComposer = () => {
    ta.value = ''; reactionId = '';
    [...rwrap.children].forEach((x) => x.classList.remove('on'));
    updateSaveState();
  };
  ta.addEventListener('input', updateSaveState);
  updateSaveState();   // initial: reflects any restored draft (body/reaction)
  // Cmd/Ctrl+Enter commits — but only when the button itself would: the keyboard path obeys the same
  // empty-commit rule, and never dismisses its host as a side effect of an empty box.
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !save.disabled) save.click(); });
  const clearDraft = () => { if (draftKey != null) drafts.delete(draftKey); };
  // preserve unsaved input on dismiss-by-outside-click / Escape; explicit Cancel discards it.
  const preserveDraft = () => {
    if (draftKey == null) return;
    if (canCommit(ta.value, reactionId)) drafts.set(draftKey, { body: ta.value, reaction: reactionId });
    else drafts.delete(draftKey);
  };
  cancel.onclick = () => { clearDraft(); onClose(); };
  save.onclick = () => {
    const body = ta.value.trim();
    if (!canCommit(body, reactionId)) { clearDraft(); return onClose(); }
    // watch what gets drawn while the commit runs: `addComment` delivers its events synchronously,
    // so an answer can arrive before this call even returns.
    inFlight = [];
    let created, drawnDuringCommit;
    try { created = onSave(body, reactionId); } finally { drawnDuringCommit = inFlight; inFlight = null; }
    clearDraft();
    afterCommit();
    // Clearing `ta.value` fires no `input` event, so the button state has to be recomputed too, or
    // it stays enabled over an empty box.
    resetComposer();
    // A brand-new region's thread identity only exists once its first comment does — adopt it now,
    // then sync. Until this point the thread had no identity to match against, so NOTHING committed
    // during it was drawn: not the utterance itself, and not an answer an integrator sent
    // synchronously. Syncing here catches both, into the same batch, so the settlement below judges
    // them as if they had arrived like any other. draw() is keyed, so nothing is drawn twice.
    if (created && threadKey == null) threadKey = threadKeyOf(created);
    if (created && created.anchor) anchor = created.anchor;   // a committed region's anchor is the real one
    inFlight = drawnDuringCommit;
    try { sync(); } finally { inFlight = null; }
    if (commit.closeOnCommit) return onClose();   // …and only now is dismissal the host's call
    markSent();
    // …and only now judge what landed during the commit. The utterance we just committed does not
    // answer itself; anything else said in this thread does — including a reply an integrator sent
    // synchronously from its `comment:add` handler, which would otherwise leave the marker waiting
    // for an answer that had already arrived.
    if (answersSend(drawnDuringCommit, created && created.id ? `c:${created.id}` : null)) settleSend('reply');
    exwrap.scrollTop = exwrap.scrollHeight;   // the newest rows are at the bottom of a scrolling thread
    ta.focus();
  };
  acts.append(cancel, save);
  // re-label in place when the locale or the transport changes (input is preserved — no rebuild)
  const relabel = () => {
    // re-derive rather than reuse what was captured at open: the transport can change under an
    // open Pane, and then Save/Send and close-vs-stay-open must both follow it.
    commit = popupCommit(core.getTransport());
    ta.placeholder = t('pane.placeholder');
    cancel.textContent = t('pane.cancel');
    save.textContent = commit.action === 'send' ? lbl('pane.send', 'Send') : t('pane.save');
    [...rwrap.children].forEach((b, idx) => {
      const def = reactions[idx]; if (!def) return;
      const { icon, label } = resolveReaction(reactions, def.id, i18n.active);
      b.textContent = `${icon} ${label}`; b.title = label;
    });
    };

    const handle = {
      nodes: [anchorEl, ta, rwrap, exwrap, acts],
      composer: [ta, rwrap, acts],   // the part a compact host keeps visible while collapsed
      timeline: exwrap,
      sync, relabel, retint: () => { for (const r of tinted) applyTint(r); },
      preserveDraft, clearDraft,
      focus: () => ta.focus(),
      // Read, never stored: a conversation adopts its identity at its first commit, so anything that
      // remembered this at construction time would name an uncommitted draft forever.
      identity: () => threadKey,
      anchorOf: () => anchor,
      // Set with a value to record the last place authority named; called with none to read it back.
      anchorMemo: (a) => { if (a) lastAuthoritative = a; return lastAuthoritative; },
      dispose: () => conversations.delete(handle),
    };
    conversations.add(handle);
    return handle;
  }

  function openPopup({ anchorLabel, existing, onSave, draftKey, threadKey: initialThreadKey = null, anchor = null, ephemeralDraft }, ev) {
    closePopup();
    pane = el(doc, 'div', 'tb-pane');
    const mine = pane;   // identity, so a Pane that replaces this one cannot be mistaken for it
    doc.documentElement.classList.add('tb-pane-open');   // lock region affordances while editing (REQ-008): no resize grip on hover, no move cursor
    const conv = createConversation({
      anchorLabel, existing, onSave, draftKey, threadKey: initialThreadKey, anchor,
      onClose: closePopup,
      // the saved region is now a committed overlay (rendered via `change`); drop the pending draft rect
      afterCommit: () => { if (pendingRegionEl) { pendingRegionEl.remove(); pendingRegionEl = null; } },
    });
    popupConv = conv;
    popupHost = createHost({ collapsible: false }, () => core.reportThreadVisibility());
    popupHost.attach(conv, pane);
    hosts.add(popupHost);
    pane.append(...conv.nodes);
    doc.body.appendChild(pane);
    core.reportThreadVisibility();
    const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
    const pos = clampToViewport(ev?.clientX ?? 120, ev?.clientY ?? 120, pane.offsetWidth, pane.offsetHeight, vw, vh);
    Object.assign(pane.style, { left: pos.x + 'px', top: pos.y + 'px' });
    conv.focus();
    // dismiss on click outside the pane or Escape. Block/range keep the unsaved draft (restorable on
    // reopen); a PENDING region is ephemeral — its rect is removed on close (REQ-012) and would never
    // recur, so its draft is DISCARDED too, per REQ-703 (Keisuke: a dismissed uncommitted region keeps
    // nothing). §6 PR #132 gpt-5.5 finding.
    const dismissPreserve = () => { if (ephemeralDraft) conv.clearDraft(); else conv.preserveDraft(); closePopup(); };
    const onDocDown = (e) => { if (pane && !e.target.closest('.tb-pane')) dismissPreserve(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); dismissPreserve(); } };
    // The same deferred-ownership shape the anchor menu has, and the reason it needs identity rather
    // than existence: `popupCleanup` holds exactly one remover, so if this Pane has been closed — or
    // REPLACED, which "is there a Pane?" cannot tell apart — by the time the deferred callback runs, whichever
    // set of listeners loses that race can never be taken off the document again.
    const register = () => {
      if (pane !== mine) return;
      doc.addEventListener('mousedown', onDocDown, true); doc.addEventListener('keydown', onKey, true);
    };
    const cancelRegister = later(register);   // deferred so the opening event doesn't self-dismiss
    popupCleanup = () => { cancelRegister(); doc.removeEventListener('mousedown', onDocDown, true); doc.removeEventListener('keydown', onKey, true); };
  }
  function openThread(comments, ev) {
    const a = comments[0].anchor;
    openPopup({ anchorLabel: anchorLabelOf(a), existing: comments, draftKey: anchorKey(a), threadKey: threadKeyOf(comments[0]), anchor: a, onSave: (body, reaction) => core.addComment({ anchor: a, body, reaction, threadId: comments[0].threadId || (a.type === 'region' || a.type === 'range' ? comments[0].id : undefined) }) }, ev);
  }
  // Open the conversation about the document as a whole. Public on the PanelInstance too, so an
  // integrator that hides the control can still reach the thread — the panel's standing rule is that
  // a hidden control never means a lost capability.
  function openDocumentThread(ev) {
    if (lane) return void toggleLane(true);   // the lane IS the document thread's surface
    const a = { type: 'document' };
    const existing = core.listComments().filter((c) => c.anchor && c.anchor.type === 'document');
    openPopup({
      anchorLabel: anchorLabelOf(a),
      existing,
      draftKey: anchorKey(a),
      threadKey: 'document',
      anchor: a,
      onSave: (body, reaction) => core.addComment({ anchor: a, body, reaction }),
    }, ev);
  }

  function anchorLabelOf(a) {
    const spec = anchorLabelSpec(a);
    if (!spec) return null;                       // an unknown kind gets no label rather than block's
    if (spec.kind === 'document') return lbl('anchor.document', 'this document');
    if (spec.kind === 'block') {
      const elx = doc.getElementById(spec.elementId);
      return (elx?.getAttribute('data-tb-section') || spec.elementId);
    }
    return spec.text;
  }

  // ---- gestures --------------------------------------------------------------------------------
  // The block/range pane opens on right-button RELEASE (pointerup), NOT on `contextmenu`. On macOS the
  // `contextmenu` event fires on right-button DOWN — before a region drag can be recognized — so opening
  // the pane there made it appear mid-drag and block the gesture (Keisuke 2026-06-15). The contextmenu
  // listener now only SUPPRESSES the native menu over content; onUp decides block/range vs region.
  const openCtxPopup = (e) => {
    if (e.target.closest('.tb-pane,.tb-console,.tb-docbar')) return;
    const elx = e.target.closest('[data-tb-anchor]');
    if (!elx) return;
    // text selected within this element → pin the phrase (range); else comment the block.
    const sel = selectionOffsetsWithin(elx, win.getSelection?.());
    let anchor, snapshot;
    if (sel) {
      const selector = buildQuoteSelector(elx.textContent, sel.start, sel.end);
      anchor = { type: 'range', elementId: elx.id, selector };
      snapshot = { section: elx.getAttribute('data-tb-section') || undefined, quote: selector.exact };
    } else {
      anchor = { type: 'block', elementId: elx.id };
    }
    openPopup({ anchorLabel: anchorLabelOf(anchor), existing: [], draftKey: anchorKey(anchor), threadKey: threadKeyOf({ anchor }), anchor, onSave: (body, reaction) => core.addComment({ anchor, body, reaction, snapshot }) }, e);
  };
  const onContext = (e) => {
    if (e.target.closest('.tb-pane,.tb-console,.tb-docbar')) return;
    // right-click ON an anchor's badge → the anchor context menu (Delete anchor), not a new
    // comment gesture. The anchor carries its comments via `__tbComments` (set in renderMarks).
    const anchorEl = e.target.closest('.tb-badge');
    if (anchorEl && anchorEl.__tbComments) { e.preventDefault(); openAnchorMenu(anchorEl.__tbComments, e); return; }
    // suppress the native menu wherever a right-click could start commenting/region work (content root or
    // a registered surface), so the OS menu never fights the gesture. The pane itself opens on pointerup.
    if (e.target.closest('[data-tb-anchor]') || e.target.closest(regionSel) || (root.contains && root.contains(e.target))) e.preventDefault();
  };
  onDoc('contextmenu', onContext);

  // A modal belongs to the panel like anything else it puts on screen: at most one at a time, and it
  // goes when the panel does.
  // They used to append unclassed children straight to the body, outside every sweep and every
  // count — so repeated clicks stacked several, and an import modal opened before teardown could
  // still write into the core afterwards.
  let modal = null;
  /**
   * Close the current modal. A modal's own dismissal passes ITSELF, because by the time it runs the
   * modal on screen may be a different one: a successful import emits `change` synchronously, and a
   * listener that opens another modal from there returns control to the import handler, which would
   * otherwise close the replacement instead of itself. Called with nothing, it closes whatever is
   * current — which is what replacing and teardown want.
   */
  function closeModal(expected) {
    if (expected !== undefined && modal !== expected) return;
    modal?.remove(); modal = null;
  }
  own(() => closePopup());
  own(() => closeAnchorMenu());
  own(() => clearHighlights(win));
  // Marks are rebuilt wholesale on every render rather than owned one by one, so they are swept.
  // `.tb-draw` is the draft rectangle of a gesture still in flight: it becomes a pending region only
  // on commit, so it is the one mark no surface owns yet.
  own(() => doc.querySelectorAll('.tb-badge,.tb-region,.tb-pending,.tb-ctxmenu,.tb-draw').forEach((e) => e.remove()));
  /**
   * Mount a modal as the one modal. `activate` runs AFTER it is in the document: focusing or
   * selecting inside a detached node does nothing, which is how making modals owned quietly broke
   * the import focus and the export select-all.
   */
  function openModal(built) {
    if (destroyed) return null;
    closeModal();
    const { node, activate, bind } = built;
    bind?.(() => closeModal(node));   // its dismissals are scoped to itself
    node.classList.add('tb-modal');
    doc.body.appendChild(node);
    modal = node;
    activate?.();
    return node;
  }
  own(() => closeModal());

  // ---- anchor context menu (right-click an anchor → Delete anchor) -----------------------------
  // A destroyed panel has had its stylesheet removed, so anything built afterwards is unstyled
  // chrome the host never asked for and has no handle to remove. Every public entry point becomes a
  // no-op rather than half-working.
  let destroyed = false;
  let anchorMenu = null, anchorMenuCleanup = null;
  function closeAnchorMenu() { anchorMenuCleanup?.(); anchorMenuCleanup = null; anchorMenu?.remove(); anchorMenu = null; }
  function openAnchorMenu(comments, ev) {
    closeAnchorMenu(); closePopup();
    anchorMenu = el(doc, 'div', 'tb-ctxmenu');
    const mine = anchorMenu;   // identity, so a menu that replaces this one cannot be mistaken for it
    const item = el(doc, 'div', 'tb-ctxitem'); item.textContent = t('menu.delete');
    item.onclick = () => { core.deleteComments(comments.map((c) => c.id)); closeAnchorMenu(); };   // ONE operation: the whole anchor
    anchorMenu.appendChild(item);
    doc.body.appendChild(anchorMenu);
    const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
    const pos = clampToViewport(ev?.clientX ?? 120, ev?.clientY ?? 120, anchorMenu.offsetWidth, anchorMenu.offsetHeight, vw, vh);
    Object.assign(anchorMenu.style, { left: pos.x + 'px', top: pos.y + 'px' });
    const onDown = (e2) => { if (anchorMenu && !e2.target.closest('.tb-ctxmenu')) closeAnchorMenu(); };
    const onKey = (e2) => { if (e2.key === 'Escape') closeAnchorMenu(); };
    // The dismiss handlers register from a DEFERRED CALLBACK, so this menu can be gone — or replaced —
    // before they do. `anchorMenuCleanup` holds exactly one remover, so whichever menu loses that
    // race would leave listeners on the document that nothing can ever take off again. Asking "is
    // there a menu?" cannot tell replaced from closed; only identity can.
    const register = () => {
      if (anchorMenu !== mine) return;
      doc.addEventListener('mousedown', onDown, true); doc.addEventListener('keydown', onKey, true);
    };
    const cancelRegister = later(register);
    anchorMenuCleanup = () => { cancelRegister(); doc.removeEventListener('mousedown', onDown, true); doc.removeEventListener('keydown', onKey, true); };
  }

  // right-drag a rectangle over a "surface" to make a region anchor. A surface is a PDF page (from
  // the pdf adapter) OR any non-text element — images, figures, svg, or anything matching the
  // configurable `regionSurfaces` selector (so you can comment on a chart/diagram/image, not just a
  // PDF). The dragged rect stays on screen as a PENDING preview while the pane is open, so you can
  // see what you selected; it becomes the saved region on save (ported from the region proto).
  // A surface must be able to host an absolutely-positioned overlay, so it's a CONTAINER element
  // (PDF page, a marked element, or a <figure> wrapping an image/diagram) — not a bare <img> (a void
  // element can't contain the overlay; wrap images in a <figure> or a [data-tb-surface] div).
  const regionSel = options.regionSurfaces || '[data-tb-page],[data-tb-surface],.tb-surface,figure';
  let surfSeq = 0, draw = null, drawEl = null, pendingRegionEl = null;
  function surfaceIdOf(surf) {
    const existing = surf.getAttribute('data-tb-surface');
    if (existing) return existing;
    if (surf.hasAttribute('data-tb-page')) return `page-${surf.getAttribute('data-tb-page')}`;
    // Prefer the element's own id (`el-<id>`) — it persists in the source, so the region re-resolves
    // after a reload via resolveAnchorDom's getElementById fallback. An id-less surface gets a
    // per-session sequence id; the data-tb-surface stamp below lets it resolve on re-render WITHIN the
    // session, but it is not reload-stable (nothing persists it) — mark the surface or give it an id.
    const id = surf.id ? `el-${surf.id}` : `tb-surf-${surfSeq++}`;
    surf.setAttribute('data-tb-surface', id);
    return id;
  }
  // existing region overlays, registered by renderMarks, for handle hit-testing (REQ-008).
  let regionOverlays = [];   // [{ box, badge, surfaceEl, comments }]
  let handleDrag = null;     // { ov, handle, startRect, surfaceEl, moved }
  const regionThreshold = options.regionThreshold ?? 8;   // px; right-drag past this = region (NFR-007)
  const moveThreshold = 3;   // px; below this an icon/grip press is a CLICK, not a move (avoids micro-move spam)

  // A left pointerdown on a region's BADGE starts a move; on its (hover-revealed) NW grip, a
  // resize (REQ-008). The box body is intentionally NOT a move target — that let drags select the
  // underlying text and the badge lagged behind. Topmost-first: last overlay wins.
  // Returns true (and suppresses the native text-selection) if a drag started.
  function startHandleDrag(e) {
    // while a comment pane is open, the region is LOCKED — no move/resize, and the anchor icon does not
    // re-trigger — so an in-progress comment is never disturbed (Keisuke 2026-06-15). Clicking elsewhere
    // dismisses the pane first (preserving the draft), then the region is interactive again.
    if (pane) return false;
    for (let i = regionOverlays.length - 1; i >= 0; i--) {
      const ov = regionOverlays[i];
      let handle = null;
      if (ov.badge && (e.target === ov.badge || ov.badge.contains?.(e.target))) handle = 'move';
      else if ((e.target === ov.box || ov.box.contains?.(e.target)) && e.target.classList?.contains('tb-grip-nw')) handle = 'nw';
      if (!handle) continue;
      const r = ov.surfaceEl.getBoundingClientRect();
      handleDrag = { ov, handle, surfaceEl: ov.surfaceEl, startRect: { ...ov.comments[0].anchor.rect }, x0: e.clientX - r.left, y0: e.clientY - r.top, pointerId: e.pointerId, captured: false };
      e.preventDefault();   // stop the browser from starting a text selection under the overlay
      return true;          // capture is taken on the first move (not here) — same contextmenu-retarget reason
    }
    return false;
  }
  function moveHandleDrag(e) {
    const hd = handleDrag, r = hd.surfaceEl.getBoundingClientRect();
    // ignore sub-threshold jitter so a plain icon/grip CLICK is not recorded as a tiny move (REQ-009 spam)
    if (!hd.moved && Math.max(Math.abs(e.clientX - r.left - hd.x0), Math.abs(e.clientY - r.top - hd.y0)) < moveThreshold) return;
    hd.moved = true;
    if (!hd.captured) { hd.captured = true; try { (doc.documentElement || hd.surfaceEl).setPointerCapture?.(hd.pointerId); } catch { /* ignore */ } }
    const dx = (e.clientX - r.left - hd.x0) / (hd.surfaceEl.clientWidth || 1);
    const dy = (e.clientY - r.top - hd.y0) / (hd.surfaceEl.clientHeight || 1);
    const next = applyHandleDrag(hd.startRect, hd.handle, dx, dy);
    if (!next) return;   // below min-size → no preview update
    const W = hd.surfaceEl.clientWidth, H = hd.surfaceEl.clientHeight;
    Object.assign(hd.ov.box.style, { left: next.x * W + 'px', top: next.y * H + 'px', width: next.width * W + 'px', height: next.height * H + 'px' });
    // keep the badge pinned to the region's SE corner so it travels with the box (never lags).
    if (hd.ov.badge) Object.assign(hd.ov.badge.style, { left: (next.x + next.width) * W + 'px', top: (next.y + next.height) * H + 'px' });
    hd._next = next;
  }
  function endHandleDrag(e) {
    const hd = handleDrag; handleDrag = null;
    try { doc.documentElement?.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const next = hd.moved ? hd._next : null;
    if (next) {
      const capture = computeCapture(hd.surfaceEl, next);
      const after = { rect: next };
      if (capture.covered.length || capture.media.length) after.capture = capture;
      // W-NWBW: re-anchor a moved/resized DOCUMENT region to its new content element — without this the
      // fallback would be dropped (appendAnchorEvent deletes a missing one) and the region would drift
      // again on the next PDF zoom, or snap back to the stale anchor. Marked/PDF surfaces stay normalized.
      const movedAnchor = hd.ov.comments[0] && hd.ov.comments[0].anchor;
      if (movedAnchor && movedAnchor.surfaceId === DOCUMENT_SURFACE_ID) {
        const fb = computeDocFallback(hd.surfaceEl, next, capture);
        if (fb) after.fallback = fb;
      }
      const type = hd.handle === 'move' ? 'move' : 'resize';
      // record the move/resize on every comment sharing this region (the shared geometry) — through
      // the engine's append-only path (REQ-008/009), never a silent re-point.
      for (const c of hd.ov.comments) { try { core.recordRegionEvent(c.id, after, type); } catch { /* skip non-region */ } }
      renderMarks();   // re-render from the recorded state
      return;
    }
    // no movement = a plain click: the anchor icon opens the thread (a grip click does nothing). We do
    // it HERE rather than via the badge's onclick, because renderMarks on a real drag would destroy it
    // before its click event fired (the "icon click does nothing" regression, Keisuke 2026-06-15).
    if (hd.handle === 'move') openThread(hd.ov.comments, e);   // a grip click is a no-op
  }

  const onPointerDown = (e) => {
    // never start a gesture on Tackback's own UI (pane/panel).
    if (e.target.closest('.tb-pane,.tb-console,.tb-docbar')) return;
    // LEFT button on a region's badge → move; on its hover-revealed NW grip → resize (REQ-008).
    // Right-drag is reserved for CREATING a region, so move/resize is left-only. A left-click that does
    // NOT drag falls through to the badge/box onclick → open thread (a no-movement handleDrag is a no-op).
    if (e.button === 0) { startHandleDrag(e); return; }
    if (e.button !== 2) return;
    // right-press ON an anchor's badge is the delete-menu gesture (handled by onContext) —
    // do NOT start a region draw from it.
    if (e.target.closest('.tb-badge')) return;
    // A region surface is a PDF page / marked element / figure, ELSE the document content root itself
    // (the default HTML surface) — so a right-drag over plain prose makes a cross-element document
    // region. Outside the content root (e.g. chrome appended elsewhere) it does not start a drag. A
    // bare right-CLICK (no drag past threshold) still falls through to onContext for block/range.
    const explicit = e.target.closest(regionSel);
    const surf = explicit || (root.contains ? (root.contains(e.target) ? root : null) : root);
    if (!surf) return;
    const r = surf.getBoundingClientRect();
    draw = { surf, x0: e.clientX - r.left, y0: e.clientY - r.top, moved: false, pointerId: e.pointerId };
    // NOTE: capture is taken in onMove once a DRAG is confirmed — NOT here. Capturing on a plain
    // right-click retargets the following `contextmenu` to the capture element, so e.target is no
    // longer the clicked block and the block/range pane never opens (the "can't comment" bug).
  };
  // W-NWBW: anchor a DOCUMENT-surface region to the content element under its top-left, in ABSOLUTE px,
  // so it tracks that content and is immune to TOTAL-page-size changes — an embedded PDF sub-surface
  // re-rendering taller on zoom must NOT move a document region (its binding is the right-drag origin's
  // content, not the whole page; Keisuke 2026-06-16). Recomputed on create AND on every move/resize so a
  // moved region re-anchors to wherever it now sits. Marked sub-surfaces (figure/panel) keep a stable
  // size and PDF pages scale uniformly, so they stay on the normalized rect (no fallback). Returns the
  // fallback {elementId,dx,dy,w,h} or null (region covers nothing identifiable → stays normalized).
  function computeDocFallback(surf, rect, capture) {
    const r = surf.getBoundingClientRect();
    const ctlx = r.left + rect.x * surf.clientWidth, ctly = r.top + rect.y * surf.clientHeight;
    // Prefer a COVERED annotatable element (guaranteed indexed id, "what the region is over"); else the
    // element under the region's top-left (a region over no text).
    const firstCovered = (capture.covered || []).find((c) => c.in);
    let aEl = (firstCovered && doc.getElementById(firstCovered.in)) || null;
    if (!aEl || !aEl.id) {
      // elementFromPoint can land on Tackback's own fixed chrome (panel, pane, lane) rather than on
      // the content the region is over; anchoring a region to the chrome would be nonsense.
      const p = doc.elementFromPoint(Math.max(0, Math.min(ctlx, (doc.documentElement.clientWidth || ctlx) - 1)),
                                     Math.max(0, Math.min(ctly, (doc.documentElement.clientHeight || ctly) - 1)));
      aEl = (p && !p.closest('.tb-console,.tb-pane,.tb-docbar') && p.closest('[id]')) || aEl;
    }
    if (!aEl || !aEl.id) return null;
    const eR = aEl.getBoundingClientRect();
    return { elementId: aEl.id, dx: ctlx - eR.left, dy: ctly - eR.top,
             w: rect.width * surf.clientWidth, h: rect.height * surf.clientHeight };
  }
  // Finalize a region draw `d` ending at (clientX,clientY): if past threshold, create the pending region
  // and open its pane (CLAMPED into the viewport so it is visible even when the drag ended off-screen,
  // Keisuke 2026-06-15). Returns true if a region was created, false otherwise (caller cleans up).
  function finalizeRegion(d, clientX, clientY) {
    const r = d.surf.getBoundingClientRect();
    const dist = Math.max(Math.abs(clientX - r.left - d.x0), Math.abs(clientY - r.top - d.y0));
    if (classifyGesture({ button: 2, dragDist: dist, threshold: regionThreshold, hasSelection: false, onSurface: true }) !== 'region') return false;
    const rect = normalizeRegion(d.x0, d.y0, clientX - r.left, clientY - r.top, d.surf.clientWidth, d.surf.clientHeight);
    if (!rect) return false;
    const pageAttr = d.surf.getAttribute('data-tb-page');
    const surfaceId = d.surf === root ? DOCUMENT_SURFACE_ID : surfaceIdOf(d.surf);
    const anchor = { type: 'region', surfaceId, rect };
    if (pageAttr != null) anchor.pageIndex = Number(pageAttr);
    const capture = computeCapture(d.surf, rect);
    if (capture.covered.length || capture.media.length) anchor.capture = capture;
    // W-NWBW: anchor a DOCUMENT-surface region to its content element in absolute px (see computeDocFallback).
    const docFb = surfaceId === DOCUMENT_SURFACE_ID ? computeDocFallback(d.surf, rect, capture) : null;
    if (docFb) anchor.fallback = docFb;
    const rectEl = drawEl; drawEl = null;
    rectEl.className = 'tb-pending';
    // openPopup clamps {clientX,clientY} into the viewport — a drag that ended below/above the visible
    // area still pops up at the nearest edge (never an invisible pane + a lingering dashed region).
    openPopup({ anchorLabel: anchorLabelOf(anchor), existing: [], draftKey: anchorKey(anchor), anchor, ephemeralDraft: true, onSave: (body, reaction) => core.addComment({ anchor, body, reaction }) }, { clientX, clientY });
    pendingRegionEl = rectEl;
    return true;
  }
  const onMove = (e) => {
    if (handleDrag) {
      if (!(e.buttons & 1)) { endHandleDrag(e); return; }   // left button released (possibly off-window) → finish the move/resize
      moveHandleDrag(e); return;
    }
    if (!draw) return;
    // right button no longer down but we never got pointerup (released OUTSIDE the window) — finalize now
    // using the last in-window position, so a drag off the edge still opens the pane (no stuck dashed rect).
    if (!(e.buttons & 2)) {
      const d = draw; draw = null;
      try { doc.documentElement?.releasePointerCapture?.(d.pointerId); } catch { /* ignore */ }
      if (!finalizeRegion(d, d.lastClientX ?? e.clientX, d.lastClientY ?? e.clientY)) { drawEl?.remove(); drawEl = null; }
      return;
    }
    const r = draw.surf.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    draw.lastClientX = e.clientX; draw.lastClientY = e.clientY;   // remembered for a missed-pointerup finalize
    draw.moved = Math.abs(x - draw.x0) > 4 || Math.abs(y - draw.y0) > 4;
    if (!draw.moved) return;
    if (!drawEl) {
      drawEl = el(doc, 'div', 'tb-draw'); ensurePositioned(draw.surf, own); draw.surf.appendChild(drawEl);
      // capture NOW (drag confirmed) so the rect tracks even if the pointer leaves the surface
      // (N1, NFR-005/007). Doing it here — not on pointerdown — keeps a plain right-click's
      // contextmenu on its real target so the block/range pane still opens.
      try { (doc.documentElement || draw.surf).setPointerCapture?.(draw.pointerId); } catch { /* ignore */ }
    }
    Object.assign(drawEl.style, { left: Math.min(x, draw.x0) + 'px', top: Math.min(y, draw.y0) + 'px', width: Math.abs(x - draw.x0) + 'px', height: Math.abs(y - draw.y0) + 'px' });
  };
  const onUp = (e) => {
    if (handleDrag) { endHandleDrag(e); return; }
    if (e.button !== 2 || !draw) return;
    const d = draw; draw = null;
    try { doc.documentElement?.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    // a right-drag past the threshold = region (finalizeRegion creates it + opens the clamped pane);
    // below threshold = a plain right-click → open the block/range pane NOW (on release), not on the
    // contextmenu-down (which fired before this).
    if (!finalizeRegion(d, e.clientX, e.clientY)) { drawEl?.remove(); drawEl = null; openCtxPopup(e); }
  };
  // if the gesture is cancelled (e.g. capture lost), still finalize from the last in-window position so
  // we never leave a stuck dashed rect with no pane.
  const onCancel = (e) => {
    if (handleDrag) { handleDrag = null; return; }
    if (!draw) return;
    const d = draw; draw = null;
    try { doc.documentElement?.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (!finalizeRegion(d, d.lastClientX ?? e.clientX, d.lastClientY ?? e.clientY)) { drawEl?.remove(); drawEl = null; }
  };
  // If the button is released OUTSIDE the window, pointerup may never be delivered — but the pointer
  // capture IS released, firing `lostpointercapture`. Finalize from the last in-window position so the
  // pane appears at the clamped viewport edge immediately, WITHOUT waiting for the cursor to come back
  // (Keisuke 2026-06-15). A window blur (focus left mid-drag) is a second fallback. Both are guarded by
  // `draw`, and are no-ops after a normal pointerup (which already set draw=null).
  const finalizeFromCaptureLoss = () => {
    if (handleDrag) { endHandleDrag({ pointerId: handleDrag.pointerId }); return; }   // a move/resize lost capture → commit what's recorded
    if (!draw) return;
    const d = draw; draw = null;
    if (!finalizeRegion(d, d.lastClientX ?? 0, d.lastClientY ?? 0)) { drawEl?.remove(); drawEl = null; }
  };
  onDoc('pointerdown', onPointerDown);
  onDoc('pointermove', onMove);
  onDoc('pointercancel', onCancel);
  onDoc('pointerup', onUp);
  onDoc('lostpointercapture', finalizeFromCaptureLoss);
  onWin('blur', finalizeFromCaptureLoss);
  const onCtxPdf = (e) => { if (e.target.closest(regionSel)) e.preventDefault(); };
  onDoc('contextmenu', onCtxPdf);

  // ---- auto-reposition: overlays follow viewport resize / zoom / surface re-render (REQ-109) ----
  // recalculateAnchors() re-renders from the normalized rects against current sizes; NFR-009 (within
  // a frame) is the manual-gate visual. A single rAF coalesces bursts so we never mix-scale a frame.
  let cancelRepaint = null;
  const queueRecalc = () => {
    if (cancelRepaint) return;
    // The scheduled work checked the CORE's lifetime, not this panel's, so a panel torn down with a
    // repaint in flight still drove one afterwards — visible when a second panel shares the core.
    cancelRepaint = laterOwned(() => { cancelRepaint = null; if (!destroyed && !core._destroyed) core.recalculateAnchors(); });
  };
  let ro = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    ro = new globalThis.ResizeObserver(queueRecalc);
    try { ro.observe(root); } catch { /* ignore */ }
    own(() => { try { ro.disconnect(); } catch { /* ignore */ } });
  }
  const vv = globalThis.visualViewport || null;
  // A software keyboard shrinks the visual viewport without moving the layout viewport, so a fixed
  // bar would sit behind it. Follow the visual viewport's bottom edge instead.
  const placeLane = () => {
    if (!lane) return;
    // MEASURE the panel rather than guessing at it: its width follows its labels, so a fixed
    // reservation is wrong the moment the locale changes or a control is toggled. The panel is
    // Tackback's own chrome, so measuring it is fair game; anything the HOST puts down there is the
    // host's to declare, via --tb-docbar-left / --tb-docbar-right.
    const panelBox = panel.getBoundingClientRect();
    const panelW = Math.ceil(panelBox.width) || 200;
    // Would sitting beside the panel leave a lane worth typing into? Don't compute it — the host's
    // own reservation (--tb-docbar-left) is part of the answer and this code cannot know it. Lay it
    // out beside, MEASURE, and step above only if what came back is too narrow to use. A 22px
    // composer is not a smaller version of the feature; it is a broken one.
    lane.style.setProperty('--tb-console-reserve', `${panelW + 16}px`);
    const { stacked } = resolveLaneLayout((tryStacked) => {
      lane.classList.toggle('tb-stacked', tryStacked);
      doc.documentElement.classList.toggle('tb-docbar-stacked', tryStacked);
      return lane.getBoundingClientRect().width;
    });
    lane.classList.toggle('tb-stacked', stacked);
    doc.documentElement.classList.toggle('tb-docbar-stacked', stacked);
    if (stacked) {
      // clear OUR chrome by measuring it; anything the host puts down there is the host's to move,
      // which the root class above lets it notice.
      const lift = Math.ceil((globalThis.innerHeight || 768) - panelBox.top) + 8;
      lane.style.setProperty('--tb-docbar-lift', `${Math.max(0, lift)}px`);
    } else {
      lane.style.setProperty('--tb-docbar-lift', '0px');
    }
    doc.documentElement.classList.toggle('tb-docbar-stacked', stacked);
    if (!vv) { lane.style.bottom = `calc(16px + env(safe-area-inset-bottom, 0px) + var(--tb-docbar-lift, 0px))`; return; }
    // a software keyboard shrinks the visual viewport without moving the layout viewport
    const hidden = Math.max(0, (globalThis.innerHeight || 0) - (vv.height + vv.offsetTop));
    lane.style.bottom = `calc(16px + env(safe-area-inset-bottom, 0px) + var(--tb-docbar-lift, 0px) + ${Math.round(hidden)}px)`;
  };
  if (vv) {
    for (const [type, fn] of [['resize', queueRecalc], ['scroll', queueRecalc], ['resize', placeLane], ['scroll', placeLane]]) {
      vv.addEventListener(type, fn);
      own(() => vv.removeEventListener(type, fn));
    }
  }
  onWin('resize', queueRecalc);
  onWin('resize', placeLane);

  // ---- wire to core + initial render -----------------------------------------------------------
  // one change → re-place the anchors, then let an open thread catch up with what was just said
  const onChange = () => { renderMarks(); broadcast((c) => c.sync()); };
  // Registering is itself the first transition, and deregistering at teardown is the last one: the
  // report that this panel is showing nothing has to be spoken by something that outlives the panel.
  own(core.registerThreadVisibility(visibleThreads));
  onCore('change', onChange);
  onCore('recalculate', renderMarks);

  /**
   * Mark every anchor whose thread holds something unread, and unmark the rest.
   *
   * The panel keeps NO record of what is unread. It asks, every time, and paints what it is told —
   * so the event path and the redraw path cannot drift, because neither of them remembers anything.
   * It is applied as a targeted toggle rather than a full renderMarks, because rebuilding every
   * overlay would throw away the elements an in-flight region drag is holding.
   */
  function syncUnread() {
    const unread = new Set(core.unreadThreads().map((e) => e.threadKey));
    doc.querySelectorAll('.tb-badge').forEach((node) => {
      const cs = node.__tbComments;
      if (cs && cs.length) node.classList.toggle('tb-unread', unread.has(threadKeyOf(cs[0])));
    });
    // The document thread has nowhere on the page to be marked, so the lane wears it — the one host
    // that carries its own indicator, which is a fact about this caller rather than about hosts.
    if (lane) lane.classList.toggle('tb-unread', unread.has('document'));
  }
  onCore('unread:change', syncUnread);
  onCore('transport:change', () => broadcast((c) => c.relabel()));   // Save ⇄ Send, live, on every host
  if (lane) buildLaneConversation();   // late: the factory closes over drafts/reactions declared above
  if (lane) placeLane();
  onCore('ready', () => { hintEl.textContent = core.surfaces.size ? t('hint.pdf') : t('hint.html'); renderMarks(); });
  renderMarks();

  // ---- PanelInstance ---------------------------------------------------------------------------
  return {
    setTheme(theme) { if (destroyed) return; currentTheme = theme; applyTheme(theme); if (themeBtn) themeBtn.textContent = themeLabel(); },
    setReactions(defs) { if (destroyed) return; reactions.length = 0; reactions.push(...defs); },
    // Update the injected category→color map live (the integrator owns the mapping; Tackback just
    // applies it to the last-speaker tint). Pass `{}` to clear back to the generic per-identity hues.
    setActorColors(map) { if (destroyed) return; actorColors = { ...(map || {}) }; claimed = claimedColors(actorColors); renderMarks(); broadcast((c) => c.retint()); },
    setLocale(lang) { if (destroyed) return false; const ok = i18n.setLocale(lang); relabel(); return ok; },
    registerLocale(lang, bundle) { if (destroyed) return; i18n.register(lang, bundle); },
    toggleMarks() { if (destroyed) return; doc.documentElement.classList.toggle('tb-hide'); },
    /** Open the conversation about the document as a whole — the lane when it is on, else a Pane. */
    openDocumentThread() { if (destroyed) return; openDocumentThread(); },
    /** Expand or collapse the document lane. Returns its resulting state (false when it is off). */
    toggleDocumentBar(force) { return destroyed ? false : toggleLane(force); },
    destroy() {
      if (destroyed) return;   // idempotent: a second teardown must not re-run releases
      destroyed = true;
      // Deliberately names nothing. Every surface and every resource registered how to let go of
      // itself at the point it was taken; this runs that record, newest first.
      disposeOwned();
    },
  };

  function relabel() {
    if (authorInput) authorInput.placeholder = t('panel.authorPlaceholder');
    if (exportBtn) exportBtn.textContent = t('panel.export');
    if (marksBtn) marksBtn.textContent = t('panel.toggleMarks');
    if (clearBtn) clearBtn.textContent = t('panel.clearAll');
    if (laneTitle) laneTitle.textContent = t('panel.docBar');
    placeLane();   // labels changed width, so the reservation did too
    refreshLane();
    if (themeBtn) themeBtn.textContent = themeLabel();
    hintEl.textContent = core.surfaces.size ? t('hint.pdf') : t('hint.html');
    broadcast((c) => c.relabel());   // every conversation on screen follows the locale change
    renderMarks();
  }
}

// ---- tiny DOM helpers ----
function el(doc, tag, cls) { const e = doc.createElement(tag); if (cls) e.className = cls; return e; }
function btn(doc, text, cls) { const b = el(doc, 'button', cls); b.textContent = text; return b; }
/**
 * Give a host element a positioning context so an absolutely-placed overlay lands inside it. The
 * element belongs to the host, so the write is recorded and handed back: restored only if it is still
 * the value we wrote, because the host may have set its own since.
 */
function ensurePositioned(elx, own) {
  const pos = getComputedStyle(elx).position;
  if (pos !== 'static') return;
  const prev = elx.style.position;
  elx.style.position = 'relative';
  own?.(() => { if (elx.style.position === 'relative') elx.style.position = prev; });
}
// Author → color and "who spoke last" live in ./actors.js (DOM-free, unit-tested), imported above.

// Import modal: paste an exported envelope and merge it in (REQ-204). Merge + skip-on-conflict so an
// incoming envelope ADDS comments (an AI participant's anchored replies/contributions) without
// overwriting existing ones. The core emits `change`, so the panel re-renders the new comments in place.
function importModal(doc, core, t) {
  let close = () => {};
  const m = el(doc, 'div'); Object.assign(m.style, { position: 'fixed', inset: '0', zIndex: 10001, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  const box = el(doc, 'div'); Object.assign(box.style, { background: 'var(--tb-pane-bg,#fff)', color: 'var(--tb-pane-fg,#111)', borderRadius: '10px', padding: '16px', width: 'min(720px,92vw)', font: '13px system-ui' });
  const ta = doc.createElement('textarea'); ta.placeholder = t('import.placeholder'); Object.assign(ta.style, { width: '100%', height: '52vh', boxSizing: 'border-box', font: '12px ui-monospace,monospace' });
  const msg = el(doc, 'div'); Object.assign(msg.style, { font: '12px system-ui', minHeight: '16px', color: 'var(--tb-accent,#06c)' });
  const load = btn(doc, t('import.load'));
  const cancel = btn(doc, t('pane.cancel') || 'Cancel', 'tb-sec');
  cancel.onclick = () => close();
  load.onclick = () => {
    let env;
    try { env = JSON.parse(ta.value); } catch (e) { msg.style.color = '#c00'; msg.textContent = t('import.badJson'); return; }
    try {
      const res = core.importEnvelope(env, { mode: 'merge', onConflict: 'skip' });
      close();
    } catch (e) { msg.style.color = '#c00'; msg.textContent = (e && e.message) || String(e); }
  };
  const bar = el(doc, 'div'); bar.style.textAlign = 'right'; bar.style.marginTop = '8px'; bar.append(cancel, load);
  box.append(ta, msg, bar); m.appendChild(box);
  m.onclick = (e) => { if (e.target === m) close(); };
  // Focus AFTER the node is in the document — focusing a detached element does nothing.
  return { node: m, activate: () => ta.focus(), bind: (fn) => { close = fn; } };
}

function exportModal(doc, envelope) {
  let close = () => {};
  const json = JSON.stringify(envelope, null, 2);
  globalThis.navigator?.clipboard?.writeText?.(json).catch(() => {});
  const m = el(doc, 'div'); Object.assign(m.style, { position: 'fixed', inset: '0', zIndex: 10001, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  const box = el(doc, 'div'); Object.assign(box.style, { background: 'var(--tb-pane-bg,#fff)', color: 'var(--tb-pane-fg,#111)', borderRadius: '10px', padding: '16px', width: 'min(720px,92vw)', font: '13px system-ui' });
  const ta = doc.createElement('textarea'); ta.readOnly = true; ta.value = json; Object.assign(ta.style, { width: '100%', height: '52vh', boxSizing: 'border-box', font: '12px ui-monospace,monospace' });
  const closeBtn = btn(doc, 'Close'); closeBtn.onclick = () => close();
  const bar = el(doc, 'div'); bar.style.textAlign = 'right'; bar.style.marginTop = '8px'; bar.appendChild(closeBtn);
  box.append(ta, bar); m.appendChild(box);
  m.onclick = (e) => { if (e.target === m) close(); };
  // Selecting inside a detached node selects nothing, so this runs once it is mounted.
  return { node: m, activate: () => { ta.focus(); ta.select(); }, bind: (fn) => { close = fn; } };
}
