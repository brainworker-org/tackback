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
    // A real DOMTokenList is iterable and has a length. Without those, code that walks the classes on
    // an element — to clear a whole namespace, say — silently walks nothing here while working in a
    // browser, which is the worst shape a fixture gap can take.
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
      get length() { return classes.size; },
      item: (i) => [...classes][i] ?? null,
      [Symbol.iterator]: () => classes.values(),
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get id() { return attrs.id || ''; },
    set id(v) { attrs.id = v; },
    setAttribute(k, v) { attrs[k] = String(v); },
    get attributes() { return { ...attrs }; },
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
    // Pointer capture was invisible to every test here: the fixture implemented neither call, so the
    // panel's `?.` calls silently did nothing and a capture retained past teardown could not be seen.
    setPointerCapture(id) { (el.ownerDocument.captures ||= new Set()).add(id); },
    releasePointerCapture(id) { el.ownerDocument.captures?.delete(id); },
    querySelectorAll(sel) { return descendants(el).filter((d) => matches(d, sel)); },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { return bubble(el, { ...ev, target: ev.target || el }); },
    click() { bubble(el, { type: 'click', target: el, stopPropagation() {} }); },
    // A browser only focuses an element that is IN the document. Checking the immediate parent is not
    // the same thing: a detached modal's textarea has a parent, so activation before mounting looked
    // like it worked.
    focus() { let n = el; while (n.parentNode) n = n.parentNode; if (n !== doc.documentElement) return; doc.activeElement = el; },
    select() { if (doc.activeElement !== el) return; el.selected = true; },
    blur() { if (doc.activeElement === el) doc.activeElement = null; },
    clientWidth: 100, clientHeight: 100, offsetWidth: 100, offsetHeight: 100, value: '',
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
    // `onclick` is a CLICK handler. Firing it for every event type meant a right-click on a mark ran
    // the mark's left-click handler, whose `stopPropagation()` then kept the event from ever reaching
    // the document — so the anchor menu could not be opened from a test at all.
    if (e.type === 'click') node.onclick?.(e);
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
    createRange: () => ({
      startContainer: null, endContainer: null,
      setStart(n, o) { this.startContainer = n; this.startOffset = o; },
      setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 20, bottom: 12, width: 20, height: 12 }),
    }),
    listeners: {},
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { doc.listeners[t] = (doc.listeners[t] || []).filter((f) => f !== fn); },
  };
  doc.captures = new Set();
  doc.activeElement = null;
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
globalThis.getComputedStyle = (elx) => ({ position: elx?.style?.position || 'static' });

/**
 * Stand in for the globals the panel reaches for, so the work it schedules and the observers and
 * non-document listeners it installs are countable. Without this a teardown test can only see the
 * document, which is the smaller half of what a panel owns.
 */
