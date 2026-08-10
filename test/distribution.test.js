// node:test — REQ-506 distribution invariants (the LIBRARY part; the reasoning-os reference generators
// are not part of this package). Verifies: subpath entry points resolve + export their public symbols,
// and the dependency graph is one-way (core never imports panel/pdf). The UMD-single-file/offline check
// is covered by the build (scripts/build.mjs emits dist/tackback.umd.min.js) + demo/umd-harness.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

test('REQ-506: subpath entry points resolve and export their public API', async () => {
  const core = await import('../src/index.js');
  assert.equal(typeof core.Tackback?.mount, 'function', 'core: Tackback.mount()');
  assert.equal(typeof core.buildEnvelope, 'function', 'core: buildEnvelope()');
  assert.equal(typeof core.parseEnvelope, 'function', 'core: parseEnvelope()');
  const panel = await import('../src/panel/index.js');
  assert.equal(typeof panel.attachPanel, 'function', 'panel: attachPanel()');
  const pdf = await import('../src/pdf/index.js');
  assert.ok(Object.keys(pdf).length > 0, 'pdf subpath exports something');
});

test('every source file is text a reviewer can read', () => {
  // A thread key joins its parts with NUL, so writing one as the byte instead of the escape is an easy
  // thing to do and an invisible thing to have done: the file still runs, the tests still pass, and the
  // only symptom is that git calls the file binary and shows a reviewer nothing at all. It has happened
  // twice. This is the check that does not depend on anyone remembering.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|json|md|html|css)$/.test(entry.name)) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) offenders.push(p.slice(here.length - 4));
    }
  };
  walk(srcDir);
  walk(here);
  assert.deepEqual(offenders, [], `control bytes make these unreviewable — write \\u0000 as an escape: ${offenders.join(', ')}`);
});

test('REQ-506: the dependency graph is one-way — core/ never imports panel/ or pdf/', () => {
  const offenders = [];
  const coreDir = join(srcDir, 'core');
  for (const f of readdirSync(coreDir)) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(join(coreDir, f), 'utf8');
    for (const m of text.matchAll(/(?:import|export)[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.includes('../panel') || spec.includes('../pdf')) offenders.push(`core/${f} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `core must not import panel/pdf (one-way dep): ${offenders.join(', ')}`);
});
