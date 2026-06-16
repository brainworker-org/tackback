// node:test — CommentStore: state, diffs, persistence, ingest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommentStore } from '../src/core/store.js';
import { memoryAdapter } from '../src/core/storage.js';

const c = (id, body = '') => ({ id, anchor: { type: 'block', elementId: 'e' }, body, createdAt: 't' });

test('add/delete produce single-item diffs and persist', async () => {
  const adapter = memoryAdapter();
  const s = new CommentStore(adapter, 'doc1');
  await s.beginLoad();
  const dAdd = s.add(c('a', 'hi'));
  assert.equal(dAdd.added.length, 1);
  await s.persist();
  assert.equal(adapter.load().comments.length, 1);
  const dDel = s.delete('a');
  assert.equal(dDel.diff.removed[0].id, 'a');
  assert.equal(dDel.previous.body, 'hi');
});

test('update preserves id/createdAt, stamps updatedAt, returns previous', () => {
  const s = new CommentStore(memoryAdapter(), 'doc1');
  s.add(c('a', 'old'));
  const { previous, next } = s.update('a', { body: 'new' }, 'T2');
  assert.equal(previous.body, 'old');
  assert.equal(next.body, 'new');
  assert.equal(next.id, 'a');
  assert.equal(next.createdAt, 't');
  assert.equal(next.updatedAt, 'T2');
});

test('list returns a frozen snapshot (no internal handle leak)', () => {
  const s = new CommentStore(memoryAdapter(), 'doc1');
  s.add(c('a'));
  const snap = s.list();
  assert.ok(Object.isFrozen(snap));
  assert.throws(() => { snap.push(c('z')); });   // frozen array
});

test('beginLoad applies a sync adapter seed immediately', () => {
  const seed = { schemaVersion: 1, documentId: 'doc1', comments: [c('seed1')] };
  const s = new CommentStore(memoryAdapter(seed), 'doc1');
  const p = s.beginLoad();             // sync adapter → applied before await
  assert.equal(s.has('seed1'), true);
  assert.ok(p instanceof Promise);
});

test('ingest replace clears then adds; reports diff', () => {
  const s = new CommentStore(memoryAdapter(), 'doc1');
  s.add(c('old'));
  const { diff, result } = s.ingest([c('new1'), c('new2')], 'replace', 'skip');
  assert.equal(diff.removed.length, 1);
  assert.equal(result.added, 2);
  assert.equal(s.has('old'), false);
});

test('ingest merge with skip-on-conflict', () => {
  const s = new CommentStore(memoryAdapter(), 'doc1');
  s.add(c('a', 'mine'));
  const { result } = s.ingest([c('a', 'theirs'), c('b')], 'merge', 'skip');
  assert.equal(result.skipped, 1);
  assert.equal(result.added, 1);
  assert.equal(s.get('a').body, 'mine');     // local kept
});

test('ingest merge with replace-on-conflict overwrites', () => {
  const s = new CommentStore(memoryAdapter(), 'doc1');
  s.add(c('a', 'mine'));
  const { result } = s.ingest([c('a', 'theirs')], 'merge', 'replace');
  assert.equal(result.updated, 1);
  assert.equal(s.get('a').body, 'theirs');
});
