// @brainworker/tackback — storage adapters.
//
// A StorageAdapter persists a StoredDocument. `load`/`save` may be sync OR async (MaybePromise), so
// the same contract covers localStorage (sync, the offline default) and a future IndexedDB/backend
// adapter (async) without a breaking change. The engine awaits them uniformly.
//
// Since 0.9.7 a StoredDocument also carries what THIS READER has got to: `arrival` numbers utterances
// in the order they reached this environment, `observed` records how far each thread has been seen,
// and `arrivalNext` is the next number to hand out. An adapter must round-trip them like any other
// field — dropping them makes the document look as though it predates unread tracking, and everything
// in it reads as already seen. They are absent from documents written before 0.9.7, which is exactly
// how that case is recognised.
//
// Two requirements come with them, and they are requirements rather than advice:
//   1. ONE ENVIRONMENT PER STORAGE. These records say what one reader has read. An adapter that shares
//      one document between viewers would make one person's reading everybody's.
//   2. ONE INSTANCE AT A TIME. Numbering is per instance, so two live instances on the same storage
//      hand out the same numbers and overwrite each other's snapshots.
// A readOnly instance DOES call `save`: `readOnly` means the document does not change, not that the
// reader leaves no trace.
//
import { TackbackError } from './errors.js';

/**
 * What is written and read back. The three optional fields are the environment-local records
 * described above; a document written before 0.9.7 simply has none of them.
 * @typedef {object} StoredDocument
 * @property {1} schemaVersion
 * @property {string} documentId
 * @property {import('./model.js').Comment[]} comments
 * @property {Record<string, number>} [arrival]      utterance id → the order it reached here
 * @property {Record<string, number>} [observed]     thread key → how far that thread has been seen
 * @property {number} [arrivalNext]                  the next arrival number to hand out
 */

/**
 * Somewhere to keep a StoredDocument. Both calls may be synchronous or return a promise; the engine
 * awaits them the same way either way.
 * @typedef {object} StorageAdapter
 * @property {() => StoredDocument|null|Promise<StoredDocument|null>} load
 * @property {(doc: StoredDocument) => void|Promise<void>} save
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
 * @returns {import('./storage.js').StorageAdapter}
 */
export function memoryAdapter(seed = null) {
  let doc = seed;
  return {
    load: () => doc,
    save: (d) => { doc = d; },
  };
}