function instrumentEnv({ noRaf = false } = {}) {
  const saved = {
    raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame,
    RO: globalThis.ResizeObserver, add: globalThis.addEventListener, rm: globalThis.removeEventListener,
    st: globalThis.setTimeout, ct: globalThis.clearTimeout,
    mm: globalThis.matchMedia, vv: globalThis.visualViewport,
    qm: globalThis.queueMicrotask, err: console.error,
  };
  // A count is not an identity. One listener removed and a different one added of the same type
  // returns every total to its baseline while ownership is wrong, so the bags carry identity too.
  // The number is stable for the same function object, which is all a before/after comparison needs.
  const marks = new WeakMap();
  let nextMark = 0;
  const idOf = (fn) => {
    if (typeof fn !== 'function' && typeof fn !== 'object') return String(fn);
    if (!marks.has(fn)) marks.set(fn, ++nextMark);
    return `fn${marks.get(fn)}`;
  };
  const listenerBag = () => {
    const m = new Map();
    return {
      add: (t, fn) => { if (!m.has(t)) m.set(t, []); m.get(t).push(fn); },
      remove: (t, fn) => m.set(t, (m.get(t) || []).filter((f) => f !== fn)),
      count: () => [...m.values()].reduce((n, a) => n + a.length, 0),
      identity: () => [...m.entries()].flatMap(([t, a]) => a.map((f) => `${t}:${idOf(f)}`)).sort(),
    };
  };
  const env = { frames: new Map(), timers: new Map(), observers: new Set(), ran: [], micro: [], handlerErrors: [] };
  env.idOf = idOf;
  const savedCSS = globalThis.CSS, savedHighlight = globalThis.Highlight;
  globalThis.CSS = { highlights: new Map() };
  globalThis.Highlight = class { constructor(...r) { this.ranges = r; } };
  const win = listenerBag(), vv = listenerBag(), mql = listenerBag();
  env.win = win; env.vv = vv; env.mql = mql;
  let seq = 0;
  if (noRaf) {
    // Not every host has requestAnimationFrame; the panel falls back to a timer, whose handle
    // `cancelAnimationFrame` cannot take back. That is the one arrangement in which the callback
    // actually runs after teardown, so it is the only place the guard inside it is reachable.
    delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;
  } else {
    globalThis.requestAnimationFrame = (fn) => { const id = ++seq; env.frames.set(id, fn); env.ran.push(fn); return id; };
    globalThis.cancelAnimationFrame = (id) => { env.frames.delete(id); };
  }
  // Deferred registrations are the whole point of several of these tests; without a countable timer
  // they are invisible, and a test can only observe what happened to fire on the real clock.
  globalThis.setTimeout = (fn, ms) => { const id = ++seq; env.timers.set(id, fn); env.ran.push(fn); return id; };
  globalThis.clearTimeout = (id) => { env.timers.delete(id); };
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; this.targets = []; env.observers.add(this); }
    observe(t) { this.targets.push(t); }
    disconnect() { env.observers.delete(this); }
  };
  globalThis.addEventListener = (t, fn) => win.add(t, fn);
  globalThis.removeEventListener = (t, fn) => win.remove(t, fn);
  // `vv` is null in the plain fixture, so the panel's four viewport registrations were never once
  // executed under test — the same blind spot as measuring a guard with the feature switched off.
  globalThis.visualViewport = { addEventListener: vv.add, removeEventListener: vv.remove, height: 768, offsetTop: 0 };
  globalThis.matchMedia = () => ({ matches: false, addEventListener: mql.add, removeEventListener: mql.remove });
  // Work deferred to the microtask boundary is invisible to a test that can only wait on the real
  // queue: it runs between assertions rather than where the test asks for it. A queue the test drains
  // itself is the only way to say "now the boundary has been reached" and mean it.
  globalThis.queueMicrotask = (fn) => { env.micro.push(fn); env.ran.push(fn); };
  // The emitter isolates a throwing subscriber and reports it to the console, which means an
  // assertion that fails inside a handler is swallowed and its test passes regardless. Capturing the
  // report is what turns that back into a failure — see `assertNoHandlerErrors`.
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[tackback]')) { env.handlerErrors.push(args); return; }
    saved.err(...args);
  };

  /**
   * Run queued microtasks until the queue stays empty. A flush that schedules another flush is the
   * design here, so draining once is not reaching the boundary; the cap turns a scheduling loop into
   * a named failure instead of a hung suite.
   */
  env.drainMicrotasks = (cap = 50) => {
    let rounds = 0;
    while (env.micro.length) {
      if (++rounds > cap) throw new Error(`microtask queue did not settle within ${cap} rounds`);
      const fns = env.micro.slice(); env.micro.length = 0;
      fns.forEach((f) => f());
    }
    return rounds;
  };
  /** Fail if any subscriber threw — including an assertion the emitter's try/catch would have eaten. */
  env.assertNoHandlerErrors = (where = 'handlers') => {
    if (!env.handlerErrors.length) return;
    const [first] = env.handlerErrors;
    const cause = first[first.length - 1];
    throw new Error(`${where}: a subscriber threw and the emitter swallowed it — ${cause?.message || cause}`, { cause });
  };

  env.flushFrames = () => { const fns = [...env.frames.values()]; env.frames.clear(); fns.forEach((f) => f()); };
  env.flushTimers = () => { const fns = [...env.timers.values()]; env.timers.clear(); fns.forEach((f) => f()); };
  env.flush = () => { env.flushTimers(); env.flushFrames(); env.drainMicrotasks(); };
  /** Run EVERY callback that was ever scheduled, including ones since cancelled. */
  env.runStale = () => { const fns = env.ran.slice(); env.ran.length = 0; env.frames.clear(); env.timers.clear(); env.micro.length = 0; fns.forEach((f) => { try { f(); } catch { /* a stale callback may legitimately throw */ } }); };
  /** Everything the environment can count, as one comparable snapshot. */
  env.census = (doc) => ({
    docListeners: Object.fromEntries(Object.entries(doc.listeners).map(([t, a]) => [t, a.length]).filter(([, n]) => n)),
    windowListeners: win.count(), viewportListeners: vv.count(), mediaQueryListeners: mql.count(),
    observers: env.observers.size, pendingFrames: env.frames.size, pendingTimers: env.timers.size,
    pendingMicrotasks: env.micro.length,
    // The same registrations again, by identity rather than by total. A count returning to its
    // baseline says nothing about WHOSE listener is installed; these say which function is on which
    // target, so releasing one and installing another cannot pass as a clean teardown.
    docListenerIds: Object.entries(doc.listeners).flatMap(([t, a]) => a.map((f) => `${t}:${idOf(f)}`)).sort(),
    windowListenerIds: win.identity(), viewportListenerIds: vv.identity(), mediaQueryListenerIds: mql.identity(),
    observerTargets: [...env.observers].map((o) => o.targets.map((t) => `${t?.tagName || '?'}#${t?.id || ''}`).sort().join(',')).sort(),
    captures: [...doc.captures].sort(),
    headChildren: (doc.head.children || []).filter((c) => c.tagName).length,
    bodyChildren: (doc.body.children || []).filter((c) => c.tagName).map((c) => `${c.tagName}.${c.className || ''}`).sort(),
    rootClass: doc.documentElement.className, rootAttrs: { ...(doc.documentElement.attributes || {}) },
    // What the panel wrote onto elements the HOST owns. Two of this change's headline fixes live
    // here — the mark class and the inline positioning context — and neither was being measured.
    // EVERY element, with nothing skipped. An earlier version skipped anything carrying a `tb-`
    // class, which excluded precisely what it was added to watch: a host element left wearing the
    // mark class. There is no need to exempt panel-owned subtrees either — the census is taken
    // before the panel attaches and after it is destroyed, so a surviving panel node SHOULD make the
    // comparison fail.
    host: (function walk(node, out) {
      for (const c of node.children || []) {
        if (!c.tagName) continue;
        out.push(`${c.tagName}#${c.id}|${c.className}|${c.style.position || ''}|${JSON.stringify(c.attributes || {})}`);
        walk(c, out);
      }
      return out;
    })(doc.body, [`BODY#|${doc.body.className}|${doc.body.style.position || ''}|${JSON.stringify(doc.body.attributes || {})}`]).sort(),
    highlights: [...(globalThis.CSS?.highlights?.keys?.() || [])].sort(),
  });
  env.restore = () => {
    globalThis.requestAnimationFrame = saved.raf; globalThis.cancelAnimationFrame = saved.caf;
    globalThis.setTimeout = saved.st; globalThis.clearTimeout = saved.ct;
    globalThis.ResizeObserver = saved.RO; globalThis.addEventListener = saved.add;
    globalThis.removeEventListener = saved.rm;
    globalThis.matchMedia = saved.mm; globalThis.visualViewport = saved.vv;
    globalThis.queueMicrotask = saved.qm; console.error = saved.err;
    globalThis.CSS = savedCSS; globalThis.Highlight = savedHighlight;
  };
  return env;
}

/** Mount a core + panel on a fresh fake document. Returns everything a test needs to drive it. */
function mountPanel({ comments = [], controls, instrument = false, setup, noRaf = false } = {}) {
  const env = instrument ? instrumentEnv({ noRaf }) : null;
  const doc = fakeDoc();
  // mount on the body, as a page with no explicit root does — that is what puts the lane INSIDE the
  // gesture root, which is the only geometry in which the lane's gesture guard can be exercised.
  const root = doc.body;
  // a storage adapter that seeds the store WITHOUT validation — the path a persisted comment takes
  const storage = { load: () => ({ comments }), save: () => {} };
  const core = Tackback.mount({ document: { id: 'panel-fixture' }, storage, root });
  // Page content the test needs is added BEFORE the panel attaches, so the baseline below includes
  // it and the meter measures the panel's footprint rather than the fixture's.
  setup?.(doc, root, core);
  // Taken after the core is mounted and after the host page exists, and before the panel attaches.
  const before = env ? env.census(doc) : null;
  const panel = attachPanel(core, { root, target: doc.body, ...(controls ? { controls } : {}) });
  const restore = () => { env?.restore(); };
  const lane = () => doc.querySelector('.tb-lane');
  const laneHead = () => lane()?.querySelector('.tb-lane-head') || null;
  const laneCount = () => lane()?.querySelector('.tb-lane-count')?.textContent ?? null;
  const laneOpen = () => !!lane()?.classList.contains('tb-open');
  const badges = () => doc.querySelectorAll('.tb-badge,.tb-pin');
  /**
   * The acceptance invariant: after destroy, every count the environment can take is back where it
   * was before the panel attached. Measured from OUTSIDE the panel on purpose — asking the panel's
   * own bookkeeping whether it cleaned up verifies the mechanism with the mechanism, and an
   * acquisition that bypassed the seam would be invisible to it.
   *
   * Exempt by contract: the element IDS assigned to elements that had none, and the identity mark on
   * a region's surface. A stored comment names its element by id, so removing those would orphan the
   * anchors that depend on them. The other indexing marks are NOT exempt and are measured here.
   */
  const assertEnvironmentRestored = (where) => {
    // TWO measurements, because one hid the thing it was meant to reveal. Flushing before counting
    // executes and empties the pending work, so `pendingTimers` and `pendingFrames` could never
    // report anything left scheduled at the moment of teardown.
    // Microtasks are the exception, and only they: work deferred to the microtask boundary is still
    // THIS turn, so "at the moment of teardown" for it means "once the boundary is reached". Teardown
    // deliberately schedules there — a display's last word is that it is showing nothing — so a queue
    // that is empty here would mean that word was never spoken. Frames and timers are next-turn work
    // that teardown is supposed to have CANCELLED, which is why they are still measured un-run.
    env.drainMicrotasks();
    assert.deepEqual(env.census(doc), before, `${where}: not given back at the moment of teardown`);
    // …and then run every callback that was ever scheduled, INCLUDING the ones teardown cancelled.
    // Flushing alone proves cancellation, because cancelling removes the callback from the queue —
    // it says nothing about whether a callback something else already dequeued is inert.
    env.runStale();
    assert.deepEqual(env.census(doc), before, `${where}: a stale callback still had an effect`);
  };
  return { doc, root, core, panel, lane, laneHead, laneCount, laneOpen, badges, restore, env, before, assertEnvironmentRestored };
}

