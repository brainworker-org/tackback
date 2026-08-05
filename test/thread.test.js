// node:test — thread logic (panel/thread.js): what one conversation IS, what it contains, and how a
// conversation already on screen takes in what arrives while it is open.
//
// These are the decisions that fail quietly — a row drawn into the wrong thread, or a row silently
// never drawn because two of them claimed the same key — so each failure mode gets a case here
// rather than a "looked right in the browser".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadKeyOf, timelineItems, utteranceCount, planInsertions } from '../src/panel/thread.js';

const at = (n) => `2026-08-05T10:0${n}:00.000Z`;
const block = (id) => ({ type: 'block', elementId: id });
const region = (x) => ({ type: 'region', surfaceId: 'document', rect: { x, y: 0, width: .2, height: .2 } });

// ---- threadKeyOf: what counts as ONE conversation ----
test('threadKeyOf: block and range threads are identified by the place they point at', () => {
  assert.equal(threadKeyOf({ id: 'a', anchor: block('p1') }), threadKeyOf({ id: 'b', anchor: block('p1') }),
    'two comments on the same block are one thread');
  assert.notEqual(threadKeyOf({ id: 'a', anchor: block('p1') }), threadKeyOf({ id: 'b', anchor: block('p2') }));
  const range = (exact, start) => ({ type: 'range', elementId: 'p1', selector: { exact, start } });
  assert.equal(threadKeyOf({ id: 'a', anchor: range('the phrase', 4) }), threadKeyOf({ id: 'b', anchor: range('the phrase', 4) }));
  assert.notEqual(threadKeyOf({ id: 'a', anchor: range('the phrase', 4) }), threadKeyOf({ id: 'b', anchor: range('the phrase', 9) }),
    'the same words at a different offset are a different place');
});

test('threadKeyOf: region threads are identified by their root comment, NOT their geometry', () => {
  // two regions drawn over the SAME rectangle are two conversations — geometry cannot tell them apart
  const r1 = { id: 'r1', anchor: region(0.1) };
  const r2 = { id: 'r2', anchor: region(0.1) };
  assert.notEqual(threadKeyOf(r1), threadKeyOf(r2), 'identical rectangles must not merge two threads');
  // a reply-carrying comment in the same thread shares the root's id
  assert.equal(threadKeyOf({ id: 'r1b', threadId: 'r1', anchor: region(0.1) }), threadKeyOf(r1));
  // …and the identity survives the region being MOVED (its rect changes, the thread does not)
  assert.equal(threadKeyOf({ id: 'r1', anchor: region(0.77) }), threadKeyOf(r1));
});

test('threadKeyOf: an uncommitted region has no identity yet; a missing anchor is null', () => {
  assert.equal(threadKeyOf({ anchor: region(0.1) }), null, 'no id yet → nothing to group by');
  assert.equal(threadKeyOf(null), null);
  assert.equal(threadKeyOf({}), null);
});

// ---- timelineItems: contents, in order, with keys that never collide ----
test('timelineItems: comments and replies interleave in one chronological list', () => {
  const thread = [
    { id: 'a', createdAt: at(1), replies: [{ id: 'a1', createdAt: at(5) }] },
    { id: 'b', createdAt: at(3), replies: [] },
  ];
  assert.deepEqual(timelineItems(thread).map((i) => i.kind), ['comment', 'comment', 'reply'],
    'a late reply sorts after a later comment — one timeline, not per-comment groups');
  assert.deepEqual(timelineItems([]), []);
  assert.deepEqual(timelineItems(undefined), []);
});

test('timelineItems: replies with missing or repeated ids still each get a row', () => {
  // an imported envelope is written by someone else — it can carry replies with no id at all, or the
  // same id twice. A key collision would mean a row is silently never drawn.
  const thread = [{ id: 'a', createdAt: at(1), replies: [
    { createdAt: at(2), body: 'first' },
    { createdAt: at(3), body: 'second' },
    { id: 'dup', createdAt: at(4), body: 'third' },
    { id: 'dup', createdAt: at(5), body: 'fourth' },
  ] }];
  const items = timelineItems(thread);
  assert.equal(items.length, 5, 'one comment + four replies');
  assert.equal(new Set(items.map((i) => i.key)).size, 5, 'every row has a key of its own');
  assert.deepEqual(items.filter((i) => i.kind === 'reply').map((i) => i.rep.body), ['first', 'second', 'third', 'fourth']);
});

