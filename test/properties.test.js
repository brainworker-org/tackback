// The properties ledger is only worth having if it cannot quietly go stale. This checks the one
// thing a file can check about another file: that every test a row names still exists where it says.
//
// What it cannot check — and this matters more than what it can — is whether the named test still
// means what the row claims. A test can be renamed into place and gutted. That is what mutation
// testing is for; this is only the bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, 'PROPERTIES.md');

/** Rows look like: | P-1 | property | `file.test.js: test name` · `…` | layer | state | */
function rows() {
  const out = [];
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*([PM]-\d+\w*)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!m) continue;
    const held = [...m[3].matchAll(/`([^`:]+\.test\.js):\s*([^`]+)`/g)].map((x) => ({ file: x[1].trim(), name: x[2].trim() }));
    out.push({ id: m[1].trim(), property: m[2].trim(), held, state: m[5].trim() });
  }
  return out;
}

test('properties ledger: every row is well formed', () => {
  const all = rows();
  assert.ok(all.length >= 12, `the ledger has rows (found ${all.length})`);
  const ids = new Set();
  for (const r of all) {
    assert.ok(!ids.has(r.id), `${r.id} appears once`); ids.add(r.id);
    assert.ok(r.property.length > 10, `${r.id} says what the property is`);
  }
});

test('properties ledger: every test a row names exists in the file it names', () => {
  for (const r of rows()) {
    if (r.state !== 'held') continue;
    assert.ok(r.held.length > 0, `${r.id} is marked held, so it must name a test`);
    for (const h of r.held) {
      const path = join(HERE, h.file);
      assert.ok(existsSync(path), `${r.id}: ${h.file} exists`);
      const src = readFileSync(path, 'utf8');
      // Test names contain apostrophes, which are escaped in the source. Compare on the text.
      const found = src.includes(h.name) || src.includes(h.name.replace(/'/g, "\\'"));
      assert.ok(found, `${r.id}: ${h.file} still has a test called "${h.name}"`);
    }
  }
});

test('properties ledger: a row that holds nothing says so out loud', () => {
  for (const r of rows()) {
    if (r.held.length === 0) {
      assert.notEqual(r.state, 'held', `${r.id} claims to be held but names no test`);
    }
  }
});
