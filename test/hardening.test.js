// Regression tests for the hardening review fixes.
// Each test pins a finding's fix so it can't silently regress.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidAnchor } from '../src/core/model.js';
import { resolveQuoteSelector, buildQuoteSelector } from '../src/core/anchor.js';
import { resolveAnchorDom } from '../src/panel/dom.js';
import { Tackback } from '../src/index.js';
import { memoryAdapter } from '../src/core/storage.js';

// ---- anchor validation hardening -----------------------------------------------------

test('isValidAnchor rejects empty/malformed anchors', () => {
  assert.equal(isValidAnchor({ type: 'block', elementId: '' }), false, 'empty block elementId');
  assert.equal(isValidAnchor({ type: 'range', elementId: 'x', selector: { exact: '' } }), false, 'empty exact');
  assert.equal(isValidAnchor({ type: 'region', surfaceId: '', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } }), false, 'empty surfaceId');
  assert.equal(isValidAnchor({ type: 'region', surfaceId: 'p1', rect: { x: 0, y: 0, width: NaN, height: 0.5 } }), false, 'NaN dim');
  assert.equal(isValidAnchor({ type: 'region', surfaceId: 'p1', rect: { x: -0.1, y: 0, width: 0.5, height: 0.5 } }), false, 'negative x');
  assert.equal(isValidAnchor({ type: 'region', surfaceId: 'p1', rect: { x: 0, y: 0, width: 0, height: 0.5 } }), false, 'zero width');
  assert.equal(isValidAnchor({ type: 'region', surfaceId: 'p1', rect: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }), false, 'x+width>1');
  // valid ones still pass
  assert.equal(isValidAnchor({ type: 'block', elementId: 'p1' }), true);
  assert.equal(isValidAnchor({ type: 'range', elementId: 'p1', selector: { exact: 'hi' } }), true);
  assert.equal(isValidAnchor({ type: 'region', surfaceId: 'page-1', rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }), true);
});

// ---- resolveQuoteSelector fails loud on ambiguous context --------------------------

test('ambiguous prefix+exact+suffix returns null (no silent mis-anchor)', () => {
  // "see X here" appears twice with identical 24-char context windows around "X"
  const text = 'see X here. see X here.';
  const sel = buildQuoteSelector(text, 4, 5); // "X" (first), prefix "see ", suffix " here. see X here." (truncated by ctx)
  // craft a genuinely ambiguous selector: short prefix/suffix that repeats
  const ambiguous = { exact: 'X', prefix: 'see ', suffix: ' here' };
  assert.equal(resolveQuoteSelector(text, ambiguous), null, 'ambiguous context → null (orphaned)');
  // a uniquely-resolvable one still resolves
  const unique = buildQuoteSelector('only one X token', 9, 10);
  assert.deepEqual(resolveQuoteSelector('only one X token', unique), { start: 9, end: 10 });
  void sel;
});

// ---- importEnvelope drops invalid records (no store corruption) --------------------

test('importEnvelope filters malformed records and reports dropped', () => {
  const tb = Tackback.mount({ document: { id: 'd1' }, storage: memoryAdapter() });
  const envelope = {
    schemaVersion: 1, document: { id: 'd1' }, comments: [
      { id: 'ok1', anchor: { type: 'block', elementId: 'p1' }, body: 'fine', createdAt: 't' },
      { id: '', anchor: { type: 'block', elementId: 'p2' }, body: 'no id', createdAt: 't' },        // bad id
      { id: 'bad2', anchor: { type: 'region', surfaceId: 'p', rect: { x: 0, y: 0, width: 5, height: 5 } }, body: 'oob', createdAt: 't' }, // bad rect
      { id: 'ok2', anchor: { type: 'range', elementId: 'p3', selector: { exact: 'phrase' } }, body: 'ok', createdAt: 't' },
    ],
  };
  const result = tb.importEnvelope(envelope, { mode: 'merge' });   // merge: filter without the replace-wipe guard
  assert.equal(result.dropped, 2, 'two malformed records dropped');
  assert.equal(tb.listComments().length, 2, 'only valid records ingested');
  assert.deepEqual(tb.listComments().map((c) => c.id).sort(), ['ok1', 'ok2']);
});

// ---- keepBoth never overwrites on -dup collision -----------------------------------

