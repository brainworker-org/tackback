// node:test — phase 3 region engine: page-span surface, reflow fallback, anchor-event history +
// per-event capture (REQ-009/010), serialized orphan state (REQ-004), and the document surface
// (REQ-005). Pure math + headless engine; gesture/handles/observer wiring is panel/browser (phase 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { regionFallbackOffset, applyRegionFallback, rectsIntersect } from '../src/core/anchor.js';
import { regionStateOf, appendAnchorEvent, markOrphan, clearOrphan } from '../src/core/model.js';
import { computeCapture, resolveRegionRect, resolveAnchorDom, boundingMeasure } from '../src/core/resolution.js';
import { documentSurface, DOCUMENT_SURFACE_ID } from '../src/core/media.js';
import { Tackback } from '../src/index.js';
import { memoryAdapter } from '../src/core/storage.js';

// ---- fake DOM (rects via getBoundingClientRect; tree-walk for capture) -----------------------

function el(tag, opts = {}) {
  const attrs = opts.attrs || {};
  const node = {
    tagName: tag.toUpperCase(),
    children: opts.children || [],
    id: opts.id || '',
    text: opts.text || '',
    _rect: opts.rect || { left: 0, top: 0, width: 0, height: 0 },
    matches(sel) { return sel.split(',').map((s) => s.trim().toUpperCase()).includes(this.tagName); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    getBoundingClientRect() { return this._rect; },
    get clientWidth() { return this._rect.width; },
    get clientHeight() { return this._rect.height; },
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text;
    },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(this);
      return sel === '*' ? out : out.filter((n) => n.matches(sel));
    },
  };
  node.ownerDocument = opts.ownerDocument || null;
  return node;
}

// ---- fallback math (REQ-007) -----------------------------------------------------------------

test('regionFallbackOffset / applyRegionFallback round-trip; reflow rides the element', () => {
  const region = { x: 0.40, y: 0.30 };
  const elAtCapture = { x: 0.35, y: 0.25 };
  const off = regionFallbackOffset(region, elAtCapture);
  assert.deepEqual({ dx: +off.dx.toFixed(4), dy: +off.dy.toFixed(4) }, { dx: 0.05, dy: 0.05 });
  // no reflow: element in the same place → region back where it was
  assert.deepEqual(applyRegionFallback(elAtCapture, off.dx, off.dy), { x: 0.40, y: 0.30 });
  // reflow pushed the element down by 0.10 → the region rides down the same 0.10
  const moved = applyRegionFallback({ x: 0.35, y: 0.35 }, off.dx, off.dy);
  assert.deepEqual({ x: +moved.x.toFixed(4), y: +moved.y.toFixed(4) }, { x: 0.40, y: 0.40 });
});

test('rectsIntersect: overlap true, edge-touch / disjoint false', () => {
  const a = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
  assert.equal(rectsIntersect(a, { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }), true);
  assert.equal(rectsIntersect(a, { x: 0.4, y: 0.1, width: 0.2, height: 0.2 }), false, 'edge touch is not overlap');
  assert.equal(rectsIntersect(a, { x: 0.8, y: 0.8, width: 0.1, height: 0.1 }), false, 'disjoint');
});

// ---- model: anchor-event history + orphan helpers (REQ-009/010/004) --------------------------

test('regionStateOf copies rect/fallback/capture (no reach-back into stored events)', () => {
  const anchor = { type: 'region', surfaceId: 'document', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, fallback: { elementId: 'p1', dx: 0.01, dy: 0.02 }, capture: { covered: [{ in: 'p1', text: 'hi' }], media: [] } };
  const s = regionStateOf(anchor);
  s.rect.x = 0.9; s.capture.covered.push({ in: 'x', text: 'y' });
  assert.equal(anchor.rect.x, 0.1, 'rect copied');
  assert.equal(anchor.capture.covered.length, 1, 'capture covered copied');
});

