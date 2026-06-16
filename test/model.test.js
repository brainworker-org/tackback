// node:test — comment model: factory, validation, legacy migration (v1 → v2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComment, createReply, isValidAnchor, migrateLegacyComment, isLegacyComment } from '../src/core/model.js';

const NOW = '2026-06-13T00:00:00.000Z';

test('createComment: library owns id + createdAt; caller supplies data only', () => {
  const c = createComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'hi', reaction: 'agree' }, NOW);
  assert.match(c.id, /[0-9a-f-]{8,}/);     // opaque id minted
  assert.equal(c.createdAt, NOW);
  assert.equal(c.body, 'hi');
  assert.equal(c.reaction, 'agree');
  assert.equal('ts' in c, false);          // no timestamp-as-identity
});

test('createComment: distinct ids for same-instant calls (no collision)', () => {
  const mk = () => createComment({ anchor: { type: 'block', elementId: 'p' }, body: 'x' }, NOW);
  assert.notEqual(mk().id, mk().id);
});

test('isValidAnchor: accepts the three kinds, rejects junk', () => {
  assert.ok(isValidAnchor({ type: 'block', elementId: 'e' }));
  assert.ok(isValidAnchor({ type: 'range', elementId: 'e', selector: { exact: 'x' } }));
  assert.ok(isValidAnchor({ type: 'region', surfaceId: 's', rect: { x: 0, y: 0, width: 0.5, height: 0.2 } }));
  assert.equal(isValidAnchor({ elementId: 'e' }), false);          // missing discriminator
  assert.equal(isValidAnchor({ type: 'mystery' }), false);
  assert.equal(isValidAnchor({ type: 'region', surfaceId: 's', rect: { x: 0 } }), false);
});

test('migrateLegacyComment: block (kind omitted) → v2', () => {
  const v2 = migrateLegacyComment({ ts: 't1', elementId: 'cogfb-el-2', section: 'S', snippet: 'q', emoji: '👍', comment: 'a', author: 'K' });
  assert.equal(v2.id, 't1');
  assert.equal(v2.createdAt, 't1');
  assert.deepEqual(v2.anchor, { type: 'block', elementId: 'cogfb-el-2' });
  assert.equal(v2.body, 'a');
  assert.equal(v2.reaction, '👍');           // legacy emoji char preserved (resolves literally)
  assert.deepEqual(v2.snapshot, { section: 'S', quote: 'q' });
});

test('migrateLegacyComment: region → v2 rect + threadId', () => {
  const v2 = migrateLegacyComment({ ts: 't2', kind: 'region', page: 1, regionId: 'r-9', rect: { nx: 0.2, ny: 0.1, nw: 0.5, nh: 0.08 }, comment: 'b' });
  assert.equal(v2.anchor.type, 'region');
  assert.deepEqual(v2.anchor.rect, { x: 0.2, y: 0.1, width: 0.5, height: 0.08 });
  assert.equal(v2.threadId, 'r-9');
});

test('isLegacyComment: discriminates by ts-without-id', () => {
  assert.equal(isLegacyComment({ ts: 't', comment: 'x' }), true);
  assert.equal(isLegacyComment({ id: 'i', ts: 't' }), false);   // already v2
  assert.equal(isLegacyComment({ id: 'i' }), false);
});

// --- v0.7 additive schema: replies, author provenance, region history/capture/fallback ---

test('createReply: library owns id + createdAt; appends body + optional author', () => {
  const r = createReply({ body: 'a reply', author: { id: 'code', kind: 'ai' } }, NOW);
  assert.match(r.id, /[0-9a-f-]{8,}/);
  assert.equal(r.createdAt, NOW);
  assert.equal(r.body, 'a reply');
  assert.deepEqual(r.author, { id: 'code', kind: 'ai' });
});

test('createComment: author may be a provenance object {id,kind} (REQ-301)', () => {
  const c = createComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'x', author: { id: 'keisuke', kind: 'human' } }, NOW);
  assert.deepEqual(c.author, { id: 'keisuke', kind: 'human' });
});

test('createComment: string author still works (back-compat)', () => {
  const c = createComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'x', author: 'me' }, NOW);
  assert.equal(c.author, 'me');
});

test('createComment: initial replies are carried (copied, not aliased)', () => {
  const replies = [createReply({ body: 'r1' }, NOW)];
  const c = createComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'x', replies }, NOW);
  assert.equal(c.replies.length, 1);
  replies.push(createReply({ body: 'r2' }, NOW));
  assert.equal(c.replies.length, 1);   // snapshot copy — later mutation of input does not leak in
});

test('createComment: no replies field when none supplied', () => {
  const c = createComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'x' }, NOW);
  assert.equal('replies' in c, false);
});

test('isValidAnchor: region with optional fallback/events/capture still valid (additive)', () => {
  const region = {
    type: 'region', surfaceId: 'document',
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
    fallback: { elementId: 'p3', dx: 4, dy: 8 },
    events: [{ ts: NOW, type: 'create', after: { rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 } } }],
    capture: { covered: [{ in: 'p3', text: 'hello' }], media: ['img:fig1'] },
  };
  assert.equal(isValidAnchor(region), true);
});

test('isValidAnchor: region rect bounds still enforced with optional fields present', () => {
  const bad = { type: 'region', surfaceId: 'document', rect: { x: 0.9, y: 0, width: 0.5, height: 0.1 }, fallback: { elementId: 'p', dx: 0, dy: 0 } };
  assert.equal(isValidAnchor(bad), false);   // x+width > 1 — additive fields don't bypass validation
});
