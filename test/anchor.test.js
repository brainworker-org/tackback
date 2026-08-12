// node:test — region anchor math (clamp/zoom) + range quote resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRegion, regionToPx, buildQuoteSelector, resolveQuoteSelector, MIN_REGION_PX,
} from '../src/core/anchor.js';

test('normalizeRegion: in-bounds drag → 0..1 rect {x,y,width,height}', () => {
  const r = normalizeRegion(122.4, 79.2, 428.4, 142.56, 612, 792);
  assert.deepEqual(
    { x: +r.x.toFixed(4), y: +r.y.toFixed(4), width: +r.width.toFixed(4), height: +r.height.toFixed(4) },
    { x: 0.2, y: 0.1, width: 0.5, height: 0.08 });
});

test('normalizeRegion: off-page end clamped flush to edges', () => {
  const r = normalizeRegion(0.3 * 612, 0.4 * 792, 612 + 400, 792 + 600, 612, 792);
  for (const k of ['x', 'y', 'width', 'height']) assert.ok(r[k] >= 0 && r[k] <= 1);
  assert.equal(+(r.x + r.width).toFixed(4), 1);
  assert.equal(+(r.y + r.height).toFixed(4), 1);
});

test('normalizeRegion: degenerate / zero page → null', () => {
  assert.equal(normalizeRegion(10, 10, 10 + MIN_REGION_PX - 1, 60, 612, 792), null);
  assert.equal(normalizeRegion(0, 0, 50, 50, 0, 792), null);
});

test('regionToPx: zoom-independent (overlay = rect × current size)', () => {
  const rect = { x: 0.25, y: 0.1, width: 0.4, height: 0.15 };
  const a = regionToPx(rect, 612, 792), b = regionToPx(rect, 918, 1188);
  assert.equal(+(b.x / a.x).toFixed(4), 1.5);
  assert.equal(+(b.width / a.width).toFixed(4), 1.5);
});

test('buildQuoteSelector: captures exact + prefix/suffix context', () => {
  const text = 'The anchor must survive zoom and scroll changes.';
  const start = text.indexOf('survive'), end = start + 'survive'.length;
  const sel = buildQuoteSelector(text, start, end, 8);
  assert.equal(sel.exact, 'survive');
  assert.equal(sel.prefix, 'or must ');     // 8 chars preceding "survive"
  assert.equal(sel.suffix, ' zoom an');     // 8 chars following
});

test('resolveQuoteSelector: disambiguates a repeated phrase via prefix', () => {
  const text = 'set the value, then set the value again';
  // target the SECOND "the value"
  const sel = { exact: 'the value', prefix: 'then set ', suffix: ' again' };
  const hit = resolveQuoteSelector(text, sel);
  assert.equal(text.slice(hit.start, hit.end), 'the value');
  assert.equal(hit.start, text.lastIndexOf('the value'));
});

test('resolveQuoteSelector: unique exact match', () => {
  const text = 'a unique needle here';
  assert.deepEqual(resolveQuoteSelector(text, { exact: 'needle' }), { start: 9, end: 15 });
});

test('resolveQuoteSelector: no match → null (orphaned, never mis-anchors)', () => {
  assert.equal(resolveQuoteSelector('nothing relevant', { exact: 'absent', prefix: 'x' }), null);
});

test('resolveQuoteSelector: positional fallback only if text still matches', () => {
  const text = 'keep this exact span intact';
  const sel = { exact: 'exact span', start: text.indexOf('exact span'), end: text.indexOf('exact span') + 10 };
  assert.ok(resolveQuoteSelector(text, sel));
  // if the slice no longer equals exact, fallback rejects
  assert.equal(resolveQuoteSelector('shifted text entirely here now', { exact: 'exact span', start: 5, end: 15 }), null);
});

// ---- DI-004: a selector may not carry half a character -----------------------------------------
//
// A character outside the BMP is two code units. Slicing between them keeps a lone surrogate, and
// nothing local complains: JSON.stringify escapes it, TextEncoder swaps in U+FFFD. It breaks where a
// strict UTF-8 encoder refuses it — the far end of a send — so what a reader saw was a comment that
// never went and never said why. Eight of them, on one page.

const EMOJI_TEXT = '💬2 未読 💬2 既読(AI) 💬2 既読(人間) 💬2 バッジ 💬3 影付き 💬2 この文書について';
const hasLoneSurrogate = (s) => !s.isWellFormed();

