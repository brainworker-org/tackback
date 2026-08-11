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
    // Consumed as it is reported. A test that deliberately provokes one asserts on it here, and by
    // doing so accounts for it — anything left unaccounted for is what teardown refuses to let pass.
    const [first] = env.handlerErrors.splice(0);
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
    // By identity, not by description: two anonymous elements of the same tag read alike, so a census
    // built from tag and id calls one observer swapped for another on a different target "unchanged".
    observerTargets: [...env.observers].map((o) => o.targets.map((t) => idOf(t)).sort().join(',')).sort(),
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
function mountPanel({ comments = [], controls, instrument = false, setup, noRaf = false, storage: storageOverride, theme } = {}) {
  const env = instrument ? instrumentEnv({ noRaf }) : null;
  const doc = fakeDoc();
  // mount on the body, as a page with no explicit root does — that is what puts the lane INSIDE the
  // gesture root, which is the only geometry in which the lane's gesture guard can be exercised.
  const root = doc.body;
  // a storage adapter that seeds the store — the path a persisted comment takes. A test can supply
  // its own to seed the environment-local records too, or to make loading finish after the mount.
  const storage = storageOverride || { load: () => ({ comments }), save: () => {} };
  const core = Tackback.mount({ document: { id: 'panel-fixture' }, storage, root });
  // Page content the test needs is added BEFORE the panel attaches, so the baseline below includes
  // it and the meter measures the panel's footprint rather than the fixture's.
  setup?.(doc, root, core);
  // Taken after the core is mounted and after the host page exists, and before the panel attaches.
  const before = env ? env.census(doc) : null;
  const panel = attachPanel(core, { root, target: doc.body, ...(controls ? { controls } : {}), ...(theme !== undefined ? { theme } : {}) });
  // Restoring the globals comes FIRST and unconditionally: a teardown that throws before putting the
  // environment back leaves every later test running against stubs, which is how a single mistake
  // here once hung the whole suite rather than failing one case.
  //
  // Then the default flips. Capturing swallowed subscriber errors only helped a test that remembered
  // to ask, which makes it a detector rather than a rule — so an unaccounted-for one now fails the
  // test that produced it, whether or not that test thought to look.
  const restore = () => {
    env?.restore();
    if (env?.handlerErrors.length) {
      const [first] = env.handlerErrors;
      const cause = first[first.length - 1];
      throw new Error(`a subscriber threw and the emitter swallowed it, unnoticed by this test — ${cause?.message || cause}`, { cause });
    }
  };
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

test('panel: a modal belongs to the panel — one at a time, and it goes when the panel does', async () => {
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
// ledger accumulated at each transition, and never from the middle of a host changing.

/** Subscribe without asserting inside the handler — the emitter would swallow anything that threw. */
function recordVisibility(core) {
  const seen = [];
  core.on('thread:visibility', (p) => seen.push(p));
  return seen;
}
const keysOf = (entries) => entries.map((e) => e.threadKey).sort();
/**
 * Let the core spend the looks it takes on its own initiative. Until those are gone a failure has not
 * been handed back to anyone, so a test that wants to see the failure reported has to get here first.
 * Deliberately more rounds than the core takes: the point is to reach the end of them, not to encode
 * how many there are.
 */
const exhaustSelfRetries = (env) => { for (let i = 0; i < 6; i += 1) { env.flushTimers(); env.drainMicrotasks(); } };

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

test('visibility: the ids a thread reports are every utterance in it, replies included', () => {
  // What a consumer resolves a read cursor against, so the set has to be exact in both directions. A
  // report naming only root ids would leave every reply permanently unaccounted for, and the shortfall
  // hides well: each id it DOES carry is correct, and the reader sees the replies either way. One
  // naming an id from a thread that is not open would clear a mark nobody looked at.
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    const root = f.core.addComment({ anchor: { type: 'document' }, body: 'root' });
    const second = f.core.addComment({ anchor: { type: 'document' }, body: 'a second root' });
    const withReply = f.core.addReply(root.id, { body: 'a reply' });
    const replyId = withReply.replies[withReply.replies.length - 1].id;
    const elsewhere = f.core.addComment({ anchor: { type: 'block', elementId: 'para' }, body: 'another thread' });

    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    const entry = f.core.visibleThreads().find((e) => e.threadKey === 'document');
    assert.deepEqual(entry.comments.slice().sort(), [root.id, second.id, replyId].sort(),
      'every utterance in the open thread, and nothing from a thread that is not open');
    assert.ok(!entry.comments.includes(elsewhere.id), 'including the one written a moment earlier');

    // A reply landing while the reader is looking is an arrival like any other: the same thread, one
    // more id — which is the only way the consumer hears that there is something new to resolve.
    const seen = recordVisibility(f.core);
    const late = f.core.addReply(second.id, { body: 'arrived while open' });
    const lateId = late.replies[late.replies.length - 1].id;
    f.env.drainMicrotasks();
    assert.equal(seen.length, 1, 'a reply changes what is readable');
    assert.ok(seen[0].visible[0].comments.includes(lateId), 'and the new reply is in the reported set');
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
  // it red — because a flush is never re-entered from inside itself. A handler that changes a host
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

test('visibility: a second display replaces the first rather than joining it', () => {
  // A document has at most one panel, so this seam reports for at most one display. Registering again
  // REPLACES: a re-attach after a teardown that did not run must not leave a dead display answering,
  // and refusing would make that situation unrecoverable. Every cell of "register while registered"
  // is pinned here rather than left to whichever call happened to come first.
  const f = mountPanel({ instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'in the lane' });
    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['document'], 'the panel is the display');

    let firstAsked = 0;
    const offFirst = f.core.registerThreadVisibility(() => { firstAsked += 1; return []; });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads(), [], 'the newcomer replaced the panel, it did not join it');
    const askedBefore = firstAsked;

    const offSecond = f.core.registerThreadVisibility(() => ([
      { threadKey: 'block:b', anchor: { type: 'block', elementId: 'b' }, comments: ['x'] },
    ]));
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['block:b'], 'and so did the next one');
    assert.equal(firstAsked, askedBefore, 'the one that was replaced is never asked again');

    offFirst();   // the replaced display withdrawing must not take the live one with it
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['block:b'],
      'withdrawing something already replaced withdraws nothing');

    offSecond();
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads(), [], 'and the live one withdrawing leaves nothing readable');
  } finally { f.restore(); }
});
test('visibility: a thread with nothing written in it yet is still readable', () => {
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
    exhaustSelfRetries(f.env);
    assert.equal(errors.length, 1, 'and once the core has stopped looking, it is not swallowed either');

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

test('harness: the census sees one observer target swapped for an identical-looking one', () => {
  const f = mountPanel({ instrument: true });
  try {
    const a = f.doc.createElement('div'), b = f.doc.createElement('div');
    f.root.appendChild(a); f.root.appendChild(b);
    const ro = new globalThis.ResizeObserver(() => {});
    ro.observe(a);
    const before = f.env.census(f.doc);
    ro.targets.length = 0; ro.observe(b);
    const after = f.env.census(f.doc);
    assert.notDeepEqual(after.observerTargets, before.observerTargets,
      'two anonymous divs describe alike; only identity tells them apart');
    ro.disconnect();
  } finally { f.restore(); }
});

test('harness: a test that never asks still fails when a subscriber threw', () => {
  // The rule, not the detector. This test asserts nothing about handler errors and does not call the
  // check — teardown is what refuses to let one pass, which is the only version of this that survives
  // an author who did not think to look.
  const f = mountPanel({ instrument: true });
  let threw = false;
  try {
    f.core.on('comment:add', () => { assert.equal(1, 2, 'deliberate'); });
    f.core.addComment({ anchor: { type: 'document' }, body: 'x' });
  } finally {
    try { f.restore(); } catch (err) { threw = /swallowed it, unnoticed/.test(err.message); }
  }
  assert.ok(threw, 'teardown, not the test, is what caught it');
});

test('visibility: a display that cannot be read gives no answer at all, rather than an old one', () => {
  // The failure the first repair introduced. Retaining each display's last good answer only reads
  // correctly while nothing changed; when the surface really has closed and the read of it fails, the
  // old answer is a statement about the present that nobody observed. Whether an unreadable display
  // shows nothing or still shows what it showed is a fact only that display has, so the core stops
  // claiming to know rather than guessing — and guesses in both directions have now been wrong.
  const f = mountPanel({ instrument: true });
  const errors = [];
  try {
    let showing = [{ threadKey: 'block:a', anchor: { type: 'block', elementId: 'a' }, comments: ['c'] }];
    let failing = false;
    f.core.on('error', (e) => errors.push(e));
    f.core.registerThreadVisibility(() => { if (failing) throw new Error('unreadable'); return showing; });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['block:a']);

    const seen = recordVisibility(f.core);
    showing = [];            // it really did close…
    failing = true;          // …and the read of that fails
    f.core.reportThreadVisibility();
    f.env.drainMicrotasks();
    assert.throws(() => f.core.visibleThreads(), /could not read/, 'the pull refuses rather than lies');
    assert.deepEqual(seen, [], 'and nothing was announced from an unobserved world');
    exhaustSelfRetries(f.env);
    assert.equal(errors.length, 1, 'the failure is reported, once the core has run out of looks');

    failing = false;
    f.core.reportThreadVisibility();
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads(), [], 'the next real look repairs it');
    assert.deepEqual(seen.at(-1).closed.map((e) => e.threadKey), ['block:a'], 'and only then is it closed');
  } finally { f.restore(); }
});

