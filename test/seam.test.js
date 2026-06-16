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
