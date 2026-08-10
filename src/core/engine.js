// @brainworker/tackback — the engine: `Tackback.mount(options)` → a headless TackbackInstance.
//
// Owns state (via CommentStore), events (via Emitter), import/export, and media-adapter
// coordination. It is UI-agnostic: gesture capture and rendering live in @brainworker/tackback/panel, which
// drives this instance. The CRUD/event/import-export surface is fully exercised without a DOM.

import { Emitter } from './events.js';
import { CommentStore } from './store.js';
import { localStorageAdapter } from './storage.js';
import { createComment, createReply, isValidAnchor, appendAnchorEvent } from './model.js';
import { documentSurface, DOCUMENT_SURFACE_ID } from './media.js';
import { buildEnvelope, parseEnvelope } from './export.js';
import { TackbackError } from './errors.js';

// MUST equal package.json "version" (export envelope's generator.version comes from here);
// export.test.js asserts they match so they can't drift.
const LIB_VERSION = '0.9.7';
const nowIso = () => new Date().toISOString();

/** How many times the core looks again by itself before handing an unreadable display back. */
const VISIBILITY_RETRIES = 3;

/**
 * Whether two visibility entries say the same thing. Both id lists arrive sorted and de-duplicated,
 * so this compares what was promised to a subscriber rather than how it was assembled.
 * @param {{anchor:object, comments:string[]}} a
 * @param {{anchor:object, comments:string[]}|undefined} b
 */
const sameEntry = (a, b) => !!b
  && a.comments.length === b.comments.length
  && a.comments.every((id, i) => id === b.comments[i])
  && a.sig === b.sig;

/**
 * A value rebuilt as the core's own, with object keys in a defined order and absent optionals
 * dropped. Two jobs at once, and they are the same job: what a subscriber receives shares nothing
 * with what a display handed over or with what the core will diff against next time, and two anchors
 * that MEAN the same thing compare equal however their properties happen to be ordered — a fresh
 * import can spell an anchor differently without that counting as a change.
 * @template T @param {T} v @returns {T}
 */
const canonical = (v) => {
  // A function or a symbol would survive a copy by REFERENCE while being invisible to the signature —
  // shared with whoever handed it over, and unable to count as a change. Neither belongs in a fact.
  if (typeof v === 'function' || typeof v === 'symbol') return null;
  if (v === null || v === undefined || typeof v !== 'object') return v === undefined ? null : v;
  if (Array.isArray(v)) return /** @type {any} */ (v.map(canonical));
  const out = /** @type {any} */ ({});
  for (const k of Object.keys(v).sort()) { if (v[k] !== undefined) out[k] = canonical(v[k]); }
  return out;
};

/** A visibility entry as a subscriber sees it: freshly built every time, sharing nothing. */
const visibilityDTO = (e) => ({ threadKey: e.threadKey, anchor: canonical(e.anchor), comments: e.comments.slice() });

/**
 * @typedef {import('./model.js').Comment} Comment
 * @typedef {import('./model.js').AddCommentInput} AddCommentInput
 */

class TackbackInstance {
  /** @param {object} [options] */
  constructor(options = {}) {
    // REQ-101: a no-options mount works out of the box — when document.id is omitted it defaults
    // deterministically to location.pathname (an SPA should pass an explicit id so storage/export stay
    // scoped per route); an explicit id always takes precedence.
    const doc = options.document || {};
    const id = (typeof doc.id === 'string' && doc.id)
      ? doc.id
      : ((globalThis.location && globalThis.location.pathname) || 'tackback-doc');
    this._opts = options;
    this._doc = { ...doc, id };
    this._readOnly = !!options.readOnly;
    this._emitter = new Emitter();
    this._surfaces = new Map();          // surfaceId -> AnnotationSurface
    this._adapterTeardowns = [];
    this._destroyed = false;
    this._transport = options.transport || null;   // descriptor only; core never transports (REQ-205)
    this._visibilityProvider = null;            // the one display that can say what is readable
    this._visibilityDelivered = new Map();      // the snapshot subscribers were last told about
    this._visibilityGeneration = 0;             // bumped when a display arrives or withdraws
    this._visibilityRetries = 0;                // attempts spent on the CURRENT failure, not ever
    this._visibilityReported = false;           // whether this failure has already been announced
    this._visibilityRetryPending = false;
    this._visibilityScheduled = false;
    this._attention = new Set();   // comment ids currently flagged for ATTENTION — a generic, live UI
                                   // state driven by the integrator; NOT persisted, NOT exported, and
                                   // WITHOUT any built-in meaning (see setAnchorAttention).

    const key = options.storageKey || `tackback::${this._doc.id}`;
    this._store = new CommentStore(options.storage || localStorageAdapter(key), this._doc.id);

    // The default HTML surface = the document content box (REQ-005); region anchors with
    // surfaceId:'document' resolve against it. Registered when the consumer mounts with an explicit
    // `root` (the content box). The panel — which owns the content root — also registers one against
    // its root; a headless / core-only mount with no root simply has no document surface, by design.
    if (options.root && typeof options.root.getBoundingClientRect === 'function') {
      this._surfaces.set(DOCUMENT_SURFACE_ID, documentSurface(options.root));
    }

    // sync-loads for a sync adapter (no await needed in the common case); ready also waits on adapters.
    // `ready` RESOLVES (never rejects) by design: an init failure is reported on the `error` event
    // (fail-soft), so a missing listener can't throw an unhandled rejection. Subscribe to 'error' to
    // detect initialization problems; do not treat `await ready` as a success signal.
    this.ready = this._store.beginLoad()
      .then(() => this._mountAdapters())
      .then(() => { if (!this._destroyed) this._emitter.emit('ready'); })
      .catch((err) => this._fail('ADAPTER_FAILED', 'initialization failed', err));
  }

