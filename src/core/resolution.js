// @brainworker/tackback — the single shared resolution module (spec REQ-014, divergence D-E).
//
// ONE DOM-walk contract, used identically by interactive creation, recalculateAnchors(), and
// import/replay — so an anchor created one way resolves the same way everywhere. It owns three
// things the spec calls out as the contract:
//   1. the annotatable NODE SET (which elements can carry a block/range comment),
//   2. block-id DERIVATION (an element's own id, else a deterministic id stable across a reload of
//      the same document — produced by the same walk on every path so all paths agree),
//   3. TEXT NORMALIZATION (the canonical string a range's quote selector indexes into = the
//      element's `textContent`, the exact indexing build/resolveQuoteSelector operate on).
//
// It is DOM-aware but takes `root`/`doc` as arguments (never reaches for a global), so it is
// headlessly testable with the same fake-DOM the rest of the suite uses. The quote-selector and
// region ALGEBRA stay in ./anchor.js (pure, DOM-free); this module is the DOM walk that drives them.

import { regionToPx, resolveQuoteSelector, applyRegionFallback, rectsIntersect } from './anchor.js';
import { DOCUMENT_SURFACE_ID } from './media.js';

/** The annotatable node set: elements that can carry a block/range comment. The ONE definition.
 *  h1 (the document title) IS annotatable — a reviewer must be able to comment on the title itself
 *  (PR #132 review, Keisuke comment 9a). h1 is also a HEADING; the walk sets it as the current
 *  section before assigning its own id, so a title's section context is itself (harmless for a title). */
export const ANNOTATABLE = 'h1,h2,h3,h4,p,li,blockquote,tr';
/** Headings that supply nearest-section context to the elements that follow them. */
export const HEADINGS = 'h1,h2,h3,h4';

/** A small deterministic string hash (FNV-1a, 32-bit → 8 hex). Stable across runs and paths. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The block-id for an annotatable element: its author-supplied id when present, else a CONTENT-bound
 * derived id `tb-<hash(tagName + normalized text)>`. Content-bound, NOT positional — so the same
 * block keeps its id when other content is inserted/removed around it (drift-stable across edits),
 * and a block whose text changed or was deleted no longer hashes the same, so an imported/replayed
 * anchor ORPHANS instead of silently re-pointing at a different element that merely landed in the old
 * position (REQ-002/004; §6 review R5, PR #132 — a positional ordinal could silently mis-anchor on a
 * fresh load after an insertion). Duplicate-content blocks are disambiguated by occurrence in
 * indexAnnotatable. Because the hash is pure, every resolution path (create/recalc/import/replay)
 * derives the identical id (REQ-014/D-E).
 * @param {Element} el
 * @returns {string}
 */
export function deriveBlockId(el) {
  if (el.id) return el.id;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return `tb-${hash32((el.tagName || '') + ' ' + text)}`;
}

/**
 * Walk `root` once in document order, assigning every annotatable element a stable id (REQ-002 via
 * deriveBlockId) and its nearest-heading section context. Idempotent: an element that already has an
 * id keeps it, so re-running over the same tree is a no-op for identity. This is THE walk every path
 * shares (REQ-014) — interactive creation calls it on mount, recalculateAnchors re-runs it, and
 * import/replay runs it before resolving imported anchors so the derived ids line up.
 * @param {Element} root
 */
export function indexAnnotatable(root) {
  let lastHeading = null;
  // Pre-collect every id already in the document (author ids + derived ids from a prior walk). A
  // derived id must never COLLIDE with an existing one: if two elements shared an id, getElementById
  // would silently resolve an existing anchor to the WRONG element instead of orphaning under drift.
  // Each id-less element gets its CONTENT-bound id (deriveBlockId), disambiguated by an occurrence
  // suffix when a document has duplicate-content blocks or an author-id clash. (§6 review, PR #132.)
  const taken = new Set();
  for (const el of root.querySelectorAll('*')) if (el.id) taken.add(el.id);
  for (const el of root.querySelectorAll('*')) {
    if (el.matches(HEADINGS)) lastHeading = el;
    if (el.matches(ANNOTATABLE)) {
      if (!el.id) {
        // content-bound base id (drift-stable); disambiguate duplicate content / an author-id clash
        // by appending an occurrence suffix until free — never reuse an id already in the document.
        const base = deriveBlockId(el);
        let id = base, k = 1;
        while (taken.has(id)) id = `${base}-${k++}`;
        el.id = id;
        taken.add(id);
      }
      el.setAttribute('data-tb-anchor', '1');
      el.setAttribute('data-tb-section', lastHeading ? lastHeading.textContent.trim() : '');
    }
  }
}

/**
 * The canonical text a range anchor indexes into: an element's `textContent` (the exact string
 * build/resolveQuoteSelector were built against, and that panel/range.js' offset math matches).
 * Centralized here so every path normalizes text the same way (REQ-014, text-normalization contract).
 * @param {Element} el
 * @returns {string}
 */
export function normalizeText(el) {
  return el.textContent ?? '';
}

