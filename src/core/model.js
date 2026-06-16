// @brainworker/tackback — the comment model: types, factory, validation, legacy migration.
//
// The data model is the seam shared with anything downstream (replay tooling, an AI, the Interplay
// backend). It is intentionally explicit: an opaque `id` distinct from `createdAt`, a nested
// `anchor` whose discriminator (`type`) is always present, and `reaction` stored as a stable id
// (the icon/meaning live in config, so changing the icon never breaks the binding).

import { newId } from './id.js';

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} NormalizedRect  // each 0..1 of the surface
 * @typedef {{ exact: string, prefix?: string, suffix?: string, start?: number, end?: number }} TextQuoteSelector
 * @typedef {{ in: string, text: string }} CoveredText
 * @typedef {{ covered?: CoveredText[], media?: string[] }} Capture  // what a region covered, for legibility (spec REQ-010)
 * @typedef {{ rect: NormalizedRect, fallback?: RegionFallback, capture?: Capture }} RegionState
 * @typedef {{ ts: string, type: 'create'|'move'|'resize', before?: RegionState, after: RegionState }} AnchorEvent  // append-only history (spec REQ-009)
 * @typedef {{ elementId: string, dx: number, dy: number }} RegionFallback  // nearest stable element + offset (HTML reflow, spec REQ-007)
 * @typedef {{ type: 'block',  elementId: string }} BlockAnchor
 * @typedef {{ type: 'range',  elementId: string, selector: TextQuoteSelector }} RangeAnchor
 * @typedef {{ type: 'region', surfaceId: string, pageIndex?: number, rect: NormalizedRect, fallback?: RegionFallback, events?: AnchorEvent[], capture?: Capture }} RegionAnchor
 * @typedef {BlockAnchor | RangeAnchor | RegionAnchor} Anchor
 * @typedef {string | { id: string, kind?: 'human'|'ai'|string }} Author  // string (legacy/simple) or provenance object (spec REQ-301)
 * @typedef {Object} Reply
 * @property {string} id
 * @property {string} body
 * @property {Author} [author]
 * @property {string} createdAt
 * @typedef {Object} Comment
 * @property {string} id
 * @property {Anchor} anchor
 * @property {string} body
 * @property {string} [reaction]    // reaction id (resolved to icon/meaning via config)
 * @property {Author|null} [author]
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {string} [threadId]
 * @property {Reply[]} [replies]     // conversation under this comment, ordered by createdAt (spec REQ-307)
 * @property {{ section?: string, quote?: string }} [snapshot]
 * @property {{ since: string, lastError?: string }} [orphan]  // serialized orphan state (spec REQ-004)
 * @typedef {{ anchor: Anchor, body: string, reaction?: string, author?: Author|null, threadId?: string, replies?: Reply[], snapshot?: Comment['snapshot'] }} AddCommentInput
 * @typedef {{ body: string, author?: Author }} AddReplyInput
 */

const ANCHOR_TYPES = new Set(['block', 'range', 'region']);

/**
 * Validate an anchor shape (cheap structural check; not a DOM existence check).
 * @param {unknown} a
 * @returns {a is Anchor}
 */
export function isValidAnchor(a) {
  if (!a || typeof a !== 'object') return false;
  const anchor = /** @type {any} */ (a);
  if (!ANCHOR_TYPES.has(anchor.type)) return false;
  const nonEmpty = (s) => typeof s === 'string' && s.length > 0;
  if (anchor.type === 'block') return nonEmpty(anchor.elementId);
  if (anchor.type === 'range') {
    return nonEmpty(anchor.elementId) && anchor.selector && nonEmpty(anchor.selector.exact);
  }
  // region — finite, non-negative, in-bounds normalized rect.
  const r = anchor.rect;
  if (!nonEmpty(anchor.surfaceId) || !r) return false;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  return fin(r.x) && fin(r.y) && fin(r.width) && fin(r.height) &&
    r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 &&
    r.x + r.width <= 1.0001 && r.y + r.height <= 1.0001;   // tiny epsilon for fp rounding
}

/**
 * Build a Comment from caller-supplied data. The library owns `id` and `createdAt` — callers never
 * mint identity or timestamps.
 * @param {AddCommentInput} input
 * @param {string} now  ISO timestamp (injected, so this stays pure/testable)
 * @returns {Comment}
 */
export function createComment(input, now) {
  /** @type {Comment} */
  const c = { id: newId(), anchor: input.anchor, body: input.body ?? '', createdAt: now };
  if (input.reaction) c.reaction = input.reaction;
  if (input.author !== undefined) c.author = input.author;
  if (input.threadId) c.threadId = input.threadId;
  if (input.replies && input.replies.length) c.replies = input.replies.slice();
  if (input.snapshot) c.snapshot = input.snapshot;
  return c;
}

/**
 * Build a Reply (the conversation under a comment, spec REQ-307). Like createComment, the library owns
 * `id` and `createdAt`; the caller supplies only body + optional author (provenance). The engine's
 * `addReply` appends the result to a comment's `replies[]`.
 * @param {AddReplyInput} input
 * @param {string} now  ISO timestamp (injected for purity/testability)
 * @returns {Reply}
 */
