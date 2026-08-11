// @brainworker/tackback — the comment model: types, factory, validation, legacy migration.
//
// The data model is the seam shared with anything downstream (replay tooling, an AI, a downstream integration
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
 * @typedef {{ type: 'document' }} DocumentAnchor   // the document AS A WHOLE — see isValidAnchor
 * @typedef {BlockAnchor | RangeAnchor | RegionAnchor | DocumentAnchor} Anchor
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
 * @typedef {{ anchor: Anchor, body: string, reaction?: string, author?: Author|null, threadId?: string, replies?: AddReplyInput[], snapshot?: Comment['snapshot'] }} AddCommentInput
 *   `replies` is what a reply is ASKED for, not what one looks like once stored — the id and the
 *   timestamp are the library's to give, here as everywhere. Requiring them of a caller asked for two
 *   values that are then discarded, and told a typed caller they could choose an identity they cannot.
 * @typedef {{ body: string, author?: Author }} AddReplyInput
 */

/**
 * The shared file: a document's comments, self-describing enough to be read somewhere else. It is
 * declared here, next to what it carries, because it is the shape two published functions name.
 *
 * `deleted` is a list of ids the producer says are GONE — an envelope that both lists an id and
 * buries it is contradicting itself, and the burial is the fresher fact.
 *
 * What is deliberately NOT here: anything about one reader. What has arrived and how far somebody has
 * got are facts about an environment, and this is a file people send each other.
 * @typedef {object} ExportEnvelope
 * @property {1} schemaVersion
 * @property {{ name: string, version: string }} generator
 * @property {{ id: string, revisionHash?: string, [k: string]: any }} document
 * @property {string} exportedAt
 * @property {Author|null} exportedBy
 * @property {Comment[]} comments
 * @property {string[]} [deleted]
 * @property {Array<{ id: string, [k: string]: any }>} [reactions]
 * @property {Array<{ id: string, [k: string]: any }>} [surfaces]
 */

