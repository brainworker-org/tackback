// node:test — pure interaction logic: gesture classification (REQ-006), popup commit behavior
// (REQ-702/703), region handle hit-test + move/resize (REQ-008). These are the headless DECISIONS the
// panel wires PointerEvents to; real-pointer reliability (NFR-005) + visual reposition (NFR-009) are
// the manual-gate residue (skip-marked in conformance.test). Spec-first: each MUST has a real test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGesture, popupCommit, canCommit, nextSendState, answersSend, handleAt, applyHandleDrag, resolveLaneLayout } from '../src/panel/interaction.js';

// ---- REQ-006: gesture = right-drag>threshold → region; below → selection→range / none→block --------

test('classifyGesture: right-drag past threshold over a surface → region', () => {
  assert.equal(classifyGesture({ button: 2, dragDist: 12, threshold: 8, hasSelection: false, onSurface: true }), 'region');
  // below threshold over a surface → DOM anchor, not a region
  assert.equal(classifyGesture({ button: 2, dragDist: 3, threshold: 8, hasSelection: false, onSurface: true }), 'block');
});

test('classifyGesture: below threshold → range when text selected, else block; non-right → none', () => {
  assert.equal(classifyGesture({ button: 2, dragDist: 0, threshold: 8, hasSelection: true, onSurface: true }), 'range');
  assert.equal(classifyGesture({ button: 2, dragDist: 0, threshold: 8, hasSelection: false, onSurface: false }), 'block');
  assert.equal(classifyGesture({ button: 0, dragDist: 99, threshold: 8, hasSelection: false, onSurface: true }), 'none', 'left button is not a tackback gesture');
});

test('classifyGesture: a drag past threshold but NOT over a surface stays a DOM anchor', () => {
  assert.equal(classifyGesture({ button: 2, dragDist: 50, threshold: 8, hasSelection: true, onSurface: false }), 'range');
});

// ---- REQ-702/703: popup commit affordance + close vs stay-open by transport ------------------------

test('popupCommit: no transport → save + close; fire-and-forget → send + close; interactive → send + stay-open', () => {
  assert.deepEqual(popupCommit(null), { action: 'save', closeOnCommit: true, conversation: false });
  assert.deepEqual(popupCommit({ interactive: false }), { action: 'send', closeOnCommit: true, conversation: false });
  assert.deepEqual(popupCommit({ interactive: true }), { action: 'send', closeOnCommit: false, conversation: true });
});

test('canCommit: body OR reaction enables the commit button; empty/whitespace-only does not', () => {
  assert.equal(canCommit('', ''), false, 'nothing to commit');
  assert.equal(canCommit('   \n\t ', ''), false, 'whitespace-only text is still empty');
  assert.equal(canCommit('a note', ''), true);
  assert.equal(canCommit('', 'agree'), true, 'a reaction alone is a valid commit');
  assert.equal(canCommit('   ', 'agree'), true);
  assert.equal(canCommit(null, null), false, 'absent inputs behave as empty, never throw');
  assert.equal(canCommit(undefined, undefined), false);
});

test('canCommit: the state AFTER an interactive send is disabled again (the stay-open reset)', () => {
  // an interactive (stay-open) commit clears BOTH inputs; re-running the rule must disable the
  // button — otherwise the next click hits the empty-commit path and dismisses the conversation.
  assert.equal(popupCommit({ interactive: true }).closeOnCommit, false, 'the popup stays open');
  assert.equal(canCommit('', ''), false, 'cleared text + cleared reaction → disabled');
});

test('answersSend: an utterance answers a send; an anchor move never does', () => {
  const reply = { kind: 'reply', key: 'r:a:0:a1' };
  const moved = { kind: 'event', key: 'e:0:t:move' };
  assert.equal(answersSend([reply]), true);
  assert.equal(answersSend([moved]), false, 'dragging the anchor is not something anyone said');
  assert.equal(answersSend([moved, reply]), true, 'the utterance still counts alongside the move');
  assert.equal(answersSend([]), false);
  assert.equal(answersSend(null), false);
});

test('answersSend: the utterance just committed does not answer itself', () => {
  const own = { kind: 'comment', key: 'c:new' };
  assert.equal(answersSend([own], 'c:new'), false, 'your own send is drawn before the marker exists');
  // …but a reply that arrived synchronously during the same commit DOES answer it: an integrator can
  // reply from its comment:add handler, before the commit call has even returned.
  const sync = { kind: 'reply', key: 'r:new:0:x' };
  assert.equal(answersSend([own, sync], 'c:new'), true, 'a synchronous answer must not be missed');
  // a second, unrelated comment in the thread counts too
  assert.equal(answersSend([own, { kind: 'comment', key: 'c:other' }], 'c:new'), true);
});

