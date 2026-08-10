// node:test — what a reader has not got to yet.
//
// BLACKBOX. Everything here goes in through the published surface: mount, the comment API, an import
// envelope, a storage adapter the test supplies, `registerThreadVisibility` standing in for a display,
// and the events. Nothing reaches for an internal name. The shape of the mechanism is fixed elsewhere;
// what is fixed HERE is the promise — that something new is visibly new, and that reading it clears it.
//
// The one case that decides whether any of it works: an utterance written a year ago, arriving now,
// is new to this reader. An implementation that compares timestamps passes almost everything else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Tackback } from '../src/index.js';

// ---- the synchronous contract -------------------------------------------------------------------
//
// Observation happens at a microtask boundary, so a claim about what IS takes one settle. A claim
// about what is NOT has to outlast the core's own retries, which is what the fourfold wait is for.
const settle = () => new Promise((r) => setTimeout(r, 0));
const quiet = async () => { for (let i = 0; i < 4; i += 1) await settle(); };

/** A storage adapter the test can look inside. The stored shape is part of the adapter contract. */
const makeStore = (seed = null) => {
  let saved = seed;
  return { adapter: { load: () => saved, save: (doc) => { saved = doc; } }, peek: () => saved };
};

/** One that refuses to write until told otherwise. */
const makeFlaky = () => {
  const a = { fail: true, saves: [] };
  a.adapter = { load: () => null, save: (doc) => { if (a.fail) throw new Error('quota'); a.saves.push(doc); } };
  return a;
};

/** One whose writes finish only when the test says so, so ordering can be looked at directly. */
const makeGated = () => {
  const g = { calls: [], gates: [] };
  g.adapter = {
    load: () => null,
    save: (doc) => { g.calls.push(doc); return new Promise((res) => g.gates.push(res)); },
  };
  g.release = () => { const r = g.gates.shift(); if (r) r(); return settle(); };
  return g;
};

// The thread naming rules, written out here from the published table rather than imported — a test
// that borrowed the library's own answer could not notice the library changing it.
const keyOf = (c) => {
  const a = c && c.anchor;
  if (!a) return null;
  if (a.type === 'document') return 'document';
  if (a.type === 'region') return `region:${c.threadId || c.id}`;
  if (a.type === 'range') return `range:${a.elementId}\u0000${a.selector?.exact ?? ''}\u0000${a.selector?.start ?? ''}`;
  if (a.type === 'block') return `block:${a.elementId}`;
  return null;
};
const idsOf = (core, key) => {
  const ids = [];
  for (const c of core.listComments()) {
    if (keyOf(c) !== key) continue;
    ids.push(c.id);
    for (const r of c.replies || []) ids.push(r.id);
  }
  return ids;
};

/**
 * A display the test drives. Built from the store on every look, because a thread that grows while it
 * is open is one of the cases being measured — a snapshot taken once would freeze the very thing.
 */
const display = (core) => {
  const state = { open: [] };
  state.stop = core.registerThreadVisibility(() =>
    state.open.map(({ key, anchor }) => ({ threadKey: key, anchor, comments: idsOf(core, key) })));
  state.show = async (...threads) => {
    state.open = threads.map((t) => (typeof t === 'string' ? { key: t, anchor: anchorFor(t) } : t));
    core.reportThreadVisibility();
    await settle();
  };
  return state;
};
const anchorFor = (key) => (key === 'document'
  ? { type: 'document' }
  : { type: 'block', elementId: key.replace(/^block:/, '') });

// ---- fixtures ------------------------------------------------------------------------------------

const A_YEAR_AGO = '2025-08-10T00:00:00.000Z';
const AN_HOUR_HENCE = '2026-08-10T01:00:00.000Z';
const NOW_ISH = '2026-08-10T00:00:00.000Z';

const entry = (id, elementId = 'p1', over = {}) => ({
  id, anchor: { type: 'block', elementId }, body: id, createdAt: NOW_ISH, ...over,
});
const reply = (id, over = {}) => ({ id, body: id, createdAt: NOW_ISH, ...over });
const envelope = (comments, over = {}) => ({
  schemaVersion: 1, generator: { name: 'tackback', version: 'x' },
  document: { id: 'd' }, exportedAt: NOW_ISH, comments, ...over,
});

const mount = (over = {}) => Tackback.mount({ document: { id: 'unread-fixture' }, ...over });

// ---- invariants, before any example --------------------------------------------------------------
//
// These hold after EVERY operation in this file. Written first because an example test can only
// encode a path somebody thought of, and the failures this feature has are the ones nobody did.

const utterancesIn = (core, key) => idsOf(core, key).length;

/** @param {any} core @param {string} where */
function invariants(core, where) {
  const threads = core.unreadThreads();
  // I2 — the list and the count are the same rule, or one of them is lying.
  for (const { threadKey, count } of threads) {
    assert.equal(core.unreadCount(threadKey), count, `${where}: I2 ${threadKey}`);
    assert.ok(count > 0, `${where}: I2 a thread with nothing unread is absent, not listed at zero`);
  }
  const listed = new Set(threads.map((t) => t.threadKey));
  const seen = new Set();
  const ids = [];
  for (const c of core.listComments()) {
    const key = keyOf(c);
    ids.push(c.id);
    for (const r of c.replies || []) ids.push(r.id);
    if (key && !seen.has(key)) {
      seen.add(key);
      const n = core.unreadCount(key);
      // I1 — a count is never negative and never exceeds what is there to be read.
      assert.ok(n >= 0 && n <= utterancesIn(core, key), `${where}: I1 ${key} (${n})`);
      if (n === 0) assert.ok(!listed.has(key), `${where}: I2 ${key} at zero must not be listed`);
    }
  }
  // I8 — every utterance that can be displayed has an id, and no id names two of them. Everything
  // above is meaningless without it: unread is counted BY id.
  assert.deepEqual(ids.filter((id) => typeof id !== 'string' || !id), [], `${where}: I8 every utterance has an id`);
  assert.equal(new Set(ids).size, ids.length, `${where}: I8 no id names two utterances`);
  // I4 — environment-local records never reach the shared file.
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v)) {
      for (const k of Object.keys(v)) {
        assert.ok(!['arrival', 'observed', 'arrivalNext'].includes(k), `${where}: I4 envelope carries ${k}`);
        walk(v[k]);
      }
      return;
    }
    for (const x of v) walk(x);
  };
  walk(core.exportEnvelope());
}

