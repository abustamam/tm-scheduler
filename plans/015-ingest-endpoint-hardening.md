# Plan 015: Harden `/api/pathways/ingest` — catalog write scope, payload limits, error visibility, route-layer tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6a37548..HEAD -- src/routes/api/pathways/ingest.ts src/server/pathways-ingest-logic.ts src/server/pathways-sync-logic.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `6a37548`, 2026-07-08
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/126

## Why this matters

`/api/pathways/ingest` is the app's only token-authenticated public write
endpoint (the browser extension POSTs Base Camp Pathways data to it, per-club
Bearer token). The token design itself is solid (256-bit CSPRNG, SHA-256 at
rest, club-scoped). Four residual gaps:

1. **Cross-club catalog overwrite**: `pathways_paths` is a *globally shared*
   catalog (no clubId), and the sync upserts it with
   `onConflictDoUpdate({ set: { name } })` from the request payload. Any one
   club's token (or a compromised extension) can rename catalog entries that
   every club displays.
2. **Unbounded body**: the route runs `await request.json()` with no size cap,
   *before* the token is checked, and the zod schema puts no `.max()` on its
   arrays. A hostile client can POST arbitrarily large JSON.
3. **Invisible failures**: unexpected errors are swallowed into a generic
   `{ error: "Sync failed." }` 500 with **no server-side log** — a broken club
   sync in production leaves nothing to debug in Railway logs.
4. **Untested route layer**: the Bearer-header parsing and the
   `IngestError → HTTP status` mapping run in no test; a parsing regression
   would silently weaken auth and CI stays green.

## Current state

Relevant files:

- `src/routes/api/pathways/ingest.ts` (61 lines) — the route. Handlers only;
  CORS is deliberately `*` (documented safe: Bearer auth, no cookies — do not
  change it).
- `src/server/pathways-ingest-logic.ts` (118 lines) — token auth + parse +
  sync orchestration. Exports `IngestError` and `ingestForToken`.
- `src/server/pathways-sync-logic.ts` — `upsertPath` at lines 78–89 is the
  catalog overwrite.
- `src/server/pathways-ingest-logic.integration.test.ts` — existing tests for
  `ingestForToken` (401/400 paths); the pattern to extend.
- `src/server/sync-tokens-logic.ts` — token hash/resolve; no changes needed.

Route POST handler as it exists today (`src/routes/api/pathways/ingest.ts:35-57`):

```ts
			POST: async ({ request }) => {
				const header = request.headers.get("authorization") ?? "";
				const token = header.startsWith("Bearer ")
					? header.slice("Bearer ".length)
					: null;

				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return json({ error: "Body must be JSON." }, 400);
				}

				try {
					const result = await ingestForToken(token, body);
					return json(result, 200);
				} catch (err) {
					if (err instanceof IngestError) {
						return json({ error: err.message }, err.status);
					}
					return json({ error: "Sync failed." }, 500);
				}
			},
```

Body schema (`src/server/pathways-ingest-logic.ts:37-41`):

```ts
const bodySchema = z.object({
	basecampClubGuid: z.string().min(1),
	pages: z.array(z.unknown()).min(1),
	details: z.array(z.unknown()).optional(),
});
```

Detail-phase swallow (`src/server/pathways-ingest-logic.ts:83-93`) — the
degrade-to-warning behavior is BY DESIGN (the summary sync has already
committed; ADR-0011), but the `catch {` at line 89 currently records nothing:

```ts
		try {
			const parsedDetails = (parsed.data.details as BcmDetailPayload[]).map(
				parseDetailPayload,
			);
			detail = await syncClubDetail(tok.clubId, parsedDetails);
		} catch {
			detailWarning =
				"Project details couldn't be synced this time; counts are up to date.";
		}
```

The catalog overwrite (`src/server/pathways-sync-logic.ts:78-89`):

```ts
async function upsertPath(row: ParsedMemberPath): Promise<string> {
	const [p] = await db
		.insert(pathwaysPaths)
		.values({ courseCode: row.courseCode, name: row.pathName })
		.onConflictDoUpdate({
			target: pathwaysPaths.courseCode,
			set: { name: row.pathName },
		})
		.returning({ id: pathwaysPaths.id });
	if (!p) throw new Error("Failed to upsert path.");
	return p.id;
}
```

Conventions that apply:

- Server-fn modules export only `createServerFn`s + types
  (`server-modules.guard.test.ts`). `pathways-ingest-logic.ts` is a `-logic.ts`
  module — plain exports are fine there, and it's where the new pure helpers
  and their tests belong.
- Domain vocabulary (CONTEXT.md): "path" = a Pathways path in the shared
  catalog; a person's participation is an "enrollment". Keep those words.
- Biome: tabs, double quotes.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `bun install` | exit 0 |
| Lint/format | `bun run check` | exit 0 |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Tests | `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test` | all pass |
| One suite | `TEST_DATABASE_URL=… bunx vitest run src/server/pathways-ingest-logic.integration.test.ts` | all pass |

