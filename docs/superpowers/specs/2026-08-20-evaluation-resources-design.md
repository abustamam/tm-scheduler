# Official evaluation resources, linked to projects and searchable

Toastmasters International publishes one evaluation resource PDF per Pathways
project. Finding the right one on toastmasters.org means paging through a
15-page filtered resource library five items at a time. This spec links each
one to the project it belongs to, surfaces it where a member or evaluator
already stands, and puts all of them on one searchable page.

We link to TI's files. We do not host, mirror, cache or proxy them.

## Provenance of the data

Scraped 2026-08-20 from the Evaluation Resources category of TI's resource
library:

```
https://www.toastmasters.org/resources/resource-library?c=%7B01B94FC3-FC65-4308-8CB2-6193718ED156%7D
```

15 pages, `&page=N`, five items per page, 73 items — matching the "1-5 of 73
items" the page states. Server-rendered, so a plain authenticated-free GET
returns the markup; no JS execution needed.

All 73 destination URLs were requested with `curl -L`: every one returned
`200 application/pdf`. That is all 73, not a sample.

Three hosts appear, all TI:

| Host | Count | Shape |
| --- | --- | --- |
| `www.toastmasters.org` | 61 | `/resources/-/media/<guid>.ashx` |
| `ccdn.toastmasters.org` | 8 | `/medias/files/…/<name>.pdf` |
| `content.toastmasters.org` | 4 | `/image/upload/<name>.pdf` |

The `.ashx` links carry an opaque Sitecore GUID and reveal nothing about their
contents. The **item code** (`8200E`, `8101E`, `8053`) is the durable
identifier, and it is usually recoverable from the thumbnail filename
(`…/english/8200e-evaluation-resource-ffe.jpg`) or the PDF filename
(`8104E1-evaluation-resource-ff.pdf`). The codes are structured — `81xx` Level
1, `82xx` Level 2, `83xx` Level 3, `84xx` Level 4, `85xx` Level 5, `8053`
generic — which is what makes them worth recording.

**Two of the 64 shipped entries have no discoverable item code**: Evaluation and
Feedback's second and third resources use a generic thumbnail and an `.ashx`
URL, so nothing on the page exposes their code. `8100E1` is confirmed for the
first speech (from its PDF filename); `8100E2` for the second would be an
inference, and this spec does not record inferences as codes. `itemCode` is
therefore nullable, and identity is a separate local key — see §1.

### TI's own library has four title/description conflicts

Each item carries a description of the form *"This evaluation resource is for
the "X" project."* Across the 73: 64 agree with the title, 3 have no parseable
project in the description (`8053`, `490CO`, `490DL` — all non-project
resources), and 6 disagree. Two of those 6 are harmless — Introduction to Vocal
Variety's two resources echo their own full title inside the quotes, which is
itself why the description cannot be trusted as a general parser. The remaining
**four are genuine conflicts, and neither field is right in all four**:

| Item | Title says | Description says | Trusted |
| --- | --- | --- | --- |
| `8103E` | Evaluation and Feedback-Writing a Speech With Purpose | Writing a Speech With Purpose | **description** |
| `8409E` | Managing a Difficult Audience | Manage Projects Successfully | **title** |
| `8410E` | Mentoring | Manage Projects Successfully | **title** |
| `8207E` | Understanding Your Leadership Style | Understanding Your Communication Style | **title** |

`8409E`/`8410E`/`8207E` are consecutive-code copy-paste errors in TI's
descriptions — `8408E` is the genuine "Manage Projects Successfully" and `8206E`
the genuine "Understanding Your Communication Style", so the description was
duplicated down the list. `8103E` is the reverse: the title carries a stray
"Evaluation and Feedback-" prefix while `8100E1`/`8100E2` are the real
Evaluation and Feedback resources.

Consequence for matching: title-only resolves 59 of 60 catalog projects,
description-only resolves 57. Only a hand-audited per-item decision reaches
60 of 60. **The mapping is therefore pinned in source, not derived at runtime.**

### Selection funnel