  // ---- queries -------------------------------------------------------------------------------
  listComments() { return this._store.list(); }
  getComment(id) { return this._store.get(id); }

  // ---- mutations -----------------------------------------------------------------------------
  /** @param {AddCommentInput} input @returns {Comment} */
  addComment(input) {
    this._assertWritable();
    if (!input || !isValidAnchor(input.anchor)) {
      throw new TackbackError('INVALID_ANCHOR', 'addComment requires a valid anchor');
    }
    const author = input.author !== undefined ? input.author : (this._opts.author ?? null);
    const comment = createComment({ ...input, author }, nowIso());
    const diff = this._store.add(comment);
    this._commit(diff, 'local');
    this._emitter.emit('comment:add', comment);
    return comment;
  }

  /** @param {string} id @param {{body?:string,reaction?:string}} patch @returns {Comment} */
  updateComment(id, patch) {
    this._assertWritable();
    if (!this._store.has(id)) throw new TackbackError('COMMENT_NOT_FOUND', `no comment ${id}`);
    const { diff, previous, next } = this._store.update(id, patch, nowIso());
    this._commit(diff, 'local');
    this._emitter.emit('comment:update', { comment: next, previous });
    return next;
  }

  /**
   * Append a reply to a comment's thread and emit `comment:update{comment,previous}` (REQ-307). A
   * reply shares the root comment's anchor (it has none of its own); the library owns its id +
   * createdAt. Replies serialize in the envelope and round-trip on import (they are a Comment field).
   * @param {string} commentId
   * @param {import('./model.js').AddReplyInput} input
   * @returns {Comment}
   */
  addReply(commentId, input) {
    this._assertWritable();
    if (!this._store.has(commentId)) throw new TackbackError('COMMENT_NOT_FOUND', `no comment ${commentId}`);
    const reply = createReply(input || { body: '' }, nowIso());
    const prev = this._store.get(commentId);
    const replies = [...(prev.replies || []), reply];
    const { diff, previous, next } = this._store.update(commentId, { replies }, nowIso());
    this._commit(diff, 'local');
    this._emitter.emit('comment:update', { comment: next, previous });
    return next;
  }

  /** @param {string} id */
  deleteComment(id) {
    this._assertWritable();
    if (!this._store.has(id)) throw new TackbackError('COMMENT_NOT_FOUND', `no comment ${id}`);
    const { diff, previous } = this._store.delete(id);
    this._attention.delete(id);   // a deleted comment carries no live attention flag
    this._commit(diff, 'local');
    this._emitter.emit('comment:delete', { id, previous });
  }

  /**
   * Delete several comments as ONE operation — what deleting a whole anchor, or clearing a document,
   * actually is. Without it an integrator sees N indistinguishable deletions and cannot tell where
   * one act ended.
   *
   * One `comment:delete` per removed comment is preserved, with the same payload. Everything else
   * about a multi-comment deletion changes: it commits (and persists) ONCE rather than per comment,
   * so there is one `change` carrying the whole removal, the per-comment events all follow it, and a
   * `comment:delete` handler sees the collection as it is AFTER the whole act.
   * @param {string[]} ids
   * @returns {{ ids: string[], previous: Comment[] }} what was actually removed
   */
  deleteComments(ids) {
    this._assertWritable();
    const removed = [], previous = [];
    let diff = { added: [], updated: [], removed: [] };
    for (const id of ids || []) {
      if (!this._store.has(id)) continue;
      const r = this._store.delete(id);
      this._attention.delete(id);
      removed.push(id); previous.push(r.previous);
      diff = { added: [], updated: [], removed: [...diff.removed, ...r.diff.removed] };
    }
    if (!removed.length) return { ids: [], previous: [] };
    this._commit(diff, 'local');
    for (let i = 0; i < removed.length; i++) this._emitter.emit('comment:delete', { id: removed[i], previous: previous[i] });
    this._emitter.emit('comments:delete', { ids: removed, previous });
    return { ids: removed, previous };
  }

