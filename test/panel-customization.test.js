// node:test — the three customization axes: theming, reactions, i18n (pure logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, buildThemeCSS, LIGHT, DARK, TOKENS, PALETTES } from '../src/panel/theme.js';
import { DEFAULT_REACTIONS, resolveReaction } from '../src/panel/reactions.js';
import { LocaleRegistry } from '../src/panel/i18n.js';

// ---- theming ----
test('resolveTheme: auto follows OS preference', () => {
  assert.equal(resolveTheme('auto', true)['--tb-bg'], DARK['--tb-bg']);
  assert.equal(resolveTheme('auto', false)['--tb-bg'], LIGHT['--tb-bg']);
});

test('resolveTheme: explicit light/dark ignore OS', () => {
  assert.equal(resolveTheme('dark', false)['--tb-bg'], DARK['--tb-bg']);
  assert.equal(resolveTheme('light', true)['--tb-bg'], LIGHT['--tb-bg']);
});

test('resolveTheme: custom palette overrides base tokens', () => {
  const t = resolveTheme({ '--tb-accent': '#7c3aed' }, false);
  assert.equal(t['--tb-accent'], '#7c3aed');         // overridden
  assert.equal(t['--tb-bg'], LIGHT['--tb-bg']);      // base kept
});

test('resolveTheme: a named palette layers its accent over the OS light/dark base', () => {
  // dark mode: base is DARK, palette overrides only its accent tokens (the "follows dark mode" claim)
  const oceanDark = resolveTheme(PALETTES.ocean, true);
  assert.equal(oceanDark['--tb-bg'], DARK['--tb-bg']);            // base flips with the OS
  assert.equal(oceanDark['--tb-accent'], PALETTES.ocean['--tb-accent']);  // accent stays the palette's
  // light mode: same palette, light base
  const oceanLight = resolveTheme(PALETTES.ocean, false);
  assert.equal(oceanLight['--tb-bg'], LIGHT['--tb-bg']);
  assert.equal(oceanLight['--tb-accent'], PALETTES.ocean['--tb-accent']);
});

test('buildThemeCSS: emits --tb-* on the panel root; every token covered', () => {
  const css = buildThemeCSS(LIGHT);
  assert.match(css, /\[data-tb-root\]/);
  for (const tok of TOKENS) assert.ok(css.includes(tok), `missing ${tok}`);
});

// ---- reactions ----
test('DEFAULT_REACTIONS is a small, focused set (👍/👎/❓) with no baked-in domain meaning', () => {
  assert.equal(DEFAULT_REACTIONS.length, 3, 'reduced to three plain sentiments');
  assert.deepEqual(DEFAULT_REACTIONS.map((r) => r.icon), ['👍', '👎', '❓']);
  assert.deepEqual(DEFAULT_REACTIONS.map((r) => r.id), ['agree', 'disagree', 'question'],
    'ids are generic sentiments — not "approve"/"reject" (that meaning is the integrator\'s)');
});

test('resolveReaction: known id → icon + localized label', () => {
  assert.deepEqual(resolveReaction(DEFAULT_REACTIONS, 'question', 'ja'), { icon: '❓', label: '疑問' });
  assert.deepEqual(resolveReaction(DEFAULT_REACTIONS, 'question', 'en'), { icon: '❓', label: 'Question' });
});

test('resolveReaction: unknown id (e.g. migrated emoji char) renders literally', () => {
  assert.deepEqual(resolveReaction(DEFAULT_REACTIONS, '👍', 'en'), { icon: '👍', label: '👍' });
});

test('resolveReaction: a fully custom reaction set works', () => {
  const custom = [{ id: 'blocker', icon: '🚧', label: { en: 'Blocker', ja: 'ブロッカー' } }];
  assert.deepEqual(resolveReaction(custom, 'blocker', 'ja'), { icon: '🚧', label: 'ブロッカー' });
});

// ---- i18n ----
test('LocaleRegistry: English-first default + interpolation', () => {
  const r = new LocaleRegistry();
  assert.equal(r.active, 'en');
  assert.equal(r.t('panel.count', { n: 3 }), '💬 3');
});

test('LocaleRegistry: switch to a registered language (ja shipped)', () => {
  const r = new LocaleRegistry();
  assert.equal(r.setLocale('ja'), true);
  assert.equal(r.t('panel.count', { n: 3 }), '💬 3 件');
  assert.equal(r.t('popup.save'), '保存');
});

test('LocaleRegistry: unknown language falls back to default (no throw)', () => {
  const r = new LocaleRegistry();
  const orig = console.warn; console.warn = () => {};
  const ok = r.setLocale('xx');
  console.warn = orig;
  assert.equal(ok, false);
  assert.equal(r.active, 'en');
  assert.equal(r.t('popup.save'), 'Save');
});

test('LocaleRegistry: registerLocale adds a custom language', () => {
  const r = new LocaleRegistry();
  r.register('fr', { 'popup.save': 'Enregistrer' });
  assert.equal(r.setLocale('fr'), true);
  assert.equal(r.t('popup.save'), 'Enregistrer');
  assert.equal(r.t('popup.cancel'), 'Cancel');   // missing key → default bundle
});