| Step | Count |
| --- | --- |
| Scraped from the category | 73 |
| less language variants (Arabic ×1, Simplified Chinese ×2) | 70 |
| of which map to a `pathways-catalog.ts` project | 63 |
| plus `8053` Generic Evaluation Resource | **64 shipped** |

The 63 project resources cover **all 60** distinct project names in
`src/lib/pathways-catalog.ts` — 60 rather than 63 because two projects have
more than one resource:

- **Evaluation and Feedback** — three (`8100E1` first speech, `8100E2` second
  speech, and the evaluator-role component). The project genuinely takes three
  assignments, which `pathways-catalog.ts` already documents under NOT MODELLED.
- **Introduction to Vocal Variety and Body Language** — two (`8104E1`
  evaluation resource, `8104E2` speech profile).

Seven English items map to no catalog project. Per the product decision only
`8053` ships; the other six are recorded here so a later reader knows they were
seen and skipped, not missed:

`8500E` Advanced Mentoring · `8202E` Cross-Cultural Understanding ·
`8410E` Mentoring · `8599E` Distinguished Toastmaster ·
`490CO` Club Officer 360-Degree Evaluation ·
`490DL` District Leader 360-Degree Evaluation

### Out of scope: a possible catalog gap

`8500E` Advanced Mentoring, `8202E` Cross-Cultural Understanding and `8410E`
Mentoring are real Pathways projects that TI publishes evaluation resources
for, and `pathways-catalog.ts` lists none of them. That file's header states
its elective pools "need re-checking by hand whenever TI revises the
curriculum" and that this is not automatic. This is plausibly that signal.

It is deliberately **not** fixed here: adding a project to the catalog changes
what the project picker offers and what the seed writes, which is a different
change with a different blast radius. Filed as #606.

## What gets built

### 1. `src/lib/evaluation-resources.ts` — the data and the lookup

```ts
export interface EvaluationResource {
	/**
	 * Local stable identity, kebab-case ("active-listening",
	 * "evaluation-and-feedback-2"). Ours, not TI's — two resources have no
	 * discoverable item code, so `itemCode` cannot carry identity.
	 */
	key: string;
	/** TI's item code where the page exposes one; null for 2 of the 64. */
	itemCode: string | null;
	/** Display title, cleaned of TI's "-Evaluation Resource" suffix. */
	title: string;
	/** Absolute https URL on a toastmasters.org host. */
	url: string;
	/** Canonical `pathways-catalog.ts` project name; null for the generic. */
	project: string | null;
	/** Distinguishes siblings: "First speech", "Evaluator role", "Speech profile". */
	part?: string;
}

export const EVALUATION_RESOURCES: readonly EvaluationResource[]; // 64
export const GENERIC_EVALUATION_RESOURCE: EvaluationResource;     // 8053
export function resourcesForProject(
	name: string | null | undefined,
): readonly EvaluationResource[];
```

`resourcesForProject` normalizes its argument before lookup: trims, lowercases,
collapses non-alphanumerics, and **strips a trailing `(Legacy)`**. It returns
`[]` for an unknown name — never the generic resource, because a caller that
wants the fallback should say so at the call site rather than be unable to tell
"no match" from "matched the generic".

`part` exists so the three Evaluation and Feedback resources are
distinguishable in a list. It is absent on the 58 single-resource projects.

**Why `src/lib/` and not a database table.** Three reasons, in order of force:

1. `pathways_projects` rows are ingested per club from Base Camp
   (`pathways-ingest-logic.ts` → `reconcileCatalog`), so their names track
   whatever TI renamed a project to for that club. `pathways-catalog.ts` is the
   stable key; a table keyed on ingested rows needs a backfill on every sync.