test('keepBoth generates a unique id when -dup already exists', () => {
  const tb = Tackback.mount({ document: { id: 'd2' }, storage: memoryAdapter() });
  const mk = (id) => ({ id, anchor: { type: 'block', elementId: 'p1' }, body: id, createdAt: 't' });
  // seed c1 and c1-dup, then import another c1 with keepBoth → must become c1-dup2, not clobber c1-dup
  tb.importEnvelope({ comments: [mk('c1'), mk('c1-dup')] }, { mode: 'replace' });
  tb.importEnvelope({ comments: [mk('c1')] }, { mode: 'merge', onConflict: 'keepBoth' });
  const ids = tb.listComments().map((c) => c.id).sort();
  assert.deepEqual(ids, ['c1', 'c1-dup', 'c1-dup2'], 'collision avoided — all three kept');
});

// ---- a partially-invalid replace import must not wipe existing comments -------------

test('replace import with an invalid record throws and preserves existing comments', () => {
  const tb = Tackback.mount({ document: { id: 'd3' }, storage: memoryAdapter() });
  tb.addComment({ anchor: { type: 'block', elementId: 'keep' }, body: 'existing' });
  const bad = { comments: [{ id: 'x', anchor: { type: 'block', elementId: '' }, body: 'bad', createdAt: 't' }] };
  assert.throws(() => tb.importEnvelope(bad, { mode: 'replace' }), /IMPORT_INVALID|invalid/);
  assert.equal(tb.listComments().length, 1, 'existing comment NOT cleared by the failed replace');
  // allowPartial opts into the destructive partial replace
  const r = tb.importEnvelope(bad, { mode: 'replace', allowPartial: true });
  assert.equal(r.dropped, 1);
  assert.equal(tb.listComments().length, 0, 'allowPartial replace cleared + dropped the invalid one');
});

// ---- the store owns its data (caller can't mutate state via the input reference) ----

test('mutating the input object after add/import does not change stored state', () => {
  const tb = Tackback.mount({ document: { id: 'd4' }, storage: memoryAdapter() });
  const input = { anchor: { type: 'block', elementId: 'p1' }, body: 'original' };
  const added = tb.addComment(input);
  input.body = 'mutated'; input.anchor.elementId = 'HIJACKED';
  const stored = tb.getComment(added.id);
  assert.equal(stored.body, 'original', 'body not mutated through input ref');
  assert.equal(stored.anchor.elementId, 'p1', 'nested anchor not mutated through input ref');
});

// ---- region surface resolution never builds a selector from an untrusted surfaceId (PR #130 R1 H1) ----

test('resolveAnchorDom matches a region surface by exact attribute value, even with selector-breaking chars', () => {
  // surfaceId/pageIndex can arrive from an imported envelope; isValidAnchor permits any non-empty
  // string. A newline/`]`/quote interpolated into [data-tb-surface="..."] would make querySelector
  // throw SyntaxError and break render. The resolver must match by exact attribute value instead.
  const weirdId = 'surf\n"]weird';
  const surfEl = { getAttribute: (k) => (k === 'data-tb-surface' ? weirdId : null), clientWidth: 100, clientHeight: 100 };
  const doc = {
    getElementById: () => null,
    querySelectorAll: (sel) => (sel === '[data-tb-surface]' ? [surfEl] : []),
  };
  const anchor = { type: 'region', surfaceId: weirdId, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } };
  const res = resolveAnchorDom(anchor, doc, new Map());
  assert.ok(res && res.element === surfEl, 'resolved by exact attribute match despite special chars');

  // a non-matching, selector-breaking id resolves to null without ever throwing
  const miss = { ...anchor, surfaceId: 'no\nsuch"]id' };
  assert.doesNotThrow(() => resolveAnchorDom(miss, doc, new Map()));
  assert.equal(resolveAnchorDom(miss, doc, new Map()), null);
});

// ---- region surfaces re-resolve after reload via the element id (PR #130 R2) ----

test('resolveAnchorDom falls back to getElementById for el-<id> surfaceIds (reload persistence)', () => {
  // After reload the runtime data-tb-surface stamp is gone, but an id'd <figure> still has its id.
  // resolveAnchorDom must recover the surface via getElementById so the region is not orphaned.
  const figure = { id: 'fig7', getAttribute: () => null, clientWidth: 200, clientHeight: 120 };
  const doc = {
    getElementById: (id) => (id === 'fig7' ? figure : null),
    querySelectorAll: () => [],   // no [data-tb-surface] present on reload
  };
  const anchor = { type: 'region', surfaceId: 'el-fig7', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } };
  const res = resolveAnchorDom(anchor, doc, new Map());
  assert.ok(res && res.element === figure, 'recovered the id-d surface via getElementById after reload');

  // an unmarked, id-less surface (tb-surf-N) has nothing to recover → null, no throw
  const orphan = { ...anchor, surfaceId: 'tb-surf-3' };
  assert.equal(resolveAnchorDom(orphan, doc, new Map()), null);
});
