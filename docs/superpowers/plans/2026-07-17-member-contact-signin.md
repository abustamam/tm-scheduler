# Member Contact Info for Signed-In Members — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show member email + phone to signed-in members only — as Email/Phone columns on the authed `/schedule` grid and a contact block on the member profile — plus a "Copy sign-up sheet link" button; never on the public `/club/:clubId` sheet.

**Architecture:** The grid component is shared by the public club shell and the authed `/schedule`, both driven by `loadSeasonGrid`. The visibility gate therefore lives in the data layer: `loadSeasonGrid` gains an `includeContact` flag; the authed server fn passes `true`, the public one `false`, so contact never enters the public payload. The member profile route is already `_authed` and already loads contact, so that half is display-only. The share link reuses the existing `ShareLinkButton`; the club slug it needs is returned from `loadSeasonGrid` (which already queries the club).

**Tech Stack:** TanStack Start (React 19), Drizzle ORM + Postgres, Vitest (integration tests against `tm_test`), Biome, shadcn/ui, lucide-react.

**Spec:** `docs/superpowers/specs/2026-07-17-member-contact-signin-design.md`

---

## File Structure

- `src/server/season-grid-logic.ts` — **modify.** Extend `SeasonGridMember` (optional `email`/`phone`) and `SeasonGridData` (`clubSlug`); add `includeContact` to `loadSeasonGrid`; select contact + slug.
- `src/server/season-grid.ts` — **modify.** `getSeasonGrid` passes `includeContact: true`; `getPublicSeasonGrid` passes `false`.
- `src/server/season-grid.integration.test.ts` — **modify.** Add tests for contact inclusion/exclusion + slug.
- `src/components/club/season-grid.tsx` — **modify.** New `showContact` prop; render Email/Phone columns in the Members × Meetings orientation.
- `src/routes/_authed/schedule.tsx` — **modify.** Pass `showContact`; add the "Copy sign-up sheet link" button.
- `src/routes/_authed/members.$id.tsx` — **modify.** Add a contact block to the profile header (display only).

---

## Task 0: Worktree prep

This plan runs in the existing worktree `.claude/worktrees/member-contact-signin`. A fresh worktree needs deps + env before tests/typecheck work.

**Files:** none (environment only)

- [ ] **Step 1: Install deps**

Run: `bun install`
Expected: completes without error.

- [ ] **Step 2: Provide env for the DB-backed test**

The integration test is skipped unless `TEST_DATABASE_URL` points at a reachable DB. `tm_test` runs in the `dev-postgres` container. No schema change in this plan, so no `db:push` is needed. Confirm reachability:

Run: `docker exec dev-postgres psql -U dev -d tm_test -c 'select 1'`
Expected: prints a `1` row. (If `.env.local` is absent in the worktree and later build/dev steps need it, copy it from the main checkout: `cp ../../.env.local .env.local` — not required just for the integration test, which only needs `TEST_DATABASE_URL`.)

---

## Task 1: Data layer — `includeContact` + `clubSlug` in `loadSeasonGrid`

**Files:**
- Modify: `src/server/season-grid-logic.ts`
- Test: `src/server/season-grid.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `clubs` to the schema import at the top of `src/server/season-grid.integration.test.ts` (it currently imports `meetings, memberAvailability, roleDefinitions, roleSlots` from `#/db/schema`) so it reads:

```ts
import {
	clubs,
	meetings,
	memberAvailability,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
```

Then add these three tests inside the `describe.skipIf(!hasTestDb)("loadSeasonGrid", …)` block (e.g. after the existing `"count: 'all'…"` test):

```ts
it("includeContact: true puts email + phone on the member axis", async () => {
	const { loadSeasonGrid } = await import("#/server/season-grid-logic");
	const data = await loadSeasonGrid({
		clubId: seed.clubId,
		count: 8,
		includeContact: true,
	});
	const member = data.members.find((m) => m.id === seed.memberId);
	expect(member).toBeDefined();
	// seedClub sets the member's email but no phone.
	expect(member?.email).toBe(`member-${seed.memberUserId}@test.example`);
	expect(member).toHaveProperty("phone");
	expect(member?.phone).toBeNull();
});

it("includeContact omitted (default) leaves contact off the member axis", async () => {
	const { loadSeasonGrid } = await import("#/server/season-grid-logic");
	const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
	const member = data.members.find((m) => m.id === seed.memberId);
	expect(member).toBeDefined();
	expect(member).not.toHaveProperty("email");
	expect(member).not.toHaveProperty("phone");
});

it("returns the club slug on the payload", async () => {
	const { loadSeasonGrid } = await import("#/server/season-grid-logic");
	const [club] = await testDb
		.select({ slug: clubs.slug })
		.from(clubs)
		.where(eq(clubs.id, seed.clubId));
	const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
	expect(data.clubSlug).toBe(club!.slug);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts`