test('appendAnchorEvent seeds a create event, then appends move with before/after; advances rect', () => {
  const a0 = { type: 'region', surfaceId: 'document', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
  const after1 = { rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, capture: { covered: [{ in: 'p2', text: 'moved' }], media: [] } };
  const a1 = appendAnchorEvent(a0, 'move', after1, '2026-06-15T01:00:00Z', '2026-06-15T00:00:00Z');
  assert.equal(a1.events.length, 2, 'create + move');
  assert.equal(a1.events[0].type, 'create');
  assert.equal(a1.events[0].ts, '2026-06-15T00:00:00Z', 'create stamped with createdAt');
  assert.equal(a1.events[0].before, undefined, 'create has no before');
  assert.equal(a1.events[1].type, 'move');
  assert.deepEqual(a1.events[1].before.rect, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
  assert.deepEqual(a1.events[1].after.rect, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 });
  assert.deepEqual(a1.rect, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, 'current rect advanced');
  assert.deepEqual(a1.capture, after1.capture, 'current capture advanced');

  // a second move does NOT re-seed create; prior event capture stays intact (REQ-010 b)
  const after2 = { rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } };
  const a2 = appendAnchorEvent(a1, 'resize', after2, '2026-06-15T02:00:00Z', '2026-06-15T00:00:00Z');
  assert.equal(a2.events.length, 3, 'no second create');
  assert.deepEqual(a2.events[1].after.capture.covered, [{ in: 'p2', text: 'moved' }], 'prior event capture intact');
  assert.equal(a2.capture, undefined, 'after2 had no capture → current cleared');
});

test('markOrphan / clearOrphan toggle the serialized state', () => {
  const c = { id: 'c1', anchor: { type: 'block', elementId: 'p1' }, body: 'x', createdAt: 't' };
  const orphaned = markOrphan(c, '2026-06-15T03:00:00Z', 'element gone');
  assert.deepEqual(orphaned.orphan, { since: '2026-06-15T03:00:00Z', lastError: 'element gone' });
  assert.equal(c.orphan, undefined, 'original untouched');
  assert.equal(clearOrphan(orphaned).orphan, undefined);
});

