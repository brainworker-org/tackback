// @brainworker/tackback — the engine: `Tackback.mount(options)` → a headless TackbackInstance.
//
// Owns state (via CommentStore), events (via Emitter), import/export, and media-adapter
// coordination. It is UI-agnostic: gesture capture and rendering live in @brainworker/tackback/panel, which
// drives this instance. The CRUD/event/import-export surface is fully exercised without a DOM.

import { Emitter } from './events.js';
import { CommentStore } from './store.js';
import { localStorageAdapter } from './storage.js';
import { createComment, createReply, isValidAnchor, appendAnchorEvent, threadKeyOf, sanitizeComments } from './model.js';
import { documentSurface, DOCUMENT_SURFACE_ID } from './media.js';
import { buildEnvelope, parseEnvelope } from './export.js';
import { TackbackError } from './errors.js';

// MUST equal package.json "version" (export envelope's generator.version comes from here);
// export.test.js asserts they match so they can't drift.
const LIB_VERSION = '0.9.10';
const nowIso = () => new Date().toISOString();

/**
 * A stored progress record that exists and cannot be read. Distinct from having none: nothing stored
 * is READ AS a document predating progress, so what is in it counts as seen, while a record that
 * cannot be read means nothing is known — and nothing known must never be turned into 'already read'.
 */