// ---- §3 arrival decides ---------------------------------------------------------------------------

test('T1: an utterance written a year ago is new when it gets here', async () => {
  // The case the whole version turns on. An implementation that compares `createdAt` passes nearly
  // everything else in this file and fails only here — and in the product, that failure is a reader
  // who is never told about anything that was not composed a moment ago.
  const core = mount({ storage: makeStore().adapter });
  core.importEnvelope(envelope([entry('old-1', 'p1', { createdAt: A_YEAR_AGO })]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1);
  assert.deepEqual(core.unreadThreads(), [{ threadKey: 'block:p1', count: 1 }]);
  invariants(core, 'T1');
  core.destroy();
});

test('T2: one dated in the future is no different — it arrives, then it is read', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  core.importEnvelope(envelope([entry('future-1', 'p1', { createdAt: AN_HOUR_HENCE })]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1);
  await d.show('block:p1');
  assert.equal(core.unreadCount('block:p1'), 0);
  invariants(core, 'T2');
  core.destroy();
});

test('I5: the same script with three different dates gives the same answers throughout', async () => {
  // The direct check. If any observation point differs between the runs, the implementation is
  // deciding with somebody else's clock.
  const observations = [];
  for (const createdAt of [A_YEAR_AGO, NOW_ISH, AN_HOUR_HENCE]) {
    const core = mount({ storage: makeStore().adapter });
    const d = display(core);
    const seen = [];
    core.importEnvelope(envelope([entry('u1', 'p1', { createdAt })]), { mode: 'merge' });
    await settle();
    seen.push(core.unreadCount('block:p1'), JSON.stringify(core.unreadThreads()));
    await d.show('block:p1');
    seen.push(core.unreadCount('block:p1'), JSON.stringify(core.unreadThreads()));
    core.importEnvelope(envelope([entry('u2', 'p1', { createdAt })]), { mode: 'merge' });
    await settle();
    seen.push(core.unreadCount('block:p1'), JSON.stringify(core.unreadThreads()));
    invariants(core, `I5 ${createdAt}`);
    core.destroy();
    observations.push(seen);
  }
  assert.deepEqual(observations[1], observations[0], 'now vs a year ago');
  assert.deepEqual(observations[2], observations[0], 'an hour hence vs a year ago');
});

test('T3: the same utterance arriving again does not become new again', async () => {
  // Polling carries the same envelope over and over. An implementation that re-numbers on every
  // import puts everything back to unread every few seconds.
  for (const onConflict of ['skip', 'replace']) {
    const core = mount({ storage: makeStore().adapter });
    const d = display(core);
    core.importEnvelope(envelope([entry('u1')]), { mode: 'merge' });
    await d.show('block:p1');
    assert.equal(core.unreadCount('block:p1'), 0, `${onConflict}: read`);
    await d.show();
    await quiet();
    const changes = [];
    core.on('unread:change', (e) => changes.push(e));

    core.importEnvelope(envelope([entry('u1', 'p1', { body: 'edited upstream' })]), { mode: 'merge', onConflict });
    await quiet();
    assert.equal(core.unreadCount('block:p1'), 0, `${onConflict}: still read`);
    assert.deepEqual(changes, [], `${onConflict}: and nothing was announced`);
    invariants(core, `T3 ${onConflict}`);
    core.destroy();
  }
});

test('T4: a reply is an utterance, and counts like one', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  const c = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'root' });
  await d.show('block:p1');
  await d.show();
  assert.equal(core.unreadCount('block:p1'), 0);

  core.addReply(c.id, { body: 'from somebody else' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'the reply is what is new');
  await d.show('block:p1');
  assert.equal(core.unreadCount('block:p1'), 0);
  invariants(core, 'T4');
  core.destroy();
});

test('T5: something landing in a thread already open is read, and never flickers', async () => {
  // The count is checked, but the number of announcements is the real oracle: evaluating unread at
  // the moment of the change rather than at the boundary makes it briefly 1, and a subscriber that
  // paints on every announcement shows a mark appearing and vanishing in front of the reader.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await d.show('block:p1');
  await quiet();
  const changes = [];
  core.on('unread:change', (e) => changes.push(e));

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'while they watch' });
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0);
  assert.deepEqual(changes, [], 'nothing was ever unread, so nothing was announced');
  invariants(core, 'T5');
  core.destroy();
});

// ---- §4 observation is the only thing that clears -------------------------------------------------

test('T13a: a display that cannot be read clears nothing', async () => {
  // The thread is opened and read FIRST, so the core has a real answer on file about it. That is the
  // shape of the mistake worth guarding: not "invent something out of nothing", but "assume the last
  // thing seen is still on screen". Something arrives afterwards, the display breaks, and the
  // question is whether the stale answer gets used as though it were a look.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'read before the trouble' });
  await d.show('block:p1');
  assert.equal(core.unreadCount('block:p1'), 0);
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'unread' });
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'still open, so still read');
  await d.show();
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'and one more, unseen' });
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1);
  const changes = [], errors = [];
  core.on('unread:change', (e) => changes.push(e));
  core.on('error', (e) => errors.push(e));

  d.stop();
  core.registerThreadVisibility(() => { throw new Error('cannot look'); });
  core.reportThreadVisibility();
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1, 'not being able to look is not having looked');

  // …and the same again with the thread still nominally OPEN when the display goes. This is the case
  // where the stale answer is most tempting — the core knows which threads were showing a moment ago
  // and could recompute what is in them — and it is exactly where using it would mark something read
  // that no display ever put in front of anybody.
  const still = mount({ storage: makeStore().adapter });
  const d2 = display(still);
  still.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'seen' });
  await d2.show('block:p1');
  assert.equal(still.unreadCount('block:p1'), 0);
  d2.stop();
  still.registerThreadVisibility(() => { throw new Error('the screen went out'); });
  still.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'arrived in the dark' });
  await quiet();
  assert.equal(still.unreadCount('block:p1'), 1, 'the thread was open a moment ago, which is not now');
  invariants(still, 'T13a still-open');
  still.destroy();
  assert.deepEqual(changes, [], 'and the picture did not change, so nothing was announced');
  assert.equal(errors.length, 1, 'the failure itself is reported');
  invariants(core, 'T13a');
  core.destroy();
});