// ---- invariants -------------------------------------------------------------------------------
// Properties that must hold however you got here. Example tests can only encode the paths someone
// thought of; these are checked at the end of the lifecycle tests, so a path nobody wrote a scenario
// for still cannot leave the document holding the panel's leftovers.
const PANEL_SELECTORS = '.tb-panel,.tb-popup,.tb-lane,.tb-ctxmenu,.tb-badge,.tb-pin,.tb-region,.tb-pending,.tb-draw';

/** After destroy the panel owns nothing: no node of its own, and no listener on the document. */
function assertFullyGone(f, where) {
  const left = PANEL_SELECTORS.split(',').flatMap((sel) => f.doc.querySelectorAll(sel));
  assert.deepEqual(left.map((e) => e.className), [], `${where}: no panel node may outlive destroy`);
  for (const type of ['mousedown', 'keydown', 'contextmenu', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.deepEqual(f.doc.listeners[type] || [], [], `${where}: no ${type} listener may outlive destroy`);
  }
}

/** At most one of each singleton surface, ever. */
function assertAtMostOne(f, where) {
  for (const sel of ['.tb-popup', '.tb-ctxmenu', '.tb-lane', '.tb-panel']) {
    assert.ok(f.doc.querySelectorAll(sel).length <= 1, `${where}: more than one ${sel} on screen`);
  }
}

const docComment = (over = {}) => ({
  id: 'd1', anchor: { type: 'document' }, body: 'about the whole thing',
  createdAt: '2026-08-06T10:00:00.000Z', ...over,
});

// ---- the instrument, measured by something other than itself -----------------------------------
//
// These tests are about the harness, not the panel. A meter that cannot be made to read wrong is not
// evidence that the thing it measures is right, and every capability below exists to catch a defect
// class that the previous harness reported as clean. So each one is exercised against a deliberate
// fault first: if these pass while the fault is present, the capability is decoration.

test('harness: an assertion that fails inside a subscriber is reported, not swallowed', () => {
  const f = mountPanel({ instrument: true });
  try {
    f.core.on('comment:add', () => { assert.equal(1, 2, 'deliberate'); });
    f.core.addComment({ anchor: { type: 'document' }, body: 'x' });
    // The emitter isolates a throwing subscriber, so the failure above did NOT propagate: this line
    // is reached, and without the capture the test would end green having asserted a falsehood.
    assert.throws(() => f.env.assertNoHandlerErrors('subscriber'), /swallowed/);
  } finally { f.restore(); }
});

test('harness: with no subscriber throwing, the same check stays silent', () => {
  const f = mountPanel({ instrument: true });
  try {
    f.core.on('comment:add', () => {});
    f.core.addComment({ anchor: { type: 'document' }, body: 'x' });
    f.env.assertNoHandlerErrors('subscriber');
  } finally { f.restore(); }
});

test('harness: draining reaches the boundary even when a microtask schedules another', () => {
  const f = mountPanel({ instrument: true });
  try {
    const order = [];
    queueMicrotask(() => { order.push('first'); queueMicrotask(() => order.push('second')); });
    assert.deepEqual(order, [], 'nothing runs until the test asks for the boundary');
    const rounds = f.env.drainMicrotasks();
    assert.deepEqual(order, ['first', 'second'], 'work scheduled from the drain still ran');
    assert.ok(rounds >= 2, 'a single pass would have stopped after "first"');
  } finally { f.restore(); }
});

test('harness: a microtask that reschedules itself forever fails by name, not by hanging', () => {
  const f = mountPanel({ instrument: true });
  try {
    const again = () => queueMicrotask(again);
    queueMicrotask(again);
    assert.throws(() => f.env.drainMicrotasks(5), /did not settle within 5 rounds/);
  } finally { f.restore(); }
});

test('harness: the census sees a listener swapped for another of the same type', () => {
  const f = mountPanel({ instrument: true });
  try {
    const mine = () => {};
    f.doc.addEventListener('keydown', mine);
    const before = f.env.census(f.doc);
    f.doc.removeEventListener('keydown', mine);
    f.doc.addEventListener('keydown', () => {});
    const after = f.env.census(f.doc);
    assert.deepEqual(after.docListeners, before.docListeners, 'the totals are identical — this is the blind spot');
    assert.notDeepEqual(after.docListenerIds, before.docListenerIds, 'identity is what tells the two apart');
  } finally { f.restore(); }
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

// ---- deleting a whole anchor, and clearing the document, are each ONE act ----------------------

test('panel: deleting an anchor removes all its comments as one operation', () => {
  // The panel used to loop `deleteComment` per comment, so an integrator watching the seam saw N
  // indistinguishable deletions and could not tell where one act ended — which is what the anchor
  // menu is: one act. This is the panel half of the `deleteComments` claim; without it the changelog
  // sentence "the panel's delete anchor and clear all now use it" has nothing behind it.
  const f = mountPanel();
  try {
    const p = f.doc.createElement('p'); p.id = 'para'; p.textContent = 'content';
    p.setAttribute('data-tb-anchor', '');
    f.root.appendChild(p);
    const a = f.core.addComment({ anchor: { type: 'block', elementId: 'para' }, body: 'first' });
    const b = f.core.addComment({ anchor: { type: 'block', elementId: 'para' }, body: 'second' });
    const batches = [], singles = [], changes = [];
    f.core.on('comments:delete', (e) => batches.push(e));
    f.core.on('comment:delete', (e) => singles.push(e.id));
    f.core.on('change', () => changes.push(1));

    const badge = f.badges()[0];
    assert.ok(badge, 'the anchor has a mark to right-click');
    assert.ok(badge.__tbComments, 'and the mark carries its thread');
    badge.dispatchEvent({ type: 'contextmenu', clientX: 10, clientY: 10, preventDefault() {} });
    const item = f.doc.querySelector('.tb-ctxitem');
    assert.ok(item, 'right-clicking a mark opens the anchor menu');
    item.click();

    assert.equal(batches.length, 1, 'one act, one batch event');
    assert.deepEqual(batches[0].ids.slice().sort(), [a.id, b.id].sort());
    assert.deepEqual(batches[0].previous.map((c) => c.body).slice().sort(), ['first', 'second']);
    assert.deepEqual(singles.slice().sort(), [a.id, b.id].sort(), 'per-comment events still fire');
    assert.equal(changes.length, 1, 'and the store settles once, not once per comment');
    assert.equal(f.core.listComments().length, 0);
  } finally { f.restore(); }
});

test('panel: clearing the document is one operation too', () => {
  const f = mountPanel({ controls: { clear: true } });
  try {
    const prevConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      f.core.addComment({ anchor: { type: 'document' }, body: 'one' });
      f.core.addComment({ anchor: { type: 'document' }, body: 'two' });
      const batches = [], changes = [];
      f.core.on('comments:delete', (e) => batches.push(e));
      f.core.on('change', () => changes.push(1));
      const clear = f.doc.querySelectorAll('.tb-sec').filter((b) => /clear/i.test(b.textContent))[0];
      assert.ok(clear, 'the clear control is on the panel');
      clear.click();
      assert.equal(batches.length, 1, 'clearing a document is one act, not one per comment');
      assert.equal(batches[0].ids.length, 2);
      assert.equal(changes.length, 1, 'and it settles once');
      assert.equal(f.core.listComments().length, 0);
    } finally { globalThis.confirm = prevConfirm; }
  } finally { f.restore(); }
});

// ---- the panel's own lifetime -------------------------------------------------------------------

test('panel: destroy leaves nothing behind, and is idempotent', async () => {
  const f = mountPanel();
  try {
    const p = f.doc.createElement('p'); p.id = 'para-life'; p.textContent = 'content';
    p.setAttribute('data-tb-anchor', '');
    f.root.appendChild(p);
    f.core.addComment({ anchor: { type: 'block', elementId: 'para-life' }, body: 'here' });
    f.core.addComment({ anchor: { type: 'document' }, body: 'about it all' });
    f.panel.toggleDocumentLane(true);
    f.badges()[0].dispatchEvent({ type: 'contextmenu', clientX: 5, clientY: 5, preventDefault() {} });
    assert.ok(f.doc.querySelector('.tb-ctxmenu'), 'a menu is open when destroy runs');

    f.panel.destroy();
    await new Promise((r) => setTimeout(r, 0));   // let any deferred registration fire
    assertFullyGone(f, 'after destroy');
    // asserted HERE, where the lane exists: with the lane off, toggling answers false whether or not
    // the panel is destroyed, so the guard would be invisible.
    assert.equal(f.panel.toggleDocumentLane(true), false, 'a destroyed lane cannot be re-expanded');
    assertFullyGone(f, 'after trying to re-expand the lane');
    f.panel.destroy();                            // twice must not throw or resurrect anything
    assertFullyGone(f, 'after a second destroy');
  } finally { f.restore(); }
});

test('panel: no public method revives a destroyed panel', async () => {
  // destroy() removes the stylesheet, so anything built afterwards is unstyled chrome the host
  // never asked for and cannot get rid of. Every entry point has to be closed, not just the ones
  // someone remembered.
  //
  // The lane is OFF on purpose: with it on, `openDocumentThread` expands the (already detached) lane
  // and adds no node, so the guard would be invisible to this test. Off, it builds a Pane — which is
  // the thing that must not appear.
  const f = mountPanel({ controls: { docLane: false } });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    f.panel.destroy();
    f.panel.openDocumentThread();
    assert.equal(f.panel.toggleDocumentLane(true), false, 'and it says it did nothing');
    f.panel.setTheme('dark');
    f.panel.setActorColors({ ai: '#123456' });
    f.panel.setReactions([{ id: 'x', icon: '?' }]);
    f.panel.setLocale('ja');
    f.panel.registerLocale('xx', {});
    f.panel.toggleMarks();
    await new Promise((r) => setTimeout(r, 0));
    assertFullyGone(f, 'after calling every public method on a destroyed panel');
  } finally { f.restore(); }
});

test('panel: an anchor menu closed before its registration runs registers nothing', async () => {
  // Same deferred-ownership shape the Pane has: the dismiss handlers register from a deferred callback, backed by
  // a single cleanup slot, so a menu that is gone — or superseded — by the time the deferred callback runs
  // leaves listeners on the document that nothing can ever remove.
  const f = mountPanel();
  try {
    const p = f.doc.createElement('p'); p.id = 'para-menu'; p.textContent = 'content';
    p.setAttribute('data-tb-anchor', '');
    f.root.appendChild(p);
    f.core.addComment({ anchor: { type: 'block', elementId: 'para-menu' }, body: 'here' });
    const badge = f.badges()[0];
    badge.dispatchEvent({ type: 'contextmenu', clientX: 5, clientY: 5, preventDefault() {} });
    f.doc.querySelector('.tb-ctxitem').click();   // deleting closes the menu, within the same tick
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.doc.listeners.mousedown || [], [], 'the menu registered nothing on its way out');
    assert.deepEqual(f.doc.listeners.keydown || [], []);
  } finally { f.restore(); }
});

