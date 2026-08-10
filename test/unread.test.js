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

/**
 * A storage adapter the test can look inside. TWO records, because that is the contract: the document
 * is what people wrote, progress is how far this reader got, and they are written by different acts.
 * Keeping them apart here is what lets a test say which of the two a given operation touched.
 */
const makeStore = (seed = null, progressSeed = null) => {
  let saved = seed, progress = progressSeed;
  return {
    adapter: {
      load: () => saved, save: (doc) => { saved = doc; },
      loadProgress: () => progress, saveProgress: (p) => { progress = p; },
    },
    peek: () => saved,
    peekProgress: () => progress,
  };
};
/** One that has nowhere to put progress — an adapter written before this existed. */
const makeDocumentOnlyStore = (seed = null) => {
  let saved = seed;
  return { adapter: { load: () => saved, save: (doc) => { saved = doc; } }, peek: () => saved };
};

/** One that refuses to write until told otherwise — both records, so neither is durable meanwhile. */
const makeFlaky = () => {
  const a = { fail: true, saves: [], progressSaves: [] };
  a.adapter = {
    load: () => null,
    save: (doc) => { if (a.fail) throw new Error('quota'); a.saves.push(doc); },
    loadProgress: () => null,
    saveProgress: (p) => { if (a.fail) throw new Error('quota'); a.progressSaves.push(p); },
  };
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
  const store = makeStore(
    { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1'), entry('c2', 'p1')] },
    { arrival: { c1: 1, c2: 2 }, observed: { 'block:p1': 1 }, arrivalNext: 3 });
  const a = mount({ storage: store.adapter, readOnly: true });
  await a.ready;
  await settle();
  assert.equal(a.unreadCount('block:p1'), 1, 'one of the two is new to them');
  const d = display(a);
  await d.show('block:p1');
  assert.equal(a.unreadCount('block:p1'), 0);
  await quiet();
  assert.equal(store.peekProgress().observed['block:p1'], 2, 'and it was written down');
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
  const lastProgress = flaky.progressSaves.at(-1);
  assert.ok(lastProgress, 'and so did the progress, which is written separately now');
  assert.ok(lastProgress.observed['block:p1'] >= 1, 'carrying what had been read while saving was broken');
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
  const seed = { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] };
  const core = mount({ storage: {
    load: () => new Promise((r) => { release = () => r(seed); }), save: () => {},
    loadProgress: () => ({ arrival: { c1: 1 }, observed: {}, arrivalNext: 2 }), saveProgress: () => {},
  } });
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
    // The cases are written as one object because that is how they read; the two records are split
    // here. No progress keys at all is the record written before any of this existed.
    const { comments, ...progress } = over;
    const store = makeStore({ schemaVersion: 1, documentId: 'd', comments },
      Object.keys(progress).length ? progress : null);
    const core = mount({ storage: store.adapter });
    await core.ready;
    await settle();
    assert.equal(core.unreadCount('block:p1'), expected, what);
    invariants(core, `T37 ${what}`);
    core.destroy();
  }
});

test('T37: a cursor past everything ever handed out cannot swallow what comes next', async () => {
  const store = makeStore({ schemaVersion: 1, documentId: 'd', comments: [entry('c1')] },
    { arrival: { c1: 1 }, observed: { 'block:p1': 999 }, arrivalNext: 2 });
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
  const store = makeStore({ schemaVersion: 1, documentId: 'd', comments: [entry('c1')] },
    { arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 0 });
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
    }, { arrival: { c1: 1, c2: 2, r2: 3 }, observed: {}, arrivalNext: 4 });
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
    }, { arrival: { c1: 1 }, observed: {}, arrivalNext: 2 });
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
    }, { arrival: {}, observed: {}, arrivalNext: 1 });
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
  const seed = { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1'), entry('c2', 'p1')] };
  const core = mount({ storage: makeStore(seed,
    { arrival: { c1: 1, c2: 2 }, observed: { 'block:p1': 1 }, arrivalNext: 3 }).adapter });
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

  const empty = mount({ storage: makeStore({ schemaVersion: 1, documentId: 'd', comments: [entry('c1')] },
    { arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 2 }).adapter });
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

test('the library owns identity on every way in, replies included', async () => {
  // The fourth place a rule was enforced at one granularity and acted on at another. Adding a comment
  // accepts initial replies, and those went in wearing whatever ids the caller supplied — so an id
  // that already named something else could enter through the ordinary front door, past the check the
  // import and restore paths both run. What it produces is silent: an utterance counted as already
  // read because a different utterance was.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  const first = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'first' });
  await d.show('block:p1');
  await d.show();
  assert.equal(core.unreadCount('block:p1'), 0, 'read, so anything new after this should show');

  // A caller hands over a reply wearing an id that is already in use.
  core.addComment({
    anchor: { type: 'block', elementId: 'p2' }, body: 'a new thread',
    replies: [{ id: first.id, body: 'a reply wearing somebody else\'s name', createdAt: NOW_ISH }],
  });
  await settle();

  const everywhere = [...idsOf(core, 'block:p1'), ...idsOf(core, 'block:p2')];
  assert.equal(new Set(everywhere).size, everywhere.length, 'no id names two utterances');
  assert.equal(core.unreadCount('block:p2'), 2, 'and both new utterances are new — neither inherits a reading');
  invariants(core, 'identity on the add path');
  core.destroy();
});

// ---- reading writes progress, and nothing else ---------------------------------------------------
//
// The document and this reader's progress are written by different acts and belong to different
// people: comments are what somebody wrote, progress is how far somebody read. While one write
// carried both, reading — which cannot change a comment — wrote every comment the reader happened to
// be holding, and so undid whatever another instance had written since. These fix the separation
// itself rather than the symptom, because the symptom is silent.

test('reading never writes the document', async () => {
  const store = makeStore(
    { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] },
    { arrival: { c1: 1 }, observed: {}, arrivalNext: 2 });
  let documentWrites = 0;
  const watched = { ...store.adapter, save: (d) => { documentWrites += 1; store.adapter.save(d); } };
  const core = mount({ storage: watched });
  await core.ready;
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1);
  documentWrites = 0;

  const d = display(core);
  await d.show('block:p1');
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'the reading happened');
  assert.equal(store.peekProgress().observed['block:p1'], 1, 'and was written down');
  assert.equal(documentWrites, 0, 'without the document being written at all');
  core.destroy();
});

