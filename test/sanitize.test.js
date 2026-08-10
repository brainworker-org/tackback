// node:test — the one entry validation, and the one definition of a thread.
//
// Whitebox (test plan W8 / W11): these import the core modules directly and check the SHAPE of the
// rules, not the product behaviour. The product behaviour that rides on them — what an import or a
// reload does with a bad entry — is fixed by the blackbox cases, which is the right place for it.
//
// Why the shape needs its own tests: this function is called from two boundaries that look nothing
// alike, and the whole reason it exists is that they must not answer differently. A test that only
// went in through one of them could not see the two drifting apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { threadKeyOf, sanitizeComments } from '../src/core/model.js';
import { threadKeyOf as panelThreadKeyOf } from '../src/panel/thread.js';

const at = (elementId) => ({ type: 'block', elementId });
const root = (id, elementId = 'p1', over = {}) => ({
  id, anchor: at(elementId), body: id, createdAt: '2026-08-10T00:00:00.000Z', ...over,
});
const reply = (id, over = {}) => ({ id, body: id, createdAt: '2026-08-10T00:00:00.000Z', ...over });
const ids = (r) => r.comments.flatMap((c) => [c.id, ...(c.replies || []).map((x) => x.id)]);

// ---- W8: one definition of a thread -------------------------------------------------------------

test('threadKeyOf: the panel and the core share the function, not merely the answer', () => {
  // Identity, not equality of results. Two copies that agree today are what drift looks like on the
  // day before it starts, and the failure it produces — a mark that will not clear because the two
  // halves of the library disagree about what the reader opened — names neither copy.
  assert.equal(panelThreadKeyOf, threadKeyOf, 'the panel re-exports the core definition');
});

test('threadKeyOf: each anchor kind names its thread, and an unknown kind names none', () => {
  assert.equal(threadKeyOf({ anchor: { type: 'document' } }), 'document');
  assert.equal(threadKeyOf({ anchor: at('p1') }), 'block:p1');
  assert.equal(
    threadKeyOf({ anchor: { type: 'range', elementId: 'p', selector: { exact: 'q', start: 3 } } }),
    'range:p\u0000q\u00003');
  assert.equal(threadKeyOf({ id: 'c1', anchor: { type: 'region', surfaceId: 'document', rect: {} } }), 'region:c1');
  assert.equal(threadKeyOf({ id: 'r2', threadId: 'c1', anchor: { type: 'region', surfaceId: 'document', rect: {} } }), 'region:c1');
  assert.equal(threadKeyOf({ anchor: { type: 'workspace' } }), null, 'a kind this build does not know borrows nobody else\'s thread');
  assert.equal(threadKeyOf(null), null);
});

// ---- W11: the entry validation ------------------------------------------------------------------

test('sanitize: what arrives intact comes back as the very value that arrived', () => {
  const a = root('c1'), b = root('c2', 'p2', { replies: [reply('r1')] });
  const r = sanitizeComments([a, b]);
  assert.deepEqual(r.faults, []);
  assert.equal(r.dropped, 0);
  assert.equal(r.comments[0], a, 'untouched entries are not rebuilt');
  assert.equal(r.comments[1], b);
});

test('sanitize: an utterance with no usable id is dropped, and its replies go with it', () => {
  const r = sanitizeComments([root(''), root('c2', 'p1', { replies: [reply('r1'), reply('r2')] })]);
  assert.deepEqual(ids(r), ['c2', 'r1', 'r2']);
  assert.equal(r.dropped, 1);
  assert.equal(r.faults.length, 1);

  // The collateral is counted but not blamed: one fault happened, and reporting it three times would
  // tell a reader there were three things wrong with the envelope.
  const withReplies = sanitizeComments([root(null, 'p1', { replies: [reply('r1'), reply('r2')] })]);
  assert.deepEqual(withReplies.comments, []);
  assert.equal(withReplies.dropped, 3, 'the root and both replies are gone');
  assert.equal(withReplies.faults.length, 1, 'but only the root was at fault');
});

test('sanitize: a bad reply loses only itself — its root and its siblings survive', () => {
  const r = sanitizeComments([root('c1', 'p1', { replies: [reply('r1'), reply(''), reply('r3')] })]);
  assert.deepEqual(ids(r), ['c1', 'r1', 'r3']);
  assert.equal(r.dropped, 1);
  assert.equal(r.faults.length, 1);
});

