// @brainworker/tackback/panel — reactions (the icons + their meanings), fully customizable.
//
// Feedback needs vary, so the "emoji" concept is generalized to a reaction set. Each reaction has a
// stable `id` (what a comment stores), an `icon` (emoji / inline SVG / text), and a `label` (its
// meaning, optionally per-locale). Changing the icon never breaks stored comments — they reference
// the id. An unknown id (e.g. a legacy emoji char migrated from v1) renders literally as a fallback.

/**
 * @typedef {{ id: string, icon: string, label: string | Record<string,string> }} ReactionDef
 */

/**
 * The built-in set — a small, focused DEFAULT of three plain sentiments (👍 up / 👎 down / ❓ query).
 * It is deliberately minimal: fewer icons read faster and cover the common "yes / no / unsure" verdict
 * shape without Tackback assigning any DOMAIN meaning to them. The *meaning* of a reaction (e.g.
 * treating 👍 as "approve" and 👎 as "send back" in a review workflow) belongs to the integrator, which
 * reads `comment.reaction` (a stable id) — Tackback only records which reaction was applied.
 *
 * Replace the whole set via the `reactions` option for a purpose-built set with your own ids/labels
 * (e.g. a review set: 👍 / 👎 / ❓ / 🔧). Changing an icon never breaks stored comments — they
 * reference the id, and an unknown id renders literally (see resolveReaction).
 */
export const DEFAULT_REACTIONS = [
  { id: 'agree', icon: '👍', label: { en: 'Agree', ja: '賛成' } },
  { id: 'disagree', icon: '👎', label: { en: 'Disagree', ja: '反対' } },
  { id: 'question', icon: '❓', label: { en: 'Question', ja: '疑問' } },
];

/**
 * Resolve a reaction id to its display { icon, label } for a locale. Falls back to rendering the id
 * itself (so a migrated v1 emoji char still shows) when the id is not in the set.
 * @param {ReactionDef[]} reactions
 * @param {string} id
 * @param {string} [locale]
 * @returns {{ icon: string, label: string }}
 */
export function resolveReaction(reactions, id, locale = 'en') {
  const def = reactions.find((r) => r.id === id);
  if (!def) return { icon: id, label: id };   // unknown → literal (legacy emoji char, etc.)
  const label = typeof def.label === 'string' ? def.label : (def.label[locale] ?? def.label.en ?? def.id);
  return { icon: def.icon, label };
}