test('an instance that has read but not written cannot undo what another wrote', async () => {
  // The failure this separation removes. Two instances on one storage — the ordinary "same page open
  // twice" — where one only ever reads. It used to write back the comments it loaded at mount, so the
  // other one's work vanished with no error and no sign, until the next reload.
  let document = { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] };
  let progress = { arrival: { c1: 1 }, observed: {}, arrivalNext: 2 };
  const shared = {
    load: () => document, save: (d) => { document = d; },
    loadProgress: () => progress, saveProgress: (p) => { progress = p; },
  };
  const bodies = () => document.comments.map((c) => c.body);

  const reader = mount({ storage: shared });
  await reader.ready;
  await quiet();

  const writer = mount({ storage: shared });
  await writer.ready;
  writer.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'written by the other one' });
  await quiet();
  assert.deepEqual(bodies(), ['c1', 'written by the other one']);

  // The reader does the only thing it has done all session: it reads.
  const d = display(reader);
  await d.show('block:p1');
  await quiet();
  assert.deepEqual(bodies(), ['c1', 'written by the other one'], 'still there');
  assert.equal(reader.unreadCount('block:p1'), 0, 'and the reading was recorded all the same');
  reader.destroy(); writer.destroy();
});

test('an adapter with nowhere to keep progress keeps its comments safe', async () => {
  // Adapters written before progress existed have no method for it. They do not get it — unread lives
  // only as long as the instance does. What they must never get is the old behaviour of folding it
  // into the document write, because that is exactly what cost them their comments.
  const store = makeDocumentOnlyStore({ schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] });
  let documentWrites = 0;
  const watched = { load: store.adapter.load, save: (d) => { documentWrites += 1; store.adapter.save(d); } };
  const core = mount({ storage: watched });
  await core.ready;
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'no progress record at all reads as the old shape: already seen');

  core.importEnvelope(envelope([entry('c2', 'p1')]), { mode: 'merge' });
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1, 'and the next arrival is still new');
  documentWrites = 0;

  const d = display(core);
  await d.show('block:p1');
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'reading works in memory');
  assert.equal(documentWrites, 0, 'and writes nothing');
  core.destroy();
});

test('progress comes back through its own record, and the document through its own', async () => {
  const store = makeStore();
  const a = mount({ storage: store.adapter });
  const da = display(a);
  a.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'read this' });
  await da.show('block:p1');
  a.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'not this' });
  await quiet();
  assert.deepEqual(Object.keys(store.peek()).sort(), ['comments', 'documentId', 'keepsProgress', 'schemaVersion'],
    'the document record carries the document, and the shape it was written in — nothing about a reader');
  assert.deepEqual(Object.keys(store.peekProgress()).sort(), ['arrival', 'arrivalNext', 'observed'],
    'and the progress record carries the progress');
  a.destroy();

  const b = mount({ storage: store.adapter });
  await b.ready;
  await settle();
  assert.equal(b.unreadCount('block:p1'), 0, 'read stays read across the two records');
  assert.equal(b.unreadCount('block:p2'), 1, 'and unread stays unread');
  invariants(b, 'two records');
  b.destroy();
});

