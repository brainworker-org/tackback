// Build the batteries-included bundles from src/browser.js.
//
// The library imports zero external packages, so there's nothing to mark external and the bundle is
// fully self-contained (pdf.js is injected at call time, never imported). esbuild is a DEV-only tool
// — it does not touch the runtime zero-dependency guarantee. Outputs (gitignored) land in dist/:
//   tackback.umd.js      IIFE, global `Tackback`, readable (showcase drop-in)
//   tackback.umd.min.js  same, minified (production drop-in)
//   tackback.esm.js      ESM bundle (bundler-less <script type=module> import)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'src/browser.js');
const out = (f) => resolve(root, 'dist', f);

const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
// Keep this in step with LICENSE / package.json "license": the banner is the license statement that
// travels with the bundle, so a stale name here misstates the terms to every drop-in consumer.
const banner = { js: `/*! Tackback v${version} — anchored comments. PolyForm Shield 1.0.0 — free for any use including commercial, except to compete with Tackback. See LICENSE. */` };

const common = { entryPoints: [entry], bundle: true, banner, logLevel: 'info', target: ['es2020'] };

await Promise.all([
  build({ ...common, format: 'iife', globalName: 'Tackback', outfile: out('tackback.umd.js') }),
  build({ ...common, format: 'iife', globalName: 'Tackback', minify: true, outfile: out('tackback.umd.min.js') }),
  build({ ...common, format: 'esm', outfile: out('tackback.esm.js') }),
]);

const kb = (f) => (statSync(out(f)).size / 1024).toFixed(1) + ' KB';
console.log(`\nbuilt v${version}:`);
for (const f of ['tackback.umd.js', 'tackback.umd.min.js', 'tackback.esm.js']) console.log(`  dist/${f}  ${kb(f)}`);