test('visibility: recovery is a fresh observation, not the cache answering forever', () => {
  const f = mountPanel({ instrument: true });
  try {
    let asked = 0, failing = false;
    let showing = [{ threadKey: 'block:a', anchor: { type: 'block', elementId: 'a' }, comments: ['c1'] }];
    f.core.on('error', () => {});
    f.core.registerThreadVisibility(() => { asked += 1; if (failing) throw new Error('unreadable'); return showing; });
    f.env.drainMicrotasks();
    const before = asked;

    failing = true; f.core.reportThreadVisibility(); f.env.drainMicrotasks();
    failing = false;
    showing = [{ threadKey: 'block:a', anchor: { type: 'block', elementId: 'a' }, comments: ['c1', 'c2'] }];
    const seen = recordVisibility(f.core);
    f.core.reportThreadVisibility(); f.env.drainMicrotasks();
    assert.ok(asked > before, 'it was actually asked again');
    assert.deepEqual(seen.at(-1).visible[0].comments, ['c1', 'c2'], 'and the new answer is what came back');
  } finally { f.restore(); }
});

test('visibility: a display that withdraws while being read does not get announced first', () => {
  // A look that spans a display arriving or leaving describes two different worlds at once. Reporting
  // the composite would announce a thread as opened and then immediately closed, which is precisely
  // the "announced from the middle of something changing" this contract exists to rule out.
  const f = mountPanel({ instrument: true });
  try {
    const seen = recordVisibility(f.core);
    let off = null;
    off = f.core.registerThreadVisibility(() => {
      off?.();                                   // withdraws itself mid-observation
      return [{ threadKey: 'block:gone', anchor: { type: 'block', elementId: 'gone' }, comments: ['x'] }];
    });
    f.env.drainMicrotasks();
    assert.deepEqual(seen.flatMap((p) => p.opened.map((e) => e.threadKey)), [],
      'nothing that had already withdrawn was ever announced as open');
    assert.deepEqual(f.core.visibleThreads(), []);
  } finally { f.restore(); }
});

test('visibility: an anchor the core cannot rebuild is a failed look, not a crash', () => {
  // Rebuilding a display's answer as the core's own is part of LOOKING, not something done to a
  // finished observation — so a value that cannot be rebuilt fails the attempt like any other unread,
  // instead of escaping as an uncaught error out of a scheduled callback nobody can catch.
  const f = mountPanel({ instrument: true });
  const errors = [];
  try {
    const cyclic = { type: 'block', elementId: 'a' };
    cyclic.self = cyclic;
    f.core.on('error', (e) => errors.push(e));
    f.core.registerThreadVisibility(() => ([{ threadKey: 'block:a', anchor: cyclic, comments: ['c'] }]));
    f.env.drainMicrotasks();
    assert.throws(() => f.core.visibleThreads(), /could not read/);
    exhaustSelfRetries(f.env);
    assert.equal(errors.length, 1, 'reported as an error rather than thrown into the void');
  } finally { f.restore(); }
});

