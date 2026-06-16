// node:test — the public engine API, exercised headlessly with the in-memory storage adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tackback } from '../src/core/engine.js';
import { TackbackError } from '../src/core/errors.js';
import { memoryAdapter } from '../src/core/storage.js';

const mountFresh = (over = {}) =>
  Tackback.mount({ document: { id: 'doc-1', title: 'Doc' }, storage: memoryAdapter(), ...over });

const blockInput = (body = 'hi') => ({ anchor: { type: 'block', elementId: 'p1' }, body });

test('mount → addComment mints id/createdAt; listComments reflects it', () => {
  const tb = mountFresh();
  const c = tb.addComment(blockInput('first'));
  assert.ok(c.id && c.createdAt);
  assert.equal(tb.listComments().length, 1);
  assert.equal(tb.getComment(c.id).body, 'first');
});

test('change event carries a diff payload + source', () => {
  const tb = mountFresh();
  const events = [];
  tb.on('change', (e) => events.push(e));
  const c = tb.addComment(blockInput());
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'local');
  assert.equal(events[0].changes.added[0].id, c.id);
  assert.equal(events[0].comments.length, 1);
});

test('granular events: add / update / delete with previous', () => {
  const tb = mountFresh();
  const log = [];
  tb.on('comment:add', (c) => log.push(['add', c.id]));
  tb.on('comment:update', ({ comment, previous }) => log.push(['update', comment.body, previous.body]));
  tb.on('comment:delete', ({ id, previous }) => log.push(['delete', id, previous.body]));
  const c = tb.addComment(blockInput('v1'));
  tb.updateComment(c.id, { body: 'v2' });
  tb.deleteComment(c.id);
  assert.deepEqual(log, [['add', c.id], ['update', 'v2', 'v1'], ['delete', c.id, 'v2']]);
});

test('addComment rejects an invalid anchor', () => {
  const tb = mountFresh();
  assert.throws(() => tb.addComment({ anchor: { elementId: 'x' }, body: 'b' }),
    (e) => e instanceof TackbackError && e.code === 'INVALID_ANCHOR');
});

test('update/delete unknown id → COMMENT_NOT_FOUND', () => {
  const tb = mountFresh();
  assert.throws(() => tb.updateComment('nope', { body: 'x' }), (e) => e.code === 'COMMENT_NOT_FOUND');
  assert.throws(() => tb.deleteComment('nope'), (e) => e.code === 'COMMENT_NOT_FOUND');
});

test('readOnly: every mutation throws READ_ONLY (no silent no-op)', () => {
  const tb = mountFresh({ readOnly: true });
  assert.throws(() => tb.addComment(blockInput()), (e) => e.code === 'READ_ONLY');
  assert.throws(() => tb.importEnvelope({ comments: [] }), (e) => e.code === 'READ_ONLY');
});

test('exportEnvelope → importEnvelope round-trip (merge) preserves ids', () => {
  const a = mountFresh();
  const c = a.addComment(blockInput('keep'));
  const env = a.exportEnvelope();
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.document.id, 'doc-1');
  const b = mountFresh();
  const result = b.importEnvelope(env, { mode: 'replace' });
  assert.equal(result.added, 1);
  assert.equal(b.getComment(c.id).body, 'keep');
});

test('importEnvelope migrates a LEGACY v1 export (ts/flat/emoji)', () => {
  const legacy = { doc: 'Old Doc', exported_at: 't', source_sha256: 'abc', source_md: 'old.md', count: 1,
    comments: [{ ts: 'leg-1', kind: 'region', page: 1, regionId: 'r1', rect: { nx: 0.2, ny: 0.1, nw: 0.5, nh: 0.08 }, emoji: '⚠️', comment: 'legacy note' }] };
  const tb = mountFresh();
  const result = tb.importEnvelope(legacy, { mode: 'replace' });
  assert.equal(result.added, 1);
  const c = tb.getComment('leg-1');
  assert.equal(c.body, 'legacy note');
  assert.equal(c.anchor.type, 'region');
  assert.deepEqual(c.anchor.rect, { x: 0.2, y: 0.1, width: 0.5, height: 0.08 });
  assert.equal(c.reaction, '⚠️');
});

test('destroy: subsequent mutation throws, no events delivered', () => {
  const tb = mountFresh();
  let changes = 0;
  tb.on('change', () => changes++);
  tb.destroy();
  assert.throws(() => tb.addComment(blockInput()));
  assert.equal(changes, 0);
});
