// node:test — phase 4 events/submission seam: replies (REQ-307), the three submission modes
// (REQ-701), the transport descriptor (REQ-205/701), and rev:mismatch drift (REQ-204/304). Core
// EMITS typed events; it never transports.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Tackback } from '../src/index.js';
import { memoryAdapter } from '../src/core/storage.js';

const mount = (doc = { id: 'd' }) => Tackback.mount({ document: doc, storage: memoryAdapter() });
const block = (el = 'p1') => ({ type: 'block', elementId: el });

// ---- replies (REQ-307) -----------------------------------------------------------------------

test('addReply appends to replies[], emits comment:update{comment,previous}, round-trips on export/import', () => {
  const tb = mount();
  const c = tb.addComment({ anchor: block(), body: 'root' });
  let payload = null;
  tb.on('comment:update', (p) => { payload = p; });
  const updated = tb.addReply(c.id, { body: 'first reply', author: { id: 'kj', kind: 'human' } });
  assert.equal(updated.replies.length, 1);
  assert.equal(updated.replies[0].body, 'first reply');
  assert.equal(updated.replies[0].author.id, 'kj');
  assert.ok(updated.replies[0].id && updated.replies[0].createdAt, 'library owns id + createdAt');
  assert.ok(payload && payload.comment.id === c.id && payload.previous.replies === undefined, 'previous had no replies');

  // order preserved across export → fresh import
  tb.addReply(c.id, { body: 'second reply' });
  const env = tb.exportEnvelope();
  const tb2 = mount();
  tb2.importEnvelope(env, { mode: 'replace' });
  const got = tb2.getComment(c.id);
  assert.deepEqual(got.replies.map((r) => r.body), ['first reply', 'second reply'], 'reply order preserved');
});

test('addReply to an unknown id throws COMMENT_NOT_FOUND', () => {
  const tb = mount();
  assert.throws(() => tb.addReply('nope', { body: 'x' }), /COMMENT_NOT_FOUND|no comment/);
});

// ---- submission modes (REQ-701) --------------------------------------------------------------

// The panel's "sent — awaiting reply…" marker is settled by what arrives after a send, and it rests
// on these two facts about how a commit delivers its events. If either changed, the marker would go
// back to waiting forever for an answer that had already come — so they are pinned here, beside the
// seam they belong to, rather than left as an assumption buried in the panel.
test('a commit delivers change then comment:add, both BEFORE addComment returns', () => {
  const tb = Tackback.mount({ document: { id: 'order' }, storage: memoryAdapter() });
  const order = [];
  tb.on('change', () => order.push('change'));
  tb.on('comment:add', () => order.push('comment:add'));
  const c = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'hi' });
  assert.deepEqual(order, ['change', 'comment:add'], 'both fired synchronously, in this order');
  assert.ok(c && c.id, 'and only then did the call return');
});

test('an integrator replying from its comment:add handler has ALREADY replied when the commit returns', () => {
  const tb = Tackback.mount({ document: { id: 'sync-reply' }, storage: memoryAdapter() });
  tb.on('comment:add', (c) => tb.addReply(c.id, { body: 'instant answer', author: { id: 'helper', kind: 'assistant' } }));
  const created = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'a question' });
  // the answer is already in the store — a UI that waits for a LATER event to notice it waits forever
  assert.equal(tb.getComment(created.id).replies.length, 1, 'the answer landed during the commit');
  // …and the object the commit RETURNED is a snapshot from before it, so reading `replies` off the
  // return value is not a way to find that answer: the thread has to be re-read from the store.
  assert.equal((created.replies || []).length, 0, 'the returned comment predates the reply');
});