// ---- two records, two fates ----------------------------------------------------------------------

test('one record failing to save does not strand the other, or itself', async () => {
  // Separating WHERE the two are kept without separating whether they SUCCEED would leave them apart
  // in storage and joined in failure: a progress write that could not land would take a comment down
  // with it, and neither would be pending in anybody's book afterwards.
  const state = { failProgress: true, failDocument: false, docs: [], progress: [] };
  const adapter = {
    load: () => null, loadProgress: () => null,
    save: (d) => { if (state.failDocument) throw new Error('document quota'); state.docs.push(d); },
    saveProgress: (p) => { if (state.failProgress) throw new Error('progress quota'); state.progress.push(p); },
  };
  const core = mount({ storage: adapter });
  const errors = [];
  core.on('error', (e) => errors.push(e));

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'written while progress is broken' });
  await quiet();
  assert.equal(state.docs.length, 1, 'the document was still attempted, and landed');
  assert.ok(errors.length >= 1, 'and the progress failure was reported');

  // The other way round: the document cannot land, progress can.
  state.failProgress = false; state.failDocument = true;
  const d = display(core);
  await d.show('block:p1');
  await quiet();
  assert.ok(state.progress.length >= 1, 'progress landed on its own');

  await d.show();
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'written while the document is broken' });
  await quiet();
  assert.equal(state.docs.length, 1, 'the document write failed, so nothing new was stored');

  // …and it is still pending. The next occasion is a READING, which is the sequence that used to
  // leave the comment stranded: progress landed, the document was never tried again, and nothing
  // remembered that it had not been stored.
  state.failDocument = false;
  await d.show('block:p1');
  await quiet();
  assert.equal(state.docs.length, 2, 'the change that could not land was written when it could');
  assert.equal(state.docs.at(-1).comments.length, 2, 'carrying both, not just the newer one');
  core.destroy();
});

test('a save that succeeds does not clear what arrived while it was in flight', async () => {
  // The subtle half of the same thing. A write carries a snapshot taken when it started; anything that
  // happens before it lands is NOT in it, and must not be marked stored by its success.
  const gated = makeGated();
  const core = mount({ storage: gated.adapter });
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await settle();
  assert.equal(gated.calls.length, 1);

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  await gated.release();          // the first write lands, knowing nothing of the second comment
  await settle();
  assert.equal(gated.calls.length, 2, 'the change made while it was in flight is written after it');
  assert.equal(gated.calls[1].comments.length, 2);
  core.destroy();
});

test('progress that arrives late is waited for, not missed', async () => {
  // An adapter may be asynchronous everywhere, and reading progress is no exception. Treating a
  // pending read as "there is none" restores a document as entirely seen — silently, and exactly for
  // the server-backed adapters that cannot answer synchronously.
  const store = makeStore(
    { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1'), entry('c2', 'p1')] },
    null);
  const slow = {
    ...store.adapter,
    loadProgress: () => new Promise((r) => setTimeout(
      () => r({ arrival: { c1: 1, c2: 2 }, observed: { 'block:p1': 1 }, arrivalNext: 3 }), 0)),
  };
  const core = mount({ storage: slow });
  await core.ready;
  await settle();
  assert.equal(core.unreadCount('block:p1'), 1, 'the record was waited for and believed');
  invariants(core, 'async progress');
  core.destroy();
});

test('progress that cannot be read is not the same as none', async () => {
  // Nothing stored means the document predates progress, and what is in it is what the reader has
  // lived with — calling that unread would light every mark at once. A record that EXISTS and cannot
  // be read means nothing is known, and nothing known must never become "already seen".
  const comments = [entry('c1', 'p1'), entry('c2', 'p2')];
  const none = mount({ storage: { load: () => ({ schemaVersion: 1, documentId: 'd', comments }), save: () => {} } });
  await none.ready; await settle();
  assert.deepEqual(none.unreadThreads(), [], 'no record at all: the old shape, already seen');
  none.destroy();

  for (const how of ['throws', 'rejects']) {
    const core = mount({ storage: {
      load: () => ({ schemaVersion: 1, documentId: 'd', comments }), save: () => {},
      loadProgress: () => { if (how === 'throws') throw new Error('corrupt'); return Promise.reject(new Error('corrupt')); },
      saveProgress: () => {},
    } });
    await core.ready; await settle();
    assert.deepEqual(core.unreadThreads().map((t) => t.threadKey), ['block:p1', 'block:p2'],
      `${how}: a record that cannot be read leaves everything to be looked at again`);
    invariants(core, `unreadable progress ${how}`);
    core.destroy();
  }
});

test('half a progress pair is no progress pair, and says so', async () => {
  // One half alone is a capability that half works — writes nothing reads back, or reads of something
  // nothing writes — and neither half says so. Unread would simply fail to persist, for a reason
  // nobody could see from the outside.
  for (const half of ['loadProgress', 'saveProgress']) {
    const written = [];
    const adapter = {
      load: () => ({ schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] }),
      save: () => {},
      [half]: half === 'loadProgress'
        ? () => ({ arrival: { c1: 1 }, observed: {}, arrivalNext: 2 })
        : (p) => written.push(p),
    };
    const core = mount({ storage: adapter });
    const errors = [];
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await quiet();
    assert.equal(errors.filter((e) => e.code === 'ADAPTER_FAILED').length, 1, `${half}: said once, plainly`);
    assert.ok(/progress/.test(errors[0].message), `${half}: and names what will not be kept`);
    assert.deepEqual(core.unreadThreads(), [], `${half}: taken as having no progress record at all`);

    const d = display(core);
    await d.show('block:p1');
    await quiet();
    assert.deepEqual(written, [], `${half}: and the half that could write is not used on its own`);
    core.destroy();
  }
});