test('visibility: a thread that MOVES while open is reported at its new place', () => {
  // Where a thread points can change without its identity changing: a region keeps its key when it is
  // dragged, and an import can replace a comment under the same key. A remembered anchor goes on
  // naming where the thread used to be while the reader is looking at where it is now — and the
  // report is what a consumer uses to put its own marker somewhere.
  const f = mountPanel({ instrument: true });
  try {
    const c = f.core.addComment({
      anchor: { type: 'region', surfaceId: 'document', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      body: 'over the diagram',
    });
    const pin = f.doc.querySelectorAll('.tb-pin')[0];
    assert.ok(pin, 'the region drew a pin to open from');
    // A pin opens its thread on a pointerup that did not move — the same gesture that would otherwise
    // have dragged the region — so the thread is opened the way a reader opens it.
    pin.dispatchEvent({ type: 'pointerdown', clientX: 5, clientY: 5, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    f.doc.dispatchEvent?.({ type: 'pointerup', clientX: 5, clientY: 5, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    f.root.dispatchEvent({ type: 'pointerup', clientX: 5, clientY: 5, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    f.env.drainMicrotasks();
    const opened = f.core.visibleThreads();
    assert.equal(opened.length, 1, 'the region thread is open');
    assert.equal(opened[0].anchor.rect.x, 0.1, 'reported where it was drawn');

    f.core.recordRegionEvent(c.id, { rect: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } }, 'move');
    f.env.drainMicrotasks();
    const after = f.core.visibleThreads();
    assert.equal(after.length, 1, 'still the same open thread');
    assert.equal(after[0].anchor.rect.x, 0.6, 'and it followed the region to where it now is');
  } finally { f.restore(); }
});

test('visibility: an open thread emptied after it moved is reported where it ENDED UP', () => {
  // The only case the remembered place answers: the surface is still open, the store no longer has
  // anything to say about where it points, and where it was FIRST opened is not where it was last
  // seen. Remembering the initial value instead would name a place the thread had already left.
  const f = mountPanel({ instrument: true });
  try {
    const c = f.core.addComment({
      anchor: { type: 'region', surfaceId: 'document', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      body: 'over the diagram',
    });
    const pin = f.doc.querySelectorAll('.tb-pin')[0];
    pin.dispatchEvent({ type: 'pointerdown', clientX: 5, clientY: 5, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    f.root.dispatchEvent({ type: 'pointerup', clientX: 5, clientY: 5, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    f.core.recordRegionEvent(c.id, { rect: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } }, 'move');
    // Deliberately NO observation between the move and the deletion. Draining here would let the
    // answer be captured by the very look the test is meant to do without, and the case only exists
    // because both happen before anyone asks.
    f.core.deleteComment(c.id);
    f.env.drainMicrotasks();
    const after = f.core.visibleThreads();
    assert.equal(after.length, 1, 'the surface is still open — emptying is not closing');
    assert.equal(after[0].comments.length, 0, 'still open, now holding nothing');
    assert.equal(after[0].anchor.rect.x, 0.6, 'and still naming where it ended up, not where it began');
  } finally { f.restore(); }
});

test('visibility: the core keeps looking by itself for a while, then stops and says why', () => {
  // The retry exists so that a display which is briefly unreadable is not left un-looked-at until
  // something unrelated happens. It is bounded on purpose: the core cannot know when the condition
  // has passed, and looking forever would spend every turn measuring the same failure. What is being
  // pinned here is that it does look again without being asked, and that it does give up.
  const f = mountPanel({ instrument: true });
  try {
    let asked = 0;
    f.core.on('error', () => {});
    f.core.registerThreadVisibility(() => { asked += 1; throw new Error('unreadable'); });
    f.env.drainMicrotasks();
    const afterFirst = asked;
    assert.equal(afterFirst, 1, 'one look, which failed');

    for (let i = 0; i < 10; i += 1) { f.env.flushTimers(); f.env.drainMicrotasks(); }
    assert.ok(asked > afterFirst, 'it looked again without being asked');
    const settled = asked;
    for (let i = 0; i < 10; i += 1) { f.env.flushTimers(); f.env.drainMicrotasks(); }
    assert.equal(asked, settled, 'and it stopped rather than looking forever');
  } finally { f.restore(); }
});

test('visibility: looking again, and giving up, belong to the failure — not to the core', () => {
  // What is spent while a display is unreadable has to be given back when that stops being the
  // situation, and there are two ways it stops: the display starts answering, or a different display
  // takes over. Neither was true of a budget kept on the core. A display attached after an earlier one
  // failed would inherit an empty one and be asked exactly once — and being asked again is the whole
  // of what the retry is for, so the display most likely to need it is the one that would not get it.
  const f = mountPanel({ instrument: true });
  try {
    const errors = [];
    f.core.on('error', (e) => errors.push(e));
    let firstAsked = 0, failing = true;
    const dropFirst = f.core.registerThreadVisibility(() => {
      firstAsked += 1;
      if (failing) throw new Error('unreadable');
      return [];
    });
    exhaustSelfRetries(f.env);
    const spent = firstAsked;
    assert.ok(spent > 1, 'the failing display was looked at more than once');
    assert.equal(errors.length, 1, 'and handed back exactly once, not once per look');

    // Still failing, and something else happens. The fact has already been stated; stating it again on
    // every later mutation would report one broken display as a stream of separate incidents.
    f.core.addComment({ anchor: { type: 'document' }, body: 'a mutation asks for a fresh report' });
    exhaustSelfRetries(f.env);
    assert.equal(errors.length, 1, 'the same failure is one fact, however often it is rediscovered');

    // It starts answering. That closes the episode, so the next failure is a new one and is said again.
    failing = false;
    f.core.reportThreadVisibility();
    f.env.drainMicrotasks();
    failing = true;
    f.core.reportThreadVisibility();
    exhaustSelfRetries(f.env);
    assert.equal(errors.length, 2, 'a failure after a good look is a different failure');
    assert.ok(firstAsked > spent, 'and it got its looks back too');

    // The same recovery, seen the other way a look can be taken. A caller pulling and getting an
    // answer has observed the display working just as surely as a report would have — so if only one
    // of the two ends the episode, a display that recovers where the caller can see it goes on
    // carrying a verdict from before, with no looks left and nothing said when it fails again.
    failing = false;
    assert.deepEqual(f.core.visibleThreads(), [], 'the pull gets a real answer');
    failing = true;
    const beforePull = firstAsked;
    f.core.reportThreadVisibility();
    exhaustSelfRetries(f.env);
    assert.ok(firstAsked - beforePull > 1, 'a pull that worked gives the looks back too');
    assert.equal(errors.length, 3, 'and the failure after it is a new one, said once');

    // A replacement display is the other way an episode ends. It must arrive with everything.
    dropFirst();
    let secondAsked = 0;
    f.core.registerThreadVisibility(() => { secondAsked += 1; throw new Error('also unreadable'); });
    exhaustSelfRetries(f.env);
    assert.ok(secondAsked > 1, 'the display that arrived second is looked at more than once too');
    assert.equal(errors.length, 4, 'and is complained about on its own account, once');
  } finally { f.restore(); }
});

test('visibility: an anchor shaped wrong is a failed look, like one that cannot be rebuilt', () => {
  // A cycle is not the only way an answer can be unusable. What the core promises subscribers is an
  // entry that names a place; an entry that names nothing cannot be published as though it did.
  const f = mountPanel({ instrument: true });
  try {
    f.core.on('error', () => {});
    let anchor = null;
    f.core.registerThreadVisibility(() => ([{ threadKey: 'block:a', anchor, comments: ['c'] }]));
    f.env.drainMicrotasks();
    assert.throws(() => f.core.visibleThreads(), /could not read/, 'no anchor at all');

    anchor = { type: 'block' };                 // a kind that says where, without saying where
    assert.throws(() => f.core.visibleThreads(), /could not read/, 'a block that names no element');

    anchor = { type: 'not-a-kind', elementId: 'a' };
    assert.throws(() => f.core.visibleThreads(), /could not read/, 'a kind this build does not know');

    anchor = { type: 'block', elementId: 'a' };
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['block:a'], 'and a real one works');
  } finally { f.restore(); }
});

test('visibility: every part of a report is the subscriber\'s own, not just the visible list', () => {
  const f = mountPanel({ instrument: true });
  try {
    f.core.addComment({ anchor: { type: 'document' }, body: 'held' });
    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    const seen = recordVisibility(f.core);
    f.panel.toggleDocumentLane(false);
    f.env.drainMicrotasks();

    const report = seen[0];
    assert.deepEqual(report.visible, [], 'nothing visible after folding away');
    report.closed[0].threadKey = 'rewritten';
    report.closed[0].comments.push('invented');
    report.closed[0].anchor.type = 'rewritten';

    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    const reopened = seen.at(-1);
    assert.deepEqual(reopened.opened.map((e) => e.threadKey), ['document'], 'the reopen names the real thread');
    assert.equal(reopened.opened[0].anchor.type, 'document', 'with the real anchor');
    assert.equal(f.core.visibleThreads()[0].anchor.type, 'document', 'and the pull agrees');
  } finally { f.restore(); }
});

test('visibility: a callable smuggled into an anchor is not carried into the report', () => {
  // It would survive a copy by reference — shared with whoever handed it over — while being invisible
  // to the comparison, so changing it could never count as a change. A fact is made of values.
  const f = mountPanel({ instrument: true });
  try {
    const smuggled = () => 'reachable';
    f.core.registerThreadVisibility(() => ([
      { threadKey: 'block:a', anchor: { type: 'block', elementId: 'a', probe: smuggled }, comments: ['c'] },
    ]));
    f.env.drainMicrotasks();
    const [entry] = f.core.visibleThreads();
    assert.equal(entry.threadKey, 'block:a', 'the entry itself is fine');
    assert.notEqual(entry.anchor.probe, smuggled, 'but nothing callable came with it');
  } finally { f.restore(); }
});

test('panel: every way a thread host ends goes through the one release path', () => {
  // What this fixes in place is the answering, at each of the three moments a host has: both hosts
  // open, one of them closed by the reader, and the panel gone. A host that dies but stays in the
  // panel's set answers "not me" forever, which is what a correctly released host says too — so this
  // cannot be the meter for the release path itself, and does not claim to be. It measures the
  // reports, which is what a consumer has.
  // The paragraph goes in through `setup`, so it is part of the baseline the environment check
  // compares against — a page element added afterwards would read as something the panel left behind.
  const f = mountPanel({
    instrument: true,
    setup: (doc, root) => {
      const p = doc.createElement('p'); p.id = 'para-host'; p.textContent = 'content';
      p.setAttribute('data-tb-anchor', '');
      root.appendChild(p);
    },
  });
  try {
    f.core.addComment({ anchor: { type: 'block', elementId: 'para-host' }, body: 'here' });
    f.core.addComment({ anchor: { type: 'document' }, body: 'and here' });
    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();

    // Open a Pane, then close it the way a reader does.
    f.badges()[0].dispatchEvent({ type: 'click', clientX: 5, clientY: 5, preventDefault() {}, stopPropagation() {} });
    f.env.flushTimers(); f.env.flushFrames();
    const opened = f.core.visibleThreads().map((e) => e.threadKey).sort();
    assert.deepEqual(opened, ['block:para-host', 'document'], 'both hosts answer while both are open');

    f.root.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads().map((e) => e.threadKey), ['document'],
      'the closed Pane stops answering');

    // Teardown must take the rest with it.
    f.panel.destroy();
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.visibleThreads(), [], 'and nothing answers once the panel is gone');
    f.assertEnvironmentRestored('every host released');
  } finally { f.restore(); }
});

// ---- unread, on the page -------------------------------------------------------------------------
//
// The core decides what is unread; these fix what a reader SEES. Reading is one question asked of
// every host — "is the thread area open" — so the three ways a thread can be on screen are three
// cases here rather than three mechanisms.

/** A page with two commentable paragraphs, so "this one, not that one" can be said. */
const twoBlocks = (doc, root) => {
  for (const id of ['p1', 'p2']) {
    const p = doc.createElement('p'); p.id = id; p.textContent = `paragraph ${id}`;
    p.setAttribute('data-tb-anchor', '');
    root.appendChild(p);
  }
};
const badgeFor = (f, elementId) => f.badges().find((b) => b.__tbComments?.[0]?.anchor?.elementId === elementId);
let arrivalSeq = 0;
/**
 * Something ARRIVING — from outside, which is the only way anything is new to this reader.
 *
 * `addComment` is the reader typing, and nobody needs telling about what they just typed, so a
 * fixture that used it to stand for "something showed up" was staging the wrong event.
 * @returns {string} the id that arrived
 */
const arrives = (f, elementId, body = 'from somewhere else') => {
  const id = `arr-${arrivalSeq += 1}`;
  const anchor = elementId === 'document' ? { type: 'document' } : { type: 'block', elementId };
  f.core.importEnvelope({
    schemaVersion: 1, generator: { name: 'tackback', version: 'x' }, document: { id: 'panel-fixture' },
    comments: [{ id, anchor, body, createdAt: '2026-08-10T00:00:00.000Z', replies: [] }],
  }, { mode: 'merge' });
  f.env.drainMicrotasks();
  return id;
};
/** A reply arriving from outside, under a comment that is already here. */
const replyArrives = (f, commentId, body = 'answered') => {
  const id = `rep-${arrivalSeq += 1}`;
  const held = f.core.listComments().find((c) => c.id === commentId);
  f.core.importEnvelope({
    schemaVersion: 1, generator: { name: 'tackback', version: 'x' }, document: { id: 'panel-fixture' },
    comments: [{ ...held, replies: [...(held.replies || []), { id, body, createdAt: '2026-08-10T00:00:00.000Z' }] }],
  }, { mode: 'merge', onConflict: 'replace' });
  f.env.drainMicrotasks();
  return id;
};
const openPane = (f, node) => {
  node.dispatchEvent({ type: 'click', clientX: 5, clientY: 5, preventDefault() {}, stopPropagation() {} });
  f.env.flushTimers(); f.env.flushFrames(); f.env.drainMicrotasks();
};

test('T7: an unopened thread keeps its ring', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    arrives(f, 'p1', 'nobody has read this');
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 1);
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'), 'and the reader can see where it is');
  } finally { f.restore(); }
});

test('T6/T12: opening a thread clears that one, and only that one', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    arrives(f, 'p1', 'here');
    arrives(f, 'p2', 'and here');
    f.env.drainMicrotasks();
    openPane(f, badgeFor(f, 'p2'));

    assert.equal(f.core.unreadCount('block:p2'), 0, 'the one they opened is read');
    assert.equal(f.core.unreadCount('block:p1'), 1, 'the one they did not is not');
    assert.ok(!badgeFor(f, 'p2').classList.contains('tb-unread'), 'the mark is gone from the one opened');
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'), 'and still on the other');
  } finally { f.restore(); }
});

test('T11: something arriving in a thread already open never rings', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    f.core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'first' });
    f.env.drainMicrotasks();
    openPane(f, badgeFor(f, 'p1'));
    assert.equal(f.core.unreadCount('block:p1'), 0);

    f.core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'while they are looking' });
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 0, 'they were looking at it as it landed');
    assert.ok(!badgeFor(f, 'p1').classList.contains('tb-unread'));
  } finally { f.restore(); }
});