test('panel: an anchor menu replaced within the same tick takes its registration with it', async () => {
  const f = mountPanel();
  try {
    for (const id of ['m1', 'm2']) {
      const p = f.doc.createElement('p'); p.id = id; p.textContent = 'content ' + id;
      p.setAttribute('data-tb-anchor', '');
      f.root.appendChild(p);
      f.core.addComment({ anchor: { type: 'block', elementId: id }, body: 'on ' + id });
    }
    const [a, b] = f.badges();
    a.dispatchEvent({ type: 'contextmenu', clientX: 5, clientY: 5, preventDefault() {} });
    b.dispatchEvent({ type: 'contextmenu', clientX: 9, clientY: 9, preventDefault() {} });
    assertAtMostOne(f, 'two menus opened in one tick');
    await new Promise((r) => setTimeout(r, 0));
    f.doc.querySelector('.tb-ctxmenu').querySelector('.tb-ctxitem').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.doc.listeners.mousedown || [], [], 'the replaced menu registered nothing');
    assert.deepEqual(f.doc.listeners.keydown || [], []);
  } finally { f.restore(); }
});

test('panel: destroy during a region drag takes the draft rectangle with it', async () => {
  // A draft rectangle is drawn while the gesture is in flight and only becomes a pending region on
  // commit, so it is the one mark `closePopup()` does not own. Tearing the panel down mid-drag left
  // it on the page: a dashed box the host has no handle to remove.
  const f = mountPanel();
  try {
    const p = f.doc.createElement('p'); p.id = 'drag-target'; p.textContent = 'content';
    f.root.appendChild(p);
    const fire = (type, x, y, buttons) =>
      p.dispatchEvent({ type, button: 2, buttons, clientX: x, clientY: y, pointerId: 21 });
    fire('pointerdown', 10, 10, 2); fire('pointermove', 90, 70, 2);
    assert.equal(f.doc.querySelectorAll('.tb-draw').length, 1, 'a draft rectangle is on screen');
    f.panel.destroy();
    await new Promise((r) => setTimeout(r, 0));
    assertFullyGone(f, 'destroyed mid-drag');
  } finally { f.restore(); }
});