export function createReply(input, now) {
  /** @type {Reply} */
  const r = { id: newId(), body: input.body ?? '', createdAt: now };
  if (input.author !== undefined) r.author = input.author;
  return r;
}

/**
 * Migrate a legacy (v1) comment record — the flat `{ ts, elementId, kind?, page, regionId, rect:{nx,…},
 * emoji, comment }` shape produced by the original feedback-panel — into a v2 Comment. Identity is
 * preserved (legacy `ts` becomes both `id` and `createdAt`) so cross-rev references survive.
 * @param {any} legacy
 * @returns {Comment}
 */
export function migrateLegacyComment(legacy) {
  /** @type {Anchor} */
  let anchor;
  if (legacy.kind === 'region') {
    anchor = {
      type: 'region',
      surfaceId: `page-${legacy.page}`,
      pageIndex: legacy.page,
      rect: { x: legacy.rect.nx, y: legacy.rect.ny, width: legacy.rect.nw, height: legacy.rect.nh },
    };
  } else {
    // legacy block (kind omitted) — the original panel anchored ranges by elementId too.
    anchor = { type: 'block', elementId: legacy.elementId };
  }
  /** @type {Comment} */
  const c = { id: legacy.ts, anchor, body: legacy.comment ?? '', createdAt: legacy.ts };
  if (legacy.emoji) c.reaction = legacy.emoji;       // legacy stored the emoji char; resolves literally
  if (legacy.author !== undefined) c.author = legacy.author;
  if (legacy.regionId) c.threadId = legacy.regionId;
  if (legacy.section || legacy.snippet) c.snapshot = { section: legacy.section, quote: legacy.snippet };
  return c;
}

/** A record is legacy if it has the old `ts` identity and no v2 `id`. */
export function isLegacyComment(rec) {
  return rec && typeof rec === 'object' && typeof rec.ts === 'string' && typeof rec.id !== 'string';
}

// ---- region anchor-event history & orphan state (spec REQ-009/010/004) -----------------------

/**
 * Deep-copy a RegionState (rect + optional fallback + optional capture, incl. each covered item) so a
 * stored event can never share a mutable reference with the caller's input — the append-only history
 * must be tamper-proof against later mutation of the source object (§6 review, PR #132).
 * @param {RegionState} s
 * @returns {RegionState}
 */
function copyRegionState(s) {
  /** @type {RegionState} */
  const c = { rect: { ...s.rect } };
  if (s.fallback) c.fallback = { ...s.fallback };
  if (s.capture) c.capture = { covered: (s.capture.covered || []).map((x) => ({ ...x })), media: (s.capture.media || []).slice() };
  return c;
}

/**
 * Snapshot a region anchor's current state for the history (the `after` of a create event, or the
 * `before` of the next move/resize). Deep-copies rect/fallback/capture so a later mutation can't
 * reach back into a stored event.
 * @param {RegionAnchor} anchor
 * @returns {RegionState}
 */
export function regionStateOf(anchor) {
  return copyRegionState(anchor);
}

/**
 * Append a move/resize to a region anchor's append-only history and advance its current
 * rect/fallback/capture to the `after` state — NEVER a silent overwrite (REQ-008/009). The first
 * call (an empty/absent history) seeds a `create` event (timestamped `createTs`) so the original
 * placement is in the log. Returns a NEW anchor object; the prior events are preserved so history is
 * never lost. Each event keeps its own capture so "what was pointed at when" stays legible (REQ-010).
 * Clocks are injected (this stays pure/testable): `ts` is the move/resize time, `createTs` the
 * comment's createdAt for the seeded create event.
 * @param {RegionAnchor} anchor             the current region anchor
 * @param {'move'|'resize'} type
 * @param {RegionState} after               the new rect (+ optional fallback/capture)
 * @param {string} ts                       ISO time of this move/resize
 * @param {string} createTs                 ISO time to stamp the seeded create event (comment.createdAt)
 * @returns {RegionAnchor}
 */
export function appendAnchorEvent(anchor, type, after, ts, createTs) {
  const events = (anchor.events || []).slice();
  const before = regionStateOf(anchor);
  if (events.length === 0) events.push({ ts: createTs, type: 'create', after: before });
  // deep-copy `after` before it enters the append-only log / current state — never retain the
  // caller's mutable reference, or a later mutation of the input could corrupt stored history (§6).
  const afterCopy = copyRegionState(after);
  events.push({ ts, type, before, after: afterCopy });
  /** @type {RegionAnchor} */
  const next = { ...anchor, rect: { ...afterCopy.rect }, events };
  if (afterCopy.fallback) next.fallback = { ...afterCopy.fallback }; else delete next.fallback;
  if (afterCopy.capture) next.capture = afterCopy.capture; else delete next.capture;
  return next;
}

/** Mark a comment's anchor as an orphan — a SERIALIZED state (REQ-004): it stays listed + exportable. */
export function markOrphan(comment, since, lastError) {
  return { ...comment, orphan: lastError != null ? { since, lastError } : { since } };
}

/** Clear a comment's orphan state (it re-resolved on a later recalc/import). */
export function clearOrphan(comment) {
  if (!comment.orphan) return comment;
  const next = { ...comment };
  delete next.orphan;
  return next;
}
