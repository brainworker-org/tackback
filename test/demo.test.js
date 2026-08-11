// node:test — the demo pages, which until now nothing checked.
//
// They were the only human gate on a release and the only artefact no machine looked at, so the one
// thing that could rot there did: both pages went on expressing "unread" the way they had to before
// the library could, by raising the generic attention flag when an answer arrived and lowering it on
// a click. A reply landing in a thread that was already open produced no click, so the mark stayed up
// while it was being read — the exact failure the library now exists to remove, on the page a release
// is accepted from.
//
// The correction after that was to give attention a switch instead, and it made things worse rather
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

/** A call that moves a flag — raising or lowering, since neither belongs to a demo any more. */
const MOVES_A_FLAG = /setAnchorAttention\s*\([^)]*\)/g;

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
      if (/setAnchorAttention|tb-unread|classList\.(add|toggle)\s*\(\s*['"]tb-/.test(code)) {
        offenders.push(`${rel}: a page-wide click handler moves a mark`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a demo is deciding "read" for itself again:\n  ${offenders.join('\n  ')}`);
});

/** A page with its alternate palette removed — what the reader gets before touching anything. */
const asDefaultView = (text) => {
  const at = text.indexOf('ALT_THEME');
  return at < 0 ? text : text.replace(blockAt(text, at), '');
};
const SETS_THE_MARK = /--tb-unread['"]?\s*:/;

test('T53: every demo page chooses its one mark\'s colour for the view it opens in', () => {
  // The vocabulary is "new is orange", and the library still ships blue as this token's default until
  // that changes in its own version. So each page has to SET it — and set it where the reader will
  // actually meet it. Reading the whole file would be satisfied by the alternate palette, which is
  // behind a button nobody has pressed yet, so the alternate palette is taken out before looking.
  const missing = [];
  for (const { rel, text } of demoPages()) {
    if (!SETS_THE_MARK.test(asDefaultView(text))) missing.push(rel);
  }
  assert.deepEqual(missing, [],
    `these pages leave their opening view on the shipped default: ${missing.join(', ')}`);
});

test('T50/T51/T53: the sweep answers about real text, and is not just failing to match', () => {
  // The failure an absence check has: reading nothing, finding nothing, and reporting that as clean.
  // So the same readings are pointed at the wiring that was removed, which they must catch.
  const onArrival = `
    function answerOn(commentId) {
      tb.addReply(commentId, { body: 'x' });
      tb.setAnchorAttention(commentId, true);
    }`;
  assert.equal((onArrival.match(MOVES_A_FLAG) || []).length, 1, 'the first attempt is caught');

  const bySwitch = `
    mkBtn('Attention: off', (b) => {
      for (const c of tb.listComments()) tb.setAnchorAttention(c.id, attentionOn);
    });`;
  assert.equal((bySwitch.match(MOVES_A_FLAG) || []).length, 1, 'and so is the second');

  const clickClear = `document.addEventListener('click', (e) => { tb.setAnchorAttention(e.id, false); }, true);`;
  assert.match(blockAt(clickClear, clickClear.indexOf("addEventListener('click'")), /setAnchorAttention/,
    'and the click-clear is found where it was');

  assert.doesNotMatch('const NOTHING = { "--tb-accent": "#000" };', SETS_THE_MARK,
    'and a page that sets some other token is not mistaken for one that sets this one');

  const onlyInTheAlternate = `
    const ALT_THEME = { '--tb-accent': '#0f766e', '--tb-unread': '#b45309' };
    let altColors = false;
  `;
  assert.match(onlyInTheAlternate, SETS_THE_MARK, 'the token IS in that page, read whole…');
  assert.doesNotMatch(asDefaultView(onlyInTheAlternate), SETS_THE_MARK,
    '…and is gone once the palette nobody has opened yet is set aside, which is the point');
});
