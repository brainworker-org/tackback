// @brainworker/tackback — storage adapters.
//
// A StorageAdapter persists a StoredDocument. `load`/`save` may be sync OR async (MaybePromise), so
// the same contract covers localStorage (sync, the offline default) and a future IndexedDB/backend
// adapter (async) without a breaking change. The engine awaits them uniformly.
//
// Since 0.9.7 there is a SECOND record: what this reader has got to. It is loaded and saved through
// its own pair of methods and never travels with the document, because the two are written by
// different acts. Comments are what somebody wrote; progress is how far somebody read. While one
// write carried both, an instance that had only ever READ still wrote back every comment it happened
// to be holding, and so undid whatever another instance had written since — silently, with the loss
// appearing only at the next reload. Separate records remove the ability rather than guard its use.
//
// `loadProgress` / `saveProgress` are OPTIONAL, and are a PAIR: an adapter supplying one of them is
// treated as supplying neither, and told so. Without them nothing is kept between mounts — a document
// written through such an adapter never declares that a record is expected, so next time whatever is
// already stored is the baseline the reader is taken to have seen, and only what arrives after the
// mount reads as new. That is the safe way to be incomplete; folding progress back into the document
// write is the defect.
//
// What may be called ALREADY READ is decided in a fixed order, and each step is asked only when the
// one before it leaves the question open:
//
//   1. Is there a document at all. If not, there is nothing for progress to apply to.
//   2. Can the document's SHAPE be read — its `keepsProgress` declaration. Absent means nothing here
//      says a separate record is expected; `true` means one is; anything else means the shape cannot be
//      read, which is reported and stops the record being believed at all.
//   3. Can this adapter reach a record. Without the pair, none is asked for.
//   4. Only then, what the record says: absent, unreadable, or readable — and a readable one is
//      believed field by field, with what is structurally wrong in it discarded rather than guessed.
//
// Exactly one of those outcomes counts as read without a record saying so: a document whose surviving
// shape declares none. Everything else — declared and missing, present and unreadable, out of reach — leaves
// the reader to look again. Unknown is never turned into already-read, because a mark that should be
// there and is not is the failure this version exists to remove.
//
// Reported, once each: a document shape that cannot be read, a record that cannot be read, and half a
// progress pair. NOT reported: a declared record that is simply not there yet, and an adapter with no
// progress pair at all. Those two are uncertainty rather than failure — one is a write that has not
// landed, the other is a supported arrangement — and an error for either would cry wolf about a
// storage that is working exactly as it was built to.
//
// Two requirements come with progress, and they are requirements rather than advice:
//   1. ONE ENVIRONMENT PER STORAGE. Progress says what one reader has read. An adapter that shared it
//      between viewers would make one person's reading everybody's.
//   2. ONE INSTANCE AT A TIME per environment for NUMBERING. Two live instances hand out the same
//      arrival numbers. They can no longer destroy each other's comments by reading, but the numbers
//      they keep are still their own.
// A readOnly instance DOES call `saveProgress`: `readOnly` means the document does not change, not
// that the reader leaves no trace. It never calls `save`.
//
import { TackbackError } from './errors.js';

/**
 * The document: what people wrote. Shared, and the same for everybody who opens it.
 * @typedef {object} StoredDocument
 * @property {1} schemaVersion
 * @property {string} documentId
 * @property {import('./model.js').Comment[]} comments
 * @property {true} [keepsProgress] present when this document was written somewhere that keeps
 *   reading progress in a record of its own. It describes the SHAPE of what is stored, not anything
 *   about a reader, and it is what tells a missing progress record apart from a document whose
 *   surviving shape declares none. Absent is the only other value — one shape for that, not two that
 *   mean the same thing. Absent is not proof that none was ever kept: an older build rebuilding the
 *   document drops the field, and nothing left in the pair would say so.
 */

/**
 * What THIS reader has got to. Local to one environment, and never part of the document or of an
 * export envelope: what one person has read is not something anybody else is entitled to.
 * @typedef {object} StoredProgress
 * @property {Record<string, number>} arrival      utterance id → the order it reached here
 * @property {Record<string, number>} observed     thread key → how far that thread has been seen
 * @property {number} arrivalNext                  the next arrival number to hand out
 */

/**
 * Somewhere to keep them. Every call may be synchronous or return a promise; the engine awaits them
 * the same way either way. The progress pair is optional — see the note at the top of this file for
 * what an adapter without it gets, and why that is the safe way to be incomplete.
 * @typedef {object} StorageAdapter
 * @property {() => StoredDocument|null|Promise<StoredDocument|null>} load
 * @property {(doc: StoredDocument) => void|Promise<void>} save
 * @property {() => StoredProgress|null|Promise<StoredProgress|null>} [loadProgress]
 * @property {(progress: StoredProgress) => void|Promise<void>} [saveProgress]
 * @property {(cb: () => void) => (() => void)} [subscribe] told when the same storage changed elsewhere
 */

// ---- setting aside a record that cannot be read ------------------------------------------------
//
// D-086: report it, start fresh, and KEEP the bytes. The three parts answer three different worries —
// the reader is told (the core emits STORAGE_LOAD_FAILED), the document is usable again (the core
// starts with nothing), and what could not be read is still recoverable by hand.
//
// It is a MOVE, not a copy. Left in place, every later mount would set the same record aside again and
// the three slots would fill with one broken document.

