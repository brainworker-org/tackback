// node:test — actor rendering logic (panel/actors.js): who spoke last, and which color they get.
//
// The whole point of this module is that Tackback holds NO actor categories: it resolves colors
// through a map the integrator injects. These tests pin that — no assertion here names a category
// Tackback knows about; 'ai'/'human' appear only as caller-supplied strings, exactly as an
// integrator would pass them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_PALETTE, authorKey, authorColor, claimedColors, actorColorOf, lastSpeaker } from '../src/panel/actors.js';

const at = (n) => `2026-08-05T10:0${n}:00.000Z`;

// ---- lastSpeaker ----
test('lastSpeaker: the most recent utterance wins, comment or reply', () => {
  const comments = [
    { author: { id: 'a', kind: 'human' }, createdAt: at(1), replies: [{ author: { id: 'b', kind: 'ai' }, createdAt: at(4) }] },
    { author: { id: 'c', kind: 'human' }, createdAt: at(2), replies: [] },
  ];
  assert.deepEqual(lastSpeaker(comments), { id: 'b', kind: 'ai' }, 'a reply can be the last speaker');
  // drop the late reply → the latest COMMENT wins
  const noReply = comments.map((c) => ({ ...c, replies: [] }));
  assert.deepEqual(lastSpeaker(noReply), { id: 'c', kind: 'human' });
});

test('lastSpeaker: order-independent (unsorted input), empty/absent input → null', () => {
  const unsorted = [
    { author: 'late', createdAt: at(9), replies: [] },
    { author: 'early', createdAt: at(1), replies: [] },
  ];
  assert.equal(lastSpeaker(unsorted), 'late', 'not "the last element" — the latest timestamp');
  assert.equal(lastSpeaker([]), null);
  assert.equal(lastSpeaker(undefined), null);
});

test('lastSpeaker: a comment with no timestamps still yields an author (never throws)', () => {
  assert.equal(lastSpeaker([{ author: 'x' }]), 'x');
});

// ---- authorKey / authorColor ----
test('authorKey: id wins over category; a string author is its own key; anonymous → empty', () => {
  assert.equal(authorKey({ id: 'kei', kind: 'human' }), 'kei');
  assert.equal(authorKey({ kind: 'human' }), 'human', 'no id → the category is the visible identity');
  assert.equal(authorKey('kei'), 'kei');
  assert.equal(authorKey(null), '');
  assert.equal(authorKey({}), '');
});

test('authorColor: deterministic per identity, no tint for an anonymous author', () => {
  assert.equal(authorColor({ id: 'kei' }), authorColor({ id: 'kei' }), 'same identity → same hue');
  assert.equal(authorColor(null), '', 'anonymous keeps the default pin color');
  assert.ok(AUTHOR_PALETTE.includes(authorColor('someone')));
});

// ---- the disjointness invariant ----
test('claimedColors: collects the injected map values, normalized', () => {
  const claimed = claimedColors({ ai: '#2563EB', human: ' #db2777 ' });
  assert.ok(claimed.has('#2563eb') && claimed.has('#db2777'), 'case and padding normalized');
  assert.equal(claimedColors(null).size, 0);
});

test('an UNMAPPED author is never painted a color the injected map claimed', () => {
  // both of these are in the default palette — an injected map using them must push the fallback off
  const map = { ai: '#2563eb', human: '#db2777' };
  const claimed = claimedColors(map);
  for (const id of ['a', 'b', 'c', 'kei', 'reviewer', 'zz', 'someone-else', '編集者']) {
    const col = actorColorOf({ id, kind: 'other' }, map, claimed);   // 'other' is not in the map
    assert.ok(!claimed.has(col.toLowerCase()), `unmapped author "${id}" got a claimed color (${col})`);
  }
});

test('a mapped category takes the injected color; the map is consulted by kind, not identity', () => {
  const map = { ai: '#2563eb', human: '#db2777' };
  assert.equal(actorColorOf({ id: 'assistant-1', kind: 'ai' }, map), '#2563eb');
  assert.equal(actorColorOf({ id: 'assistant-2', kind: 'ai' }, map), '#2563eb', 'category, not identity');
  assert.equal(actorColorOf({ id: 'kei', kind: 'human' }, map), '#db2777');
});

test('no injected map → the generic per-identity hue; a string author is never category-mapped', () => {
  assert.ok(AUTHOR_PALETTE.includes(actorColorOf({ id: 'kei', kind: 'human' }, null)));
  assert.ok(AUTHOR_PALETTE.includes(actorColorOf('human', { human: '#db2777' })),
    'a plain string author has no `kind` — it cannot claim a category color');
});

test('a map claiming the whole palette still tints (falls back rather than going invisible)', () => {
  const map = Object.fromEntries(AUTHOR_PALETTE.map((c, i) => [`k${i}`, c]));
  const col = actorColorOf({ id: 'kei', kind: 'unmapped' }, map);
  assert.ok(AUTHOR_PALETTE.includes(col), 'degrades to a duplicate color, never to no color');
});