test('nextSendState: pending → ok on ack/reply, → failed on error/timeout (never an indefinite hang)', () => {
  assert.equal(nextSendState('pending', 'ack'), 'ok');
  assert.equal(nextSendState('pending', 'reply'), 'ok');
  assert.equal(nextSendState('pending', 'error'), 'failed');
  assert.equal(nextSendState('pending', 'timeout'), 'failed');
  assert.equal(nextSendState(undefined, undefined), 'pending');
});

// ---- REQ-008: handle hit-test (topmost-first) + move/resize with clamp + min-size guard ------------

test('handleAt: corner handles win over the body (topmost-first); outside → null', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  assert.equal(handleAt(100, 100, rect), 'nw');
  assert.equal(handleAt(300, 100, rect), 'ne');
  assert.equal(handleAt(100, 200, rect), 'sw');
  assert.equal(handleAt(300, 200, rect), 'se');
  assert.equal(handleAt(200, 150, rect), 'move', 'inside the body → move');
  assert.equal(handleAt(500, 500, rect), null, 'outside → null');
});

test('applyHandleDrag: move translates and clamps into bounds', () => {
  const rect = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  assert.deepEqual(applyHandleDrag(rect, 'move', 0.1, 0.1, 0.01), { x: 0.5, y: 0.5, width: 0.2, height: 0.2 });
  // move toward the edge clamps so the rect stays in [0,1]
  const r2 = applyHandleDrag(rect, 'move', 1, 1, 0.01);
  assert.equal(+(r2.x + r2.width).toFixed(4), 1); assert.equal(+(r2.y + r2.height).toFixed(4), 1);
});

test('applyHandleDrag: corner resize adjusts that corner; opposite edge fixed', () => {
  const rect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };  // se corner at (0.7,0.7)
  const r = applyHandleDrag(rect, 'se', 0.1, 0.1, 0.01);
  assert.deepEqual({ x: r.x, y: r.y, width: +r.width.toFixed(4), height: +r.height.toFixed(4) }, { x: 0.3, y: 0.3, width: 0.5, height: 0.5 });
  // nw corner moves the top-left, keeps bottom-right fixed
  const r2 = applyHandleDrag(rect, 'nw', 0.1, 0.1, 0.01);
  assert.equal(+(r2.x).toFixed(4), 0.4); assert.equal(+(r2.x + r2.width).toFixed(4), 0.7, 'right edge fixed');
});

test('applyHandleDrag: a resize below min-size (toward zero area) is REJECTED (null) — REQ-008', () => {
  const rect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
  // drag the se corner back almost onto the nw corner → width/height ~0 → rejected
  assert.equal(applyHandleDrag(rect, 'se', -0.4, -0.4, 0.01), null);
  // a legitimate small-but-above-min resize is allowed
  assert.ok(applyHandleDrag(rect, 'se', -0.35, -0.35, 0.01));
});

// ---- the document lane's placement, which has to survive a host that answers back ---------------

test('resolveLaneLayout: beside when it is wide enough to type into, above when it is not', () => {
  assert.deepEqual(resolveLaneLayout(() => 600), { stacked: false, width: 600, fits: true });
  const roomyAbove = (stacked) => (stacked ? 680 : 120);
  assert.deepEqual(resolveLaneLayout(roomyAbove), { stacked: true, width: 680, fits: true });
});

test('resolveLaneLayout: a host that answers back cannot make it flicker', () => {
  // the reason each candidate is measured under its OWN state: a host moves its bottom chrome out
  // of the way when told the lane stacked, so "beside" is narrow while the host is there and roomy
  // once it has gone. Deciding from a single measurement gives a good frame and a flicker after it.
  const answersBack = (stacked) => (stacked ? 700 : 120);
  const a = resolveLaneLayout(answersBack);
  const b = resolveLaneLayout(answersBack);
  const c = resolveLaneLayout(answersBack);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.equal(a.stacked, true, 'and it settles on the state that is actually usable');
});

test('resolveLaneLayout: it asks about beside first, and only asks about above when it has to', () => {
  const asked = [];
  resolveLaneLayout((stacked) => { asked.push(stacked); return 600; });
  assert.deepEqual(asked, [false], 'a roomy beside is not second-guessed');
  asked.length = 0;
  resolveLaneLayout((stacked) => { asked.push(stacked); return stacked ? 600 : 100; });
  assert.deepEqual(asked, [false, true], 'and each candidate is measured exactly once');
});

test('resolveLaneLayout: when nothing fits, it says so and takes the wider state anyway', () => {
  const cramped = () => 100;
  const r = resolveLaneLayout(cramped, { min: 320 });
  assert.equal(r.stacked, true, 'above is never narrower than beside');
  assert.equal(r.fits, false, 'and the caller is told it did not fit');
});