test('mode 2 "send all": submitBatch emits submit:batch with the whole set; empty set = no-op', () => {
  const tb = mount();
  let batches = 0, lastPayload = null;
  tb.on('submit:batch', (p) => { batches++; lastPayload = p; });
  // empty set → no-op (no event)
  assert.equal(tb.submitBatch(), null);
  assert.equal(batches, 0, 'no event on empty set');
  // with comments → one event carrying the whole set + an envelope
  tb.addComment({ anchor: block('a'), body: 'one' });
  tb.addComment({ anchor: block('b'), body: 'two' });
  const payload = tb.submitBatch();
  assert.equal(batches, 1);
  assert.equal(lastPayload.comments.length, 2);
  assert.equal(lastPayload.envelope.comments.length, 2, 'envelope carries the set');
  assert.equal(payload.comments.length, 2, 'returns the emitted payload');
});

test('mode 3 "per-comment": each commit emits comment:add (the integrator transports it)', () => {
  const tb = mount();
  const added = [];
  tb.on('comment:add', (c) => added.push(c.body));
  tb.addComment({ anchor: block('a'), body: 'one' });
  tb.addComment({ anchor: block('b'), body: 'two' });
  assert.deepEqual(added, ['one', 'two']);
});

test('modes 2/3 work with NO transport attached; mode 1 export still works (REQ-701 a)', () => {
  const tb = mount();
  tb.addComment({ anchor: block('a'), body: 'one' });
  // no setTransport called
  assert.equal(tb.getTransport(), null);
  assert.doesNotThrow(() => tb.submitBatch());
  assert.equal(tb.exportEnvelope().comments.length, 1, 'export (mode 1) works regardless');
});

// ---- transport descriptor (REQ-205/701: descriptor only, core never transports) -------------

test('setTransport / getTransport hold a descriptor the core never calls', () => {
  const tb = mount();
  assert.equal(tb.getTransport(), null);
  tb.setTransport({ interactive: true, label: 'Send to backend' });
  assert.deepEqual(tb.getTransport(), { interactive: true, label: 'Send to backend' });
  tb.setTransport(null);
  assert.equal(tb.getTransport(), null);
});

// ---- rev:mismatch drift (REQ-204/304, Z3): warn but never refuse -----------------------------

test('rev:mismatch fires when the import revision disagrees; comments are still loaded (not refused)', () => {
  const tb = mount({ id: 'doc', revisionHash: 'sha256:CURRENT' });
  let mismatch = null;
  tb.on('rev:mismatch', (p) => { mismatch = p; });
  const env = {
    schemaVersion: 1,
    document: { id: 'doc', revisionHash: 'sha256:OLD' },
    comments: [{ id: 'c1', anchor: block('p1'), body: 'authored against an old rev', createdAt: 't' }],
  };
  const result = tb.importEnvelope(env, { mode: 'merge' });
  assert.ok(mismatch && mismatch.expected === 'sha256:CURRENT' && mismatch.actual === 'sha256:OLD');
  assert.equal(tb.listComments().length, 1, 'comments loaded in drift mode, NOT refused');
  assert.equal(result.dropped, 0);
});

test('matching revision → no rev:mismatch; legacy envelope without a revision skips the check', () => {
  const tb = mount({ id: 'doc', revisionHash: 'sha256:SAME' });
  let fired = 0;
  tb.on('rev:mismatch', () => fired++);
  tb.importEnvelope({ document: { id: 'doc', revisionHash: 'sha256:SAME' }, comments: [] }, { mode: 'merge' });
  assert.equal(fired, 0, 'same rev → no warning');
  // legacy: no revisionHash on either side → comparison skipped (REQ-304 b)
  const tb2 = mount({ id: 'doc' });
  tb2.on('rev:mismatch', () => fired++);
  tb2.importEnvelope({ document: { id: 'doc' }, comments: [] }, { mode: 'merge' });
  assert.equal(fired, 0, 'missing rev → comparison skipped');
});