test('panel: destroy gives the environment back, whatever was in flight', async () => {
  // The acceptance invariant for the panel's ownership. Not "the nodes I remembered to list are
  // gone" — every count the environment can take, back where it was before the panel attached.
  const f = mountPanel({
    instrument: true,
    setup: (doc, root) => {
      const p = doc.createElement('p'); p.id = 'own'; p.textContent = 'content';
      p.setAttribute('data-tb-anchor', '');
      root.appendChild(p);
    },
  });
  try {
    const p = f.doc.getElementById('own');
    f.core.addComment({ anchor: { type: 'block', elementId: 'own' }, body: 'x' });
    f.panel.toggleDocumentLane(true);
    f.badges()[0].dispatchEvent({ type: 'contextmenu', clientX: 5, clientY: 5, preventDefault() {} });
    const fire = (t, x, y, b) => p.dispatchEvent({ type: t, button: 2, buttons: b, clientX: x, clientY: y, pointerId: 41 });
    fire('pointerdown', 10, 10, 2); fire('pointermove', 90, 70, 2);   // a gesture holding capture
    [...f.env.observers][0]?.fn?.();                                   // a repaint queued
    f.panel.destroy();
    f.assertEnvironmentRestored('destroy with a menu open, a gesture in flight and a frame queued');
  } finally { f.restore(); }
});

test('panel: a Pane replaced before its deferred callback fires leaves no listener behind', async () => {
  // The deferred-ownership shape, on the Pane this time. `popupCleanup` holds one remover, so if the
  // Pane that scheduled the registration has been replaced by the time the deferred callback runs, the loser's
  // listeners can never come off. Asking whether SOME Pane exists cannot tell replaced from closed.
  const f = mountPanel({ instrument: true, controls: { docLane: false } });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'q' });
    f.panel.openDocumentThread();
    f.panel.openDocumentThread();   // replaces the first, before either has registered
    f.env.flushTimers();
    f.doc.querySelector('.tb-cancel').click();
    // The loser's listeners went straight onto the document rather than through the panel's own
    // seam, so nothing but this Pane could ever have removed them — teardown is where that shows.
    f.panel.destroy();
    f.assertEnvironmentRestored('a Pane opened twice in one tick, dismissed, then destroyed');
  } finally { f.restore(); }
});

test('panel: a modal is a surface — one at a time, and it goes when the panel does', async () => {
  // They used to be unclassed children appended straight to the body: outside every sweep and every
  // count, stacking one per click, and an import modal opened before teardown could still write into
  // the core afterwards.
  const f = mountPanel({ instrument: true, controls: { export: true, import: true } });
  try {
    const buttons = f.doc.querySelectorAll('.tb-sec').filter((b) => /import/i.test(b.textContent));
    const importBtn = buttons[0] || f.doc.querySelectorAll('button').filter((b) => /import/i.test(b.textContent))[0];
    assert.ok(importBtn, 'the import control is on the panel');
    importBtn.click();
    importBtn.click();
    importBtn.click();
    assert.equal(f.doc.querySelectorAll('.tb-modal').length, 1, 'three clicks, one modal');
    f.panel.destroy();
    f.assertEnvironmentRestored('destroy with a modal open');
  } finally { f.restore(); }
});

test('panel: a repaint queued on a timer does not fire after the panel is gone', async () => {
  // With requestAnimationFrame present the teardown cancels the frame outright. Without it the panel
  // falls back to a timer, whose handle cancelAnimationFrame cannot take back — so the callback does
  // run, and the only thing standing between a destroyed panel and a repaint it provokes is the
  // check inside it. It used to ask whether the CORE was alive, which says nothing about this panel.
  const f = mountPanel({ instrument: true, noRaf: true });
  try {
    const recalcs = [];
    f.core.on('recalculate', () => recalcs.push(1));
    [...f.env.observers][0]?.fn?.();          // something asks for a repaint
    assert.ok(f.env.timers.size >= 1, 'the repaint is queued on a timer');
    f.panel.destroy();
    // Teardown cancels it, so run it ON PURPOSE: the guard inside the callback is what stands between
    // a dequeued-but-stale callback and a repaint, and cancellation alone would never exercise it.
    f.env.runStale();
    assert.deepEqual(recalcs, [], 'a destroyed panel drives no repaint, even if its work runs anyway');
  } finally { f.restore(); }
});

test('panel: destroy from inside a core dispatch does not let the panel run afterwards', async () => {
  const panelRef = {};
  // The emitter snapshots its listeners before invoking them, so unsubscribing during a dispatch
  // does not take this panel out of the run already in progress. An integrator that destroys the
  // panel from its own `change` handler had the panel's handler run next anyway — re-creating marks
  // and writing to host elements after teardown. Unsubscription is not a liveness check.
  const f = mountPanel({
    instrument: true,
    setup: (doc, root, core) => {
      const p = doc.createElement('p'); p.id = 'reentry'; p.textContent = 'content';
      p.setAttribute('data-tb-anchor', '');
      root.appendChild(p);
      // Subscribed BEFORE the panel attaches, so this handler sits ahead of the panel's in the
      // snapshot the emitter takes — the only ordering in which the panel's handler runs after
      // destroy. `panel` is read lazily because it does not exist yet at this point.
      core.on('change', () => panelRef.panel?.destroy());
    },
  });
  panelRef.panel = f.panel;
  try {
    f.core.addComment({ anchor: { type: 'block', elementId: 'reentry' }, body: 'x' });
    f.assertEnvironmentRestored('destroyed from inside a core dispatch');
  } finally { f.restore(); }
});

test('panel: destroy with a Pane open gives everything back', async () => {
  // The Pane's own dismissal is a teardown seam nothing else reached.
  //
  // Releasing the CSS highlight registry is NOT covered here. This document holds text as a flat
  // property and has no tree walker, so a range anchor never resolves and the registry is never
  // populated — staging one would only add a swallowed error and the appearance of coverage. That
  // release is verified in a real browser instead.
  const f = mountPanel({
    instrument: true,
    controls: { docLane: false },
    setup: (doc, root) => {
      const p = doc.createElement('p'); p.id = 'phrase';
      p.textContent = 'a sentence with a quotable phrase inside it';
      p.setAttribute('data-tb-anchor', '');
      root.appendChild(p);
    },
  });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'about it all' });
    f.panel.openDocumentThread();
    assert.ok(f.doc.querySelector('.tb-popup'), 'a Pane is open when destroy runs');
    f.panel.destroy();
    f.assertEnvironmentRestored('destroy with a Pane open');
  } finally { f.restore(); }
});

