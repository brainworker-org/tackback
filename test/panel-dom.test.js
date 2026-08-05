// node:test — the PANEL's own contract, exercised through `attachPanel` against a fake DOM.
//
// Everything else about the panel is tested as DOM-free decisions (thread.js, interaction.js,
// actors.js). That left the WIRING untested, and wiring is where 0.9.3's defects actually lived: a
// label dispatch that still fell through to block, and a control that showed an attention tint the
// page had no way to clear. Both survived a fully green suite. This file exists so that class of
// defect fails a test instead of a review.
//
// The fake DOM is deliberately small — just enough for attachPanel to mount and be driven. It uses
// the same self-contained-fake approach as pdf.test.js rather than adding a dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Tackback } from '../src/core/engine.js';
import { attachPanel } from '../src/panel/index.js';

// ---- fake DOM ---------------------------------------------------------------------------------

/** Matches the selector shapes the panel actually uses: `*`, `tag`, `.class`, `[attr]`, comma lists. */
function matchesOne(el, sel) {
  sel = sel.trim();
  if (sel === '*') return true;
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('[')) {
    const name = sel.slice(1, -1).split('=')[0];
    return el.getAttribute(name) != null;
  }
  const [tag, ...rest] = sel.split('.');
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  return rest.every((c) => el.classList.contains(c));
}
const matches = (el, sel) => String(sel).split(',').some((s) => matchesOne(el, s));

function fakeElement(doc, tag) {
  const children = [];
  const attrs = {};
  const classes = new Set();
  let text = '';
  const el = {
    tagName: tag.toUpperCase(), ownerDocument: doc, children, style: {}, parentNode: null,
    listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get id() { return attrs.id || ''; },
    set id(v) { attrs.id = v; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(c) { c.parentNode = el; children.push(c); return c; },
    insertBefore(c, ref) { const i = children.indexOf(ref); children.splice(i < 0 ? children.length : i, 0, c); c.parentNode = el; return c; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentNode = null; },
    remove() { el.parentNode?.removeChild(el); },
    append(...cs) { cs.forEach((c) => el.appendChild(typeof c === 'object' ? c : doc.createTextNode(String(c)))); },
    matches: (sel) => matches(el, sel),
    closest(sel) { let n = el; while (n) { if (n.matches?.(sel)) return n; n = n.parentNode; } return null; },
    querySelectorAll(sel) { return descendants(el).filter((d) => matches(d, sel)); },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { return bubble(el, { ...ev, target: ev.target || el }); },
    click() { bubble(el, { type: 'click', target: el, stopPropagation() {} }); },
    clientWidth: 100, clientHeight: 100, offsetWidth: 100, offsetHeight: 100,
    focus() {}, select() {}, value: '',
  };
  Object.defineProperty(el, 'textContent', {
    get: () => (children.length ? children.map((c) => c.textContent ?? '').join('') : text),
    set: (v) => { text = String(v); children.length = 0; },
  });
  Object.defineProperty(el, 'firstElementChild', { get: () => children[0] || null });
  Object.defineProperty(el, 'lastElementChild', { get: () => children[children.length - 1] || null });
  return el;
}
// Dispatch an event on `el` and let it travel up to the document, the way a page-level listener
// (a clear-on-open policy, for instance) actually receives it.
function bubble(el, ev) {
  let stopped = false;
  const e = { ...ev, stopPropagation() { stopped = true; } };
  let node = el;
  while (node && !stopped) {
    node.onclick?.(e);
    (node.listeners?.[e.type] || []).forEach((f) => f(e));
    node = node.parentNode;
  }
  const doc = el.ownerDocument;
  if (!stopped && doc) (doc.listeners?.[e.type] || []).forEach((f) => f(e));
  return true;
}

function descendants(el) {
  const out = [];
  for (const c of el.children || []) {
    if (!c.tagName) continue;                     // text nodes are not selectable
    out.push(c); out.push(...descendants(c));
  }
  return out;
}
function fakeDoc() {
  const doc = {
    createElement: (t) => fakeElement(doc, t),
    createTextNode: (v) => ({ textContent: String(v), nodeType: 3 }),
    listeners: {},
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { doc.listeners[t] = (doc.listeners[t] || []).filter((f) => f !== fn); },
  };
  doc.documentElement = fakeElement(doc, 'html');
  doc.head = fakeElement(doc, 'head');
  doc.body = fakeElement(doc, 'body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.querySelectorAll = (sel) => descendants(doc.documentElement).filter((d) => matches(d, sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.getElementById = (id) => descendants(doc.documentElement).find((d) => d.id === id) || null;
  doc.elementFromPoint = () => null;
  return doc;
}

// `ensurePositioned` reaches for the global; the panel's `ready` handler can fire after a test has
// returned, so the stub is installed for the file rather than per test.
globalThis.getComputedStyle = () => ({ position: 'relative' });

/** Mount a core + panel on a fresh fake document. Returns everything a test needs to drive it. */
function mountPanel({ comments = [], controls } = {}) {
  const doc = fakeDoc();
  const root = fakeElement(doc, 'div');
  doc.body.appendChild(root);
  // a storage adapter that seeds the store WITHOUT validation — the path a persisted comment takes
  const storage = { load: () => ({ comments }), save: () => {} };
  const core = Tackback.mount({ document: { id: 'panel-fixture' }, storage, root });
  const panel = attachPanel(core, { root, target: doc.body, ...(controls ? { controls } : {}) });
  const restore = () => {};
  const docBtn = () => doc.querySelector('.tb-docbtn');
  const badges = () => doc.querySelectorAll('.tb-badge,.tb-pin');
  return { doc, root, core, panel, docBtn, badges, restore };
}

const docComment = (over = {}) => ({
  id: 'd1', anchor: { type: 'document' }, body: 'about the whole thing',
  createdAt: '2026-08-06T10:00:00.000Z', ...over,
});

// ---- the document thread's entry point ---------------------------------------------------------

test('panel: the document thread control is shown by default and opens the thread', () => {
  const f = mountPanel();
  try {
    assert.ok(f.docBtn(), 'a thread with no mark on the page must still be reachable');
    f.core.addComment({ anchor: { type: 'document' }, body: 'hello' });
    f.docBtn().click();
    const popup = f.doc.querySelector('.tb-popup');
    assert.ok(popup, 'the control opens the Pane');
    assert.match(popup.querySelector('.tb-anchor').textContent, /this document/);
    assert.equal(popup.querySelectorAll('.tb-c').length, 1, 'and it shows the document thread');
  } finally { f.restore(); }
});

test('panel: hiding the control does not remove the capability', () => {
  const f = mountPanel({ controls: { docThread: false } });
  try {
    assert.equal(f.docBtn(), null, 'the control is gone');
    f.core.addComment({ anchor: { type: 'document' }, body: 'still reachable' });
    f.panel.openDocumentThread();
    assert.ok(f.doc.querySelector('.tb-popup'), 'openDocumentThread() still opens it');
  } finally { f.restore(); }
});

test('panel: the control carries the count a badge would — replies included', () => {
  const f = mountPanel();
  try {
    const before = f.docBtn().textContent;
    assert.ok(!before.includes('💬'), 'no count while the thread is empty');
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    assert.match(f.docBtn().textContent, /💬1/);
    f.core.addReply(c.id, { body: 'a', author: { id: 'other', kind: 'ai' } });
    assert.match(f.docBtn().textContent, /💬2/, 'an answer moves the number, as it does on a badge');
  } finally { f.restore(); }
});

test('panel: the control wears the attention tint, and drops it when cleared', () => {
  const f = mountPanel();
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    assert.equal(f.docBtn().classList.contains('tb-attn'), false);
    f.core.setAnchorAttention(c.id, true);
    assert.equal(f.docBtn().classList.contains('tb-attn'), true, 'the control is this thread\'s mark');
    f.core.setAnchorAttention(c.id, false);
    assert.equal(f.docBtn().classList.contains('tb-attn'), false);
  } finally { f.restore(); }
});

test('panel: a document comment places no mark on the page', () => {
  const f = mountPanel();
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'whole document' });
    assert.equal(f.badges().length, 0, 'it is about everything, so it sits nowhere');
  } finally { f.restore(); }
});

