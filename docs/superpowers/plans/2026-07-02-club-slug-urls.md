# Human-readable club URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve clubs at `/club/<slug>` (e.g. `/club/mcf-toastmasters`), with club-number and old-UUID URLs resolving and redirecting to the slug.

**Architecture:** Add `slug` + `club_number` (both `text`) to `clubs`. A pure `slugify` helper and a DB resolver (`resolveClubByIdentifier`) map a URL segment → club. Public `/club/$clubId/*` routes resolve the segment at the route layer (shell `beforeLoad` for index+meeting, and the escaped print route independently), redirect non-slug forms to the slug, and pass the resolved UUID to the existing UUID-keyed server functions, which are otherwise unchanged.

**Tech Stack:** TanStack Start/Router (SSR, file routes), Drizzle + Postgres (`node-postgres`), Vitest (unit + test-DB integration), Bun. Import alias `#/*` → `src/*`. Biome: tabs + double quotes. Strict TS (no unused symbols).

**Reference spec:** `docs/superpowers/specs/2026-07-02-club-slug-urls-design.md`

---

## File Structure

- **Modify** `src/db/schema.ts` — add `slug`, `clubNumber` to `clubs`.
- **Create** `drizzle/0006_*.sql` (via `db:generate`, then hand-edit) — add columns nullable, backfill, set NOT NULL, unique constraints, set MCF's real values.
- **Modify** `src/test/db.ts` — `seedClub` must provide a unique `slug` (NOT NULL).
- **Create** `src/lib/slug.ts` + `src/lib/slug.test.ts` — pure `slugify`.
- **Create** `src/server/clubs-logic.ts` — `resolveClubByIdentifier` (db query; never client-imported).
- **Create** `src/server/clubs.ts` — `getClubByIdentifier` (`createServerFn` wrapper only).
- **Create** `src/server/clubs.integration.test.ts` — resolver against the test DB.
- **Modify** `src/routes/club.$clubId.tsx` — shell `beforeLoad` resolve+redirect+context; `ClubNotFound`.
- **Modify** `src/components/club/require-member.tsx` — take `clubUuid` (data) + `clubSlug` (identity).
- **Modify** `src/routes/club.$clubId.index.tsx` — loader uses `context.clubUuid`.
- **Modify** `src/routes/club.$clubId.meeting.$meetingId.tsx` — loader uses `context.clubUuid`; public share button uses the slug param.
- **Modify** `src/routes/club.$clubId_.meeting.$meetingId.print.tsx` — resolve independently (escaped from shell).
- **Modify** `src/server/meetings.ts` — `loadMeetingDetail` returns `clubSlug`.
- **Modify** `src/routes/_authed/meetings.$id.tsx` — VPE share button uses `clubSlug`.

**Convention note:** `clubs.ts` is imported by client route files, so it must export ONLY `createServerFn`s/types; the db query lives in `clubs-logic.ts` (see the header comment in `src/server/members-logic.ts` and `server-modules.guard.test.ts`).

---

## Task 1: Schema + migration + test seed

**Files:**
- Modify: `src/db/schema.ts` (the `clubs` table, currently lines 75–80)
- Modify: `src/test/db.ts` (the `insert(clubs).values({ id, name })` call)
- Create/hand-edit: `drizzle/0006_*.sql`

- [ ] **Step 1: Add columns to the schema**

In `src/db/schema.ts`, change the `clubs` table to:

```ts
export const clubs = pgTable("clubs", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	clubNumber: text("club_number").unique(),
	timezone: text("timezone").notNull().default("America/Chicago"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: Give `seedClub` a unique slug**

In `src/test/db.ts`, the club insert (currently `{ id: clubId, name: "Test Club" }`) must set a unique, non-null slug so integration tests still seed. Change it to:

```ts
	await testDb.insert(clubs).values({
		id: clubId,
		name: "Test Club",
		slug: `test-club-${clubId}`,
	});