const UNREADABLE = Symbol('unreadable progress');

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

    // ---- what has arrived, and how far a reader has got ------------------------------------------
    //
    // Two numbers and one rule: an utterance is unread when it arrived after the last time its thread
    // was seen. The numbers are the library's own, handed out in the order things reach THIS
    // environment, so nothing here consults `createdAt`. An utterance written a year ago and reaching
    // this reader now is new to them, and that is the only sense of "new" a reader can act on.
    //
    // Both are environment-local facts with no source outside this instance: they are not a cached
    // view of something else, so keeping them is not the copy this codebase otherwise refuses to make.
    this._arrival = new Map();       // utterance id → the order it reached here (a positive integer)
    // Utterances THIS reader wrote, here, through this instance's own input path. They never take an
    // arrival number, because writing something is not the same as it reaching you: a number is what
    // makes an utterance capable of being unread, and nobody needs telling about what they just typed.
    // Membership is not stored — the absence of a number IS the fact, and that survives a reload for
    // free (see _restoreEnvState, which reads an id present in a document but missing from a record
    // of arrivals as one that was written here).
    this._own = new Set();
    this._observed = new Map();      // thread key → how far that thread has been seen
    this._arrivalNext = 1;
    this._staged = [];               // ids seen but not yet numbered — see _stageArrival
    this._lastUnreadSig = '[]';      // the last unread snapshot announced, as JSON, to suppress repeats
    this._loadFaults = [];           // entries refused while restoring; reported just before `ready`
    // A channel each. Sharing one queue would have kept them apart in storage and in failure while
    // joining them in TIME: a progress write that never settles would stop the document from being
    // attempted at all, which is the same coupling arriving by a different road.
    this._docChain = Promise.resolve(); this._docQueued = false;
    this._progressChain = Promise.resolve(); this._progressQueued = false;
    // Each record is pending while its revision is ahead of what has actually landed. A plain flag
    // cannot say this: a write that succeeds would clear changes that arrived after its snapshot was
    // taken, and those changes would then be pending in nobody's book.
    this._documentRev = 0; this._documentSaved = 0;   // bumped only by a real change, never by reading
    this._progressRev = 0; this._progressSaved = 0;

    const key = options.storageKey || `tackback::${this._doc.id}`;
    // The engine writes environment-local state itself, so it holds the adapter too. The store keeps
    // being the store of COMMENTS — widening it to carry per-reader state would put two unrelated
    // lifetimes behind one save.
    const adapter = options.storage || localStorageAdapter(key);
    this._envAdapter = adapter;
    // The progress pair is optional, but it is a PAIR: one half alone is a capability that half works
    // — writes that nothing reads back, or reads of something nothing writes — and neither says so.
    // Taken as absent, and said out loud, rather than left to be discovered as unread that will not
    // persist for reasons nobody can see.
    const canRead = typeof adapter.loadProgress === 'function';
    const canWrite = typeof adapter.saveProgress === 'function';
    // Tracked as a capability rather than by rebuilding the adapter without the two methods. A copy
    // keeps only own properties, so an adapter whose operations are methods on a class would lose the
    // document ones too — disabling progress by silently disabling everything.
    this._progressCapable = canRead && canWrite;
    if (canRead !== canWrite) {
      this._loadFaults.push({
        code: 'ADAPTER_FAILED',
        message: `storage adapter has ${canRead ? 'loadProgress' : 'saveProgress'} but not ${canRead ? 'saveProgress' : 'loadProgress'}; reading progress will not be kept`,
      });
    }
    // Restoration is intercepted rather than pushed into the store: what comes back from an adapter is
    // outside input like any envelope, and only what survives validation may reach the store at all.
    const hydrate = (d) => this._hydrateEnv(d);
    this._store = new CommentStore({
      // A record that cannot be READ AT ALL is a third case, next to "there is one" and "there is
      // none": it is reported, and this instance starts with nothing (D-086). The adapter says so by
      // throwing — the only channel it has — and that throw must not come out of `mount()`, or a
      // reader with one corrupt key gets no document, no marks and no page-side error to act on.
      load: () => {
        try {
          const r = adapter.load();
          return (r && typeof r.then === 'function') ? r.then(hydrate, (err) => hydrate(this._unreadable(err))) : hydrate(r);
        } catch (err) { return hydrate(this._unreadable(err)); }
      },
      save: (d) => adapter.save(d),
      ...(typeof adapter.subscribe === 'function' ? { subscribe: (cb) => adapter.subscribe(cb) } : {}),
    }, this._doc.id);

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
      .then(() => {
        if (this._destroyed) return;
        // Entries refused while restoring are reported HERE rather than as they were found. A
        // synchronous adapter finishes loading inside the constructor, before the caller has had a
        // chance to subscribe — reporting there would mean the only listeners who could hear about
        // corrupt stored data are the ones who did not exist yet.
        for (const fault of this._loadFaults.splice(0)) this._fail(fault.code || 'IMPORT_ENTRY_DROPPED', fault.message);
        // One look, armed before `ready` and taken after it: whatever was restored as unread reaches a
        // subscriber as an ordinary report rather than as a special case for starting up.
        this._scheduleVisibility();
        this._emitter.emit('ready');
      })
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
    this._mine(comment.id);
    for (const r of comment.replies || []) this._mine(r.id);
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
    this._mine(reply.id);
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
   * the integrator listens to. The descriptor tells the panel how to label the pane (save when none
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
    const mode = opts.mode || 'merge';
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
    // Who is here now, so an entry cannot quietly take an id that already belongs to something else,
    // or carry a known utterance to a different thread. Both break the same promise: that an id names
    // one utterance and that an utterance stays in the conversation it was written into. Broken, the
    // symptom is an utterance the reader has never seen being counted as already read.
    const known = new Map();
    for (const c of this._store.list()) {
      const key = threadKeyOf(c);
      known.set(c.id, { threadKey: key, reply: false });
      for (const r of c.replies || []) known.set(r.id, { threadKey: key, reply: true });
    }
    const checked = sanitizeComments(comments, { known, doomed, checkAnchor: true });
    const dropped = checked.dropped;
    // A REPLACE declares a complete state, so accepting the good half of one composes a document
    // neither side ever asked for: the rows the envelope meant to keep are gone with everything else,
    // and what is left was nobody's idea of the truth. A replacement is all or nothing.
    //
    // A MERGE is the opposite case and gets the opposite answer: a polling integration carries the
    // same envelope over and over, and refusing the whole thing would stop synchronising completely
    // from the first time a producer emitted one bad row. Drop that row, keep going, say so.
    //
    // A buried entry is not counted here in either mode. The envelope saying an id is gone is the
    // envelope being read correctly, not a fault in it.
    if (mode === 'replace') {
      // The malformed-file guard that predates all of this: a file whose records cannot be placed
      // must not be able to clear what the reader already has. `allowPartial` still opts in.
      const unplaceable = checked.faults.filter((f) => f.kind === 'anchor').length;
      if (unplaceable > 0 && !opts.allowPartial) {
        throw new TackbackError('IMPORT_INVALID', `replace import has ${unplaceable} invalid record(s); refusing to clear existing comments`);
      }
      const identity = checked.faults.filter((f) => f.kind === 'identity').length;
      if (identity > 0) {
        this._fail('IMPORT_REPLACE_REJECTED',
          `replacement refused: ${identity} entr${identity === 1 ? 'y' : 'ies'} would break which utterance is which`);
        return { added: 0, updated: 0, skipped: 0, conflicts: 0, dropped, deleted: 0 };
      }
    }
    const { diff, result } = this._store.ingest(checked.comments, mode, opts.onConflict || 'skip');
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
    const buriedReplies = [];
    for (const id of (doomed || [])) {
      if (this._store.has(id)) {
        const r = this._store.delete(id);
        gone.push(id); gonePrev.push(r.previous);
        diff.removed.push(...r.diff.removed);
        continue;
      }
      // A tombstone names an UTTERANCE, and a reply is one. Refusing the envelope's own copy of a
      // buried reply is only half of honouring it — the resident copy has to go too, or the envelope
      // has been read and only partly obeyed. It shows up as its thread being updated, which is how
      // an import reports every other modification; the per-comment delete events stay about comments.
      const r = this._store.deleteReply(id);
      if (!r) continue;
      buriedReplies.push(r);
      diff.updated.push(...r.diff.updated);
    }
    this._commit(diff, 'import');
    // the same payload every other deletion carries — a listener reading `previous` must not find
    // that an import is the one path that hands it nothing
    for (let i = 0; i < gone.length; i++) this._emitter.emit('comment:delete', { id: gone[i], previous: gonePrev[i] });
    if (gone.length) this._emitter.emit('comments:delete', { ids: gone, previous: gonePrev });
    // Dropped, but never silently. Said once per fault and after the document has settled, so a
    // listener that reacts to one is looking at the import's finished result rather than its middle.
    for (const fault of checked.faults) this._fail('IMPORT_ENTRY_DROPPED', fault.message);
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

  // ---- what a reader has not got to yet ----------------------------------------------------------
  //
  // ONE rule, computed every time and never stored: a thread is unread when it holds an utterance that
  // arrived after the last time that thread was seen.
  //
  //     unread(t)  ⇔  ∃ u ∈ t : arrival[u] > observed[t]
  //
  // No flag is kept, because a flag is a second answer that can disagree with the first. The numbers
  // it is derived from are kept, because they are first-hand facts about this environment with no
  // source anywhere else — recording them creates the authority rather than copying one.

  /**
   * How many utterances are unread, per thread. The one place the rule is written; both public
   * queries read it, so they cannot come to different conclusions about the same document.
   * @returns {Map<string, number>} every thread with utterances, including those at zero
   */
  _unreadTally() {
    const counts = new Map();
    for (const c of this._store.list()) {
      const key = threadKeyOf(c);
      if (!key) continue;
      const seen = this._observed.get(key) ?? 0;
      let n = counts.get(key) ?? 0;
      if ((this._arrival.get(c.id) ?? 0) > seen) n += 1;
      for (const r of c.replies || []) if ((this._arrival.get(r.id) ?? 0) > seen) n += 1;
      counts.set(key, n);
    }
    return counts;
  }

  /**
   * How many utterances in this thread the reader has not seen yet.
   * @param {string} threadKey
   * @returns {number} 0 for a thread that does not exist, and for anything that is not a thread key —
   *   this is a question, not an instruction, and there is no state a wrong key could corrupt
   */
  unreadCount(threadKey) {
    if (typeof threadKey !== 'string' || !threadKey) return 0;
    return this._unreadTally().get(threadKey) ?? 0;
  }

  /**
   * Every thread holding something unread, by thread key. Threads at zero are absent rather than
   * present with a count of nought — the answer is "where is there something new", and a list of
   * places with nothing new in them is not that.
   * @returns {Array<{threadKey: string, count: number}>} freshly built, ordered by key
   */
  unreadThreads() {
    return [...this._unreadTally()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([threadKey, count]) => ({ threadKey, count }));
  }

  /**
   * Move each visible thread's cursor up to the newest utterance the reader could see in it.
   *
   * Only ever called from a look that SUCCEEDED. A look that failed is not evidence that anything was
   * on screen, and treating it as evidence marks things read that nobody saw — the one failure this
   * whole mechanism has to be incapable of.
   * @param {Array<{threadKey: string, comments: string[]}>} visible
   * @returns {boolean} whether any cursor moved
   */
  _advanceObserved(visible) {
    let moved = false;
    for (const entry of visible) {
      const was = this._observed.get(entry.threadKey) ?? 0;
      let now = was;
      for (const id of entry.comments) {
        const seq = this._arrival.get(id);
        // An id the store has never heard of is not a fact about what was on screen, so it does not
        // move anything. One of them does not spoil the rest of an otherwise good look.
        if (seq !== undefined && seq > now) now = seq;
      }
      if (now !== was) { this._observed.set(entry.threadKey, now); moved = true; }
    }
    return moved;
  }

  /**
   * Announce the unread snapshot, if it is not the one already announced.
   *
   * A snapshot rather than a difference, for the reason the visibility report is one: a consumer that
   * misses a difference stays wrong forever, while one that misses a snapshot is corrected by the next.
   * The core keeps only the string it compares against, so nothing a subscriber does to what it was
   * handed can change what the core believes it said.
   */
  _emitUnreadIfChanged() {
    const threads = this.unreadThreads();
    const sig = JSON.stringify(threads);
    if (sig === this._lastUnreadSig) return;
    this._lastUnreadSig = sig;
    this._emitter.emit('unread:change', { threads });
  }

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
    // A LOOK THAT SUCCEEDED ends the failure it succeeded after — here, where looking happens, and so
    // for whoever took it. Ending the episode on the scheduled path alone made a pull a second kind of
    // success that did not count: a display could recover in full view of the caller and still be
    // carrying the verdict earned before, with no attempts left and nothing said when it failed again.
    this._visibilityRetries = 0;
    this._visibilityReported = false;
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
    // FIRST, and whether or not the look succeeds. What has arrived is known regardless of whether
    // anything can be seen, and a display that cannot be read must not be able to hold up the fact
    // that something came in — that is the half this version exists to deliver.
    const numbered = this._finalizeArrivals();
    if (numbered) this._progressRev += 1;
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
      if (attempt.error) {
        if (this._visibilityRetries < VISIBILITY_RETRIES) {
          this._visibilityRetries += 1;
          this._retryVisibilityLater();
        } else if (!this._visibilityReported) {
          // Out of attempts, so responsibility passes to the caller — which is what the error MEANS,
          // and why it is not said earlier: a display that is unreadable for a moment and readable by
          // the next look never needed anyone told. It is said ONCE, because "this display cannot be
          // read" is one fact and does not become several by being rediscovered on every later
          // mutation. Saying it again takes a successful look in between, or a different display.
          this._visibilityReported = true;
          // `_failAs`, not `_fail`: the display's own error may be a TackbackError (an unusable anchor
          // in what it returned), and passing that code through would report INVALID_ANCHOR — a code
          // this library only ever throws at a caller who supplied a bad anchor. The pull path
          // already answers this situation with ADAPTER_FAILED (see `visibleThreads`); this is the
          // same situation reached on the scheduled path, so it gets the same code.
          this._failAs('ADAPTER_FAILED', 'a display could not report what is visible', attempt.error);
        }
      }
      // Being unable to LOOK is not being unable to COUNT. What has arrived and how far each thread
      // was seen are both already here; a broken display changes neither. Stopping here would let one
      // stuck display starve the reader of every notice that something new came in — which is the
      // first half of the whole point, held hostage by the second.
      this._emitUnreadIfChanged();
      return;
    }
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
    // BEFORE the early return, deliberately. Whether the visible SET changed and whether a cursor has
    // catching up to do are different questions: the same threads reported again after a reload is a
    // report that changes nothing and moves everything. Putting this after the return would make the
    // reader's progress depend on something moving on screen.
    // Numbering and observation settled together, so the record written from here is the whole of
    // this turn rather than half of it.
    if (this._advanceObserved(visible) || numbered) this._schedulePersist();
    if (changed) {
      // Built fresh for this delivery. What a subscriber is given is not the baseline the next diff is
      // measured against, so nothing it does to the payload can rewrite what the core believes it said.
      this._emitter.emit('thread:visibility', {
        visible: visible.map(visibilityDTO), opened: opened.map(visibilityDTO), closed: closed.map(visibilityDTO),
      });
    }
    // Last, and after the cursors moved. A flush always ends by asking whether the unread picture
    // changed — so an utterance landing in a thread the reader already has open is read by the time
    // anyone is told about it, and never flickers as unread on its way in.
    this._emitUnreadIfChanged();
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
    // Every path that changes anything meets here, which is why arrivals are NOTICED here and nowhere
    // else. Spreading it over the entry points would mean each new one had to remember, and the way it
    // fails when someone does not is that an utterance is displayed and never counted as new.
    //
    // Noticed, not numbered. Numbering is what makes something unread, and it happens where observation
    // settles — see _finalizeArrivals. Doing it here put the two cursors on different boundaries, so
    // between them every synchronous question got an answer the event contract said was impossible: an
    // utterance the reader had open counted as unread, and nothing ever corrected it, because from the
    // core's side nothing had changed.
    this._stageArrival(comments);
    this._pruneEnvState(comments);
    // Every mutation can change what a reader is looking at, so every mutation schedules a report.
    // Scheduling too often costs one comparison that finds nothing; scheduling too rarely leaves the
    // consumer acting on a world that has moved. Only one of those two errors is recoverable.
    //
    // Asked for BEFORE the change goes out, so that this look is ahead of anything a handler defers
    // to the same boundary. A subscriber that redraws on `change` and then wants to know what is
    // still unread has to be answered from after the cursors moved, not from the middle of the turn.
    this._scheduleVisibility();
    const payload = { comments, changes: diff, source };
    this._emitter.emit('change', payload);
    this._schedulePersist(true);
  }

  /**
   * Give an arrival number to every utterance that has none. Never to one that already has: a number
   * is what "this is the same utterance I already had" MEANS, so re-issuing it on an edit, or on the
   * same envelope arriving again, would make everything a reader has already read new all over again.
   * @param {readonly import('./model.js').Comment[]} comments
   */
  _ensureArrival(comments) {
    for (const c of comments) {
      if (!this._arrival.has(c.id)) this._arrival.set(c.id, this._arrivalNext++);
      for (const r of c.replies || []) {
        if (!this._arrival.has(r.id)) this._arrival.set(r.id, this._arrivalNext++);
      }
    }
  }

  /**
   * Note which utterances are new, in the order they arrived, without numbering them yet.
   *
   * The ORDER is taken here and not rediscovered later, because later means scanning the finished
   * document, which is in the order the document happens to be stored in rather than the order things
   * reached this environment. Several utterances can arrive in one turn — one envelope carries as many
   * as it likes — and the numbers are what "arrival order" MEANS to anything reading them back.
   * @param {readonly import('./model.js').Comment[]} comments
   */
  /**
   * Record that an utterance was written here, through this instance's own input path.
   *
   * Called where the id is minted rather than from the commit, because the commit cannot tell the two
   * apart: the same `addReply` carries a reply this reader typed and one an integrator relays from
   * somewhere else. What it CAN tell is that neither of those reached this environment from outside,
   * which is the whole of the distinction — no notion of who is speaking is introduced or needed.
   * @param {string} id
   */
  _mine(id) { if (id) this._own.add(id); }

  _stageArrival(comments) {
    const pending = new Set(this._staged);
    const note = (id) => {
      if (this._own.has(id)) return;   // written here: never an arrival, so never numbered
      if (!this._arrival.has(id) && !pending.has(id)) { this._staged.push(id); pending.add(id); }
    };
    for (const c of comments) {
      note(c.id);
      for (const r of c.replies || []) note(r.id);
    }
  }

  /**
   * Hand out the numbers, in the order the arrivals were noticed.
   *
   * Called at the settling boundary and nowhere else, so that becoming numbered and becoming observed
   * are one event rather than two with a gap between them. Anything staged that has since been deleted
   * is dropped rather than numbered: it never survived to be read, and a number for it would only have
   * to be pruned again.
   * @returns {boolean} whether anything was numbered
   */
  _finalizeArrivals() {
    if (!this._staged.length) return false;
    const staged = this._staged;
    this._staged = [];
    let numbered = false;
    for (const id of staged) {
      if (this._arrival.has(id) || !this._holds(id)) continue;
      this._arrival.set(id, this._arrivalNext++);
      numbered = true;
    }
    return numbered;
  }

  /** Whether this utterance — comment or reply — is still in the document. */
  _holds(id) {
    if (this._store.has(id)) return true;
    for (const c of this._store.list()) {
      for (const r of c.replies || []) if (r.id === id) return true;
    }
    return false;
  }

  /**
   * Forget what is gone.
   *
   * Safe because numbers only ever go up: a thread that is emptied and later written in again receives
   * a number above anything its old cursor could have been, so it reads as new without the record
   * having to survive. That is also the intended meaning of deletion — this environment has forgotten
   * the utterance, so the same id arriving later is a fresh arrival rather than something already read.
   * @param {readonly import('./model.js').Comment[]} comments
   */
  _pruneEnvState(comments) {
    const alive = new Set();
    const threads = new Set();
    for (const c of comments) {
      alive.add(c.id);
      for (const r of c.replies || []) alive.add(r.id);
      const key = threadKeyOf(c);
      if (key) threads.add(key);
    }
    for (const id of this._arrival.keys()) if (!alive.has(id)) this._arrival.delete(id);
    for (const id of this._own) if (!alive.has(id)) this._own.delete(id);
    for (const key of this._observed.keys()) if (!threads.has(key)) this._observed.delete(key);
  }

  /** The document, as one whole. Written in full, so a save never depends on an earlier one landing. */
  _snapshotStored() {
    // The document says which SHAPE it was written in — that reading progress is kept in a record of
    // its own. Not what anybody read, so it is still the document's to carry: without it, a document
    // written by this build whose very first progress write never landed is indistinguishable from one
    // written before progress existed, and everything in it silently counts as already seen.
    const doc = { schemaVersion: 1, documentId: this._doc.id, comments: [...this._store.list()] };
    // Present only when progress can actually be kept, and then only as `true`. An adapter with
    // nowhere to put a record will never have one, so declaring that one is expected turns a
    // permanent, ordinary arrangement into "the write must have failed" — everything unread, every
    // time, for ever. Absent means what it has always meant. THIS writer omits it for exactly one
    // reason: the adapter cannot keep a record. The other histories that end in the same shape arrive
    // from outside — a build written before progress existed, and an older build rebuilding the
    // document and dropping a field it never knew. One shape covers all three, because nothing left
    // in the pair separates them.
    if (this._progressCapable) doc.keepsProgress = true;
    return doc;
  }

  /**
   * What THIS reader has got to. Kept apart from the document on purpose.
   *
   * They are written by different acts and belong to different people: comments are what somebody
   * wrote, progress is how far somebody has read. Putting them in one indivisible write meant that
   * reading — which cannot change a comment — nevertheless wrote every comment the reader happened to
   * be holding, and so undid what another instance had written since. Separating the two removes the
   * ability rather than guarding against its use.
   */
  _snapshotProgress() {
    return {
      arrival: Object.fromEntries(this._arrival),
      observed: Object.fromEntries(this._observed),
      arrivalNext: this._arrivalNext,
    };
  }

  /**
   * Ask for the current state to be written. One save at a time, and while one is in flight any number
   * of further requests collapse into a single later one that writes the state as it is THEN.
   *
   * Serial because the alternative loses read state in a way nobody can see: two saves in flight
   * finish in whatever order the storage feels like, and an older snapshot landing last quietly puts
   * a thread back to unread. Coalescing because the intermediate states have no value — every save
   * carries everything, so the last one is the only one that has to arrive.
   *
   * @param {boolean} [documentToo] whether the DOCUMENT changed. Reading never sets it, and that is
   *   the whole of the guarantee: an instance that has not written anything cannot write anything.
   */
  _schedulePersist(documentToo = false) {
    if (documentToo) this._documentRev += 1;
    this._progressRev += 1;
    this._pump('progress');
    this._pump('document');
  }

  /**
   * Keep one record's writes moving, one at a time, on its own channel.
   *
   * Serial WITHIN a record because two writes of the same thing finishing out of order would put an
   * older snapshot last, quietly undoing what the newer one said. Independent BETWEEN records because
   * they are different people's work: one that is slow, or that never answers at all, must not be able
   * to hold the other up. While a write is in flight any number of further requests collapse into a
   * single later one, which then writes the state as it is then.
   * @param {'document'|'progress'} which
   */
  _pump(which) {
    const isDocument = which === 'document';
    if (isDocument ? this._docQueued : this._progressQueued) return;
    if (isDocument) this._docQueued = true; else this._progressQueued = true;
    const run = async () => {
      if (isDocument) this._docQueued = false; else this._progressQueued = false;
      if (this._destroyed) return;   // a queued write has nothing left to be about
      await this._writeRecord(which);
    };
    if (isDocument) this._docChain = this._docChain.then(run);
    else this._progressChain = this._progressChain.then(run);
  }

  /**
   * Write one record, and keep it pending until its OWN write lands.
   *
   * A failed save is a durability failure, not a meaning one: the reader did read it, the author did
   * write it. Memory keeps what it knows, the failure is reported once, and because the record stays
   * pending the next save — every change and every observation schedules one — carries it again.
   * Clearing the flag before the write succeeded is how a comment gets stranded with nothing left to
   * remember that it was never stored.
   * @param {'document'|'progress'} which
   */
  async _writeRecord(which) {
    const isDocument = which === 'document';
    const rev = isDocument ? this._documentRev : this._progressRev;
    if (rev === (isDocument ? this._documentSaved : this._progressSaved)) return;
    // An adapter with nowhere to keep progress is not failing — it has no such record. Nothing is
    // pending, because nothing was ever going to be written.
    if (!isDocument && !this._progressCapable) { this._progressSaved = rev; return; }
    try {
      // The revision is read BEFORE the snapshot and only recorded after the write lands, so anything
      // that changes while the write is in flight stays ahead of what was stored and is written again.
      await (isDocument
        ? this._envAdapter.save(this._snapshotStored())
        : this._envAdapter.saveProgress(this._snapshotProgress()));
      if (isDocument) this._documentSaved = rev; else this._progressSaved = rev;
    } catch (err) {
      this._fail(err instanceof TackbackError ? err.code : 'STORAGE_SAVE_FAILED', 'persist failed', err);
    }
  }

  /**
   * Take a stored document apart: validate it, recover what it says about arrival and observation, and
   * hand back the document the store is allowed to see.
   *
   * The order matters and is fixed. Broken records fall on the side of asking the reader to look
   * again, never on the side of quietly claiming they already did — an unread mark that should not be
   * there is a small annoyance a glance repairs, and one that should be there but is not is the whole
   * failure this version exists to fix, arriving silently.
   * @param {import('./storage.js').StoredDocument|null} doc
   */
  _hydrateEnv(doc) {
    // The order below is the order these decisions actually depend on each other in, and it has to
    // be: asking for progress first means an adapter that answers late — or never — holds up
    // decisions that never needed it. There is nothing for progress to apply to when there is no
    // document, and nothing to believe when the document's own shape cannot be read.
    if (!doc) { this._arrivalNext = 1; return doc; }
    const declaration = this._readDeclaration(doc);
    // Neither of these consults the record, so neither waits for one.
    if (declaration === 'malformed' || !this._progressCapable) return this._hydrateWith(doc, declaration, null);
    let kept;
    // A load that throws is a record that EXISTS and cannot be read — a different thing from none.
    const unreadable = () => {
      this._loadFaults.push({ code: 'STORAGE_LOAD_FAILED', message: 'stored reading progress could not be read; nothing is taken as read' });
      return this._hydrateWith(doc, declaration, UNREADABLE);
    };
    try { kept = this._envAdapter.loadProgress(); } catch { return unreadable(); }
    // Only here does waiting begin, and only on something whose answer is going to be used.
    return (kept && typeof kept.then === 'function')
      ? kept.then((p) => this._hydrateWith(doc, declaration, p), unreadable)
      : this._hydrateWith(doc, declaration, kept);
  }

  /**
   * A stored document that could not be read: queue the report and hand back nothing.
   *
   * The report goes on the same queue as everything else found while restoring, so it reaches the
   * `error` event just before `ready` — the moment a subscriber exists to hear it. Handing back `null`
   * is what makes this instance start fresh; the bytes are not lost, the adapter set them aside.
   * @param {unknown} err
   * @returns {null}
   */
  _unreadable(err) {
    const e = /** @type {any} */ (err);
    this._loadFaults.push({
      code: e instanceof TackbackError ? e.code : 'STORAGE_LOAD_FAILED',
      message: e?.message || 'stored document could not be read; starting with nothing',
    });
    return null;
  }

  /**
   * Whether this document says reading progress is kept in a record of its own.
   *
   * It decides whether an ABSENT record is read as none having been expected — the one answer that
   * counts everything as seen — so a value nobody recognises must not be able to pass for no value.
   * Stored data is reachable by hand and through adapters that were never typed, and corrupted format
   * metadata quietly clearing marks is the failure this field exists to prevent. Presence is asked
   * separately from value, because a property that is THERE holding undefined is not one that was
   * never written.
   * @param {import('./storage.js').StoredDocument} doc
   * @returns {'absent'|'present'|'malformed'}
   */
  _readDeclaration(doc) {
    if (!Object.prototype.hasOwnProperty.call(doc, 'keepsProgress')) return 'absent';
    if (doc.keepsProgress === true) return 'present';
    this._loadFaults.push({
      code: 'STORAGE_LOAD_FAILED',
      message: 'stored document declares an unrecognised progress format; nothing is taken as read',
    });
    return 'malformed';
  }

  /**
   * @param {import('./storage.js').StoredDocument|null} doc
   * @param {'absent'|'present'|'malformed'} declaration what the document says about its own shape
   * @param {any} progress the stored progress, `null` if there is none or none was asked for, or
   *   UNREADABLE if there is one that could not be read
   */
  _hydrateWith(doc, declaration, progress) {
    // An adapter's answer is outside input, exactly like an envelope, and gets the same check.
    const { comments, faults } = sanitizeComments(doc.comments);
    this._loadFaults.push(...faults);
    // What may be called ALREADY READ. The shape has already been read — that decision came first,
    // because it does not need the record and must not wait for one — so what is left is what the
    // record itself says, and whether it may be believed at all.
    //
    // A shape that could not be read stops the record being believed at all, rather than merely being
    // reported alongside it: validation that announces a problem and then trusts what it could not
    // validate is a comment, not a boundary. The one thing that counts as read without a record is
    // the exception below, and it needs a shape that reads cleanly in order to be an exception at all.
    const nothingStored = progress === null || progress === undefined;
    const kept = (declaration !== 'malformed' && progress && progress !== UNREADABLE) ? progress : null;

    // The one cell that counts as read without a record: nothing was expected here, as far as anything
    // surviving can tell. Written before progress existed, written somewhere it cannot be kept, or
    // written by an older build that dropped the declaration and since parted with its record — one
    // shape covers all three, because no evidence is left that would separate them. It is the reading
    // applied to that silence, not a fact about it. Everything else leaves the reader to look again,
    // because a document that
    // expected a record and has none, and one whose record cannot be read, are both ignorance; and
    // turning ignorance into "already read" is how a reader stops being told about anything at all.
    const legacy = nothingStored && declaration === 'absent';
    const counts = (v) => Number.isSafeInteger(v) && v >= 1;

    // Whether there is a record of arrivals to read AT ALL. It is not the same question as whether an
    // utterance has a number in it: with a record, an id missing from it was written here; with no
    // record, nothing is known about any of them and every one is looked at again.
    const hasArrivals = !!(kept && typeof kept.arrival === 'object' && kept.arrival);
    const declared = hasArrivals ? kept.arrival : {};
    const byNumber = new Map();
    // An id whose number is structurally wrong was WRITTEN DOWN and cannot be read — which is not the
    // same as never having been written down. Only the second means "this reader wrote it"; the first
    // is damage, and damage is numbered again so it lands on the side that asks for another look.
    const rejected = new Set();
    for (const [id, v] of Object.entries(declared)) {
      if (!counts(v)) { rejected.add(id); continue; }  // not a number that could have been handed out
      if (!byNumber.has(v)) byNumber.set(v, []);
      byNumber.get(v).push(id);
    }
    // Ids that gave a number up because two utterances claimed it. They are numbered again below,
    // rather than read as written-here: a damaged record must not be able to turn into "already read".
    const contested = new Set();
    for (const [v, sharing] of byNumber) {
      // A number two utterances both claim identifies neither. Which one is the real holder is not
      // recoverable, so both give theirs up and are numbered again — landing them after everything
      // read so far, which is the side that asks for another look.
      if (sharing.length === 1) this._arrival.set(sharing[0], v);
      else for (const id of sharing) contested.add(id);
    }
    let highest = 0;
    for (const v of this._arrival.values()) if (v > highest) highest = v;
    // Never hand out a number twice, whatever the stored counter says. A reused number is read as
    // already-seen by whatever cursor is sitting above it.
    this._arrivalNext = Math.max(counts(kept?.arrivalNext) ? kept.arrivalNext : 1, highest + 1);
    // What an unnumbered utterance means here depends on whether a record of arrivals existed at all.
    //
    // With one, every arrival that ever reached this environment was numbered as it landed — so an
    // utterance sitting in the document without a number is one that never arrived, which is to say
    // this reader wrote it. That is how "written here" survives a reload without being stored: the
    // absence is the record. A record from before arrivals existed says nothing of the kind, so
    // everything in it is numbered as before and the legacy reading below decides what to do with it.
    // No record to read — missing, unreadable, or not the shape of one — says nothing about who wrote
    // what, so nothing may be read as written-here. Everything is numbered and left to be looked at
    // again, which is the side ignorance has to fall on.
    if (legacy || !hasArrivals) this._ensureArrival(comments);
    else {
      for (const c of comments) {
        for (const id of [c.id, ...(c.replies || []).map((r) => r.id)]) {
          if (this._arrival.has(id)) continue;
          if (contested.has(id) || rejected.has(id)) this._arrival.set(id, this._arrivalNext++);
          else this._mine(id);
        }
      }
    }

    const issued = this._arrivalNext - 1;
    const observed = (kept && typeof kept.observed === 'object' && kept.observed) ? kept.observed : {};
    for (const [key, v] of Object.entries(observed)) {
      // Structurally wrong — not an integer, or not positive — is treated as never written, which in a
      // record that knows about reading means unread.
      if (!Number.isSafeInteger(v) || v < 1) continue;
      // A cursor ABOVE everything currently here is not damage: delete a thread's utterances and their
      // numbers go with them while the fact that they were read stays. Trimmed to what has actually
      // been handed out, so a cursor cannot swallow arrivals that have not happened yet.
      this._observed.set(key, Math.min(v, issued));
    }
    if (legacy) {
      for (const c of comments) {
        const key = threadKeyOf(c);
        if (key) this._observed.set(key, issued);
      }
    }
    this._pruneEnvState(comments);
    // Nothing is written back here. The normalization rides out on the next ordinary save, so a mount
    // that reads and never observes anything leaves the stored document alone.
    return { ...doc, comments };
  }

  _fail(code, message, cause) {
    const err = cause instanceof TackbackError ? cause : new TackbackError(/** @type any */(code), message, { cause });
    this._emitter.emit('error', err);
  }

  /**
   * Report as THIS code, keeping whatever failed as `cause`.
   *
   * `_fail` passes a TackbackError cause straight through, which is right when the cause's code IS
   * the honest description of what happened (a storage write that failed). It is wrong where the
   * SITUATION owns the code: a display that cannot answer is `ADAPTER_FAILED` however it failed, and
   * letting the inner code out would announce a caller-input error for something no caller did.
   */
  _failAs(code, message, cause) {
    this._emitter.emit('error', new TackbackError(/** @type any */(code), message, { cause }));
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

/**
 * What mounting takes. Only `document` is really needed; everything else has a working default.
 * @typedef {object} MountOptions
 * @property {{ id?: string, title?: string, revisionHash?: string, source?: string|null }} [document]
 * @property {import('./storage.js').StorageAdapter} [storage] where comments and reading progress are kept
 * @property {string} [storageKey] names the default storage instead of deriving it from the document
 * @property {boolean} [readOnly] the DOCUMENT does not change; the reader still records what they read
 * @property {import('./model.js').Author} [author] who new comments are attributed to
 * @property {object} [root] the content box region anchors are measured against
 * @property {any[]} [reactions] the reaction set, if not the built-in one
 * @property {any[]} [mediaAdapters] surfaces to register at mount
 * @property {object} [transport] a descriptor the panel shows; the core never transports anything
 */

export const Tackback = {
  /** @param {MountOptions} [options] @returns {TackbackInstance} */
  mount(options) { return new TackbackInstance(options); },
  version: LIB_VERSION,
};

export { TackbackInstance };