test('panel: teardown does not overwrite an indexing mark the host changed since', async () => {
  // The indexing marks are the panel's, so it hands them back — but only where the value is still the
  // one it wrote. A host that relabels a section while the panel is alive owns that value afterwards;
  // restoring blindly would silently undo the host's own edit at teardown.
  const f = mountPanel({
    instrument: true,
    setup: (doc, root) => {
      const p = doc.createElement('p'); p.id = 'relabelled'; p.textContent = 'content';
      root.appendChild(p);
    },
  });
  try {
    const p = f.doc.getElementById('relabelled');
    assert.equal(p.getAttribute('data-tb-anchor'), '1', 'indexing marked it');
    p.setAttribute('data-tb-section', 'the host renamed this');   // the host takes it over
    // Detached BEFORE teardown: the disposer holds the element itself, so it is still handed back.
    // A version that searched the document at teardown would never find this one, and would leave
    // the panel's mark on an element the host may well re-attach.
    p.remove();
    f.panel.destroy();
    assert.equal(p.getAttribute('data-tb-section'), 'the host renamed this',
      'the value the host set is still the value the host set');
    assert.equal(p.getAttribute('data-tb-anchor'), null,
      'and the mark the panel still owned is gone');
  } finally { f.restore(); }
});

test('panel: a modal is activated after it is mounted, and cancel and close release the surface', async () => {
  // Making modals owned moved the mounting step, and focusing or selecting inside a node that is not
  // yet in the document does nothing — so activation has to come after. And a dismissal that only
  // removed the node left the panel still holding a detached surface as its one modal.
  const f = mountPanel({ instrument: true, controls: { export: true, import: true } });
  try {
    const byText = (re) => f.doc.querySelectorAll('button').filter((b) => re.test(b.textContent))[0];
    const importBtn = byText(/import/i), exportBtn = byText(/export/i);
    assert.ok(importBtn && exportBtn, 'both controls are on the panel');

    importBtn.click();
    const importModalEl = f.doc.querySelector('.tb-modal');
    assert.ok(importModalEl, 'the import modal is mounted');
    const ta = importModalEl.querySelector('textarea');
    assert.equal(f.doc.activeElement, ta, 'and its input was focused once it was in the document');

    importModalEl.querySelectorAll('button').filter((b) => /cancel/i.test(b.textContent))[0].click();
    assert.equal(f.doc.querySelectorAll('.tb-modal').length, 0, 'cancel takes the node away');
    // and the next one opens cleanly afterwards. That the SLOT was released is not observable from
    // here — opening another modal clears a stale reference on its way in either way.
    exportBtn.click();
    assert.equal(f.doc.querySelectorAll('.tb-modal').length, 1, 'exactly one, the export modal');
    const exportModalEl = f.doc.querySelector('.tb-modal');
    assert.ok(exportModalEl.querySelectorAll('button').some((b) => /close/i.test(b.textContent)),
      'the export modal has its Close button, not a stray value in its place');
    assert.equal(exportModalEl.querySelector('textarea').selected, true, 'and its text was selected');

    exportModalEl.querySelectorAll('button').filter((b) => /close/i.test(b.textContent))[0].click();
    f.panel.destroy();
    f.assertEnvironmentRestored('modals opened, dismissed, then the panel destroyed');
  } finally { f.restore(); }
});

test('panel: a marked block detached before teardown still gets its class back', async () => {
  // The census cannot see this shape: the element has left the subtree it walks. Releasing the mark
  // by searching the document would not find a block the host detached while the panel was alive,
  // and re-attaching that element later would bring the panel's class back with it.
  const f = mountPanel({
    instrument: true,
    setup: (doc, root) => {
      const p = doc.createElement('p'); p.id = 'detached'; p.textContent = 'content';
      p.setAttribute('data-tb-anchor', '');
      root.appendChild(p);
    },
  });
  try {
    const p = f.doc.getElementById('detached');
    f.core.addComment({ anchor: { type: 'block', elementId: 'detached' }, body: 'x' });
    assert.equal(p.classList.contains('tb-mark'), true, 'the block is marked while the panel is alive');
    p.remove();                     // the host takes it out of the document…
    f.panel.destroy();
    assert.equal(p.classList.contains('tb-mark'), false,
      'and it comes back without the panel\'s class on it');
  } finally { f.restore(); }
});

test('panel: a modal dismissing itself does not close the one that replaced it', async () => {
  // A successful import emits `change` synchronously. A listener that opens another modal from there
  // returns control to the import handler, which then dismisses — and an unscoped close would take
  // the replacement with it. Dismissal has to name the modal doing the dismissing, for the same
  // reason a Pane's deferred registration has to: "the current one" is a moving target.
  const f = mountPanel({ instrument: true, controls: { export: true, import: true } });
  try {
    const byText = (re) => f.doc.querySelectorAll('button').filter((b) => re.test(b.textContent))[0];
    byText(/import/i).click();
    const importModalEl = f.doc.querySelector('.tb-modal');
    let opened = false;
    f.core.on('change', () => { if (!opened) { opened = true; byText(/export/i).click(); } });
    importModalEl.querySelector('textarea').value = JSON.stringify({ comments: [] });
    importModalEl.querySelectorAll('button').filter((b) => /load|import/i.test(b.textContent))[0].click();

    assert.equal(opened, true, 'the import did emit a change, and the listener opened another modal');
    const left = f.doc.querySelectorAll('.tb-modal');
    assert.equal(left.length, 1, 'the replacement is still on screen');
    assert.ok(left[0].querySelectorAll('button').some((b) => /close/i.test(b.textContent)),
      'and it is the export modal, not the import one');
    f.panel.destroy();
    f.assertEnvironmentRestored('a modal replaced from inside its own dismissal');
  } finally { f.restore(); }
});

// ---- thread visibility: the contract, written before the mechanism ------------------------------
//
// These encode the settled decisions rather than the implementation, so they stay meaningful if the
// mechanism is rewritten. The shape they are protecting: the core announces WHICH THREADS ARE
// READABLE NOW, as a settled snapshot projected from live state at a microtask boundary — never as a
// ledger accumulated at each transition, and never from the middle of a surface mutation.

/** Subscribe without asserting inside the handler — the emitter would swallow anything that threw. */
function recordVisibility(core) {
  const seen = [];
  core.on('thread:visibility', (p) => seen.push(p));
  return seen;
}
const keysOf = (entries) => entries.map((e) => e.threadKey).sort();

test('visibility: opening a thread is announced at the boundary, not from inside the opening', () => {
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'readable' });
    const seen = recordVisibility(f.core);
    f.panel.openDocumentThread();
    assert.deepEqual(seen, [], 'nothing is emitted from inside the mutation that opened it');
    f.env.drainMicrotasks();
    assert.equal(seen.length, 1, 'exactly one report, at the boundary');
    assert.deepEqual(keysOf(seen[0].visible), ['document']);
    assert.deepEqual(keysOf(seen[0].opened), ['document']);
    assert.deepEqual(seen[0].closed, []);
    f.env.assertNoHandlerErrors('visibility subscriber');
  } finally { f.restore(); }
});