test('appendAnchorEvent deep-copies `after` — mutating the input cannot corrupt stored history', () => {
  const a0 = { type: 'region', surfaceId: 'document', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
  const after = { rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, capture: { covered: [{ in: 'p1', text: 'orig' }], media: ['a.png'] } };
  const a1 = appendAnchorEvent(a0, 'move', after, 't1', 't0');
  // mutate the caller's input AFTER the call — the append-only log must be immune
  after.rect.x = 0.99; after.fallback = { elementId: 'x', dx: 9, dy: 9 };
  after.capture.covered[0].text = 'HACKED'; after.capture.media.push('b.png');
  const ev = a1.events[a1.events.length - 1];
  assert.equal(ev.after.rect.x, 0.3, 'stored event rect unchanged');
  assert.equal(ev.after.capture.covered[0].text, 'orig', 'stored event capture text unchanged');
  assert.deepEqual(ev.after.capture.media, ['a.png'], 'stored event media unchanged');
  assert.equal(ev.after.fallback, undefined, 'a fallback added to the input after the call did not leak in');
  assert.equal(a1.rect.x, 0.3, 'current anchor rect unchanged');
  assert.equal(a1.capture.covered[0].text, 'orig', 'current capture unchanged');
});

// ---- media: document surface (REQ-005) -------------------------------------------------------

test('documentSurface normalizes against the content box, round-trips, and is zoom-independent', () => {
  const surf = el('div', { rect: { left: 100, top: 50, width: 800, height: 1000 } });
  const ds = documentSurface(surf);
  assert.equal(ds.id, DOCUMENT_SURFACE_ID);
  // a client rect at (300,250) size 400x200 inside the surface → normalized
  const norm = ds.toNormalizedRect({ left: 300, top: 250, width: 400, height: 200 });
  assert.deepEqual({ x: +norm.x.toFixed(4), y: +norm.y.toFixed(4), width: +norm.width.toFixed(4), height: +norm.height.toFixed(4) },
    { x: 0.25, y: 0.2, width: 0.5, height: 0.2 });
  // fromNormalizedRect (uses clientWidth/Height) is the inverse in size terms
  const back = ds.fromNormalizedRect(norm);
  assert.deepEqual({ width: +back.width.toFixed(2), height: +back.height.toFixed(2) }, { width: 400, height: 200 });
});

// ---- resolution: capture + region rect with fallback -----------------------------------------

function captureFixture() {
  // surface 1000x1000 at origin; a heading + two paragraphs + an image stacked vertically
  const surf = el('div', { rect: { left: 0, top: 0, width: 1000, height: 1000 } });
  const h2 = el('h2', { id: 'h', text: 'Heading', rect: { left: 0, top: 0, width: 1000, height: 100 } });
  const p1 = el('p', { id: 'p1', text: 'first paragraph text', rect: { left: 0, top: 100, width: 1000, height: 100 } });
  const p2 = el('p', { id: 'p2', text: 'second paragraph text', rect: { left: 0, top: 400, width: 1000, height: 100 } });
  const img = el('img', { id: 'fig', attrs: { src: 'pic.png' }, rect: { left: 0, top: 700, width: 1000, height: 200 } });
  surf.children = [h2, p1, p2, img];
  return { surf, h2, p1, p2, img };
}

test('computeCapture lists covered text + media; raster-only region → media-only', () => {
  const { surf } = captureFixture();
  // region covering y 0.05..0.25 → touches the heading (0..0.1) and p1 (0.1..0.2)
  const cap = computeCapture(surf, { x: 0, y: 0.05, width: 1, height: 0.20 });
  assert.deepEqual(cap.covered.map((c) => c.in).sort(), ['h', 'p1']);
  assert.deepEqual(cap.media, [], 'no media in that band');

  // region over the image only (y 0.7..0.9) → media-only, no covered text
  const cap2 = computeCapture(surf, { x: 0, y: 0.72, width: 1, height: 0.15 });
  assert.deepEqual(cap2.covered, [], 'raster-only → no text');
  assert.deepEqual(cap2.media, ['pic.png']);
});

test('computeCapture includes the surface element itself when it IS media (stamped img/canvas)', () => {
  const img = el('img', { id: 'fig', attrs: { src: 'pic.png' }, rect: { left: 0, top: 0, width: 500, height: 500 } });
  // a region drawn directly on an img-used-as-surface (querySelectorAll sees no descendants)
  const cap = computeCapture(img, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
  assert.deepEqual(cap.media, ['pic.png'], 'the surface img itself is captured as media, not omitted');
  assert.deepEqual(cap.covered, [], 'an img surface has no annotatable text');
});

test('computeCapture caps the covered list (NFR-006)', () => {
  const surf = el('div', { rect: { left: 0, top: 0, width: 100, height: 100 } });
  surf.children = Array.from({ length: 30 }, (_, i) =>
    el('p', { id: `p${i}`, text: `para ${i}`, rect: { left: 0, top: 0, width: 100, height: 100 } }));
  const cap = computeCapture(surf, { x: 0, y: 0, width: 1, height: 1 }, { maxCovered: 5 });
  assert.equal(cap.covered.length, 5, 'covered capped at maxCovered');
});

test('resolveRegionRect applies the fallback when its element resolves, else uses the stored rect', () => {
  const { surf, p2 } = captureFixture();
  surf.ownerDocument = { getElementById: (id) => (id === 'p2' ? p2 : null) };
  const measure = boundingMeasure(surf);   // surface is 1000x1000 at origin → normalized = px/1000
  // anchor stored at y 0.10 with a fallback to p2; p2 is now at y 0.40 (reflowed down 0.30)
  // offset was captured when p2 was at 0.10 → dy 0.0 ... craft: region top == p2 top at capture (dx=dy=0)
  const anchor = { type: 'region', surfaceId: 'document', rect: { x: 0, y: 0.10, width: 0.5, height: 0.1 }, fallback: { elementId: 'p2', dx: 0, dy: 0 } };
  const r = resolveRegionRect(anchor, surf, measure);
  assert.equal(+r.rect.y.toFixed(4), 0.40, 'region rode to p2 current position (reflow corrected)');
  assert.equal(+r.rect.width.toFixed(4), 0.5, 'width unchanged');
  assert.equal(+r.px.y.toFixed(1), 400, 'px from corrected normalized rect × surface size');

  // fallback element gone → stored rect stands
  surf.ownerDocument.getElementById = () => null;
  const r2 = resolveRegionRect(anchor, surf, measure);
  assert.equal(+r2.rect.y.toFixed(4), 0.10, 'no fallback element → stored rect');

  // surface gone → null (orphaned)
  assert.equal(resolveRegionRect(anchor, null, measure), null);
});

test('resolveRegionRect: an ABSOLUTE element-anchored fallback (fb.w set) is immune to surface TOTAL-size change', () => {
  // A document region anchored to p2 in absolute px. p2 sits at top=400 and does NOT move.
  const make = (surfHeight) => {
    const surf = el('div', { rect: { left: 0, top: 0, width: 1000, height: surfHeight } });
    const p2 = el('p', { id: 'p2', rect: { left: 0, top: 400, width: 1000, height: 100 } });
    surf.children = [p2];
    surf.ownerDocument = { getElementById: (id) => (id === 'p2' ? p2 : null) };
    return surf;
  };
  const anchor = { type: 'region', surfaceId: 'document',
    rect: { x: 0.01, y: 0.405, width: 0.12, height: 0.03 },             // stored normalized (portability/orphan)
    fallback: { elementId: 'p2', dx: 10, dy: 5, w: 120, h: 30 } };       // absolute px from p2's top-left

  const r1 = resolveRegionRect(anchor, make(1000));
  assert.deepEqual(r1.px, { x: 10, y: 405, width: 120, height: 30 }, 'px = p2.topLeft + (dx,dy), absolute size');

  // the surface DOUBLES in height (e.g. an embedded PDF re-rendered taller on zoom) but p2 is unchanged
  const r2 = resolveRegionRect(anchor, make(2000));
  assert.deepEqual(r2.px, { x: 10, y: 405, width: 120, height: 30 },
    'region tracks p2 (its content), NOT the total surface height — a PDF zoom must not move a document region');

  // the anchor element is gone → fall through to the stored normalized rect (orphan-safe)
  const surfNoEl = el('div', { rect: { left: 0, top: 0, width: 1000, height: 1000 } });
  surfNoEl.ownerDocument = { getElementById: () => null };
  const r3 = resolveRegionRect(anchor, surfNoEl);
  assert.equal(+r3.rect.y.toFixed(3), 0.405, 'element gone → stored normalized rect stands');
});

test('resolveAnchorDom (region) is fallback-aware — the single path delegates to resolveRegionRect', () => {
  const { surf, p2 } = captureFixture();
  surf.ownerDocument = { getElementById: (id) => (id === 'p2' ? p2 : null), querySelectorAll: () => [] };
  const surfaces = new Map([['document', { element: surf }]]);
  const doc = { getElementById: () => null, querySelectorAll: () => [] };
  // stored at y 0.10 but a fallback to p2, which is now at y 0.40 (reflowed)
  const anchor = { type: 'region', surfaceId: 'document', rect: { x: 0, y: 0.10, width: 0.5, height: 0.1 }, fallback: { elementId: 'p2', dx: 0, dy: 0 } };
  const viaAnchorDom = resolveAnchorDom(anchor, doc, surfaces);
  const viaRegionRect = resolveRegionRect(anchor, surf);
  assert.deepEqual(viaAnchorDom.rect, viaRegionRect.px, 'resolveAnchorDom rect == fallback-aware resolveRegionRect px (one path)');
  assert.equal(+viaAnchorDom.rect.y.toFixed(1), 400, 'fallback applied (p2 current position), not the stale stored rect');
});

// ---- engine: recordRegionEvent + serialized orphan (REQ-008/009/010/004) ---------------------

function mountWithRegion() {
  const tb = Tackback.mount({ document: { id: 'doc-region' }, storage: memoryAdapter() });
  const c = tb.addComment({ anchor: { type: 'region', surfaceId: 'document', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }, body: 'on a region' });
  return { tb, c };
}

test('recordRegionEvent appends history, advances rect, emits comment:update — no silent re-point', () => {
  const { tb, c } = mountWithRegion();
  let updates = 0; tb.on('comment:update', () => updates++);
  const next = tb.recordRegionEvent(c.id, { rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, capture: { covered: [], media: ['pic.png'] } }, 'move');
  assert.equal(updates, 1, 'comment:update emitted');
  assert.deepEqual(next.anchor.rect, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, 'rect advanced');
  assert.equal(next.anchor.events.length, 2, 'create + move recorded');
  assert.equal(next.anchor.events[0].type, 'create');
  assert.equal(next.anchor.events[1].type, 'move');
  // history survives export (it is part of the data contract)
  const env = tb.exportEnvelope();
  const exported = env.comments.find((x) => x.id === c.id);
  assert.equal(exported.anchor.events.length, 2, 'history exported');
});

test('recordRegionEvent rejects a non-region anchor and an out-of-bounds / zero-area rect (REQ-008)', () => {
  const tb = Tackback.mount({ document: { id: 'd' }, storage: memoryAdapter() });
  const block = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'x' });
  assert.throws(() => tb.recordRegionEvent(block.id, { rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }, 'move'), /not a region/);
  const { tb: tb2, c } = mountWithRegion();
  assert.throws(() => tb2.recordRegionEvent(c.id, { rect: { x: 0, y: 0, width: 0, height: 0.2 } }, 'resize'), /out of bounds|zero-area/, 'resize to zero rejected');
  assert.throws(() => tb2.recordRegionEvent(c.id, { rect: { x: 0.9, y: 0, width: 0.5, height: 0.2 } }, 'move'), /out of bounds|zero-area/, 'x+width>1 rejected');
});

