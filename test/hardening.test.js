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

// ---- the import rules the README states, checked through the engine rather than the sanitizer ----
//
// The rules themselves are fixed in sanitize.test.js, against the function that applies them. These
// three are about what a CALLER sees, which is a different question: the same rule reached through
// importEnvelope, in both modes, with the document either changed or not. A rule can be right in the
// sanitizer and still be wrong here — the mode dispatch sits in between.

test('allowPartial does not reach an identity fault: the replace is still refused whole', () => {
  // The declared asymmetry. An anchor this build cannot place is something a caller may knowingly
  // accept the loss of; an identity it cannot accept is not, because taking the good half of a
  // complete-state declaration composes a document neither side asked for. Same flag, different kind,
  // deliberately different answer — and nothing but this says so.
  const tb = Tackback.mount({ document: { id: 'n2' }, storage: memoryAdapter() });
  const errors = [];
  tb.on('error', (e) => errors.push(e));
  const a = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'existing' });

  const clash = { comments: [
    { id: 'dup', anchor: { type: 'block', elementId: 'p2' }, body: 'one', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'dup', anchor: { type: 'block', elementId: 'p3' }, body: 'two', createdAt: '2026-01-01T00:00:00.000Z' },
  ] };
  const r = tb.importEnvelope(clash, { mode: 'replace', allowPartial: true });

  assert.deepEqual(tb.listComments().map((c) => c.id), [a.id], 'the document is exactly as it was');
  assert.equal(r.added, 0, 'and the result says so rather than throwing');
  assert.equal(errors.filter((e) => e.code === 'IMPORT_REPLACE_REJECTED').length, 1,
    'refused as a whole, once, with allowPartial set');
});

test('a tombstone in the envelope is honoured in BOTH modes, not just one', () => {
  // deleted[] is the one rule that refuses an entry the envelope itself asked for. It has to hold on
  // the way in and on the way over, or a replace becomes a way to resurrect what a merge would bury.
  const bury = (id) => ({
    comments: [{ id, anchor: { type: 'block', elementId: 'p9' }, body: 'back from the dead', createdAt: '2026-01-01T00:00:00.000Z' }],
    deleted: [id],
  });
  for (const mode of ['merge', 'replace']) {
    const tb = Tackback.mount({ document: { id: `n3-${mode}` }, storage: memoryAdapter() });
    const r = tb.importEnvelope(bury('ghost'), { mode });
    assert.equal(tb.listComments().length, 0, `${mode}: the buried entry did not come back`);
    assert.equal(r.added, 0, `${mode}: and was not counted as added`);
    assert.ok(r.dropped >= 1, `${mode}: it was refused, not silently skipped`);
  }
});

test('a refused entry does not consume its id — a later one carrying it can still be accepted', () => {
  // Stated in the README as "a refusal does not consume the id". If a refusal DID take the id, an
  // envelope would be silently order-dependent in a second way: a malformed first copy would make
  // every good copy after it unusable, and the count would look identical either way.
  const tb = Tackback.mount({ document: { id: 'n4' }, storage: memoryAdapter() });
  const r = tb.importEnvelope({ comments: [
    { id: 'same', anchor: { type: 'block', elementId: '' }, body: 'refused — no elementId', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'same', anchor: { type: 'block', elementId: 'p1' }, body: 'accepted', createdAt: '2026-01-01T00:00:00.000Z' },
  ] }, { mode: 'merge' });

  assert.equal(r.dropped, 1, 'the first was refused');
  assert.deepEqual(tb.listComments().map((c) => c.body), ['accepted'],
    'and the second was not refused as a duplicate of it');
});
