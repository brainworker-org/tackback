// node:test — phase 6 replay model: merge N exported envelopes (multi-author) into one
// timeline-ordered, author-attributed set (REQ-505), never dropping a comment (REQ-004). Mirrors the
// proven tackback_replay.py merge/author-resolution; anchor re-resolution + orphan isolation are a
// render concern (covered by resolution.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReplayModel } from '../src/core/replay.js';

const block = (el) => ({ type: 'block', elementId: el });
const cmt = (id, body, createdAt, extra = {}) => ({ id, anchor: block('p1'), body, createdAt, ...extra });

// ---- multi-author merge + timeline ordering --------------------------------------------------

test('merges two envelopes from two authors, tags each comment, lists distinct authors', () => {
  const kj = { exportedBy: { id: 'kj', kind: 'human' }, document: { id: 'd' }, comments: [cmt('a', 'kj note', '2026-06-15T02:00:00Z')] };
  const code = { exportedBy: { id: 'code', kind: 'ai' }, document: { id: 'd' }, comments: [cmt('b', 'code note', '2026-06-15T01:00:00Z')] };
  const m = buildReplayModel([{ envelope: kj }, { envelope: code }]);
  assert.equal(m.comments.length, 2);
  // timeline order: code (01:00) before kj (02:00), regardless of source order
  assert.deepEqual(m.comments.map((c) => c.id), ['b', 'a']);
  assert.deepEqual(m.comments.map((c) => c.author.id), ['code', 'kj']);
  assert.deepEqual(m.authors.map((a) => a.id), ['code', 'kj'], 'distinct authors, first-seen (timeline) order');
});

test('author resolution precedence: override > comment.author > exportedBy > fallback label', () => {
  const env = {
    exportedBy: 'envelope-author',
    comments: [
      cmt('own', 'has own author', 't1', { author: { id: 'own-author' } }),
      cmt('inherit', 'no own author', 't2'),
    ],
  };
  // override wins for the whole source
  const overridden = buildReplayModel([{ envelope: env, author: 'OVERRIDE' }]);
  assert.deepEqual(overridden.comments.map((c) => c.author), ['OVERRIDE', 'OVERRIDE']);
  // no override: comment.author wins where present, else exportedBy
  const natural = buildReplayModel([{ envelope: env }]);
  assert.equal(natural.comments.find((c) => c.id === 'own').author.id, 'own-author');
  assert.equal(natural.comments.find((c) => c.id === 'inherit').author, 'envelope-author');
  // no exportedBy either: fallback label
  const bare = buildReplayModel([{ envelope: { comments: [cmt('x', 'b', 't')] }, label: 'Reviewer X' }]);
  assert.equal(bare.comments[0].author, 'Reviewer X');
  // no label given → default "reviewer N"
  const dflt = buildReplayModel([{ envelope: { comments: [cmt('y', 'b', 't')] } }]);
  assert.equal(dflt.comments[0].author, 'reviewer 1');
});

// ---- revision mismatch (per source) ----------------------------------------------------------

test('flags per-source revision mismatch against the reference revision; matching/legacy skip', () => {
  const sources = [
    { envelope: { document: { id: 'd', revisionHash: 'OLD' }, comments: [cmt('a', '1', 't')] }, label: 'old-rev' },
    { envelope: { document: { id: 'd', revisionHash: 'CUR' }, comments: [cmt('b', '2', 't')] }, label: 'cur-rev' },
    { envelope: { document: { id: 'd' }, comments: [cmt('c', '3', 't')] }, label: 'legacy-no-rev' },
  ];
  const m = buildReplayModel(sources, { referenceRevision: 'CUR' });
  assert.equal(m.revMismatches.length, 1);
  assert.deepEqual(m.revMismatches[0], { source: 'old-rev', expected: 'CUR', actual: 'OLD' });
  assert.equal(m.comments.length, 3, 'all comments kept regardless of mismatch (never refused)');
});

// ---- never drops; migrates legacy + bare arrays ----------------------------------------------

test('keeps a comment whose anchor will not resolve (orphan is a render concern, not a merge drop)', () => {
  const env = { comments: [cmt('gone', 'points at a deleted element', 't', { anchor: block('deleted-el') })] };
  const m = buildReplayModel([{ envelope: env, label: 'r' }]);
  assert.equal(m.comments.length, 1, 'present in the model — the renderer orphans it, merge never drops');
  assert.equal(m.comments[0].anchor.elementId, 'deleted-el');
});

test('accepts a bare comment array and migrates legacy v1 records (via parseEnvelope)', () => {
  // bare array of v2 comments
  const bare = [cmt('a', 'x', 't')];
  assert.equal(buildReplayModel([{ envelope: bare, label: 'r' }]).comments.length, 1);
  // legacy v1 flat record (ts identity, no v2 id) → migrated, author = label
  const legacy = { comments: [{ ts: '2026-01-01T00:00:00Z', elementId: 'p1', comment: 'old note' }] };
  const m = buildReplayModel([{ envelope: legacy, label: 'Legacy Reviewer' }]);
  assert.equal(m.comments.length, 1);
  assert.equal(m.comments[0].body, 'old note');
  assert.equal(m.comments[0].author, 'Legacy Reviewer');
});

test('empty / missing sources → empty model', () => {
  assert.deepEqual(buildReplayModel([]), { comments: [], authors: [], revMismatches: [] });
  assert.deepEqual(buildReplayModel(), { comments: [], authors: [], revMismatches: [] });
});
