// @brainworker/tackback/pdf — coordinate algebra (pure, DOM-free, headlessly testable).
//
// A region is stored as a PDF-page-NORMALIZED rect (0..1). These two functions are the surface's
// coordinate transform: client-space selection → normalized (store), and normalized → page-local px
// against the CURRENT rendered size (overlay). Keeping them pure pins the zoom-independence:
// change the scale and the same normalized rect reconstructs to the right box.

import { regionToPx } from '../core/anchor.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Normalize a client-space rectangle into 0..1 coords relative to a surface's bounds. Both `rect`
 * and `bounds` are DOMRect-compatible ({ left, top, width, height }). The result is clamped to
 * [0,1] so a selection that overflows the page edge still yields a valid anchor (mirrors the core's
 * `normalizeRegion` clamp). Returns a zero rect for a degenerate surface rather than NaN.
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{left:number,top:number,width:number,height:number}} bounds
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function toNormalizedAgainst(rect, bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  // Clamp BOTH endpoints and derive width/height from the clamped corners, so a selection that
  // overflows an edge is CLIPPED to the visible page rather than keeping the off-surface extent
  const left = clamp01((rect.left - bounds.left) / bounds.width);
  const top = clamp01((rect.top - bounds.top) / bounds.height);
  const right = clamp01((rect.left + rect.width - bounds.left) / bounds.width);
  const bottom = clamp01((rect.top + rect.height - bounds.top) / bounds.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Reconstruct a normalized rect into page-local px against the current surface size, returned as a
 * DOMRect in the browser or a DOMRect-shaped plain object when headless.
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {number} W  current surface width (px)
 * @param {number} H  current surface height (px)
 * @returns {DOMRect|{x:number,y:number,width:number,height:number,left:number,top:number,right:number,bottom:number}}
 */
export function fromNormalizedToRect(rect, W, H) {
  const px = regionToPx(rect, W, H);
  if (typeof DOMRect === 'function') return new DOMRect(px.x, px.y, px.width, px.height);
  return {
    x: px.x, y: px.y, width: px.width, height: px.height,
    left: px.x, top: px.y, right: px.x + px.width, bottom: px.y + px.height,
  };
}