// ---- one boundary, not two -----------------------------------------------------------------------

test('the settled answer is the only answer, even mid-turn', async () => {
  // Arrival used to be recognised when a change committed and observation when the boundary settled,
  // so between the two every synchronous question got an answer the event contract said could not
  // exist: an utterance in a thread the reader had OPEN counted as unread. Nothing corrected it —
  // from the core's side the picture was empty before and empty after, so there was nothing to say.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await d.show('block:p1');
  await quiet();
  const seen = [];
  core.on('unread:change', (e) => seen.push(e.threads.length));

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'while they are looking at it' });
  assert.equal(core.unreadCount('block:p1'), 0, 'mid-turn, the settled answer stands');
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'and it was the right one');
  assert.deepEqual(seen, [], 'nothing to correct, so nothing announced');
  invariants(core, 'open thread mid-turn');
  core.destroy();
});

test('what the window cannot know yet, it does not claim — and the next report says it', async () => {
  // The other side of the same coin. For a CLOSED thread the window under-counts, which is the
  // recoverable direction: the boundary numbers the arrival, the picture genuinely changes, and the
  // announcement carries the correction. An over-count had no such route back.
  const core = mount({ storage: makeStore().adapter });
  const d = display(core);
  await d.show();
  await quiet();
  const seen = [];
  core.on('unread:change', (e) => seen.push(e.threads));

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'nobody is looking' });
  assert.equal(core.unreadCount('block:p1'), 0, 'not claimed before it is settled');
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1);
  assert.equal(seen.length, 1, 'and the correction is announced');
  assert.deepEqual(seen[0], [{ threadKey: 'block:p1', count: 1 }]);
  invariants(core, 'closed thread mid-turn');
  core.destroy();
});

test('several arrivals in one turn keep the order they arrived in', async () => {
  // The numbers ARE arrival order to anything reading them back, so they cannot be rediscovered later
  // from the finished document — that is the order the document is stored in, not the order things
  // reached here. One envelope can carry as many as it likes.
  const store = makeStore();
  const core = mount({ storage: store.adapter });
  const d = display(core);
  core.importEnvelope(envelope([entry('first'), entry('second'), entry('third')]), { mode: 'merge' });
  await quiet();
  const { arrival } = store.peekProgress();
  assert.ok(arrival.first < arrival.second && arrival.second < arrival.third,
    `arrived in order: ${JSON.stringify(arrival)}`);

  // And reading up to the middle one leaves exactly the later ones unread.
  core.registerThreadVisibility(() => ([{ threadKey: 'block:p1',
    anchor: { type: 'block', elementId: 'p1' }, comments: ['first', 'second'] }]));
  core.reportThreadVisibility();
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 1, 'only the one after them');
  invariants(core, 'order in one turn');
  d.stop(); core.destroy();
});

test('an utterance that arrives and goes within one turn never takes a number', async () => {
  const store = makeStore();
  const core = mount({ storage: store.adapter });
  const c = core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'brief' });
  core.deleteComment(c.id);
  await quiet();
  assert.deepEqual(core.unreadThreads(), []);
  assert.deepEqual(Object.keys(store.peekProgress().arrival), [], 'nothing to remember, so nothing remembered');
  core.destroy();
});

