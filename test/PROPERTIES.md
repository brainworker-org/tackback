# Properties

Behaviour this library is expected to hold, and the test that would notice if it stopped.

The spec's REQ/NFR clauses are tracked separately, in `conformance.test.js`. This ledger is finer
than that one: a clause usually bundles several properties, and a property is the unit a test can
actually fail on. The two use different names on purpose — `P-*` here, `REQ-*` there.

## How to use it

1. **Before changing something, say which properties you are touching**, by id.
2. **If two of them pull against each other, stop and raise it as a design question.** Do not pick
   one and carry on.
3. **Adding a property means adding a row.** If nothing tests it yet, write `unheld` and say so —
   an honest gap reads better than a row that implies a test exists.

Rows name real tests. `properties.test.js` checks that each one still exists in the file it names,
which catches a renamed or deleted test; it cannot check that the test still means what the row says.

## Layers

| Layer | What it can settle |
|---|---|
| `unit` | Plain functions, no DOM |
| `panel-dom` | The panel against a stand-in DOM |
| `browser` | Only a real browser: computed styles, real layout |
| `device` | Only real hardware: gestures, OS behaviour |

## Placement (P-1 … P-12)

| Id | Property | Held by | Layer | State |
|---|---|---|---|---|
| P-1 | A visual-viewport event leaves the badge DOM alone — no node is replaced, and work in progress (pointer capture, focus) survives | `panel-dom.test.js: P-1: a visual-viewport event leaves the badge DOM alone` | panel-dom | held |
| P-2 | A badge holds its place against its own anchor across a visual-viewport event | `panel-dom.test.js: P-2: a badge holds its place against its own anchor across a visual-viewport event` | panel-dom | held |
| P-3 | A comment arriving, and the explicit escape hatch, both resolve anchors again | `panel-dom.test.js: P-3: change and recalculateAnchors still resolve anchors again` | panel-dom | held |
| P-5 | Where every badge sits is pinned to the number, across all five coordinate sources | `panel-dom.test.js: G-A: where every badge sits is pinned to the number (characterization, pre-0.9.11)` | panel-dom | held |
| P-6a | Block, range and region placement go through the same geometry, and it returns the same numbers as before | `panel-dom.test.js: P-6a: block/range and region go through the same geometry, and it returns today's numbers` | unit + panel-dom | held |
| P-8 | Every overlay node is taken out of normal flow by its own rule | `panel-dom.test.js: REQ-109(b): every overlay node the panel renders is taken out of normal flow by its own rule` | panel-dom | held |
| P-9 | A badge carries exactly the THREAD the document has now (the delete menu acts on this) | `panel-dom.test.js: P-9: the comments a badge carries are the ones its thread has now` | panel-dom | held |
| P-11 | A frame of reference travels with the numbers, and every badge sits where the shared geometry puts it | `panel-dom.test.js: P-11: a frame of reference is part of the value, and mixing two of them is refused` · `panel-dom.test.js: P-11: every badge on the page sits exactly where the shared geometry puts it` | unit + panel-dom | held |
| P-12 | A corrupted coordinate is repaired by one call to the escape hatch | `panel-dom.test.js: P-12: a corrupted coordinate is repaired by one call to the escape hatch` | unit + panel-dom | held |

## Marks and overlays (REQ-109 judgment conditions)

| Id | Property | Held by | Layer | State |
|---|---|---|---|---|
| M-1 | A block mark is a class on the host's own element and adds no child | `panel-dom.test.js: REQ-109(c)-1: a block mark is a class on the host element, not an overlay node` | panel-dom | held |
| M-2 | A range mark goes through the highlight registry and adds no node — including when the API is absent | `panel-dom.test.js: REQ-109(c)-2: a range mark goes through the highlight registry and adds no node of its own` · `panel-dom.test.js: REQ-109(c)-2b: without the highlight API the mark still creates no node of its own` | panel-dom | held |
| M-3 | The mark rule is paint only: no box-model property is in it | `panel-dom.test.js: REQ-109(c)-3: the mark rule can only paint — no box-model property is in it` | panel-dom | held |

## Not held, and why

| Id | Property | Why there is no test |
|---|---|---|
| P-13 | A host element's own absolutely positioned descendants keep their place when the library establishes a containing block on it | The library sets `position: relative` on the overlay root or a surface whose computed position is `static`, and restores the inline value it captured. A CSS declaration carries no writer, so a host that sets the same value while mounted cannot be told apart and loses it on teardown. The fix is to stop writing the host's style at all; the tests for this property belong with that change, not before it. Published as a known limitation. |
