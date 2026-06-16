// @brainworker/tackback — replay model: merge N exported envelopes (multi-author) into one
// timeline-ordered, author-attributed comment set for re-rendering the review over the source doc
// (REQ-505, grounded in the proven tackback_replay.py). Tackback is the display RECEIVER: each
// comment already carries its author (source) + createdAt (timeline) in the schema (REQ-301), so
// replay just orders by timeline and distinguishes authors — no separate tool.
//
// This is the headless model half. Anchor re-resolution + orphan isolation happen at RENDER via the
// shared resolution module (REQ-004/014) — the merge NEVER drops a comment, so an anchor that won't
// resolve is still present (the renderer isolates it as an orphan, never a silent drop). Per-author
// colour distinction is a render concern (the renderer keys off comment.author).

import { parseEnvelope } from './export.js';

/**
 * Resolve a comment's author for replay: an explicit per-source override wins, then the comment's own
 * author (object or string), then the envelope's exportedBy, then a fallback label for the source.
 * Mirrors tackback_replay.py's precedence (override > author key > exportedBy > filename stem).
 * @returns {import('./model.js').Author|string}
 */
function resolveAuthor(comment, exportedBy, fallback, override) {
  if (override != null) return override;
  if (comment.author != null) return comment.author;
  if (exportedBy != null) return exportedBy;
  return fallback;
}

const authorKey = (a) => (a == null ? '' : (typeof a === 'string' ? a : (a.id ?? '')));

/**
 * Build the replay model from exported envelopes.
 * @param {Array<{ envelope: unknown, author?: import('./model.js').Author|string, label?: string }>} sources
 * @param {{ referenceRevision?: string|null }} [opts]  the doc revision being replayed against, for mismatch detection
 * @returns {{
 *   comments: import('./model.js').Comment[],   // every comment, author-tagged, ordered by createdAt (timeline)
 *   authors: Array<import('./model.js').Author|string>,   // distinct authors, first-seen order
 *   revMismatches: Array<{ source: string|number, expected: string, actual: string }>
 * }}
 */
export function buildReplayModel(sources, opts = {}) {
  const referenceRevision = opts.referenceRevision ?? null;
  /** @type {import('./model.js').Comment[]} */
  const comments = [];
  const revMismatches = [];

  (sources || []).forEach((src, i) => {
    const raw = src.envelope;
    const { comments: parsed, document } = parseEnvelope(raw);
    const isObjEnv = raw && typeof raw === 'object' && !Array.isArray(raw);
    const exportedBy = isObjEnv ? (/** @type {any} */ (raw).exportedBy ?? null) : null;
    const label = src.label != null ? src.label : `reviewer ${i + 1}`;

    const rev = document && document.revisionHash;
    if (referenceRevision != null && rev != null && rev !== referenceRevision) {
      revMismatches.push({ source: src.label != null ? src.label : i, expected: referenceRevision, actual: rev });
    }

    for (const c of parsed) {
      // never dropped — an unresolvable anchor is orphaned at render, not silently lost
      comments.push({ ...c, author: resolveAuthor(c, exportedBy, label, src.author) });
    }
  });

  // timeline order: ascending createdAt (ISO strings sort lexicographically). Stable for equal ts.
  comments.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  // distinct authors in first-seen-along-the-timeline order (the legend/colour assignment order).
  const authors = [];
  const seen = new Set();
  for (const c of comments) {
    const key = authorKey(c.author);
    if (key && !seen.has(key)) { seen.add(key); authors.push(c.author); }
  }
  return { comments, authors, revMismatches };
}