```

- [ ] **Step 3: Generate the migration**

Run: `bun run db:generate`
Expected: a new `drizzle/0006_*.sql` plus an updated `drizzle/meta/` snapshot referencing `slug` and `club_number`.

- [ ] **Step 4: Hand-edit the migration SQL to backfill before enforcing NOT NULL**

The generated SQL adds `slug` as `NOT NULL` in one statement, which fails on the existing MCF row. Edit `drizzle/0006_*.sql` so the final SQL is (keep drizzle's generated unique-constraint statements and their names; only make `slug` nullable first, inject the two backfills, then set NOT NULL):

```sql
ALTER TABLE "clubs" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "club_number" text;--> statement-breakpoint
-- Backfill existing rows (mirrors src/lib/slug.ts) so NOT NULL/unique can apply.
UPDATE "clubs" SET "slug" = trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')) WHERE "slug" IS NULL;--> statement-breakpoint
-- One-time launch values for MCF (deploy is self-completing; seed script does not run in prod).
UPDATE "clubs" SET "slug" = 'mcf-toastmasters', "club_number" = '28677176' WHERE "name" = 'MCF';--> statement-breakpoint
ALTER TABLE "clubs" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_club_number_unique" UNIQUE("club_number");
```

If drizzle generated different unique-constraint names than `clubs_slug_unique` / `clubs_club_number_unique`, use whatever names it generated (Step 6 will catch a mismatch).

- [ ] **Step 5: Apply the migration to dev + test DBs**

`drizzle.config.ts` migrates whatever `DATABASE_URL` points at. Migrate dev, then
the test DB by overriding only the database name (reuse the host/creds from
`.env.local`'s `DATABASE_URL`; the test DB is `tm_test` in the `dev-postgres`
container):

```bash
bun run db:migrate
# Take the DATABASE_URL from .env.local, swap the trailing /tm_scheduler for /tm_test:
DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | sed 's#/tm_scheduler#/tm_test#')" bun run db:migrate
```
Then verify MCF: `docker exec dev-postgres psql -U dev -d tm_scheduler -tAc "select slug, club_number from clubs where name='MCF';"`
Expected: `mcf-toastmasters|28677176`

- [ ] **Step 6: Verify no schema drift**

Run: `bun run db:generate`
Expected: **no new migration file** ("No schema changes, nothing to migrate" or equivalent). If it emits a diff (e.g. constraint-name mismatch), reconcile the constraint names in the `.sql` to match the snapshot, re-migrate a fresh scratch DB if needed, and re-run until clean.

- [ ] **Step 7: Confirm existing integration tests still seed**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/members.integration.test.ts`
Expected: PASS (proves `seedClub` with the new `slug` column works).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/test/db.ts drizzle/
git commit -m "feat(db): add club slug + club_number, backfill MCF launch values"
```

---

## Task 2: `slugify` helper

**Files:**
- Create: `src/lib/slug.ts`
- Test: `src/lib/slug.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/slug.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
	it("lowercases and hyphenates", () => {
		expect(slugify("Downtown Speakers")).toBe("downtown-speakers");
	});
	it("collapses runs of non-alphanumerics to a single hyphen", () => {
		expect(slugify("MCF   Toastmasters!!")).toBe("mcf-toastmasters");
	});
	it("trims leading/trailing separators", () => {
		expect(slugify("  --Hello, World--  ")).toBe("hello-world");
	});
	it("lowercases a plain name", () => {
		expect(slugify("MCF")).toBe("mcf");
	});
	it("returns empty string for all-punctuation input", () => {
		expect(slugify("!!!")).toBe("");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/slug.test.ts`
Expected: FAIL — cannot find module `./slug`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/slug.ts`:

```ts
/**
 * Turn a display name into a URL slug: lowercase, non-alphanumeric runs → "-",
 * trimmed. The migration backfill mirrors these rules in SQL.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/slug.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/slug.ts src/lib/slug.test.ts
git commit -m "feat(lib): slugify helper"
```

---

## Task 3: Club resolver (`resolveClubByIdentifier` + `getClubByIdentifier`)

**Files:**
- Create: `src/server/clubs-logic.ts`
- Create: `src/server/clubs.ts`
- Test: `src/server/clubs.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `src/server/clubs.integration.test.ts`:

```ts
/**
 * DB-backed tests for resolveClubByIdentifier. `#/db` is redirected to the
 * test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/clubs.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs } from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";
import { resolveClubByIdentifier } from "./clubs-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("resolveClubByIdentifier", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(clubs)
			.set({ slug: `mcf-${seed.clubId}`, clubNumber: `num-${seed.clubId}` })
			.where(eq(clubs.id, seed.clubId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("resolves by slug", async () => {
		const club = await resolveClubByIdentifier(`mcf-${seed.clubId}`);
		expect(club.id).toBe(seed.clubId);
	});
	it("resolves by club number", async () => {
		const club = await resolveClubByIdentifier(`num-${seed.clubId}`);
		expect(club.id).toBe(seed.clubId);
	});
	it("resolves by UUID", async () => {
		const club = await resolveClubByIdentifier(seed.clubId);
		expect(club.slug).toBe(`mcf-${seed.clubId}`);
	});
	it("matches slug case-insensitively", async () => {
		const club = await resolveClubByIdentifier(`MCF-${seed.clubId}`.toUpperCase());
		expect(club.id).toBe(seed.clubId);
	});
	it("throws for an unknown identifier", async () => {
		await expect(resolveClubByIdentifier("nope-does-not-exist")).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/clubs.integration.test.ts`
Expected: FAIL — cannot find module `./clubs-logic`.

- [ ] **Step 3: Write `resolveClubByIdentifier`**

Create `src/server/clubs-logic.ts`:

```ts
// Club identifier resolution. Lives away from the createServerFn wrapper
// (`clubs.ts`, client-imported) so its `db` import is never bundled into the
// client. See the header of `members-logic.ts`.
import { eq, or, type SQL } from "drizzle-orm";
import { db } from "#/db";
import { clubs } from "#/db/schema";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvedClub = {
	id: string;
	slug: string;
	name: string;
	timezone: string;
	clubNumber: string | null;
};

/**
 * Resolve a URL segment to a club by slug (case-insensitive), then club number,
 * then UUID. Throws if nothing matches. Slug is tried first, so a slug that
 * happens to equal a club number still wins as a slug.
 */
export async function resolveClubByIdentifier(
	identifier: string,
): Promise<ResolvedClub> {
	const seg = identifier.trim();
	const lower = seg.toLowerCase();

	// Build match conditions. Only compare against `id` when the segment is a
	// real UUID — otherwise Postgres throws "invalid input syntax for type uuid".
	const conds: SQL[] = [eq(clubs.slug, lower), eq(clubs.clubNumber, seg)];
	if (UUID_RE.test(seg)) conds.push(eq(clubs.id, seg));

	const rows = await db
		.select({
			id: clubs.id,
			slug: clubs.slug,
			name: clubs.name,
			timezone: clubs.timezone,
			clubNumber: clubs.clubNumber,
		})
		.from(clubs)
		.where(or(...conds));

	if (rows.length === 0) throw new Error("Club not found.");
	// Precedence: slug > club number > id.
	return (
		rows.find((r) => r.slug === lower) ??
		rows.find((r) => r.clubNumber === seg) ??
		rows[0]
	);
}
```

- [ ] **Step 4: Write the thin server-fn wrapper**

Create `src/server/clubs.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { resolveClubByIdentifier } from "./clubs-logic";

/** Resolve a club URL segment (slug | club number | UUID) to the club.
 *  PUBLIC — no session required. */
export const getClubByIdentifier = createServerFn({ method: "GET" })
	.validator((identifier: unknown) => z.string().min(1).parse(identifier))
	.handler(async ({ data }) => resolveClubByIdentifier(data));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/clubs.integration.test.ts`
Expected: PASS (5 tests).

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS (confirms `clubs.ts` exports only server fns / types).

- [ ] **Step 6: Commit**

```bash
git add src/server/clubs-logic.ts src/server/clubs.ts src/server/clubs.integration.test.ts
git commit -m "feat(server): resolveClubByIdentifier (slug/number/uuid)"
```

---

## Task 4: Shell route resolves + redirects; RequireMember takes uuid + slug

**Files:**
- Modify: `src/routes/club.$clubId.tsx`
- Modify: `src/components/club/require-member.tsx`

- [ ] **Step 1: Rewrite the shell route**

Replace the entire contents of `src/routes/club.$clubId.tsx` with:

```tsx
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { RequireMember } from "#/components/club/require-member";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { getClubByIdentifier } from "#/server/clubs";

export const Route = createFileRoute("/club/$clubId")({
	beforeLoad: async ({ params, location }) => {
		const club = await getClubByIdentifier({ data: params.clubId });
		// Canonicalize: number/UUID (or wrong-case slug) → the slug URL.
		if (params.clubId !== club.slug) {
			throw redirect({
				href:
					location.pathname.replace(/^\/club\/[^/]+/, `/club/${club.slug}`) +
					location.searchStr,
			});
		}
		return { clubUuid: club.id, clubSlug: club.slug };
	},
	component: ClubShell,
	notFoundComponent: ClubNotFound,
});

function ClubShell() {
	const { clubId } = Route.useParams();
	const { clubUuid } = Route.useRouteContext();
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-background">
			<RequireMember clubUuid={clubUuid} clubSlug={clubId}>
				<Outlet />
			</RequireMember>
			<Toaster position="top-center" />
		</div>
	);
}

function ClubNotFound() {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
			<p className="font-semibold text-lg">Club not found</p>
			<p className="text-muted-foreground text-sm">
				This club doesn't exist, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link to="/">Go home</Link>
			</Button>
		</div>
	);
}
```

- [ ] **Step 2: Update RequireMember to take `clubUuid` (data) + `clubSlug` (identity)**

In `src/components/club/require-member.tsx`:

Change the `RequireMember` signature and body:

```tsx
export function RequireMember({
	clubUuid,
	clubSlug,
	children,
}: {
	clubUuid: string;
	clubSlug: string;
	children: React.ReactNode;
}) {
	const { member, setMember } = useCurrentMember(clubSlug);
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	if (!mounted) {
		return (
			<output
				className="flex min-h-svh items-center justify-center text-muted-foreground"
				aria-label="Loading"
			>
				<span aria-hidden>…</span>
			</output>
		);
	}

	if (!member) {
		return <PickNameScreen clubUuid={clubUuid} onPicked={setMember} />;
	}

	return <>{children}</>;
}
```

Then change `PickNameScreen` to take `clubUuid` and use it for the server calls (identity is already handled by the parent via `clubSlug`):

```tsx
function PickNameScreen({
	clubUuid,
	onPicked,
}: {
	clubUuid: string;
	onPicked: (m: StoredMember) => void;
}) {
	const [query, setQuery] = useState("");
	const [newName, setNewName] = useState("");

	const { data: members = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
	});

	const addMutation = useMutation({
		mutationFn: (name: string) => addMember({ data: { clubId: clubUuid, name } }),
	});