test('the built-in adapter tells corrupt progress from none, like any other', async () => {
  // The distinction is worth nothing if the adapter almost everybody uses defeats it on the way in.
  // Its parser used to answer "no record" for a record it could not read, which is the one answer that
  // silently clears marks: no record means the document predates unread, so everything counts as seen.
  const items = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => { items.set(k, v); },
    removeItem: (k) => { items.delete(k); },
  };
  try {
    const doc = { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1'), entry('c2', 'p2')] };
    items.set('tackback::corrupt-fixture', JSON.stringify(doc));
    items.set('tackback::corrupt-fixture::progress', 'not json at all');

    const core = Tackback.mount({ document: { id: 'corrupt-fixture' } });
    await core.ready;
    await quiet();
    assert.deepEqual(core.unreadThreads().map((t) => t.threadKey), ['block:p1', 'block:p2'],
      'nothing is known, so everything is left to be looked at again');
    core.destroy();

    // …and with no progress record at all, the same document reads as already seen.
    items.delete('tackback::corrupt-fixture::progress');
    const fresh = Tackback.mount({ document: { id: 'corrupt-fixture' } });
    await fresh.ready;
    await quiet();
    assert.deepEqual(fresh.unreadThreads(), [], 'no record: the shape written before unread existed');
    fresh.destroy();
  } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
});

test('an adapter whose operations are methods is not disabled by having half a pair', async () => {
  // The half-pair is refused by tracking the capability, not by rebuilding the adapter without it: a
  // copy keeps only own properties, so an adapter written as a class would lose its document
  // operations too — and be disabled entirely, for having offered too little rather than too much.
  class Adapter {
    constructor() { this.docs = []; }
    load() { return { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] }; }
    save(doc) { this.docs.push(doc); }
    saveProgress() { throw new Error('should never be called with no loadProgress'); }
  }
  const adapter = new Adapter();
  const core = mount({ storage: adapter });
  const errors = [];
  core.on('error', (e) => errors.push(e));
  await core.ready;
  await quiet();
  assert.equal(errors.filter((e) => e.code === 'ADAPTER_FAILED').length, 1, 'the half pair is reported');

  core.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'and the document still saves' });
  await quiet();
  assert.equal(adapter.docs.length, 1, 'its document operations were never taken away');
  assert.equal(adapter.docs[0].comments.length, 2);
  core.destroy();
});

test('a record that never finishes writing does not hold up the other', async () => {
  // Separating where the two are kept, and whether each succeeds, and still queueing them behind one
  // another leaves them joined in TIME: a progress write that never answers stops the document being
  // attempted at all. Same coupling, different road.
  const never = new Promise(() => {});
  const docs = [], progress = [];
  const stuck = {
    load: () => null, loadProgress: () => null,
    save: (d) => { docs.push(d); },
    saveProgress: (p) => { progress.push(p); return never; },
  };
  const core = mount({ storage: stuck });
  await core.ready;
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'written while progress hangs' });
  await quiet();
  assert.equal(progress.length, 1, 'the progress write started and is still hanging');
  assert.equal(docs.length, 1, 'and the document was written anyway');

  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'and so is the next one' });
  await quiet();
  assert.equal(docs.length, 2);
  assert.equal(progress.length, 1, 'while the hung channel is still waiting on its own');
  core.destroy();
});

test('a document write that never finishes does not hold up reading', async () => {
  const never = new Promise(() => {});
  const docs = [], progress = [];
  const stuck = {
    load: () => ({ schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] }),
    loadProgress: () => ({ arrival: { c1: 1 }, observed: {}, arrivalNext: 2 }),
    save: (d) => { docs.push(d); return never; },
    saveProgress: (p) => { progress.push(p); },
  };
  const core = mount({ storage: stuck });
  await core.ready;
  core.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'starts a document write that hangs' });
  await quiet();
  assert.equal(docs.length, 1, 'hanging');

  const d = display(core);
  await d.show('block:p1');
  await quiet();
  assert.equal(core.unreadCount('block:p1'), 0, 'the reading happened');
  assert.ok(progress.length >= 1, 'and was written, on its own channel');
  core.destroy();
});

test('each channel still writes one at a time, newest state last', async () => {
  // Independent between the records, serial within one: two writes of the same record finishing out
  // of order would leave an older snapshot on top, quietly undoing the newer one.
  const gated = makeGated();
  const core = mount({ storage: gated.adapter });
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  await settle();
  assert.equal(gated.calls.length, 1);
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'three' });
  await settle();
  assert.equal(gated.calls.length, 1, 'nothing started alongside it');
  await gated.release();
  await settle();
  assert.equal(gated.calls.length, 2, 'and the two that queued became one');
  assert.equal(gated.calls[1].comments.length, 3, 'carrying the state as it is now');
  core.destroy();
});

