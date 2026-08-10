// @brainworker/tackback — export envelope build + import parse (with legacy migration).
//
// The export envelope is the formal seam to anything downstream (replay, an AI, the Interplay
// backend). `parseEnvelope` accepts both the v2 envelope and the original v1 export (flat `ts`
// records / `{ doc, comments:[…] }`) and normalizes to v2 — so old review artifacts keep working.

import { migrateLegacyComment, isLegacyComment } from './model.js';
import { TackbackError } from './errors.js';

/**
 * @param {object} p
 * @param {{ id: string, title?: string, revisionHash?: string|null, source?: string|null }} p.document
 * @param {string} p.now            ISO timestamp for exportedAt
 * @param {string} p.version        library version string
 * @param {string|null} [p.exportedBy]
 * @param {Array<{id:string,icon:string,label:any}>} [p.reactions]  active reaction legend (self-describing)
 * @param {Array<object>} [p.surfaces]  REQ-507: raster-surface descriptors so the file is self-describing
 * @param {import('./model.js').Comment[]} p.comments
 * @returns {import('./model.js').ExportEnvelope}
 */
export function buildEnvelope({ document, now, version, exportedBy = null, reactions, surfaces, comments }) {
  /** @type {any} */
  const env = {
    schemaVersion: 1,
    generator: { name: 'tackback', version },
    document,
    exportedAt: now,
    exportedBy: exportedBy ?? null,
    comments,
  };
  if (reactions && reactions.length) env.reactions = reactions;
  // REQ-507: surfaces[] carries the reproduction info for any region on a raster surface (PDF page /
  // canvas / image), so the self-describing file can later replay it (replay itself is post-v1).
  if (surfaces && surfaces.length) env.surfaces = surfaces;
  return env;
}

/**
 * What comes out of reading an envelope, whatever shape went in. Declared once and named by the
 * parser, because a return type written inline drifts from what is actually returned and nothing
 * notices: `deleted` and `surfaces` were carried at runtime and absent from the type for as long as
 * they have existed, so a consumer reading the declaration could not see the tombstones at all.
 * @typedef {object} ParsedEnvelope
 * @property {import('./model.js').Comment[]} comments  migrated to the current shape
 * @property {{ id?: string, revisionHash?: string, [k: string]: any }} [document]
 * @property {any[]} [reactions]
 * @property {string[]} [deleted]   ids the producer says are gone
 * @property {any[]} [surfaces]     raster-surface descriptors, carried through for replay
 */

/**
 * Parse + normalize an envelope (or a bare comment array) to v2 comments. Legacy records are
 * migrated. Throws TackbackError('IMPORT_INVALID') on unrecognized input.
 * @param {unknown} json
 * @returns {ParsedEnvelope}
 */
export function parseEnvelope(json) {
  let data = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch (err) {
      throw new TackbackError('IMPORT_INVALID', 'not valid JSON', { cause: err });
    }
  }
  // Accept: v2 envelope | v1 envelope | bare array of comments.
  const rawComments = Array.isArray(data) ? data
    : (data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).comments))
      ? /** @type {any} */ (data).comments
      : null;
  if (!rawComments) throw new TackbackError('IMPORT_INVALID', 'expected an envelope or a comment array');

  const comments = rawComments.map((c) => (isLegacyComment(c) ? migrateLegacyComment(c) : c));

  const out = { comments };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = /** @type {any} */ (data);
    if (d.document) out.document = d.document;
    else if (d.doc) out.document = { id: String(d.doc), title: d.doc, revisionHash: d.source_sha256 ?? null, source: d.source_md ?? null };
    if (d.reactions) out.reactions = d.reactions;
    // tombstones travel with the envelope, so they must survive a STRING envelope too — reading them
    // off the caller's original argument silently lost them whenever the input was JSON text.
    if (Array.isArray(d.deleted)) out.deleted = d.deleted;
    if (Array.isArray(d.surfaces)) out.surfaces = d.surfaces;   // REQ-507: carried through for (post-v1) replay
  }
  return out;
}