(`tm_test` lives in the running `dev-postgres` container; never start a new
Postgres. Integration suites skip without `TEST_DATABASE_URL`.)

## Scope

**In scope** (the only files you should modify):

- `src/routes/api/pathways/ingest.ts`
- `src/server/pathways-ingest-logic.ts`
- `src/server/pathways-sync-logic.ts` (only `upsertPath` + input length caps)
- `src/server/pathways-ingest-logic.integration.test.ts`
- `src/server/pathways-sync.integration.test.ts` (catalog-behavior tests)

**Out of scope** (do NOT touch):

- The CORS headers in the route — `*` is documented and correct here.
- `src/server/pathways-detail-logic.ts` — its project-rename-on-sync behavior
  is part of the ADR-0011 catalog-stamping design; changing it is a product
  decision, not part of this hardening (see Maintenance notes).
- `src/server/sync-tokens-logic.ts` and the token model.
- The extension (`extension/`).
- Any batching/performance rework of the sync loops (separate concern, not
  planned this round).

## Git workflow

- Branch: `advisor/015-ingest-hardening` (in a dedicated git worktree — repo
  rule; fresh worktrees need `bun install` + `.env.local` copied).
- Commit style: conventional, e.g.
  `fix(ingest): payload caps, catalog write scope, error logging + route tests`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Stop ingest from renaming existing catalog paths

In `src/server/pathways-sync-logic.ts`, change `upsertPath` to
insert-if-missing + select-if-exists (never overwrite an existing `name`):

```ts
async function upsertPath(row: ParsedMemberPath): Promise<string> {
	const [inserted] = await db
		.insert(pathwaysPaths)
		.values({ courseCode: row.courseCode, name: row.pathName })
		.onConflictDoNothing()
		.returning({ id: pathwaysPaths.id });
	if (inserted) return inserted.id;
	const [existing] = await db
		.select({ id: pathwaysPaths.id })
		.from(pathwaysPaths)
		.where(eq(pathwaysPaths.courseCode, row.courseCode));
	if (!existing) throw new Error("Failed to upsert path.");
	return existing.id;
}
```

(The insert-then-reselect pattern under concurrency is already established in
this codebase — see `src/server/pathways-detail-logic.ts:140-181`.)

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 2: Length-cap ingest-derived strings

In `src/server/pathways-ingest-logic.ts`, tighten `bodySchema`:

```ts
const bodySchema = z.object({
	basecampClubGuid: z.string().min(1).max(100),
	pages: z.array(z.unknown()).min(1).max(200),
	details: z.array(z.unknown()).max(1000).optional(),
});
```

Bounds rationale (comment them): a summary walk is one page per ~25 members
(200 pages ≫ any real club); details are one entry per member×path (1000 ≫
real). Additionally, cap the parsed path/project name lengths where they enter
the DB: in `pathways-sync-logic.ts`, truncate or reject `row.pathName` over
200 chars (reject with the existing unmatched/reported mechanics is more
complex — simplest correct: `row.pathName.slice(0, 200)` at the `upsertPath`
call site with a comment). Do the same for `proj.name` only if it can be done
without touching `pathways-detail-logic.ts` (it can't — so leave it; see
Maintenance notes).

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 3: Cap the request body size in the route

In `src/routes/api/pathways/ingest.ts`, read the body as text with a ceiling
before parsing. Target shape (replace the current `request.json()` block):

```ts
const MAX_BODY_BYTES = 5_000_000; // ~5 MB; a full 30-member club sync with details is <1 MB.

				const declared = Number(request.headers.get("content-length") ?? "0");
				if (declared > MAX_BODY_BYTES) {
					return json({ error: "Body too large." }, 413);
				}
				let body: unknown;
				try {
					const text = await request.text();
					if (text.length > MAX_BODY_BYTES) {
						return json({ error: "Body too large." }, 413);
					}
					body = JSON.parse(text);
				} catch {
					return json({ error: "Body must be JSON." }, 400);
				}
```

(Checking both the declared header and the actual text length covers chunked
bodies with no `content-length`.)

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 4: Log what today is swallowed

- In the route's final catch (currently returning the bare 500), log before
  returning: `console.error("[ingest] sync failed:", err);` — the route has no
  request-id infra; the timestamp + stack in Railway logs is the goal.
- In `pathways-ingest-logic.ts`, change the detail-phase `catch {` (line 89)
  to `catch (err) {` and add
  `console.warn("[ingest] detail phase degraded for club", tok.clubId, err);`
  before setting the warning. Do NOT change the degrade-to-warning behavior
  (ADR-0011: the detail phase must never sink a committed summary sync).
- In the same file, the summary-parse `catch {` at line 67 maps to a clean 400
  for the caller; add `console.warn("[ingest] unparseable progress payload")`
  (no payload contents in the log — it can contain member names/emails).