test('T13b: what arrives while the display is broken is still announced', async () => {
  // The half that must not be held hostage by the other. What has arrived and how far each thread was
  // seen are both already known; a display that cannot be read changes neither. An implementation
  // that stops evaluating on a failed look leaves the reader with no notice of anything new for as
  // long as the display stays broken.
  const core = mount({ storage: makeStore().adapter });
  const changes = [], errors = [];
  core.on('unread:change', (e) => changes.push(e));
  core.on('error', (e) => errors.push(e));
  const broken = core.registerThreadVisibility(() => { throw new Error('cannot look'); });
  await quiet();
  assert.equal(errors.length, 1, 'the display is reported broken once, before anything else happens');
  changes.length = 0;

  core.importEnvelope(envelope([entry('arrived-blind')]), { mode: 'merge' });
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1);
  assert.equal(changes.length, 1, 'the arrival is announced even though nothing could be looked at');
  assert.deepEqual(changes[0].threads, [{ threadKey: 'block:p1', count: 1 }]);
  assert.equal(errors.length, 1, 'and the same broken display is not complained about all over again');

  // Withdrawing the broken one FIRST: a registration replaces rather than joins, but the test says so
  // out loud, because leaving it in place is how this case silently stops testing anything.
  broken();
  const d = display(core);
  await d.show('block:p1');
  assert.equal(core.unreadCount('block:p1'), 0, 'and a display that works clears it');
  invariants(core, 'T13b');
  core.destroy();
});

test('T34: closing before the boundary means it was never open', async () => {
  // The rule decides this on its own: reading happens at a successful look, and by the time the look
  // happens the thread is shut. The utterance was never in front of anybody.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await d.show('block:p1');
  await quiet();
  const changes = [];
  core.on('unread:change', (e) => changes.push(e));
  const closeFirst = core.on('change', () => { d.open = []; core.reportThreadVisibility(); });

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'they shut it first' });
  await quiet();
  closeFirst();
  assert.equal(core.unreadCount('block:p1'), 1);
  assert.deepEqual(changes.at(-1).threads, [{ threadKey: 'block:p1', count: 1 }]);
  invariants(core, 'T34');
  core.destroy();
});

// ---- §5 across a reload ---------------------------------------------------------------------------

test('T14: a reload keeps both what was read and what was not', async () => {
  // The second thread is the point. Restoring "what was read" is easy to get right by accident;
  // restoring "what was NOT" is what breaks when a default meant for old data is applied to new.
  const store = makeStore();
  const a = mount({ storage: store.adapter });
  const da = display(a);
  a.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  a.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  await da.show('block:p1');
  a.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'never opened' });
  await settle();
  assert.equal(a.unreadCount('block:p1'), 0);
  assert.equal(a.unreadCount('block:p2'), 1);
  a.destroy();

  const b = mount({ storage: store.adapter });
  await b.ready;
  await settle();
  assert.equal(b.unreadCount('block:p1'), 0, 'read stays read');
  assert.equal(b.unreadCount('block:p2'), 1, 'and unread stays unread');
  invariants(b, 'T14');
  b.destroy();
});

test('T15: after a reload, an old utterance arriving is still new', async () => {
  // T1 and T14 at once, which is where an implementation that treats a reload as everything arriving
  // at once finally shows: the numbers all move together and the distinction is gone.
  const store = makeStore();
  const a = mount({ storage: store.adapter });
  const da = display(a);
  a.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await da.show('block:p1');
  a.destroy();

  const b = mount({ storage: store.adapter });
  await b.ready;
  await settle();
  assert.equal(b.unreadCount('block:p1'), 0);
  b.importEnvelope(envelope([entry('late', 'p1', { createdAt: A_YEAR_AGO })]), { mode: 'merge' });
  await settle();
  assert.equal(b.unreadCount('block:p1'), 1);
  invariants(b, 'T15');
  b.destroy();
});

test('T16: data from before any of this existed does not turn everything unread', async () => {
  // The first thing a reader would see on upgrading, if this were wrong: every mark in the document
  // lit at once, which says only "everything", which is the state this version exists to end.
  const store = makeStore({
    schemaVersion: 1, documentId: 'd',
    comments: [entry('c1', 'p1'), entry('c2', 'p2'), entry('c3', 'p2')],
  });
  const core = mount({ storage: store.adapter });
  const changes = [];
  core.on('unread:change', (e) => changes.push(e));
  await core.ready;
  await quiet();
  assert.deepEqual(core.unreadThreads(), [], 'what was there before counts as already seen');
  assert.deepEqual(changes, [], 'and nothing is announced about it');

  core.importEnvelope(envelope([entry('c4', 'p2')]), { mode: 'merge' });
  await settle();
  assert.deepEqual(core.unreadThreads(), [{ threadKey: 'block:p2', count: 1 }], 'the next arrival is new, though');
  invariants(core, 'T16');
  core.destroy();
});

