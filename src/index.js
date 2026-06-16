// @brainworker/tackback — public entry point.
//
// The headless anchored-comment engine: mount an instance, add/update/delete comments anchored to a
// document (block / range / region), subscribe to changes, import/export JSON. Zero dependencies,
// zero network — a separate @brainworker/tackback/panel adds the default UI, @brainworker/tackback/pdf adds PDF rendering.

export { Tackback } from './core/engine.js';
export { TackbackError } from './core/errors.js';

// Anchor algebra + storage adapters, exposed for headless/custom integrations.
export {
  normalizeRegion, regionToPx, buildQuoteSelector, resolveQuoteSelector, MIN_REGION_PX,
} from './core/anchor.js';
export { localStorageAdapter, memoryAdapter } from './core/storage.js';
export { buildEnvelope, parseEnvelope } from './core/export.js';
export { createComment, createReply, migrateLegacyComment, isValidAnchor } from './core/model.js';
// Replay: merge N exported envelopes (multi-author) into one timeline-ordered model (REQ-505).
export { buildReplayModel } from './core/replay.js';
