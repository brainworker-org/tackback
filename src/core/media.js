// @brainworker/tackback — media adapter contract (types only; pdf/image adapters implement it).
//
// A MediaAdapter renders a medium (PDF, image, …) into the page and registers "annotation surfaces"
// the core can anchor region comments against. The surface owns its own coordinate transform
// (clientRect ⇄ normalized 0..1), so the core stays geometry-agnostic and zoom-independent.

/**
 * @typedef {import('./model.js').NormalizedRect} NormalizedRect
 *
 * @typedef {Object} AnnotationSurface
 * @property {string} id                                  // surfaceId a region anchor points at
 * @property {'pdf-page'|'image'|'custom'} type
 * @property {Element} element
 * @property {number} [pageIndex]
 * @property {SurfaceDescriptor} [descriptor]              // REQ-507: reproduction info for export/replay (raster surfaces)
 * @property {(clientRect: DOMRect) => NormalizedRect} toNormalizedRect
 * @property {(rect: NormalizedRect) => DOMRect} fromNormalizedRect
 *
 * @typedef {Object} SurfaceDescriptor                     // REQ-507 — how to reproduce a raster surface's pixels
 * @property {string} id                                   // matches the AnnotationSurface / anchor.surfaceId
 * @property {'document'|'pdf-page'|'canvas'|'image'} kind
 * @property {{ width:number, height:number }} size        // normalization basis (surface px at capture)
 * @property {{ ref:{type:'doc-source'|'url'|'blob-hash'|'data', value:any}, page?:number, scale?:number, rotation?:number, crop?:object }} [content]  // raster only
 *
 * @typedef {Object} MediaAdapterContext
 * @property {Element} root
 * @property {(surface: AnnotationSurface) => (() => void)} registerSurface   // returns an unregister fn
 * @property {() => void} invalidate                                          // call after (re)render
 * @property {(event: string, cb: Function) => (() => void)} on
 *
 * @typedef {Object} MediaAdapter
 * @property {string} name
 * @property {Array<'block'|'range'|'region'>} [supports]
 * @property {(ctx: MediaAdapterContext) => void | (() => void) | Promise<void | (() => void)>} mount
 */

/** The default HTML surface id — a region with no PDF page normalizes to the document (REQ-005). */
export const DOCUMENT_SURFACE_ID = 'document';

/**
 * Build the default HTML AnnotationSurface: the document itself, a page-sized coordinate container
 * whose normalized 0..1 space is its own content box (REQ-005, DES-003). Region anchors with
 * `surfaceId:'document'` resolve against this. The transform is zoom/scroll independent — normalized
 * = client offset ÷ current size — so the overlay tracks resize without restamping the rect.
 * @param {Element} element   the document content root (e.g. the [data-tb-root] element)
 * @returns {import('./media.js').AnnotationSurface}
 */
export function documentSurface(element) {
  return {
    id: DOCUMENT_SURFACE_ID,
    type: 'custom',
    element,
    toNormalizedRect(clientRect) {
      const s = element.getBoundingClientRect();
      const W = s.width || 1, H = s.height || 1;
      return { x: (clientRect.left - s.left) / W, y: (clientRect.top - s.top) / H, width: clientRect.width / W, height: clientRect.height / H };
    },
    fromNormalizedRect(rect) {
      const W = element.clientWidth, H = element.clientHeight;
      return { left: rect.x * W, top: rect.y * H, width: rect.width * W, height: rect.height * H };
    },
  };
}
