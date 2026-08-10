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
// `loadProgress` / `saveProgress` are OPTIONAL. An adapter without them is not given progress at all:
// unread lives as long as the instance and is rebuilt from scratch next time. That is the safe way to
// be incomplete — the alternative, folding progress back into the document write, is the defect.
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
 * @property {() => StoredProgress|null} [loadProgress]
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
      // Unreadable progress is treated as absent — everything reads as new, which is the side that
      // asks the reader to look again. It is never a reason to fail the document load.
      try { return JSON.parse(raw); } catch { return null; }
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