  /**
   * Record a region move/resize: append an anchor-event {ts,type,before,after} to the region's
   * append-only history, advance the stored rect/fallback/capture, and route through the normal
   * update path so it persists + emits comment:update/change — NEVER a silent re-point
   * (REQ-008/009/010). The new state is validated (a resize-to-zero / out-of-bounds rect is rejected
   * before any mutation, REQ-008). `after.capture` (DOM-derived) is supplied by the caller (the panel
   * computes it via resolution.computeCapture) so the core stays geometry/DOM-agnostic.
   * @param {string} id
   * @param {import('./model.js').RegionState} after   the new region state (rect required; fallback/capture optional)
   * @param {'move'|'resize'} [type]
   * @returns {Comment}
   */
  recordRegionEvent(id, after, type = 'move') {
    this._assertWritable();
    if (type !== 'move' && type !== 'resize') {
      throw new TackbackError('INVALID_ANCHOR', `recordRegionEvent type must be move|resize, got ${type}`);
    }
    const prev = this._store.get(id);
    if (!prev) throw new TackbackError('COMMENT_NOT_FOUND', `no comment ${id}`);
    if (!prev.anchor || prev.anchor.type !== 'region') {
      throw new TackbackError('INVALID_ANCHOR', `comment ${id} is not a region anchor`);
    }
    if (!after || !after.rect) throw new TackbackError('INVALID_ANCHOR', 'recordRegionEvent requires after.rect');
    const nextAnchor = appendAnchorEvent(prev.anchor, type, after, nowIso(), prev.createdAt);
    if (!isValidAnchor(nextAnchor)) {
      throw new TackbackError('INVALID_ANCHOR', 'region move/resize rejected: rect out of bounds or zero-area');
    }
    const { diff, previous, next } = this._store.update(id, { anchor: nextAnchor }, nowIso());
    this._commit(diff, 'local');
    this._emitter.emit('comment:update', { comment: next, previous });
    return next;
  }

  // ---- submission seam (REQ-701; core EMITS, integrator transports — REQ-205) ----------------

  /**
   * Record a transport DESCRIPTOR for the panel's benefit (REQ-701/205). The core never performs
   * the network/storage transport itself and never calls this object — it only emits typed events
   * the integrator listens to. The descriptor tells the panel how to label the popup (save when none
   * is attached, send when one is) and whether to stay open after a commit (`interactive:true`).
   * @param {{ interactive?: boolean, label?: string } | null} transport
   */
  setTransport(transport) {
    const next = transport || null;
    // Compare the descriptor's FIELDS, not its serialized text: `{interactive, label}` and
    // `{label, interactive}` are the same descriptor, and a UI that reacts once per change must not
    // be woken by a change of representation.
    const same = (a, b) => (a === b) || !!(a && b && a.interactive === b.interactive && a.label === b.label);
    const changed = !same(this._transport, next);
    this._transport = next;
    // A UI that decides "Save or Send" once, when it opens, goes stale the moment this changes. A
    // Pane's staleness is bounded by its own lifetime, but a persistent composer's is not — so the
    // change is announced. Descriptor only: the core still transports nothing.
    if (changed) this._emitter.emit('transport:change', next);
  }

  /** @returns {{ interactive?: boolean, label?: string } | null} the attached transport descriptor */
  getTransport() { return this._transport ?? null; }

  /**
   * "Send all" affordance (REQ-701 mode 2): emit a single `submit:batch` carrying the whole comment
   * set (+ a ready-to-hand envelope) for an integrator's listener to transport. Tackback only emits;
   * it never transports. An empty set is a no-op (emits nothing). Modes 1 (exportEnvelope) and 3
   * (per-commit comment:add) work whether or not a transport is attached.
   * @returns {{ comments: Comment[], envelope: import('./model.js').ExportEnvelope } | null} the emitted payload, or null on no-op
   */
  submitBatch() {
    const comments = [...this._store.list()];
    if (comments.length === 0) return null;   // "send all" on an empty set = no-op (REQ-701 b)
    const payload = { comments, envelope: this.exportEnvelope(), transport: this._transport ?? null };
    this._emitter.emit('submit:batch', payload);
    return payload;
  }

  // ---- import / export -----------------------------------------------------------------------
  exportEnvelope() {
    const comments = [...this._store.list()];
    // REQ-507: include the descriptor for every raster surface a region anchor references (not the live
    // HTML 'document' surface), so the exported file is self-describing enough for a later replay.
    const surfaces = [];
    const seen = new Set();
    for (const c of comments) {
      const a = c.anchor;
      if (!a || a.type !== 'region') continue;
      const sid = a.surfaceId;
      if (!sid || sid === DOCUMENT_SURFACE_ID || seen.has(sid)) continue;
      seen.add(sid);
      const s = this._surfaces.get(sid);
      if (s && s.descriptor) surfaces.push(s.descriptor);
    }
    return buildEnvelope({
      document: this._doc, now: nowIso(), version: LIB_VERSION,
      exportedBy: this._opts.author ?? null, reactions: this._opts.reactions,
      surfaces, comments,
    });
  }

