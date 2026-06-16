// @brainworker/tackback/panel — range (text-selection) DOM bridge.
//
// The quote-selector ALGEBRA lives in @brainworker/tackback (build/resolveQuoteSelector, headlessly
// tested). This module is the DOM half the headless core can't own: turn a live Selection into
// character offsets within an element's textContent (the same indexing the selectors use), map
// offsets back to a DOM Range, and paint matches via the CSS Custom Highlight API — which needs NO
// DOM mutation, so teardown is one delete and overlapping highlights never corrupt text offsets.

export const HIGHLIGHT_NAME = 'tb-range';

/**
 * Character offset of (node, nodeOffset) within `root`, computed with a Range so it matches
 * `root.textContent` indexing exactly (what build/resolveQuoteSelector operate on).
 */
function offsetWithin(root, node, nodeOffset) {
  const r = root.ownerDocument.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, nodeOffset);
  return r.toString().length;
}

/**
 * If `sel` holds a non-collapsed selection lying fully inside `root`, return its `{start,end}`
 * character offsets within `root.textContent`; otherwise null (caller falls back to a block anchor).
 * @param {Element} root
 * @param {Selection|null} sel
 * @returns {{start:number,end:number}|null}
 */
export function selectionOffsetsWithin(root, sel) {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = offsetWithin(root, range.startContainer, range.startOffset);
  const end = offsetWithin(root, range.endContainer, range.endOffset);
  if (end <= start) return null;
  return { start, end };
}

/**
 * Map `[start,end)` character offsets within `root` back to a live DOM Range over its text nodes.
 * Returns null if the offsets fall outside the current text (drifted) — caller treats as orphaned.
 * @param {Element} root
 * @param {number} start
 * @param {number} end
 * @returns {Range|null}
 */
export function offsetsToRange(root, start, end) {
  const doc = root.ownerDocument;
  // Use the document's own NodeFilter (cross-realm safe — the current global may lack it).
  const SHOW_TEXT = (doc.defaultView && doc.defaultView.NodeFilter && doc.defaultView.NodeFilter.SHOW_TEXT)
    || (typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4);
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  let acc = 0, startNode = null, startOff = 0, endNode = null, endOff = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (startNode === null && acc + len >= start) { startNode = node; startOff = start - acc; }
    if (acc + len >= end) { endNode = node; endOff = end - acc; break; }
    acc += len;
  }
  if (!startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

/**
 * Paint the given DOM ranges via the CSS Custom Highlight API. Returns false when unsupported (the
 * caller then degrades to a per-element badge — the comment is never lost, only the inline tint).
 * @param {Window} win
 * @param {Range[]} ranges
 * @returns {boolean}
 */
export function paintHighlights(win, ranges) {
  const cssRef = win && win.CSS;
  if (!cssRef || !cssRef.highlights || typeof win.Highlight !== 'function') return false;
  if (ranges.length === 0) { cssRef.highlights.delete(HIGHLIGHT_NAME); return true; }
  cssRef.highlights.set(HIGHLIGHT_NAME, new win.Highlight(...ranges));
  return true;
}

/** Remove the tackback highlight registration (idempotent, support-safe). */
export function clearHighlights(win) {
  win && win.CSS && win.CSS.highlights && win.CSS.highlights.delete(HIGHLIGHT_NAME);
}
