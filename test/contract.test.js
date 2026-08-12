// node:test — the contracts the README STATES, checked against what the library does.
//
// 0.9.9 wrote two of them down (`## Errors`, `## What an import may not do`) and nine of the
// statements turned out to describe something slightly other than the code. Nothing here is new
// behaviour: these tests are the wire between the sentences and the implementation, so the next
// sentence that drifts is caught by a test rather than by a reader being surprised.
//
// Grouped the way the README is: which code arrives by which route, then what an import may not do.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Tackback } from '../src/index.js';
import { memoryAdapter } from '../src/core/storage.js';
import { TackbackError } from '../src/core/errors.js';

const A = (elementId) => ({ type: 'block', elementId });
const C = (id, elementId = 'p1', extra = {}) =>
  ({ id, anchor: A(elementId), body: id, createdAt: '2026-01-01T00:00:00.000Z', ...extra });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** mount + collect every error it emits */
function watched(options = {}) {
  const errors = [];
  const tb = Tackback.mount({ document: { id: `c-${Math.random().toString(36).slice(2)}` }, storage: memoryAdapter(), ...options });
  tb.on('error', (e) => errors.push(e));
  return { tb, errors, codes: () => errors.map((e) => e.code) };
}

// ================================================================================================
// Errors — "the route is fixed per situation"
// ================================================================================================

test('a display that cannot answer is ADAPTER_FAILED on both routes, never the display\'s own code', async () => {
  // The pull says so by throwing, the scheduled look by emitting, and both name the SITUATION.
  // An unusable anchor in what a display returned is not INVALID_ANCHOR: that code belongs to a
  // caller who supplied a bad anchor, and a reader watching for it would be told a lie about who
  // failed. The display's error survives as `cause`.
  const pull = watched();
  pull.tb.registerThreadVisibility(() => [{ threadKey: 't1', anchor: { type: 'block' }, comments: [] }]);
  assert.throws(() => pull.tb.visibleThreads(), (e) => {
    assert.ok(e instanceof TackbackError);
    assert.equal(e.code, 'ADAPTER_FAILED');
    assert.equal(/** @type any */ (e.cause)?.code, 'INVALID_ANCHOR', 'the display\'s own error is kept as cause');
    return true;
  });
  pull.tb.destroy();

  const scheduled = watched();
  scheduled.tb.registerThreadVisibility(() => [{ threadKey: 't1', anchor: { type: 'block' }, comments: [] }]);
  await settle(60);
  assert.deepEqual(scheduled.codes(), ['ADAPTER_FAILED'], 'the scheduled path reports the situation');
  assert.equal(scheduled.errors[0].cause?.code, 'INVALID_ANCHOR', 'and keeps the display\'s error as cause');
  assert.equal(scheduled.codes().includes('INVALID_ANCHOR'), false, 'INVALID_ANCHOR is never emitted');
  scheduled.tb.destroy();
});

test('ADAPTER_FAILED is emitted for a storage adapter that has half the progress pair', async () => {
  // The fourth emitted situation. The other three (mount, init, a look that gave up) are covered in
  // unread.test.js; this one is here because the README lists the situations and this was missing.
  const half = { ...memoryAdapter() };
  delete half.saveProgress;
  const w = watched({ storage: half });
  await w.tb.ready; await settle();
  assert.deepEqual(w.codes(), ['ADAPTER_FAILED']);
  w.tb.destroy();
});

// ================================================================================================
// What an import may not do
// ================================================================================================

test('a refused root takes its replies with it: dropped counts them, the report does not', () => {
  // Two numbers that are not the same number. `dropped` is how many entries did not make it;
  // one error is emitted per FAULT, and a reply lost because its root was refused is not a second
  // fault — saying it three times would report three things wrong with the envelope.
  const w = watched();
  const r = w.tb.importEnvelope({ comments: [
    { id: '', anchor: A('p1'), body: 'no id', createdAt: 't', replies: [{ id: 'r1', body: 'a' }, { id: 'r2', body: 'b' }] },
  ] }, { mode: 'merge' });
  assert.equal(r.dropped, 3, 'the root and both replies are gone');
  assert.equal(w.codes().filter((c) => c === 'IMPORT_ENTRY_DROPPED').length, 1, 'one fault, said once');
  w.tb.destroy();
});