test('setTransport announces a real change, and stays quiet when nothing changed', () => {
  // a UI that decides "Save or Send" when it opens goes stale the moment this changes. A Pane's
  // staleness is bounded by its own lifetime; a persistent composer's is not.
  const tb = Tackback.mount({ document: { id: 'transport-events' }, storage: memoryAdapter() });
  const seen = [];
  tb.on('transport:change', (d) => seen.push(d));
  tb.setTransport({ interactive: true, label: 'Send' });
  tb.setTransport({ interactive: true, label: 'Send' });   // same descriptor — nothing to announce
  tb.setTransport({ label: 'Send', interactive: true });   // …and the same one written differently
  tb.setTransport(null);
  tb.setTransport(null);
  assert.deepEqual(seen, [{ interactive: true, label: 'Send' }, null],
    'one event per change of DESCRIPTOR, not per change of representation');
  assert.equal(tb.getTransport(), null, 'and the descriptor itself still reads back');
});

// ---- the seam an integrator needs to know that something was deleted, and by which act ---------

test('deleteComments: one operation, one commit, one operation-level event', () => {
  const tb = Tackback.mount({ document: { id: 'batch-delete' }, storage: memoryAdapter() });
  const a = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  const b = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  tb.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'elsewhere' });
  const singles = [], batches = [], changes = [];
  tb.on('comment:delete', (e) => singles.push(e.id));
  tb.on('comments:delete', (e) => batches.push(e.ids));
  tb.on('change', () => changes.push(1));
  const res = tb.deleteComments([a.id, b.id]);
  assert.deepEqual(res.ids, [a.id, b.id]);
  assert.deepEqual(singles, [a.id, b.id], 'a `comment:delete` subscription still gets one event per removed comment');
  assert.deepEqual(batches, [[a.id, b.id]], 'and the OPERATION reports once, which is what N events could not say');
  assert.equal(changes.length, 1, 'one operation, one commit');
  assert.equal(tb.listComments().length, 1, 'the comment on the other anchor is untouched');
});

test('deleteComments: unknown ids are skipped, and an all-unknown call is a silent no-op', () => {
  const tb = Tackback.mount({ document: { id: 'batch-partial' }, storage: memoryAdapter() });
  const a = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  const seen = [];
  tb.on('comments:delete', (e) => seen.push(e.ids));
  assert.deepEqual(tb.deleteComments([a.id, 'never-existed']).ids, [a.id]);
  assert.deepEqual(seen, [[a.id]], 'the event reports what actually went');
  assert.deepEqual(tb.deleteComments(['nothing', 'here']).ids, []);
  assert.deepEqual(seen.length, 1, 'and an operation that removed nothing announces nothing');
});

test('importEnvelope: a merge honours the incoming envelope\'s tombstones', () => {
  // the bug this exists for: an integrator polling a server and merging its envelope resurrected
  // every comment the server had deleted, because merge only ever added.
  const tb = Tackback.mount({ document: { id: 'tombstones' }, storage: memoryAdapter() });
  const gone = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'deleted on the server' });
  const kept = tb.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'still there' });
  const removed = [];
  tb.on('comments:delete', (e) => removed.push(...e.ids));
  const res = tb.importEnvelope({ schemaVersion: 1, document: { id: 'tombstones' }, comments: [], deleted: [gone.id] }, { mode: 'merge' });
  assert.equal(res.deleted, 1, 'the import reports what it removed');
  assert.deepEqual(tb.listComments().map((c) => c.id), [kept.id], 'and the server\'s deletion sticks');
  assert.deepEqual(removed, [gone.id], 'reported on the same seam as any other deletion');
});

test('importEnvelope: tombstones for ids we never had, or of the wrong shape, change nothing', () => {
  const tb = Tackback.mount({ document: { id: 'tombstones-noop' }, storage: memoryAdapter() });
  const c = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'here' });
  const res = tb.importEnvelope({ comments: [], deleted: ['never-had-it', 42, null] }, { mode: 'merge' });
  assert.equal(res.deleted, 0);
  assert.equal(tb.listComments().length, 1);
  assert.ok(c.id);
});

test('an envelope without `deleted` behaves exactly as it did before', () => {
  const tb = Tackback.mount({ document: { id: 'no-tombstones' }, storage: memoryAdapter() });
  tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'here' });
  const res = tb.importEnvelope({ comments: [] }, { mode: 'merge' });
  assert.equal(res.deleted, 0);
  assert.equal(tb.listComments().length, 1, 'a merge with nothing to add and nothing to remove is a no-op');
});

