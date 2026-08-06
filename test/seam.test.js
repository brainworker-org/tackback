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

// ---- the seams an integrator needs to know a thread was read, and that something was deleted -----

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
  assert.deepEqual(singles, [a.id, b.id], 'each comment still reports itself — existing listeners are unaffected');
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