test('sanitize: the first arrival of an id wins, and a rejected entry does not consume it', () => {
  // First-wins is only meaningful if "first" means first ACCEPTED. An entry that was thrown out never
  // entered the document, so it cannot be the reason a later, valid one is called a duplicate.
  const kept = sanitizeComments([root('c1', 'p1', { body: 'first' }), root('c1', 'p2', { body: 'second' })]);
  assert.deepEqual(ids(kept), ['c1']);
  assert.equal(kept.comments[0].body, 'first');
  assert.equal(kept.faults.length, 1);

  const afterReject = sanitizeComments(
    [root('c1', 'p1', { anchor: { type: 'workspace' } }), root('c1', 'p2', { body: 'the valid one' })],
    { checkAnchor: true });
  assert.deepEqual(ids(afterReject), ['c1'], 'the valid entry still gets in');
  assert.equal(afterReject.comments[0].body, 'the valid one');
});

test('sanitize: a reply cannot take an id a root in the same batch already has', () => {
  const r = sanitizeComments([root('c1'), root('c2', 'p2', { replies: [reply('c1')] })]);
  assert.deepEqual(ids(r), ['c1', 'c2'], 'the collision is dropped, both roots survive');
  assert.equal(r.faults.length, 1);
});

test('sanitize: the scan runs root, its replies, then the next root', () => {
  // The order is the same one arrival numbers are handed out in, so "first wins" means the same thing
  // to both. A scan that took all the roots first would keep the reply here and drop the root.
  const r = sanitizeComments([root('c1', 'p1', { replies: [reply('x') ] }), root('x', 'p2')]);
  assert.deepEqual(ids(r), ['c1', 'x'], 'the reply reached x first');
  assert.equal(r.comments.length, 1, 'so the later root with the same id is the one that goes');
});

test('sanitize: an anchor is required only where anchors are checked', () => {
  const entries = [root('c1', 'p1', { anchor: { type: 'workspace' } })];
  assert.deepEqual(ids(sanitizeComments(entries)), ['c1'],
    'restoring keeps a kind this build does not know — it is a downgrade artefact, not corruption');
  assert.deepEqual(ids(sanitizeComments(entries, { checkAnchor: true })), [],
    'an envelope may not introduce one');
});

test('sanitize: an utterance may not move to another thread, and may be redelivered where it is', () => {
  const known = new Map([['c1', { threadKey: 'block:p1', reply: false }]]);
  const moved = sanitizeComments([root('c1', 'p2')], { known });
  assert.deepEqual(moved.comments, [], 'the same id at another anchor is refused');
  assert.equal(moved.faults.length, 1);

  const again = sanitizeComments([root('c1', 'p1', { body: 'edited' })], { known });
  assert.deepEqual(ids(again), ['c1'], 'the same id where it already is, is just the same utterance again');
  assert.deepEqual(again.faults, []);
});

test('sanitize: an id that already belongs to something else cannot be reused', () => {
  const known = new Map([['c1', { threadKey: 'block:p1', reply: false }]]);
  const asReply = sanitizeComments([root('c2', 'p2', { replies: [reply('c1')] })], { known });
  assert.deepEqual(ids(asReply), ['c2'], 'a root\'s id cannot arrive as somebody\'s reply');
  assert.equal(asReply.faults.length, 1);

  const replyKnown = new Map([['r1', { threadKey: 'block:p1', reply: true }]]);
  const asRoot = sanitizeComments([root('r1', 'p1')], { known: replyKnown });
  assert.deepEqual(asRoot.comments, [], 'nor a reply\'s id as a root');
  assert.equal(asRoot.faults.length, 1);
});

test('sanitize: an entry buried by the same envelope that carries it is refused', () => {
  // Deleting a row and re-inserting the same identity elsewhere is not how an utterance moves. An
  // envelope that says one id is both dead and alive is contradicting itself, and the tombstone is
  // the fresher fact.
  const doomed = new Set(['c1']);
  const r = sanitizeComments([root('c1', 'p2'), root('c9', 'p2')], { doomed });
  assert.deepEqual(ids(r), ['c9'], 'the live entry goes; a genuinely new id at the new place does not');
  assert.equal(r.faults.length, 1);

  const sameAnchor = sanitizeComments([root('c1', 'p1')], { doomed });
  assert.deepEqual(sameAnchor.comments, [], 'the anchor being unchanged does not make it less contradictory');

  const buriedReply = sanitizeComments([root('c2', 'p1', { replies: [reply('r1')] })], { doomed: new Set(['r1']) });
  assert.deepEqual(ids(buriedReply), ['c2']);
  assert.equal(buriedReply.faults.length, 1);
});

test('sanitize: what is not a list, and what is not an utterance', () => {
  assert.deepEqual(sanitizeComments(null).comments, []);
  assert.deepEqual(sanitizeComments(undefined).comments, []);
  const r = sanitizeComments([null, 'nope', 42, root('c1')]);
  assert.deepEqual(ids(r), ['c1']);
  assert.equal(r.dropped, 3);
  assert.equal(r.faults.length, 3);
});