test('importEnvelope: a JSON-STRING envelope carries its tombstones too', () => {
  // `parseEnvelope` accepts a string, which is how an integrator hands over what a fetch returned.
  // Reading `deleted` off the caller's original argument instead of the parsed envelope meant the
  // same envelope removed a comment as an object and silently removed nothing as text — the failure
  // being invisible in exactly the transport where a server's tombstones actually arrive.
  const build = () => {
    const tb = Tackback.mount({ document: { id: 'tombstones-str' }, storage: memoryAdapter() });
    const gone = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'deleted on the server' });
    return { tb, gone };
  };
  const envelope = (id) => ({ schemaVersion: 1, document: { id: 'tombstones-str' }, comments: [], deleted: [id] });

  const a = build();
  assert.equal(a.tb.importEnvelope(envelope(a.gone.id), { mode: 'merge' }).deleted, 1);
  const b = build();
  const asText = b.tb.importEnvelope(JSON.stringify(envelope(b.gone.id)), { mode: 'merge' });
  assert.equal(asText.deleted, 1, 'the same envelope, in the form it actually arrives in');
  assert.equal(b.tb.listComments().length, 0);
});

test('importEnvelope: a tombstoned comment is reported with the same payload as any other deletion', () => {
  // "the same seam as any other deletion" is only true if the payload is the same. `previous` is
  // what a listener needs to undo, or to tell WHICH comment left — an id alone does not say.
  const tb = Tackback.mount({ document: { id: 'tombstone-payload' }, storage: memoryAdapter() });
  const one = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'first' });
  const two = tb.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'second' });
  const singles = [], batches = [];
  tb.on('comment:delete', (e) => singles.push(e));
  tb.on('comments:delete', (e) => batches.push(e));
  tb.importEnvelope({ comments: [], deleted: [one.id, two.id] }, { mode: 'merge' });
  assert.deepEqual(singles.map((e) => e.id), [one.id, two.id]);
  assert.deepEqual(singles.map((e) => e.previous && e.previous.body), ['first', 'second'],
    'each event carries the comment that left, not null');
  assert.deepEqual(batches[0].ids, [one.id, two.id]);
  assert.deepEqual(batches[0].previous.map((c) => c.body), ['first', 'second'],
    'and ids[i] still describes previous[i]');
});