// ---- phase 7: PDF page region is consistent with the new region model (no adapter change needed) ----

test('a PDF page region resolves via its page surface (no fallback) and captures media-only', () => {
  // a pdf-page surface = a positioned wrapper containing the rendered <canvas> (see pdf/index.js).
  const canvas = el('canvas', { rect: { left: 0, top: 0, width: 800, height: 1000 } });
  const page = el('div', { attrs: { 'data-tb-page': '1', 'data-tb-surface': 'page-1' }, rect: { left: 0, top: 0, width: 800, height: 1000 } });
  page.children = [canvas];
  const measure = boundingMeasure(page);
  // a PDF region anchor: surfaceId page-1, normalized rect, NO fallback (page surfaces are fixed)
  const anchor = { type: 'region', surfaceId: 'page-1', pageIndex: 1, rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 } };
  const r = resolveRegionRect(anchor, page, measure);
  assert.deepEqual(r.rect, anchor.rect, 'no fallback → stored rect stands');
  assert.equal(+r.px.width.toFixed(1), 400, 'px = rect × page size');
  // capture over a page = media-only (canvas), no annotatable text (PDF text lives in the raster)
  const cap = computeCapture(page, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(cap.covered, [], 'no annotatable text on a PDF page');
  assert.deepEqual(cap.media, ['canvas'], 'the rendered canvas is the covered media ref');
});