test('a document whose progress never landed is not mistaken for one written before progress', async () => {
  // The discriminator used to be "is there a progress record", which cannot tell a document written
  // before unread existed from one written by this build whose very first progress write never
  // answered. Both look the same, and one of the two answers — everything counts as seen — silently
  // clears marks the reader never looked at.
  let document = null;
  const neverAnswers = new Promise(() => {});
  const first = mount({ storage: {
    load: () => document, save: (d) => { document = d; },
    loadProgress: () => null, saveProgress: () => neverAnswers,
  } });
  await first.ready;
  first.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'arrived and never marked read' });
  await quiet();
  assert.equal(first.unreadCount('block:p1'), 1, 'unread here');
  assert.ok(document, 'the document itself did land');
  first.destroy();

  const second = mount({ storage: {
    load: () => document, save: () => {}, loadProgress: () => null, saveProgress: () => {},
  } });
  await second.ready;
  await quiet();
  assert.equal(second.unreadCount('block:p1'), 1, 'and still unread after coming back');
  invariants(second, 'progress never landed');
  second.destroy();

  // …while a document with no marker at all is still read as predating progress.
  const older = { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] };
  const legacy = mount({ storage: {
    load: () => older, save: () => {}, loadProgress: () => null, saveProgress: () => {},
  } });
  await legacy.ready;
  await quiet();
  assert.deepEqual(legacy.unreadThreads(), [], 'no marker, no record: written before any of this');
  legacy.destroy();
});

test('a document kept by an adapter that cannot hold progress does not claim it does', async () => {
  // The marker says a progress record is EXPECTED. An adapter with nowhere to put one will never have
  // it, so claiming otherwise turns a permanent, ordinary arrangement into "the write must have
  // failed" — and everything reads as unread every time, for ever.
  let document = null;
  const documentOnly = { load: () => document, save: (d) => { document = d; } };
  const first = mount({ storage: documentOnly });
  await first.ready;
  first.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'written with nowhere to keep progress' });
  await quiet();
  assert.equal(first.unreadCount('block:p1'), 1, 'unread within the session');
  assert.ok(!document.keepsProgress, 'and the document does not claim a record is coming');
  first.destroy();

  const second = mount({ storage: documentOnly });
  await second.ready;
  await quiet();
  assert.deepEqual(second.unreadThreads(), [],
    'next time, what is stored is the baseline — the documented session-only arrangement');
  invariants(second, 'document-only adapter');
  second.destroy();
});

// ---- the whole domain, not the cases somebody happened to hit -------------------------------------
//
// Restoring is decided by three things at once: what SHAPE the stored document says it was written in,
// whether this adapter can reach a progress record at all, and what state that record is in. Every
// defect found in this area was one unenumerated cell of that product, found by reproduction, fixed
// one at a time. The table is the fix for the class: a cell with no row is a question nobody asked.
//
// Capability comes first, because without it the record is never consulted — so those rows have no
// record axis rather than an empty one.

// ---- the whole domain, not the cases somebody happened to hit -------------------------------------
//
// Restoring is decided by three things at once: whether the stored document DECLARES that reading
// progress is kept in a record of its own, whether this adapter can reach such a record, and what
// state that record is in. Every defect found in this area was one unenumerated cell of that product,
// found by reproducing it. Reproduction finds the cell somebody walked into; it cannot find the cell
// nobody has.
//
// The axes, and why each is shaped this way:
//
//   DECLARATION   absent | present. There is no third value: a document written where progress cannot
//                 be kept looks exactly like one written before progress existed, because for the
//                 purpose of this decision it IS the same — there is no record here and there never
//                 was going to be one.
//   CAPABILITY    unavailable | complete. Half a pair counts as unavailable, and is reported; that
//                 reporting is checked on its own elsewhere, not here.
//   RECORD        only when capability is complete, because otherwise it is never consulted. Four
//                 states, not three: a readable record that says UNREAD and one that says READ are
//                 different answers, and separating them is what stops the declaration deciding for
//                 them. Rows that move the declaration and the record's content together can be
//                 satisfied by an implementation where the declaration decides and the record is
//                 ignored — which is a different library that passes the same table.

