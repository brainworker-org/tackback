// @brainworker/tackback/panel — actor rendering logic (DOM-free), so "who gets which color" is
// headlessly testable, like the gesture/popup decisions in interaction.js.
//
// Tackback ships NO actor categories and NO category colors. An author may carry an opaque `kind`
// string; the INTEGRATOR maps kinds to colors (`attachPanel({ actorColors })`). Nothing here knows
// what 'ai' or 'human' mean — this module only resolves an author to a color and finds the last
// speaker of a thread. The meaning of the categories stays entirely with the caller.

/**
 * @typedef {import('../core/model.js').Author} Author
 * @typedef {import('../core/model.js').Comment} Comment
 */

/**
 * The fallback palette: a deterministic per-IDENTITY hue for an author with no mapped category, so
 * "who said what" stays legible even with no injected map.
 */
export const AUTHOR_PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

/** The stable key an author is identified by (its id, else its category, else ''). */
export function authorKey(a) { return !a ? '' : (typeof a === 'string' ? a : (a.id || a.kind || '')); }

/** Normalize a CSS color for comparison (case/whitespace only — not a color-space conversion). */
export function normalizeColor(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

/**
 * The set of colors an injected category map has claimed. The fallback palette is filtered against
 * it so an UNMAPPED author can never be painted the same color as a MAPPED category — otherwise a
 * map like `{ ai: '#2563eb' }` (a color that is also in the palette) would let an unrelated author
 * masquerade as that category. Comparison is literal: a caller mixing notations for the same color
 * (`#2563eb` vs `rgb(37,99,235)`) is outside what a string compare can catch.
 * @param {Record<string,string>|null|undefined} actorColors
 * @returns {Set<string>}
 */
export function claimedColors(actorColors) {
  const out = new Set();
  for (const v of Object.values(actorColors || {})) { const n = normalizeColor(v); if (n) out.add(n); }
  return out;
}

/**
 * A deterministic color for an author identity, drawn from the palette MINUS any color already
 * claimed by an injected category map. Anonymous / unnamed → '' (no tint: the anchor keeps its
 * default pin color). If a map claims every palette entry, the unfiltered palette is used rather
 * than dropping the tint entirely — a duplicate color reads better than an invisible author.
 * @param {Author|null|undefined} a
 * @param {Set<string>} [claimed]
 * @returns {string}
 */
export function authorColor(a, claimed) {
  const k = authorKey(a);
  if (!k) return '';
  const pool = (claimed && claimed.size)
    ? AUTHOR_PALETTE.filter((c) => !claimed.has(normalizeColor(c)))
    : AUTHOR_PALETTE;
  const use = pool.length ? pool : AUTHOR_PALETTE;
  let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return use[h % use.length];
}

/**
 * Resolve an author to its display color: the caller-injected CATEGORY color (author.kind → color)
 * wins; otherwise the generic per-identity hue, disjoint from the injected map.
 * @param {Author|null|undefined} author
 * @param {Record<string,string>|null|undefined} actorColors
 * @param {Set<string>} [claimed]   pass the memoized claimedColors(actorColors) to avoid rebuilding it
 * @returns {string}
 */
export function actorColorOf(author, actorColors, claimed) {
  const kind = author && typeof author === 'object' ? author.kind : null;
  if (kind && actorColors && actorColors[kind]) return actorColors[kind];
  return authorColor(author, claimed || claimedColors(actorColors));
}

/**
 * A thread's utterances as ONE chronological list — every comment and every reply, each carrying a
 * stable `key` so a renderer can tell what it has already drawn. This is what makes an OPEN thread
 * able to grow: re-run it after a change, skip the keys already on screen, append the rest.
 * @param {Comment[]|null|undefined} comments
 * @returns {Array<{key:string, t:string, kind:'comment'|'reply', c?:Comment, rep?:object}>}
 */
export function timelineItems(comments) {
  const items = [];
  for (const c of comments || []) {
    items.push({ key: `c:${c.id}`, t: String(c.createdAt || ''), kind: 'comment', c });
    for (const rep of (c.replies || [])) {
      items.push({ key: `r:${rep.id}`, t: String(rep.createdAt || ''), kind: 'reply', rep });
    }
  }
  items.sort((a, b) => a.t.localeCompare(b.t));
  return items;
}

/**
 * How many UTTERANCES a thread holds — every comment plus every reply. This is what an anchor badge
 * counts: a thread where one comment drew three replies reads as four, because four things were said
 * there. Counting root comments only would make a busy conversation look untouched.
 * @param {Comment[]|null|undefined} comments
 * @returns {number}
 */
export function utteranceCount(comments) {
  let n = 0;
  for (const c of comments || []) n += 1 + ((c.replies && c.replies.length) || 0);
  return n;
}

/**
 * The author of the LAST utterance in a thread — the most recent comment OR reply by timestamp — so
 * an anchor can be tinted by "who touched it last". Pure and category-agnostic (returns the Author
 * as-is; ties resolve to the later item in iteration order).
 * @param {Comment[]|null|undefined} comments
 * @returns {Author|null}
 */
export function lastSpeaker(comments) {
  let best = null, bestT = '';
  for (const c of comments || []) {
    const ct = String(c.createdAt || '');
    if (ct >= bestT) { bestT = ct; best = c.author; }
    for (const rep of (c.replies || [])) {
      const rt = String(rep.createdAt || '');
      if (rt >= bestT) { bestT = rt; best = rep.author; }
    }
  }
  return best;
}
