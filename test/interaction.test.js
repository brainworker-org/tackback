// node:test — pure interaction logic: gesture classification (REQ-006), popup commit behavior
// (REQ-702/703), region handle hit-test + move/resize (REQ-008). These are the headless DECISIONS the
// panel wires PointerEvents to; real-pointer reliability (NFR-005) + visual reposition (NFR-009) are
// the manual-gate residue (skip-marked in conformance.test). Spec-first: each MUST has a real test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGesture, popupCommit, nextSendState, handleAt, applyHandleDrag } from '../src/panel/interaction.js';

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
