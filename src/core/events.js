// @brainworker/tackback — tiny typed event emitter.
//
// `on(event, handler)` returns an unsubscribe function (the idiomatic shape — no need to keep a
// reference for `off`). Handlers are isolated: a throwing handler is reported but never breaks the
// emit loop or other subscribers.

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void}
   */
  on(event, handler) {
    let set = this._handlers.get(event);
    if (!set) this._handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Remove a previously registered handler (kept for familiarity; `on`'s return value is preferred).
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all subscribers. A throwing handler is isolated (reported, loop continues).
   * @param {string} event
   * @param {unknown} [payload]
   */
  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // Never let one subscriber break delivery to the others.
        // eslint-disable-next-line no-console
        console.error(`[tackback] "${event}" handler threw:`, err);
      }
    }
  }

  /** Drop all subscribers (used on destroy). */
  clear() {
    this._handlers.clear();
  }
}