test('T17: what one environment has read is not carried in the shared file', async () => {
  const store = makeStore();
  const a = mount({ storage: store.adapter });
  const da = display(a);
  a.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'read here' });
  await da.show('block:p1');
  const shared = a.exportEnvelope();
  invariants(a, 'T17 source');

  const b = mount({ document: { id: 'other' }, storage: makeStore().adapter });
  const db = display(b);
  b.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'read over here' });
  await db.show('block:p2');
  assert.equal(b.unreadCount('block:p2'), 0);

  b.importEnvelope(shared, { mode: 'merge' });
  await settle();
  assert.equal(b.unreadCount('block:p2'), 0, 'the import did not reach into what was already read');
  assert.equal(b.unreadCount('block:p1'), 1, 'and what came in is new here, whatever it was there');
  invariants(b, 'T17 target');
  a.destroy(); b.destroy();
});

test('T18: a reader who cannot write comments still records what they have read', async () => {
  // The reader who only reads is who this is FOR. If their progress cannot be kept, the feature does
  // nothing for the person it was built for.
  const store = makeStore({
    schemaVersion: 1, documentId: 'd',
    comments: [entry('c1', 'p1'), entry('c2', 'p1')],
    arrival: { c1: 1, c2: 2 }, observed: { 'block:p1': 1 }, arrivalNext: 3,
  });
  const a = mount({ storage: store.adapter, readOnly: true });
  await a.ready;
  await settle();
  assert.equal(a.unreadCount('block:p1'), 1, 'one of the two is new to them');
  const d = display(a);
  await d.show('block:p1');
  assert.equal(a.unreadCount('block:p1'), 0);
  await quiet();
  assert.equal(store.peek().observed['block:p1'], 2, 'and it was written down');
  a.destroy();

  const b = mount({ storage: store.adapter, readOnly: true });
  await b.ready;
  await settle();
  assert.equal(b.unreadCount('block:p1'), 0, 'so it survives coming back');
  invariants(b, 'T18');
  b.destroy();
});

test('T19: a failed save does not undo what the reader did, and the next one catches up', async () => {
  const flaky = makeFlaky();
  const core = mount({ storage: flaky.adapter });
  const errors = [];
  core.on('error', (e) => errors.push(e));
  const d = display(core);

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await quiet();
  await d.show('block:p1');
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'memory keeps what actually happened');
  assert.ok(errors.length >= 1, 'and the durability failure is reported');
  assert.ok(errors.every((e) => e.code === 'STORAGE_SAVE_FAILED'));

  flaky.fail = false;
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  await quiet();
  const last = flaky.saves.at(-1);
  assert.ok(last, 'a save finally landed');
  assert.equal(last.comments.length, 2, 'carrying everything, not just what came after the failure');
  assert.ok(last.observed['block:p1'] >= 1, 'including what had been read while saving was broken');
  invariants(core, 'T19');
  core.destroy();
});

// ---- §6 deletion, import, forgetting ---------------------------------------------------------------

test('T20/T21: deleting what was unread takes it out of the count', async () => {
  const core = mount({ storage: makeStore().adapter });
  const a = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  const b = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 2);

  core.deleteComment(a.id);
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1);
  core.deleteComment(b.id);
  await settle();
  assert.equal(core.unreadCount('block:p1'), 0);
  assert.deepEqual(core.unreadThreads(), [], 'and the thread stops being somewhere with something new');
  invariants(core, 'T21');
  core.destroy();
});

test('T22: a thread emptied and written in again is new, not haunted by the old cursor', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  const a = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await d.show('block:p1');
  await d.show();
  core.deleteComment(a.id);
  await settle();

  core.importEnvelope(envelope([entry('fresh', 'p1')]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1);
  invariants(core, 'T22');
  core.destroy();
});

test('T23/T24: an import brings only what is actually new', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  core.importEnvelope(envelope([entry('c1')]), { mode: 'merge' });
  await d.show('block:p1');
  await d.show();
  assert.equal(core.unreadCount('block:p1'), 0);

  core.importEnvelope(envelope([entry('c1'), entry('c3')]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'merge: only c3');

  await d.show('block:p1');
  await d.show();
  core.importEnvelope(envelope([entry('c1'), entry('c4')]), { mode: 'replace' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'replace: c1 is the same utterance, c4 is not');
  invariants(core, 'T24');
  core.destroy();
});

test('T25: an utterance the envelope buries stops being counted', async () => {
  const core = mount({ storage: makeStore().adapter });
  core.importEnvelope(envelope([entry('c1'), entry('c2')]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 2);

  core.importEnvelope(envelope([], { deleted: ['c1'] }), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1);
  invariants(core, 'T25');
  core.destroy();
});

test('T39: an id this environment forgot is new when it comes back', async () => {
  // The counterpart to T3. A live id arriving again is the same utterance; a deleted one arriving
  // again is not, because deletion is this environment forgetting it.
  //
  // The SIBLING is what makes this bite. Delete the only utterance in a thread and the thread's whole
  // record goes with it, so the id coming back looks new for a second reason and the forgetting of the
  // NUMBER is never tested. Leaving one behind keeps the thread — and its cursor — alive, so an
  // implementation that keeps the old number reads the returning utterance as already seen.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  core.importEnvelope(envelope([entry('u1'), entry('u2')]), { mode: 'merge' });
  await d.show('block:p1');
  await d.show();
  assert.equal(core.unreadCount('block:p1'), 0);

  core.deleteComment('u1');
  await settle();
  assert.equal(core.unreadCount('block:p1'), 0, 'the survivor is still read');
  core.importEnvelope(envelope([entry('u1')]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'and what came back is new');
  invariants(core, 'T39');
  core.destroy();
});

// ---- §8 what gets announced -------------------------------------------------------------------------

test('T28: the announcement carries the whole picture, not a difference', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await quiet();
  const changes = [];
  core.on('unread:change', (e) => changes.push(e));

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'new' });
  await settle();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].threads, [{ threadKey: 'block:p1', count: 1 }]);

  await d.show('block:p1');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].threads, [], 'and an empty picture is a picture');
  invariants(core, 'T28');
  core.destroy();
});