test('reportOrphaned serializes orphan state (listed + exportable + idempotent); markResolved clears it', () => {
  const { tb, c } = mountWithRegion();
  let orphanEvents = 0, changes = 0;
  tb.on('anchor:orphaned', () => orphanEvents++);
  tb.on('change', () => changes++);
  tb.reportOrphaned(tb.getComment(c.id), 'surface gone');
  const orphaned = tb.getComment(c.id);
  assert.deepEqual(typeof orphaned.orphan?.since, 'string');
  assert.equal(orphaned.orphan.lastError, 'surface gone');
  assert.equal(tb.listComments().find((x) => x.id === c.id) != null, true, 'still listed');
  assert.ok(tb.exportEnvelope().comments.find((x) => x.id === c.id).orphan, 'orphan exported');

  // idempotent: a second report fires the event but does NOT re-commit (no render loop)
  const changesAfterFirst = changes;
  tb.reportOrphaned(tb.getComment(c.id), 'surface gone');
  assert.equal(orphanEvents, 2, 'event still fires each report');
  assert.equal(changes, changesAfterFirst, 'no second commit (idempotent serialization)');

  // re-resolve clears it
  const resolved = tb.markResolved(c.id);
  assert.ok(resolved && !resolved.orphan, 'orphan cleared on markResolved');
  assert.equal(tb.markResolved(c.id), null, 'idempotent: clearing a non-orphan is a no-op');
});