test('a replace refused whole is reported once, as the refusal of the whole thing', () => {
  // Not one IMPORT_ENTRY_DROPPED per entry: the unit of the refusal is the envelope. `dropped` still
  // carries how many entries were at fault, so the caller can tell one bad row from fifty.
  const w = watched();
  const kept = w.tb.addComment({ anchor: A('keep'), body: 'existing' });
  const r = w.tb.importEnvelope({ comments: [C('dup', 'p2'), C('dup', 'p3')] }, { mode: 'replace', allowPartial: true });
  assert.deepEqual(w.codes(), ['IMPORT_REPLACE_REJECTED'], 'said once, about the replacement');
  assert.equal(w.codes().filter((c) => c === 'IMPORT_ENTRY_DROPPED').length, 0, 'and not once per entry');
  assert.deepEqual({ ...r }, { added: 0, updated: 0, skipped: 0, conflicts: 0, dropped: 1, deleted: 0 },
    'everything zero except dropped — which is information the caller needs');
  assert.deepEqual(w.tb.listComments().map((c) => c.id), [kept.id], 'the document is exactly as it was');
  w.tb.destroy();
});

test('IMPORT_ENTRY_DROPPED happens on a replace too, when the replace still goes through', () => {
  // The README listed merge and restore. A replace that is not refused whole drops its bad rows the
  // same way — the rule about not going quiet does not depend on the mode.
  const w = watched();
  w.tb.addComment({ anchor: A('keep'), body: 'existing' });
  const r = w.tb.importEnvelope({ comments: [C('ghost', 'p9')], deleted: ['ghost'] }, { mode: 'replace' });
  assert.deepEqual(w.codes(), ['IMPORT_ENTRY_DROPPED']);
  assert.equal(r.dropped, 1);
  w.tb.destroy();
});

test('a tombstone is the third kind, and a replace carrying only one still replaces', () => {
  // `anchor` can be waved through with allowPartial and `identity` can never be; a tombstone is
  // neither. It is the envelope being read correctly, so the replacement proceeds — including when
  // that leaves the document empty, because a complete-state declaration whose only row is buried
  // IS a declaration that nothing is left.
  const w = watched();
  w.tb.addComment({ anchor: A('keep'), body: 'existing' });
  const r = w.tb.importEnvelope({ comments: [C('ghost', 'p9')], deleted: ['ghost'] }, { mode: 'replace' });
  assert.deepEqual(w.tb.listComments(), [], 'the replacement happened');
  assert.equal(r.added, 0);
  assert.ok(r.dropped >= 1, 'and the buried row was refused, not silently skipped');
  w.tb.destroy();
});

test('a reply may not take the id of an utterance that is already here', () => {
  // The rule the README states as "under a different utterance" also covers "IS a different
  // utterance" — a reply claiming a resident root's id is refused, or the same id would name two
  // things at once.
  const w = watched();
  w.tb.importEnvelope({ comments: [C('R', 'p1', { replies: [{ id: 'y', body: 'reply', createdAt: 't' }] })] }, { mode: 'merge' });
  const r = w.tb.importEnvelope({ comments: [C('S', 'p1', { replies: [{ id: 'R', body: 'claims a root id', createdAt: 't' }] })] }, { mode: 'merge' });
  assert.equal(r.dropped, 1);
  assert.equal(w.codes().filter((c) => c === 'IMPORT_ENTRY_DROPPED').length, 1);
  assert.equal(w.tb.getComment('S')?.replies.length, 0, 'the reply did not enter');
  w.tb.destroy();
});

// ================================================================================================
// A stored document that cannot be read (D-086): reported, set aside, started over
// ================================================================================================

/** run `fn` with a localStorage that also answers `length` / `key(i)` */
async function withLocalStorage(fn) {
  const items = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => { items.set(k, v); },
    removeItem: (k) => { items.delete(k); },
    // Needed to trim the set-aside records: the FIFO is read off the keys themselves rather than an
    // index kept beside them, because an index can disagree with what is actually there.
    get length() { return items.size; },
    key: (i) => [...items.keys()][i] ?? null,
  };
  try { await fn(items); } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
}
const asideKeys = (items) => [...items.keys()].filter((k) => k.startsWith('tackback:broken:')).sort();

test('D-086: an unreadable document is reported, and mount() does not throw', async () => {
  await withLocalStorage(async (items) => {
    items.set('tackback::broken-doc', '{not json');
    const errors = [];
    let tb;
    assert.doesNotThrow(() => { tb = Tackback.mount({ document: { id: 'broken-doc' } }); }, 'mount survives it');
    tb.on('error', (e) => errors.push(e));
    await tb.ready; await settle();
    assert.deepEqual(errors.map((e) => e.code), ['STORAGE_LOAD_FAILED'], 'and says so on the error event');
    assert.deepEqual(tb.listComments(), [], 'starting with nothing rather than with half of something');
    tb.destroy();
  });
});

