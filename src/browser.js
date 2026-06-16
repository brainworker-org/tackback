// Batteries-included entry point for the UMD drop-in (shipped inside @brainworker/tackback as
// dist/tackback.umd*.js — there is no separate browser package).
//
// Aggregates the public surface of @brainworker/tackback + @brainworker/tackback/panel + @brainworker/tackback/pdf into one global
// (`window.Tackback`) so a plain <script> tag is all a page needs. The library imports NO external
// packages (pdf.js is injected into createPdfAdapter at call time), so the bundle is self-contained
// and keeps the runtime zero-dependency guarantee — esbuild is dev-only.
//
//   <script src="tackback.umd.js"></script>
//   const tb = Tackback.mount({ document: { id: 'doc' } });
//   Tackback.attachPanel(tb);
//   // PDF: Tackback.createPdfAdapter({ pdfjs, url, workerSrc, standardFontDataUrl })

import { Tackback, TackbackError } from './index.js';
import {
  normalizeRegion, regionToPx, buildQuoteSelector, resolveQuoteSelector, MIN_REGION_PX,
} from './core/anchor.js';
import { localStorageAdapter, memoryAdapter } from './core/storage.js';
import { buildEnvelope, parseEnvelope } from './core/export.js';
import { createComment, migrateLegacyComment, isValidAnchor } from './core/model.js';
import { attachPanel } from './panel/index.js';
import { DEFAULT_REACTIONS } from './panel/reactions.js';
import { EN, JA } from './panel/i18n.js';
import { createPdfAdapter } from './pdf/index.js';

// Flat convenience aliases so the global reads naturally: Tackback.mount / .attachPanel / …
export const mount = Tackback.mount.bind(Tackback);
export const version = Tackback.version;

export {
  Tackback, TackbackError,
  attachPanel, createPdfAdapter,
  // anchor algebra + adapters for custom integrations
  normalizeRegion, regionToPx, buildQuoteSelector, resolveQuoteSelector, MIN_REGION_PX,
  localStorageAdapter, memoryAdapter,
  buildEnvelope, parseEnvelope,
  createComment, migrateLegacyComment, isValidAnchor,
  DEFAULT_REACTIONS, EN, JA,
};
