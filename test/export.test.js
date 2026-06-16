// node:test — export envelope build + import parse/migration (the Interplay seam).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEnvelope, parseEnvelope } from '../src/core/export.js';
import { Tackback } from '../src/core/engine.js';
import { TackbackError } from '../src/core/errors.js';
import { memoryAdapter } from '../src/core/storage.js';

test('integrity: Tackback.version (→ export generator.version) matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Tackback.version, pkg.version);   // the export envelope stamps this — must not drift
});

const v2 = (id) => ({ id, anchor: { type: 'block', elementId: 'e' }, body: 'b', createdAt: 't' });

test('buildEnvelope: v2 shape with schemaVersion + generator + reaction legend', () => {
  const env = buildEnvelope({
    document: { id: 'd1', title: 'Doc' }, now: 'N', version: '0.1.0', exportedBy: 'K',
    reactions: [{ id: 'agree', icon: '👍', label: 'Agree' }], comments: [v2('a')],
  });
  assert.equal(env.schemaVersion, 1);
  assert.deepEqual(env.generator, { name: 'tackback', version: '0.1.0' });
  assert.equal(env.exportedAt, 'N');
  assert.equal(env.exportedBy, 'K');
  assert.equal(env.reactions[0].id, 'agree');
  assert.equal(env.comments.length, 1);
});

test('buildEnvelope: omits empty reaction legend', () => {
  const env = buildEnvelope({ document: { id: 'd' }, now: 'N', version: '0.1.0', comments: [] });
  assert.equal('reactions' in env, false);
});

test('parseEnvelope: v2 envelope passes through', () => {
  const { comments, document } = parseEnvelope({ schemaVersion: 1, document: { id: 'd' }, comments: [v2('a')] });
  assert.equal(comments[0].id, 'a');
  assert.equal(document.id, 'd');
});

test('parseEnvelope: bare comment array', () => {
  const { comments } = parseEnvelope([v2('a'), v2('b')]);
  assert.equal(comments.length, 2);
});

test('parseEnvelope: legacy v1 envelope → migrated comments + derived document', () => {
  const legacy = { doc: 'Old', source_sha256: 'abc', source_md: 'o.md',
    comments: [{ ts: 'L1', elementId: 'el', emoji: '👍', comment: 'x', section: 'S', snippet: 'q' }] };
  const { comments, document } = parseEnvelope(legacy);
  assert.equal(comments[0].id, 'L1');
  assert.equal(comments[0].anchor.type, 'block');
  assert.equal(comments[0].body, 'x');
  assert.equal(document.id, 'Old');
  assert.equal(document.revisionHash, 'abc');
});

test('parseEnvelope: JSON string input', () => {
  const { comments } = parseEnvelope(JSON.stringify({ comments: [v2('a')] }));
  assert.equal(comments[0].id, 'a');
});

test('parseEnvelope: garbage → IMPORT_INVALID', () => {
  assert.throws(() => parseEnvelope('{not json'), (e) => e instanceof TackbackError && e.code === 'IMPORT_INVALID');
  assert.throws(() => parseEnvelope({ nope: true }), (e) => e.code === 'IMPORT_INVALID');
});

// --- spec REQ-304: envelope carries document source + revisionHash (round-trip + legacy migration) ---

test('buildEnvelope + parseEnvelope: document source + revisionHash round-trip (REQ-304)', () => {
  const env = buildEnvelope({
    document: { id: 'doc-1', title: 'T', revisionHash: 'sha256:abc', source: '# md source' },
    now: 'N', version: '0.1.0', comments: [],
  });
  assert.equal(env.document.revisionHash, 'sha256:abc');
  assert.equal(env.document.source, '# md source');
  const { document } = parseEnvelope(env);
  assert.equal(document.revisionHash, 'sha256:abc');
  assert.equal(document.source, '# md source');
});

test('parseEnvelope: legacy source_sha256/source_md → revisionHash/source (REQ-304/305)', () => {
  const { document } = parseEnvelope({ doc: 'D', source_sha256: 'sha256:old', source_md: '# old', comments: [] });
  assert.equal(document.revisionHash, 'sha256:old');
  assert.equal(document.source, '# old');
});

// --- spec REQ-507: raster-surface descriptors travel in the envelope (surfaces[]) ---

const pdfDescriptor = (id, page) => ({
  id, kind: 'pdf-page', size: { width: 600, height: 800 },
  content: { ref: { type: 'doc-source', value: null }, page, scale: 1 },
});

test('buildEnvelope: emits surfaces[] when provided, omits when empty (REQ-507)', () => {
  const withS = buildEnvelope({ document: { id: 'd' }, now: 'N', version: '0.1.0', surfaces: [pdfDescriptor('page-1', 1)], comments: [] });
  assert.equal(withS.surfaces.length, 1);
  assert.equal(withS.surfaces[0].kind, 'pdf-page');
  const noS = buildEnvelope({ document: { id: 'd' }, now: 'N', version: '0.1.0', surfaces: [], comments: [] });
  assert.equal('surfaces' in noS, false);
});

test('parseEnvelope: carries surfaces[] through for (post-v1) replay (REQ-507)', () => {
  const { surfaces } = parseEnvelope({ schemaVersion: 1, document: { id: 'd' }, surfaces: [pdfDescriptor('page-2', 2)], comments: [v2('a')] });
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].content.page, 2);
});

test('exportEnvelope: collects a raster surface descriptor for a region anchor, excludes the live document surface (REQ-507)', () => {
  const tb = Tackback.mount({ document: { id: 'doc-1', source: '# pdf-doc' }, storage: memoryAdapter() });
  // an adapter registering a PDF page surface with a REQ-507 descriptor
  tb.registerMediaAdapter({ name: 't', mount(ctx) {
    ctx.registerSurface({ id: 'page-1', type: 'pdf-page', element: {}, descriptor: pdfDescriptor('page-1', 1),
      toNormalizedRect: () => ({ x: 0, y: 0, width: 1, height: 1 }), fromNormalizedRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) });
  } });
  tb.addComment({ anchor: { type: 'region', surfaceId: 'page-1', rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }, body: 'on a pdf page' });
  tb.addComment({ anchor: { type: 'region', surfaceId: 'document', rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }, body: 'on the live document' });
  const env = tb.exportEnvelope();
  assert.equal(env.surfaces.length, 1, 'only the raster surface (page-1) is described; the live document surface is not');
  assert.equal(env.surfaces[0].id, 'page-1');
  assert.equal(env.surfaces[0].content.ref.type, 'doc-source');
});
