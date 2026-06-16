// @brainworker/tackback — opaque comment identity.
//
// A comment's identity is separate from its creation time (a timestamp is metadata, not a key).
// We mint a short, opaque, collision-resistant id. `crypto.randomUUID` is available in every modern
// browser and in Node ≥ 16; the fallback keeps the dependency-zero promise even in odd embeddings.

/** @returns {string} an opaque, collision-resistant comment id */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
  }
  // Last-resort (non-crypto) fallback. Only reached in environments without WebCrypto.
  return 'c-' + Array.from({ length: 24 }, () => ((Math.random() * 36) | 0).toString(36)).join('');
}
