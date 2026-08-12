// @brainworker/tackback/panel — theming (color scheme), customizable & dynamic.
//
// Every color is a `--tb-*` CSS custom property, so a consumer can re-skin with plain CSS (no JS).
// `theme: 'auto'|'light'|'dark'|ThemeTokens` picks/extends a palette; 'auto' follows the OS and
// updates live (the panel wires a matchMedia listener and re-applies on change).

/** The full token contract (documented; override any in your own CSS). */
export const TOKENS = [
  '--tb-bg', '--tb-fg', '--tb-accent', '--tb-border',
  '--tb-mark-bg', '--tb-mark-outline', '--tb-badge-bg', '--tb-badge-fg',
  '--tb-pane-bg', '--tb-pane-fg', '--tb-muted', '--tb-danger',
  // `--tb-unread` FILLS a badge holding something this reader has not got to yet, and it breathes on
  // a two-second cycle while it does. Reading the thread takes the fill away and the badge goes back
  // to the colour of whoever spoke last, so the mark and its removal are one thing rather than two.
  //
  // The ink on top of that fill is not a token. It follows the light/dark base — white on the light
  // orange, black on the lighter dark one — and a token would make that a promise callers could
  // change independently of the fill, which is not a promise worth making.
  '--tb-unread',
];

export const LIGHT = {
  '--tb-bg': '#ffffff', '--tb-fg': '#1c1e21', '--tb-accent': '#33aa77', '--tb-border': '#cccccc',
  '--tb-mark-bg': 'rgba(255,210,0,.20)', '--tb-mark-outline': '#d9a400',
  '--tb-badge-bg': '#d9a400', '--tb-badge-fg': '#000000',
  '--tb-pane-bg': '#ffffff', '--tb-pane-fg': '#111111', '--tb-muted': '#777777', '--tb-danger': '#cc3333',
  '--tb-unread': '#ef7f0e',
};

export const DARK = {
  '--tb-bg': '#1b1c1d', '--tb-fg': '#e6e6e6', '--tb-accent': '#5aa', '--tb-border': '#555555',
  '--tb-mark-bg': 'rgba(255,210,0,.16)', '--tb-mark-outline': '#d9a400',
  '--tb-badge-bg': '#d9a400', '--tb-badge-fg': '#000000',
  '--tb-pane-bg': '#2a2c2e', '--tb-pane-fg': '#eeeeee', '--tb-muted': '#aaaaaa', '--tb-danger': '#e06666',
  '--tb-unread': '#f59331',
};

/**
 * Named accent palettes — layered over the OS light/dark base (the optional "play" themes the
 * panel's theme switch can cycle through). Each is just a partial token map fed to `resolveTheme`.
 */
export const PALETTES = {
  ocean:   { '--tb-accent': '#1d9bf0', '--tb-mark-bg': 'rgba(29,155,240,.18)', '--tb-mark-outline': '#1d9bf0', '--tb-badge-bg': '#1d9bf0', '--tb-badge-fg': '#ffffff' },
  passion: { '--tb-accent': '#d6336c', '--tb-mark-bg': 'rgba(214,51,108,.18)', '--tb-mark-outline': '#d6336c', '--tb-badge-bg': '#d6336c', '--tb-badge-fg': '#ffffff' },
  ochre:   { '--tb-accent': '#c98a00', '--tb-mark-bg': 'rgba(217,164,0,.22)', '--tb-mark-outline': '#d9a400', '--tb-badge-bg': '#d9a400', '--tb-badge-fg': '#000000' },
};

/**
 * The unread fill each palette uses, per light/dark base.
 *
 * A palette re-tints what a comment IS; unread says one has not been read yet, and the two have to
 * stay apart — from each other and from the colour of whoever spoke last, which an integration
 * supplies (blue and pink, in the one this was chosen against). So the fill is picked per palette
 * rather than shared, and the choice was made by looking at the three side by side. The default (no
 * palette) keeps the orange it has had since it meant "unread" at all.
 *
 * Kept beside PALETTES rather than inside it because a palette is a flat token map, and this one
 * token has two values. The pulse is NOT per palette — it is the same everywhere.
 */
export const PALETTE_UNREAD = {
  ocean:   { light: '#1ad411', dark: '#4bf042' },
  passion: { light: '#11d490', dark: '#42f0b3' },
  ochre:   { light: '#d48511', dark: '#f0a942' },
};

/**
 * A named palette as a plain token map, with the unread fill for this base folded in.
 * @param {string} key            a key of PALETTES
 * @param {boolean} prefersDark   the current base
 * @returns {Record<string,string>|'auto'}  'auto' for an unknown key (nothing to apply)
 */
export function paletteTheme(key, prefersDark) {
  const base = PALETTES[/** @type {keyof PALETTES} */ (key)];
  if (!base) return 'auto';
  const unread = PALETTE_UNREAD[/** @type {keyof PALETTE_UNREAD} */ (key)];
  return unread ? { ...base, '--tb-unread': prefersDark ? unread.dark : unread.light } : { ...base };
}

/**
 * Resolve a `theme` option into a concrete token map.
 * @param {'auto'|'light'|'dark'|Record<string,string>} theme
 * @param {boolean} prefersDark   the current OS preference (for 'auto')
 * @returns {Record<string,string>}
 */
export function resolveTheme(theme, prefersDark) {
  if (theme === 'dark') return { ...DARK };
  if (theme === 'light') return { ...LIGHT };
  if (theme && typeof theme === 'object') return { ...(prefersDark ? DARK : LIGHT), ...theme }; // custom over base
  // 'auto' (or unset) follows the OS.
  return { ...(prefersDark ? DARK : LIGHT) };
}

/**
 * Build a CSS rule applying a token map to the panel root.
 * @param {Record<string,string>} tokens
 * @param {string} [selector]
 * @returns {string}
 */
export function buildThemeCSS(tokens, selector = '[data-tb-root]') {
  const body = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n}`;
}

/** The ink an unread mark is written in — black, on every base and every palette. */
const UNREAD_INK = '#000000';

/**
 * The ink a filled unread mark is written in.
 *
 * Not a token, deliberately. It is not a colour anyone chooses; it is whatever stays legible on the
 * fill beside it, so publishing it as a token would offer a promise that can only be used to break
 * the pairing. It is emitted as a plain rule alongside the token map instead.
 *
 * It used to follow the base — white on light, black on dark. Measured against the fills, white was
 * the weaker half of that pair everywhere, and on the light orange it read at 2.7:1 where black reads
 * at 7.7:1. It is black on both bases now, and on every palette fill.
 * @param {string} [selector]
 * @returns {string}
 */
export function buildUnreadInkCSS(selector = '[data-tb-root]') {
  return `${selector} .tb-badge.tb-unread,\n`
    + `${selector} .tb-docbar.tb-unread .tb-docbar-count { color: ${UNREAD_INK} !important; }`;
}
