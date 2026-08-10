// node:test — the demo pages, which until now nothing checked.
//
// They were the only human gate on a release and the only artefact no machine looked at, so the one
// thing that could rot there did: both pages went on expressing "unread" the way they had to before
// the library could, by raising the generic attention flag when an answer arrived and lowering it on
// a click. A reply landing in a thread that was already open produced no click, so the mark stayed up
// while it was being read — the exact failure the library now exists to remove, on the page a release
// is accepted from.
//
// WHAT IS FORBIDDEN IS NARROW, AND HAS TO BE. Attention is a good thing for a demo to show: it is a
// generic flag whose meaning belongs to whoever raises it, and seeing it sit beside unread — one
// fills, the other rings — is how an integrator learns it does not have to choose. Both pages have a
// control that raises it, deliberately. What no page may do is raise it BECAUSE SOMETHING ARRIVED,
// because arrival is not the question. The question is what is on screen, and only the library can
// see that.
//
// WHAT THESE CAN AND CANNOT SEE. They read the pages as text. That catches the shape of the mistake
// and nothing else: neither page is executed here, so a page that marks things some new way walks
// straight past. The behaviour itself is fixed where it belongs, against the real panel — see
// panel-dom.test T48/T49/T52. These are the guard that the demos do not go back to answering a
// question the library now answers.

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
      const text = readFileSync(join(root, dir, name), 'utf8');
      // a harness is not a demo: it exists to prove the bundle loads, and drives nothing
      if (!/attachPanel|Tackback\.mount/.test(text)) continue;
      pages.push({ rel: `${dir}/${name}`, text });
    }
  }
  return pages;
}

/** The source from `start` to the brace that closes the block it opens. */
function blockAt(text, start) {
  const from = text.indexOf('{', start);
  if (from < 0) return '';
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(from, i + 1); }
  }
  return text.slice(from);
}

/**
 * Everything that runs BECAUSE something arrived: the simulated participant, and every handler the
 * page hangs off an event that carries an arrival. Brace-matched rather than "the next N characters",
 * so a handler that grows does not quietly walk out of what is being read.
 */
function arrivalPaths(text) {
  const paths = [];
  const answer = text.indexOf('function answerOn');
  if (answer >= 0) paths.push({ what: 'answerOn()', code: blockAt(text, answer) });
  const ARRIVAL_EVENTS = ['comment:add', 'comment:update', 'change', 'submit:batch'];
  for (const ev of ARRIVAL_EVENTS) {
    const re = new RegExp(`\\.on\\(\\s*['"]${ev.replace(':', ':')}['"]`, 'g');
    for (const m of text.matchAll(re)) paths.push({ what: `on('${ev}')`, code: blockAt(text, m.index) });
  }
  return paths;
}

const RAISES_ATTENTION = /setAnchorAttention\s*\([^)]*\)/g;
/** A raise is anything that is not, plainly, a lowering. Uncertainty counts as a raise on purpose. */
const isRaise = (call) => !/,\s*false\s*\)$/.test(call);

test('the demo pages exist and are found, so an empty sweep cannot pass for a clean one', () => {
  const pages = demoPages();
  assert.ok(pages.some((p) => p.rel === 'demo/demo.html'), 'the bundled demo is in the sweep');
  assert.ok(pages.some((p) => p.rel === 'docs/index.html'), 'the hosted demo is in the sweep');
  for (const p of pages) assert.ok(arrivalPaths(p.text).length > 0, `${p.rel}: its arrival path was found`);
});

test('T50: no demo page raises a mark of its own because something arrived', () => {
  const offenders = [];
  for (const { rel, text } of demoPages()) {
    for (const { what, code } of arrivalPaths(text)) {
      for (const call of code.match(RAISES_ATTENTION) || []) {
        if (isRaise(call)) offenders.push(`${rel} → ${what}: ${call}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `a demo is marking on arrival again — arrival is not the question, what is on screen is:\n  ${offenders.join('\n  ')}`);
});

test('T51: no demo page decides "read" from a click, either', () => {
  // The other half, and the half that turned a redundancy into a bug. Clearing on a click only ever
  // reaches a reader who was somewhere else; the reader watching the thread it lands in never clicks,
  // so the mark stays up in front of them. A page-wide click handler that lowers a mark has rebuilt
  // that trap. A CONTROL that toggles attention has not — it is a button, not a theory of reading.
  const offenders = [];
  for (const { rel, text } of demoPages()) {
    for (const m of text.matchAll(/addEventListener\s*\(\s*['"]click['"]/g)) {
      const code = blockAt(text, m.index);
      if (/setAnchorAttention/.test(code)) offenders.push(`${rel}: a page-wide click handler moves an attention flag`);
    }
  }
  assert.deepEqual(offenders, [],
    `a demo is deciding "read" for itself again:\n  ${offenders.join('\n  ')}`);
});

test('T50/T51: the sweep answers about real text, and is not just failing to match', () => {
  // The failure an absence check has: reading nothing, finding nothing, and reporting that as clean.
  // So the same reading is pointed at the wiring that was actually removed, which it must catch, and
  // at the control that replaced it, which it must not.
  const wasWrong = `
    function answerOn(commentId) {
      tb.addReply(commentId, { body: 'x' });
      tb.setAnchorAttention(commentId, true);
    }
    document.addEventListener('click', (e) => { tb.setAnchorAttention(e.id, false); }, true);
  `;
  const raisedOnArrival = arrivalPaths(wasWrong)
    .flatMap(({ code }) => (code.match(RAISES_ATTENTION) || []).filter(isRaise));
  assert.equal(raisedOnArrival.length, 1, 'the removed raise is found where it was');

  const clickHandler = blockAt(wasWrong, wasWrong.indexOf("addEventListener('click'"));
  assert.match(clickHandler, /setAnchorAttention/, 'and the removed click-clear is found too');

  const theControl = `
    let attentionOn = false;
    mkBtn('Attention: off', (b) => {
      attentionOn = !attentionOn;
      for (const c of tb.listComments()) tb.setAnchorAttention(c.id, attentionOn);
    });
  `;
  assert.deepEqual(arrivalPaths(theControl), [], 'a button is not an arrival path, so the control is left alone');
});