test('visibility: the pull accessor answers the same question without waiting', () => {
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    assert.deepEqual(f.core.visibleThreads(), [], 'nothing is open yet');
    f.core.addComment({ anchor: { type: 'document' }, body: 'readable' });
    f.panel.openDocumentThread();
    assert.deepEqual(keysOf(f.core.visibleThreads()), ['document'], 'answered before any boundary');
  } finally { f.restore(); }
});

test('visibility: a core with no panel has no surfaces, and says so without erroring', async () => {
  const core = Tackback.mount({ document: { id: 'headless-fixture' } });
  const seen = recordVisibility(core);
  core.addComment({ anchor: { type: 'document' }, body: 'nobody is showing this' });
  assert.deepEqual(core.visibleThreads(), [], 'a headless core shows nothing');
  // The boundary has to actually be reached before silence means anything. Asserting here and then
  // destroying would let a core that DOES emit pass, because the report it scheduled would run after
  // the assertion and return early on a destroyed instance.
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(seen, [], 'and announces nothing');
  core.destroy();
});

test('visibility: destroying the panel with a thread open reports the EMPTY snapshot', () => {
  // The decisive case for where this contract lives. A consumer that raised its update rate while a
  // thread was open must be told the thread is gone, and the panel's own destruction is precisely
  // when it cannot tell them itself.
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'readable' });
    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);

    f.panel.destroy();
    f.env.drainMicrotasks();
    assert.equal(seen.length, 1, 'destruction is a transition, and transitions are reported');
    assert.deepEqual(seen[0].visible, [], 'nothing is readable once the panel is gone');
    assert.deepEqual(keysOf(seen[0].closed), ['document']);
    assert.deepEqual(f.core.visibleThreads(), [], 'and the pull agrees');
  } finally { f.restore(); }
});

test('visibility: a COLLAPSED lane is not visible, though its conversation is registered', () => {
  // The lane's conversation stays registered while it is folded away, so the set of registered
  // conversations is not the set of readable threads. Deriving from it would report a thread the
  // reader cannot see — and would light nothing, forever, for the one they can.
  const f = mountPanel({ instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'in the lane' });
    f.panel.toggleDocumentLane(false);
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads(), [], 'folded away is not readable');
    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    assert.deepEqual(keysOf(f.core.visibleThreads()), ['document'], 'expanded is');
  } finally { f.restore(); }
});

test('visibility: a comment arriving in an OPEN thread is reported, though membership did not change', () => {
  // The gap this contract exists to close. The reader is looking at the thread while it grows; the
  // set of open threads never changes, so a membership-only contract says nothing and whatever the
  // consumer drives from it — an unread marker, a read cursor — stays wrong in front of them.
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'first' });
    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);

    const arrived = f.core.addComment({ anchor: { type: 'document' }, body: 'arrived while open' });
    f.env.drainMicrotasks();
    assert.equal(seen.length, 1, 'the changed content is reported');
    assert.deepEqual(seen[0].opened, [], 'nothing opened');
    assert.deepEqual(seen[0].closed, [], 'and nothing closed');
    const entry = seen[0].visible.find((e) => e.threadKey === 'document');
    assert.ok(entry.comments.includes(arrived.id), 'the new comment id is in the readable set');
  } finally { f.restore(); }
});

test('visibility: a report identical to the last one is not sent again', () => {
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    const first = f.core.addComment({ anchor: { type: 'document' }, body: 'first' });
    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);
    // A real mutation, so a report is genuinely reconsidered — the point is that it finds nothing to
    // say. Editing a body changes the thread's contents without changing anything the snapshot
    // promises: same thread, same anchor, same ids. An earlier version of this test used a call that
    // never scheduled a report at all, so it would have stayed green with the comparison deleted.
    f.core.updateComment(first.id, { body: 'edited, but the same utterance' });
    f.env.drainMicrotasks();
    assert.deepEqual(seen, [], 'the same snapshot twice is one fact, not two');
  } finally { f.restore(); }
});

test('visibility: opening and closing within one turn settles to nothing, and says nothing', () => {
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'brief' });
    const seen = recordVisibility(f.core);
    f.panel.openDocumentThread();
    // The dismiss registration is deferred, so that the very interaction which opened the Pane cannot
    // immediately close it. Frames and timers only — draining microtasks here would deliver the
    // opening report and destroy the premise, which is that both events happen inside ONE turn.
    f.env.flushTimers(); f.env.flushFrames();
    // Both transitions have to be real for the silence to mean anything: an `openDocumentThread` that
    // quietly did nothing would satisfy an event-only assertion just as well.
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['document'], 'it really did open');
    f.root.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.deepEqual(f.core.visibleThreads(), [], 'and it really did close, both before the boundary');
    f.env.drainMicrotasks();
    assert.deepEqual(seen, [], 'this is settled visibility, not an interaction log');
  } finally { f.restore(); }
});

test('visibility: a handler that closes during the flush is diffed against what was delivered', () => {
  // What this pins is that the baseline is committed at all: a handler that closes the thread it was
  // just told about produces a SECOND report, diffed against the first. Leave the baseline unwritten
  // and the second flush sees nothing to compare against and stays silent.
  //
  // It does NOT pin the ORDER of that commit against the emit, and reverting the order does not turn
  // it red — because a flush is never re-entered from inside itself. A handler that changes a surface
  // schedules the next flush onto the queue rather than running one, so the frame that wrote a stale
  // baseline would always be the same frame that delivered it. The order is kept as written anyway:
  // it costs nothing, and it is the order that stays correct if a synchronous path is ever added.
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'readable' });
    const seen = [];
    let once = false;
    f.core.on('thread:visibility', (p) => {
      seen.push(p);
      if (once) return;
      once = true;
      f.root.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    });
    f.panel.openDocumentThread();
    f.env.flushTimers(); f.env.flushFrames();   // install the deferred dismissal before the handler uses it
    f.env.drainMicrotasks();

    assert.equal(seen.length, 2, 'the handler-driven close is a second transition');
    assert.deepEqual(keysOf(seen[0].opened), ['document']);
    assert.deepEqual(keysOf(seen[1].closed), ['document'], 'diffed against the delivered snapshot');
    assert.deepEqual(seen[1].visible, []);
    f.env.assertNoHandlerErrors('re-entrant visibility subscriber');
  } finally { f.restore(); }
});

test('visibility: a destroyed panel is no longer asked what is readable', () => {
  // Not the same claim as "it reports empty". A provider left registered keeps a destroyed panel —
  // and everything its closure holds — reachable from the core, and goes on answering from detached
  // nodes that still carry the state they had when they were torn out. No count anywhere moves, which
  // is exactly why this needs its own test rather than the environment meter.
  const f = mountPanel({ instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'in the lane' });
    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['document'], 'open before teardown');

    f.panel.destroy();
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);
    f.core.addComment({ anchor: { type: 'document' }, body: 'arrives after the panel is gone' });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads(), [], 'nothing answers for a panel that no longer exists');
    assert.deepEqual(seen, [], 'and the core has nothing to announce');
  } finally { f.restore(); }
});