/**
 * Resolve a range anchor against the live DOM to character offsets within its element's text.
 * Returns null (→ orphaned, never a guess) when the element is gone or the quote no longer resolves
 * (REQ-003/004). DOM-to-Range mapping for painting lives in panel/range.js; this is the headless,
 * shared "where does the quote land now" decision.
 * @param {Document} doc
 * @param {{elementId:string, selector:import('./model.js').TextQuoteSelector}} anchor
 * @returns {{ element: Element, start: number, end: number } | null}
 */
export function resolveRange(doc, anchor) {
  const element = doc.getElementById(anchor.elementId);
  if (!element) return null;
  const hit = resolveQuoteSelector(normalizeText(element), anchor.selector);
  if (!hit) return null;
  return { element, start: hit.start, end: hit.end };
}

/** Media-bearing elements a region can cover (raster/vector/embeds), for the capture's media refs. */
const MEDIA = 'img,canvas,svg,video,picture,object';

/**
 * The default surface-relative measurer: an element's normalized rect (0..1 of the surface's content
 * box) from live geometry. Injectable (tests pass a fake measure) so the walk is headlessly testable.
 * @param {Element} surfaceEl
 * @returns {(el: Element) => {x:number,y:number,width:number,height:number}}
 */
export function boundingMeasure(surfaceEl) {
  const s = surfaceEl.getBoundingClientRect();
  const W = s.width || 1, H = s.height || 1;
  return (el) => {
    const r = el.getBoundingClientRect();
    return { x: (r.left - s.left) / W, y: (r.top - s.top) / H, width: r.width / W, height: r.height / H };
  };
}

/**
 * Capture what a region covers, for legibility (REQ-010): the text of covered annotatable elements +
 * refs to covered media. Covered = the element's normalized rect intersects the region rect. Text is
 * capped (count + per-entry length) so capture never bloats a comment (NFR-006 "capture capped").
 * The hit test is normalized-rect intersection (zoom-independent); a browser may refine text to a
 * per-char-center test, but the contract — "lists covered text/media, media-only when raster-only" —
 * holds here and headlessly.
 * @param {Element} surfaceEl                         the surface the region is normalized against
 * @param {{x:number,y:number,width:number,height:number}} rect   normalized region rect
 * @param {{ measure?: (el: Element) => any, maxCovered?: number, maxChars?: number }} [opts]
 * @returns {import('./model.js').Capture}
 */
export function computeCapture(surfaceEl, rect, opts = {}) {
  const measure = opts.measure || boundingMeasure(surfaceEl);
  const maxCovered = opts.maxCovered ?? 12;
  const maxChars = opts.maxChars ?? 280;
  /** @type {{in:string,text:string}[]} */
  const covered = [];
  /** @type {string[]} */
  const media = [];
  for (const el of surfaceEl.querySelectorAll(ANNOTATABLE)) {
    if (covered.length >= maxCovered) break;
    if (!rectsIntersect(measure(el), rect)) continue;
    const text = normalizeText(el).trim();
    if (text) covered.push({ in: el.id || '', text: text.slice(0, maxChars) });
  }
  const mediaRef = (el) => el.getAttribute('src') || el.getAttribute('data-tb-media') || el.id || el.tagName.toLowerCase();
  // the surface element ITSELF may be the media (a stamped <img>/<canvas> used directly as the
  // surface, not a container) — querySelectorAll only sees descendants, so include self when it is
  // media (the region is always within the surface, so it is always covered). (§6 review R4, PR #132.)
  if (surfaceEl.matches && surfaceEl.matches(MEDIA)) {
    const ref = mediaRef(surfaceEl);
    if (ref) media.push(ref);
  }
  for (const el of surfaceEl.querySelectorAll(MEDIA)) {
    if (!rectsIntersect(measure(el), rect)) continue;
    const ref = mediaRef(el);
    if (ref && !media.includes(ref)) media.push(ref);
  }
  return { covered, media };
}

/**
 * Resolve a region anchor to a normalized rect against the CURRENT DOM, applying the reflow fallback
 * (REQ-007) when present: if the fallback element resolves, the region rides to the element's current
 * position + the stored offset (reflow moved the content, so the element-relative anchor is the
 * reflow-stable truth); width/height are unchanged. Falls back to the stored rect when there is no
 * fallback or its element is gone. Returns null when the surface itself is gone (→ orphaned).
 * @param {import('./model.js').RegionAnchor} anchor
 * @param {Element} surfaceEl
 * @param {(el: Element) => {x:number,y:number,width:number,height:number}} [measure]
 * @returns {{ rect:{x:number,y:number,width:number,height:number}, px:{x:number,y:number,width:number,height:number} } | null}
 */