  /** @param {unknown} envelope @param {{mode?:'replace'|'merge',onConflict?:'skip'|'replace'|'keepBoth'}} [opts] */
  importEnvelope(envelope, opts = {}) {
    this._assertWritable();
    const { comments, document: importedDoc, deleted: incomingDeleted } = parseEnvelope(envelope);
    // REQ-204/304 (Z3): if the import names a revisionHash that disagrees with the doc we render
    // against, warn via rev:mismatch but DO NOT refuse — load in drift mode. Text anchors re-resolve
    // at render (DOM-side) and orphan what they cannot (REQ-004); never a silent mis-point. A legacy
    // envelope with no revisionHash skips the comparison (back-compat, REQ-304 b).
    const importedRev = importedDoc && importedDoc.revisionHash;
    const currentRev = this._doc.revisionHash;
    if (importedRev != null && currentRev != null && importedRev !== currentRev) {
      this._emitter.emit('rev:mismatch', { expected: currentRev, actual: importedRev });
    }
    // Validate before ingesting — a malformed record must never corrupt store state.
    const valid = comments.filter((c) => c && typeof c.id === 'string' && c.id.length > 0 && isValidAnchor(c.anchor));
    const dropped = comments.length - valid.length;
    const mode = opts.mode || 'merge';
    // 'replace' wipes existing comments first; refuse to do that on a partially-invalid import — a
    // malformed file must not silently destroy the user's current comments. Pass
    // allowPartial:true to opt into a partial replace.
    if (dropped > 0 && mode === 'replace' && !opts.allowPartial) {
      throw new TackbackError('IMPORT_INVALID', `replace import has ${dropped} invalid record(s); refusing to clear existing comments`);
    }
    // Precedence is decided BEFORE the store is touched, and it belongs to the ENVELOPE, not to the
    // mode the reader happens to pass: a producer emits one envelope, and its meaning cannot depend
    // on an option chosen at the other end. An envelope that both lists an id and buries it is saying
    // the server no longer has it — the only way the two can disagree is a torn read of an
    // append-only ledger (comments projected, a delete lands, tombstones projected), and there the
    // tombstone is strictly the fresher fact. So a buried id is never ingested, in either mode.
    //
    // Ingesting first and burying afterwards let one envelope contradict itself out loud: the id
    // arrived in both `added` and `removed` of a single `change`, the return said `added: 1` and
    // `deleted: 1` at once, and a `comment:delete` described a comment no listener had been shown.
    const doomed = Array.isArray(incomingDeleted)
      ? new Set(incomingDeleted.filter((id) => typeof id === 'string'))
      : null;
    const ingestible = doomed && doomed.size ? valid.filter((c) => !doomed.has(c.id)) : valid;
    const { diff, result } = this._store.ingest(ingestible, mode, opts.onConflict || 'skip');
    // A MERGE only ever added, so an integrator polling a server's envelope resurrected everything
    // the server had deleted. The envelope can now say what is gone, and merge honours it. The
    // CLIENT keeps no tombstones: the party that knows about a deletion is the one that recorded it,
    // and a list that only grows is not something to make every mounted instance carry.
    //
    // Under REPLACE the filter above is the whole of it: the wipe already removes whatever the
    // incoming set omits, so this loop finds nothing left to take and `deleted` comes back 0. The
    // envelope is still honoured — a buried id simply cannot come back in through the front door.
    // Everything removed below was ALREADY in the store, so the emitted diff is a true before/after.
    const gone = [], gonePrev = [];
    for (const id of (doomed || [])) {
      if (!this._store.has(id)) continue;
      const r = this._store.delete(id);
      this._attention.delete(id);
      gone.push(id); gonePrev.push(r.previous);
      diff.removed.push(...r.diff.removed);
    }
    this._commit(diff, 'import');
    // the same payload every other deletion carries — a listener reading `previous` must not find
    // that an import is the one path that hands it nothing
    for (let i = 0; i < gone.length; i++) this._emitter.emit('comment:delete', { id: gone[i], previous: gonePrev[i] });
    if (gone.length) this._emitter.emit('comments:delete', { ids: gone, previous: gonePrev });
    return { ...result, dropped, deleted: gone.length };
  }

  // ---- events / adapters / lifecycle ---------------------------------------------------------
  on(event, cb) { return this._emitter.on(event, cb); }
  off(event, cb) { this._emitter.off(event, cb); }