Expected: the three new tests FAIL — `includeContact` is not accepted / `data.clubSlug` is `undefined` / member has no `email` key. (If ALL tests are skipped, `TEST_DATABASE_URL` isn't reaching `tm_test` — fix Task 0 Step 2 first.)

- [ ] **Step 3: Extend the types**

In `src/server/season-grid-logic.ts`, extend `SeasonGridMember`:

```ts
export interface SeasonGridMember {
	id: string;
	name: string;
	/** Present only on the member axis when contact is included (authed).
	 *  Never populated for the public sheet or for name-only lookups. */
	email?: string | null;
	phone?: string | null;
}
```

And add `clubSlug` to `SeasonGridData` (place it near the top of the interface, after `meetings`). It is **optional** on purpose: `loadSeasonGrid` always sets it, but existing tests (`src/lib/season-grid-view.test.ts`, `src/lib/member-role-picker.test.ts`) build `SeasonGridData` literals without it — optional keeps their typecheck green untouched.

```ts
export interface SeasonGridData {
	/** The club's URL slug — used to build the public sign-up-sheet share link.
	 *  Optional so existing view/picker test fixtures need not set it; always
	 *  populated by loadSeasonGrid. */
	clubSlug?: string | null;
	meetings: SeasonGridMeeting[];
	rows: SeasonGridRow[];
	members: SeasonGridMember[];
	memberNames: SeasonGridMember[];
	guestNames: SeasonGridMember[];
	cells: SeasonGridCell[];
	unavailable: { memberId: string; meetingId: string }[];
}
```

- [ ] **Step 4: Add `includeContact` to the input and select the slug**

Change the `loadSeasonGrid` signature to accept the flag:

```ts
export async function loadSeasonGrid(input: {
	clubId: string;
	count: SeasonGridCount;
	/** Include member email/phone on the member axis. Off by default so the
	 *  public sheet never carries contact PII. */
	includeContact?: boolean;
}): Promise<SeasonGridData> {
```

Extend the existing club query to also select the slug (currently `columns: { timezone: true }`):

```ts
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
		columns: { timezone: true, slug: true },
	});
	const timezone = club?.timezone ?? "UTC";
```

- [ ] **Step 5: Select contact columns and map them conditionally**

Replace the active-member query + mapping (currently selects `id/name/status` and maps `memberRows` to `{ id, name }`). Always select the contact columns (a negligible cost on rows already fetched); only place them on the returned objects when `includeContact` is set — so the gate lives in the returned shape:

```ts
	const allMemberRows = await db
		.select({
			id: members.id,
			name: members.name,
			status: members.status,
			email: members.email,
			phone: members.phone,
		})
		.from(members)
		.where(eq(members.clubId, input.clubId))
		.orderBy(asc(members.name));
	const memberRows: SeasonGridMember[] = allMemberRows
		.filter((m) => m.status !== "inactive")
		.map((m) =>
			input.includeContact
				? { id: m.id, name: m.name, email: m.email, phone: m.phone }
				: { id: m.id, name: m.name },
		);
	const memberNames: SeasonGridMember[] = allMemberRows.map((m) => ({
		id: m.id,
		name: m.name,
	}));
```

(`memberNames` stays name-only — the roles orientation never needs contact.)

- [ ] **Step 6: Return `clubSlug`**

Add `clubSlug` to the returned object (the `return { … }` at the end of `loadSeasonGrid`):

```ts
	return {
		clubSlug: club?.slug ?? null,
		meetings: gridMeetings,
		rows,
		members: memberRows,
		memberNames,
		guestNames,
		cells,
		unavailable,
	};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts`
Expected: all tests PASS (the 3 pre-existing + the 3 new).

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (`SeasonGridData` now requires `clubSlug`; the only constructor is `loadSeasonGrid`, so nothing else should break.)

- [ ] **Step 9: Commit**

```bash
git add src/server/season-grid-logic.ts src/server/season-grid.integration.test.ts
git commit -m "feat(season-grid): loadSeasonGrid can include member contact + returns clubSlug"
```

---

## Task 2: Gate the server fns

**Files:**
- Modify: `src/server/season-grid.ts`

- [ ] **Step 1: Pass `includeContact` from each server fn**

In `src/server/season-grid.ts`, update the two handlers. The authed one includes contact; the public one explicitly does not:

```ts
export const getSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) => seasonGridInput.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubViewAccess(user.id, data.clubId);
		return loadSeasonGrid({ ...data, includeContact: true });
	});

export const getPublicSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) => seasonGridInput.parse(input))
	.handler(async ({ data }) => loadSeasonGrid({ ...data, includeContact: false }));
```

- [ ] **Step 2: Run the server-module guard + typecheck**

Run: `bunx vitest run src/server/server-modules.guard.test.ts && bun run typecheck`
Expected: guard test PASSES (season-grid.ts still exports only server fns + types) and typecheck is clean.

- [ ] **Step 3: Commit**

```bash
git add src/server/season-grid.ts
git commit -m "feat(season-grid): gate member contact to the authed grid fn"
```

---

## Task 3: Email/Phone columns in the grid

**Files:**
- Modify: `src/components/club/season-grid.tsx`

- [ ] **Step 1: Add the `showContact` prop**

In `src/components/club/season-grid.tsx`, add `showContact` to the destructured props and the prop type. Add it after `clubSlug` in both places:

```ts
	clubSlug,
	showContact = false,
	onOrientationChange,
```

and in the type block:

```ts
	/** Club slug — when set (public club shell), meeting links … target the
	 *  public meeting view instead of `/meetings/$id`. */
	clubSlug?: string;
	/** Show member Email/Phone columns (Members × Meetings, signed-in only). */
	showContact?: boolean;
	onOrientationChange?: (o: Orientation) => void;
```

- [ ] **Step 2: Build the contact lookup**

Near the top of the component body (e.g. just after `const rows = projectGrid(data, orientation);`), add:

```ts
	// Members × Meetings contact columns (signed-in only) resolve email/phone
	// off the member axis; role rows have no memberId and never render these.
	const showContactCols = orientation === "members" && showContact;
	const contactByMember = new Map(data.members.map((m) => [m.id, m]));
```

- [ ] **Step 3: Add the header cells**

In the header `<tr>`, immediately after the `{data.meetings.map((m) => { … })}` block closes and before `</tr>`, add:

```tsx
							{showContactCols ? (
								<>
									<th className="sticky top-0 bg-card px-3 py-2 text-left text-xs font-semibold">
										Email
									</th>
									<th className="sticky top-0 bg-card px-3 py-2 text-left text-xs font-semibold">
										Phone
									</th>
								</>
							) : null}
```

- [ ] **Step 4: Add the body cells**

Inside `rows.map((row) => { … })`, add a `contact` lookup alongside the other per-row consts (e.g. right after the `tdClass` definition):

```ts
								const contact = row.memberId
									? contactByMember.get(row.memberId)
									: undefined;
```

Then, inside the `<tr>`, immediately after the `{row.cells.map((cell, i) => { … })}` block closes and before `</tr>`, add:

```tsx
										{showContactCols ? (
											<>
												<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
													{contact?.email ? (
														<a
															href={`mailto:${contact.email}`}
															className="text-primary hover:underline"
														>
															{contact.email}
														</a>
													) : (
														<span className="text-muted-foreground">—</span>
													)}
												</td>
												<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
													{contact?.phone ? (
														<a
															href={`tel:${contact.phone}`}
															className="text-primary hover:underline"
														>
															{contact.phone}
														</a>
													) : (
														<span className="text-muted-foreground">—</span>
													)}
												</td>
											</>
										) : null}
```

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run check`
Expected: no type errors; Biome passes (fix formatting if it rewrites — re-run until clean).

- [ ] **Step 6: Commit**

```bash
git add src/components/club/season-grid.tsx
git commit -m "feat(season-grid): Email/Phone columns in Members × Meetings (showContact)"
```

---

## Task 4: Wire `/schedule` — show contact + share button

**Files:**
- Modify: `src/routes/_authed/schedule.tsx`

- [ ] **Step 1: Import `ShareLinkButton`**

Add to the imports at the top of `src/routes/_authed/schedule.tsx`:

```ts
import { ShareLinkButton } from "#/components/share-link-button";
```

- [ ] **Step 2: Add the share button to the header and pass `showContact`**

Replace the `<h1>Sign-up sheet</h1>` line with a header row that keeps the title and adds the copy-link button (only when the slug is known), and add `showContact` to the `<SeasonGrid>` props:

```tsx
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Sign-up sheet
				</h1>
				{data?.clubSlug ? (
					<ShareLinkButton
						path={`/club/${data.clubSlug}`}
						label="Copy sign-up sheet link"
					/>
				) : null}
			</div>
```

and in the `<SeasonGrid … />` prop list add:

```tsx
					showContact
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run check`
Expected: clean. (`data` is `SeasonGridData | null`; `data?.clubSlug` narrows correctly.)

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed/schedule.tsx
git commit -m "feat(schedule): show member contact + copy public sign-up-sheet link"
```

---

## Task 5: Contact block on the member profile

**Files:**
- Modify: `src/routes/_authed/members.$id.tsx`

This is display-only — `getMemberProfile` already returns `member.email`/`member.phone` (the Edit dialog uses them) and the route is `_authed`, so it is already gated.

- [ ] **Step 1: Import the icons**

Add `Mail` and `Phone` to the existing `lucide-react` import (currently `Archive, ArchiveRestore, CalendarPlus, ChevronLeft, ShieldCheck`):

```ts
import {
	Archive,
	ArchiveRestore,
	CalendarPlus,
	ChevronLeft,
	Mail,
	Phone,
	ShieldCheck,
} from "lucide-react";
```

- [ ] **Step 2: Render the contact block**

In `MemberDetail`, inside the header container `<div className="min-w-[220px] flex-1">`, immediately after the `mt-1.5 flex flex-wrap items-center gap-2.5` div (the one holding tenure/badges) closes and before that container's closing `</div>`, add:

```tsx
						{member.email || member.phone ? (
							<div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--sea-ink-soft)]">
								{member.email ? (
									<a
										href={`mailto:${member.email}`}
										className="inline-flex items-center gap-1.5 hover:text-[var(--sea-ink)] hover:underline"
									>
										<Mail className="size-3.5" aria-hidden />
										{member.email}
									</a>
								) : null}
								{member.phone ? (
									<a
										href={`tel:${member.phone}`}
										className="inline-flex items-center gap-1.5 hover:text-[var(--sea-ink)] hover:underline"
									>
										<Phone className="size-3.5" aria-hidden />
										{member.phone}
									</a>
								) : null}
							</div>
						) : null}
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run check`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed/members.$id.tsx
git commit -m "feat(members): show member contact on the profile header"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full gate check**

Run: `bun run check && bun run typecheck && TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts src/server/server-modules.guard.test.ts`
Expected: Biome clean, typecheck clean, all listed tests PASS.

- [ ] **Step 2: Manual verification in the app**

Start dev (`bun run dev`) and confirm end-to-end (use the `/run` or `/browse` skill / dev-login for the authed views):
  - `/schedule` in **Members × Meetings** shows Email + Phone columns; `mailto:`/`tel:` links work; `—` shows for the blank phone. **Roles × Meetings** shows **no** contact columns.
  - The **"Copy sign-up sheet link"** button copies `<origin>/club/<slug>`.
  - The public sheet at `/club/<slug>` shows **no** contact anywhere (view source / network: the `getPublicSeasonGrid` payload has no `email`/`phone`).
  - A member profile at `/members/<id>` shows the contact block (email/phone links) under the name.

- [ ] **Step 3: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open the PR (or per the repo's ship flow).

---

## Notes for the implementer

- **Test DB:** `tm_test` lives in the `dev-postgres` Docker container; `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test`. No schema change here, so **do not** run `db:push`/`db:migrate`.
- **Only `bun run typecheck` type-checks** — `build`/`test` transpile without checking. Run it before claiming green.
- **Server-module boundary:** keep `season-grid.ts` exporting only `createServerFn`s + types (db logic stays in `season-grid-logic.ts`) — the guard test enforces it.
- **Do not** add contact to `memberNames` or `guestNames`, or to the Roles × Meetings orientation.
