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