  /** @param {import('./media.js').MediaAdapter} adapter @returns {() => void} idempotent unregister */
  registerMediaAdapter(adapter) {
    return this._mountAdapter(adapter);
  }

  /** Re-resolve overlays after the document/surfaces re-rendered (zoom, reflow). */
  recalculateAnchors() { this._emitter.emit('recalculate'); }

  /**
   * Surface an anchor that no longer resolves against the live document (drift). The panel detects
   * this during render (resolution is DOM-side) and reports it here. Beyond emitting the public
   * `anchor:orphaned` event, this SERIALIZES the orphan onto the stored comment (REQ-004): the
   * comment stays in listComments(), is exportable, and re-resolves on a later markResolved(). The
   * serialization is idempotent — an already-orphaned comment does not re-commit — so a panel that
   * reports it every render does not loop.
   * @param {Comment} comment
   * @param {string} [lastError]
   */
  reportOrphaned(comment, lastError) {
    this._emitter.emit('anchor:orphaned', { comment });
    if (this._readOnly || this._destroyed || !comment || !this._store.has(comment.id)) return;
    const cur = this._store.get(comment.id);
    if (cur.orphan) return;   // idempotent — already serialized, do not re-commit (no render loop)
    const orphan = lastError != null ? { since: nowIso(), lastError } : { since: nowIso() };
    const { diff } = this._store.update(comment.id, { orphan }, nowIso());
    this._commit(diff, 'local');
  }

  /**
   * Clear a comment's serialized orphan state because its anchor re-resolved (a later
   * recalculateAnchors()/import found its target again, REQ-004). Idempotent: a non-orphaned comment
   * is a no-op. Routes through the update path so the cleared state persists.
   * @param {string} id
   * @returns {Comment|null} the updated comment, or null if it was not orphaned / unknown
   */
  markResolved(id) {
    if (this._readOnly || this._destroyed || !this._store.has(id)) return null;
    const cur = this._store.get(id);
    if (!cur.orphan) return null;
    const { diff, next } = this._store.update(id, { orphan: undefined }, nowIso());
    this._commit(diff, 'local');
    return next;
  }

  /**
   * Flag (or clear) an ATTENTION state on an anchor, keyed by one of its comment ids. This is a
   * generic, live signal the integrator drives — Tackback attaches NO meaning to it (it is not
   * "unread", not "needs-review"; those are the integrator's concepts). The panel paints a flagged
   * anchor with the `--tb-attention` tint and clears it when the flag is removed. It is deliberately
   * SESSION-only: never persisted to storage and never written into the export envelope, so it can
   * never leak a per-viewer UI state into a shared file. A panel groups comments by anchor, so a
   * thread's badge shows attention when ANY of its comment ids is flagged — pass the id you track.
   * Idempotent: no event when the state does not actually change (a panel can call it freely).
   * A flag lives exactly as long as its comment: deleting or wiping the comment drops it, so a later
   * import that re-creates the same id starts UNflagged (a stale flag never resurrects).
   * Throws on a destroyed instance.
   * @param {string} id      a comment id belonging to the anchor
   * @param {boolean} [on]    true to flag (default), false to clear
   * @returns {boolean}       the resulting attention state for that id
   */
  setAnchorAttention(id, on = true) {
    // a destroyed instance has no live UI state to flag — fail loudly rather than mutating a set no
    // listener will ever see (readOnly is deliberately NOT blocked: attention is view state, not a
    // document mutation, so a read-only viewer can still track its own notices).
    if (this._destroyed) throw new TackbackError('ADAPTER_FAILED', 'instance destroyed');
    const want = !!on;
    const had = this._attention.has(id);
    if (want === had) return want;   // idempotent — no redundant event / re-render
    if (want) this._attention.add(id); else this._attention.delete(id);
    this._emitter.emit('attention:change', { id, on: want });
    return want;
  }

  /** @param {string} id @returns {boolean} whether the attention flag is set on this comment id */
  hasAttention(id) { return this._attention.has(id); }

  // ---- thread visibility -----------------------------------------------------------------------
  //
  // WHICH THREADS ARE READABLE RIGHT NOW, as a settled snapshot rather than as a pair of edges the
  // consumer has to keep balanced. A dropped or reordered edge is unrecoverable; a snapshot repairs
  // itself on the next report, which is the whole reason for the shape.
  //
  // The core cannot see a surface, so it does not try: a display registers a PROVIDER and the core
  // asks it, at the moment it needs an answer. That keeps the boundary where it already is — the same
  // arrangement `reportOrphaned` uses for a fact only the display can determine — while leaving the
  // subscription on the one object an integration always holds. It also means the last word, when a
  // display is torn down, is spoken by something that outlives it.

