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
 * The built-in set — a broad palette that works out of the box. Replace it via the `reactions`
 * option for a purpose-built, focused set (e.g. a 4-button review set: 👍 / 👎 / ❓ / 🔧).
 */
export const DEFAULT_REACTIONS = [
  { id: 'agree', icon: '👍', label: { en: 'Agree', ja: '賛成' } },
  { id: 'disagree', icon: '👎', label: { en: 'Disagree', ja: '反対' } },
  { id: 'question', icon: '❓', label: { en: 'Question', ja: '疑問' } },
  { id: 'concern', icon: '⚠️', label: { en: 'Concern', ja: '懸念' } },
  { id: 'cut', icon: '✂️', label: { en: 'Cut', ja: '削る' } },
  { id: 'good', icon: '✨', label: { en: 'Nice', ja: '良い' } },
  { id: 'rethink', icon: '🔁', label: { en: 'Rethink', ja: '要再考' } },
  { id: 'add', icon: '➕', label: { en: 'Add', ja: '追記希望' } },
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