test('timelineItems: two anchor events in the SAME millisecond both get a row', () => {
  const events = [
    { type: 'move', ts: at(2) },
    { type: 'move', ts: at(2) },   // same timestamp, same type — recorded back to back
    { type: 'create', ts: at(2) }, // not part of the move/resize history
  ];
  const items = timelineItems([{ id: 'a', createdAt: at(1) }], events);
  assert.equal(items.filter((i) => i.kind === 'event').length, 2, 'neither move is swallowed');
  assert.equal(new Set(items.map((i) => i.key)).size, items.length);
});

// ---- utteranceCount: what an anchor badge shows ----
test('utteranceCount: every comment AND every reply counts', () => {
  const thread = [
    { createdAt: at(1), replies: [{ createdAt: at(2) }, { createdAt: at(3) }] },
    { createdAt: at(4), replies: [] },
  ];
  assert.equal(utteranceCount(thread), 4, '2 comments + 2 replies — a busy thread must not read as 2');
  assert.equal(utteranceCount([{ createdAt: at(1) }]), 1, 'a comment with no replies field counts as one');
  assert.equal(utteranceCount([]), 0);
  assert.equal(utteranceCount(null), 0);
});

test('utteranceCount: answers from another participant move the number', () => {
  const c = { createdAt: at(1), replies: [] };
  assert.equal(utteranceCount([c]), 1);
  const answered = { ...c, replies: [{ createdAt: at(2), author: { id: 'other', kind: 'ai' } }] };
  assert.equal(utteranceCount([answered]), 2, 'the reply is visible in the count, not hidden inside it');
});

// ---- planInsertions: how an OPEN thread takes in what arrives ----
test('planInsertions: an empty screen draws the whole timeline, in order, appended', () => {
  const items = timelineItems([{ id: 'a', createdAt: at(1), replies: [{ id: 'a1', createdAt: at(2) }] }]);
  const plan = planInsertions([], items);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.beforeKey), [null, null], 'nothing to insert before yet');
});

test('planInsertions: a newer utterance is appended; nothing already drawn is drawn again', () => {
  const drawn = [{ key: 'c:a', t: at(1) }, { key: 'r:a:0:a1', t: at(2) }];
  const items = timelineItems([{ id: 'a', createdAt: at(1), replies: [
    { id: 'a1', createdAt: at(2) }, { id: 'a2', createdAt: at(6) },
  ] }]);
  const plan = planInsertions(drawn, items);
  assert.equal(plan.length, 1, 'only the new answer is drawn');
  assert.equal(plan[0].item.rep.id, 'a2');
  assert.equal(plan[0].beforeKey, null, 'the newest utterance goes at the end');
  // running it again with everything drawn is a no-op — safe on every change
  assert.deepEqual(planInsertions([...drawn, { key: plan[0].item.key, t: plan[0].item.t }], items), []);
});

test('planInsertions: an OLDER utterance lands in its chronological place, not at the bottom', () => {
  // an import can deliver something older than what is on screen; appending it would break the
  // flat, time-ordered contract the Pane documents.
  const drawn = [{ key: 'c:a', t: at(1) }, { key: 'c:c', t: at(7) }];
  const items = [
    { key: 'c:a', t: at(1), kind: 'comment' },
    { key: 'c:b', t: at(4), kind: 'comment' },
    { key: 'c:c', t: at(7), kind: 'comment' },
  ];
  const plan = planInsertions(drawn, items);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].beforeKey, 'c:c', 'the older row is inserted before the later one already shown');
});

test('planInsertions: several out-of-order arrivals stay ordered among themselves', () => {
  const drawn = [{ key: 'c:a', t: at(1) }, { key: 'c:z', t: at(9) }];
  const items = [
    { key: 'c:a', t: at(1) }, { key: 'c:m', t: at(5) }, { key: 'c:k', t: at(3) }, { key: 'c:z', t: at(9) },
  ];
  const plan = planInsertions(drawn, items);
  assert.deepEqual(plan.map((p) => [p.item.key, p.beforeKey]), [['c:m', 'c:z'], ['c:k', 'c:m']],
    'the second arrival is placed relative to the first, not to the original screen');
});