test('T29/I6: nothing is announced when nothing about it changed', async () => {
  const core = mount({ storage: makeStore().adapter });
  const c = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await quiet();
  const changes = [];
  core.on('unread:change', (e) => changes.push(e));

  core.updateComment(c.id, { body: 'edited' });
  core.setAnchorAttention(c.id, true);
  core.setAnchorAttention(c.id, false);
  core.reportThreadVisibility();
  core.reportThreadVisibility();
  await quiet();
  assert.deepEqual(changes, [], 'an edit is not an arrival, and attention is not reading');
  invariants(core, 'T29');
  core.destroy();
});

test('T27: attention does not move the count', async () => {
  const core = mount({ storage: makeStore().adapter });
  const c = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await quiet();
  const before = core.unreadCount('block:p1');
  core.setAnchorAttention(c.id, true);
  await quiet();
  assert.equal(core.unreadCount('block:p1'), before);
  core.setAnchorAttention(c.id, false);
  await quiet();
  assert.equal(core.unreadCount('block:p1'), before);
  core.destroy();
});

test('T30: what a subscriber is handed is theirs to keep or wreck', async () => {
  const core = mount({ storage: makeStore().adapter });
  const got = [];
  core.on('unread:change', (e) => got.push(e));
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await settle();
  assert.equal(got.length, 1);

  got[0].threads.length = 0;
  const pulled = core.unreadThreads();
  pulled[0].count = 999;
  pulled.length = 0;
  assert.equal(core.unreadCount('block:p1'), 1, 'the core does not read back what it handed out');
  assert.deepEqual(core.unreadThreads(), [{ threadKey: 'block:p1', count: 1 }]);
  core.destroy();
});

// ---- §9 re-entrancy ----------------------------------------------------------------------------------

test('T31: opening a thread from inside the announcement settles, and settles right', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await quiet();
  const changes = [];
  let opened = false;
  core.on('unread:change', (e) => {
    changes.push(e);
    if (opened) return;
    opened = true;
    d.open = [{ key: 'block:p1', anchor: anchorFor('block:p1') }];
    core.reportThreadVisibility();
  });

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await quiet();
  assert.equal(changes.length, 2, 'the arrival, then the reading of it');
  assert.deepEqual(changes[0].threads, [{ threadKey: 'block:p1', count: 1 }]);
  assert.deepEqual(changes[1].threads, []);
  assert.equal(core.unreadCount('block:p1'), 0);
  invariants(core, 'T31');
  core.destroy();
});

test('T32: deleting from inside the announcement settles too', async () => {
  const core = mount({ storage: makeStore().adapter });
  await quiet();
  const changes = [];
  let done = false;
  core.on('unread:change', (e) => {
    changes.push(e);
    if (done || !e.threads.length) return;
    done = true;
    core.deleteComment(e.threads[0].threadKey === 'block:p1' ? core.listComments()[0].id : '');
  });

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await quiet();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].threads, []);
  assert.equal(core.unreadCount('block:p1'), 0);
  invariants(core, 'T32');
  core.destroy();
});

// ---- §9.7 boundaries, order, storage ------------------------------------------------------------------

test('T35: asking about something that is not a thread is a question, not an error', () => {
  const core = mount({ storage: makeStore().adapter });
  for (const bad of ['nope', '', 42, null, undefined, {}, []]) {
    assert.equal(core.unreadCount(/** @type any */(bad)), 0, `${String(bad)}`);
  }
  assert.deepEqual(core.unreadThreads(), []);
  core.destroy();
});

test('T36: before anything is loaded, and after everything is over', async () => {
  let release;
  const seed = {
    schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')],
    arrival: { c1: 1 }, observed: {}, arrivalNext: 2,
  };
  const core = mount({ storage: { load: () => new Promise((r) => { release = () => r(seed); }), save: () => {} } });
  assert.equal(core.unreadCount('block:p1'), 0, 'nothing has been read in yet, so nothing is known');
  assert.deepEqual(core.unreadThreads(), []);

  release();
  await core.ready;
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'and once it has, the restored picture is there');

  const changes = [];
  core.on('unread:change', (e) => changes.push(e));
  core.destroy();
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1, 'a destroyed instance still answers with its last state');
  assert.deepEqual(changes, [], 'but it never says anything again');
});