// THE TABLE OF VALID, SETTLED OUTCOMES. Two partitions sit outside it and are checked on their own:
// input validation, where the stored shape itself cannot be read (below), and loading in progress,
// where an answer has not arrived yet and there is no outcome to be in a cell of.
test('restoring: every reachable combination of declaration, capability and record', async () => {
  const doc = (declared) => (declared
    ? { schemaVersion: 1, documentId: 'd', keepsProgress: true, comments: [entry('c1', 'p1')] }
    : { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] });
  const SAYS_UNREAD = { arrival: { c1: 1 }, observed: {}, arrivalNext: 2 };
  const SAYS_READ = { arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 2 };

  const CASES = [
    // declaration absent — nothing here says a separate record was ever expected
    ['absent · unavailable',            false, 'unavailable', null, 0,
      'no record was ever expected here: what is stored is what the reader has lived with'],
    ['absent · complete · no record',   false, 'complete', null, 0,
      'the same, and being able to look changes nothing about what is there to find'],
    ['absent · complete · unreadable',  false, 'complete', 'unreadable', 1,
      'a record IS here and cannot be read: nothing is known'],
    ['absent · complete · says unread', false, 'complete', SAYS_UNREAD, 1,
      'the record is believed — and it is the record that answers, not the declaration'],
    ['absent · complete · says read',   false, 'complete', SAYS_READ, 0,
      'believed here too: an undeclared document with a record that says read, is read'],

    // declaration present — this document was written where a record is kept
    ['present · unavailable',            true, 'unavailable', null, 1,
      'a record was expected and this adapter cannot reach it: nothing is known'],
    ['present · complete · no record',   true, 'complete', null, 1,
      'expected, reachable, and not there: the write never landed'],
    ['present · complete · unreadable',  true, 'complete', 'unreadable', 1,
      'nothing is known'],
    ['present · complete · says unread', true, 'complete', SAYS_UNREAD, 1,
      'believed'],
    ['present · complete · says read',   true, 'complete', SAYS_READ, 0,
      'believed — a declared document with a record that says read, is read'],
  ];

  for (const [name, declared, capability, record, expected, why] of CASES) {
    const adapter = { load: () => doc(declared), save: () => {} };
    if (capability === 'complete') {
      adapter.loadProgress = () => {
        if (record === 'unreadable') throw new Error('corrupt');
        return record;
      };
      adapter.saveProgress = () => {};
    }
    const core = mount({ storage: adapter });
    core.on('error', () => {});
    await core.ready;
    await quiet();
    assert.equal(core.unreadCount('block:p1'), expected, `${name} → ${why}`);
    invariants(core, name);
    core.destroy();
  }
});

test('restoring: what may be called read, stated as a rule rather than as ten numbers', async () => {
  // A table of expected numbers can go on being satisfied while the principle underneath it quietly
  // stops holding, and no individual row would fail. The principle: reading is claimed only where a
  // record SAYS so, or where no record was ever expected. Everywhere else — expected and missing,
  // present and unreadable, out of reach — the reader is left to look again, because unknown is never
  // turned into read.
  const comments = [entry('c1', 'p1')];
  const claimedRead = [];
  for (const declared of [false, true]) {
    for (const capability of ['unavailable', 'complete']) {
      for (const record of [null, 'unreadable']) {
        if (capability === 'unavailable' && record === 'unreadable') continue;   // never consulted
        const stored = declared
          ? { schemaVersion: 1, documentId: 'd', keepsProgress: true, comments }
          : { schemaVersion: 1, documentId: 'd', comments };
        const adapter = { load: () => stored, save: () => {} };
        if (capability === 'complete') {
          adapter.loadProgress = () => { if (record === 'unreadable') throw new Error('corrupt'); return null; };
          adapter.saveProgress = () => {};
        }
        const core = mount({ storage: adapter });
        core.on('error', () => {});
        await core.ready;
        await quiet();
        if (core.unreadCount('block:p1') === 0) claimedRead.push(`declared=${declared} capability=${capability} record=${record}`);
        core.destroy();
      }
    }
  }
  // No record says anything in any of these, so the only cells that may claim reading are the ones
  // where none was ever expected.
  assert.deepEqual(claimedRead,
    ['declared=false capability=unavailable record=null', 'declared=false capability=complete record=null'],
    'with no record speaking, only an undeclared document counts as read');
});

test('restoring: a declaration nobody recognises is not the same as no declaration', async () => {
  // The partition BEFORE the table: whether the stored shape can be read at all. This field decides
  // whether an absent record may be called "already read", so a value nobody recognises must not mean
  // the same as no value — stored data is reachable by hand and through adapters that were never
  // typed, and corrupted format metadata quietly clearing marks is the failure the field exists to
  // prevent. Absent still means what it always meant; anything unrecognised means the shape is
  // unreadable, which is not knowledge.
  for (const declared of [false, 'true', 1, 0, null, {}, [], undefined]) {
    // Written as a property that is THERE, whatever it holds — including undefined, which is not the
    // same as never having been written at all.
    const stored = { schemaVersion: 1, documentId: 'd', keepsProgress: declared, comments: [entry('c1', 'p1')] };
    const errors = [];
    const core = mount({ storage: {
      load: () => stored, save: () => {},
      loadProgress: () => null, saveProgress: () => {},
    } });
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await quiet();
    assert.equal(core.unreadCount('block:p1'), 1, `${JSON.stringify(declared)}: left to be looked at again`);
    assert.equal(errors.filter((e) => e.code === 'STORAGE_LOAD_FAILED').length, 1,
      `${JSON.stringify(declared)}: and said out loud rather than absorbed`);
    invariants(core, `malformed declaration ${JSON.stringify(declared)}`);
    core.destroy();
  }

  // …while the one value that IS recognised, and its absence, behave as the table says.
  for (const [declared, expected] of [[true, 1], [undefined, 0]]) {
    const stored = { schemaVersion: 1, documentId: 'd', comments: [entry('c1', 'p1')] };
    if (declared !== undefined) stored.keepsProgress = declared;
    const errors = [];
    const core = mount({ storage: {
      load: () => stored, save: () => {}, loadProgress: () => null, saveProgress: () => {},
    } });
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await quiet();
    assert.equal(core.unreadCount('block:p1'), expected, `${declared}: recognised`);
    assert.deepEqual(errors, [], `${declared}: nothing wrong to report`);
    core.destroy();
  }
});

