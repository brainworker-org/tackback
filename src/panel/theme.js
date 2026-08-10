// @brainworker/tackback/panel — theming (color scheme), customizable & dynamic.
//
// Every color is a `--tb-*` CSS custom property, so a consumer can re-skin with plain CSS (no JS).
// `theme: 'auto'|'light'|'dark'|ThemeTokens` picks/extends a palette; 'auto' follows the OS and
// updates live (the panel wires a matchMedia listener and re-applies on change).

/** The full token contract (documented; override any in your own CSS). */
export const TOKENS = [
  '--tb-bg', '--tb-fg', '--tb-accent', '--tb-border',
  '--tb-mark-bg', '--tb-mark-outline', '--tb-pin-bg', '--tb-pin-fg',
  '--tb-popup-bg', '--tb-popup-fg', '--tb-muted', '--tb-danger',
  // `--tb-attention` is the highlight an anchor wears while it carries an ATTENTION flag
  // (setAnchorAttention). It is a generic "needs-notice" tint — the *meaning* of the flag (e.g.
  // "unread") is the integrator's, never Tackback's. Override it like any other token.
  '--tb-attention',
  // `--tb-unread` rings an anchor holding something this reader has not got to yet. Deliberately a
  // different channel from attention rather than a different value of the same one: attention fills,
  // unread outlines, and an anchor that is both wears both. One tint doing two jobs is how "I read it
  // and the mark is still there" comes back — the exact failure this version removes.
  '--tb-unread',
];

export const LIGHT = {
  '--tb-bg': '#ffffff', '--tb-fg': '#1c1e21', '--tb-accent': '#33aa77', '--tb-border': '#cccccc',
  '--tb-mark-bg': 'rgba(255,210,0,.20)', '--tb-mark-outline': '#d9a400',
  '--tb-pin-bg': '#d9a400', '--tb-pin-fg': '#000000',
  '--tb-popup-bg': '#ffffff', '--tb-popup-fg': '#111111', '--tb-muted': '#777777', '--tb-danger': '#cc3333',
  '--tb-attention': '#ef7f0e', '--tb-unread': '#2f6fed',
};

export const DARK = {
  '--tb-bg': '#1b1c1d', '--tb-fg': '#e6e6e6', '--tb-accent': '#5aa', '--tb-border': '#555555',
  '--tb-mark-bg': 'rgba(255,210,0,.16)', '--tb-mark-outline': '#d9a400',
  '--tb-pin-bg': '#d9a400', '--tb-pin-fg': '#000000',
  '--tb-popup-bg': '#2a2c2e', '--tb-popup-fg': '#eeeeee', '--tb-muted': '#aaaaaa', '--tb-danger': '#e06666',
  '--tb-attention': '#f59331', '--tb-unread': '#6ea8fe',
};

/**
 * Named accent palettes — layered over the OS light/dark base (the optional "play" themes the
 * panel's theme switch can cycle through). Each is just a partial token map fed to `resolveTheme`.
 */
export const PALETTES = {
  ocean:   { '--tb-accent': '#1d9bf0', '--tb-mark-bg': 'rgba(29,155,240,.18)', '--tb-mark-outline': '#1d9bf0', '--tb-pin-bg': '#1d9bf0', '--tb-pin-fg': '#ffffff' },
  passion: { '--tb-accent': '#d6336c', '--tb-mark-bg': 'rgba(214,51,108,.18)', '--tb-mark-outline': '#d6336c', '--tb-pin-bg': '#d6336c', '--tb-pin-fg': '#ffffff' },
  ochre:   { '--tb-accent': '#c98a00', '--tb-mark-bg': 'rgba(217,164,0,.22)', '--tb-mark-outline': '#d9a400', '--tb-pin-bg': '#d9a400', '--tb-pin-fg': '#000000' },
};

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