test('D-086: the bytes are moved to a set-aside key, not left where they were', async () => {
  await withLocalStorage(async (items) => {
    items.set('tackback::doc-a', '{not json');
    const tb = Tackback.mount({ document: { id: 'doc-a' } });
    await tb.ready; await settle();
    const aside = asideKeys(items);
    assert.equal(aside.length, 1, 'one record set aside');
    assert.match(aside[0], /^tackback:broken:doc-a:\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'named for the document and the moment');
    assert.equal(items.get(aside[0]), '{not json', 'kept exactly as it was found');
    assert.equal(items.has('tackback::doc-a'), false, 'and moved — nothing left at the live key');
    tb.destroy();

    // The move is what stops it happening again: a second mount finds an empty key, not a broken one.
    const again = Tackback.mount({ document: { id: 'doc-a' } });
    await again.ready; await settle();
    assert.equal(asideKeys(items).length, 1, 'no second copy of the same trouble');
    again.destroy();
  });
});

test('D-086: three are kept per document, and the fourth removes the oldest', async () => {
  await withLocalStorage(async (items) => {
    const stamps = [];
    for (let i = 1; i <= 4; i++) {
      items.set('tackback::doc-f', `{broken ${i}`);
      const tb = Tackback.mount({ document: { id: 'doc-f' } });
      await tb.ready; await settle(4);
      tb.destroy();
      stamps.push(asideKeys(items).length);
    }
    assert.deepEqual(stamps, [1, 2, 3, 3], 'it grows to three and then stays at three');
    const kept = asideKeys(items).map((k) => items.get(k));
    assert.deepEqual(kept.sort(), ['{broken 2', '{broken 3', '{broken 4'],
      'the oldest went, and the newest three are what is left');
  });
});

test('D-086: one document\'s trouble does not evict another\'s', async () => {
  await withLocalStorage(async (items) => {
    for (let i = 1; i <= 3; i++) {
      items.set('tackback::doc-keep', `{keep ${i}`);
      const tb = Tackback.mount({ document: { id: 'doc-keep' } });
      await tb.ready; await settle(4); tb.destroy();
    }
    assert.equal(asideKeys(items).filter((k) => k.includes(':doc-keep:')).length, 3);

    // A fourth for a DIFFERENT document. With one shared set of three slots this is where the first
    // document's evidence would quietly go.
    for (let i = 1; i <= 4; i++) {
      items.set('tackback::doc-other', `{other ${i}`);
      const tb = Tackback.mount({ document: { id: 'doc-other' } });
      await tb.ready; await settle(4); tb.destroy();
    }
    assert.equal(asideKeys(items).filter((k) => k.includes(':doc-keep:')).length, 3, 'still three, untouched');
    assert.equal(asideKeys(items).filter((k) => k.includes(':doc-other:')).length, 3, 'and three for the other');
  });
});

test('D-086: an id containing a colon keeps its own group', async () => {
  // `storageKey` is the caller's string and may contain anything. Splitting a set-aside key on ':'
  // would put `a:b`'s records into `a`'s group and trim the wrong ones; the stamp comes off the end
  // instead, which cannot be confused.
  await withLocalStorage(async (items) => {
    for (const key of ['a', 'a:b']) {
      for (let i = 1; i <= 3; i++) {
        items.set(key, `{${key} ${i}`);
        const tb = Tackback.mount({ document: { id: `doc-${key}` }, storageKey: key });
        await tb.ready; await settle(4); tb.destroy();
      }
    }
    const forA = asideKeys(items).filter((k) => k.replace(/:\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '') === 'tackback:broken:a');
    const forAB = asideKeys(items).filter((k) => k.replace(/:\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '') === 'tackback:broken:a:b');
    assert.equal(forA.length, 3, 'three for "a"');
    assert.equal(forAB.length, 3, 'three for "a:b" — its own group');
  });
});

test('D-086: a document that reads fine is never set aside', async () => {
  // The other direction. A fix that set every load aside would pass every test above.
  await withLocalStorage(async (items) => {
    items.set('tackback::fine', JSON.stringify({ schemaVersion: 1, documentId: 'fine', comments: [C('c1')] }));
    const errors = [];
    const tb = Tackback.mount({ document: { id: 'fine' } });
    tb.on('error', (e) => errors.push(e));
    await tb.ready; await settle();
    assert.equal(tb.listComments().length, 1, 'restored');
    assert.deepEqual(asideKeys(items), [], 'nothing set aside');
    assert.deepEqual(errors, [], 'and nothing reported');
    tb.destroy();
  });
});