2. A club that has never synced has an empty `pathways_projects` — the same
   reason `pathways-catalog.ts` exists as a seed at all (#412).
3. CLAUDE.md's constant-assertability trap: a constant defined in a module that
   imports `#/db` cannot be reached from a unit test, because importing it
   throws `DATABASE_URL is not set`. The numbers and the URLs must live where
   vitest can assert on them.

The module's header carries the Provenance section above in condensed form: the
scrape date, the exact URL, the 73→64 funnel, the four conflicts with which
field was trusted, and the catalog gap. `pathways-catalog.ts` carries a
prominent correction about an earlier version claiming a TI source for
LLM-generated names — "corrected here rather than quietly deleted so nobody
re-derives false confidence from it". This file records how its data was
obtained so the same question never has to be re-litigated.

### 2. Project picker

`src/components/pathways/project-picker.tsx` renders each project as a button
showing `project.name` and a Required badge. Each row gains a link to its
evaluation resource, and the selected-project summary block does too.

The link is an `<a target="_blank" rel="noopener noreferrer">` to TI. Per
CLAUDE.md's unlayered-anchor rule, `src/styles.css` styles bare `a` outside
`@layer` and repaints it link-teal regardless of any utility class the
component sets. Here that is the desired colour — these ARE external links —
so no `data-slot` exclusion is needed. Stated explicitly because the rule has
caused three bugs by being discovered late.

A project with no resource renders no link. That is unreachable for catalog
projects today (60/60 covered) but reachable for a Base-Camp-ingested project
name the catalog does not have, which is exactly the Advanced Mentoring case
above.

### 3. Evaluator "Up next"

The member who needs the evaluation form is usually **the evaluator**, not the
speaker. `role_slots.evaluatesSlotId` already points an evaluator slot at the
speaker slot it evaluates, and that speaker slot carries `speechId` →
`speeches.projectId` / `speeches.projectName`.

`loadMyCommitments` (`src/server/my-activity-logic.ts`) currently left-joins
`speeches` on the member's **own** `roleSlots.speechId`, which is null for an
evaluator. It gains a self-join through `evaluatesSlotId` to the speaker slot
and its speech, yielding the evaluated project name. The same file already uses
this idiom in the opposite direction at `my-activity-logic.ts:81`
(`evaluatorSlot.evaluatesSlotId = roleSlots.id`), so the shape is established.

Resolution order for an evaluator's commitment:

1. `speeches.projectId` → catalog project name → `resourcesForProject`
2. else free-text `speeches.projectName` → `resourcesForProject`
3. else (TBA speech, no project, or no match) → `GENERIC_EVALUATION_RESOURCE`

Step 3 is why `8053` ships. An evaluator assigned to a TBA speech still gets a
usable form.

A speaker's own commitment gets the same link for their own project, via the
existing join.

**This must stay one query.** The join is added to the existing statement, not
issued per row. Guarded by a query-count assertion (below) because a per-row
lookup here is an N+1 over every upcoming commitment.

### 4. `/resources/evaluation-resources`

A new public route listing all 64 alphabetically, with a filter input matching
project name, resource title, item code and part. Filtering is client-side over
a 64-item array — no server round-trip, no query.

**Not grouped by level.** An earlier draft of this section said "grouped by
Level 1–5", which is not buildable as specified: `EvaluationResource` carries no
level, and it cannot derive one — the item-code prefix is the only signal and
three rows have no code. Supplying it would mean importing
`pathways-catalog.ts` here, which §1 forbids precisely so the two files can
cross-check each other. A level is also not what someone types when hunting for
a form; the project name is. Alphabetical plus filter.

Registered in `src/data/resources.ts` as a `Resource` with `cat: "Pathways"`.
`src/data/resources.guard.test.ts` asserts both directions of the
registry↔markdown relation: every entry has a `content/resources/<slug>.md`,
and every markdown file has an entry. So this route gets a real intro article
(`content/resources/evaluation-resources.md`) explaining what an evaluation
resource is and that the files are TI's. That keeps the guard untouched, and
the page is public and worth having prose on.

The route reuses `ResourcesShell` so a signed-in member with a club sees it
inside the app shell and an anonymous visitor gets the light header, matching
`resources.index.tsx`.

### 5. Legacy-path labelling

`pathways-catalog.ts` suffixes every project on the five legacy paths with
`" (Legacy)"`, because Base Camp names the superseded edition that way. TI
publishes only the current edition of each evaluation resource.

`resourcesForProject` strips the suffix, so a legacy-path member gets the
current-edition resource. Where the requested name carried `(Legacy)` and the
match came from stripping it, the UI notes that the form is the current
edition. Without that note a member could be evaluated against criteria that do
not match their path's edition and have no way to know.

The note is derived at the call site from the input name, not stored on the
resource — the resource is edition-neutral; only the request is legacy.

## Testing

The interesting risk is that the mapping is silently wrong, so the tests aim at
the mapping rather than at the plumbing.

**`src/lib/evaluation-resources.test.ts`** (unit, no DB):

- For every one of the 60 distinct project names in `PATHWAYS_CATALOG`,
  `resourcesForProject` returns at least one resource. This is the assertion
  that catches TI's four title/description conflicts — it fails if the pinned
  mapping regresses to naive title matching.
- Each `(Legacy)`-suffixed name resolves to the identical resource as its
  current-edition twin.
- An unknown name returns `[]`, and specifically not the generic.
- Evaluation and Feedback returns three resources with distinct `part` values;
  Introduction to Vocal Variety and Body Language returns two.

**Structural guard, absolute not relative.** CLAUDE.md's trap: a test stated
relative to the constant it guards cannot fail —
`expect(EVALUATION_RESOURCES.length).toBeGreaterThan(0)` passes for every value
including a truncated list. So:

- `EVALUATION_RESOURCES.length === 64` exactly.
- Every `key` unique and non-empty; every non-null `itemCode` unique.
- Exactly two entries have `itemCode === null`, and both are Evaluation and
  Feedback siblings — so a future entry cannot quietly omit a code that TI does
  publish.
- Every `url` parses, uses `https:`, and has a hostname equal to or ending in
  `.toastmasters.org` — no third-party host can be introduced silently.
- Exactly one entry has `project === null`, and it is `8053`.
- Every `url` distinct: two projects pointing at the same PDF is the shape a
  copy-paste error in a 64-entry hand-audited table would take.

**`scripts/check-evaluation-resource-links.ts`** — link liveness, deliberately
**not** a vitest test. It needs network, and a network test that skips when
offline reads exactly like a passing one; that is the failure shape CLAUDE.md
documents for the Chrome-backed print gates ("a silently absent print gate
reads exactly like a passing one"). As a script it is honest: run it, and it
prints every URL whose status is not `200 application/pdf` and exits non-zero
if any. Run on demand and when TI reorganizes, not in CI.

**Query-count guard** on the evaluator join, using `statementsDuring` /
`readsOf` from `src/test/query-spy.ts`, which spy on `db.$client` (the
node-postgres pool) and so are indifferent to how the statement was built.
Asserts the statement list is non-empty before trusting the count — CLAUDE.md
notes both blind spots (transaction-scoped statements report zero, and a broken
driver pattern also reports zero), and an unguarded zero reads as success.

**Component tests** for the picker link and the commitments link. Note
CLAUDE.md's props trap: a component tested through its props cannot see a wrong
prop, and the resolution order in §3 is a computed expression. The resolution
itself therefore lives in a pure exported function in `src/lib/` — not inline
in the route or the component — so it is directly testable rather than reachable
only through a source grep.

## What this does not do

- No hosting, mirroring, caching or proxying of TI's PDFs. Links only.
- No print surface. The `.ashx` URLs are ~80 characters of opaque GUID and are
  useless typed off paper; a QR code on the printed agenda is a separate idea
  with its own layout cost against the page-count and density gates.
- No language variants. The three that exist (Arabic, Simplified Chinese) are
  dropped; the schema has no language field, so adding them later is additive.
- No officer 360-degree evaluations or DTM resource.
- No change to `pathways-catalog.ts`, including the three-project gap above.
- No automatic re-scrape. The mapping is pinned in source and TI's library
  moves rarely; the liveness script is how drift gets noticed.
