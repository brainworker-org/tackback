// @brainworker/tackback/panel — DOM helpers + the panel's view onto the shared resolution module.
//
// Anchor → live-DOM resolution (the annotatable node set, block-id derivation, range/region
// resolution) lives in the ONE shared module @brainworker/tackback core/resolution.js (spec REQ-014,
// divergence D-E) so the panel, recalculateAnchors(), and import/replay all resolve identically.
// This file re-exports that surface for the panel's existing call sites and keeps the genuinely
// panel-only helper (popup viewport clamping) here.

export {
  ANNOTATABLE,
  HEADINGS,
  indexAnnotatable,
  deriveBlockId,
  resolveRange,
  resolveAnchorDom,
} from '../core/resolution.js';

/** Clamp a popup box within the viewport. (Panel-only: depends on the popup box, not on anchors.) */
export function clampToViewport(x, y, w, h, vw, vh) {
  return { x: Math.max(8, Math.min(x, vw - w - 12)), y: Math.max(8, Math.min(y, vh - h - 12)) };
}