test('T8/T9: a folded document lane is not read, and unfolding it reads it', () => {
  // The case that defines what reading means. The lane is present and can be TYPED INTO while folded,
  // so "the host exists" cannot be the test — the thread area has to be open.
  const f = mountPanel({ instrument: true });
  try {
    arrives(f, 'document', 'about the whole thing');
    f.panel.toggleDocumentLane(false);
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('document'), 1, 'folded away is not read');
    assert.ok(f.lane().classList.contains('tb-unread'), 'and the lane says so, having no badge of its own');

    f.panel.toggleDocumentLane(true);
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('document'), 0);
    assert.ok(!f.lane().classList.contains('tb-unread'), 'the mark goes when it is opened');
  } finally { f.restore(); }
});

test('T10: with no lane, the document thread reads through an ordinary Pane', () => {
  const f = mountPanel({ controls: { docLane: false }, instrument: true });
  try {
    arrives(f, 'document', 'about the whole thing');
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('document'), 1);
    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('document'), 0, 'the third route works like the other two');
  } finally { f.restore(); }
});

test('T26: attention and unread are separate states, whichever one is drawn', () => {
  // They now draw on the same channel — both are fills — so the paint can only show one, and unread
  // is the one it shows. What must not follow is the STATE collapsing into it: an integrator still
  // using attention has to be able to raise and lower it, and read it back, while unread comes and
  // goes underneath. Attention is on its way out; until it is, this is what holds.
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const c = { id: arrives(f, 'p1', 'here') };
    f.env.drainMicrotasks();
    const badge = () => badgeFor(f, 'p1');
    assert.ok(badge().classList.contains('tb-unread'));
    assert.ok(!badge().classList.contains('tb-attn'));

    f.core.setAnchorAttention(c.id, true);
    f.env.drainMicrotasks();
    assert.ok(badge().classList.contains('tb-unread'), 'both states are on the badge…');
    assert.ok(badge().classList.contains('tb-attn'), '…and neither is dropped because of the other');

    openPane(f, badge());
    assert.ok(!badge().classList.contains('tb-unread'), 'reading clears its own mark');
    assert.ok(badge().classList.contains('tb-attn'), 'and leaves the integrator\'s alone');

    f.core.setAnchorAttention(c.id, false);
    f.env.drainMicrotasks();
    assert.ok(!badge().classList.contains('tb-attn'));
    assert.ok(!badge().classList.contains('tb-unread'));
  } finally { f.restore(); }
});

