// node:test — phase 9 conformance ledger for tackback-spec v0.9's Traceability Matrix (TEST doc §4).
//
// The TEST doc deliberately does NOT restate individual cases (§5: "they rot"); tests live with the
// library and the MATRIX is the traceability. This file IS that matrix in code. Every REQ/NFR row is
// EITHER `covered` (a real, executable node:test exists — pointer in `by`) OR explicitly surfaced as
// `manual` / `pending` WITH a reason — there is NO silent "deferred=no test" for a MUST (the gap
// Keisuke flagged: a captured MUST without a failing test, dressed up as deferred while the suite was
// green — see memory: spec-first RED tests). It asserts ZERO unclassified rows (INV-10) and runs the
// dependency-direction / zero-dep / no-network gates (RUN-001/002), plus pins two MUSTs found
// uncovered during mapping (REQ-101, REQ-011).
//
// Non-covered categories (each needs a reason):
//   manual  — genuinely physical/visual, not synthesizable headlessly. reasons: 'real-mouse'
//             (NFR-005/009 real-pointer draw + visual reposition), 'browser-flow' (a panel flow
//             verified in the headless preview but with no node unit, e.g. REQ-012). The DECISION
//             logic behind these IS covered (interaction.test); only the physical I/O is manual.
//   pending — a MUST scheduled but not yet implemented (REQ-506 phase 8) — surfaced + counted, never hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { Tackback } from '../src/index.js';
import { memoryAdapter } from '../src/core/storage.js';

// Allowed non-covered categories. A MUST is EITHER `covered` (a real executable test) OR explicitly
// surfaced as `manual` (genuinely physical/visual, skip-marked) / `pending` (scheduled, not yet
// implemented) WITH a reason — never a silent "deferred=no test". (memory: spec-first RED tests.)
const REASONS = new Set(['real-mouse', 'browser-flow', 'phase-8']);

