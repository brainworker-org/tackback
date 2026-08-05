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
const LIB_VERSION = '0.9.1';
const nowIso = () => new Date().toISOString();

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
  setTransport(transport) { this._transport = transport || null; }

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
    const { comments, document: importedDoc } = parseEnvelope(envelope);
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
    const { diff, result } = this._store.ingest(valid, mode, opts.onConflict || 'skip');
    this._commit(diff, 'import');
    return { ...result, dropped };
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