test('T44: what was unread before the reload is rung on the first paint', async () => {
  // Restoration finishes after the panel is already on screen, so the first draw happens with nothing
  // known. Whether the ring arrives by the announcement or by the next redraw does not matter — both
  // ask the core — but it has to arrive.
  let release;
  const seed = {
    schemaVersion: 1, documentId: 'panel-fixture',
    comments: [
      { id: 'c1', anchor: { type: 'block', elementId: 'p1' }, body: 'read', createdAt: '2026-08-10T00:00:00.000Z' },
      { id: 'c2', anchor: { type: 'block', elementId: 'p2' }, body: 'not read', createdAt: '2026-08-10T00:00:00.000Z' },
    ],
  };
  const progress = { arrival: { c1: 1, c2: 2 }, observed: { 'block:p1': 1 }, arrivalNext: 3 };
  const f = mountPanel({
    instrument: true,
    setup: twoBlocks,
    storage: { load: () => new Promise((r) => { release = () => r(seed); }), save: () => {},
      loadProgress: () => progress, saveProgress: () => {} },
  });
  try {
    release();
    await f.core.ready;
    f.env.drainMicrotasks(); f.env.flushFrames(); f.env.drainMicrotasks();
    assert.ok(badgeFor(f, 'p2')?.classList.contains('tb-unread'), 'the one nobody opened is rung');
    assert.ok(!badgeFor(f, 'p1')?.classList.contains('tb-unread'), 'and the one they had read is not');
  } finally { f.restore(); }
});

test('a redraw that nothing else follows still leaves the rings on', () => {
  // Badges are rebuilt from scratch by a redraw, so every class they carried goes with them. A reflow
  // — a resize, a re-render of the host page — redraws without changing the store, so there is no
  // announcement afterwards to put anything back. Relying on the announcement alone loses the ring
  // exactly when the page moved, which is when a reader is most likely to be looking at it.
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    arrives(f, 'p1', 'nobody has read this');
    f.env.drainMicrotasks();
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'));

    f.core.recalculateAnchors();
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 1, 'nothing about the reading changed');
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'), 'so the mark is still there');
  } finally { f.restore(); }
});

// ---- a reply arriving into a timeline that is on screen ------------------------------------------
//
// The design principle, verbatim: "when the timeline inside a Pane — the UI where comments are
// arranged on a time axis — is in the shown state, an arriving message is processed immediately and
// the read marker is advanced; when it is hidden, unread is shown."
//
// T11 above already sends a COMMENT into a shown timeline. What was never sent into one is a REPLY,
// and a reply is what actually arrives in a conversation: you send, and the other side answers into
// the Pane you are still looking at. The crossing was empty in every layer at once.

test('T48: a reply arriving into a Pane that is open does not ring it', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const c = f.core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'sent' });
    f.env.drainMicrotasks();
    openPane(f, badgeFor(f, 'p1'));
    assert.equal(f.core.unreadCount('block:p1'), 0, 'opening it read what was there');

    f.core.addReply(c.id, { body: 'answered while you watch' });
    f.env.drainMicrotasks();

    assert.equal(f.core.unreadCount('block:p1'), 0, 'the timeline was shown, so the reply arrived read');
    assert.ok(!badgeFor(f, 'p1').classList.contains('tb-unread'), 'and nothing is marked');
  } finally { f.restore(); }
});