test('DI-004: no field of a selector is left holding half a character', () => {
  // The case that was actually reported: an offset landing inside the first 💬.
  const one = buildQuoteSelector(EMOJI_TEXT, 1, 3);
  for (const field of ['exact', 'prefix', 'suffix']) {
    assert.ok(!hasLoneSurrogate(one[field]), `${field} is well-formed: ${JSON.stringify(one[field])}`);
  }

  // And every selection this text can produce, not just the reported one — the bug was a boundary
  // that happened to fall inside a pair, so the only honest coverage is the sweep.
  let checked = 0;
  for (let start = 0; start < EMOJI_TEXT.length - 1; start++) {
    for (let len = 1; len <= 6 && start + len <= EMOJI_TEXT.length; len++) {
      const sel = buildQuoteSelector(EMOJI_TEXT, start, start + len);
      checked++;
      assert.ok(!hasLoneSurrogate(sel.exact), `exact at ${start}+${len}`);
      assert.ok(!hasLoneSurrogate(sel.prefix), `prefix at ${start}+${len}`);
      assert.ok(!hasLoneSurrogate(sel.suffix), `suffix at ${start}+${len}`);
      assert.notEqual(sel.exact, '', `a quote is never emptied by the rounding (${start}+${len})`);
    }
  }
  assert.ok(checked > 300, `the sweep really ran (${checked} selections)`);
});

test('DI-004: the offsets it hands back are on character boundaries too', () => {
  // start/end are stored on the anchor and used as the positional fallback, so they have to be
  // usable on their own — a stored offset inside a pair would re-create the same half character.
  for (let start = 0; start < EMOJI_TEXT.length - 1; start++) {
    const sel = buildQuoteSelector(EMOJI_TEXT, start, start + 2);
    assert.ok(!hasLoneSurrogate(EMOJI_TEXT.slice(0, sel.start)), `start ${sel.start} splits nothing`);
    assert.ok(!hasLoneSurrogate(EMOJI_TEXT.slice(sel.end)), `end ${sel.end} splits nothing`);
  }
});

test('DI-004: the rounding SHRINKS — it never reaches for a character nobody selected', () => {
  // Both directions produce a well-formed string, so well-formedness alone does not say which way it
  // went. The direction is the contract: growing the quote would comment on a character the reader did
  // not select, and growing a context window would claim surroundings that were never checked for
  // uniqueness. Index 1 of this text is the second half of the leading 💬 — a real split.
  assert.equal(EMOJI_TEXT.codePointAt(0), 0x1F4AC, 'the fixture really starts with an astral character');
  const sel = buildQuoteSelector(EMOJI_TEXT, 1, 5);
  assert.equal(sel.start, 2, 'forward, off the pair — not back to 0, which would swallow the emoji');
  assert.equal(sel.exact.startsWith('💬'), false, 'the quote does not gain a character');
  assert.equal(sel.exact, EMOJI_TEXT.slice(2, 5));

  // the same, for the far edge of a context window: it comes IN, so the window can only get shorter
  const mid = EMOJI_TEXT.indexOf('バッジ');
  const win = buildQuoteSelector(EMOJI_TEXT, mid, mid + 3, 5);
  assert.ok(win.prefix.length <= 5, `the prefix window never grows past ctx (${win.prefix.length})`);
  assert.ok(win.suffix.length <= 5, `nor the suffix window (${win.suffix.length})`);

  const hit = resolveQuoteSelector(EMOJI_TEXT, sel);
  assert.ok(hit, 'the shortened quote still resolves');
  assert.equal(EMOJI_TEXT.slice(hit.start, hit.end), sel.exact, 'and resolves to what it says');
});

test('DI-004: a selection covering only half a character takes the whole one', () => {
  // Nothing is left to shrink to here, and an empty quote resolves to nothing at all.
  const sel = buildQuoteSelector('a💬b', 1, 2);
  assert.equal(sel.exact, '💬', 'the character the reader saw');
  assert.ok(!hasLoneSurrogate(sel.exact));
});

test('DI-004: text with no astral characters comes back byte for byte unchanged', () => {
  // The rounding must be invisible to everything that was already fine — this is the pair that
  // catches a fix which "helpfully" adjusts every selector.
  const plain = 'The quick brown fox jumps over the lazy dog, and then some more text follows here.';
  for (let start = 0; start < plain.length - 1; start++) {
    for (const len of [1, 3, 7]) {
      if (start + len > plain.length) continue;
      const sel = buildQuoteSelector(plain, start, start + len);
      assert.deepEqual(sel, {
        exact: plain.slice(start, start + len),
        prefix: plain.slice(Math.max(0, start - 24), start),
        suffix: plain.slice(start + len, Math.min(plain.length, start + len + 24)),
        start,
        end: start + len,
      }, `unchanged at ${start}+${len}`);
    }
  }
});