test('restoring: a shape that cannot be read stops the record being believed, not merely reported', async () => {
  // The partition has to be a boundary. Announcing that the stored shape is unreadable and then going
  // on to trust the record inside it is a comment, not validation — and the record is the one thing
  // that can say "already read", which is what the whole check exists to withhold.
  const record = { arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 2 };   // says: read
  for (const declared of [false, 'true', 1, null, undefined]) {
    const stored = { schemaVersion: 1, documentId: 'd', keepsProgress: declared, comments: [entry('c1', 'p1')] };
    const errors = [];
    const core = mount({ storage: {
      load: () => stored, save: () => {}, loadProgress: () => record, saveProgress: () => {},
    } });
    core.on('error', (e) => errors.push(e));
    await core.ready;
    await quiet();
    assert.equal(core.unreadCount('block:p1'), 1,
      `${JSON.stringify(declared)}: the record says read, and is not believed`);
    assert.equal(errors.filter((e) => e.code === 'STORAGE_LOAD_FAILED').length, 1);
    invariants(core, `malformed declaration with a record ${JSON.stringify(declared)}`);
    core.destroy();
  }

  // …and the recognised shape does believe the same record.
  const ok = mount({ storage: {
    load: () => ({ schemaVersion: 1, documentId: 'd', keepsProgress: true, comments: [entry('c1', 'p1')] }),
    save: () => {}, loadProgress: () => record, saveProgress: () => {},
  } });
  await ok.ready;
  await quiet();
  assert.equal(ok.unreadCount('block:p1'), 0, 'a shape that can be read believes what is inside it');
  ok.destroy();
});

test('restoring: nothing waits for an answer it was never going to use', async () => {
  // The partitions have to be an ORDER, not just a hierarchy in prose. Asking for progress before
  // deciding whether there is a document, or whether its shape can be read, means an adapter that
  // answers late — or never — holds up decisions that never needed it. Readiness then hangs on a
  // question with no bearing on the answer.
  const never = () => new Promise(() => {});
  const settled = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), 40))]);

  // No document: there is nothing for progress to apply to.
  const empty = mount({ storage: { load: () => null, save: () => {}, loadProgress: never, saveProgress: () => {} } });
  assert.notEqual(await settled(empty.ready.then(() => 'ready')), 'HUNG', 'ready with no document');
  assert.deepEqual(empty.unreadThreads(), []);
  empty.destroy();

  // A shape that cannot be read: the record was never going to be believed.
  const errors = [];
  const malformed = mount({ storage: {
    load: () => ({ schemaVersion: 1, documentId: 'd', keepsProgress: 'yes please', comments: [entry('c1', 'p1')] }),
    save: () => {}, loadProgress: never, saveProgress: () => {},
  } });
  malformed.on('error', (e) => errors.push(e));
  assert.notEqual(await settled(malformed.ready.then(() => 'ready')), 'HUNG', 'ready with an unreadable shape');
  await quiet();
  assert.equal(malformed.unreadCount('block:p1'), 1, 'and left to be looked at again');
  assert.equal(errors.filter((e) => e.code === 'STORAGE_LOAD_FAILED').length, 1);
  invariants(malformed, 'malformed shape, pending progress');
  malformed.destroy();

  // …while a document whose shape IS readable does wait, because the answer is going to be used.
  let release;
  const waits = mount({ storage: {
    load: () => ({ schemaVersion: 1, documentId: 'd', keepsProgress: true, comments: [entry('c1', 'p1')] }),
    save: () => {},
    loadProgress: () => new Promise((r) => { release = () => r({ arrival: { c1: 1 }, observed: { 'block:p1': 1 }, arrivalNext: 2 }); }),
    saveProgress: () => {},
  } });
  assert.equal(await settled(waits.ready.then(() => 'ready')), 'HUNG', 'it waits for what it will use');
  release();
  await waits.ready;
  await quiet();
  assert.equal(waits.unreadCount('block:p1'), 0, 'and then believes it');
  waits.destroy();
});