test('T49: shown-vs-hidden decides a reply the same way in all three thread hosts', () => {
  // One question — is this thread's timeline shown — asked of an ordinary Pane, of the document lane,
  // and of the document thread when it falls back to an ordinary Pane. A host that answered it its
  // own way would show up here and nowhere else.
  const cases = [
    ['ordinary Pane', {}, (f) => {
      const c = { id: arrives(f, 'p1', 'seed') };
      f.env.drainMicrotasks();
      return { id: c.id, key: 'block:p1',
        show: () => openPane(f, badgeFor(f, 'p1')),
        hide: () => { f.doc.querySelector('.tb-popup').querySelector('.tb-cancel').click(); f.env.drainMicrotasks(); },
        marked: () => badgeFor(f, 'p1').classList.contains('tb-unread') };
    }],
    ['document lane', {}, (f) => {
      const c = { id: arrives(f, 'document', 'seed') };
      f.env.drainMicrotasks();
      return { id: c.id, key: 'document',
        show: () => { f.panel.toggleDocumentLane(true); f.env.drainMicrotasks(); },
        hide: () => { f.panel.toggleDocumentLane(false); f.env.drainMicrotasks(); },
        marked: () => f.lane().classList.contains('tb-unread') };
    }],
    ['document thread with no lane', { controls: { docLane: false } }, (f) => {
      const c = { id: arrives(f, 'document', 'seed') };
      f.env.drainMicrotasks();
      return { id: c.id, key: 'document',
        show: () => { f.panel.openDocumentThread(); f.env.drainMicrotasks(); },
        hide: () => { f.doc.querySelector('.tb-popup').querySelector('.tb-cancel').click(); f.env.drainMicrotasks(); },
        marked: () => false };   // no badge and no lane: the mark has nowhere to be, so the count is the oracle
    }],
  ];
  for (const [name, opts, build] of cases) {
    const f = mountPanel({ instrument: true, setup: twoBlocks, ...opts });
    try {
      const t = build(f);
      t.show();
      assert.equal(f.core.unreadCount(t.key), 0, `${name}: shown, so what is there is read`);

      replyArrives(f, t.id, 'answer, timeline shown');
      f.env.drainMicrotasks();
      assert.equal(f.core.unreadCount(t.key), 0, `${name}: a reply into a SHOWN timeline arrives read`);
      assert.equal(t.marked(), false, `${name}: and nothing is marked`);

      t.hide();
      replyArrives(f, t.id, 'answer, timeline hidden');
      f.env.drainMicrotasks();
      assert.equal(f.core.unreadCount(t.key), 1, `${name}: a reply into a HIDDEN timeline is unread`);

      t.show();
      assert.equal(f.core.unreadCount(t.key), 0, `${name}: showing it is what clears it`);
      assert.equal(t.marked(), false, `${name}: and the mark goes with it`);
    } finally { f.restore(); }
  }
});

test('T52: the reported conversation walk-through, end to end', () => {
  // The sequence a person actually performed, kept as one test so a regression is caught as the
  // JOURNEY rather than as five properties that each still hold on their own.
  //
  // Step 3 is the one that was reported wrong and is not: with an interactive transport the Pane
  // STAYS open, because that is what a conversation is — the answer lands in front of you rather
  // than behind a badge you have to find again. The mark that used to appear here was the demo
  // page raising the attention flag on arrival, not the library.
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    f.core.setTransport({ interactive: true });                       // (2) scenario: conversation
    f.env.drainMicrotasks();

    arrives(f, 'p1', 'seed');
    f.env.drainMicrotasks();
    openPane(f, badgeFor(f, 'p1'));
    assert.ok(f.doc.querySelector('.tb-popup'), 'the Pane is on screen');

    // (3) the Send itself — typed and committed, so `closeOnCommit` is actually exercised. Asserting
    // on a Pane that was merely opened would leave this step measuring nothing.
    const pane = f.doc.querySelector('.tb-popup');
    assert.equal(pane.querySelector('.tb-save').textContent, 'Send', '(2) the transport made it a Send');
    const ta = pane.querySelector('textarea');
    ta.value = 'my message'; ta.dispatchEvent({ type: 'input' });
    pane.querySelector('.tb-save').click();
    f.env.drainMicrotasks();
    assert.ok(f.doc.querySelector('.tb-popup'), '(3) a Send does NOT close a conversation — the Pane stays open');
    const c = f.core.listComments().find((x) => x.anchor.elementId === 'p1');

    replyArrives(f, c.id, 'the other participant answers');  // (4) ~a beat later
    f.env.drainMicrotasks();
    assert.ok(f.doc.querySelector('.tb-popup'), '(4) and it is still open when the answer lands');
    assert.equal(f.core.unreadCount('block:p1'), 0,
      '(4/5) the answer landed in a shown timeline, so it is read on arrival and no mark goes up');
    assert.ok(!badgeFor(f, 'p1').classList.contains('tb-unread'));

    // …and the other half of the same principle: hide the timeline, and the next answer is unread.
    f.doc.querySelector('.tb-popup').querySelector('.tb-cancel').click();
    f.env.drainMicrotasks();
    assert.equal(f.doc.querySelector('.tb-popup'), null, 'the reader closes it');

    replyArrives(f, c.id, 'answered while they were away');
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 1, 'hidden timeline: now it IS new');
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'), 'and the reader can see where');

    openPane(f, badgeFor(f, 'p1'));
    assert.equal(f.core.unreadCount('block:p1'), 0, 'reading it clears it');
    assert.ok(!badgeFor(f, 'p1').classList.contains('tb-unread'), 'the mark goes, which is the whole promise');
  } finally { f.restore(); }
});

// ---- writing is not arriving, drawn ---------------------------------------------------------------
//
// The same seven rows as the core suite, through the real panel, so that what the reader actually
// SEES is fixed and not only what the count says. Rows 1 and 2 are the regression: a person typing
// into a folded lane, or sending from a Pane that shuts as it commits, was marked as having something
// new — by themselves, about themselves.

test('row 1 (drawn) — typing into a folded lane counts, and draws nothing', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    f.panel.toggleDocumentLane(false);
    f.env.drainMicrotasks();
    f.core.addComment({ anchor: { type: 'document' }, body: 'typed into the folded lane' });
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('document'), 0);
    assert.ok(!f.lane().classList.contains('tb-unread'), 'the lane wears nothing');
    assert.match(f.laneCount(), /1/, 'and the count still went up');
  } finally { f.restore(); }
});

