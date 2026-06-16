// @brainworker/tackback/pdf — a MediaAdapter that renders a PDF into self-drawn page surfaces the core can
// anchor region comments against.
//
// pdf.js is a PEER dependency: the host passes its pdf.js module in `options.pdfjs` (the vendored
// build, or `pdfjs-dist`), so this package carries NO hard import and stays bundler-agnostic. Each
// page is rendered to our OWN canvas inside a positioned, viewport-sized wrapper carrying the
// `data-tb-page` / `data-tb-surface` attributes the panel's region gesture keys off — so to
// Tackback a PDF is just self-drawn DOM (like SVG/IMG). A region is stored page + normalized rect
// and re-rendered as `normalized × current page size`, so it survives zoom (re-render → invalidate).
//
// Render gotchas baked in (memory: reference_pdfjs_render_gotchas):
//  - GlobalWorkerOptions.workerSrc MUST be set or getDocument never resolves.
//  - pdf.js 4.x ships no base-14 fonts; without `standardFontDataUrl`, page.render() hangs on fonts.

import { toNormalizedAgainst, fromNormalizedToRect } from './geometry.js';
import { TackbackError } from '../core/errors.js';

const DEFAULT_PAGE_CLASS = 'tb-page';

/**
 * @param {object} options
 * @param {*} options.pdfjs                          the pdf.js module (GlobalWorkerOptions + getDocument)
 * @param {string} [options.url]                     PDF url (or pass `options.data`)
 * @param {ArrayBuffer|Uint8Array} [options.data]    raw PDF bytes (alternative to `url`)
 * @param {string} [options.workerSrc]               pdf.worker URL — required for rendering
 * @param {string} [options.standardFontDataUrl]     base-14 font dir — required or render hangs
 * @param {number} [options.scale=1.0]               initial render scale
 * @param {Element} [options.container]              where to render (default: a div appended to ctx.root)
 * @param {string} [options.pageClassName='tb-page'] class for each page wrapper
 * @returns {import('../core/media.js').MediaAdapter & {
 *   setScale(scale:number): Promise<void>|void,
 *   rerender(): Promise<void>|void,
 *   readonly pdfDocument: any,
 *   readonly scale: number,
 * }}
 */
export function createPdfAdapter(options = {}) {
  const {
    pdfjs, url, data, workerSrc, standardFontDataUrl,
    container, pageClassName = DEFAULT_PAGE_CLASS,
  } = options;
  let scale = options.scale ?? 1.0;
  let ctx = null;
  let doc = null;
  let host = null;
  let pdfDoc = null;
  let generation = 0;          // bumped by each renderAll + teardown; aborts superseded/torn-down renders
  const unregisters = [];

  function clearSurfaces() {
    for (const un of unregisters.splice(0)) { try { un(); } catch { /* ignore */ } }
    if (host) host.textContent = '';
  }

  // Render every page at the current scale, (re)registering one surface per page. Idempotent: it
  // clears prior surfaces/DOM first, so setScale() can call it on every zoom change. A generation
  // token makes it cancellation-safe: a newer render (zoom) or teardown bumps
  // `generation`, and this loop bails after each await rather than mutating DOM / registering stale
  // surfaces against a torn-down or superseded state.
  async function renderAll() {
    const myGen = ++generation;
    const live = () => myGen === generation && !!ctx && !!host;
    clearSurfaces();
    const localPdf = pdfDoc;
    try {
      for (let n = 1; n <= localPdf.numPages; n++) {
        const page = await localPdf.getPage(n);
        if (!live()) return;
        const viewport = page.getViewport({ scale });
        const wrap = doc.createElement('div');
        wrap.className = pageClassName;
        wrap.style.position = 'relative';
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        const surfaceId = `page-${n}`;
        wrap.setAttribute('data-tb-page', String(n));
        wrap.setAttribute('data-tb-surface', surfaceId);

        const canvas = doc.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = 'block';
        wrap.appendChild(canvas);
        host.appendChild(wrap);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        if (!live()) return;

        const unregister = ctx.registerSurface({
          id: surfaceId,
          type: 'pdf-page',
          element: wrap,
          pageIndex: n,
          // REQ-507: reproduction info — reuse the envelope's document.source as the PDF, render page n.
          // size/scale are informational (rect is 0..1 of the surface, so replay is scale-independent).
          descriptor: {
            id: surfaceId, kind: 'pdf-page',
            size: { width: viewport.width, height: viewport.height },
            content: { ref: { type: 'doc-source', value: null }, page: n, scale },
          },
          toNormalizedRect: (clientRect) => toNormalizedAgainst(clientRect, wrap.getBoundingClientRect()),
          fromNormalizedRect: (rect) => fromNormalizedToRect(rect, wrap.clientWidth, wrap.clientHeight),
        });
        unregisters.push(unregister);
      }
      if (live()) ctx.invalidate();
    } catch (err) {
      // A render superseded by zoom or invalidated by teardown can reject (pdf.js cancels pending
      // getPage/render when the document is destroyed). Swallow those; log only a still-live failure
      // so setScale()/rerender() never produce an unhandled rejection.
      if (live() && globalThis.console) globalThis.console.error('[tackback/pdf] render failed:', err);
    }
  }

  const adapter = {
    name: '@brainworker/tackback/pdf',
    supports: ['region'],

    async mount(context) {
      ctx = context;
      doc = context.root?.ownerDocument || globalThis.document;
      if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
        throw new TackbackError('ADAPTER_FAILED', '@brainworker/tackback/pdf requires options.pdfjs (the pdf.js module)');
      }
      if (workerSrc && pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      if (url == null && data == null) {
        throw new TackbackError('ADAPTER_FAILED', '@brainworker/tackback/pdf requires options.url or options.data');
      }

      host = container || doc.createElement('div');
      if (!container) {
        host.className = 'tb-pdf-pages';
        (context.root || doc.body).appendChild(host);
      }

      const params = { ...(standardFontDataUrl ? { standardFontDataUrl } : {}) };
      if (url != null) params.url = url; else params.data = data;
      pdfDoc = await pdfjs.getDocument(params).promise;
      await renderAll();

      return () => {
        generation++;            // invalidate any in-flight renderAll before we null out state
        clearSurfaces();
        if (!container && host && host.parentNode) host.parentNode.removeChild(host);
        try { pdfDoc?.destroy?.(); } catch { /* ignore */ }
        pdfDoc = null;
        ctx = null;
        host = null;
      };
    },

    /** Re-render at a new scale; overlays follow because normalized coords are size-relative. */
    setScale(next) {
      scale = next;
      if (pdfDoc && ctx) return renderAll();
    },
    rerender() {
      if (pdfDoc && ctx) return renderAll();
    },
    get pdfDocument() { return pdfDoc; },
    get scale() { return scale; },
  };
  return adapter;
}
