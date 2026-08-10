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
// treated as supplying neither, and told so. Without them nothing is kept between mounts — whatever
// is already stored becomes the baseline the reader is taken to have seen, and only what arrives
// AFTER the mount reads as new. That is the safe way to be incomplete; folding progress back into the
// document write is the defect.
//
// Three states, three meanings, and they must not be collapsed: NO RECORD means this document was
// written before progress existed, so what is in it counts as seen. A record that EXISTS and cannot
// be read means nothing is known, and unknown is never turned into 'already read' — everything is
// left to be looked at again. A readable record is believed, field by field, with what is
// structurally wrong in it discarded rather than guessed at.
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
 * @property {boolean} [keepsProgress] written by a build that keeps reading progress in its own
 *   record. It describes the SHAPE of what is stored, not anything about a reader, and it is what
 *   tells a missing progress record apart from a document written before progress existed.
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
      // A record that is HERE and cannot be read is reported as such, never as an absent one. Absent
      // means this document predates progress, so what is in it counts as seen — answering that for a
      // corrupt record would silently clear marks the reader never looked at.
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
