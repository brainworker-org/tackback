// node:test — the demo pages, which until now nothing checked.
//
// They were the only human gate on a release and the only artefact no machine looked at, so the one
// thing that could rot there did: both pages went on expressing "unread" the way they had to before
// the library could, by raising the generic attention flag when an answer arrived and lowering it on
// a click. A reply landing in a thread that was already open produced no click, so the mark stayed up
// while it was being read — the exact failure the library now exists to remove, on the page a release
// is accepted from.
//
// WHAT THESE CAN AND CANNOT SEE. They read the pages as text. That catches the shape of the mistake —
// a page taking arrival as its own cue to mark something — and it does not execute either page, so it
// cannot catch a page that marks things some new way. The behaviour itself is fixed where it belongs,
// against the real panel: panel-dom.test T48/T49/T52. These are the guard that the demos do not go
// back to answering a question the library now answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Every demo page in the package, found rather than listed — a new one is covered the day it exists. */
function demoPages() {
  const pages = [];
  for (const dir of ['demo', 'docs']) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith('.html')) continue;
      const rel = `${dir}/${name}`;
      const text = readFileSync(join(root, dir, name), 'utf8');
      // a harness is not a demo: it exists to prove the bundle loads, and drives nothing
      if (!/attachPanel|Tackback\.mount/.test(text)) continue;
      pages.push({ rel, text });
    }
  }
  return pages;
}

test('the demo pages exist and are found, so an empty sweep cannot pass for a clean one', () => {
  const pages = demoPages();
  assert.ok(pages.length >= 2, `expected the bundled and hosted demos, found: ${pages.map((p) => p.rel).join(', ') || 'none'}`);
  assert.ok(pages.some((p) => p.rel === 'demo/demo.html'), 'the bundled demo');
  assert.ok(pages.some((p) => p.rel === 'docs/index.html'), 'the hosted demo');
});

test('T50: no demo page turns an arrival into a mark of its own', () => {
  // `setAnchorAttention(x, true)` is the whole of it. Attention is a fine thing for a page to
  // demonstrate — it is a generic flag whose meaning belongs to whoever raises it — but a page that
  // raises it because something ARRIVED has re-implemented unread, and will mark a thread the reader
  // is looking at, because arrival is not the question. The question is what is on screen, and only
  // the library can see that.
  const offenders = [];
  for (const { rel, text } of demoPages()) {
    const raised = [...text.matchAll(/setAnchorAttention\s*\(([^)]*)\)/g)]
      .filter((m) => !/,\s*false\s*$/.test(m[1]));
    if (raised.length) offenders.push(`${rel}: ${raised.map((m) => m[0]).join(' / ')}`);
  }
  assert.deepEqual(offenders, [], `a demo is marking threads itself again:\n  ${offenders.join('\n  ')}`);
});

test('T51: no demo page implements its own clearing, either', () => {
  // The other half, and the half that made it a bug rather than a redundancy. Clearing on a CLICK
  // only ever reaches a reader who was somewhere else; the reader watching the thread it lands in
  // never clicks, so the mark stays. Any page lowering a flag from a click handler has rebuilt the
  // same trap, whichever flag it is.
  const offenders = [];
  for (const { rel, text } of demoPages()) {
    if (/addEventListener\s*\(\s*['"]click['"][\s\S]{0,600}?setAnchorAttention/.test(text)) {
      offenders.push(`${rel}: a click handler lowers an attention flag`);
    }
  }
  assert.deepEqual(offenders, [], `a demo is deciding "read" for itself again:\n  ${offenders.join('\n  ')}`);
});

test('T50/T51: the sweep is answering about the real files, not about an empty set', () => {
  // The failure these two would have as absence checks: matching nothing because the reading is
  // broken, and reporting that as clean. So the same reading is pointed at text that MUST match.
  const raised = /setAnchorAttention\s*\(([^)]*)\)/;
  const clickClear = /addEventListener\s*\(\s*['"]click['"][\s\S]{0,600}?setAnchorAttention/;
  const wasWrong = `
    function answerOn(commentId) {
      tb.addReply(commentId, { body: 'x' });
      tb.setAnchorAttention(commentId, true);
    }
    document.addEventListener('click', (e) => { tb.setAnchorAttention(e.id, false); }, true);
  `;
  assert.match(wasWrong, raised, 'the reading finds a raise where there is one');
  assert.match(wasWrong, clickClear, 'and finds a click-clear where there is one');
  assert.doesNotMatch('tb.setAnchorAttention(c.id, false);', clickClear, 'and does not cry wolf over a bare lowering');
});