export function resolveRegionRect(anchor, surfaceEl, measure) {
  if (!surfaceEl) return null;
  let rect = anchor.rect;
  const fb = anchor.fallback;
  // ELEMENT-ANCHORED region (document surface, W-NWBW): position & size are stored in ABSOLUTE px
  // relative to a content element (`fb.w` present marks this form). The region tracks that element, so
  // a change to the surface's TOTAL size — e.g. an embedded PDF sub-surface re-rendering taller on zoom
  // — never moves it (only the element's own movement does). This is why a `document` region must NOT
  // ride the PDF's scale: its binding is the content under the right-drag ORIGIN, not the whole page
  // (Keisuke 2026-06-16). The normalized `rect` is kept for portability + the orphan path.
  if (fb && fb.elementId && fb.w != null) {
    const fbEl = surfaceEl.ownerDocument ? surfaceEl.ownerDocument.getElementById(fb.elementId) : null;
    if (fbEl) {
      const sRect = surfaceEl.getBoundingClientRect();
      const eRect = fbEl.getBoundingClientRect();
      const px = { x: (eRect.left - sRect.left) + fb.dx, y: (eRect.top - sRect.top) + fb.dy, width: fb.w, height: fb.h };
      const W = surfaceEl.clientWidth || 1, H = surfaceEl.clientHeight || 1;
      return { rect: { x: px.x / W, y: px.y / H, width: px.width / W, height: px.height / H }, px };
    }
    // element gone → fall through to the stored normalized rect (orphan-safe)
  }
  if (fb && fb.elementId) {
    const m = measure || boundingMeasure(surfaceEl);
    const fbEl = surfaceEl.ownerDocument ? surfaceEl.ownerDocument.getElementById(fb.elementId) : null;
    if (fbEl) {
      const pos = applyRegionFallback(m(fbEl), fb.dx, fb.dy);
      rect = { x: pos.x, y: pos.y, width: anchor.rect.width, height: anchor.rect.height };
    }
  }
  const W = surfaceEl.clientWidth, H = surfaceEl.clientHeight;
  return { rect, px: regionToPx(rect, W, H) };
}

// Find an element by an EXACT attribute value without ever building a selector from the value.
// The selector uses only the fixed attribute name, so an untrusted value can't make querySelector
// throw (region surfaceId/pageIndex arrive from imported envelopes and are caller-asserted).
function findByAttr(doc, attr, value) {
  for (const el of doc.querySelectorAll(`[${attr}]`)) {
    if (el.getAttribute(attr) === value) return el;
  }
  return null;
}

/**
 * Resolve an anchor to { element, rect? }. `rect` (page-local px against the current rendered size,
 * zoom/scroll independent) is present for region anchors. Returns null when the target is gone — the
 * caller treats null as orphaned (REQ-004) rather than guessing.
 * @param {import('./model.js').Anchor} anchor
 * @param {Document} doc
 * @param {Map<string, any>} surfaces
 * @returns {{ element: Element, rect?: {x:number,y:number,width:number,height:number} } | null}
 */
export function resolveAnchorDom(anchor, doc, surfaces) {
  if (anchor.type === 'block' || anchor.type === 'range') {
    const element = doc.getElementById(anchor.elementId);
    return element ? { element } : null;
  }
  // document — the whole document surface IS the place. Resolving here rather than treating a
  // document anchor as place-less is what keeps it an ordinary anchor: it resolves whenever the
  // surface is registered, so it takes part in the normal resolve/orphan lifecycle instead of
  // needing an exception to it. No rect: the anchor is the surface, not a rectangle on it.
  if (anchor.type === 'document') {
    const element = surfaces.get(DOCUMENT_SURFACE_ID)?.element;
    return element ? { element } : null;
  }
  if (anchor.type !== 'region') return null;   // an unknown kind resolves to nothing; it never
                                               // borrows another kind's resolution by falling through
  // region — resolve the surface element. Reload-stable resolution order: (1) a live adapter surface
  // (PDF), (2) a stamped/consumer-marked [data-tb-surface], (3) an `el-<id>` surfaceId back to the
  // element's own id (so a region on an id'd <figure> survives a reload — the runtime data-tb-surface
  // stamp is gone but the element id persists), (4) a PDF page by index. An unmarked, id-less surface
  // gets a per-session sequence id (panel surfaceIdOf) and is in-session only — by design.
  const surface = surfaces.get(anchor.surfaceId);
  const sid = anchor.surfaceId != null ? String(anchor.surfaceId) : null;
  const element = surface?.element
    || (sid != null ? findByAttr(doc, 'data-tb-surface', sid) : null)
    || (sid != null && sid.startsWith('el-') ? doc.getElementById(sid.slice(3)) : null)
    || (anchor.pageIndex != null ? findByAttr(doc, 'data-tb-page', String(anchor.pageIndex)) : null);
  if (!element) return null;
  // ONE region-resolution path: delegate the rect to resolveRegionRect so the shared resolver is
  // fallback-aware too (REQ-005/007) — a caller using resolveAnchorDom must not get a stale,
  // non-fallback rect that disagrees with resolveRegionRect after reflow (§6 review R3, PR #132).
  const rr = resolveRegionRect(anchor, element);
  return { element, rect: rr ? rr.px : regionToPx(anchor.rect, element.clientWidth, element.clientHeight) };
}