  /**
   * Register a display's view of what is readable. `provider` returns the currently visible threads;
   * the core calls it when it needs the answer and never stores what it returned as truth.
   * @param {() => Array<{threadKey:string, anchor:object, comments:string[]}>} provider
   * @returns {() => void} deregister — which is itself a transition, and is reported as one
   */
  registerThreadVisibility(provider) {
    // A destroyed core keeps nothing: it would never schedule a report for this provider, so adding
    // it only makes the display — and everything its closure holds — reachable from a corpse.
    if (typeof provider !== 'function' || this._destroyed) return () => {};
    // AT MOST ONE display, because a document has at most one panel — attaching a second to the same
    // document is already unsupported, and this seam does not get to be more general than the thing
    // it reports on. Aggregating several would mean deciding, in here, which of two disagreeing
    // claims about one thread is true and whether an unreadable display should hold up a readable
    // one: policy about surfaces the core cannot see, invented for a situation that cannot arise.
    // A later registration REPLACES the earlier one rather than being refused, so re-attaching after
    // a teardown that did not run cannot leave a dead display answering forever.
    this._visibilityProvider = provider;
    this._newVisibilityEpisode();
    this._scheduleVisibility();
    return () => {
      if (this._visibilityProvider !== provider) return;   // already replaced; not ours to withdraw
      this._visibilityProvider = null;
      this._newVisibilityEpisode();
      this._scheduleVisibility();
    };
  }

  /**
   * A different display is a different world, so it starts with the whole budget and the right to be
   * complained about once. Carrying either across would let a display that was never asked more than
   * once inherit a verdict earned by the one before it — and the failure it inherits is exactly the
   * one that would have made a fresh look worth taking.
   */
  _newVisibilityEpisode() {
    this._visibilityGeneration += 1;
    this._visibilityRetries = 0;
    this._visibilityReported = false;
  }

  /** Ask for a report to be reconsidered at the next boundary. Reports that change nothing are dropped. */
  reportThreadVisibility() { this._scheduleVisibility(); }

  /**
   * The readable threads, right now. Same shape as the event's `visible`, answered without waiting.
   * @returns {Array<{threadKey:string, anchor:object, comments:string[]}>}
   */
  visibleThreads() {
    const attempt = this._observeVisibility();
    // "I could not look" has no honest synchronous answer that is also a value. Handing back the last
    // array the core happened to hold would be answering a question about NOW with something from
    // before, silently — which is the one failure this whole contract exists to make impossible.
    if (!attempt.ok) throw new TackbackError('ADAPTER_FAILED', 'could not read what is visible', { cause: attempt.error });
    return attempt.visible.map(visibilityDTO);
  }

  /**
   * ONE observation attempt, whole or not at all.
   *
   * Asking every display, narrowing what each returns, and rebuilding it as the core's own are not
   * three steps that can partly succeed — they are one act of looking. If any part of it fails, the
   * core has not seen the world; it has seen part of the world and would have to invent the rest.
   * Both ways of inventing it are wrong, and neither can be right in principle: whether an unreadable
   * display currently shows nothing or still shows what it last showed is a fact only that display
   * knows. So the attempt is voided instead, the last ACTUALLY OBSERVED state stands untouched, and
   * the next successful look repairs everything at once — late rather than wrong, which is the same
   * rule the projection itself is built on.
   * @returns {{ok:true, visible:any[]} | {ok:false, error:unknown}}
   */
  _observeVisibility() {
    if (this._destroyed) return { ok: true, visible: [] };
    const generation = this._visibilityGeneration;
    /** @type {Map<string, any>} */
    const merged = new Map();
    const provider = this._visibilityProvider;
    if (provider) {
      try {
        const entries = provider();
        for (const e of entries || []) {
          if (!e || typeof e.threadKey !== 'string' || !e.threadKey) continue;
          // An entry promises to name a PLACE. One that names nothing, or names it with a kind this
          // build does not know, cannot be published as though it did — and quietly dropping it would
          // report a thread the reader is looking at as gone. It fails the look instead.
          if (!isValidAnchor(e.anchor)) {
            throw new TackbackError('INVALID_ANCHOR', `visible thread ${e.threadKey} has no usable anchor`);
          }
          // A display supplies facts, not values the core will hand on. Narrowing and rebuilding
          // happen HERE, inside the attempt: a value that cannot be canonicalized is a look that
          // failed, not a report to publish with a hole in it.
          const ids = [...new Set((Array.isArray(e.comments) ? e.comments : [])
            .filter((id) => typeof id === 'string' && id))].sort();
          const prev = merged.get(e.threadKey);
          if (!prev) {
            const anchor = canonical(e.anchor ?? null);
            merged.set(e.threadKey, { threadKey: e.threadKey, anchor, comments: ids, sig: JSON.stringify(anchor) });
            continue;
          }
          // Two displays showing the same thread is one readable thread, not two.
          prev.comments = [...new Set([...prev.comments, ...ids])].sort();
        }
      } catch (error) {
        return { ok: false, error };
      }
    }
    // A display that arrived or withdrew while we were looking means this look spans two different
    // worlds. Nothing is reported from a composite of them.
    if (generation !== this._visibilityGeneration) return { ok: false, error: null };
    const visible = [...merged.values()]
      .sort((a, b) => (a.threadKey < b.threadKey ? -1 : a.threadKey > b.threadKey ? 1 : 0));
    return { ok: true, visible };
  }