test('row 2 (drawn) — sending from a Pane that shuts marks nothing', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    arrives(f, 'p1', 'a thread to open');
    openPane(f, badgeFor(f, 'p1'));
    const pane = f.doc.querySelector('.tb-popup');
    const ta = pane.querySelector('textarea');
    ta.value = 'sent, and the Pane shuts'; ta.dispatchEvent({ type: 'input' });
    pane.querySelector('.tb-save').click();
    f.env.flushTimers(); f.env.drainMicrotasks();
    assert.equal(f.doc.querySelector('.tb-popup'), null, 'no transport: it closes on commit');
    assert.equal(f.core.unreadCount('block:p1'), 0, 'and what they sent is not new to them');
    assert.ok(!badgeFor(f, 'p1').classList.contains('tb-unread'));
  } finally { f.restore(); }
});

test('rows 4-6 (drawn) — an answer from outside marks only while it is out of sight', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const id = arrives(f, 'p1', 'a thread');
    openPane(f, badgeFor(f, 'p1'));
    assert.equal(f.core.unreadCount('block:p1'), 0);

    replyArrives(f, id, 'answered in front of them');          // row 6 — shown
    assert.equal(f.core.unreadCount('block:p1'), 0, 'row 6: read as it lands');
    assert.ok(!badgeFor(f, 'p1').classList.contains('tb-unread'));

    f.doc.querySelector('.tb-popup').querySelector('.tb-cancel').click();
    f.env.drainMicrotasks();
    replyArrives(f, id, 'answered while they were away');      // row 5 — Pane shut
    assert.equal(f.core.unreadCount('block:p1'), 1, 'row 5: out of sight, so new');
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'), 'and the reader can see where');

    openPane(f, badgeFor(f, 'p1'));
    assert.equal(f.core.unreadCount('block:p1'), 0, 'opening it clears it');
  } finally { f.restore(); }
});

test('row 7 (drawn) — typing does not take somebody else\'s mark down', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const id = arrives(f, 'p1', 'a thread');
    openPane(f, badgeFor(f, 'p1'));
    f.doc.querySelector('.tb-popup').querySelector('.tb-cancel').click();
    f.env.drainMicrotasks();
    replyArrives(f, id, 'arrived, and never looked at');
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'));

    f.core.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'and then I typed something' });
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 1, 'still exactly one, and it is still theirs');
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'), 'the mark is still up');
  } finally { f.restore(); }
});

// ---- the unread mark as the product's own default -------------------------------------------------
//
// WHAT THESE CAN AND CANNOT SEE. The fake document's `getComputedStyle` answers with `position` and
// nothing else, and there is no `getAnimations`, so no test here can say what a mark LOOKS like. What
// they can say is what the panel WROTE — the rules it puts on the page — and that is what they say.
// Whether those rules produce an orange that breathes is checked in a real browser, and is not
// claimed here. Building a fake that resolved the cascade would only move the lie somewhere quieter.

const panelCSS = (f) => (f.doc.head.children || []).map((c) => c.textContent || '').join('\n');
/**
 * Every rule that names this selector, joined — not the first one found.
 *
 * A selector appears more than once on purpose: the reduced-motion block names the same three marks
 * in order to stop their movement. Reading only the first match found whichever came earlier in the
 * file, which is a property of the file rather than of the rule being asked about.
 */
const unreadRule = (css, sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`[^{}@]*${esc}[^{}]*\\{[^}]*\\}`, 'g'))].map((m) => m[0]).join('\n');
};

test('S3-U1: the mark the panel writes for unread is a FILL, and the ring it replaces is gone', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const css = panelCSS(f);
    for (const sel of ['.tb-badge.tb-unread', '.tb-pin.tb-unread']) {
      const rule = unreadRule(css, sel);
      assert.match(rule, /background:\s*var\(--tb-unread\)\s*!important/, `${sel}: filled`);
      assert.doesNotMatch(rule, /box-shadow:\s*0 0 0 2px var\(--tb-unread\)/, `${sel}: not also ringed`);
    }
    const lane = unreadRule(css, '.tb-lane.tb-unread .tb-lane-count');
    assert.match(lane, /background:\s*var\(--tb-unread\)\s*!important/, 'the lane count too');
  } finally { f.restore(); }
});

test('S3-U2: it breathes on the agreed cycle, and the cycle it names is defined', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const css = panelCSS(f);
    for (const sel of ['.tb-badge.tb-unread', '.tb-pin.tb-unread', '.tb-lane.tb-unread .tb-lane-count']) {
      assert.match(unreadRule(css, sel), /animation:\s*tb-unread-pulse\s+2s\b/, `${sel}: 2s pulse`);
    }
    assert.match(css, /@keyframes\s+tb-unread-pulse\s*\{/, 'and the cycle exists');
  } finally { f.restore(); }
});

test('S3-U3: a reader who asked for less movement gets the mark without the movement', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const css = panelCSS(f);
    const guard = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(css);
    assert.ok(guard, 'the guard exists');
    assert.match(guard[1], /animation:\s*none/, 'and it stops the movement');
    assert.doesNotMatch(guard[1], /background|display\s*:\s*none/, 'and takes nothing else with it');
  } finally { f.restore(); }
});

test('S3-U4: the ink on the fill follows the base, and is not a token anyone can take apart', () => {
  const light = mountPanel({ instrument: true, setup: twoBlocks, theme: 'light' });
  try {
    assert.match(panelCSS(light), /\.tb-badge\.tb-unread[\s\S]{0,200}?color:\s*#ffffff\s*!important/,
      'white on the light fill');
  } finally { light.restore(); }
  const dark = mountPanel({ instrument: true, setup: twoBlocks, theme: 'dark' });
  try {
    assert.match(panelCSS(dark), /\.tb-badge\.tb-unread[\s\S]{0,200}?color:\s*#000000\s*!important/,
      'black on the darker one');
    assert.doesNotMatch(panelCSS(dark), /--tb-unread-(ink|fg|text)/, 'and no new token was published for it');
  } finally { dark.restore(); }
});

// ---- what the change must NOT reach ---------------------------------------------------------------

test('L3-1: changing what unread looks like moves nothing else', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const css = panelCSS(f);
    for (const [token, value] of [['--tb-accent', '#33aa77'], ['--tb-mark-outline', '#d9a400'],
      ['--tb-pin-bg', '#d9a400'], ['--tb-attention', '#ef7f0e']]) {
      assert.match(css, new RegExp(`${token}:\\s*${value}`), `${token} is where it was`);
    }
  } finally { f.restore(); }
});

test('L3-2: unread is not in the palettes yet — that is a later version\'s question', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks, theme: 'ocean' });
  try {
    assert.match(panelCSS(f), /--tb-unread:\s*#ef7f0e/, 'a palette leaves the mark alone');
  } finally { f.restore(); }
});

test('L3-3: a caller can still say what the mark should look like', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks, theme: { '--tb-unread': '#123456' } });
  try {
    assert.match(panelCSS(f), /--tb-unread:\s*#123456/, 'the default did not seal the door');
  } finally { f.restore(); }
});