const ASIDE = 'tackback:broken:';
const ASIDE_KEEP = 3;                       // per document — one document's trouble may not evict another's
// The stamp is an ISO 8601 instant, optionally followed by `-<n>` when two records land in the same
// millisecond. Both sort oldest-first as plain text (`Z` sorts before `Z-`), which is what the FIFO
// reads. Taking the stamp OFF is how a key is attributed to a document: an id may itself contain ':'
// (a caller's own `storageKey` can be anything), so splitting on ':' would put `a:b`'s records in
// `a`'s group.
const STAMP = /:\d{4}-\d{2}-\d{2}T[\d:.]+Z(?:-\d+)?$/;

/**
 * @param {Storage} ls
 * @param {string} key   the live key this adapter reads and writes
 * @param {string} raw   exactly what was in there, unparsed
 */
function setAside(ls, key, raw) {
  // Failing to set a record aside must not replace the failure the caller is about to hear about.
  try {
    // The document's own name where there is one to use: the default key is `tackback::<id>`, but a
    // caller's `storageKey` is whatever they chose, and that string is then the only name there is.
    const own = 'tackback::';
    const group = ASIDE + (key.startsWith(own) ? key.slice(own.length) : key);
    // Enumeration is how the FIFO stays honest — an index kept alongside can disagree with the keys
    // themselves. An adapter-like object without it (some test doubles) still gets the record set
    // aside; only the trimming is skipped.
    const enumerable = typeof ls.length === 'number' && typeof ls.key === 'function';
    const mine = () => {
      const out = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.startsWith(ASIDE) && STAMP.test(k) && k.replace(STAMP, '') === group) out.push(k);
      }
      return out.sort();
    };
    // A stamp is only unique if nothing else landed in the same millisecond. Two failures inside one
    // tick — or any environment whose clock does not advance between them — wrote the same key twice,
    // and the second silently replaced the first: three unreadable records, one kept.
    let at = `${group}:${new Date().toISOString()}`;
    if (enumerable || typeof ls.getItem === 'function') {
      for (let n = 2; ls.getItem(at) != null; n++) at = `${at.replace(/-\d+$/, '')}-${n}`;
    }
    // WRITE FIRST, and only then make room. The other order lost data for real: the eviction had
    // already happened when the write failed (a quota is exactly when this runs), so the oldest record
    // was gone and the new one was never stored. Standing at four for an instant is the cheaper fault.
    ls.setItem(at, raw);
    if (enumerable) {
      const kept = mine();
      while (kept.length > ASIDE_KEEP) ls.removeItem(/** @type string */(kept.shift()));
    }
    // Last, because it is the only copy until the line above has succeeded.
    ls.removeItem(key);
  } catch { /* the record stays where it is; the caller is still told it could not be read */ }
}

/**
 * The default adapter: a single localStorage key per document. Sync, zero-config, offline.
 * @param {string} key
 * @returns {import('./storage.js').StorageAdapter}
 */
export function localStorageAdapter(key) {
  const ls = globalThis.localStorage;
  return {
    load() {
      if (!ls) return null;
      const raw = ls.getItem(key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        // A record that cannot be read is SET ASIDE before we say so, so that "unreadable" does not
        // also mean "gone": the core starts fresh, and the next save writes over an empty key rather
        // than over the only copy of whatever was in there. Then the throw, unchanged — it is the
        // only way this adapter can tell the core anything.
        setAside(ls, key, raw);
        throw new TackbackError('STORAGE_LOAD_FAILED', `corrupt stored data at "${key}"`, { cause: err });
      }
    },
    save(doc) {
      if (!ls) return;
      try {
        ls.setItem(key, JSON.stringify(doc));
      } catch (err) {
        // QuotaExceededError, private-mode write blocks, etc. Surface, don't swallow.
        throw new TackbackError('STORAGE_SAVE_FAILED', `could not persist to "${key}"`, { cause: err });
      }
    },
    // Reader progress lives under its own key. Not a tidiness choice: while it shared the document's
    // key, every write of one was a write of the other, so a second tab merely READING put back the
    // comments it happened to be holding and undid what the first had written. Separate keys make
    // that impossible rather than unlikely. Two tabs can still overwrite each other's PROGRESS, and
    // that costs at most a thread reading as unread again, which the next look repairs.
    loadProgress() {
      if (!ls) return null;
      const raw = ls.getItem(`${key}::progress`);
      if (raw == null) return null;
      // A record that is HERE and cannot be read is reported as such, never as an absent one. An
      // absent one is read as a document predating progress, so what is in it counts as seen —
      // answering that for a corrupt record would silently clear marks the reader never looked at.
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new TackbackError('STORAGE_LOAD_FAILED', `corrupt reading progress at "${key}"`, { cause: err });
      }
    },
    saveProgress(progress) {
      if (!ls) return;
      try {
        ls.setItem(`${key}::progress`, JSON.stringify(progress));
      } catch (err) {
        throw new TackbackError('STORAGE_SAVE_FAILED', `could not persist reading progress to "${key}"`, { cause: err });
      }
    },
    subscribe(cb) {
      if (!globalThis.addEventListener) return () => {};
      const onStorage = (e) => { if (e.key === key) cb(); };
      globalThis.addEventListener('storage', onStorage);
      return () => globalThis.removeEventListener('storage', onStorage);
    },
  };
}

/**
 * In-memory adapter — for headless tests and ephemeral/readOnly use.
 * @param {StoredDocument|null} [seed]
 * @param {StoredProgress|null} [progressSeed]
 * @returns {import('./storage.js').StorageAdapter}
 */
export function memoryAdapter(seed = null, progressSeed = null) {
  let doc = seed;
  let progress = progressSeed;
  return {
    load: () => doc,
    save: (d) => { doc = d; },
    loadProgress: () => progress,
    saveProgress: (p) => { progress = p; },
  };
}
