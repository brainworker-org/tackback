// node:test — the single shared resolution module (spec REQ-014, divergence D-E).
//
// Pins the ONE DOM-walk contract: the annotatable node set, deterministic block-id derivation, the
// text-normalization a range indexes into, and that interactive-creation vs import/replay resolve
// identically. Driven with the suite's fake-DOM idiom (no jsdom) — resolution takes root/doc, never
// a global.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANNOTATABLE, HEADINGS, indexAnnotatable, deriveBlockId, normalizeText, resolveRange,
  resolveAnchorDom,
} from '../src/core/resolution.js';

// ---- fake DOM (tree-walk capable: querySelectorAll('*'), matches, getElementById) ------------

function el(tag, opts = {}) {
  const attrs = {};
  const node = {
    tagName: tag.toUpperCase(),
    children: opts.children || [],
    _id: opts.id || '',
    text: opts.text || '',
    get id() { return this._id; },
    set id(v) { this._id = v; },
    matches(sel) { return sel.split(',').map((s) => s.trim().toUpperCase()).includes(this.tagName); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    get textContent() {
      return this.children.length
        ? this.children.map((c) => c.textContent).join('')
        : this.text;
    },
    // Element.querySelectorAll is descendant-scoped (matches the real DOM contract indexAnnotatable uses).
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(this);
      return sel === '*' ? out : out.filter((n) => n.matches(sel));
    },
  };
  return node;
}

function doc(root) {
  const all = root.querySelectorAll('*');
  return {
    body: root,
    querySelectorAll: (sel) => (sel === '*' ? all : all.filter((n) => n.matches(sel))),
    getElementById: (id) => all.find((n) => n.id === id) || null,
  };
}

// A small article: an H1 title, an H2 section, two paragraphs, a list item. (h1 IS annotatable now —
// a reviewer can comment on the title; it is also the section context for what follows. PR #132 9a.)
function article() {
  return el('div', { children: [
    el('h1', { text: 'Doc Title' }),
    el('h2', { text: 'Section A' }),
    el('p', { text: 'The anchor must survive zoom and scroll changes.' }),
    el('p', { text: 'A second paragraph with unique words herein.' }),
    el('ul', { children: [el('li', { text: 'a bullet point' })] }),
  ] });
}

// ---- node set --------------------------------------------------------------------------------

test('ANNOTATABLE / HEADINGS are the single node-set definition', () => {
  assert.equal(ANNOTATABLE, 'h1,h2,h3,h4,p,li,blockquote,tr');
  assert.equal(HEADINGS, 'h1,h2,h3,h4');
});

// ---- id derivation ---------------------------------------------------------------------------

test('deriveBlockId: author id preferred, else a deterministic content-bound tb-<hash> id', () => {
  assert.equal(deriveBlockId({ id: 'intro' }), 'intro');
  const a = deriveBlockId({ id: '', tagName: 'P', textContent: 'hello world' });
  const b = deriveBlockId({ id: '', tagName: 'P', textContent: 'hello world' });
  assert.equal(a, b, 'same tag+text → same id (deterministic, content-bound)');
  assert.match(a, /^tb-[0-9a-f]{8}$/);
  // different text or tag → different id (so a changed block no longer matches → orphans)
  assert.notEqual(a, deriveBlockId({ id: '', tagName: 'P', textContent: 'different' }));
  assert.notEqual(a, deriveBlockId({ id: '', tagName: 'H2', textContent: 'hello world' }));
});

test('indexAnnotatable assigns content-bound ids + nearest-heading section, and is idempotent', () => {
  const root = article();
  const d = doc(root);
  indexAnnotatable(root);
  const annot = d.querySelectorAll(ANNOTATABLE);
  const ids = annot.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(ids.every((id) => /^tb-[0-9a-f]{8}$/.test(id)), 'every id-less element got a tb-<hash> id');
  // section context = nearest preceding heading (a heading is itself annotatable; its own section is itself)
  const [h1, h2, p1, p2, li] = annot;
  assert.equal(h1.getAttribute('data-tb-section'), 'Doc Title', 'the h1 title is annotatable; its section is itself');
  assert.equal(h2.getAttribute('data-tb-section'), 'Section A');
  assert.equal(p1.getAttribute('data-tb-section'), 'Section A');
  assert.equal(p2.getAttribute('data-tb-section'), 'Section A');
  assert.equal(li.getAttribute('data-tb-section'), 'Section A');
  assert.equal(h1.getAttribute('data-tb-anchor'), '1');
  assert.equal(h2.getAttribute('data-tb-anchor'), '1');

  // idempotent: a second walk over the same tree changes no ids
  const before = annot.map((n) => n.id);
  indexAnnotatable(root);
  assert.deepEqual(d.querySelectorAll(ANNOTATABLE).map((n) => n.id), before);
});