```

(Leave the rest of `PickNameScreen` unchanged — the `filtered`/`handleAdd`/JSX below still work.)

- [ ] **Step 3: Typecheck**

Run: `bun run check`
Expected: PASS. (If `redirect({ href })` is rejected by types, that's a real signal — TanStack supports `href` on redirect; ensure the import and field name are correct.)

- [ ] **Step 4: Commit**

```bash
git add src/routes/club.$clubId.tsx src/components/club/require-member.tsx
git commit -m "feat(club): resolve+redirect club slug in the shell route"
```

---

## Task 5: Index route uses the resolved UUID

**Files:**
- Modify: `src/routes/club.$clubId.index.tsx`

- [ ] **Step 1: Update the loader to read `context.clubUuid`**

In `src/routes/club.$clubId.index.tsx`, change the route definition's loader:

```tsx
export const Route = createFileRoute("/club/$clubId/")({
	loader: ({ context }) => listUpcomingMeetings({ data: context.clubUuid }),
	component: ClubHome,
});
```

Leave `ClubHome` unchanged — it still reads `const { clubId } = Route.useParams()` (now the slug) for `useCurrentMember(clubId)` (identity is slug-keyed) and for `<Link>` params.

- [ ] **Step 2: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/routes/club.$clubId.index.tsx
git commit -m "feat(club): index loader uses resolved club uuid"
```