test('T37: stored records are believed only as far as they can be', async () => {
  const cases = [
    ['no metadata at all — the old shape', { comments: [entry('c1')] }, 0],
    ['numbers but no cursor', { comments: [entry('c1')], arrival: { c1: 1 }, arrivalNext: 2 }, 1],
    ['a cursor for another thread only',
      { comments: [entry('c1'), entry('c2', 'p2')], arrival: { c1: 1, c2: 2 }, observed: { 'block:p2': 2 }, arrivalNext: 3 }, 1],
    ['a number that is not one', { comments: [entry('c1')], arrival: { c1: 'x' }, observed: { 'block:p1': 1 }, arrivalNext: 2 }, 1],
    ['a negative number', { comments: [entry('c1')], arrival: { c1: -3 }, observed: { 'block:p1': 1 }, arrivalNext: 2 }, 1],
    ['a fractional number', { comments: [entry('c1')], arrival: { c1: 1.5 }, observed: { 'block:p1': 2 }, arrivalNext: 3 }, 1],
    ['two utterances claiming one number',
      { comments: [entry('c1'), entry('c2')], arrival: { c1: 1, c2: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 2 }, 2],
    ['a cursor that is not a number', { comments: [entry('c1')], arrival: { c1: 1 }, observed: { 'block:p1': 'x' }, arrivalNext: 2 }, 1],
    ['a cursor above everything still here — deletion leaves that behind',
      { comments: [entry('c1')], arrival: { c1: 1 }, observed: { 'block:p1': 7 }, arrivalNext: 10 }, 0],
  ];
  for (const [what, over, expected] of cases) {
    const store = makeStore({ schemaVersion: 1, documentId: 'd', ...over });
    const core = mount({ storage: store.adapter });
    await core.ready;
    await settle();
    assert.equal(core.unreadCount('block:p1'), expected, what);
    invariants(core, `T37 ${what}`);
    core.destroy();
  }
});

test('T37: a cursor past everything ever handed out cannot swallow what comes next', async () => {
  const store = makeStore({
    schemaVersion: 1, documentId: 'd', comments: [entry('c1')],
    arrival: { c1: 1 }, observed: { 'block:p1': 999 }, arrivalNext: 2,
  });
  const core = mount({ storage: store.adapter });
  await core.ready;
  await settle();
  assert.equal(core.unreadCount('block:p1'), 0, 'what is here reads as seen');
  core.importEnvelope(envelope([entry('later')]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'and the next arrival is still new');
  invariants(core, 'T37 clamp');
  core.destroy();
});

test('T37: a counter that would hand out a number twice is corrected', async () => {
  // Reuse shows up as an arrival landing UNDER a cursor and disappearing, so the cursor is what
  // detects it.
  const store = makeStore({
    schemaVersion: 1, documentId: 'd', comments: [entry('c1')],
    arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 0,
  });
  const core = mount({ storage: store.adapter });
  await core.ready;
  await settle();
  assert.equal(core.unreadCount('block:p1'), 0);
  core.importEnvelope(envelope([entry('next')]), { mode: 'merge' });
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'the new one did not get number 1 again');
  invariants(core, 'T37 counter');
  core.destroy();
});

test('T38: an envelope may not break which utterance is which', async () => {
  const drops = (core) => { const e = []; core.on('error', (x) => e.push(x)); return e; };

  // 1 — a reply with no id
  {
    const core = mount({ storage: makeStore().adapter });
    const errors = drops(core);
    const r = core.importEnvelope(envelope([entry('c1', 'p1', { replies: [{ body: 'nameless', createdAt: NOW_ISH }] })]), { mode: 'merge' });
    await settle();
    assert.equal(core.listComments()[0].replies.length, 0, 'the reply never entered');
    assert.equal(core.unreadCount('block:p1'), 1, 'and is not counted as something to read');
    assert.equal(r.dropped, 1);
    assert.equal(errors.filter((e) => e.code === 'IMPORT_ENTRY_DROPPED').length, 1);
    invariants(core, 'T38.1');
    core.destroy();
  }
  // 2 — the same id twice in one envelope: the first wins
  {
    const core = mount({ storage: makeStore().adapter });
    const errors = drops(core);
    const r = core.importEnvelope(envelope([entry('c1', 'p1', { body: 'first' }), entry('c1', 'p1', { body: 'second' })]), { mode: 'merge' });
    await settle();
    assert.equal(core.listComments().length, 1);
    assert.equal(core.listComments()[0].body, 'first');
    assert.equal(r.dropped, 1);
    assert.equal(errors.length, 1);
    invariants(core, 'T38.2');
    core.destroy();
  }
  // 3 — an id that already belongs to something else
  {
    const core = mount({ storage: makeStore().adapter });
    core.importEnvelope(envelope([entry('c1')]), { mode: 'merge' });
    await settle();
    const errors = drops(core);
    core.importEnvelope(envelope([entry('c2', 'p2', { replies: [{ id: 'c1', body: 'stolen', createdAt: NOW_ISH }] })]), { mode: 'merge' });
    await settle();
    assert.equal(core.listComments().find((c) => c.id === 'c1').body, 'c1', 'the original is untouched');
    assert.equal(errors.length, 1);
    invariants(core, 'T38.3');
    core.destroy();
  }
  // 4 — carrying a known utterance to another thread
  {
    const core = mount({ storage: makeStore().adapter });
    core.importEnvelope(envelope([entry('c1', 'p1')]), { mode: 'merge' });
    await settle();
    const errors = drops(core);
    core.importEnvelope(envelope([entry('c1', 'p2')]), { mode: 'merge' });
    await settle();
    assert.equal(core.listComments().length, 1);
    assert.equal(core.listComments()[0].anchor.elementId, 'p1', 'it stays where it was written');
    assert.equal(core.unreadCount('block:p2'), 0, 'and no thread appears at the other place');
    assert.equal(errors.length, 1);
    invariants(core, 'T38.4');
    core.destroy();
  }
  // 5 — buried and alive in one envelope: the tombstone wins
  {
    const core = mount({ storage: makeStore().adapter });
    core.importEnvelope(envelope([entry('c1', 'p1')]), { mode: 'merge' });
    await settle();
    const errors = drops(core);
    core.importEnvelope(envelope([entry('c1', 'p2')], { deleted: ['c1'] }), { mode: 'merge' });
    await settle();
    assert.deepEqual(core.listComments(), [], 'it is gone, not moved');
    assert.equal(errors.length, 1);
    invariants(core, 'T38.5');
    core.destroy();
  }
  // 6 — the legitimate move: bury the old, create a new one
  {
    const core = mount({ storage: makeStore().adapter });
    const d = display(core);
    core.importEnvelope(envelope([entry('c1', 'p1')]), { mode: 'merge' });
    await d.show('block:p1');
    await d.show();
    const errors = drops(core);
    core.importEnvelope(envelope([entry('c9', 'p2')], { deleted: ['c1'] }), { mode: 'merge' });
    await settle();
    assert.deepEqual(core.listComments().map((c) => c.id), ['c9']);
    assert.deepEqual(errors, [], 'nothing was wrong with that');
    assert.equal(core.unreadCount('block:p2'), 1, 'and where it went, it is new');
    invariants(core, 'T38.6');
    core.destroy();
  }
  // 8 — a replacement is refused whole
  {
    const core = mount({ storage: makeStore().adapter });
    core.importEnvelope(envelope([entry('c1', 'p1'), entry('c2', 'p2')]), { mode: 'merge' });
    await settle();
    const changes = [], errors = drops(core);
    core.on('change', (e) => changes.push(e));
    const r = core.importEnvelope(envelope([entry('c2', 'p2'), entry('c1', 'p3')]), { mode: 'replace' });
    await settle();
    assert.deepEqual(core.listComments().map((c) => c.id).sort(), ['c1', 'c2'], 'the document is untouched');
    assert.deepEqual(changes, [], 'nothing happened, so nothing was announced');
    assert.equal(r.added, 0);
    assert.ok(r.dropped >= 1);
    assert.equal(errors.filter((e) => e.code === 'IMPORT_REPLACE_REJECTED').length, 1, 'said once, about the replacement');
    invariants(core, 'T38.8');
    core.destroy();
  }
});

test('T45: a stored document gets the same reading as an envelope', async () => {
  // The other way in. An adapter can hand back anything, and everything downstream assumes the same
  // things about ids either way.
  {
    const store = makeStore({
      schemaVersion: 1, documentId: 'd',
      comments: [
        entry('c1', 'p1'),
        entry('c2', 'p1', { replies: [{ body: 'nameless', createdAt: NOW_ISH }, { id: 'r2', body: 'fine', createdAt: NOW_ISH }] }),
      ],
      arrival: { c1: 1, c2: 2, r2: 3 }, observed: {}, arrivalNext: 4,
    });
    const core = mount({ storage: store.adapter });
    const errors = [];
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await settle();
    const c2 = core.listComments().find((c) => c.id === 'c2');
    assert.deepEqual(c2.replies.map((r) => r.id), ['r2'], 'the nameless one is gone, its sibling is not');
    assert.equal(errors.filter((e) => e.code === 'IMPORT_ENTRY_DROPPED').length, 1);
    assert.equal(core.unreadCount('block:p1'), 3, 'and what survived is counted');
    invariants(core, 'T45 reply');
    core.destroy();
  }
  {
    const store = makeStore({
      schemaVersion: 1, documentId: 'd',
      comments: [entry('c1', 'p1', { body: 'first' }), entry('c1', 'p1', { body: 'second' })],
      arrival: { c1: 1 }, observed: {}, arrivalNext: 2,
    });
    const core = mount({ storage: store.adapter });
    const errors = [];
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await settle();
    assert.equal(core.listComments().length, 1);
    assert.equal(core.listComments()[0].body, 'first');
    assert.equal(errors.length, 1);
    invariants(core, 'T45 duplicate');
    core.destroy();
  }
  {
    const store = makeStore({
      schemaVersion: 1, documentId: 'd',
      comments: [{ anchor: { type: 'block', elementId: 'p1' }, body: 'no id', createdAt: NOW_ISH, replies: [{ id: 'r1', body: 'orphaned', createdAt: NOW_ISH }] }],
      arrival: {}, observed: {}, arrivalNext: 1,
    });
    const core = mount({ storage: store.adapter });
    const errors = [];
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await settle();
    assert.deepEqual(core.listComments(), [], 'the root took its reply with it');
    assert.equal(errors.length, 1, 'one thing was wrong, so one thing is said');
    assert.deepEqual(core.unreadThreads(), []);
    core.destroy();
  }
});

test('T40: saves happen one at a time, and the last state is never dropped', async () => {
  const gated = makeGated();
  const core = mount({ storage: gated.adapter });
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await settle();
  assert.equal(gated.calls.length, 1, 'the first save is in flight');

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'three' });
  await settle();
  assert.equal(gated.calls.length, 1, 'and nothing else started alongside it');

  await gated.release();
  await settle();
  assert.equal(gated.calls.length, 2, 'exactly one more — the two that queued became one');
  assert.equal(gated.calls[1].comments.length, 3, 'carrying the state as it is now, not as it was');
  core.destroy();
});