// ---- persisted state from other builds ---------------------------------------------------------

test('panel: an orphan stamped on a document comment by an older build is cleared', () => {
  // a 0.9.2 build reading 0.9.3 storage does exactly this: it does not know the kind, fails to
  // resolve it, and serializes an orphan. Coming back to a build that understands it must clear that.
  const f = mountPanel({ comments: [docComment({ orphan: { since: '2026-08-06T09:00:00.000Z' } })] });
  try {
    assert.equal(f.core.listComments()[0].orphan, undefined, 'the stale stamp is gone');
    assert.equal(f.badges().length, 0, 'and it is not drawn as an orphaned badge');
  } finally { f.restore(); }
});

test('panel: an anchor kind the build does not know is not drawn as some other kind', () => {
  // storage seeds the store without validation, so an unknown kind can reach the renderer. It must
  // not borrow block's placement or block's label.
  const f = mountPanel({ comments: [{ id: 'u1', anchor: { type: 'workspace' }, body: 'from the future', createdAt: '2026-08-06T10:00:00.000Z' }] });
  try {
    assert.equal(f.badges().length, 0, 'no badge invented for a kind we cannot place');
    assert.equal(f.core.listComments().length, 1, 'and the comment itself is not destroyed');
  } finally { f.restore(); }
});

test('panel: a control click reaches a page-level listener, so a clear-on-open policy can work', () => {
  // This pins the MECHANISM, not either demo: an integrator clearing its own notice when a thread
  // opens does so from a document-level listener, and the fixture could not bubble at all before, so
  // no such policy was exercisable here. A regression in a demo's own listener would still not fail
  // this test — the demos are not loaded.
  const f = mountPanel();
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    f.core.setAnchorAttention(c.id, true);
    let sawControlClick = false;
    f.doc.addEventListener('click', (e) => {
      if (e.target.closest?.('.tb-docbtn')) {
        sawControlClick = true;
        f.core.listComments().forEach((x) => { if (x.anchor.type === 'document') f.core.setAnchorAttention(x.id, false); });
      }
    });
    f.docBtn().click();
    assert.equal(sawControlClick, true, 'the click reached the page-level listener');
    assert.equal(f.core.hasAttention(c.id), false, 'so the page could clear its own notice');
    assert.equal(f.docBtn().classList.contains('tb-attn'), false, 'and the control drops the tint');
  } finally { f.restore(); }
});
