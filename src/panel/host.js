// @brainworker/tackback/panel — the thing a thread is shown in.
//
// There are two of them on a page: the Pane that opens where you clicked, and the bar along the
// bottom that carries the document thread. They look nothing alike and they live for different
// lengths of time, but they are the same kind of thing — a place a conversation is put — and until
// now that was expressed twice, in two code paths, which meant every question about them had to be
// asked twice too.
//
// The one that matters is "can the reader see this thread right now". A Pane answers it by existing;
// the bottom bar answers it by being expanded. Written as two questions, the two answers drift. So
// there is one question here, and the difference between the two is a single configuration: whether
// the thread area can be folded away at all. A Pane does not lack a thread area — it keeps its open.
//
// Deliberately not configuration: how long the thing lives, where it is placed, and whether it shows
// its own count. Those are facts about the caller, not behaviour of this factory, and a setting that
// changes nothing here would only invite two readers to disagree about what it was supposed to do.

/**
 * @typedef {object} ThreadHost
 * @property {{collapsible: boolean}} config
 * @property {(conv: object, rootEl: object) => void} attach
 * @property {() => boolean} timelineOpen
 * @property {() => string|null} identity
 * @property {() => object|null} anchorOf
 * @property {(a?: object) => object|null} anchorMemo
 * @property {(force?: boolean) => boolean} setOpen
 * @property {() => object|null} dispose
 * @property {boolean} alive
 */

/**
 * @param {{collapsible: boolean}} config `collapsible`: the thread area can be folded away.
 * @param {() => void} onVisibilityChange called whenever what the reader can see may have changed.
 * @returns {ThreadHost}
 */
export function createHost(config, onVisibilityChange) {
  let conv = null;      // the conversation handle this host is showing
  let rootEl = null;    // the host's own DOM root
  let alive = true;
  const changed = typeof onVisibilityChange === 'function' ? onVisibilityChange : () => {};
  return {
    config,
    /** Bind a conversation and a root. A Pane does this when it opens; the bar does it once. */
    attach(c, el) { conv = c; rootEl = el; },
    /**
     * Whether the reader can see this thread. The whole point of the generalisation: a host that
     * cannot fold is open for as long as it exists, so "is it open" is one question everywhere.
     */
    timelineOpen() {
      if (!alive || !conv) return false;
      return config.collapsible ? !!rootEl?.classList.contains('tb-docbar-open') : true;
    },
    identity() { return conv ? conv.identity() : null; },
    anchorOf() { return conv ? conv.anchorOf() : null; },
    anchorMemo(a) { return conv ? conv.anchorMemo(a) : null; },
    /** Fold or unfold. A host that cannot fold has nothing to do here and says so by staying put. */
    setOpen(force) {
      if (!alive || !config.collapsible || !rootEl) return this.timelineOpen();
      const open = force === undefined ? !rootEl.classList.contains('tb-docbar-open') : !!force;
      rootEl.classList.toggle('tb-docbar-open', open);
      changed();
      return open;
    },
    /**
     * End this host. Returns the root so the caller can take it off the page — the DOM was never
     * this factory's to own, and handing it back is what lets releasing run through one path.
     */
    dispose() {
      if (!alive) return null;
      alive = false;
      conv?.dispose();
      conv = null;
      changed();
      const el = rootEl;
      rootEl = null;
      return el;
    },
    get alive() { return alive; },
  };
}
