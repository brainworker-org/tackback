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
    tagName: tag.toUpperCase(), ownerDocument: doc, children, parentNode: null,
    style: (() => { const st = {}; st.setProperty = (k, v) => { st[k] = v; }; st.getPropertyValue = (k) => st[k] ?? ''; return st; })(),
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
  // mount on the body, as a page with no explicit root does — that is what puts the lane INSIDE the
  // gesture root, which is the only geometry in which the lane's gesture guard can be exercised.
  const root = doc.body;
  // a storage adapter that seeds the store WITHOUT validation — the path a persisted comment takes
  const storage = { load: () => ({ comments }), save: () => {} };
  const core = Tackback.mount({ document: { id: 'panel-fixture' }, storage, root });
  const panel = attachPanel(core, { root, target: doc.body, ...(controls ? { controls } : {}) });
  const restore = () => {};
  const lane = () => doc.querySelector('.tb-lane');
  const laneHead = () => lane()?.querySelector('.tb-lane-head') || null;
  const laneCount = () => lane()?.querySelector('.tb-lane-count')?.textContent ?? null;
  const laneOpen = () => !!lane()?.classList.contains('tb-open');
  const badges = () => doc.querySelectorAll('.tb-badge,.tb-pin');
  return { doc, root, core, panel, lane, laneHead, laneCount, laneOpen, badges, restore };
}

const docComment = (over = {}) => ({
  id: 'd1', anchor: { type: 'document' }, body: 'about the whole thing',
  createdAt: '2026-08-06T10:00:00.000Z', ...over,
});

// ---- the document thread's entry point ---------------------------------------------------------

test('panel: the document lane is present by default and expands to the thread', () => {
  const f = mountPanel();
  try {
    assert.ok(f.lane(), 'a thread about no particular place still needs somewhere to live');
    assert.equal(f.laneOpen(), false, 'collapsed until asked for');
    f.core.addComment({ anchor: { type: 'document' }, body: 'hello' });
    f.laneHead().click();
    assert.equal(f.laneOpen(), true);
    assert.equal(f.lane().querySelectorAll('.tb-c').length, 1, 'and it holds the document thread');
    f.laneHead().click();
    assert.equal(f.laneOpen(), false, 'and collapses again');
  } finally { f.restore(); }
});

test('panel: the lane composes into the document thread, no popup involved', () => {
  const f = mountPanel();
  try {
    f.laneHead().click();
    const ta = f.lane().querySelector('textarea');
    ta.value = 'about the whole thing'; ta.dispatchEvent({ type: 'input' });
    f.lane().querySelector('.tb-save').click();
    assert.equal(f.core.listComments().length, 1);
    assert.equal(f.core.listComments()[0].anchor.type, 'document');
    assert.equal(f.doc.querySelector('.tb-popup'), null, 'the lane is its own surface');
    assert.equal(f.laneOpen(), true, 'and committing does not dismiss it');
  } finally { f.restore(); }
});

test('panel: with the lane off the thread is still reachable, as a Pane', () => {
  const f = mountPanel({ controls: { docLane: false } });
  try {
    assert.equal(f.lane(), null, 'the lane is gone');
    f.core.addComment({ anchor: { type: 'document' }, body: 'still reachable' });
    f.panel.openDocumentThread();
    const popup = f.doc.querySelector('.tb-popup');
    assert.ok(popup, 'openDocumentThread() falls back to an ordinary Pane');
    assert.equal(popup.querySelectorAll('.tb-c').length, 1);
  } finally { f.restore(); }
});

test('panel: the lane head carries the count a badge would — replies included', () => {
  const f = mountPanel();
  try {
    assert.equal(f.laneCount(), '', 'no count while the thread is empty');
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    assert.equal(f.laneCount(), '💬1');
    f.core.addReply(c.id, { body: 'a', author: { id: 'other', kind: 'ai' } });
    assert.equal(f.laneCount(), '💬2', 'an answer moves the number, as it does on a badge');
  } finally { f.restore(); }
});

test('panel: the lane wears the attention tint, and drops it when cleared', () => {
  const f = mountPanel();
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    assert.equal(f.lane().classList.contains('tb-attn'), false);
    f.core.setAnchorAttention(c.id, true);
    assert.equal(f.lane().classList.contains('tb-attn'), true, 'the lane is this thread\'s mark');
    f.core.setAnchorAttention(c.id, false);
    assert.equal(f.lane().classList.contains('tb-attn'), false);
  } finally { f.restore(); }
});

