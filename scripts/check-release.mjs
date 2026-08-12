#!/usr/bin/env node
// What has to be true before a tag is cut. `npm run check:release`.
//
// Each of these is something that was got wrong once, by hand, on a release that looked finished:
//
//   0.9.7  shipped with the version written in some places and not others
//   0.9.9  was tagged twice — once before a change was found, once before that change reached the
//          release notes, which is the only place a reader would learn about it
//
// The last one is the reason for the freshness check below, and it is the least obvious of these:
// nothing else in the repository notices when the code moves and the notes do not follow.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const problems = [];
const fail = (what, detail) => problems.push(`${what}\n    ${detail.split('\n').join('\n    ')}`);

// ---- 1. the version, everywhere it is written -------------------------------------------------
//
// Not "is it right" — there is nothing to be right against. Only: does every copy say the same thing.

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

const stated = [
  ['package.json', version],
  ['package-lock.json (root)', lock.version],
  ['package-lock.json (this package)', lock.packages?.['']?.version],
  ['src/core/engine.js LIB_VERSION', (readFileSync('src/core/engine.js', 'utf8')
    .match(/LIB_VERSION\s*=\s*'([^']+)'/) || [])[1]],
  ['README.md', (readFileSync('README.md', 'utf8').match(/Version ([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1]],
];

const disagree = stated.filter(([, v]) => v !== version);
if (disagree.length) {
  fail(`the version is not written the same way everywhere (package.json says ${version})`,
    stated.map(([where, v]) => `${v === version ? '  ' : '✗ '}${where}: ${v ?? '(not found)'}`).join('\n'));
}

// ---- 2. this version has a section in the CHANGELOG --------------------------------------------

const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## [${version}]`)) {
  fail(`CHANGELOG.md has no section for ${version}`,
    `Looked for "## [${version}]". A version nobody wrote down is a version nobody can upgrade to\n` +
    `on purpose. Found: ${(changelog.match(/^## \[[^\]]+\]/gm) || []).slice(0, 3).join(', ') || 'none'}`);
}

// ---- 3. the notes are at least as new as the code ----------------------------------------------
//
// An approximation, and deliberately a crude one: it cannot tell whether a change was worth writing
// down, only whether anything was written down after it. That is enough to catch the failure it
// exists for — code lands, the release notes are not touched again, and the tag goes out. It cannot
// catch notes that were updated but say the wrong thing, and it says so rather than implying it did.
//
// `types/` is generated and not tracked, so in practice this watches `src/`. It asks for both anyway,
// so the check does not quietly narrow if that ever changes.

const newestTouching = (paths) => {
  const out = git('log', '-1', '--format=%H', '--', ...paths);
  return out || null;
};
const codeCommit = newestTouching(['src', 'types']);
const notesCommit = newestTouching(['CHANGELOG.md']);

if (!codeCommit) {
  fail('no commit in this history touches src/ or types/', 'That is not a repository this check understands.');
} else if (!notesCommit) {
  fail('CHANGELOG.md has never been committed', 'There is nothing for a reader to upgrade against.');
} else {
  // A commit is its own ancestor, so a change and its notes landing together passes.
  let notesAreCurrent = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', codeCommit, notesCommit], { stdio: 'ignore' });
  } catch { notesAreCurrent = false; }
  if (!notesAreCurrent) {
    const show = (h) => git('log', '-1', '--format=%h %ad  %s', '--date=short', h);
    fail('the code moved after the release notes last did',
      `last change to src/ or types/:  ${show(codeCommit)}\n` +
      `last change to CHANGELOG.md:    ${show(notesCommit)}\n\n` +
      `Every commit in between is a change no reader has been told about. If none of them is\n` +
      `visible to a user, say so in the CHANGELOG anyway — an empty note is a decision, silence\n` +
      `is an oversight. This cannot tell the two apart, which is exactly why it asks.`);
  }
}

// ---- 4. the names check, which has its own opinions --------------------------------------------

try {
  execFileSync('node', ['scripts/check-names.mjs'], { stdio: 'pipe' });
} catch (err) {
  fail('check:names is not clean', (err.stdout?.toString() || err.stderr?.toString() || String(err)).trim());
}

// ---- report ------------------------------------------------------------------------------------

if (problems.length) {
  console.error(`\ncheck:release — ${problems.length} problem${problems.length === 1 ? '' : 's'}, ` +
                `so this is not ready to tag\n`);
  for (const p of problems) console.error('  ' + p + '\n');
  process.exit(1);
}
console.log(`check:release — ${version} is written the same in ${stated.length} places, ` +
            `has a CHANGELOG section, and the notes are no older than the code`);
