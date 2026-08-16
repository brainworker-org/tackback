// @brainworker/tackback/panel — DOM helpers + the panel's view onto the shared resolution module.
//
// Anchor → live-DOM resolution (the annotatable node set, block-id derivation, range/region
// resolution) lives in the ONE shared module @brainworker/tackback core/resolution.js (spec REQ-014,
// divergence D-E) so the panel, recalculateAnchors(), and import/replay all resolve identically.
// This file re-exports that surface for the panel's existing call sites and keeps the genuinely
// panel-only helper (pane viewport clamping) here.

export {
  ANNOTATABLE,
  HEADINGS,
  indexAnnotatable,
  deriveBlockId,
  resolveRange,
  resolveAnchorDom,
} from '../core/resolution.js';

/** Clamp a pane box within the viewport. (Panel-only: depends on the pane box, not on anchors.) */
export function clampToViewport(x, y, w, h, vw, vh) {
  return { x: Math.max(8, Math.min(x, vw - w - 12)), y: Math.max(8, Math.min(y, vh - h - 12)) };
}

// ---- badge placement: the corner, then the frame ------------------------------------------------
// Where a badge goes used to be worked out in two places that looked alike and were not: a block or
// range badge from the difference of two client rects, a region badge from a normalized rect scaled
// against its surface. Same property names, different frames of reference, and nothing in the code
// said so. These two functions are the one path both take, split the way the question splits — which
// corner of the anchor, and whose coordinate space the answer is in.
//
// A frame of reference travels WITH the numbers here, and resolving a point against an origin from a
// different frame throws. That is not defensive dressing: `getBoundingClientRect` is relative to the
// visual viewport on at least one shipping engine, while the panel's clamped surfaces are handed
// innerWidth/innerHeight, which is the layout viewport. Two frames already meet in this file.

/**
 * The point on a box that a badge is hung from.
 * @param {{left:number,top:number,right:number,bottom:number,frame:string}} box
 * @param {'right-top'|'right-bottom'} corner
 * @returns {{x:number,y:number,frame:string}}
 */
export function cornerOf(box, corner) {
  if (!box || typeof box.frame !== 'string') throw new TypeError('cornerOf: the box must name its frame');
  if (corner !== 'right-top' && corner !== 'right-bottom') {
    throw new TypeError(`cornerOf: unknown corner ${corner}`);
  }
  return { x: box.right, y: corner === 'right-bottom' ? box.bottom : box.top, frame: box.frame };
}

/**
 * Re-express a point in the coordinate space of the element it will be placed inside. The origin is
 * that element's own position, given in the SAME frame as the point.
 * @param {{x:number,y:number,frame:string}} point
 * @param {{x:number,y:number,frame:string}} parentOrigin
 * @returns {{x:number,y:number,frame:'parent-content'}}
 */
export function toParentSpace(point, parentOrigin) {
  if (!point || !parentOrigin) throw new TypeError('toParentSpace: both a point and an origin are required');
  if (point.frame !== parentOrigin.frame) {
    throw new TypeError(
      `toParentSpace: the point is in frame "${point.frame}" and the origin is in frame ` +
      `"${parentOrigin.frame}" — one of the two is measured against something else`,
    );
  }
  return { x: point.x - parentOrigin.x, y: point.y - parentOrigin.y, frame: 'parent-content' };
}
