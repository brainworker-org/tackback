// @brainworker/tackback — public error type.
//
// Anything that touches the DOM, storage, JSON import, or a media adapter can fail. We surface a
// single typed error with a stable `code` so callers can branch without string-matching messages.

/**
 * @typedef {'INVALID_ANCHOR'|'COMMENT_NOT_FOUND'|'READ_ONLY'|'STORAGE_LOAD_FAILED'
 *   |'STORAGE_SAVE_FAILED'|'IMPORT_INVALID'|'ADAPTER_FAILED'} TackbackErrorCode
 */

export class TackbackError extends Error {
  /**
   * @param {TackbackErrorCode} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'TackbackError';
    /** @type {TackbackErrorCode} */
    this.code = code;
  }
}