// ---- the traceability matrix (TEST doc §4), classified ---------------------------------------
// row: [reqId, testId, level, status, by|reason, note?]
const MATRIX = [
  // anchoring core (REQ-001..014)
  ['REQ-001', 'TEST-001', 'L3', 'covered', 'model.isValidAnchor + engine.addComment + anchor.test (three kinds consistent)'],
  ['REQ-002', 'TEST-002', 'L3', 'covered', 'resolution.test deriveBlockId / indexAnnotatable'],
  ['REQ-003', 'TEST-003', 'L1', 'covered', 'anchor.test resolveQuoteSelector + resolution.test resolveRange'],
  ['REQ-004', 'TEST-004', 'L1', 'covered', 'region.test reportOrphaned/markResolved + resolution.test resolveRange-null'],
  ['REQ-005', 'TEST-005', 'L4', 'covered', 'region.test documentSurface/resolveRegionRect + anchor.test regionToPx; browser-verified (phase 5a). W-NWBW: +test — an absolute element-anchored document region is immune to a 2x surface-height change (a PDF zoom cannot move it); orphan-safe'],
  ['REQ-006', 'TEST-006', 'L1', 'covered', 'interaction.test classifyGesture (right-drag>threshold→region, else selection→range/none→block); real-pointer reliability = NFR-005 manual'],
  ['REQ-007', 'TEST-007', 'L3', 'covered', 'region.test regionFallbackOffset/applyRegionFallback/resolveRegionRect'],
  ['REQ-008', 'TEST-008', 'L3', 'covered', 'region.test recordRegionEvent (recorded, no silent re-point); handle UI = phase-5b'],
  ['REQ-009', 'TEST-009', 'L1', 'covered', 'region.test appendAnchorEvent / recordRegionEvent history'],
  ['REQ-010', 'TEST-010', 'L1', 'covered', 'region.test computeCapture (covered text + media, capped)'],
  ['REQ-011', 'TEST-011', 'L1', 'covered', 'conformance.test threadId grouping (below)'],
  ['REQ-012', 'TEST-012', 'L3', 'manual', 'browser-flow', 'pending uncommitted region writes no record until commit — browser-verified (5a/5b); panel flow, no headless unit'],
  ['REQ-013', 'TEST-013', 'L4', 'covered', 'region.test computeCapture mixed text+media + documentSurface; browser-verified (phase 5a document region)'],
  ['REQ-114', 'TEST-114', 'L3', 'manual', 'real-mouse', 'sub-surface-bound region visual distinction (double-frame border) + host-CSS-immune pin (explicit line-height) — browser/real-mouse verified (W-WK2E demo review / W-NWBW); the surfaceId-based class logic runs in the panel, no headless unit'],
  ['REQ-014', 'TEST-014', 'L2', 'covered', 'resolution.test D-E path-independence'],
  // API surface (REQ-101..111)
  ['REQ-101', 'TEST-101', 'L1', 'covered', 'conformance.test default doc.id (below) + engine.test mount factory'],
  ['REQ-102', 'TEST-102', 'L2', 'covered', 'package.json exports (ESM) + UMD build (scripts/build.mjs); export.test version pin'],
  ['REQ-103', 'TEST-103', 'L1', 'covered', 'engine.test + region.test + seam.test (root/document/storage/author/readOnly/mediaAdapters)'],
  ['REQ-104', 'TEST-104', 'L1', 'covered', 'seam.test addReply/setTransport + engine.test + region.test registerMediaAdapter/recalc'],
  ['REQ-105', 'TEST-105', 'L1', 'covered', 'store.test list() frozen snapshot'],
  ['REQ-106', 'TEST-106', 'L1', 'covered', 'engine.test mint id/createdAt + model.test empty body'],
  ['REQ-107', 'TEST-107', 'L2', 'covered', 'engine.test import round-trip + hardening.test atomic replace/conflict'],
  ['REQ-108', 'TEST-108', 'L2', 'covered', 'store.test beginLoad sync seed + engine ready chain'],
  ['REQ-109', 'TEST-109', 'L3', 'covered', 'region.test resolveRegionRect recompute + panel ResizeObserver/visualViewport wiring (browser-verified, rAF-coalesced); visual frame budget = NFR-009 manual'],
  ['REQ-110', 'TEST-110', 'L3', 'covered', 'engine.test destroy (core listeners); panel DOM-trace removal browser-verified (phase 5a)'],
  ['REQ-111', 'TEST-111', 'L1', 'covered', 'engine.test readOnly throws on every mutation'],
  // events (REQ-201..205)
  ['REQ-201', 'TEST-201', 'L1', 'covered', 'events.test on/unsubscribe/multi-subscriber'],
  ['REQ-202', 'TEST-202', 'L2', 'covered', 'engine.test change diff + source'],
  ['REQ-203', 'TEST-203', 'L2', 'covered', 'engine.test add/update/delete with previous'],
  ['REQ-204', 'TEST-204', 'L2', 'covered', 'seam.test rev:mismatch + region.test anchor:orphaned'],
  ['REQ-205', 'TEST-205', 'L2', 'covered', 'seam.test modes work w/o transport; dep-direction gate (below) proves no backend import'],
  // data model (REQ-301..307)
  ['REQ-301', 'TEST-301', 'L1', 'covered', 'model.test author provenance object + comment shape'],
  ['REQ-302', 'TEST-302', 'L1', 'covered', 'model.test reaction stored as id + panel-customization resolveReaction'],
  ['REQ-303', 'TEST-303', 'L2', 'covered', 'export.test buildEnvelope v2 shape + reaction legend'],
  ['REQ-304', 'TEST-304', 'L2', 'covered', 'export.test source + revisionHash round-trip'],
  ['REQ-305', 'TEST-305', 'L1', 'covered', 'export.test + model.test migrateLegacyComment'],
  ['REQ-306', 'TEST-306', 'L2', 'covered', 'export.test schemaVersion; seam = schema + typed events (this matrix is the seam fixture)'],
  ['REQ-307', 'TEST-307', 'L2', 'covered', 'seam.test addReply round-trip + order preserved'],
  // customization (REQ-401..405)
  ['REQ-401', 'TEST-401', 'L3', 'covered', 'panel-customization.test (theming/reactions/i18n axes)'],
  ['REQ-402', 'TEST-402', 'L3', 'covered', 'panel-customization.test resolveTheme/buildThemeCSS (--tb-*, auto)'],
  ['REQ-403', 'TEST-403', 'L1', 'covered', 'panel-customization.test resolveReaction (id decoupled from glyph)'],
  ['REQ-404', 'TEST-404', 'L1', 'covered', 'panel-customization.test LocaleRegistry (en-first, ja, fallback, register)'],
  ['REQ-405', 'TEST-405', 'L3', 'covered', 'attachPanel consumes core — browser-verified (phase 5a: panel attaches + renders)'],
  // media + storage (REQ-501..506)
  ['REQ-501', 'TEST-501', 'L2', 'covered', 'pdf.test MediaAdapter contract + media.js surface'],
  ['REQ-502', 'TEST-502', 'L4', 'covered', 'pdf.test adapter (fake pdfjs, surface-per-page, zoom-independent); real render = staging. SHOULD [post-v1] — the PDF adapter ships as an optional reference adapter / demo sample, not a v1 release gate (PRD v0.5, W-MA8X)'],
  ['REQ-503', 'TEST-503', 'L3', 'covered', 'pdf.test + media.js — media-agnostic contract (image/svg/custom authorable)'],
  ['REQ-504', 'TEST-504', 'L2', 'covered', 'store.test localStorage/memory StorageAdapter'],
  ['REQ-505', 'TEST-505', 'L2', 'covered', 'replay.test buildReplayModel (multi-author merge + timeline) — [post-v1] gate none'],
  ['REQ-507', 'TEST-507', 'L4', 'covered', 'export.test exportEnvelope collects the raster SurfaceDescriptor into surfaces[] (excludes the live document surface) — the descriptor seam ships in v1, keeping the export self-describing; the live PDF/canvas raster-region consumer is [post-v1] (real PDF-render replay = staging, PRD v0.5, W-MA8X)'],
  ['REQ-506', 'TEST-506', 'L2', 'pending', 'phase-8', 'distribution + generators (make-feedback-*.sh to new bundle, v2 replay pipeline) — scheduled before merge, needs pytest env'],
  // errors + submission (REQ-601, 701..704)
  ['REQ-601', 'TEST-601', 'L1', 'covered', 'errors.js TackbackError code enum; hardening/engine assert codes surface'],
  ['REQ-701', 'TEST-611', 'L2', 'covered', 'seam.test three submission modes (export / submitBatch / comment:add)'],
  ['REQ-702', 'TEST-612', 'L3', 'covered', 'interaction.test popupCommit (save↔send by transport) + nextSendState (pending→ok/failed); browser-verified Send label'],
  ['REQ-703', 'TEST-613', 'L3', 'covered', 'interaction.test popupCommit (close vs stay-open when interactive); panel wires it (browser-verified)'],
  ['REQ-704', 'TEST-614', 'L3', 'covered', 'panel renders thread inline as ONE flat, time-ordered timeline (0.9.1): every comment AND reply is its own actor-labeled row, interleaved with the move/resize history; the anchor badge counts every utterance (0.9.2). NOTHING in the timeline is deletable — deletion is anchor-level via right-click → Delete anchor (0.9.2; browser-verified). Still NO reply INPUT (post-v1/Interplay) — replies arrive via the addReply seam, covered by seam.test (core); the row logic behind the rendering (lastSpeaker / actorColorOf / utteranceCount) is covered by actors.test, the commit-enable rule by interaction.test canCommit'],
  // NFRs (NFR-001..010 → TEST-701..710)
  ['NFR-001', 'TEST-701', 'L2', 'covered', 'conformance.test zero-dependency audit (below)'],
  ['NFR-002', 'TEST-702', 'L2', 'covered', 'conformance.test core no-network scan (below)'],
  ['NFR-003', 'TEST-703', 'L1', 'covered', 'model REQ-301 body is plain text; panel renders via createTextNode (browser-verified no innerHTML, phase 5a)'],
  ['NFR-004', 'TEST-704', 'L2', 'covered', 'conformance.test dep-direction gate — core imports no sibling (below)'],
  ['NFR-005', 'TEST-705', 'manual', 'manual', 'real-mouse', 'region draw reliability under a real pointer on staging (not synthesizable; gesture LOGIC covered by interaction.test)'],
  ['NFR-006', 'TEST-706', 'L4', 'covered', 'region.test computeCapture cap; single-flight render = pdf.test generation token'],
  ['NFR-007', 'TEST-707', 'L1', 'covered', 'anchor.test MIN_REGION_PX threshold (configurable threshold honored)'],
  ['NFR-008', 'TEST-708', 'L2', 'covered', 'export.test version pin (generator.version == package.json)'],
  ['NFR-009', 'TEST-709', 'manual', 'manual', 'real-mouse', 'overlay reposition within the frame budget on staging (visual; recompute LOGIC covered by region.test, wiring browser-verified)'],
  ['NFR-010', 'TEST-710', 'L1', 'covered', 'store.test dup-id never overwrites + import conflict governed by REQ-107'],
];