test('indexAnnotatable keeps author-supplied ids (only id-less elements get a derived id)', () => {
  const root = el('div', { children: [
    el('h2', { id: 'sec', text: 'S' }),
    el('p', { text: 'first' }),       // id-less → derived
    el('p', { id: 'mine', text: 'second' }),
  ] });
  indexAnnotatable(root);
  const [h2, p1, p2] = doc(root).querySelectorAll(ANNOTATABLE);
  assert.equal(h2.id, 'sec'); assert.equal(p2.id, 'mine');
  assert.match(p1.id, /^tb-[0-9a-f]{8}$/, 'the id-less element gets a content-bound id');
});

test('content-bound ids survive insertion: a fresh-load import resolves to the SAME content or orphans (§6 R5 PR #132)', () => {
  // original doc, fresh load → an anchor is created against the "Bravo" paragraph
  const orig = el('div', { children: [el('p', { text: 'Alpha' }), el('p', { text: 'Bravo' }), el('p', { text: 'Charlie' })] });
  indexAnnotatable(orig);
  const anchorId = doc(orig).querySelectorAll(ANNOTATABLE)[1].id;   // "Bravo"

  // the SOURCE is edited (an id-less paragraph inserted at the FRONT) and a DIFFERENT viewer loads it
  // FRESH (no retained runtime ids) — a positional ordinal would mis-resolve the anchor here.
  const edited = el('div', { children: [el('p', { text: 'NEW intro' }), el('p', { text: 'Alpha' }), el('p', { text: 'Bravo' }), el('p', { text: 'Charlie' })] });
  indexAnnotatable(edited);
  const resolved = doc(edited).getElementById(anchorId);
  assert.ok(resolved && resolved.textContent === 'Bravo', 'resolves to the SAME content (Bravo), not the shifted position');

  // a block whose text was deleted → no element hashes to the old id → orphan (null), never mis-point
  const removed = el('div', { children: [el('p', { text: 'Alpha' }), el('p', { text: 'Charlie' })] });
  indexAnnotatable(removed);
  assert.equal(doc(removed).getElementById(anchorId), null, 'deleted block → imported anchor orphans');
});

test('indexAnnotatable disambiguates duplicate-content blocks by occurrence (unique ids)', () => {
  const root = el('div', { children: [el('p', { text: 'same' }), el('p', { text: 'same' }), el('p', { text: 'same' })] });
  indexAnnotatable(root);
  const ids = doc(root).querySelectorAll(ANNOTATABLE).map((n) => n.id);
  assert.equal(new Set(ids).size, 3, 'three identical paragraphs get three unique ids');
  assert.ok(ids.every((id) => id.startsWith('tb-')));
});

// ---- D-E: interactive creation and import/replay resolve identically (the divergence guard) ----

test('D-E: the same walk on two identical trees derives identical ids (path-independence)', () => {
  // "interactive" tree (creation-side) and "import/replay" tree (a fresh render of the same doc)
  const interactive = article();
  const replay = article();
  indexAnnotatable(interactive);   // creation path
  indexAnnotatable(replay);        // import/replay path — SAME module, SAME walk
  const a = doc(interactive).querySelectorAll(ANNOTATABLE).map((n) => n.id);
  const b = doc(replay).querySelectorAll(ANNOTATABLE).map((n) => n.id);
  assert.deepEqual(a, b, 'an anchor created one way resolves to the same id on import/replay');
});

// ---- text normalization + range resolution ---------------------------------------------------

test('normalizeText is the element textContent (the string quote selectors index into)', () => {
  const p = el('p', { text: 'hello world' });
  assert.equal(normalizeText(p), 'hello world');
  assert.equal(normalizeText(el('p')), '');
});

test('resolveRange resolves a unique quote to offsets; orphans (null) when gone or drifted', () => {
  const root = article();
  indexAnnotatable(root);
  const d = doc(root);
  const p1 = d.querySelectorAll(ANNOTATABLE)[2];   // the "...must survive zoom..." paragraph (after h1,h2)
  const anchor = { elementId: p1.id, selector: { exact: 'survive', prefix: 'must ', suffix: ' zoom' } };
  const hit = resolveRange(d, anchor);
  assert.ok(hit && hit.element.id === p1.id);
  assert.equal(hit.element.textContent.slice(hit.start, hit.end), 'survive');

  // element missing → orphaned (null), never a guess
  assert.equal(resolveRange(d, { elementId: 'tb-missing', selector: { exact: 'x' } }), null);
  // quote drifted out of the element → orphaned
  assert.equal(resolveRange(d, { elementId: p1.id, selector: { exact: 'no-such-phrase' } }), null);
});

// ---- block resolution (region resolution is pinned in hardening.test.js) ---------------------

test('resolveAnchorDom resolves a block by id, null when missing', () => {
  const root = article();
  indexAnnotatable(root);
  const d = doc(root);
  const h2 = d.querySelectorAll(ANNOTATABLE)[1];   // [0] is the h1 title; [1] is the h2 section heading
  const res = resolveAnchorDom({ type: 'block', elementId: h2.id }, d, new Map());
  assert.ok(res && res.element.id === h2.id && res.rect === undefined);
  assert.equal(resolveAnchorDom({ type: 'block', elementId: 'gone' }, d, new Map()), null);
});