test('visibility: two displays showing the same thread make it readable once, not twice', () => {
  // The objection that a core-level baseline cannot serve more than one display. It can, because the
  // core never stores what a display returned: it asks every display and merges. One thread shown in
  // two places is one readable thread, and a consumer resolving read state gets the union of what is
  // actually on screen rather than whichever display answered last.
  const f = mountPanel({ instrument: true });
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'in the lane' });
    f.panel.toggleDocumentLane(true);
    const other = f.core.registerThreadVisibility(() => ([
      { threadKey: 'document', anchor: { type: 'document' }, comments: [c.id, 'seen-only-over-there'] },
      { threadKey: 'block:elsewhere', anchor: { type: 'block', elementId: 'elsewhere' }, comments: ['x'] },
    ]));
    f.env.drainMicrotasks();

    const now = f.core.visibleThreads();
    assert.deepEqual(now.map((e) => e.threadKey), ['block:elsewhere', 'document'], 'one entry per thread');
    assert.deepEqual(now.find((e) => e.threadKey === 'document').comments, [c.id, 'seen-only-over-there'].sort(),
      'the union of what both displays are showing');

    const seen = recordVisibility(f.core);
    other();                                  // the second display goes away
    f.env.drainMicrotasks();
    assert.deepEqual(seen[0].closed.map((e) => e.threadKey), ['block:elsewhere'],
      'only what it alone was showing closes');
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['document'],
      'the thread the panel still shows stays open');
  } finally { f.restore(); }
});

test('visibility: a surface with nothing written in it yet is still readable', () => {
  // Being open and holding a comment are different facts. A thread the reader has just opened has
  // never been written in, and answering "not readable" while they are looking straight at it makes
  // the report describe the store rather than the reader.
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    const now = f.core.visibleThreads();
    assert.deepEqual(now.map((e) => e.threadKey), ['document'], 'an empty thread is open all the same');
    assert.deepEqual(now[0].comments, [], 'and holds nothing, which is a state and not an absence');
    assert.ok(now[0].anchor, 'it still knows what it points at');
  } finally { f.restore(); }
});

test('visibility: emptying an open thread is not the same as closing it', () => {
  // The lane stays expanded when its last comment goes, composer and all. Deriving presence from the
  // store reports a closing that never happened, and a consumer that stops tracking on `closed` then
  // stops tracking a thread the reader is still sitting in front of.
  const f = mountPanel({ instrument: true });
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'the only one' });
    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);

    f.core.deleteComment(c.id);
    f.env.drainMicrotasks();
    assert.equal(seen.length, 1, 'losing its contents is a change worth reporting');
    assert.deepEqual(seen[0].closed, [], 'but nothing closed — the lane never folded away');
    assert.deepEqual(seen[0].visible.map((e) => e.threadKey), ['document']);
    assert.deepEqual(seen[0].visible[0].comments, [], 'it is simply empty now');
  } finally { f.restore(); }
});

test('visibility: what a subscriber is handed cannot rewrite what the core believes it said', () => {
  // A snapshot contract is worth nothing if the recipient can edit the baseline the next difference
  // is measured against — or, through a shared anchor, edit stored comment state with no mutation, no
  // validation and no `change` event.
  const f = mountPanel({ instrument: true });
  try {
    const c = f.core.addComment({ anchor: { type: 'document' }, body: 'held' });
    f.panel.toggleDocumentLane(true);
    let vandalised = false;
    f.core.on('thread:visibility', (p) => {
      if (vandalised || !p.visible.length) return;
      vandalised = true;
      p.visible[0].threadKey = 'rewritten';
      p.visible[0].comments.push('invented');
      if (p.visible[0].anchor) p.visible[0].anchor.type = 'rewritten';
    });
    f.env.drainMicrotasks();
    assert.ok(vandalised, 'the payload was actually reachable, so this test measured something');

    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['document'], 'the pull is untouched');
    assert.deepEqual(f.core.visibleThreads()[0].comments, [c.id], 'and so is what it holds');
    assert.equal(f.core.getComment(c.id).anchor.type, 'document', 'the stored comment kept its own anchor');

    const seen = recordVisibility(f.core);
    f.panel.toggleDocumentLane(false);
    f.env.drainMicrotasks();
    assert.deepEqual(seen[0].closed.map((e) => e.threadKey), ['document'], 'the close names the real thread');
    assert.equal(seen[0].closed[0].anchor.type, 'document');
  } finally { f.restore(); }
});

test('visibility: the same anchor spelled in a different order is the same anchor', () => {
  // Equality has to be about what an anchor MEANS. Property order is how it happens to be written
  // down, and an import can legitimately write it down differently — reporting that as a change makes
  // the documented suppression untrue exactly where round-tripping is most likely.
  const f = mountPanel({ instrument: true });
  try {
    const spelled = (order) => order === 'a'
      ? { type: 'block', elementId: 'para-x' }
      : { elementId: 'para-x', type: 'block' };
    let which = 'a';
    f.core.registerThreadVisibility(() => ([{ threadKey: 'block:para-x', anchor: spelled(which), comments: ['c1'] }]));
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);

    which = 'b';
    f.core.reportThreadVisibility();
    f.env.drainMicrotasks();
    assert.deepEqual(seen, [], 'the same fact written the other way round is not news');
  } finally { f.restore(); }
});

test('visibility: a display that fails to answer has not stopped showing anything', () => {
  // "Could not answer" and "shows nothing" are opposite facts, and the diff cannot tell them apart
  // once one is written down as the other: everything that display alone was showing lands in
  // `closed`, that becomes the baseline, and nothing repairs it until something else happens.
  const f = mountPanel({ instrument: true });
  try {
    let failing = false;
    f.core.registerThreadVisibility(() => {
      if (failing) throw new Error('cannot read the surface right now');
      return [{ threadKey: 'block:elsewhere', anchor: { type: 'block', elementId: 'elsewhere' }, comments: ['x'] }];
    });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['block:elsewhere']);

    const seen = recordVisibility(f.core);
    const errors = [];
    f.core.on('error', (e) => errors.push(e));
    failing = true;
    f.core.reportThreadVisibility();
    f.env.drainMicrotasks();
    assert.deepEqual(seen, [], 'a moment of not answering closes nothing');
    assert.equal(errors.length >= 1, true, 'and is not swallowed either');

    failing = false;
    f.core.addComment({ anchor: { type: 'document' }, body: 'recovering' });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['block:elsewhere'], 'it answers again');
  } finally { f.restore(); }
});

test('visibility: a destroyed core does not take on a new display', () => {
  const core = Tackback.mount({ document: { id: 'destroyed-fixture' } });
  core.destroy();
  let asked = false;
  const off = core.registerThreadVisibility(() => { asked = true; return []; });
  assert.equal(typeof off, 'function', 'it still answers with something callable');
  off();
  assert.equal(asked, false, 'but nothing was ever registered to ask');
});
