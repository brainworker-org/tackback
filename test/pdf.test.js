// @brainworker/tackback/pdf — headless tests. The pure coordinate algebra is tested directly; the adapter is
// driven with an injected fake pdf.js + a minimal fake DOM, so surface registration, the
// zoom-independent transform, and teardown are pinned without a browser. Real PDF rendering +
// the panel's right-drag gesture are covered by the demo's post-v1 PDF preview (demo/demo.html).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toNormalizedAgainst, fromNormalizedToRect } from '../src/pdf/geometry.js';
import { createPdfAdapter } from '../src/pdf/index.js';

// ---- fakes -----------------------------------------------------------------------------------

function fakeElement(doc, tag) {
  const children = [];
  const attrs = {};
  const style = {};
  let textContent = '';
  const el = {
    tagName: tag, ownerDocument: doc, style, children, className: '',
    width: 0, height: 0, parentNode: null,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(c) { c.parentNode = el; children.push(c); return c; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentNode = null; },
    getContext() { return {}; },
    // size comes from the inline style the adapter sets (e.g. "140px")
    getBoundingClientRect() { return { left: 0, top: 0, width: parseFloat(style.width) || 0, height: parseFloat(style.height) || 0 }; },
  };
  Object.defineProperty(el, 'clientWidth', { get: () => parseFloat(style.width) || 0 });
  Object.defineProperty(el, 'clientHeight', { get: () => parseFloat(style.height) || 0 });
  Object.defineProperty(el, 'textContent', {
    get: () => textContent,
    set: (v) => { textContent = v; if (v === '') children.length = 0; },
  });
  return el;
}

function fakeDoc() {
  const doc = { createElement: (t) => fakeElement(doc, t) };
  doc.body = fakeElement(doc, 'body');
  return doc;
}

// scaled-but-proportional page: 100×140 at scale 1.
function fakePdfjs({ numPages = 2 } = {}) {
  const captured = { params: null, workerSrc: undefined };
  const GlobalWorkerOptions = {};
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    get: () => captured.workerSrc, set: (v) => { captured.workerSrc = v; }, configurable: true,
  });
  return {
    _captured: captured,
    GlobalWorkerOptions,
    getDocument(params) {
      captured.params = params;
      return {
        promise: Promise.resolve({
          numPages,
          getPage: (n) => Promise.resolve({
            _page: n,
            getViewport: ({ scale }) => ({ width: 100 * scale, height: 140 * scale }),
            render: () => ({ promise: Promise.resolve() }),
          }),
          destroy() { captured.destroyed = true; },
        }),
      };
    },
  };
}

function fakeCtx(root) {
  const surfaces = new Map();
  let invalidated = 0;
  return {
    root, surfaces,
    registerSurface(s) { surfaces.set(s.id, s); return () => surfaces.delete(s.id); },
    invalidate() { invalidated++; },
    on() { return () => {}; },
    get invalidated() { return invalidated; },
  };
}

// ---- geometry --------------------------------------------------------------------------------

test('toNormalizedAgainst maps a client rect into 0..1 relative to bounds', () => {
  const r = toNormalizedAgainst({ left: 10, top: 14, width: 50, height: 70 },
    { left: 0, top: 0, width: 100, height: 140 });
  assert.deepEqual(r, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
});

test('toNormalizedAgainst respects a non-zero bounds origin (scrolled/offset page)', () => {
  const r = toNormalizedAgainst({ left: 30, top: 50, width: 100, height: 140 },
    { left: 20, top: 20, width: 100, height: 140 });
  assert.equal(r.x, 0.1);
  assert.equal(r.y, (50 - 20) / 140);
});

test('toNormalizedAgainst clamps an overflowing selection to [0,1]', () => {
  const r = toNormalizedAgainst({ left: -20, top: -10, width: 999, height: 999 },
    { left: 0, top: 0, width: 100, height: 140 });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.width, 1);
  assert.equal(r.height, 1);
});

test('toNormalizedAgainst returns a zero rect for a degenerate surface (no NaN)', () => {
  const r = toNormalizedAgainst({ left: 0, top: 0, width: 10, height: 10 },
    { left: 0, top: 0, width: 0, height: 0 });
  assert.deepEqual(r, { x: 0, y: 0, width: 0, height: 0 });
});

