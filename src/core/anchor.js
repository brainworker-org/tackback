// @brainworker/tackback — anchor math & resolution (pure, DOM-free).
//
// These functions take plain numbers/strings, never DOM, so they unit-test headlessly and pin the
// clamp + zoom-independent overlay behavior, plus the range-quote resolution.
// DOM-side resolution (getElementById, surface lookup) lives in the engine; this is the algebra.

/** Minimum drawn size (px) below which a region drag is treated as a non-drag. */
export const MIN_REGION_PX = 8;

const clamp = (v, hi) => Math.max(0, Math.min(hi, v));

/**
 * Normalize a drawn rectangle (two endpoints, page-local px) into a 0..1 NormalizedRect. BOTH
 * endpoints are clamped into the page first, so a drag that ends off-page still yields a valid
 * 0..1 anchor (no negative / >1 coords).
 * @returns {{x:number,y:number,width:number,height:number}|null} null if degenerate (< MIN_REGION_PX).
 */
export function normalizeRegion(x0, y0, x1, y1, W, H) {
  if (W <= 0 || H <= 0) return null;
  const ax = clamp(x0, W), ay = clamp(y0, H);
  const bx = clamp(x1, W), by = clamp(y1, H);
  const left = Math.min(ax, bx), top = Math.min(ay, by);
  const w = Math.abs(bx - ax), h = Math.abs(by - ay);
  if (w < MIN_REGION_PX || h < MIN_REGION_PX) return null;
  return { x: left / W, y: top / H, width: w / W, height: h / H };
}

/**
 * Reconstruct a NormalizedRect into page-local px against the CURRENT rendered surface size.
 * overlay px = normalized × current size → zoom/scroll independent.
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function regionToPx(rect, W, H) {
  return { x: rect.x * W, y: rect.y * H, width: rect.width * W, height: rect.height * H };
}

/**
 * Reflow fallback (REQ-007): the region's top-left offset from a nearby stable element, in
 * normalized surface units, captured at draw time. `el` is that element's normalized rect on the
 * same surface. Storing the OFFSET (not an absolute position) is what lets the region ride along
 * when reflow moves the element — see applyRegionFallback.
 * @param {{x:number,y:number}} rect   the region's normalized top-left
 * @param {{x:number,y:number}} el     the fallback element's normalized top-left
 * @returns {{dx:number,dy:number}}
 */
export function regionFallbackOffset(rect, el) {
  return { dx: rect.x - el.x, dy: rect.y - el.y };
}

/**
 * Correct a region's normalized top-left under reflow: the fallback element has moved to `el` (its
 * current normalized top-left), so the region rides to `el + offset`. Width/height are unchanged
 * (reflow moves content, it doesn't rescale the surface). Returns the corrected position only.
 * @param {{x:number,y:number}} el     the fallback element's CURRENT normalized top-left
 * @param {number} dx
 * @param {number} dy
 * @returns {{x:number,y:number}}
 */
export function applyRegionFallback(el, dx, dy) {
  return { x: el.x + dx, y: el.y + dy };
}

/**
 * Do two normalized rects overlap? Used by capture (which covered elements does a region touch).
 * Edge-touching (zero-area overlap) is NOT covered.
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Move an index off the middle of a surrogate pair, always by SHRINKING the span it bounds.
 *
 * A character outside the BMP is two code units, and a `slice` that lands between them keeps half of
 * one — a lone surrogate. The text still looks fine locally: `JSON.stringify` escapes it and
 * `TextEncoder` swaps in U+FFFD, so nothing throws here. It breaks at the other end, where a strict
 * UTF-8 encoder refuses it, and what a reader sees is a comment that was never sent and never
 * complained. Rounding INWARD (a shorter quote, a shorter context) can only lose one character of
 * disambiguation; rounding outward would grow the span past what the reader selected.
 *
 * @param {string} text
 * @param {number} i     the index to move
 * @param {1|-1} inward  +1 to move forward (a span's start), -1 to move back (a span's end)
 * @returns {number}
 */
