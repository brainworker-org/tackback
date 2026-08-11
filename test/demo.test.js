// node:test — the demo pages, which until now nothing checked.
//
// They were the only human gate on a release and the only artefact no machine looked at, so the one
// thing that could rot there did: both pages went on expressing "unread" the way they had to before
// the library could, by raising a generic "look at this" flag when an answer arrived and lowering it
// on a click. A reply landing in a thread that was already open produced no click, so the mark stayed up
// while it was being read — the exact failure the library now exists to remove, on the page a release
// is accepted from.
//
// The correction after that was to give that flag a switch instead, and it made things worse rather
// than better: a thread holding nothing but your own comments went orange and stayed orange however
// often you read it, while something genuinely new was a different colour entirely. Two marks, two
// colours, and only one of them answering to reading.
//
// SO THE RULE IS ONE MARK. A demo page shows the reader exactly one thing — where there is something
// new — and reading it is what clears it. Nothing else on the page marks anything, which is why
// raising a flag of the demo's own is out entirely rather than out only on arrival: a second mark is
// a second vocabulary, whatever moves it.
//
// WHAT THESE CAN AND CANNOT SEE. They read the pages as text. That catches a page taking a mark back
// into its own hands, and nothing else: neither page is executed here, so a page that marks things
// some new way walks straight past. The behaviour itself is fixed where it belongs, against the real
// panel — see panel-dom.test T48/T49/T52.

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
 * A demo putting a mark on the page with its own hands. The flag API this used to catch is gone in
 * 0.9.9, so what is left to catch is the other way of keeping a second mark: writing one of the
 * library's mark classes directly. Demos style their own controls with their own classes, so this
 * looks only for `tb-`.
 */
const MOVES_A_FLAG = /classList\s*\.\s*(?:add|remove|toggle)\s*\(\s*['"]tb-[a-z-]+/g;

test('the demo pages exist and are found, so an empty sweep cannot pass for a clean one', () => {
  const pages = demoPages();
  assert.ok(pages.some((p) => p.rel === 'demo/demo.html'), 'the bundled demo is in the sweep');
  assert.ok(pages.some((p) => p.rel === 'docs/index.html'), 'the hosted demo is in the sweep');
  for (const p of pages) assert.ok(p.text.length > 1000, `${p.rel}: was actually read`);
});

test('T50: no demo page carries a mark of its own — there is one mark, and the library owns it', () => {
  // Not "does not mark ON ARRIVAL": does not mark at all. The switch that raised it by hand was the
  // second attempt at this and produced a mark that could not be read away, which is the failure
  // stated the other way round. What a page may still do is CHOOSE THE COLOUR — that is a token, and
  // tokens are the customisation this library is built on.
  const offenders = [];
  for (const { rel, text } of demoPages()) {
    for (const call of text.match(MOVES_A_FLAG) || []) offenders.push(`${rel}: ${call}`);
  }
  assert.deepEqual(offenders, [],
    `a demo is keeping a mark of its own again — one mark, and reading clears it:\n  ${offenders.join('\n  ')}`);
});

test('T51: no demo page decides "read" from a click, either', () => {
  // The half that turned a redundancy into a bug. Clearing on a click only ever reaches a reader who
  // was somewhere else; the reader watching the thread it lands in never clicks, so the mark stays up
  // in front of them. A page-wide click handler that moves a mark has rebuilt that trap.
  const offenders = [];
  for (const { rel, text } of demoPages()) {
    for (const m of text.matchAll(/addEventListener\s*\(\s*['"]click['"]/g)) {
      const code = blockAt(text, m.index);
      MOVES_A_FLAG.lastIndex = 0;
      if (MOVES_A_FLAG.test(code)) {
        offenders.push(`${rel}: a page-wide click handler moves a mark`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a demo is deciding "read" for itself again:\n  ${offenders.join('\n  ')}`);
});

// T53 and T54 have gone. They fixed that each demo page CHOSE the mark's colour and drew it as a
// fill that breathes — which the pages had to do while the library still shipped a blue ring. The
// library ships the fill now, so a page that set it would be restating the default, and a check that
// it does would fail the day someone tidied that up. What the mark looks like is fixed against the
// panel instead: panel-dom.test S3-U1..U4.

test('T50/T51: the sweep answers about real text, and is not just failing to match', () => {
  // The failure an absence check has: reading nothing, finding nothing, and reporting that as clean.
  // So the same readings are pointed at the wiring that was removed, which they must catch.
  const onArrival = `
      function answerOn(commentId, el) {
        tb.addReply(commentId, { body: 'x' });
        el.classList.add('tb-unread');
      }`;
  assert.equal((onArrival.match(MOVES_A_FLAG) || []).length, 1, 'the first attempt is caught');

  const bySwitch = `
      mkBtn('Notice: off', (b) => {
        for (const el of document.querySelectorAll('.tb-badge')) el.classList.toggle('tb-unread', on);
      });`;
  assert.equal((bySwitch.match(MOVES_A_FLAG) || []).length, 1, 'and so is the second');

  const clickClear = `document.addEventListener('click', (e) => { e.target.classList.remove('tb-unread'); }, true);`;
  assert.match(blockAt(clickClear, clickClear.indexOf("addEventListener('click'")), /classList/,
    'and the click-clear is found where it was');

  // The demos DO touch classList — for their own buttons. If the reading could not tell those apart
  // it would be failing every run, or passing by looking at nothing.
  assert.equal(`b.classList.toggle('on', altColors);`.match(MOVES_A_FLAG), null,
    'a demo styling its own control is not a second mark');

});