test('L3-4: only what is unread breathes', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const css = panelCSS(f);
    const animated = [...css.matchAll(/([^{}]+)\{[^}]*animation:\s*tb-unread-pulse[^}]*\}/g)]
      .map((m) => m[1].trim());
    for (const sel of animated) assert.match(sel, /tb-unread/, `${sel} breathes, and it should not`);
    assert.doesNotMatch(unreadRule(css, '.tb-badge.tb-attn'), /animation/, 'attention alone is still');
  } finally { f.restore(); }
});

test('L3-5: hiding the marks hides the areas too, and changes nothing about what is unread', () => {
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const css = panelCSS(f);
    const hide = (new RegExp('\\.tb-hide[^{]*\\{[^}]*\\}', 'g').exec(css) || [''])[0];
    for (const what of ['.tb-badge', '.tb-pin', '.tb-region', '.tb-mark']) {
      assert.match(hide, new RegExp(`\\${what}\\b`), `${what} goes with the rest`);
    }
    assert.match(css, /tb-hide\s+::highlight\(tb-range\)/, 'and so does a highlighted quote');

    arrives(f, 'p1', 'while the marks are on');
    assert.equal(f.core.unreadCount('block:p1'), 1);
    f.panel.toggleMarks();
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 1, 'hiding is not reading');
    arrives(f, 'p2', 'and this arrives while they are hidden');
    assert.equal(f.core.unreadCount('block:p2'), 1, 'what arrives out of sight still counts');
    f.panel.toggleMarks();
    f.env.drainMicrotasks();
    assert.ok(badgeFor(f, 'p2').classList.contains('tb-unread'), 'and is there when they look again');
  } finally { f.restore(); }
});

test('L3-6: the lane count wears the speaker\'s colour, and unread still outweighs it', () => {
  const f = mountPanel({ instrument: true });
  try {
    f.panel.setActorColors({ human: '#db2777' });
    f.panel.toggleDocumentLane(true);
    f.core.addComment({ anchor: { type: 'document' }, body: 'mine', author: { id: 'me', kind: 'human' } });
    f.env.drainMicrotasks();
    const count = () => f.lane().querySelector('.tb-lane-count');
    assert.ok(count().classList.contains('tb-tinted'), 'read: it carries a colour at all');
    assert.equal(count().style.background, '#db2777', 'and it is the colour of whoever spoke last');

    f.panel.toggleDocumentLane(false);
    f.env.drainMicrotasks();
    arrives(f, 'document', 'theirs, while it is folded');
    assert.ok(f.lane().classList.contains('tb-unread'));
    assert.match(unreadRule(panelCSS(f), '.tb-lane.tb-unread .tb-lane-count'),
      /background:\s*var\(--tb-unread\)\s*!important/, 'unread is written to outweigh the inline tint');
  } finally { f.restore(); }
});

// ---- the rest of the reader's actions, at the layer that can hold them -----------------------------
//
// The seven rows were fixed on block and document anchors. These carry the same rule to the two kinds
// that were never asked — a quote and an area — and to the acts around it: deleting an anchor, hiding
// the marks, and the document thread when it has no lane to live in.

const anchorArrives = (f, anchor, body = 'from somewhere else') => {
  const id = `arr-${arrivalSeq += 1}`;
  f.core.importEnvelope({
    schemaVersion: 1, generator: { name: 'tackback', version: 'x' }, document: { id: 'panel-fixture' },
    comments: [{ id, anchor, body, createdAt: '2026-08-10T00:00:00.000Z', replies: [] }],
  }, { mode: 'merge' });
  f.env.drainMicrotasks();
  return id;
};
const QUOTE = { type: 'range', elementId: 'p1', selector: { exact: 'paragraph p1' } };
const AREA = { type: 'region', surfaceId: 'document', rect: { x: .1, y: .1, width: .2, height: .2 } };

test('A3: writing on an area is not news to the person who wrote it', () => {
  // A QUOTE cannot be exercised here: resolving one walks the text with `createTreeWalker`, which the
  // fake document does not have. That half is confirmed in a real browser instead, and is not claimed
  // by any test in this file.
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    f.core.addComment({ anchor: AREA, body: 'my note on an area' });
    f.env.drainMicrotasks();
    assert.deepEqual(f.core.unreadThreads(), [], 'an area they drew on themselves is not news');
  } finally { f.restore(); }
});

test('B4: an answer into an area thread marks it', () => {
  // Only the arrival half. Opening an area's badge goes through a pointer sequence rather than a
  // click — the badge would be destroyed by the redraw before a click event could fire — so "opening
  // it clears it" is confirmed in a real browser, not here.
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    const id = anchorArrives(f, AREA, 'somebody else drew this');
    assert.equal(f.core.unreadCount(`region:${id}`), 1, 'it arrived from outside, so it is new');
    const mark = f.doc.querySelector('.tb-pin');
    assert.ok(mark, 'an area carries a badge of its own');
    assert.ok(mark.classList.contains('tb-unread'), 'and it wears the mark');
  } finally { f.restore(); }
});

test('deleting the whole anchor takes its mark and its unread with it', () => {
  // The general rule stated the other way round: nothing unread left means nothing to mark.
  const f = mountPanel({ instrument: true, setup: twoBlocks });
  try {
    arrives(f, 'p1', 'unread, and about to be deleted');
    assert.equal(f.core.unreadCount('block:p1'), 1);
    assert.ok(badgeFor(f, 'p1').classList.contains('tb-unread'));

    f.core.deleteComments(f.core.listComments().map((c) => c.id));
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('block:p1'), 0, 'nothing left to be unread about');
    assert.deepEqual(f.core.unreadThreads(), []);
    assert.equal(badgeFor(f, 'p1'), undefined, 'and no mark left over');
  } finally { f.restore(); }
});

test('D4: with no lane, the document thread is an ordinary Pane and behaves like one', () => {
  // `docLane: false` does not remove the thread — it stops giving it a bar of its own, so it opens
  // the way every other thread does.
  const f = mountPanel({ controls: { docLane: false }, instrument: true, setup: twoBlocks });
  try {
    assert.equal(f.lane(), null, 'no bar');
    anchorArrives(f, { type: 'document' }, 'theirs, about the whole thing');
    assert.equal(f.core.unreadCount('document'), 1, 'and it is still new when it arrives');
    f.panel.openDocumentThread();
    f.env.drainMicrotasks();
    assert.equal(f.core.unreadCount('document'), 0, 'and opening it still reads it');
  } finally { f.restore(); }
});

// E4 (a save that fails is reported) is fixed where the failure happens — see unread.test
// 'a failed save does not undo what the reader did', which asserts the STORAGE_SAVE_FAILED code. The
// panel adds nothing to that path, so a second copy here would only restate it further from the fact.