function onCodePointBoundary(text, i, inward) {
  if (i <= 0 || i >= text.length) return i;
  const before = text.charCodeAt(i - 1);
  // i splits a pair only when the unit just before it is a HIGH surrogate and the one at it is LOW.
  if (before >= 0xD800 && before <= 0xDBFF) {
    const at = text.charCodeAt(i);
    if (at >= 0xDC00 && at <= 0xDFFF) return i + inward;
  }
  return i;
}

/**
 * Build a TextQuoteSelector from a selected substring and its surrounding text (W3C Web Annotation
 * shape). `prefix`/`suffix` disambiguate repeated phrases; `start`/`end` are a positional fallback.
 *
 * Every edge is rounded to a code-point boundary (DI-004): the quote's own two, and the outer edge of
 * each context window. Text with no astral characters is untouched — the rounding only moves an index
 * that would have split a pair.
 *
 * @param {string} fullText  the container's textContent
 * @param {number} start     selection start offset within fullText
 * @param {number} end       selection end offset
 * @param {number} [ctx]     prefix/suffix context length (chars)
 * @returns {{exact:string,prefix:string,suffix:string,start:number,end:number}}
 */
export function buildQuoteSelector(fullText, start, end, ctx = 24) {
  let s = onCodePointBoundary(fullText, start, 1);        // the quote starts one unit later
  let e = onCodePointBoundary(fullText, end, -1);         // and ends one unit earlier
  // A span covering only PART of one character has nothing left to shrink to, and an empty quote
  // resolves to nothing at all. Take the whole character instead — it is what was on screen.
  if (e <= s) {
    s = onCodePointBoundary(fullText, start, -1);
    e = onCodePointBoundary(fullText, end, 1);
  }
  const pre = onCodePointBoundary(fullText, Math.max(0, s - ctx), 1);
  const suf = onCodePointBoundary(fullText, Math.min(fullText.length, e + ctx), -1);
  return {
    exact: fullText.slice(s, e),
    prefix: fullText.slice(pre, s),
    suffix: fullText.slice(e, suf),
    start: s,
    end: e,
  };
}

/**
 * Resolve a TextQuoteSelector against the container's text. Strategy: prefer the unique
 * `prefix+exact` match; fall back to the positional offset; return null (→ orphaned) rather than
 * silently mis-anchoring. (drift fails loud, never points at the wrong text.)
 * @param {string} fullText
 * @param {{exact:string,prefix?:string,suffix?:string,start?:number,end?:number}} sel
 * @returns {{start:number,end:number}|null}
 */
export function resolveQuoteSelector(fullText, sel) {
  if (!sel.exact) return null;
  // 1. prefix+exact (+suffix) — the disambiguating match. Require it to be UNIQUE: if the same
  // context appears more than once we cannot tell which occurrence was meant, so fall through
  // rather than silently anchoring to the first — drift must fail loud.
  if (sel.prefix != null) {
    const needle = sel.prefix + sel.exact + (sel.suffix ?? '');
    const at = fullText.indexOf(needle);
    if (at !== -1 && fullText.indexOf(needle, at + 1) === -1) {
      const start = at + sel.prefix.length;
      return { start, end: start + sel.exact.length };
    }
  }
  // 2. unique exact occurrence.
  const first = fullText.indexOf(sel.exact);
  if (first !== -1 && fullText.indexOf(sel.exact, first + 1) === -1) {
    return { start: first, end: first + sel.exact.length };
  }
  // 3. positional fallback — only if the text there still matches exactly.
  if (typeof sel.start === 'number' && typeof sel.end === 'number' &&
      fullText.slice(sel.start, sel.end) === sel.exact) {
    return { start: sel.start, end: sel.end };
  }
  return null; // orphaned — caller emits anchor:orphaned, degrades to a block mark.
}
