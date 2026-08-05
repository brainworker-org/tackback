// @brainworker/tackback/panel — localization (display language), switchable at runtime.
//
// English-first: the default bundle is `en`, `ja` ships alongside. A LocaleRegistry holds bundles;
// `setLocale(lang)` switches if registered, else falls back to the default (a warning, never a
// crash). Consumers add languages with `registerLocale(lang, bundle)`. Labels support `{n}`-style
// interpolation.

/** @typedef {Record<string, string>} LabelBundle  // flat dotted keys, e.g. 'theme.dark' */

/** @type {LabelBundle} */
export const EN = {
  'panel.count': '💬 {n}',
  'panel.authorPlaceholder': '✍️ Name (recorded in export)',
  'panel.export': '📋 Export JSON',
  'panel.import': '📥 Import JSON',
  'panel.toggleMarks': 'Toggle marks',
  'panel.clearAll': 'Clear all',
  'panel.docThread': '🗒 About this document',
  'anchor.document': 'this document',
  'import.placeholder': 'Paste an exported Tackback JSON here, then Load. Merges in — existing comments are kept.',
  'import.load': 'Load', 'import.badJson': 'Not valid JSON — check the pasted text.',
  'panel.theme': '🌗 Theme: {mode}',
  'theme.auto': 'Auto', 'theme.light': 'Light', 'theme.dark': 'Dark',
  'theme.default': 'Default', 'theme.ocean': 'Ocean', 'theme.passion': 'Passion', 'theme.ochre': 'Ochre',
  'popup.placeholder': 'Comment… (⌘/Ctrl+Enter to save)',
  'popup.save': 'Save', 'popup.cancel': 'Cancel', 'popup.emojiOnly': '(reaction only)',
  'menu.delete': '🗑 Delete anchor',
  'event.create': '➕ Created', 'event.move': '✋ Moved', 'event.resize': '⤡ Resized',
  'hint.html': 'Right-click to comment. Select text first to pin a phrase. ⌘/Ctrl+Enter saves.',
  'hint.pdf': 'Right-drag a rectangle to comment a region. It follows zoom and scroll.',
  'confirm.clearAll': 'Clear all comments on this document?',
};

/** @type {LabelBundle} */
export const JA = {
  'panel.count': '💬 {n} 件',
  'panel.authorPlaceholder': '✍️ 名前(export に記録)',
  'panel.export': '📋 JSON を書き出し',
  'panel.import': '📥 JSON を読み込み',
  'panel.toggleMarks': 'マーク表示 ⇄',
  'panel.clearAll': '全消去',
  'panel.docThread': '🗒 文書全体について',
  'anchor.document': 'この文書',
  'import.placeholder': 'エクスポート済みの Tackback JSON を貼り付けて「読み込み」。マージされ、既存コメントは保持されます。',
  'import.load': '読み込み', 'import.badJson': 'JSON が不正です — 貼り付けたテキストを確認してください。',
  'panel.theme': '🌗 表示: {mode}',
  'theme.auto': '自動', 'theme.light': 'ライト', 'theme.dark': 'ダーク',
  'theme.default': 'デフォルト', 'theme.ocean': 'オーシャン', 'theme.passion': 'パッション', 'theme.ochre': 'オークル',
  'popup.placeholder': 'コメント…(⌘/Ctrl+Enter で保存)',
  'popup.save': '保存', 'popup.cancel': '取消', 'popup.emojiOnly': '(絵文字のみ)',
  'menu.delete': '🗑 アンカーを削除',
  'event.create': '➕ 作成', 'event.move': '✋ 移動', 'event.resize': '⤡ リサイズ',
  'hint.html': '右クリックでコメント。テキスト選択してから右クリックで箇所を限定。⌘/Ctrl+Enter で保存。',
  'hint.pdf': '右ドラッグで領域を囲んでコメント。ズーム/スクロールしても箇所は追従。',
  'confirm.clearAll': 'このドキュメントのコメントを全消去しますか?',
};

export class LocaleRegistry {
  /** @param {string} [defaultLang] */
  constructor(defaultLang = 'en') {
    /** @type {Map<string, LabelBundle>} */
    this._bundles = new Map([['en', EN], ['ja', JA]]);
    this._default = defaultLang;
    this._active = defaultLang;
  }

  /** @param {string} lang @param {LabelBundle} bundle */
  register(lang, bundle) {
    this._bundles.set(lang, { ...(this._bundles.get(lang) || {}), ...bundle });
  }

  has(lang) { return this._bundles.has(lang); }
  get active() { return this._active; }

  /**
   * Switch the active language. If unknown, keep the default and report (never throw).
   * @param {string} lang @returns {boolean} whether the requested language was available
   */
  setLocale(lang) {
    if (this._bundles.has(lang)) { this._active = lang; return true; }
    // eslint-disable-next-line no-console
    console.warn(`[tackback] locale "${lang}" not registered; staying on "${this._default}"`);
    this._active = this._default;
    return false;
  }

  /**
   * Resolve a label key for the active language (falls back to default bundle, then the key itself).
   * @param {string} key @param {Record<string, string|number>} [vars]
   * @returns {string}
   */
  t(key, vars) {
    const bundle = this._bundles.get(this._active) || this._bundles.get(this._default) || {};
    const fallback = this._bundles.get(this._default) || {};
    let s = bundle[key] ?? fallback[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  }
}
