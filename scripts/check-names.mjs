#!/usr/bin/env node
// The 0.9.9 renames, checked mechanically. `npm run check:names`.
//
// A rename cannot be verified by the test suite. Rename the source and the tests in the same sweep
// and the suite goes green whatever happened — it is asking whether the code agrees with itself, and
// after a find-and-replace it always does. So this asks a different question, from outside: does any
// old name still appear, and does every name that was supposed to STAY still appear?
//
// Both halves are needed. Checking only that old names are gone would be satisfied by deleting them,
// and deleting them is exactly the failure mode this rename had: three names that stay are spelled
// inside names that changed —
//
//   data-tb-anchor   contains  tb-anchor
//   --tb-mark-bg     contains  tb-mark
//   data-tb-section  contains  tb-sec
//
// — so a sweep that is too eager destroys them and a one-directional check calls that clean.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Old names. Every one of these must be gone from the shipped surfaces.
const GONE = [
  ['tb-pin', 'folded into tb-badge + tb-floating'],
  ['tb-popup', 'the small window is a Pane'],
  ['tb-existing', 'where utterances sit in time order is the Timeline'],
  ['tb-panel', 'the box of buttons is the console'],
  ['tb-lane', 'the bar along the bottom is the DocumentBar'],
  ['tb-attn', 'the flag it painted is gone'],
  ['--tb-attention', 'the flag it painted is gone'],
  ['setAnchorAttention', 'the flag is gone'],
  ['hasAttention', 'the flag is gone'],
  ['attention:change', 'the flag is gone'],
  ['docLane', 'the setting is docBar'],
  ['toggleDocumentLane', 'the method is toggleDocumentBar'],
  // These three name a class that moved. The attribute / tokens spelled inside them are checked as
  // STAYS below, so a sweep that took those with it fails there rather than passing here.
  [/(?<!data-)\btb-anchor\b/, 'the label inside a Pane is tb-pane-label'],
  [/\btb-mark(?!-)/, 'what can be commented on is tb-commentable'],
  [/\btb-open\b/, 'a bar that is open says tb-docbar-open'],
  [/(?<![-\w])tb-count\b/, 'the console owns it: tb-console-count'],
  [/\btb-hint\b/, 'the console owns it: tb-console-hint'],
  [/(['"])popup\./, 'the message keys are pane.*'],
];

// Names that had to survive the sweep. Zero of any of these means the rename went too far.
const STAYS = [
  ['data-tb-anchor', 'marks a place a comment can go — the attribute was never renamed'],
  ['data-tb-section', 'the section an anchor sits in'],
  ['--tb-mark-bg', 'still paints what can be commented on'],
  ['--tb-mark-outline', 'still outlines it'],
  ['attachPanel', 'renaming it would break every integrator'],
  ['tackback/panel', 'the npm subpath is not the console'],
  ['tb-sec', 'a secondary button, on the console AND in a Pane'],
  ['toggleMarks', 'the method kept its name; only the class moved'],
  ['surfaceId', 'the coordinate system'],
  ['tb-badge', 'one mark, one name'],
  ['tb-floating', 'the badge that floats on a picture'],
  ['tb-commentable', 'what tb-mark became'],
  ['tb-pane', 'what tb-popup became'],
  ['tb-console', 'what tb-panel became'],
  ['tb-docbar', 'what tb-lane became'],
  ['tb-timeline', 'what tb-existing became'],
  ['tb-pane-label', 'what the tb-anchor class became'],
];

// The hosted demo loads Tackback from a CDN at a pinned version, and GitHub Pages redeploys the
// moment anything lands on main — so that page and its pin have to move in the same commit. They did
// not once, and what went live was a page written in names the published bundle had never heard of.
// It is checked below, on its own terms: not which vocabulary it uses, but whether its vocabulary
// agrees with the version it fetches.
const PINNED_PAGES = ['docs/index.html'];

// What ships, plus the tests that describe it. CHANGELOG is excluded on purpose: its migration guide
// lists every old name, which is the point of it. docs/_samples holds dated records of decisions —
// they say what was true when they were written and must not be rewritten to say something else.
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /^(src|test|docs|demo)\/|^README\.md$/.test(f))
  .filter((f) => /\.(js|mjs|ts|md|html)$/.test(f))
  .filter((f) => !f.startsWith('docs/_samples/'))
    .concat(execFileSync('sh', ['-c', 'ls types/**/*.d.ts types/*.d.ts 2>/dev/null || true'], { encoding: 'utf8' })
    .split('\n').filter(Boolean));

const read = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const hits = (needle) => {
  const re = typeof needle === 'string'
    ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    : new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : needle.flags + 'g');
  const out = [];
  for (const [f, text] of read) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { out.push(`${f}:${i + 1}`); re.lastIndex = 0; }
  }
  return out;
};

const problems = [];

// A pinned page is scanned by everything above like any other file, AND asked this one extra
// question, because the two failures are different. The scan catches an old name left behind. This
// catches a page and a bundle that disagree — which no amount of scanning either one alone would.
const OLD_NAMES = /tb-pin|tb-popup|tb-lane|tb-panel|tb-existing|tb-attn|docLane|--tb-attention/;
const NEW_NAMES = /tb-floating|tb-pane|tb-docbar|tb-console|tb-timeline|tb-commentable|docBar/;
const atLeast099 = (v) => {
  const [maj, min, pat] = v.split('.').map(Number);
  return maj > 0 || min > 9 || (min === 9 && pat >= 9);
};
for (const file of PINNED_PAGES) {
  const text = readFileSync(file, 'utf8');
  const pin = (text.match(/tackback@([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
  if (!pin) continue;                                  // a local build — nothing to disagree with
  const wantsNew = atLeast099(pin);
  const speaksWrong = wantsNew ? OLD_NAMES.exec(text) : NEW_NAMES.exec(text);
  if (speaksWrong) {
    problems.push(
      `${file} loads tackback@${pin} but says "${speaksWrong[0]}", which is a ` +
      `${wantsNew ? 'name that version no longer has' : 'name that version has never heard of'}.\n` +
      `    Pages serves this pair the moment it lands on main. Move the pin and the page together.`);
  }
}

for (const [needle, why] of GONE) {
  const found = hits(needle);
  if (found.length) problems.push(`still here: ${needle}  — ${why}\n    ${found.slice(0, 6).join('\n    ')}` +
    (found.length > 6 ? `\n    …and ${found.length - 6} more` : ''));
}
for (const [needle, why] of STAYS) {
  if (!hits(needle).length) problems.push(`gone, and should not be: ${needle}  — ${why}`);
}

if (problems.length) {
  console.error(`\ncheck:names — ${problems.length} problem${problems.length === 1 ? '' : 's'} across ${read.size} files\n`);
  for (const p of problems) console.error('  ' + p + '\n');
  process.exit(1);
}
console.log(`check:names — ${GONE.length} old names gone, ${STAYS.length} kept names present, across ${read.size} files`);
