// @brainworker/tackback/panel — thread logic (DOM-free): what counts as one conversation, what it
// contains, and how a conversation already on screen takes in what arrives while it is open.
//
// Kept pure for the same reason as interaction.js: these are the decisions that go wrong quietly —
// a row drawn into the wrong thread, a row silently not drawn at all — so they get real tests
// instead of a "verified in the browser" note.

/**
 * @typedef {import('../core/model.js').Comment} Comment
 * @typedef {{ key: string, t: string, kind: 'comment'|'reply'|'event', c?: Comment, rep?: object, evt?: object }} TimelineItem
 */

// The identity of one conversation now lives in the core, which derives unread state from it. This
// re-export keeps the panel's own import path — and, more to the point, keeps there being exactly one
// answer to "is this the same thread": a second copy here would drift, and the first symptom would be
// a mark that will not clear because two parts of the library disagree about what the reader opened.
export { threadKeyOf } from '../core/model.js';

/**
 * How an anchor names itself in the Pane header — the DECISION, without the DOM.
 *
 * A block anchor's label is the section it sits in, which only the document can supply, so the
 * caller passes a lookup and this returns what to ask for. Everything else is decided here. An
 * unrecognised kind returns null: it gets no label rather than borrowing block's, which is what the
 * panel used to do (rendering a bare "undefined", or another kind's section name).
 * @param {{type?:string, selector?:{exact?:string}, pageIndex?:number, elementId?:string}|null|undefined} a
 * @returns {{ kind:'document' }|{ kind:'region', text:string }|{ kind:'range', text:string }|{ kind:'block', elementId:string }|null}
 */
export function anchorLabelSpec(a) {
  if (!a) return null;
  if (a.type === 'document') return { kind: 'document' };
  if (a.type === 'region') return { kind: 'region', text: a.pageIndex != null ? `p.${a.pageIndex} region` : 'region' };
  if (a.type === 'range') {
    const q = a.selector?.exact || '';
    return { kind: 'range', text: `“${q.length > 40 ? `${q.slice(0, 40)}…` : q}”` };
  }
  if (a.type === 'block') return { kind: 'block', elementId: a.elementId };
  return null;
}

/**
 * A thread's contents as ONE chronological list — every comment, every reply, and the anchor's
 * move/resize history — each carrying a key that identifies that row and nothing else.
 *
 * Key construction is deliberately defensive. A reply is keyed by its POSITION under its comment
 * rather than by its own id: replies arrive through an import as well as through `addReply`, and an
 * envelope written by someone else can carry replies with missing or repeated ids. Since a key
 * collision means a row is silently never drawn, position (which the append-only reply list makes
 * stable) is the safer identity, with the id folded in as a tiebreaker. Anchor events are keyed by
 * position for the same reason: two moves recorded in the same millisecond share a timestamp.
 * @param {Comment[]|null|undefined} comments
 * @param {object[]} [events]   the anchor's append-only move/resize history
 * @returns {TimelineItem[]}
 */
export function timelineItems(comments, events) {
  const items = [];
  for (const c of comments || []) {
    items.push({ key: `c:${c.id}`, t: String(c.createdAt || ''), kind: 'comment', c });
    const replies = c.replies || [];
    for (let i = 0; i < replies.length; i++) {
      const rep = replies[i];
      items.push({ key: `r:${c.id}:${i}:${rep.id ?? ''}`, t: String(rep.createdAt || ''), kind: 'reply', rep });
    }
  }
  const evts = events || [];
  for (let i = 0; i < evts.length; i++) {
    const evt = evts[i];
    if (evt.type !== 'move' && evt.type !== 'resize') continue;
    items.push({ key: `e:${i}:${evt.ts}:${evt.type}`, t: String(evt.ts || ''), kind: 'event', evt });
  }
  // stable sort on the timestamp alone: items sharing a timestamp keep the order they were built in
  // (a comment before its own replies), which is the order a reader expects.
  return items.sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * How many UTTERANCES a thread holds — every comment plus every reply. This is what an anchor badge
 * counts: a thread where one comment drew three replies reads as four, because four things were said
 * there. Counting root comments only would make a busy conversation look untouched.
 * @param {Comment[]|null|undefined} comments
 * @returns {number}
 */
export function utteranceCount(comments) {
  let n = 0;
  for (const c of comments || []) n += 1 + ((c.replies && c.replies.length) || 0);
  return n;
}

/**
 * Where each not-yet-drawn item belongs in a thread that is already on screen — the reconciliation
 * behind a Pane that stays open while the conversation continues.
 *
 * Rows already drawn are left alone (identified by key, so nothing is drawn twice). A new row goes
 * BEFORE the first drawn row that is later than it, which keeps the timeline in order even when an
 * utterance arrives out of order — an import can deliver something older than what is on screen, and
 * appending it to the bottom would quietly break the chronological contract.
 * @param {Array<{key:string, t:string}>} drawn   rows currently on screen, in display order
 * @param {TimelineItem[]} items                  the thread's full timeline
 * @returns {Array<{item: TimelineItem, beforeKey: string|null}>}  null beforeKey = append at the end
 */
export function planInsertions(drawn, items) {
  const order = (drawn || []).map((d) => ({ key: d.key, t: d.t }));
  const have = new Set(order.map((d) => d.key));
  const plan = [];
  for (const item of items || []) {
    if (have.has(item.key)) continue;
    const at = order.findIndex((d) => d.t.localeCompare(item.t) > 0);
    plan.push({ item, beforeKey: at === -1 ? null : order[at].key });
    if (at === -1) order.push({ key: item.key, t: item.t });
    else order.splice(at, 0, { key: item.key, t: item.t });
    have.add(item.key);
  }
  return plan;
}