test('fromNormalizedToRect reconstructs px against the current surface size', () => {
  const px = fromNormalizedToRect({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, 200, 280);
  assert.equal(px.x, 20);
  assert.equal(px.y, 28);
  assert.equal(px.width, 100);
  assert.equal(px.height, 140);
});

// ---- adapter ---------------------------------------------------------------------------------

test('mount renders one surface per page with panel-keyed attributes', async () => {
  const doc = fakeDoc();
  const ctx = fakeCtx(doc.body);
  const pdfjs = fakePdfjs({ numPages: 3 });
  const adapter = createPdfAdapter({ pdfjs, url: 'x.pdf', workerSrc: 'w.mjs', standardFontDataUrl: 'fonts/' });

  assert.equal(adapter.name, '@brainworker/tackback/pdf');
  assert.deepEqual(adapter.supports, ['region']);

  const teardown = await adapter.mount(ctx);

  assert.equal(ctx.surfaces.size, 3);
  for (let n = 1; n <= 3; n++) {
    const s = ctx.surfaces.get(`page-${n}`);
    assert.ok(s, `surface page-${n} registered`);
    assert.equal(s.type, 'pdf-page');
    assert.equal(s.pageIndex, n);
    assert.equal(s.element.getAttribute('data-tb-page'), String(n));
    assert.equal(s.element.getAttribute('data-tb-surface'), `page-${n}`);
    assert.equal(s.element.style.position, 'relative');
  }
  assert.ok(ctx.invalidated >= 1, 'invalidate called after render');
  assert.equal(pdfjs._captured.workerSrc, 'w.mjs', 'workerSrc set on GlobalWorkerOptions');
  assert.equal(pdfjs._captured.params.url, 'x.pdf');
  assert.equal(pdfjs._captured.params.standardFontDataUrl, 'fonts/');

  teardown();
  assert.equal(ctx.surfaces.size, 0, 'teardown unregisters all surfaces');
});

test('surface.toNormalizedRect is zoom-independent across a scale change', async () => {
  const doc = fakeDoc();
  const ctx = fakeCtx(doc.body);
  const adapter = createPdfAdapter({ pdfjs: fakePdfjs({ numPages: 1 }), url: 'x.pdf' });
  await adapter.mount(ctx);

  // a selection covering the lower-right quarter of page 1 at scale 1 (page is 100×140)
  const at1 = ctx.surfaces.get('page-1').toNormalizedRect({ left: 50, top: 70, width: 50, height: 70 });
  assert.deepEqual(at1, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });

  // zoom to 2× → page is 200×280; the SAME logical quarter is a different client rect…
  await adapter.setScale(2);
  assert.equal(adapter.scale, 2);
  const at2 = ctx.surfaces.get('page-1').toNormalizedRect({ left: 100, top: 140, width: 100, height: 140 });
  // …but normalizes to the same anchor (zoom-independence)
  assert.deepEqual(at2, at1);

  // and reconstructs to the right px at the new size
  const px = ctx.surfaces.get('page-1').fromNormalizedRect(at1);
  assert.equal(px.width, 100); // 0.5 × 200
  assert.equal(px.height, 140); // 0.5 × 280
});

test('setScale re-registers fresh surfaces (no stale handles) and re-invalidates', async () => {
  const doc = fakeDoc();
  const ctx = fakeCtx(doc.body);
  const adapter = createPdfAdapter({ pdfjs: fakePdfjs({ numPages: 2 }), url: 'x.pdf' });
  await adapter.mount(ctx);
  const before = ctx.invalidated;
  const firstPageEl = ctx.surfaces.get('page-1').element;

  await adapter.setScale(1.5);

  assert.equal(ctx.surfaces.size, 2, 'still 2 surfaces, not 4 (old ones cleared)');
  assert.notEqual(ctx.surfaces.get('page-1').element, firstPageEl, 'page-1 re-rendered to a fresh element');
  assert.ok(ctx.invalidated > before, 're-invalidated after zoom');
});

test('mount rejects without a pdfjs module', async () => {
  const ctx = fakeCtx(fakeDoc().body);
  const adapter = createPdfAdapter({ url: 'x.pdf' });
  await assert.rejects(() => adapter.mount(ctx), /requires options\.pdfjs/);
});

test('mount rejects without a url or data source', async () => {
  const ctx = fakeCtx(fakeDoc().body);
  const adapter = createPdfAdapter({ pdfjs: fakePdfjs() });
  await assert.rejects(() => adapter.mount(ctx), /requires options\.url or options\.data/);
});

test('data source is forwarded to getDocument when no url is given', async () => {
  const ctx = fakeCtx(fakeDoc().body);
  const pdfjs = fakePdfjs({ numPages: 1 });
  const bytes = new Uint8Array([1, 2, 3]);
  const adapter = createPdfAdapter({ pdfjs, data: bytes });
  await adapter.mount(ctx);
  assert.equal(pdfjs._captured.params.data, bytes);
  assert.equal(pdfjs._captured.params.url, undefined);
});