test('T41: a save queued behind a destroy never happens', async () => {
  const gated = makeGated();
  const core = mount({ storage: gated.adapter });
  const errors = [];
  core.on('error', (e) => errors.push(e));
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await settle();
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  await settle();
  assert.equal(gated.calls.length, 1);

  core.destroy();
  await gated.release();
  await quiet();
  assert.equal(gated.calls.length, 1, 'the queued one was about a world that is over');
  assert.deepEqual(errors, [], 'and nothing is announced after a destroy');
});

test('T42: what was restored as unread arrives as an ordinary announcement', async () => {
  const seed = {
    schemaVersion: 1, documentId: 'd',
    comments: [entry('c1', 'p1'), entry('c2', 'p1')],
    arrival: { c1: 1, c2: 2 }, observed: { 'block:p1': 1 }, arrivalNext: 3,
  };
  const core = mount({ storage: makeStore(seed).adapter });
  const early = [];
  core.on('unread:change', (e) => early.push(e));
  await core.ready;
  await quiet();
  assert.equal(early.length, 1);
  assert.deepEqual(early[0].threads, [{ threadKey: 'block:p1', count: 1 }]);

  const late = [];
  core.on('unread:change', (e) => late.push(e));
  await quiet();
  assert.deepEqual(late, [], 'a later subscriber is not sent history');
  assert.deepEqual(core.unreadThreads(), [{ threadKey: 'block:p1', count: 1 }], 'they ask instead');
  core.destroy();

  const empty = mount({ storage: makeStore({ schemaVersion: 1, documentId: 'd', comments: [entry('c1')], arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 2 }).adapter });
  const none = [];
  empty.on('unread:change', (e) => none.push(e));
  await empty.ready;
  await quiet();
  assert.deepEqual(none, [], 'nothing unread is not news');
  empty.destroy();
});

test('T43: the fact comes before what is derived from it', async () => {
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await d.show('block:p1');
  await quiet();
  const order = [];
  core.on('thread:visibility', () => order.push('thread:visibility'));
  core.on('unread:change', () => order.push('unread:change'));

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'in the open one' });
  core.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'in the shut one' });
  await settle();
  assert.deepEqual(order, ['thread:visibility', 'unread:change']);
  assert.deepEqual(core.unreadThreads(), [{ threadKey: 'block:p2', count: 1 }],
    'and only the one nobody was looking at is new');
  invariants(core, 'T43');
  core.destroy();
});