  _scheduleVisibility() {
    if (this._destroyed || this._visibilityScheduled) return;
    this._visibilityScheduled = true;
    const run = () => this._flushVisibility();
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  _flushVisibility() {
    this._visibilityScheduled = false;
    if (this._destroyed) return;
    const attempt = this._observeVisibility();
    if (!attempt.ok) {
      // Nothing is installed and nothing is announced. Every mutation re-arms a report, so a bounded
      // retry is only there to cover a stretch in which nothing else happens; the correctness comes
      // from the baseline still being the last state anyone actually saw.
      //
      // A look VOIDED because the display changed underneath it is not a display that failed, and is
      // not anyone's to answer for: the arrival or withdrawal has already begun a fresh episode and
      // asked for another report. Belt and braces — every generation change goes through
      // `_newVisibilityEpisode`, so nothing is left to spend here anyway — but the rule is written
      // where the decision is made rather than inferred from somewhere else.
      if (!attempt.error) return;
      if (this._visibilityRetries < VISIBILITY_RETRIES) {
        this._visibilityRetries += 1;
        this._retryVisibilityLater();
        return;
      }
      // Out of attempts, so responsibility passes to the caller — which is what the error MEANS, and
      // why it is not said earlier: a display that is unreadable for a moment and readable by the
      // next look never needed anyone told. It is said ONCE, because "this display cannot be read"
      // is one fact and does not become several by being rediscovered on every later mutation.
      // Saying it again takes a successful look in between, or a different display.
      if (this._visibilityReported) return;
      this._visibilityReported = true;
      this._fail('ADAPTER_FAILED', 'a display could not report what is visible', attempt.error);
      return;
    }
    this._visibilityRetries = 0;
    this._visibilityReported = false;
    const visible = attempt.visible;
    const before = this._visibilityDelivered;
    const now = new Map(visible.map((e) => [e.threadKey, e]));
    const opened = visible.filter((e) => !before.has(e.threadKey));
    const closed = [...before.values()].filter((e) => !now.has(e.threadKey));
    // Identity is the content, not the membership: a thread the reader is looking at while it grows
    // never enters or leaves, and a consumer resolving read state from `comments` needs to hear about
    // it. Comparing keys alone would report nothing for exactly the case the display supports best.
    const changed = opened.length || closed.length
      || visible.some((e) => !sameEntry(e, before.get(e.threadKey)));
    // The baseline is installed BEFORE anyone is called. A handler is free to open or close something
    // from here, and its report must be diffed against what was just delivered — not overwritten by
    // this frame writing back a world its own handler has already left.
    this._visibilityDelivered = now;
    if (!changed) return;
    // Built fresh for this delivery. What a subscriber is given is not the baseline the next diff is
    // measured against, so nothing it does to the payload can rewrite what the core believes it said.
    this._emitter.emit('thread:visibility', {
      visible: visible.map(visibilityDTO), opened: opened.map(visibilityDTO), closed: closed.map(visibilityDTO),
    });
  }

  _retryVisibilityLater() {
    // Its own flag, deliberately. Sharing the ordinary one would let a retry waiting on a later turn
    // swallow a report that a mutation has just asked for now — the retry is a floor under liveness,
    // never a ceiling on it.
    if (this._visibilityRetryPending) return;
    this._visibilityRetryPending = true;
    const run = () => { this._visibilityRetryPending = false; if (!this._destroyed) this._flushVisibility(); };
    if (typeof setTimeout === 'function') setTimeout(run, 0); else queueMicrotask(run);
  }

  setAuthor(name) { this._opts.author = name; }

  /**
   * The author new comments are attributed to — the `author` mount option as last set by setAuthor.
   * Exposed so a UI can EDIT the identity without destroying it: an Author may be a provenance object
   * (`{ id, kind }`), and a name-entry field must patch `.id` rather than replace the whole object
   * (dropping `kind` would silently disable any category-based rendering).
   * @returns {import('./model.js').Author | null}
   */
  getAuthor() { return this._opts.author ?? null; }

  /** @returns {ReadonlyMap<string, any>} registered annotation surfaces (for the panel/renderer) */
  get surfaces() { return this._surfaces; }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const t of this._adapterTeardowns.splice(0)) { try { t(); } catch { /* ignore */ } }
    this._surfaces.clear();
    this._attention.clear();
    this._visibilityProvider = null;
    this._visibilityDelivered.clear();
    this._emitter.clear();
  }

  // ---- internals -----------------------------------------------------------------------------
  _assertWritable() {
    if (this._destroyed) throw new TackbackError('ADAPTER_FAILED', 'instance destroyed');
    if (this._readOnly) throw new TackbackError('READ_ONLY', 'instance is read-only');
  }

  /** Persist (async, decoupled) + emit the unified `change` with a diff payload. */
  _commit(diff, source) {
    const comments = this._store.list();
    this._pruneAttention(comments);   // BEFORE the emit, so listeners never render a ghost flag
    const payload = { comments, changes: diff, source };
    this._emitter.emit('change', payload);
    // Every mutation can change what a reader is looking at, so every mutation schedules a report.
    // Scheduling too often costs one comparison that finds nothing; scheduling too rarely leaves the
    // consumer acting on a world that has moved. Only one of those two errors is recoverable.
    this._scheduleVisibility();
    Promise.resolve(this._store.persist()).catch((err) =>
      this._fail(err instanceof TackbackError ? err.code : 'STORAGE_SAVE_FAILED', 'persist failed', err));
  }

  /**
   * Drop attention flags whose comment no longer exists. A flag is keyed by a comment id, so a wipe
   * (clear-all / `replace` import) must not leave it dangling — otherwise a later import that
   * re-creates the SAME id would resurrect a stale flag the integrator never re-set. Cheap: the flag
   * set is a live UI signal, normally near-empty, and this is a no-op when it is.
   * @param {import('./model.js').Comment[]} comments
   */
  _pruneAttention(comments) {
    if (this._attention.size === 0) return;
    const alive = new Set(comments.map((c) => c.id));
    for (const id of this._attention) if (!alive.has(id)) this._attention.delete(id);
  }

  _fail(code, message, cause) {
    const err = cause instanceof TackbackError ? cause : new TackbackError(/** @type any */(code), message, { cause });
    this._emitter.emit('error', err);
  }

  /** Mount the option-supplied adapters; `ready` awaits async mounts so 'ready' fires after render. */
  _mountAdapters() {
    this._pendingMounts = [];
    if (this._destroyed) return Promise.resolve([]);   // destroyed during beginLoad → don't mount
    for (const a of (this._opts.mediaAdapters || [])) { if (this._destroyed) break; this._mountAdapter(a); }
    return Promise.all(this._pendingMounts);
  }

  /**
   * Mount one adapter and return an IDEMPOTENT unregister fn (works whether mount is sync or still
   * pending). Async-safe: if the instance is destroyed before an async mount
   * resolves, the adapter's teardown runs immediately and its surfaces are not retained.
   * @param {import('./media.js').MediaAdapter} adapter @returns {() => void}
   */
  _mountAdapter(adapter) {
    if (this._destroyed) return () => {};   // never mount onto a destroyed instance
    const ctx = {
      root: this._opts.root || globalThis.document?.body,
      registerSurface: (s) => {
        if (this._destroyed) return () => {};
        this._surfaces.set(s.id, s);
        // delete only if still the SAME surface — a reused id must not drop a newer one.
        return () => { if (this._surfaces.get(s.id) === s) this._surfaces.delete(s.id); };
      },
      invalidate: () => this.recalculateAnchors(),
      on: (event, cb) => this._emitter.on(event, cb),
    };
    const slot = { teardown: null, unregistered: false };
    const adopt = (t) => {
      const fn = typeof t === 'function' ? t : () => {};
      if (this._destroyed || slot.unregistered) { try { fn(); } catch { /* ignore */ } return; }
      slot.teardown = fn;
      this._adapterTeardowns.push(fn);
    };
    let pending = null;
    try {
      const t = adapter.mount(ctx);
      if (t && typeof t.then === 'function') {
        pending = t.then(adopt, (err) => this._fail('ADAPTER_FAILED', `adapter "${adapter.name}" failed to mount`, err));
        (this._pendingMounts ||= []).push(pending);
      } else {
        adopt(t);
      }
    } catch (err) {
      this._fail('ADAPTER_FAILED', `adapter "${adapter.name}" failed to mount`, err);
    }
    return () => {
      if (slot.unregistered) return;
      slot.unregistered = true;
      const run = () => {
        const fn = slot.teardown;
        if (!fn) return;
        const i = this._adapterTeardowns.indexOf(fn); if (i >= 0) this._adapterTeardowns.splice(i, 1);
        try { fn(); } catch { /* ignore */ }
      };
      if (pending) pending.then(run); else run();
    };
  }
}

export const Tackback = {
  /** @param {object} options @returns {TackbackInstance} */
  mount(options) { return new TackbackInstance(options); },
  version: LIB_VERSION,
};

export { TackbackInstance };