const ANCHOR_TYPES = new Set(['block', 'range', 'region', 'document']);

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
  // document — a conversation about the whole document rather than a place inside it. It carries no
  // coordinates because its place IS the document surface (see resolveAnchorDom): the instance
  // already knows which document it is mounted on, so the anchor has nothing left to say. Nothing to
  // validate beyond the type, and nothing that can drift.
  if (anchor.type === 'document') return true;
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
 * The identity of the THREAD an utterance belongs to. This is the SINGLE definition of "one
 * conversation" — anchor marks group by it, an open Pane matches against it, and the unread cursor
 * is kept per thread, so a badge, the thread it opens and what counts as read can never disagree
 * about what belongs together.
 *
 * A region thread is identified by its `threadId` (its root comment's id), NOT by its geometry: two
 * regions can be drawn over the same rectangle, and a region's rectangle changes when it is moved,
 * so geometry is neither unique nor stable. Block and range threads are identified by the place they
 * point at, which is exactly what makes them the same thread.
 *
 * It lives here rather than with the panel because the core now derives from it too. The panel's
 * `thread.js` re-exports this one — the definition is not copied, because two answers to "is this
 * the same conversation" is precisely the disagreement this function exists to prevent.
 * @param {Comment|{anchor:object}|null|undefined} comment
 * @returns {string|null} null when there is no usable identity yet (e.g. an uncommitted region)
 */
export function threadKeyOf(comment) {
  const a = comment && comment.anchor;
  if (!a) return null;
  // The document as a whole is ONE conversation per instance — the mount is already scoped to a
  // single document, so the anchor needs nothing further to identify its thread.
  if (a.type === 'document') return 'document';
  if (a.type === 'region') {
    const id = comment.threadId || comment.id;
    return id ? `region:${id}` : null;
  }
  if (a.type === 'range') {
    const s = a.selector || {};
    return `range:${a.elementId}\u0000${s.exact ?? ''}\u0000${s.start ?? ''}`;
  }
  if (a.type === 'block') return `block:${a.elementId}`;
  // An unrecognised kind gets NO identity rather than borrowing block's. This dispatch used to end in
  // a bare `return block:...`, so any kind this build did not know about became `block:undefined` —
  // every such comment silently collapsing into one imaginary shared thread.
  return null;
}

/**
 * THE entry validation for everything that arrives from outside — an import envelope and a storage
 * adapter's stored document alike. One implementation, because the two boundaries ask the same
 * question and two answers to it would differ somewhere nobody was looking.
 *
 * What it enforces is what everything downstream is allowed to assume: **every utterance that
 * reaches the store has a non-empty string id, unique across the document, and never changes which
 * thread it belongs to.** Those are not conveniences — the unread cursor is per thread and compares
 * arrival numbers by id, so an utterance that changes threads is read as already-seen in its new one
 * and an id used twice makes "which utterance is this" unanswerable. Both break silently.
 *
 * Rejected entries are dropped and REPORTED; the caller emits one error per fault. A reply that is
 * lost only because its root was rejected is collateral: it is dropped, but it is not a second fault.
 *
 * @param {any[]} comments the entries as they arrived
 * @param {object} [opts]
 * @param {Map<string, {threadKey: string|null, reply: boolean}>|null} [opts.known] utterances already
 *   resident, by id. Supplied by the import path so an entry cannot re-anchor an existing utterance
 *   or take an id that is already someone else's. Restoration has nothing resident yet.
 * @param {Set<string>|null} [opts.doomed] ids the same envelope also buries. A tombstone wins: an
 *   envelope that calls one id both dead and alive is contradicting itself, and deleting a row to
 *   re-insert the same identity elsewhere is not how an utterance moves.
 * @param {boolean} [opts.checkAnchor] require a usable anchor. The import path does; restoration does
 *   not, because a stored anchor of a kind this build does not know is a downgrade artefact rather
 *   than corruption, and is already rendered as unplaceable rather than dropped.
 * @returns {{ comments: any[], dropped: number, faults: Array<{kind: 'identity'|'anchor'|'tombstone', message: string}> }}
 *   Each refusal carries a KIND, because the two modes owe them different answers: an identity fault
 *   makes a whole replacement unsafe, an unusable anchor is the malformed-file case the import already
 *   refused before this existed, and an entry the same envelope buries is not a fault in the envelope
 *   at all — it is the envelope being read correctly.
 */
export function sanitizeComments(comments, opts = {}) {
  const known = opts.known || null;
  const doomed = opts.doomed || null;
  const checkAnchor = !!opts.checkAnchor;
  const list = Array.isArray(comments) ? comments : [];
  // Ids that were ACCEPTED. A rejected entry does not consume its id — uniqueness is a property of
  // the resulting document, and an entry that never enters it cannot make a later one a duplicate.
  const taken = new Set();
  const out = [];
  const faults = [];
  let dropped = 0;
  const usableId = (v) => typeof v === 'string' && v.length > 0;

  // Root, then its replies, then the next root — the same order arrival numbers are handed out in, so
  // "the first one wins" means the same thing to both.
  for (const c of list) {
    if (!c || typeof c !== 'object') {
      dropped += 1; faults.push({ kind: 'identity', message: 'an entry that is not an utterance' }); continue;
    }
    const replies = Array.isArray(c.replies) ? c.replies : [];
    const collateral = () => { dropped += 1 + replies.length; };   // the replies go with their root
    if (!usableId(c.id)) { collateral(); faults.push({ kind: 'identity', message: 'an utterance with no id' }); continue; }
    if (doomed && doomed.has(c.id)) {
      collateral(); faults.push({ kind: 'tombstone', message: `utterance ${c.id} is buried by the same envelope that carries it` }); continue;
    }
    if (checkAnchor && !isValidAnchor(c.anchor)) {
      collateral(); faults.push({ kind: 'anchor', message: `utterance ${c.id} has no usable anchor` }); continue;
    }
    if (taken.has(c.id)) { collateral(); faults.push({ kind: 'identity', message: `id ${c.id} arrives more than once` }); continue; }
    const key = threadKeyOf(c);
    const resident = known ? known.get(c.id) : undefined;
    if (resident) {
      if (resident.reply) { collateral(); faults.push({ kind: 'identity', message: `id ${c.id} already belongs to a reply` }); continue; }
      if (resident.threadKey !== key) {
        collateral(); faults.push({ kind: 'identity', message: `utterance ${c.id} would move to another thread` }); continue;
      }
    }
    taken.add(c.id);
    const kept = [];
    for (const r of replies) {
      if (!r || typeof r !== 'object' || !usableId(r.id)) {
        dropped += 1; faults.push({ kind: 'identity', message: 'a reply with no id' }); continue;
      }
      if (doomed && doomed.has(r.id)) {
        dropped += 1; faults.push({ kind: 'tombstone', message: `reply ${r.id} is buried by the same envelope that carries it` }); continue;
      }
      if (taken.has(r.id)) { dropped += 1; faults.push({ kind: 'identity', message: `id ${r.id} arrives more than once` }); continue; }
      const res = known ? known.get(r.id) : undefined;
      if (res && (!res.reply || res.threadKey !== key)) {
        dropped += 1; faults.push({ kind: 'identity', message: `id ${r.id} already belongs to another utterance` }); continue;
      }
      taken.add(r.id);
      kept.push(r);
    }
    // A fresh object only when something was actually removed: the caller's array is not ours to edit,
    // and an untouched entry should stay the very value that arrived.
    out.push(kept.length === replies.length ? c : { ...c, replies: kept });
  }
  return { comments: out, dropped, faults };
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
  // Initial replies are minted here, exactly as `addReply` mints one. The rule above — the library
  // owns identity, callers never bring their own — was true of the comment and not of anything hung
  // under it, so this was the one way in for an id that already named something else. Nothing
  // downstream can tell where such an id came from, and what it produces is an utterance counted as
  // already read because another utterance was. A thread with a history to preserve arrives by
  // import, which checks identities rather than trusting them.
  if (input.replies && input.replies.length) c.replies = input.replies.map((r) => createReply(r, now));
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
 * must be tamper-proof against later mutation of the source object.
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
  // caller's mutable reference, or a later mutation of the input could corrupt stored history.
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
