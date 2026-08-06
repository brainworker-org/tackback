// @brainworker/tackback/panel — pure interaction logic (DOM-free), so the gesture/handle/popup
// DECISIONS are headlessly testable (REQ-006/008/702/703). The DOM WIRING (PointerEvent listeners,
// rendering) lives in panel/index.js and calls these; only the real-pointer reliability (NFR-005)
// and the visual reposition budget (NFR-009) are the manual-gate residue. Keeping the decisions pure
// is why a MUST gets a real test instead of a "deferred" matrix row (see memory: spec-first RED tests).

/**
 * Classify a right-button gesture into the anchor kind it should produce (REQ-006). A drag past the
 * threshold over a surface = region; otherwise it is a DOM anchor — a live text selection → range,
 * none → block. Returns 'none' when it is not a right-button interaction at all.
 * @param {{ button:number, dragDist:number, threshold:number, hasSelection:boolean, onSurface:boolean }} g
 * @returns {'region'|'range'|'block'|'none'}
 */
export function classifyGesture({ button, dragDist, threshold, hasSelection, onSurface }) {
  if (button !== 2) return 'none';
  if (onSurface && dragDist >= threshold) return 'region';   // right-drag past threshold over a surface
  return hasSelection ? 'range' : 'block';                   // below threshold → DOM anchor
}

/**
 * The popup's commit behavior for the current transport descriptor (REQ-702/703). With no transport
 * the action is *save* and the popup closes on commit; with a transport it is *send*; an
 * `interactive:true` transport keeps the popup open as a conversation (then shows pending → failed),
 * a fire-and-forget transport closes. These are SEMANTIC actions (localized by the caller).
 * @param {{ interactive?: boolean } | null | undefined} transport
 * @returns {{ action:'save'|'send', closeOnCommit:boolean, conversation:boolean }}
 */
export function popupCommit(transport) {
  if (!transport) return { action: 'save', closeOnCommit: true, conversation: false };
  const conversation = !!transport.interactive;
  return { action: 'send', closeOnCommit: !conversation, conversation };
}

/**
 * Whether the popup's commit button is enabled: a commit needs SOMETHING — body text or a reaction —
 * so an empty commit is never offered. Whitespace-only text does not count. Pure UX, no domain
 * meaning. The same rule re-runs after an interactive (stay-open) commit clears the inputs, so the
 * button cannot stay enabled over an empty conversation box.
 * @param {string|null|undefined} body
 * @param {string|null|undefined} reactionId
 * @returns {boolean}
 */
export function canCommit(body, reactionId) {
  return !!((body && String(body).trim()) || reactionId);
}

/**
 * Whether a batch of newly drawn timeline rows answers a send that is waiting (REQ-702).
 *
 * Two things do NOT answer a send. An anchor move/resize is a record of the anchor being dragged
 * about, not something anyone said — a region nudged while a send is outstanding must not clear the
 * marker. And the send's own committed utterance cannot answer itself: it is drawn as soon as the
 * commit lands, before the marker even exists.
 * @param {Array<{kind?: string, key?: string}>} items   rows drawn in this batch
 * @param {string|null} [ownKey]                         the key of the utterance just committed
 * @returns {boolean}
 */
export function answersSend(items, ownKey = null) {
  return (items || []).some((i) => (i.kind === 'comment' || i.kind === 'reply') && i.key !== ownKey);
}

/**
 * Choose whether the document lane sits beside the panel or above it, given a way to measure what
 * each choice would produce.
 *
 * The input is not stable on its own: a host declares how much room the lane may have, and a
 * well-behaved host CHANGES that declaration when told the lane had to stack. Deciding from one
 * measurement therefore produces a good frame and a two-state flicker on the next event.
 *
 * The fix is not to iterate but to measure each candidate UNDER ITS OWN STATE, so the host's answer
 * is already folded into both numbers. The decision is then a pure function of two measurements and
 * gives the same result every time it is asked. Beside wins when it is wide enough to type into;
 * otherwise above — including when neither fits, since removing the panel's reservation is the only
 * lever there is. The two widths are not compared: `fits` reports whether the chosen one was enough.
 * @param {(stacked: boolean) => number} measure   width the lane would have in that state
 * @param {{ min?: number }} [opts]
 * @returns {{ stacked: boolean, width: number, fits: boolean }}
 */
export function resolveLaneLayout(measure, { min = 320 } = {}) {
  const beside = measure(false);
  if (beside >= min) return { stacked: false, width: beside, fits: true };
  const above = measure(true);
  return { stacked: true, width: above, fits: above >= min };
}

/** The next state of a sent comment in an interactive conversation (REQ-702): pending → ok | failed. */
export function nextSendState(current, signal) {
  if (signal === 'ack' || signal === 'reply') return 'ok';
  if (signal === 'error' || signal === 'timeout') return 'failed';   // never an indefinite hang
  return current || 'pending';
}

const HANDLES = ['nw', 'ne', 'sw', 'se'];

/**
 * Hit-test a point (page-local px) against a region's resize handles, then its body (REQ-008,
 * topmost-first: corners win over the body). Returns the handle id, 'move' for the body, or null.
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,width:number,height:number}} rectPx   region overlay in page px
 * @param {number} [handleSize]
 * @returns {'nw'|'ne'|'sw'|'se'|'move'|null}
 */
export function handleAt(px, py, rectPx, handleSize = 10) {
  const h = handleSize, { x, y, width: w, height: ht } = rectPx;
  const near = (cx, cy) => Math.abs(px - cx) <= h && Math.abs(py - cy) <= h;
  if (near(x, y)) return 'nw';
  if (near(x + w, y)) return 'ne';
  if (near(x, y + ht)) return 'sw';
  if (near(x + w, y + ht)) return 'se';
  if (px >= x && px <= x + w && py >= y && py <= y + ht) return 'move';
  return null;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Apply a move/resize drag to a normalized rect (REQ-008): a corner handle resizes that corner; 'move'
 * translates. dx/dy are NORMALIZED deltas (px delta ÷ surface size). The result is clamped into
 * [0,1] and rejected (null) if it would fall below `minSize` (the zero-area guard) — the caller then
 * does NOT record an event. Never silently produces an out-of-bounds or zero rect.
 * @param {{x:number,y:number,width:number,height:number}} rect  normalized
 * @param {'nw'|'ne'|'sw'|'se'|'move'} handle
 * @param {number} dx @param {number} dy   normalized deltas
 * @param {number} [minSize]               normalized minimum width/height
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function applyHandleDrag(rect, handle, dx, dy, minSize = 0.01) {
  let { x, y, width: w, height: h } = rect;
  if (handle === 'move') {
    x = clamp01(x + dx); y = clamp01(y + dy);
    if (x + w > 1) x = 1 - w;
    if (y + h > 1) y = 1 - h;
    return { x, y, width: w, height: h };
  }
  // resize: adjust the dragged edges, keep the opposite edges fixed.
  let left = x, top = y, right = x + w, bottom = y + h;
  if (handle === 'nw') { left = x + dx; top = y + dy; }
  if (handle === 'ne') { right = x + w + dx; top = y + dy; }
  if (handle === 'sw') { left = x + dx; bottom = y + h + dy; }
  if (handle === 'se') { right = x + w + dx; bottom = y + h + dy; }
  left = clamp01(left); right = clamp01(right); top = clamp01(top); bottom = clamp01(bottom);
  const nw = right - left, nh = bottom - top;
  if (nw < minSize || nh < minSize) return null;   // zero-area / below-min → rejected (REQ-008)
  return { x: left, y: top, width: nw, height: nh };
}