---

## Task 6: Meeting route uses the resolved UUID; public share button uses the slug

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`

- [ ] **Step 1: Update the loader to take `context` and use `context.clubUuid`**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, change the loader signature and the two `params.clubId` usages:

```tsx
	loader: async ({ params, context }) => {
		// Fire both in parallel. getMeeting stays fatal (the agenda is the page);
		// the upcoming list is non-fatal — a failure degrades to no strip.
		const meetingPromise = getMeeting({ data: params.meetingId });
		const upcomingPromise = listUpcomingMeetings({
			data: context.clubUuid,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);

		const data = await meetingPromise;
		// Guard against a meetingId that belongs to a different club than the URL.
		if (data.meeting.clubId !== context.clubUuid) throw notFound();
```

(Everything below — `currentOpenSlots`, `buildMeetingNavItems`, the return — is unchanged.)

- [ ] **Step 2: Point the public share button at the slug**

In the same file, the meeting-view `ShareLinkButton` currently builds its path from `meeting.clubId` (a UUID). Change it to the route param (the slug — `clubId` is already destructured from `Route.useParams()` in `MeetingView`):

```tsx
					path={`/club/${clubId}/meeting/${meeting.id}`}
```

- [ ] **Step 3: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/club.$clubId.meeting.$meetingId.tsx
git commit -m "feat(club): meeting loader uses resolved uuid; share link uses slug"
```

---

## Task 7: Print route resolves independently (escaped from the shell)

**Files:**
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

- [ ] **Step 1: Resolve + redirect + guard in the print loader**

The `$clubId_` route opts out of the shell, so it must resolve itself. Replace its `loader` and add the needed imports.

Add to the imports at the top:

```tsx
import { redirect } from "@tanstack/react-router";
import { getClubByIdentifier } from "#/server/clubs";
```

(`createFileRoute` and `notFound` are already imported from `@tanstack/react-router`; add `redirect` to that existing import instead of duplicating.)

Replace the loader:

```tsx
		loader: async ({ params, location }) => {
			const club = await getClubByIdentifier({ data: params.clubId });
			if (params.clubId !== club.slug) {
				throw redirect({
					href:
						location.pathname.replace(/^\/club\/[^/]+/, `/club/${club.slug}`) +
						location.searchStr,
				});
			}
			const data = await getMeeting({ data: params.meetingId });
			if (data.meeting.clubId !== club.id) throw notFound();
			return data;
		},
```

- [ ] **Step 2: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/routes/club.$clubId_.meeting.$meetingId.print.tsx
git commit -m "feat(club): print route resolves club slug independently"
```

---

## Task 8: Authed VPE share button emits the slug URL

**Files:**
- Modify: `src/server/meetings.ts` (`loadMeetingDetail`)
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Return the club slug from `loadMeetingDetail`**

In `src/server/meetings.ts`, in `loadMeetingDetail`, add `slug` to the club columns and return `clubSlug`:

```ts
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
		columns: { timezone: true, name: true, slug: true },
	});