test('panel: a right-DRAG beginning on the lane starts no gesture', () => {
  // A bar fixed across the bottom sits over the content root, so without a guard a right-drag
  // beginning on it draws a region anchored to nothing anyone pointed at. The drag must be complete:
  // a lone pointerdown draws nothing regardless, so asserting on it proves nothing about the guard.
  const f = mountPanel();
  try {
    const fire = (type, over, x, y, buttons) =>
      over.dispatchEvent({ type, button: 2, buttons, clientX: x, clientY: y, pointerId: 1 });
    fire('pointerdown', f.laneHead(), 10, 10, 2);
    fire('pointermove', f.doc.body, 90, 70, 2);     // well past the drag threshold
    fire('pointerup', f.doc.body, 90, 70, 0);
    assert.equal(f.doc.querySelectorAll('.tb-draw').length, 0, 'no draft rectangle');
    assert.equal(f.doc.querySelector('.tb-popup'), null, 'and no popup was opened either');
    assert.equal(f.core.listComments().length, 0, 'and nothing was committed');
  } finally { f.restore(); }
});

test('panel: the same drag beginning on the CONTENT does start one', () => {
  // the counterpart, so the test above is known to be measuring the guard rather than a fixture
  // that could never have produced a draft in the first place.
  const f = mountPanel();
  try {
    const p = f.doc.createElement('p'); p.id = 'para'; p.textContent = 'content';
    f.root.appendChild(p);
    const fire = (type, over, x, y, buttons) =>
      over.dispatchEvent({ type, button: 2, buttons, clientX: x, clientY: y, pointerId: 2 });
    fire('pointerdown', p, 10, 10, 2);
    fire('pointermove', p, 90, 70, 2);
    assert.equal(f.doc.querySelectorAll('.tb-draw').length, 1, 'a drag over content does draw one');
  } finally { f.restore(); }
});

test('panel: destroy() takes the lane with it', () => {
  const f = mountPanel();
  try {
    assert.ok(f.lane());
    f.panel.destroy();
    assert.equal(f.lane(), null, 'no chrome outlives the panel that owns it');
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
      if (e.target.closest?.('.tb-lane')) {
        sawControlClick = true;
        f.core.listComments().forEach((x) => { if (x.anchor.type === 'document') f.core.setAnchorAttention(x.id, false); });
      }
    });
    f.laneHead().click();
    assert.equal(sawControlClick, true, 'the click reached the page-level listener');
    assert.equal(f.core.hasAttention(c.id), false, 'so the page could clear its own notice');
    assert.equal(f.lane().classList.contains('tb-attn'), false, 'and the lane drops the tint');
  } finally { f.restore(); }
});

test('panel: an open Pane follows the transport when it changes underneath it', () => {
  const f = mountPanel({ controls: { docLane: false } });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    f.panel.openDocumentThread();
    const save = () => f.doc.querySelector('.tb-save');
    assert.equal(save().textContent, 'Save', 'no transport attached yet');
    f.core.setTransport({ interactive: true });
    assert.equal(save().textContent, 'Send', 'the open Pane relabels rather than going stale');
    f.core.setTransport(null);
    assert.equal(save().textContent, 'Save');
  } finally { f.restore(); }
});

test('panel: a transport change moves close-vs-stay-open too, not just the label', () => {
  // relabelling alone would pass the test above while the commit still closed a conversation, or
  // left a note-taking Pane open — the label is the visible half of one policy.
  const f = mountPanel({ controls: { docLane: false } });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'seed' });
    f.panel.openDocumentThread();                        // opened with NO transport → Save + close
    f.core.setTransport({ interactive: true });          // …now a conversation
    const ta = f.doc.querySelector('.tb-popup').querySelector('textarea');
    ta.value = 'first'; ta.dispatchEvent({ type: 'input' });
    f.doc.querySelector('.tb-save').click();
    assert.ok(f.doc.querySelector('.tb-popup'), 'commit now STAYS open, following the new descriptor');
    // and back the other way
    f.core.setTransport(null);
    const ta2 = f.doc.querySelector('.tb-popup').querySelector('textarea');
    ta2.value = 'second'; ta2.dispatchEvent({ type: 'input' });
    f.doc.querySelector('.tb-save').click();
    assert.equal(f.doc.querySelector('.tb-popup'), null, 'and closes again once the transport is gone');
  } finally { f.restore(); }
});