test('importEnvelope: a buried id cannot come back in through the front door, in either mode', () => {
  // Precedence belongs to the ENVELOPE, not to the mode the reader passes. A producer emits one
  // envelope; its meaning cannot depend on an option chosen at the other end. Scoping the rule to
  // merge left `replace` importing and KEEPING a comment the same envelope declared dead — and the
  // sentence that justified the scoping ("a tombstone can only say the same thing twice") was false
  // in exactly this cell, where it says the opposite thing.
  for (const mode of ['merge', 'replace']) {
    for (const onConflict of ['skip', 'replace', 'keepBoth']) {
      for (const held of [false, true]) {
        const tb = Tackback.mount({ document: { id: `precedence-${mode}-${onConflict}-${held}` }, storage: memoryAdapter() });
        if (held) tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'already here' });
        const id = held ? tb.listComments()[0].id : 'c-never-seen';
        const incoming = {
          id, anchor: { type: 'block', elementId: 'p1' }, body: 'listed and buried',
          createdAt: '2026-08-07T10:00:00.000Z', author: { id: 'u', kind: 'human' },
        };
        const changes = [], singles = [], batches = [];
        tb.on('change', (e) => changes.push(e.changes));
        tb.on('comment:delete', (e) => singles.push(e.id));
        tb.on('comments:delete', (e) => batches.push(e.ids));
        const res = tb.importEnvelope({ comments: [incoming], deleted: [id] }, { mode, onConflict });
        const where = `${mode}/${onConflict}/${held ? 'held' : 'new'}`;

        assert.deepEqual(tb.listComments(), [], `${where}: the store agrees with the envelope`);
        assert.equal(res.added, 0, `${where}: nothing was added`);
        assert.equal(res.updated, 0, `${where}: and nothing was updated into place either`);
        // A buried id must not reach conflict handling at all. Without these two, a regression that
        // let the incoming comment meet the held one before the tombstone removed it would satisfy
        // every other assertion here while quietly reporting a conflict that never happened.
        assert.equal(res.skipped, 0, `${where}: it never met the store, so nothing was skipped`);
        assert.equal(res.conflicts, 0, `${where}: and nothing collided`);
        assert.deepEqual(changes.flatMap((c) => c.added.map((x) => x.id)), [], `${where}: never added`);
        assert.deepEqual(changes.flatMap((c) => c.updated.map((x) => x.id)), [], `${where}: never updated`);
        // WHO removes it decides how it is reported, and the README promises exactly this split.
        if (!held) {
          assert.deepEqual(singles, [], `${where}: nobody is told about a comment they were never shown`);
          assert.deepEqual(batches, [], `${where}: and no act is announced either`);
          assert.equal(res.deleted, 0, `${where}: it was never there, so nothing was removed`);
        } else if (mode === 'merge') {
          // the tombstone does the removing, so it arrives on the ordinary deletion seam
          assert.deepEqual(singles, [id], `${where}: one per-comment event`);
          assert.deepEqual(batches, [[id]], `${where}: and one act`);
          assert.equal(res.deleted, 1, `${where}: counted by the tombstone that did it`);
          assert.deepEqual(changes.flatMap((c) => c.removed.map((x) => x.id)), [id], `${where}: removed once`);
        } else {
          // the wipe got there first, so there is no per-comment deletion to report
          assert.deepEqual(singles, [], `${where}: the wipe removed it, so no per-comment event`);
          assert.deepEqual(batches, [], `${where}: and no act event`);
          assert.equal(res.deleted, 0, `${where}: the tombstone found nothing left to take`);
          assert.deepEqual(changes.flatMap((c) => c.removed.map((x) => x.id)), [id], `${where}: only the aggregate reports it`);
        }
      }
    }
  }
});

test('importEnvelope: a replaced-away comment leaves no attention flag behind', () => {
  const tb = Tackback.mount({ document: { id: 'replace-attention' }, storage: memoryAdapter() });
  const c = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'flagged' });
  tb.setAnchorAttention(c.id, true);
  assert.equal(tb.hasAttention(c.id), true);
  tb.importEnvelope({ comments: [], deleted: [c.id] }, { mode: 'replace' });
  assert.equal(tb.listComments().length, 0, 'omitted from the incoming set, so gone');
  assert.equal(tb.hasAttention(c.id), false, 'and the flag goes with the comment it was about');
});

// A MERGE's `change` is a statement about before and after, so no id may appear in two halves of it:
// a merge that says one id was both added and removed has not described a net effect, it has
// narrated its own internal steps. This is the property, not one example of it.
//
// It is deliberately NOT asserted for `replace`, where the wipe-and-refill IS the representation:
// re-importing a comment that is already held legitimately reports it removed (by the wipe) and
// added (by the refill). Applying this check there would fail every ordinary replace.
//
// Asserted on collected payloads, never inside the handler: the emitter wraps every subscriber in a
// try/catch so one listener cannot break delivery to the others (src/core/events.js), which means an
// assertion that throws inside a handler is SWALLOWED and its test passes regardless.
const mergeDiffIsNet = (changes) => {
  for (const c of changes) {
    const ids = (k) => new Set(c[k].map((x) => x.id));
    const [added, updated, removed] = ['added', 'updated', 'removed'].map(ids);
    for (const [aName, a, bName, b] of [
      ['added', added, 'removed', removed],
      ['updated', updated, 'removed', removed],
      ['added', added, 'updated', updated],
    ]) {
      const both = [...a].filter((id) => b.has(id));
      assert.deepEqual(both, [], `no id may be reported ${aName} and ${bName} by one merge`);
    }
  }
};