// ---- a reply is an utterance everywhere, not only where it is validated --------------------------
//
// Validation treats roots and replies alike. The operations that follow it — resolving a conflict,
// applying a tombstone — worked on records, which are roots. Wherever those two granularities meet is
// where an id can end up naming two utterances, or a deletion end up half-applied, and neither says
// anything when it happens.

test('keepBoth: a duplicated thread gets new identities all the way down', async () => {
  for (const withReplies of [true, false]) {
    const core = mount({ storage: makeStore().adapter });
    const thread = entry('c1', 'p1', withReplies
      ? { replies: [reply('r1'), reply('r2')] }
      : {});
    core.importEnvelope(envelope([thread]), { mode: 'merge' });
    await settle();
    const before = idsOf(core, 'block:p1').length;

    core.importEnvelope(envelope([thread]), { mode: 'merge', onConflict: 'keepBoth' });
    await settle();
    const ids = idsOf(core, 'block:p1');
    assert.equal(new Set(ids).size, ids.length, `${withReplies}: no id names two utterances`);
    assert.equal(ids.length, before * 2, `${withReplies}: the copy is a whole new thread`);
    assert.equal(core.unreadCount('block:p1'), ids.length,
      `${withReplies}: and the count is of utterances, not of ids counted twice`);
    invariants(core, `keepBoth ${withReplies}`);
    core.destroy();
  }
});

test('keepBoth: a minted id steps around replies too, not only roots', async () => {
  // Minting has to avoid every id in use, and a reply's id is one. Checking only the roots leaves the
  // one name a duplicate is most likely to reach for — the one built from the id it is duplicating —
  // free to land on a reply that already has it.
  const core = mount({ storage: makeStore().adapter });
  const thread = entry('c1', 'p1', { replies: [reply('r1')] });
  core.importEnvelope(envelope([
    thread,
    entry('c2', 'p2', { replies: [reply('c1-dup')] }),   // the name a duplicate of c1 would want
  ]), { mode: 'merge' });
  await settle();

  core.importEnvelope(envelope([thread]), { mode: 'merge', onConflict: 'keepBoth' });
  await settle();
  const all = [...idsOf(core, 'block:p1'), ...idsOf(core, 'block:p2')];
  assert.equal(new Set(all).size, all.length, 'still no id naming two utterances');
  invariants(core, 'keepBoth minting');
  core.destroy();
});

test('a buried reply goes from the thread it hangs under, whatever the conflict policy', async () => {
  // The envelope's own copy of a buried reply is refused by validation. That is only half of honouring
  // it: the one already stored has to go too, or the deletion has been read and partly obeyed — and
  // the reader is left looking at an utterance the sender declared gone.
  for (const onConflict of ['skip', 'replace', 'keepBoth']) {
    const core = mount({ storage: makeStore().adapter });
    const d = display(core);
    core.importEnvelope(envelope([entry('c1', 'p1', { replies: [reply('r1'), reply('r2')] })]), { mode: 'merge' });
    await d.show('block:p1');
    await d.show();
    assert.equal(core.unreadCount('block:p1'), 0, `${onConflict}: all read to start with`);

    const changes = [];
    core.on('change', (e) => changes.push(e.changes));
    core.importEnvelope(
      envelope([entry('c1', 'p1', { replies: [reply('r1'), reply('r2')] })], { deleted: ['r1'] }),
      { mode: 'merge', onConflict });
    await settle();

    const ids = idsOf(core, 'block:p1');
    assert.ok(!ids.includes('r1'), `${onConflict}: the buried reply is gone from the store`);
    assert.equal(new Set(ids).size, ids.length, `${onConflict}: and nothing was duplicated getting there`);
    assert.equal(core.unreadCount('block:p1'), ids.length - 2,
      `${onConflict}: what is left of the original is still read`);
    assert.ok(changes.flatMap((c) => c.updated).some((c) => c.id === 'c1'),
      `${onConflict}: the thread it hung under is reported as changed, however the reply left`);
    invariants(core, `buried reply ${onConflict}`);
    core.destroy();
  }
});

test('a buried reply that is not here changes nothing', async () => {
  const core = mount({ storage: makeStore().adapter });
  core.importEnvelope(envelope([entry('c1', 'p1', { replies: [reply('r1')] })]), { mode: 'merge' });
  await settle();
  const updates = [];
  core.on('comment:update', (e) => updates.push(e));
  core.importEnvelope(envelope([], { deleted: ['r-never-seen'] }), { mode: 'merge' });
  await settle();
  assert.deepEqual(idsOf(core, 'block:p1'), ['c1', 'r1']);
  assert.deepEqual(updates, [], 'nobody is told about a reply that was never here');
  core.destroy();
});

test('keepBoth: a minted id does not take one the same envelope is delivering', async () => {
  // Reserving what is STORED is only half of it. An envelope arrives as a whole, so a name invented
  // for one entry can land on an identity another entry in the same envelope was about to supply —
  // and then the utterance that conflicted with nothing is the one renamed, on account of somebody
  // else's copy.
  const core = mount({ storage: makeStore().adapter });
  core.importEnvelope(envelope([entry('c1', 'p1')]), { mode: 'merge' });
  await settle();

  const r = core.importEnvelope(envelope([
    entry('c1', 'p1', { body: 'the conflicting one' }),
    entry('c1-dup', 'p1', { body: 'not conflicting with anything' }),
  ]), { mode: 'merge', onConflict: 'keepBoth' });
  await settle();

  const ids = idsOf(core, 'block:p1');
  assert.equal(new Set(ids).size, ids.length, 'no id names two utterances');
  assert.ok(ids.includes('c1-dup'), 'the entry that supplied its own identity kept it');
  assert.equal(core.listComments().find((c) => c.id === 'c1-dup').body, 'not conflicting with anything',
    'and it is the entry that supplied it, not a copy wearing its name');
  assert.equal(r.conflicts, 1, 'only the one that actually conflicted is reported as one');
  invariants(core, 'keepBoth envelope-wide');
  core.destroy();
});
