// node:test — the contract of the thing a thread is shown in.
//
// The existing suite cannot stand in for this. It describes what the panel DOES, and this change is
// meant to alter nothing about that — so a host that answered "can the reader see this" wrongly
// would leave every one of those tests green and only surface later, as a thread whose mark will not
// clear, in a part of the code that did not cause it.
//
// The factory touches no DOM of its own; it reads and toggles a class on an element it was handed.
// So the element here is the smallest thing that can carry a class.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/panel/host.js';

/** Just enough element to hold a class, because that is all the factory ever asks of one. */
const fakeEl = () => {
  const set = new Set();
  return {
    classes: set,
    classList: {
      contains: (c) => set.has(c),
      toggle: (c, on) => { if (on === undefined ? set.has(c) : !on) set.delete(c); else set.add(c); },
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
    },
  };
};

const fakeConv = (identity = 'block:x') => {
  let anchor = { type: 'block', elementId: 'x' };
  let memo = null;
  let disposed = 0;
  return {
    identity: () => identity,
    anchorOf: () => anchor,
    anchorMemo: (a) => { if (a) memo = a; return memo; },
    dispose: () => { disposed += 1; },
    get disposed() { return disposed; },
    setAnchor: (a) => { anchor = a; },
  };
};

test('host: one that cannot fold is open for as long as it exists', () => {
  const calls = [];
  const host = createHost({ collapsible: false }, () => calls.push('changed'));
  assert.equal(host.timelineOpen(), false, 'nothing is shown before a conversation is attached');

  const el = fakeEl();
  host.attach(fakeConv(), el);
  assert.equal(host.timelineOpen(), true, 'attached and alive is all it takes');

  // The class this host does not use must not be able to speak for it.
  el.classList.add('tb-docbar-open');
  assert.equal(host.timelineOpen(), true);
  el.classList.remove('tb-docbar-open');
  assert.equal(host.timelineOpen(), true, 'a Pane does not lack a thread area — it keeps its open');

  host.dispose();
  assert.equal(host.timelineOpen(), false, 'and it is gone when the host is');
});

test('host: one that can fold follows its class and nothing else', () => {
  const host = createHost({ collapsible: true }, () => {});
  const el = fakeEl();
  host.attach(fakeConv('document'), el);
  assert.equal(host.timelineOpen(), false, 'folded away is not readable, even though it is present');

  el.classList.add('tb-docbar-open');
  assert.equal(host.timelineOpen(), true);

  host.dispose();
  assert.equal(host.timelineOpen(), false, 'and the class cannot outlive the host');
  assert.equal(el.classList.contains('tb-docbar-open'), true, 'the class itself is the caller\'s to clean up');
});

test('host: identity and anchor are the conversation\'s to answer, or nobody\'s', () => {
  for (const collapsible of [false, true]) {
    const host = createHost({ collapsible }, () => {});
    assert.equal(host.identity(), null, `collapsible=${collapsible}: no conversation, no identity`);
    assert.equal(host.anchorOf(), null);

    // Written with escapes rather than the bytes themselves: a real range key joins its parts
    // with NUL, and a source file carrying one as a byte is binary to every tool that would diff it.
    const conv = fakeConv('range:para\u0000quote\u00000');
    host.attach(conv, fakeEl());
    assert.equal(host.identity(), 'range:para\u0000quote\u00000');
    assert.deepEqual(host.anchorOf(), { type: 'block', elementId: 'x' });

    // Read through, never remembered here: a conversation adopts its identity at its first commit.
    conv.setAnchor({ type: 'region', surfaceId: 'document', rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } });
    assert.equal(host.anchorOf().type, 'region', 'the host asks every time rather than keeping a copy');

    host.anchorMemo({ type: 'block', elementId: 'remembered' });
    assert.deepEqual(host.anchorMemo(), { type: 'block', elementId: 'remembered' });

    host.dispose();
    assert.equal(host.identity(), null, 'and a released host answers for nobody');
    assert.equal(host.anchorOf(), null);
  }
});

test('host: folding announces exactly once, and only where folding means something', () => {
  const folding = [];
  const collapsible = createHost({ collapsible: true }, () => folding.push(1));
  const el = fakeEl();
  collapsible.attach(fakeConv(), el);

  assert.equal(collapsible.setOpen(true), true);
  assert.equal(folding.length, 1, 'one announcement per change of what can be seen');
  assert.equal(el.classList.contains('tb-docbar-open'), true);

  assert.equal(collapsible.setOpen(), false, 'no argument means the other way');
  assert.equal(folding.length, 2);
  assert.equal(el.classList.contains('tb-docbar-open'), false);

  const fixed = [];
  const notCollapsible = createHost({ collapsible: false }, () => fixed.push(1));
  const el2 = fakeEl();
  notCollapsible.attach(fakeConv(), el2);
  assert.equal(notCollapsible.setOpen(false), true, 'it cannot be folded, so it reports what it is');
  assert.deepEqual(fixed, [], 'and says nothing, because nothing changed');
  assert.equal(el2.classList.contains('tb-docbar-open'), false, 'nor did it touch the class');
});

test('host: releasing hands the root back, disposes the conversation, and is idempotent', () => {
  const calls = [];
  const host = createHost({ collapsible: true }, () => calls.push(1));
  const el = fakeEl();
  const conv = fakeConv();
  host.attach(conv, el);

  const returned = host.dispose();
  assert.equal(returned, el, 'the root comes back so the caller can take it off the page');
  assert.equal(conv.disposed, 1, 'the conversation goes with it');
  assert.equal(host.alive, false);
  assert.equal(calls.length, 1, 'released is a change to what can be seen, and is announced once');

  assert.equal(host.dispose(), null, 'a second release has nothing to hand back');
  assert.equal(conv.disposed, 1, 'and does not dispose twice');
  assert.equal(calls.length, 1, 'nor announce twice');
  assert.equal(host.setOpen(true), false, 'a released host cannot be reopened');
});