test('importEnvelope: a tombstone WINS over an incoming comment with the same id', () => {
  // An envelope that both lists an id and buries it is saying the server no longer has it. Ingesting
  // first and burying afterwards made one envelope contradict itself out loud: the id arrived in
  // `added` and `removed` of the same `change`, the return said `added: 1` and `deleted: 1` at once,
  // and a `comment:delete` described a comment no listener had ever been shown.
  const tb = Tackback.mount({ document: { id: 'overlap-new' }, storage: memoryAdapter() });
  const incoming = {
    id: 'c-both', anchor: { type: 'block', elementId: 'p1' }, body: 'listed and buried',
    createdAt: '2026-08-07T10:00:00.000Z', author: { id: 'u', kind: 'human' },
  };
  const changes = [], singles = [], batches = [];
  tb.on('change', (e) => changes.push(e.changes));
  tb.on('comment:delete', (e) => singles.push(e.id));
  tb.on('comments:delete', (e) => batches.push(e.ids));
  const res = tb.importEnvelope({ comments: [incoming], deleted: ['c-both'] }, { mode: 'merge' });

  mergeDiffIsNet(changes);
  assert.equal(tb.listComments().length, 0, 'the store agrees with the envelope');
  assert.equal(res.added, 0, 'nothing was added, so the count must not say one was');
  assert.equal(res.deleted, 0, 'and nothing was removed either — it was never there');
  assert.deepEqual(singles, [], 'no deletion is announced for a comment nobody was shown');
  assert.deepEqual(batches, []);
  assert.deepEqual(changes.flatMap((d) => d.added.map((c) => c.id)), []);
});

test('importEnvelope: a tombstone still removes an id the store already held, once', () => {
  // the other half of the precedence rule: winning over the incoming copy must not stop it removing
  // the copy that is actually there.
  const tb = Tackback.mount({ document: { id: 'overlap-existing' }, storage: memoryAdapter() });
  const held = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'already here' });
  const kept = tb.addComment({ anchor: { type: 'block', elementId: 'p2' }, body: 'untouched' });
  const resent = { ...tb.exportEnvelope().comments.find((c) => c.id === held.id) };
  const changes = [], singles = [];
  tb.on('change', (e) => changes.push(e.changes));
  tb.on('comment:delete', (e) => singles.push(e.id));
  const res = tb.importEnvelope({ comments: [resent], deleted: [held.id] }, { mode: 'merge' });

  mergeDiffIsNet(changes);
  assert.deepEqual(tb.listComments().map((c) => c.id), [kept.id]);
  assert.equal(res.deleted, 1, 'it was there, and it went');
  assert.equal(res.added, 0, 'and it was never re-added on the way out');
  assert.deepEqual(singles, [held.id], 'announced once, not twice');
  assert.deepEqual(changes.flatMap((d) => d.removed.map((c) => c.id)), [held.id]);
});

test('deleteComments: the whole removal is settled before any per-comment event fires', () => {
  // What the changelog and README now state as the behavioural change, pinned. The panel used to
  // loop `deleteComment`, so a listener woke between removals and saw a half-deleted collection —
  // and the store was persisted once per comment. Now the act commits once and then narrates.
  const tb = Tackback.mount({ document: { id: 'batch-order' }, storage: memoryAdapter() });
  const a = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'one' });
  const b = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'two' });
  const order = [], seenCounts = [];
  tb.on('change', () => order.push('change'));
  tb.on('comment:delete', () => { order.push('comment:delete'); seenCounts.push(tb.listComments().length); });
  tb.on('comments:delete', () => order.push('comments:delete'));
  tb.deleteComments([a.id, b.id]);
  assert.deepEqual(order, ['change', 'comment:delete', 'comment:delete', 'comments:delete'],
    'one settlement, then one event per comment, then the act');
  assert.deepEqual(seenCounts, [0, 0],
    'every per-comment handler already sees the finished collection, not a half-deleted one');
});