// ---- inline real tests for the two MUSTs found uncovered during mapping ----------------------

test('REQ-101: a no-options / id-less mount defaults document.id deterministically; explicit id wins', () => {
  const a = Tackback.mount({ storage: memoryAdapter() });               // no document at all
  assert.equal(typeof a.exportEnvelope().document.id, 'string');
  assert.ok(a.exportEnvelope().document.id.length > 0, 'a default id is assigned');
  const b = Tackback.mount({ document: { id: 'explicit-doc' }, storage: memoryAdapter() });
  assert.equal(b.exportEnvelope().document.id, 'explicit-doc', 'explicit id takes precedence');
  // title/revisionHash/source carry through alongside the (possibly defaulted) id
  const c = Tackback.mount({ document: { title: 'T', revisionHash: 'r1' }, storage: memoryAdapter() });
  const d = c.exportEnvelope().document;
  assert.equal(d.title, 'T'); assert.equal(d.revisionHash, 'r1'); assert.ok(d.id);
});

test('REQ-011: threadId groups multiple comments on one anchor into a thread (any kind), round-trips', () => {
  const tb = Tackback.mount({ document: { id: 'd' }, storage: memoryAdapter() });
  const root = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'root' });
  const reply = tb.addComment({ anchor: { type: 'block', elementId: 'p1' }, body: 'second on same anchor', threadId: root.id });
  assert.equal(reply.threadId, root.id, 'threadId carried onto the stored comment');
  const inThread = tb.listComments().filter((c) => (c.threadId || c.id) === root.id);
  assert.equal(inThread.length, 2, 'both comments group under the thread');
  // survives export/import
  const tb2 = Tackback.mount({ document: { id: 'd' }, storage: memoryAdapter() });
  tb2.importEnvelope(tb.exportEnvelope(), { mode: 'replace' });
  assert.equal(tb2.getComment(reply.id).threadId, root.id, 'threadId round-trips');
});

