// @brainworker/tackback — the comment store: in-memory state + persistence + change diffs.
//
// Pure of DOM and of the event system: mutating methods return a `{ added, removed, updated }` diff
// and the engine turns that into events. `list()` returns a frozen snapshot — callers never get a
// handle on the internal array.

/**
 * @typedef {import('./model.js').Comment} Comment
 * @typedef {{ added: Comment[], removed: Comment[], updated: Comment[] }} Diff
 */

const EMPTY_DIFF = () => ({ added: [], removed: [], updated: [] });

// Deep-copy a comment so the store owns its data (callers can't mutate state via a retained input
// reference). structuredClone is built into Node ≥17 / modern browsers; JSON round-trip is the
// fallback (comments are plain JSON-serializable data).
const clone = (typeof structuredClone === 'function')
  ? (o) => structuredClone(o)
  : (o) => JSON.parse(JSON.stringify(o));

export class CommentStore {
  /**
   * @param {import('./storage.js').StorageAdapter} adapter
   * @param {string} documentId
   */
  constructor(adapter, documentId) {
    this._adapter = adapter;
    this._documentId = documentId;
    /** @type {Map<string, Comment>} insertion order preserved */
    this._byId = new Map();
  }

  /** @param {import('./storage.js').StoredDocument|null} doc */
  _apply(doc) {
    this._byId.clear();
    if (doc && Array.isArray(doc.comments)) {
      for (const c of doc.comments) this._byId.set(c.id, c);
    }
  }

  /**
   * Begin loading persisted comments. For a SYNC adapter (the localStorage default) state is applied
   * immediately — before this returns — so `mount()` callers need no `await` in the common case. For
   * an async adapter the returned promise resolves once state is applied.
   * @returns {Promise<void>}
   */
  beginLoad() {
    const r = this._adapter.load();
    if (r && typeof (/** @type {any} */ (r).then) === 'function') {
      return /** @type {Promise<any>} */ (r).then((doc) => this._apply(doc));
    }
    this._apply(/** @type {any} */ (r));
    return Promise.resolve();
  }

  /** Async load (explicit await; used in tests). */
  async load() {
    this._apply(await this._adapter.load());
  }

  /** @returns {readonly Comment[]} immutable snapshot (frozen clones) */
  list() {
    return Object.freeze([...this._byId.values()].map((c) => Object.freeze({ ...c })));
  }

  /**
   * Every id in use, roots and replies alike. An id names an UTTERANCE, not a record, so anything
   * minting one has to avoid all of them and not just the top level.
   * @returns {Set<string>}
   */
  _takenIds() {
    const ids = new Set();
    for (const c of this._byId.values()) {
      ids.add(c.id);
      for (const r of c.replies || []) ids.add(r.id);
    }
    return ids;
  }

  /**
   * Remove one reply from the thread it hangs under. A tombstone names an utterance and a reply is
   * one; without this a buried reply survived on a resident root while the same envelope's copy of it
   * was correctly refused, so the deletion was half-applied and nothing said which half.
   * @param {string} replyId
   * @returns {{ diff: Diff, previous: Comment, next: Comment }|null} null when no thread holds it
   */
  deleteReply(replyId) {
    for (const prev of this._byId.values()) {
      const replies = prev.replies || [];
      if (!replies.some((r) => r.id === replyId)) continue;
      const next = { ...prev, replies: replies.filter((r) => r.id !== replyId) };
      this._byId.set(prev.id, next);
      return {
        diff: { ...EMPTY_DIFF(), updated: [Object.freeze({ ...next })] },
        previous: Object.freeze({ ...prev }),
        next: Object.freeze({ ...next }),
      };
    }
    return null;
  }

  /** @param {string} id @returns {Comment|undefined} */
  get(id) {
    const c = this._byId.get(id);
    return c ? Object.freeze({ ...c }) : undefined;
  }

  has(id) {
    return this._byId.has(id);
  }

  /**
   * Persist the current state. Adapter may be async; returns whatever the adapter returns so the
   * engine can await + route failures to the `error` event. In-memory mutations are synchronous
   * (above); persistence is decoupled so the public API stays synchronous.
   * @returns {void|Promise<void>}
   */
  persist() {
    return this._adapter.save({ schemaVersion: 1, documentId: this._documentId, comments: [...this._byId.values()] });
  }

  /** @param {Comment} comment @returns {Diff} */
  add(comment) {
    const c = clone(comment);     // store owns its copy — caller can't mutate state via the input ref
    this._byId.set(c.id, c);
    return { ...EMPTY_DIFF(), added: [Object.freeze({ ...c })] };
  }

  /**
   * @param {string} id
   * @param {Partial<Comment>} patch
   * @param {string} now
   * @returns {{ diff: Diff, previous: Comment, next: Comment }}
   */
  update(id, patch, now) {
    const prev = this._byId.get(id);
    if (!prev) throw new Error(`comment not found: ${id}`); // engine wraps as TackbackError
    const next = { ...prev, ...patch, id: prev.id, createdAt: prev.createdAt, updatedAt: now };
    this._byId.set(id, next);
    return {
      diff: { ...EMPTY_DIFF(), updated: [Object.freeze({ ...next })] },
      previous: Object.freeze({ ...prev }),
      next: Object.freeze({ ...next }),
    };
  }

  /** @param {string} id @returns {{ diff: Diff, previous: Comment }} */
  delete(id) {
    const prev = this._byId.get(id);
    if (!prev) throw new Error(`comment not found: ${id}`);
    this._byId.delete(id);
    return { diff: { ...EMPTY_DIFF(), removed: [Object.freeze({ ...prev })] }, previous: Object.freeze({ ...prev }) };
  }

  /**
   * Replace or merge in a set of comments (used by import). Returns the net diff.
   * @param {Comment[]} incoming
   * @param {'replace'|'merge'} mode
   * @param {'skip'|'replace'|'keepBoth'} onConflict
   * @returns {{ diff: Diff, result: { added: number, updated: number, skipped: number, conflicts: number } }}
   */
  ingest(incoming, mode, onConflict) {
    const diff = EMPTY_DIFF();
    const result = { added: 0, updated: 0, skipped: 0, conflicts: 0 };
    if (mode === 'replace') {
      for (const prev of this._byId.values()) diff.removed.push(Object.freeze({ ...prev }));
      this._byId.clear();
    }
    for (const incomingComment of incoming) {
      const c = clone(incomingComment);   // store owns its copy
      const exists = this._byId.get(c.id);
      if (!exists) {
        this._byId.set(c.id, c);
        diff.added.push(Object.freeze({ ...c }));
        result.added++;
      } else {
        result.conflicts++;
        if (onConflict === 'skip') { result.skipped++; continue; }
        if (onConflict === 'keepBoth') {
          // A kept-both copy is a NEW utterance, and so is every reply under it. Renaming only the
          // root left the copy's replies wearing the originals' ids, so one id named two utterances —
          // which makes "how many are there" and "have I seen this one" unanswerable, quietly.
          const taken = this._takenIds();
          const fresh = (base) => { let id = `${base}-dup`, n = 1; while (taken.has(id)) id = `${base}-dup${++n}`; taken.add(id); return id; };
          c.id = fresh(c.id);
          if (Array.isArray(c.replies)) c.replies = c.replies.map((r) => ({ ...r, id: fresh(r.id) }));
          this._byId.set(c.id, c);
          diff.added.push(Object.freeze({ ...c }));
          result.added++;
          continue;
        }
        this._byId.set(c.id, c); // 'replace'
        diff.updated.push(Object.freeze({ ...c }));
        result.updated++;
      }
    }
    return { diff, result };
  }
}