**Verify**: `bun run check` → exit 0.

### Step 5: Extract and test the Bearer parsing + status mapping

In `src/server/pathways-ingest-logic.ts`, add a pure exported helper and move
the route's inline parsing into it:

```ts
/** Extract the raw token from an Authorization header. Case-insensitive
 *  scheme per RFC 7235; returns null when absent/malformed. */
export function parseBearerToken(header: string | null): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? m[1] : null;
}
```

Route becomes `const token = parseBearerToken(request.headers.get("authorization"));`.

**Verify**: `bunx tsc --noEmit` → exit 0, and the guard test still passes
(`bunx vitest run src/server/server-modules.guard.test.ts` — note
`pathways-ingest-logic.ts` is a `-logic.ts` file, exempt from the
exports rule, so this must stay green trivially).

### Step 6: Tests

See "Test plan".

**Verify**: `TEST_DATABASE_URL=… bun run test` → all pass including new cases.

### Step 7: Full gate

**Verify**: `bun run check`, `bunx tsc --noEmit`, `TEST_DATABASE_URL=… bun run test`,
`bun run build` → all exit 0.

## Test plan

Unit (no DB), in `pathways-ingest-logic.integration.test.ts` or a new
`pathways-ingest-logic.test.ts` for the pure parts:

- `parseBearerToken`: null header → null; `"Bearer abc"` → `"abc"`;
  `"bearer abc"` (lowercase) → `"abc"`; `"Basic abc"` → null; `"Bearer"`
  (no token) → null; leading/trailing whitespace tolerated.
- `bodySchema` bounds: 201 pages rejected; `basecampClubGuid` of 101 chars
  rejected (exercise via `ingestForToken` with a valid token and assert the
  400 `IngestError`).

Integration (model after the existing suites in
`pathways-ingest-logic.integration.test.ts` / `pathways-sync.integration.test.ts`):

- **Catalog protection**: seed `pathways_paths` with
  `(courseCode: "PM", name: "Presentation Mastery")`; run a sync whose payload
  claims `courseCode "PM"` with a different name; assert the stored name is
  unchanged and the sync still succeeds (enrollment/levels written).
- **New path still created**: sync with an unseen courseCode creates the row.
- **Detail degrade still warns**: existing behavior test should still pass
  (the logging change must not alter the returned warning).

Route-layer cases (413 / oversized body) can't be exercised without an HTTP
harness — the header-size check is trivial enough that the excerpt review +
typecheck suffices; do NOT build an HTTP test harness for this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "onConflictDoUpdate" src/server/pathways-sync-logic.ts` shows NO hit for the paths-table upsert (enrollment/level upserts elsewhere in the file still legitimately use it)
- [ ] `grep -n "max(" src/server/pathways-ingest-logic.ts` shows caps on `pages`, `details`, `basecampClubGuid`
- [ ] `grep -n "MAX_BODY_BYTES" src/routes/api/pathways/ingest.ts` → present, with the 413 path
- [ ] `grep -n "console.error(\"\[ingest\]" src/routes/api/pathways/ingest.ts` → present in the 500 path
- [ ] `grep -n "parseBearerToken" src/routes/api/pathways/ingest.ts src/server/pathways-ingest-logic.ts` → helper exported from logic, used by route
- [ ] `bun run check`, `bunx tsc --noEmit`, `TEST_DATABASE_URL=… bun run test`, `bun run build` all exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The cited code doesn't match the excerpts (drift).
- Changing `upsertPath` breaks an existing integration test that *depends* on
  rename-propagation for paths — that would mean rename-tracking is a designed
  behavior for paths too, and the catalog-authority question needs a product
  decision.
- The extension's real payloads exceed the proposed zod bounds (check
  `samples/_api_bcm_progress_1`/`_2` fixture sizes if present — if a real
  fixture violates a bound, report instead of raising the bound arbitrarily).

## Maintenance notes

- **Accepted residual**: `pathways-detail-logic.ts` still updates project
  `name`/`level` on block-id match (rename tracking) — any club's token can
  push a rename to the shared project catalog. This is ADR-0011's
  stamping design; revisit if multi-club tenancy becomes real. An allow-list
  or per-club moderation queue is the likely future shape.
- **Not built here**: per-IP/token rate limiting on the route. The unauth
  probe cost is one SHA-256 + one indexed SELECT; revisit when #117
  (unattended scheduled sync) raises request volume.
- Reviewers of future ingest changes: any new field flowing from the payload
  into a shared (non-club-scoped) table needs the same "insert, never
  overwrite" scrutiny.
- The dev-login enable gate (`src/lib/dev-login.ts`) is already unit-tested
  (`dev-login.test.ts`); the ROUTE's 404 branch remains untested like all
  route wrappers — acceptable, same rationale as the 413 path above.