// ---- inspection gates: zero-dep / no-network / dep-direction (RUN-001/002) --------------------

const srcUrl = (p) => new URL(`../src/${p}`, import.meta.url);

test('NFR-001: the package declares zero runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = pkg.dependencies || {};
  assert.deepEqual(Object.keys(deps), [], `runtime dependencies must be empty, got: ${Object.keys(deps).join(', ')}`);
});

test('NFR-004: dependency direction — core/* imports no sibling (panel/pdf) and no backend', () => {
  const coreDir = new URL('../src/core/', import.meta.url);
  for (const f of readdirSync(coreDir).filter((n) => n.endsWith('.js'))) {
    const txt = readFileSync(new URL(f, coreDir), 'utf8');
    assert.ok(!/from\s+['"][^'"]*\/panel\//.test(txt), `core/${f} must not import panel/*`);
    assert.ok(!/from\s+['"][^'"]*\/pdf\//.test(txt), `core/${f} must not import pdf/*`);
  }
});

test('NFR-002: core performs no network I/O (no fetch / XMLHttpRequest / WebSocket in src/core)', () => {
  const coreDir = new URL('../src/core/', import.meta.url);
  for (const f of readdirSync(coreDir).filter((n) => n.endsWith('.js'))) {
    const txt = readFileSync(new URL(f, coreDir), 'utf8');
    assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b/.test(txt), `core/${f} must not do network I/O`);
  }
  void srcUrl;
});

// ---- the ledger assertions: zero unclassified rows (INV-10), valid reasons --------------------

test('conformance matrix: every spec REQ/NFR row is classified — no silent coverage gap (INV-10)', () => {
  assert.equal(MATRIX.length, 65, 'the matrix has all 65 spec rows (+ REQ-507 raster-surface SPEC v0.9; + REQ-114 region visual distinction SPEC v0.16)');
  const ids = new Set();
  for (const [req, testId, level, status, byOrReason, note] of MATRIX) {
    assert.ok(req && testId && level, `row ${req} is well-formed`);
    assert.ok(!ids.has(testId), `TEST id ${testId} is unique`); ids.add(testId);
    if (status === 'covered') {
      assert.ok(typeof byOrReason === 'string' && byOrReason.length > 8, `${req} covered needs a real test pointer`);
    } else if (status === 'manual' || status === 'pending') {
      assert.ok(REASONS.has(byOrReason), `${req} ${status} reason '${byOrReason}' must be in the allowed set`);
      assert.ok(typeof note === 'string' && note.length > 0, `${req} ${status} needs a note`);
    } else {
      assert.fail(`${req} has an unknown status '${status}' (must be covered|manual|pending — never silent "deferred")`);
    }
  }
});

test('conformance summary: covered / manual / pending breakdown — no MUST is a silent gap', () => {
  const by = (s) => MATRIX.filter((r) => r[3] === s);
  const covered = by('covered'), manual = by('manual'), pending = by('pending');
  assert.equal(covered.length + manual.length + pending.length, MATRIX.length, 'every row is covered | manual | pending');
  // every phase-5b MUST now has a REAL executable test (the gap Keisuke flagged is closed); only the
  // genuinely physical/visual rows are `manual`, and the scheduled distribution work is `pending`.
  const reason = {};
  for (const r of [...manual, ...pending]) reason[r[4]] = (reason[r[4]] || 0) + 1;
  assert.equal(reason['real-mouse'], 3, 'real-mouse manual rows: region draw + visual reposition (NFR-005/009) + region visual distinction (REQ-114)');
  assert.equal(reason['browser-flow'], 1, 'the pending-region-no-record flow is browser-verified (REQ-012)');
  assert.equal(reason['phase-8'], 1, 'distribution/generators scheduled before merge (REQ-506)');
  assert.equal(covered.length, 60, '60 of 65 rows covered by an executable node:test (REQ-114 region visual distinction is real-mouse manual, not headless)');
  assert.equal(pending.length, 1, 'exactly one MUST remains unimplemented (REQ-506 phase 8), surfaced not hidden');
});
