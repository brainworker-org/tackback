// Not a runtime test — this file exists to be COMPILED against the published declarations, the way a
// consumer's editor compiles them. `npm run types` checks it.
//
// The declaration check on its own only proves the types are consistent with each other. A shape can
// be perfectly consistent and still wrong to use: `replies` once demanded an id and a timestamp on a
// reply that had not been written yet, values the library discards and replaces. Nothing internal
// could notice, because nothing internal was the consumer. This is.
//
// Written against `../types/index.js`, which is what the package's `types` entry resolves to.

import { Tackback, parseEnvelope, buildEnvelope, TackbackError } from '../types/index.js';
import type { StoredDocument, StorageAdapter } from '../types/core/storage.js';
import type { Comment, Anchor } from '../types/core/model.js';

// ---- an adapter, written by hand, keeping everything it is given -----------------------------------
// The obligation the contract states: the environment-local records round-trip like any other field.
let held: StoredDocument | null = null;
const mine: StorageAdapter = {
  load: () => held,
  save: (doc) => { held = doc; },
};

const tb = Tackback.mount({ document: { id: 'guide' }, storage: mine, author: { id: 'kei', kind: 'human' } });

// ---- writing ---------------------------------------------------------------------------------------
const where: Anchor = { type: 'block', elementId: 'intro' };
const first: Comment = tb.addComment({ anchor: where, body: 'a thought' });

// Seeding a thread asks for a reply the way adding one later does: what to say, and optionally who
// said it. Naming it is the library's job.
tb.addComment({
  anchor: { type: 'document' },
  body: 'about the whole thing',
  replies: [{ body: 'and a first response' }, { body: 'and another', author: { id: 'other', kind: 'ai' } }],
});
tb.addReply(first.id, { body: 'a later one' });

// ---- what this reader has not got to yet -----------------------------------------------------------
const count: number = tb.unreadCount('block:intro');
const outstanding: Array<{ threadKey: string; count: number }> = tb.unreadThreads();
tb.on('unread:change', ({ threads }: { threads: Array<{ threadKey: string; count: number }> }) => {
  for (const t of threads) console.log(t.threadKey, t.count);
});

// ---- answering for a display of your own -------------------------------------------------------------
const stopAnswering: () => void = tb.registerThreadVisibility(() => [
  { threadKey: 'block:intro', anchor: where, comments: [first.id] },
]);
tb.reportThreadVisibility();
try {
  const readable = tb.visibleThreads();
  console.log(readable.map((r) => r.threadKey));
} catch (err) {
  if (err instanceof TackbackError && err.code === 'ADAPTER_FAILED') console.log('unknown for now');
}
stopAnswering();

// ---- the shared file --------------------------------------------------------------------------------
const envelope = tb.exportEnvelope();
const parsed = parseEnvelope(JSON.stringify(envelope));
// Tombstones and surface descriptors are part of what an envelope carries, so a consumer can read them.
const buried: string[] = parsed.deleted ?? [];
const surfaces: any[] = parsed.surfaces ?? [];
console.log(count, outstanding.length, buried.length, surfaces.length);
console.log(buildEnvelope({
  document: { id: 'guide' }, now: new Date().toISOString(), version: '0.9.7',
  exportedBy: null, reactions: undefined, surfaces: undefined, comments: [first],
}).schemaVersion);

tb.destroy();