```

and in the returned object add:

```ts
		clubSlug: club?.slug ?? "",
```

(next to `clubName: club?.name ?? "",`).

- [ ] **Step 2: Use `clubSlug` in the VPE share button**

In `src/routes/_authed/meetings.$id.tsx`, add `clubSlug` to the loader-data destructure (currently `const { meeting, slots, canManage, timezone, unavailableMembers } = Route.useLoaderData();`):

```tsx
	const { meeting, slots, canManage, timezone, unavailableMembers, clubSlug } =
		Route.useLoaderData();
```

and change the `ShareLinkButton` path (currently `/club/${meeting.clubId}/meeting/${meeting.id}`):

```tsx
					path={`/club/${clubSlug}/meeting/${meeting.id}`}
```

- [ ] **Step 3: Typecheck + full suite**

Run: `bun run check`
Expected: PASS.

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test`
Expected: PASS (all unit + integration tests; the meeting/print/index changes compile and existing behavior holds).

- [ ] **Step 4: Manual verification (dev server)**

Run `bun run dev`. With MCF (`slug='mcf-toastmasters'`):
- `http://localhost:3000/club/mcf-toastmasters` → serves the club (pick-name → home).
- `http://localhost:3000/club/28677176` → **redirects** to `/club/mcf-toastmasters`.
- `http://localhost:3000/club/78bc6e8c-0031-4eb7-bd36-c3b85c902dc1` → **redirects** to `/club/mcf-toastmasters`.
- Open a meeting; the nav strip still works; the "Copy share link" button copies a `/club/mcf-toastmasters/meeting/...` URL.
- `http://localhost:3000/club/does-not-exist` → "Club not found".

(Defer heavy browser QA to the controller; this step confirms wiring compiles and resolves.)

- [ ] **Step 5: Commit**

```bash
git add src/server/meetings.ts src/routes/_authed/meetings.$id.tsx
git commit -m "feat(club): VPE share link emits the canonical slug URL"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** schema slug+club_number as text (Task 1); migration backfill + MCF values (Task 1 Step 4); slugify (Task 2); resolver precedence slug→number→uuid, case-insensitive, unknown→throw (Task 3); shell resolve+redirect+context + not-found (Task 4); UUID-keyed server fns unchanged, loaders read context (Tasks 5/6); print route resolves independently (Task 7); both share buttons emit the slug — public via param (Task 6), authed via `clubSlug` (Task 8); localStorage identity stays slug-keyed via `clubSlug` (Task 4). All covered.
- **Type consistency:** `resolveClubByIdentifier(identifier: string): ResolvedClub` and `getClubByIdentifier({ data })` are used identically in Tasks 3/4/7. Shell `beforeLoad` returns `{ clubUuid, clubSlug }`; consumed as `context.clubUuid` (Tasks 5/6) and `Route.useRouteContext().clubUuid` + `clubSlug` prop (Task 4). `RequireMember` props `{ clubUuid, clubSlug }` match the shell call. `loadMeetingDetail` adds `clubSlug`, consumed in Task 8.
- **Deferred/for-the-controller:** heavier browser QA (redirects + share-copy) after the tasks land.