test('panel: Cmd/Ctrl+Enter commits, and only when the button would', () => {
  // this binding was silently dropped during the conversation-view extraction and no test noticed,
  // which is the whole argument for pinning it here.
  const f = mountPanel({ controls: { docLane: false } });
  try {
    f.panel.openDocumentThread();
    const ta = f.doc.querySelector('.tb-popup').querySelector('textarea');   // the fixture matches simple selectors only
    const send = (mods) => ta.dispatchEvent({ type: 'keydown', key: 'Enter', ...mods });
    send({ metaKey: true });
    assert.equal(f.core.listComments().length, 0, 'an empty box commits nothing');
    ta.value = 'typed'; ta.dispatchEvent({ type: 'input' });
    send({ metaKey: false, ctrlKey: false });
    assert.equal(f.core.listComments().length, 0, 'plain Enter is a newline, not a commit');
    send({ metaKey: true });
    assert.equal(f.core.listComments().length, 1, 'Cmd+Enter commits');
    assert.equal(f.core.listComments()[0].body, 'typed');
  } finally { f.restore(); }
});

// --- what a host that never dies needs, and the popup never did ---------------------------------

test('lane: a local Save clears the composer instead of leaving it loaded', () => {
  // the popup got away with skipping the reset because it was about to be destroyed. A host that
  // stays kept the committed text in an enabled box, ready to be sent a second time.
  const f = mountPanel();
  try {
    const ta = f.lane().querySelector('textarea');
    const save = f.lane().querySelector('.tb-save');
    ta.value = 'said once'; ta.dispatchEvent({ type: 'input' });
    save.click();
    assert.equal(f.core.listComments().length, 1);
    assert.equal(ta.value, '', 'the composer is empty again');
    assert.equal(save.disabled, true, 'and cannot re-send what was already sent');
    save.click();
    assert.equal(f.core.listComments().length, 1, 'so a second click commits nothing');
  } finally { f.restore(); }
});

test('lane: a deleted comment loses its row, not just its place in the count', () => {
  // reconciliation was insertion-only. The popup survived that because every destructive path
  // closes it first; a persistent host would have shown the comment forever.
  const f = mountPanel();
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'to be removed' });
    f.laneHead().click();
    assert.equal(f.lane().querySelectorAll('.tb-c').length, 1);
    f.core.deleteComment(c.id);
    assert.equal(f.lane().querySelectorAll('.tb-c').length, 0, 'the row goes with the comment');
    assert.equal(f.laneCount(), '', 'and so does the count');
  } finally { f.restore(); }
});

test('lane: it follows a transport change, like any other conversation on screen', () => {
  // the panel used to fan out to a single slot that only an open popup ever filled, so a second
  // host silently kept whatever policy it was built with.
  const f = mountPanel();
  try {
    const save = () => f.lane().querySelector('.tb-save');
    assert.equal(save().textContent, 'Save');
    f.core.setTransport({ interactive: true });
    assert.equal(save().textContent, 'Send', 'the lane relabels too, not just a popup');
    f.core.setTransport(null);
    assert.equal(save().textContent, 'Save');
  } finally { f.restore(); }
});

test('lane: it re-tints when the participant colour map changes', () => {
  const f = mountPanel();
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'x', author: { id: 'a', kind: 'ai' } });
    f.laneHead().click();
    const row = () => f.lane().querySelector('.tb-c');
    f.panel.setActorColors({ ai: '#123456' });
    assert.match(row().style.borderLeft, /#123456/, 'existing rows follow the new map');
    f.panel.setActorColors({ ai: '#654321' });
    assert.match(row().style.borderLeft, /#654321/);
  } finally { f.restore(); }
});

test('lane: its entry point is a real button, and announces whether it is expanded', () => {
  // the control it replaced was a <button>; focusability, Enter/Space and the announced state come
  // with the element rather than having to be rebuilt on a div.
  const f = mountPanel();
  try {
    const head = f.laneHead();
    assert.equal(head.tagName, 'BUTTON');
    assert.equal(head.getAttribute('type'), 'button');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    head.click();
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    head.click();
    assert.equal(head.getAttribute('aria-expanded'), 'false');
  } finally { f.restore(); }
});

test('lane: a host\'s own right-side reservation is not overwritten by the panel measurement', () => {
  // the two reservations are added, not merged: writing the measured panel width into the PUBLIC
  // property would silently discard whatever the host declared, while the docs promise it works.
  const f = mountPanel();
  try {
    const style = f.lane().style;
    assert.ok(style['--tb-panel-reserve'], 'the panel measurement is published…');
    assert.equal(style['--tb-lane-right'], undefined, '…and never as the host-facing property');
  } finally { f.restore(); }
});
