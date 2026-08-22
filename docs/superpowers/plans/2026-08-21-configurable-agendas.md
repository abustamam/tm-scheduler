# Configurable Agendas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a club officer edit a templated meeting's agenda — add, remove, reorder, retime and rename rows, set timing marks, and bind rows to roles including roles they create — without affecting any other meeting.

**Architecture:** Applying a template deep-copies it into a *private* `meeting_templates` row owned by the club and marked with `meeting_id`. Editing a meeting's agenda is editing that private copy. No new tables: `meeting_templates` / `meeting_template_roles` / `meeting_template_beats` already admit club-scoped rows, and `loadTemplateContent` / `resolveAgendaRows` / `roleDefScope` keep working because a private template id is just another template id.

**Tech Stack:** TanStack Start (React 19, file-based routing), Drizzle ORM on Postgres via node-postgres, Vitest, Biome, TypeScript strict. Package manager Bun.

**Spec:** `docs/superpowers/specs/2026-08-21-configurable-agendas-design.md`

## Global Constraints

- **Worktree only.** Never edit or commit in the main checkout. Bootstrap with `bun run worktree:setup "<task>"`.
- **Import alias is `#/*` → `src/*`.** Biome formats with **tabs** and **double quotes**, import organization on.
- **Server-fn modules export only `createServerFn`s and types.** All db logic goes in a sibling `*-logic.ts`; `server-modules.guard.test.ts` enforces it. A handler body is unreachable from vitest.
- **Every write gates**: `requireMeetingTemplateEditor` (already in `src/server/meeting-templates.ts:38`) does `requireUser` + `assertClubNotArchived` + `requireClubRole(["admin"])`. Reuse it. Never the self-asserted TMOD arm.
- **`assertMeetingNotLocked(status)`** before any agenda mutation, and refuse `cancelled` the way `applyTemplateConversion` does.
- **Integration tests need a database or they silently SKIP.** Always run with `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"`. Port **5433** on this machine, not 5432.
- **Browser-backed suites need `CHROME_PATH`** or they skip locally and fail in CI:
  `CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"`
- **Absolute assertions, never relative to the constant under test.** `expect(x).toBeLessThanOrEqual(CAP)` passes for every value of `CAP`.
- **Read the lint gate as `bunx biome check --diagnostic-level=error src/ scripts/`** — `src/db/seed.ts` carries ~118 pre-existing warnings that bury real errors.
- **`bun run typecheck` is the only thing that type-checks.** Build and test both transpile without checking.
- **Do not run `bun run build`** — it appends a block to the tracked `src/routeTree.gen.ts`. Use `bun run generate-routes` when a route is added.
- **Caps live in `src/lib/meeting-template-limits.ts`** and are imported by renderers, never redefined.

---

### Task 1: The private-template marker and its indexes

**Files:**
- Modify: `src/db/schema.ts` (the `meetingTemplates` table, currently ~line 953)
- Create: `drizzle/<generated>.sql` (via `db:generate` — do not hand-write)
- Test: `src/db/template-schema.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `meetingTemplates.meetingId` (`uuid | null`, FK → `meetings.id` ON DELETE CASCADE). Indexes `meeting_templates_club_key_unique` (predicate now `club_id is not null and meeting_id is null`) and `meeting_templates_meeting_unique` (`(meeting_id) where meeting_id is not null`).

- [ ] **Step 1: Write the failing test**

Append to `src/db/template-schema.integration.test.ts`, inside the existing top-level `describe`:

```ts
	it("lets two meetings in one club each hold a private copy of the same key", async () => {
		// The shared-template unique index is on (club_id, key). Two contest
		// meetings both copying `speech_contest` would collide on it, so its
		// predicate must exempt private rows.
		const [a, b] = await testDb
			.insert(meetings)
			.values([
				{ clubId: club.clubId, scheduledAt: new Date("2027-01-07T02:00:00Z") },
				{ clubId: club.clubId, scheduledAt: new Date("2027-01-21T02:00:00Z") },
			])
			.returning({ id: meetings.id });
		if (!a || !b) throw new Error("meeting insert failed");

		const rows = await testDb
			.insert(meetingTemplates)
			.values([
				{ clubId: club.clubId, meetingId: a.id, key: `copy_${RUN}`, name: "A" },
				{ clubId: club.clubId, meetingId: b.id, key: `copy_${RUN}`, name: "B" },
			])
			.returning({ id: meetingTemplates.id });
		expect(rows).toHaveLength(2);
	});

	it("allows at most ONE private template per meeting", async () => {
		const [m] = await testDb
			.insert(meetings)
			.values({ clubId: club.clubId, scheduledAt: new Date("2027-02-04T02:00:00Z") })
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");

		await testDb.insert(meetingTemplates).values({
			clubId: club.clubId,
			meetingId: m.id,
			key: `one_${RUN}`,
			name: "First",
		});
		await expect(
			testDb.insert(meetingTemplates).values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `two_${RUN}`,
				name: "Second",
			}),
		).rejects.toThrow();
	});

	it("cascade-deletes a private template when its meeting goes", async () => {
		// `recurrence-rule-logic.ts:162` really does delete meetings, so an
		// orphaned private template is not theoretical.
		const [m] = await testDb
			.insert(meetings)
			.values({ clubId: club.clubId, scheduledAt: new Date("2027-03-04T02:00:00Z") })
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `cascade_${RUN}`,
				name: "Doomed",
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");

		await testDb.delete(meetings).where(eq(meetings.id, m.id));
		const left = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, t.id));
		expect(left).toEqual([]);
	});
```

If `RUN`, `meetings` or `eq` are not already in that file's scope, add them: `RUN` is the per-run suffix idiom (`const RUN = Math.random().toString(36).slice(2, 8)` if absent), `meetings` to the `#/db/schema` import, `eq` to the `drizzle-orm` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/db/template-schema.integration.test.ts`
Expected: FAIL — the first case errors on a duplicate key, and `meetingId` does not exist on the insert type.

- [ ] **Step 3: Add the column and change the indexes**

In `src/db/schema.ts`, inside `meetingTemplates`, after the `clubId` column:

```ts
		// Non-null = this row is ONE MEETING's private copy, not a template
		// anyone picks. Conversion deep-copies the chosen template into a row
		// like this so editing one night's agenda never touches another's.
		// CASCADE because meetings really are deleted (`recurrence-rule-logic.ts`
		// prunes pristine ones), and an orphaned private template would be a row
		// nothing can ever reach or clean up.
		meetingId: uuid("meeting_id").references(() => meetings.id, {
			onDelete: "cascade",
		}),
```

Then replace the club-key index and add the per-meeting one:

```ts
		// Predicate excludes private copies: two contest meetings in one club
		// both copy `speech_contest`, and without `meeting_id is null` the second
		// conversion would fail on this index.
		uniqueIndex("meeting_templates_club_key_unique")
			.on(t.clubId, t.key)
			.where(sql`${t.clubId} is not null and ${t.meetingId} is null`),
		// One private template per meeting, enforced at the database rather than
		// by the one code path that currently creates them.
		uniqueIndex("meeting_templates_meeting_unique")
			.on(t.meetingId)
			.where(sql`${t.meetingId} is not null`),
```

- [ ] **Step 4: Generate and apply the migration**

```bash
bun run db:generate
```

Read the generated SQL. It MUST contain a `DROP INDEX`/`CREATE UNIQUE INDEX` pair for `meeting_templates_club_key_unique` — a bare `CREATE` means the predicate change was not detected and the migration is wrong.

```bash
DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bun run db:migrate
```

- [ ] **Step 5: Verify the index predicate actually changed**

**`db:push` does NOT update a partial index's `WHERE` predicate on an index that already exists.** This repo lost time to exactly this on `role_definitions_club_key_unique`, where `db:push` left the old predicate in place while creating the new sibling beside it, so the test database enforced a constraint the schema no longer declared.

```bash
docker exec -i $(docker ps --filter publish=5433 --format '{{.Names}}') \
  psql -U dev -d tm_test -c \
  "select indexname, indexdef from pg_indexes where indexname like 'meeting_templates%';"
```

Expected: `meeting_templates_club_key_unique` shows `WHERE ((club_id IS NOT NULL) AND (meeting_id IS NULL))`, and `meeting_templates_meeting_unique` exists. If the predicate is stale, `DROP INDEX meeting_templates_club_key_unique;` and re-run `db:migrate`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/db/template-schema.integration.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle/ src/db/template-schema.integration.test.ts
git commit -m "feat(templates): add the private-per-meeting template marker

A nullable meeting_templates.meeting_id, CASCADE from meetings. The
club-key unique index gains 'and meeting_id is null' so two contest
meetings in one club can each copy the same template, and a new partial
unique index on meeting_id enforces one private copy per meeting at the
database rather than in the single code path that makes them."
```

---

### Task 2: Private copies stay out of the picker

**Files:**
- Modify: `src/server/meeting-templates-logic.ts:61-80` (`listAvailableTemplates`)
- Test: `src/server/meeting-templates-logic.integration.test.ts`

**Interfaces:**
- Consumes: `meetingTemplates.meetingId` (Task 1).
- Produces: `listAvailableTemplates(clubId)` returns only pickable templates — unchanged signature.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("listAvailableTemplates", …)`:

```ts
		it("omits a meeting's private copy", async () => {
			// A private copy is a meeting's own agenda, not something another
			// meeting may be converted to. It is an ordinary template in every
			// other respect, which is why the picker has to exclude it explicitly.
			const [m] = await testDb
				.insert(meetings)
				.values({ clubId: club.clubId, scheduledAt: new Date("2027-04-01T02:00:00Z") })
				.returning({ id: meetings.id });
			if (!m) throw new Error("meeting insert failed");
			await testDb.insert(meetingTemplates).values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `private_${RUN}`,
				name: `Private ${RUN}`,
			});

			const rows = await listAvailableTemplates(club.clubId);
			expect(rows.map((r) => r.name)).not.toContain(`Private ${RUN}`);
		});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-templates-logic.integration.test.ts -t "omits a meeting's private copy"`
Expected: FAIL — the private row is listed.

- [ ] **Step 3: Add the predicate**

In `listAvailableTemplates`, inside the existing `and(...)`, after `eq(meetingTemplates.enabled, true)`:

```ts
				// Private per-meeting copies are agendas, not choices. Excluded in
				// the QUERY rather than by a caller's `.filter()`, for the same
				// reason the tenant predicate is: a filter is droppable in a
				// refactor with every test still green.
				isNull(meetingTemplates.meetingId),
```

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-templates-logic.integration.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/meeting-templates-logic.ts src/server/meeting-templates-logic.integration.test.ts
git commit -m "feat(templates): keep private per-meeting copies out of the picker"
```

---

### Task 3: Conversion deep-copies into a private template

**Files:**
- Modify: `src/server/meeting-templates-logic.ts` (add `copyTemplateForMeeting`, change `applyTemplateConversion`)
- Test: `src/server/meeting-template-convert.integration.test.ts`

**Interfaces:**
- Consumes: `meetingTemplates.meetingId` (Task 1).
- Produces: `copyTemplateForMeeting(conn: DbOrTx, input: { sourceTemplateId: string; clubId: string; meetingId: string }): Promise<string>` — returns the new private template's id. `applyTemplateConversion` now points `meetings.template_id` at a private copy and deletes it on revert.

- [ ] **Step 1: Write the failing test**

Add to `src/server/meeting-template-convert.integration.test.ts`:

```ts
	it("points the meeting at a PRIVATE copy, not the shared template", async () => {
		const source = await seedGlobalContest();
		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId: source,
			actorMemberId: null,
		});

		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		expect(m?.templateId).not.toBe(source);

		const [copy] = await testDb
			.select({
				meetingId: meetingTemplates.meetingId,
				clubId: meetingTemplates.clubId,
			})
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, m?.templateId ?? ""));
		expect(copy?.meetingId).toBe(club.meetingId);
		expect(copy?.clubId).toBe(club.clubId);
	});

	it("copies the source's beats and roles verbatim", async () => {
		const source = await seedGlobalContest();
		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId: source,
			actorMemberId: null,
		});
		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));

		const srcBeats = await testDb
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, source));
		const copyBeats = await testDb
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, m?.templateId ?? ""));
		expect(copyBeats).toHaveLength(srcBeats.length);
		expect(copyBeats.map((b) => b.label).sort()).toEqual(
			srcBeats.map((b) => b.label).sort(),
		);
	});

	it("gives two meetings independent copies of one template", async () => {
		// The whole point: editing one night's agenda must not reach another's.
		const source = await seedGlobalContest();
		const [second] = await testDb
			.insert(meetings)
			.values({ clubId: club.clubId, scheduledAt: new Date("2027-05-06T02:00:00Z") })
			.returning({ id: meetings.id });
		if (!second) throw new Error("meeting insert failed");

		for (const id of [club.meetingId, second.id]) {
			await applyTemplateConversion({
				meetingId: id,
				clubId: club.clubId,
				templateId: source,
				actorMemberId: null,
			});
		}
		const rows = await testDb
			.select({ id: meetings.id, templateId: meetings.templateId })
			.from(meetings)
			.where(inArray(meetings.id, [club.meetingId, second.id]));
		const ids = rows.map((r) => r.templateId);
		expect(new Set(ids).size).toBe(2);
	});

	it("deletes the private copy when the meeting goes back to standard", async () => {
		const source = await seedGlobalContest();
		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId: source,
			actorMemberId: null,
		});
		const [before] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		const privateId = before?.templateId ?? "";

		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId: null,
			actorMemberId: null,
		});

		const left = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, privateId));
		expect(left).toEqual([]);
		// And the SOURCE survives — reverting one meeting must not retire the
		// template every other meeting picks from.
		const src = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, source));
		expect(src).toHaveLength(1);
	});
```

`seedGlobalContest()` is this file's existing helper that inserts a global template with roles and beats and returns its id; if it is named differently in the file, use that name. Ensure `inArray` is imported from `drizzle-orm`.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-template-convert.integration.test.ts`
Expected: FAIL — `templateId` still equals the source id.

- [ ] **Step 3: Add `copyTemplateForMeeting`**

In `src/server/meeting-templates-logic.ts`, after `materializeTemplateRoles`:

```ts
/**
 * Deep-copy a template into a PRIVATE row owned by one meeting, and return the
 * copy's id.
 *
 * This is what makes an agenda editable: the meeting points at content nobody
 * else reads, so removing a row from one contest cannot remove it from the next
 * one, and "save this shape as a template" later is a promotion (clear
 * `meeting_id`) rather than a second mechanism.
 *
 * The copy keeps the SOURCE's `key`. It is unique per meeting via
 * `meeting_templates_meeting_unique`, and the club-key index exempts private
 * rows, so the key here is provenance rather than identity — it is how you can
 * still tell what a meeting was built from after it has been edited.
 */
export async function copyTemplateForMeeting(
	conn: DbOrTx,
	input: { sourceTemplateId: string; clubId: string; meetingId: string },
): Promise<string> {
	const { sourceTemplateId, clubId, meetingId } = input;
	const [source] = await conn
		.select()
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, sourceTemplateId))
		.limit(1);
	if (!source) throw new Error("That meeting template no longer exists.");

	const [copy] = await conn
		.insert(meetingTemplates)
		.values({
			clubId,
			meetingId,
			key: source.key,
			name: source.name,
			description: source.description,
			defaultLengthMinutes: source.defaultLengthMinutes,
			sortOrder: source.sortOrder,
			enabled: source.enabled,
		})
		.returning({ id: meetingTemplates.id });
	if (!copy) throw new Error("Failed to copy the meeting template.");

	const roles = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, sourceTemplateId));
	if (roles.length > 0) {
		await conn.insert(meetingTemplateRoles).values(
			roles.map((r) => ({
				templateId: copy.id,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		);
	}

	const beats = await conn
		.select()
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, sourceTemplateId));
	if (beats.length > 0) {
		await conn.insert(meetingTemplateBeats).values(
			beats.map((b) => ({
				templateId: copy.id,
				sortOrder: b.sortOrder,
				kind: b.kind,
				label: b.label,
				detail: b.detail,
				minutes: b.minutes,
				roleKey: b.roleKey,
				repeatsRoleKey: b.repeatsRoleKey,
				flex: b.flex,
				markGreen: b.markGreen,
				markYellow: b.markYellow,
				markRed: b.markRed,
			})),
		);
	}

	return copy.id;
}
```

- [ ] **Step 4: Wire it into `applyTemplateConversion`**

Inside the transaction, replace the materialization step. The existing code is:

```ts
		if (templateId !== null) {
			await materializeTemplateRoles(tx, clubId, templateId);
		}
		const defs = await resolveMeetingRoleDefs(tx, clubId, templateId);
```

Replace with:

```ts
		// The meeting's CURRENT private template, if it has one — captured before
		// we repoint, because that is what we must delete afterwards.
		const [before] = await tx
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.limit(1);
		const previousPrivateId = before?.templateId
			? ((
					await tx
						.select({ id: meetingTemplates.id })
						.from(meetingTemplates)
						.where(
							and(
								eq(meetingTemplates.id, before.templateId),
								eq(meetingTemplates.meetingId, meetingId),
							),
						)
						.limit(1)
				)[0]?.id ?? null)
			: null;

		// Deep-copy so this meeting's agenda is its own. Re-converting makes a
		// FRESH copy, which is what keeps an edited contest from leaking into the
		// next one.
		const effectiveTemplateId =
			templateId === null
				? null
				: await copyTemplateForMeeting(tx, {
						sourceTemplateId: templateId,
						clubId,
						meetingId,
					});

		if (effectiveTemplateId !== null) {
			await materializeTemplateRoles(tx, clubId, effectiveTemplateId);
		}
		const defs = await resolveMeetingRoleDefs(tx, clubId, effectiveTemplateId);
```

Then, in the remainder of the transaction, replace every later use of `templateId` with `effectiveTemplateId` — specifically the `length` lookup and the `meetings` update:

```ts
		const length =
			effectiveTemplateId === null
				? null
				: ((
						await tx
							.select({ m: meetingTemplates.defaultLengthMinutes })
							.from(meetingTemplates)
							.where(eq(meetingTemplates.id, effectiveTemplateId))
							.limit(1)
					)[0]?.m ?? null);

		await tx
			.update(meetings)
			.set({
				templateId: effectiveTemplateId,
				...(length != null ? { lengthMinutes: length } : {}),
			})
			.where(eq(meetings.id, meetingId));

		// Delete the copy we just replaced. AFTER the update, because
		// `meetings.template_id` is ON DELETE RESTRICT and still points at it
		// until then. Cascades to its own roles and beats.
		if (previousPrivateId !== null && previousPrivateId !== effectiveTemplateId) {
			await tx
				.delete(meetingTemplates)
				.where(eq(meetingTemplates.id, previousPrivateId));
		}
```

Leave the `logActivity` `detail` as `{ templateId }` — the SOURCE id is the meaningful thing in an audit feed; add the copy beside it:

```ts
			detail: { templateId, privateTemplateId: effectiveTemplateId },
```

Note `planTemplateConversion` (the preview) is deliberately unchanged: it must not write, and it already reads the SOURCE template's own rows when nothing is materialized.

- [ ] **Step 5: Run the tests**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-template-convert.integration.test.ts src/server/meeting-templates-logic.integration.test.ts`
Expected: PASS. If an existing case asserts `meetings.templateId === <source id>`, it is asserting the old contract — update it to assert the private copy's `meetingId` instead, and say so in the commit.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/server/meeting-templates-logic.ts src/server/meeting-template-convert.integration.test.ts
git commit -m "feat(templates): deep-copy a template into a private per-meeting row

Converting a meeting now copies the chosen template's row, roles and
beats into a private copy marked with meeting_id, and points the meeting
at that. Reverting deletes the copy; re-converting makes a fresh one, so
an edited contest never leaks into the next meeting that picks the same
template."
```

---

### Task 4: An empty agenda is a legal state

**Files:**
- Modify: `src/server/meeting-templates-logic.ts:145-157` (`loadTemplateContent`)
- Test: `src/server/meeting-templates-logic.integration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadTemplateContent(templateId)` returns `{ beats: [], roles: [] }` for a template row that exists but is empty, and `null` only when no such row exists.

- [ ] **Step 1: Write the failing test**

```ts
	it("returns an EMPTY agenda for a template with no rows, not null", async () => {
		// The editor can delete the last row, and building an agenda up from
		// nothing is a legitimate state. Today "no beats and no roles" is read as
		// "no such template", which makes `meetings.ts` throw
		// "references template X, which has no beats or roles" and takes the
		// meeting page down.
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({ clubId: club.clubId, key: `empty_${RUN}`, name: `Empty ${RUN}` })
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");

		const content = await loadTemplateContent(t.id);
		expect(content).toEqual({ beats: [], roles: [] });
	});

	it("returns null for a template id that does not exist", async () => {
		expect(
			await loadTemplateContent("00000000-0000-0000-0000-000000000000"),
		).toBeNull();
	});
```

Add `loadTemplateContent` to this file's import from `./meeting-templates-logic`.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-templates-logic.integration.test.ts -t "EMPTY agenda"`
Expected: FAIL — `expected null to deeply equal { beats: [], roles: [] }`.

- [ ] **Step 3: Replace the shortcut with a real existence check**

```ts
export async function loadTemplateContent(
	templateId: string,
): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null> {
	// THREE reads in parallel, not two. The existence check used to be inferred
	// from "both empty", which was free — but the editor can legitimately empty a
	// template, and inferring absence from emptiness turns "I deleted my last
	// row" into `meetings.ts` throwing and the meeting page going down. A third
	// parallel round trip adds no latency to `loadMeetingDetail`'s critical path,
	// which is what the old comment was protecting.
	const [beats, roles, exists] = await Promise.all([
		loadTemplateBeats(templateId),
		loadTemplateRoles(templateId),
		database
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, templateId))
			.limit(1),
	]);
	if (exists.length === 0) return null;
	return { beats, roles };
}
```

- [ ] **Step 4: Check the meeting-detail caller still behaves**

`src/server/meetings.ts:327-332` throws when `loadTemplateContent` returns null. That stays correct — a null now means the FK points at a row that does not exist, which really is corruption. Read those lines and confirm the message still reads truthfully; if it says "has no beats or roles", change it to:

```ts
			throw new Error(
				`Meeting ${meeting.id} references template ${meeting.templateId}, which does not exist.`,
			);
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/meeting-templates-logic.ts src/server/meetings.ts src/server/meeting-templates-logic.integration.test.ts
git commit -m "fix(templates): an empty agenda is a legal state, not a missing template

loadTemplateContent inferred absence from emptiness, so an officer who
deleted the last row would have taken the meeting page down with a
thrown 'has no beats or roles'. It now checks the row exists."
```

---

### Task 5: "Once" vs "per holder", and the double-printed tally

**Files:**
- Modify: `src/lib/agenda-template-rows.ts:180-200` (the non-repeating role-beat branch of `buildTemplateRows`)
- Modify: `src/lib/contest-template.ts` (bind Tallying and the timers' report back to their real owners)
- Test: `src/lib/agenda-template-rows.test.ts`, `src/lib/contest-template.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildTemplateRows` emits ONE row for a role beat with `repeatsRoleKey === null`, naming every holder; a beat repeats per holder only when it is in a repeat block. No schema change — `repeats_role_key` already *is* the per-holder flag, since a block needs it to name the role for rows that own none (the ballot minute).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/agenda-template-rows.test.ts`:

```ts
	it("emits ONE row for a non-repeating role beat, naming every holder", () => {
		// A non-repeating role beat used to emit one row PER SLOT, so "Tallying"
		// on a two-slot ballot_counter printed twice at ten minutes each — twenty
		// minutes for one joint activity, on the clock the chair runs the night
		// from. Repeating is what `repeatsRoleKey` is for; a plain role beat is
		// one activity however many people hold the role.
		const beats: TemplateBeatRow[] = [
			beat({ kind: "role", label: "Tallying", roleKey: "counter", minutes: 10 }),
		];
		const roles: TemplateRoleRow[] = [
			{ key: "counter", name: "Ballot Counter", isSpeakerRole: false },
		];
		const rows = buildTemplateRows(beats, roles, [
			slot({ roleKey: "counter", slotIndex: 0, assigneeName: "Ada" }),
			slot({ roleKey: "counter", slotIndex: 1, assigneeName: "Grace" }),
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.who).toBe("Tallying · Ada and Grace");
		expect(rows[0]?.holder).toBe("Ada and Grace");
		expect(rows[0]?.minutes).toBe(10);
	});

	it("still repeats a beat that declares repeatsRoleKey", () => {
		const beats: TemplateBeatRow[] = [
			beat({
				kind: "role",
				label: "Speech",
				roleKey: "speaker",
				repeatsRoleKey: "speaker",
				minutes: 7,
			}),
		];
		const roles: TemplateRoleRow[] = [
			{ key: "speaker", name: "Contestant", isSpeakerRole: true },
		];
		const rows = buildTemplateRows(beats, roles, [
			slot({ roleKey: "speaker", slotIndex: 0, assigneeName: "Ada" }),
			slot({ roleKey: "speaker", slotIndex: 1, assigneeName: "Grace" }),
		]);
		expect(rows.map((r) => r.who)).toEqual([
			"Speech 1 · Ada",
			"Speech 2 · Grace",
		]);
	});
```

Use the file's existing `beat(...)` and `slot(...)` fixture helpers; if it has none, build the literals inline matching `TemplateBeatRow` and `AgendaSlot`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-template-rows.test.ts`
Expected: FAIL — `expected length 1, got 2`.

- [ ] **Step 3: Bind every holder onto one row**

In `src/lib/agenda-template-rows.ts`, add above `toRow`:

```ts
/** "Ada", "Ada and Grace", "Ada, Grace and Alan" — one beat, several holders. */
function joinHolders(names: string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}
```

Change `toRow`'s signature to take the slots it is bound to rather than one slot:

```ts
function toRow(
	row: TemplateBeatRow,
	rolesByKey: Map<string, TemplateRoleRow>,
	bound: AgendaSlot[],
	index: number,
	total: number,
): AgendaRow | null {
```

and inside it, replace the holder derivation:

```ts
	const numberedLabel = numbered(label, index, total > 1);
	const names = bound
		.map((s) => assigneeDisplay(s))
		.filter((n): n is string => n != null && n !== "");
	const holder = names.length > 0 ? joinHolders(names) : null;
```

Then in `buildTemplateRows`, replace the non-repeating role-beat branch:

```ts
		if (row.repeatsRoleKey == null) {
			if (row.kind === "role" && row.roleKey != null) {
				// ONE row per beat. Every holder of the role is named on it; the
				// beat repeats per holder only when it says so via repeatsRoleKey.
				const owned = slotsForRole(slots, row.roleKey);
				const emitted = toRow(row, rolesByKey, owned, 0, 0);
				if (emitted) out.push(emitted);
			} else {
				const emitted = toRow(row, rolesByKey, [], 0, 0);
				if (emitted) out.push(emitted);
			}
			i += 1;
			continue;
		}
```

and in the repeat-block loop, pass a single-element array:

```ts
				const bound = blockRow.roleKey === repeatKey ? [s] : [];
				const emitted = toRow(blockRow, rolesByKey, bound, n, repeated.length);
```

Update the doc comment above `buildTemplateRows`, which currently states the opposite ("A NON-repeating role beat emits one row per slot … Binding only the first slot would silently drop the second Ballot Counter"). Replace that paragraph with:

```
 * A NON-repeating role beat emits ONE row, naming every holder of its role.
 * It used to emit one row per slot, which was right for a roster and wrong for
 * a run of show: two ballot counters perform one tally together, and printing
 * it twice booked twice the minutes.
```

- [ ] **Step 4: Bind the contest's two beats back to their owners**

In `src/lib/contest-template.ts`, now that a role beat prints once:

```ts
		beat({
			kind: "role",
			label: "Tallying",
			roleKey: "ballot_counter",
			minutes: 10,
			detail:
				"Ballots are counted and verified with the Chief Judge, out of the room.",
		}),
		beat({
			kind: "role",
			label: "Timers' report",
			roleKey: "contest_timer",
			minutes: 3,
			detail: "Reports each contestant's time and confirms who qualified.",
		}),
```

and delete the header block that begins `TALLYING AND THE TIMERS' REPORT OWN NO ROLE, deliberately and temporarily` — it documents a workaround this task removes.

- [ ] **Step 5: Update the contest template's own expectations**

In `src/lib/contest-template.test.ts`, the case `prints the tally and the timers' report once each` still asserts one row of each — correct and unchanged. Add to it:

```ts
		// And they are OWNED now, not anonymous events: the fix is the renderer's,
		// so the beats no longer have to dodge multi-slot roles.
		const tally = rows.find((r) => r.who.startsWith("Tallying"));
		expect(tally?.roleKey).toBe("ballot_counter");
		const report = rows.find((r) => r.who.startsWith("Timers' report"));
		expect(report?.roleKey).toBe("contest_timer");
```

The `gives every role beat at least one slot at default counts` case now also covers these two, which is the point.

- [ ] **Step 6: Run the affected suites**

Run:
```bash
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"
bunx vitest run src/lib/agenda-template-rows.test.ts src/lib/contest-template.test.ts src/lib/agenda-template-slides.test.ts src/lib/agenda-parity.test.ts src/components/agenda/print-density.test.tsx
```
Expected: PASS. The row count at four contestants stays 21 (two beats moved between `event` and `role`, none added or removed), so `print-density.test.tsx`'s `toBe(21)` still holds. If it does not, the beat list changed — reconcile before proceeding rather than adjusting the number.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agenda-template-rows.ts src/lib/agenda-template-rows.test.ts src/lib/contest-template.ts src/lib/contest-template.test.ts
git commit -m "fix(agenda): a non-repeating role beat is one row, naming every holder

It emitted one row per slot, so a two-slot ballot_counter printed
'Tallying' twice at ten minutes each. Repeating is what repeatsRoleKey
is for. The contest's tally and timers' report bind back to their real
owners, dropping the workaround that routed them around multi-slot
roles."
```

---

### Task 6: Read the draft — the editor's loader

**Files:**
- Create: `src/server/meeting-agenda-edit-logic.ts`
- Create: `src/server/meeting-agenda-edit.ts`
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: `copyTemplateForMeeting` (Task 3), `requireMeetingTemplateEditor` (existing, `src/server/meeting-templates.ts:38` — export it from that module).
- Produces:
  - `type AgendaDraftRow = { id: string; sortOrder: number; kind: "section" | "role" | "event"; label: string; detail: string | null; minutes: number; roleKey: string | null; repeatsRoleKey: string | null; markGreen: number | null; markYellow: number | null; markRed: number | null }`
  - `type AgendaDraftRole = { key: string; name: string; category: "leadership" | "speaker" | "evaluator" | "functionary"; defaultCount: number; isSpeakerRole: boolean }`
  - `type AgendaDraft = { templateId: string; templateName: string; editable: boolean; rows: AgendaDraftRow[]; roles: AgendaDraftRole[] }`
  - `loadAgendaDraft(meetingId: string): Promise<AgendaDraft | null>` — null when the meeting has no template (a standard meeting is not editable).
  - server fn `getAgendaDraft`.

- [ ] **Step 1: Write the failing test**

Create `src/server/meeting-agenda-edit-logic.integration.test.ts`:

```ts
/**
 * DB-backed tests for the per-meeting agenda editor's read side.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadAgendaDraft } = await import("./meeting-agenda-edit-logic");

const RUN = Math.random().toString(36).slice(2, 8);

describe.runIf(hasTestDb())("loadAgendaDraft", () => {
	let club: SeededClub;
	const madeTemplates: string[] = [];
	// `SeededClub` carries `adminUserId` / `memberUserId` / `memberId` (all
	// singular) and ONE meeting, ONE role definition and ONE slot — not a
	// nine-role club. Assertions written against a full roster can only fail.

	beforeEach(async () => {
		club = await seedClub();
	});

	afterEach(async () => {
		// Templates can be CLUB-LESS, and `cleanup` cascades from the club, so
		// anything global survives it. Delete only what this run created.
		for (const id of madeTemplates.splice(0)) {
			await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function givePrivateTemplate() {
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: club.meetingId,
				key: `draft_${RUN}`,
				name: `Draft ${RUN}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		madeTemplates.push(t.id);
		await testDb.insert(meetingTemplateRoles).values({
			templateId: t.id,
			key: "chair",
			name: "Chair",
			category: "leadership",
			defaultCount: 1,
			sortOrder: 10,
			isSpeakerRole: false,
		});
		await testDb.insert(meetingTemplateBeats).values([
			{ templateId: t.id, sortOrder: 0, kind: "section", label: "OPENING", minutes: 0 },
			{
				templateId: t.id,
				sortOrder: 1,
				kind: "role",
				label: "Welcome",
				roleKey: "chair",
				minutes: 5,
			},
		]);
		await testDb
			.update(meetings)
			.set({ templateId: t.id })
			.where(eq(meetings.id, club.meetingId));
		return t.id;
	}

	it("returns the meeting's own rows in sort order", async () => {
		const id = await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.templateId).toBe(id);
		expect(draft?.rows.map((r) => r.label)).toEqual(["OPENING", "Welcome"]);
		expect(draft?.roles.map((r) => r.key)).toEqual(["chair"]);
		expect(draft?.editable).toBe(true);
	});

	it("returns null for a standard meeting", async () => {
		// A meeting with no template reads the code-derived RUN_OF_SHOW and is
		// out of scope for this editor by design.
		expect(await loadAgendaDraft(club.meetingId)).toBeNull();
	});

	it("marks a completed meeting NOT editable rather than hiding it", async () => {
		// The agenda is still worth reading after the night; it just stops being
		// writable, the same lock every other mutator honours.
		await givePrivateTemplate();
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.editable).toBe(false);
		expect(draft?.rows.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts`
Expected: FAIL — `Cannot find module './meeting-agenda-edit-logic'`.

- [ ] **Step 3: Write the logic module**

Create `src/server/meeting-agenda-edit-logic.ts`:

```ts
/**
 * Per-meeting agenda editing (configurable agendas, Phase 2).
 *
 * A templated meeting owns a PRIVATE `meeting_templates` row (`meeting_id` non
 * null, created by `copyTemplateForMeeting`), so editing an agenda is editing
 * that copy and reaches no other meeting.
 *
 * A `*-logic.ts` module for the two reasons this repo documents: a top-level
 * db-touching export in a server-fn module drags `#/db` → `pg` → `Buffer` into
 * the client bundle, and a query living only inside a `createServerFn` handler
 * is unreachable from vitest — which for a module of gates is the whole ball
 * game.
 */
import { and, asc, eq } from "drizzle-orm";
import { db as database } from "#/db";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";

export type AgendaDraftRow = {
	id: string;
	sortOrder: number;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
	repeatsRoleKey: string | null;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

export type AgendaDraftRole = {
	key: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
};

export type AgendaDraft = {
	templateId: string;
	templateName: string;
	/** False once the meeting is locked. The rows still load — an agenda is
	 *  worth reading after the night, it just stops being writable. */
	editable: boolean;
	rows: AgendaDraftRow[];
	roles: AgendaDraftRole[];
};

/**
 * This meeting's editable agenda, or null when it has none.
 *
 * Null means STANDARD: a meeting with `template_id IS NULL` renders the
 * code-derived `RUN_OF_SHOW`, which this editor deliberately does not touch.
 */
export async function loadAgendaDraft(
	meetingId: string,
): Promise<AgendaDraft | null> {
	const [meeting] = await database
		.select({ templateId: meetings.templateId, status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting?.templateId) return null;

	const [tpl] = await database
		.select({ id: meetingTemplates.id, name: meetingTemplates.name })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.id, meeting.templateId),
				eq(meetingTemplates.meetingId, meetingId),
			),
		)
		.limit(1);
	// Not the meeting's OWN copy: a meeting converted before this feature still
	// points at a shared template, and editing that would rewrite it for every
	// club. Treated as not-yet-editable rather than silently editing the shared
	// row; `ensureAgendaDraft` (Task 7) upgrades it on first write.
	if (!tpl) return null;

	const [rows, roles] = await Promise.all([
		database
			.select({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
				kind: meetingTemplateBeats.kind,
				label: meetingTemplateBeats.label,
				detail: meetingTemplateBeats.detail,
				minutes: meetingTemplateBeats.minutes,
				roleKey: meetingTemplateBeats.roleKey,
				repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, tpl.id))
			.orderBy(asc(meetingTemplateBeats.sortOrder)),
		database
			.select({
				key: meetingTemplateRoles.key,
				name: meetingTemplateRoles.name,
				category: meetingTemplateRoles.category,
				defaultCount: meetingTemplateRoles.defaultCount,
				isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, tpl.id))
			.orderBy(asc(meetingTemplateRoles.sortOrder)),
	]);

	return {
		templateId: tpl.id,
		templateName: tpl.name,
		editable: !isMeetingLocked(meeting.status),
		rows,
		roles,
	};
}
```

`isMeetingLocked(status: string): boolean` is already exported from `#/lib/meeting-lifecycle` (line 26) — import it, do not write a new predicate.

- [ ] **Step 4: Write the server-fn module**

Create `src/server/meeting-agenda-edit.ts`:

```ts
/**
 * Server fns for per-meeting agenda editing.
 *
 * Exports ONLY `createServerFn`s and types — a top-level db-touching export
 * here would drag `#/db` → `pg` → `Buffer` into the client bundle and
 * white-screen the page (`server-modules.guard.test.ts` enforces this).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AgendaDraft } from "./meeting-agenda-edit-logic";
import { loadAgendaDraft } from "./meeting-agenda-edit-logic";
import { requireMeetingTemplateEditor } from "./meeting-templates";

export type { AgendaDraft };

const meetingInput = z.object({ meetingId: z.string().uuid() });

/** This meeting's editable agenda. Officer-gated: the same authority that may
 *  change a meeting's type may reshape its run of show. */
export const getAgendaDraft = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingInput.parse(input))
	.handler(async ({ data }): Promise<AgendaDraft | null> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return loadAgendaDraft(data.meetingId);
	});
```

Export `requireMeetingTemplateEditor` from `src/server/meeting-templates.ts` by changing `async function requireMeetingTemplateEditor` to `export async function requireMeetingTemplateEditor`.

- [ ] **Step 5: Run the tests, typecheck, and the module guard**

Run:
```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run \
  src/server/meeting-agenda-edit-logic.integration.test.ts \
  src/server/server-modules.guard.test.ts \
  src/server/public-readers-archive-gate.guard.test.ts
bun run typecheck
```
Expected: PASS. `public-readers-archive-gate.guard.test.ts` derives its candidate set by walking `src/server/*.ts`, so it enrolls `meeting-agenda-edit.ts` automatically — it passes because every fn calls `requireMeetingTemplateEditor`, which asserts the archive state.

- [ ] **Step 6: Commit**

```bash
git add src/server/meeting-agenda-edit-logic.ts src/server/meeting-agenda-edit.ts src/server/meeting-templates.ts src/server/meeting-agenda-edit-logic.integration.test.ts
git commit -m "feat(agenda): load a templated meeting's editable agenda draft"
```

---

### Task 7: Row mutations

**Files:**
- Modify: `src/server/meeting-agenda-edit-logic.ts`
- Modify: `src/server/meeting-agenda-edit.ts`
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: `AgendaDraftRow`, `loadAgendaDraft` (Task 6); `copyTemplateForMeeting` (Task 3).
- Produces:
  - `ensureAgendaDraft(conn, meetingId): Promise<string>` — the meeting's private template id, upgrading a pre-feature shared pointer into a copy on first write.
  - `addAgendaRow(input: { meetingId: string; afterRowId: string | null; kind: "section" | "role" | "event" }): Promise<AgendaDraftRow>`
  - `updateAgendaRow(input: { meetingId: string; rowId: string; patch: Partial<Pick<AgendaDraftRow, "label" | "detail" | "minutes" | "roleKey" | "repeatsRoleKey" | "markGreen" | "markYellow" | "markRed">> }): Promise<void>`
  - `removeAgendaRow(input: { meetingId: string; rowId: string }): Promise<void>`
  - `moveAgendaRow(input: { meetingId: string; rowId: string; direction: "up" | "down" }): Promise<void>`
  - server fns `addAgendaRowFn`, `updateAgendaRowFn`, `removeAgendaRowFn`, `moveAgendaRowFn`.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/meeting-agenda-edit-logic.integration.test.ts`:

```ts
describe.runIf(hasTestDb())("agenda row mutations", () => {
	// … same beforeEach/afterEach/givePrivateTemplate as above; extract them to
	// module scope and share rather than duplicating.

	it("adds a row after the one named, renumbering the rest", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const first = before?.rows[0];
		if (!first) throw new Error("no rows");

		const created = await addAgendaRow({
			meetingId: club.meetingId,
			afterRowId: first.id,
			kind: "event",
		});
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.id)).toEqual([
			first.id,
			created.id,
			before.rows[1]?.id,
		]);
		// sortOrder stays strictly increasing — `buildTemplateRows` groups repeat
		// blocks from ADJACENT rows, so a duplicate or out-of-order value splits a
		// block in two and silently doubles a segment.
		const orders = after?.rows.map((r) => r.sortOrder) ?? [];
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
		expect(new Set(orders).size).toBe(orders.length);
	});

	it("refuses to add past the beat ceiling", async () => {
		// ABSOLUTE: the cap is enforced at the writer as well as the read seam,
		// so an officer holding the button cannot build a template the renderer
		// will then silently truncate.
		const id = await givePrivateTemplate();
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS }, (_, i) => ({
				templateId: id,
				sortOrder: 100 + i,
				kind: "event" as const,
				label: `filler ${i}`,
				minutes: 0,
			})),
		);
		await expect(
			addAgendaRow({ meetingId: club.meetingId, afterRowId: null, kind: "event" }),
		).rejects.toThrow(/too long/i);
	});

	it("edits a row's label, minutes and marks", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");

		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { label: "Opening remarks", minutes: 4, markGreen: 2, markYellow: 3, markRed: 4 },
		});
		const after = await loadAgendaDraft(club.meetingId);
		const updated = after?.rows.find((r) => r.id === row.id);
		expect(updated?.label).toBe("Opening remarks");
		expect(updated?.minutes).toBe(4);
		expect(updated?.markGreen).toBe(2);
	});

	it("refuses a partial set of timing marks", async () => {
		// `resolveMarks` treats all-three-or-none as the contract and drops a
		// partial set silently; a timer card with a hole in it is worse than no
		// card, so the writer refuses rather than the renderer discarding.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { markGreen: 2, markYellow: null, markRed: 4 },
			}),
		).rejects.toThrow(/all three/i);
	});

	it("caps label and detail by CODE POINTS", async () => {
		// Slicing a surrogate pair in half yields a lone surrogate that renders as
		// a replacement glyph and makes encodeURIComponent throw for any consumer
		// building a URL from it (#522).
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { label: "🎤".repeat(MAX_TEMPLATE_LABEL_CHARS + 1) },
			}),
		).rejects.toThrow(/too long/i);
	});

	it("moves a row up and down", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const ids = before?.rows.map((r) => r.id) ?? [];
		await moveAgendaRow({ meetingId: club.meetingId, rowId: ids[1] ?? "", direction: "up" });
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.id)).toEqual([ids[1], ids[0]]);
	});

	it("removes a row", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const target = before?.rows[0];
		if (!target) throw new Error("no rows");
		await removeAgendaRow({ meetingId: club.meetingId, rowId: target.id });
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.id)).not.toContain(target.id);
	});

	it("refuses every mutation on a locked meeting", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			removeAgendaRow({ meetingId: club.meetingId, rowId: row.id }),
		).rejects.toThrow();
		await expect(
			updateAgendaRow({ meetingId: club.meetingId, rowId: row.id, patch: { minutes: 1 } }),
		).rejects.toThrow();
	});

	it("cannot touch a row belonging to another meeting's template", async () => {
		// The rowId is caller-supplied. Scoping every mutation to the meeting's
		// OWN template is what stops one club editing another's agenda by id.
		await givePrivateTemplate();
		const other = await seedClub();
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: other.clubId,
				meetingId: other.meetingId,
				key: `other_${RUN}`,
				name: "Other",
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		madeTemplates.push(t.id);
		const [foreign] = await testDb
			.insert(meetingTemplateBeats)
			.values({ templateId: t.id, sortOrder: 0, kind: "event", label: "theirs", minutes: 0 })
			.returning({ id: meetingTemplateBeats.id });
		if (!foreign) throw new Error("beat insert failed");

		await expect(
			removeAgendaRow({ meetingId: club.meetingId, rowId: foreign.id }),
		).rejects.toThrow();
		const still = await testDb
			.select({ id: meetingTemplateBeats.id })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.id, foreign.id));
		expect(still).toHaveLength(1);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});
});
```

Import `MAX_TEMPLATE_BEATS` and `MAX_TEMPLATE_LABEL_CHARS` from `#/lib/meeting-template-limits`, and the four mutators from `./meeting-agenda-edit-logic`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts`
Expected: FAIL — the mutators are not exported.

- [ ] **Step 3: Implement the mutators**

Add to `src/server/meeting-agenda-edit-logic.ts`:

```ts
/**
 * The meeting's own private template id, or a thrown error.
 *
 * Upgrades on first write: a meeting converted before this feature points at a
 * SHARED template, and editing that would rewrite the agenda for every club
 * using it. Rather than refuse, the first edit copies it — the officer's
 * intent is to change THIS meeting, and the copy is exactly what makes that
 * true.
 */
export async function ensureAgendaDraft(
	conn: DbOrTx,
	meetingId: string,
): Promise<string> {
	const [meeting] = await conn
		.select({
			templateId: meetings.templateId,
			clubId: meetings.clubId,
			status: meetings.status,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");
	if (!meeting.templateId) {
		throw new Error(
			"Only a meeting with a meeting type can have its agenda edited.",
		);
	}
	assertMeetingNotLocked(meeting.status);
	if (meeting.status === "cancelled") {
		throw new Error("A cancelled meeting's agenda cannot be edited.");
	}

	const [own] = await conn
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.id, meeting.templateId),
				eq(meetingTemplates.meetingId, meetingId),
			),
		)
		.limit(1);
	if (own) return own.id;

	const copyId = await copyTemplateForMeeting(conn, {
		sourceTemplateId: meeting.templateId,
		clubId: meeting.clubId,
		meetingId,
	});
	await conn
		.update(meetings)
		.set({ templateId: copyId })
		.where(eq(meetings.id, meetingId));
	return copyId;
}

/** Cap by CODE POINTS — see `capChars` in `agenda-template-rows.ts`. */
function assertWithin(value: string, max: number, what: string): void {
	if ([...value].length > max) {
		throw new Error(`That ${what} is too long (max ${max} characters).`);
	}
}

/** All three marks or none. A partial set is a data error `resolveMarks` drops
 *  silently, so it is refused at the writer instead. */
function assertMarks(patch: {
	markGreen?: number | null;
	markYellow?: number | null;
	markRed?: number | null;
}): void {
	const keys = ["markGreen", "markYellow", "markRed"] as const;
	const touched = keys.filter((k) => k in patch);
	if (touched.length === 0) return;
	const values = keys.map((k) => patch[k] ?? null);
	const set = values.filter((v) => v != null).length;
	if (set !== 0 && set !== 3) {
		throw new Error("Timing marks need all three values, or none.");
	}
}

export async function addAgendaRow(input: {
	meetingId: string;
	afterRowId: string | null;
	kind: "section" | "role" | "event";
}): Promise<AgendaDraftRow> {
	return database.transaction(async (tx) => {
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await tx
			.select({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		if (rows.length >= MAX_TEMPLATE_BEATS) {
			throw new Error(
				`This agenda is too long (max ${MAX_TEMPLATE_BEATS} rows).`,
			);
		}

		const at =
			input.afterRowId === null
				? rows.length
				: rows.findIndex((r) => r.id === input.afterRowId) + 1;
		if (input.afterRowId !== null && at === 0) {
			throw new Error("That agenda row is not part of this meeting.");
		}

		// RENUMBER the whole list rather than inserting a fractional order.
		// `buildTemplateRows` groups a repeat block from ADJACENT rows, so
		// contiguity is load-bearing and a gap invites a later fractional insert
		// that collides.
		const reordered = [...rows];
		const [created] = await tx
			.insert(meetingTemplateBeats)
			.values({
				templateId,
				sortOrder: 0,
				kind: input.kind,
				label: input.kind === "section" ? "NEW SECTION" : "New item",
				minutes: 0,
			})
			.returning({ id: meetingTemplateBeats.id });
		if (!created) throw new Error("Failed to add the agenda row.");
		reordered.splice(at, 0, { id: created.id, sortOrder: 0 });

		for (const [i, r] of reordered.entries()) {
			await tx
				.update(meetingTemplateBeats)
				.set({ sortOrder: i })
				.where(eq(meetingTemplateBeats.id, r.id));
		}

		const [row] = await tx
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.id, created.id))
			.limit(1);
		if (!row) throw new Error("Failed to add the agenda row.");
		return {
			id: row.id,
			sortOrder: row.sortOrder,
			kind: row.kind,
			label: row.label,
			detail: row.detail,
			minutes: row.minutes,
			roleKey: row.roleKey,
			repeatsRoleKey: row.repeatsRoleKey,
			markGreen: row.markGreen,
			markYellow: row.markYellow,
			markRed: row.markRed,
		};
	});
}

export async function updateAgendaRow(input: {
	meetingId: string;
	rowId: string;
	patch: Partial<
		Pick<
			AgendaDraftRow,
			| "label"
			| "detail"
			| "minutes"
			| "roleKey"
			| "repeatsRoleKey"
			| "markGreen"
			| "markYellow"
			| "markRed"
		>
	>;
}): Promise<void> {
	const { patch } = input;
	if (patch.label != null) {
		assertWithin(patch.label, MAX_TEMPLATE_LABEL_CHARS, "label");
	}
	if (patch.detail != null) {
		assertWithin(patch.detail, MAX_TEMPLATE_DETAIL_CHARS, "note");
	}
	if (patch.minutes != null && (patch.minutes < 0 || patch.minutes > 600)) {
		throw new Error("Minutes must be between 0 and 600.");
	}
	assertMarks(patch);

	await database.transaction(async (tx) => {
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		// Scoped to THIS meeting's template: the row id is caller-supplied, and
		// without the template predicate an officer of one club could edit
		// another's agenda by id.
		const updated = await tx
			.update(meetingTemplateBeats)
			.set(patch)
			.where(
				and(
					eq(meetingTemplateBeats.id, input.rowId),
					eq(meetingTemplateBeats.templateId, templateId),
				),
			)
			.returning({ id: meetingTemplateBeats.id });
		if (updated.length === 0) {
			throw new Error("That agenda row is not part of this meeting.");
		}
	});
}

export async function removeAgendaRow(input: {
	meetingId: string;
	rowId: string;
}): Promise<void> {
	await database.transaction(async (tx) => {
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const deleted = await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.id, input.rowId),
					eq(meetingTemplateBeats.templateId, templateId),
				),
			)
			.returning({ id: meetingTemplateBeats.id });
		if (deleted.length === 0) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const rest = await tx
			.select({ id: meetingTemplateBeats.id })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		for (const [i, r] of rest.entries()) {
			await tx
				.update(meetingTemplateBeats)
				.set({ sortOrder: i })
				.where(eq(meetingTemplateBeats.id, r.id));
		}
	});
}

export async function moveAgendaRow(input: {
	meetingId: string;
	rowId: string;
	direction: "up" | "down";
}): Promise<void> {
	await database.transaction(async (tx) => {
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await tx
			.select({ id: meetingTemplateBeats.id })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		const at = rows.findIndex((r) => r.id === input.rowId);
		if (at === -1) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const to = input.direction === "up" ? at - 1 : at + 1;
		if (to < 0 || to >= rows.length) return;

		const reordered = [...rows];
		const [moved] = reordered.splice(at, 1);
		if (!moved) return;
		reordered.splice(to, 0, moved);
		for (const [i, r] of reordered.entries()) {
			await tx
				.update(meetingTemplateBeats)
				.set({ sortOrder: i })
				.where(eq(meetingTemplateBeats.id, r.id));
		}
	});
}
```

Add the imports this needs: `MAX_TEMPLATE_BEATS`, `MAX_TEMPLATE_LABEL_CHARS`, `MAX_TEMPLATE_DETAIL_CHARS` from `#/lib/meeting-template-limits`; `assertMeetingNotLocked` from `./meeting-authz-logic`; `copyTemplateForMeeting` and the `DbOrTx` type from `./meeting-templates-logic` (export `DbOrTx` from there).

- [ ] **Step 4: Add the four server fns**

Append to `src/server/meeting-agenda-edit.ts`:

```ts
const addInput = z.object({
	meetingId: z.string().uuid(),
	afterRowId: z.string().uuid().nullable(),
	kind: z.enum(["section", "role", "event"]),
});
const rowInput = z.object({
	meetingId: z.string().uuid(),
	rowId: z.string().uuid(),
});
const patchInput = rowInput.extend({
	patch: z.object({
		label: z.string().optional(),
		detail: z.string().nullable().optional(),
		minutes: z.number().int().optional(),
		roleKey: z.string().nullable().optional(),
		repeatsRoleKey: z.string().nullable().optional(),
		markGreen: z.number().nullable().optional(),
		markYellow: z.number().nullable().optional(),
		markRed: z.number().nullable().optional(),
	}),
});
const moveInput = rowInput.extend({ direction: z.enum(["up", "down"]) });

export const addAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => addInput.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingTemplateEditor(data.meetingId);
		return addAgendaRow(data);
	});

export const updateAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => patchInput.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingTemplateEditor(data.meetingId);
		return updateAgendaRow(data);
	});

export const removeAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => rowInput.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingTemplateEditor(data.meetingId);
		return removeAgendaRow(data);
	});

export const moveAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveInput.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingTemplateEditor(data.meetingId);
		return moveAgendaRow(data);
	});
```

- [ ] **Step 5: Run the tests, typecheck, lint**

Run:
```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/
bun run typecheck
bunx biome check --diagnostic-level=error src/ scripts/
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/meeting-agenda-edit-logic.ts src/server/meeting-agenda-edit.ts src/server/meeting-templates-logic.ts src/server/meeting-agenda-edit-logic.integration.test.ts
git commit -m "feat(agenda): add, edit, reorder and remove a meeting's agenda rows

Every mutation is scoped to the meeting's own private template, so a
caller-supplied row id cannot reach another club's agenda. Caps are
enforced at the writer as well as the read seam, marks are all-three-or-
none, and a pre-feature meeting pointing at a shared template is copied
on first write rather than edited in place."
```

---

### Task 8: Role mutations, and naming who loses a role

**Files:**
- Modify: `src/server/meeting-agenda-edit-logic.ts`
- Modify: `src/server/meeting-agenda-edit.ts`
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: `ensureAgendaDraft` (Task 7), `materializeTemplateRoles` and `ReleasedHolder` (existing, `meeting-templates-logic.ts`), `generateSlotRows` (`#/lib/agenda`).
- Produces:
  - `addAgendaRole(input: { meetingId: string; name: string; category: "leadership" | "speaker" | "evaluator" | "functionary"; defaultCount: number; isSpeakerRole: boolean }): Promise<AgendaDraftRole>`
  - `planRoleRemoval(input: { meetingId: string; roleKey: string }): Promise<ReleasedHolder[]>`
  - `removeAgendaRole(input: { meetingId: string; roleKey: string; actorMemberId: string | null }): Promise<ReleasedHolder[]>`
  - server fns `addAgendaRoleFn`, `planRoleRemovalFn`, `removeAgendaRoleFn`.

- [ ] **Step 1: Write the failing tests**

```ts
	it("adds a role, materializes it, and makes it claimable", async () => {
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		expect(role.key).toMatch(/^[a-z0-9_]+$/);

		// A role with no `role_definitions` row cannot own a slot —
		// role_slots.role_definition_id is NOT NULL and restricting — so an
		// unmaterialized role is a row nobody can ever sign up for.
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.roles.map((r) => r.name)).toContain("Zoom Master");
		const defs = await testDb
			.select({ name: roleDefinitions.name })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
		expect(defs.map((d) => d.name)).toContain("Zoom Master");
	});

	it("derives a unique key when two roles share a name", async () => {
		await givePrivateTemplate();
		const a = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Judge",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const b = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Judge",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		expect(a.key).not.toBe(b.key);
	});

	it("names the people a role removal would release, BEFORE removing", async () => {
		// The dialog leads with names because a released holder cannot be told:
		// notifications.slot_id is NOT NULL and ON DELETE CASCADE to role_slots,
		// so a row enqueued against a slot the same transaction deletes is
		// destroyed before the poller sees it.
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		await claimFirstSlotFor(role.key, club.memberId);

		const plan = await planRoleRemoval({
			meetingId: club.meetingId,
			roleKey: role.key,
		});
		expect(plan).toHaveLength(1);
		expect(plan[0]?.name).toBeTruthy();
		// And nothing was destroyed by ASKING.
		const still = await loadAgendaDraft(club.meetingId);
		expect(still?.roles.map((r) => r.key)).toContain(role.key);
	});

	it("removes the role, its slots and the rows bound to it", async () => {
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const draft = await loadAgendaDraft(club.meetingId);
		const anyRow = draft?.rows.find((r) => r.kind === "role");
		if (!anyRow) throw new Error("no role row");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: anyRow.id,
			patch: { roleKey: role.key },
		});

		await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: role.key,
			actorMemberId: null,
		});
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.roles.map((r) => r.key)).not.toContain(role.key);
		// A row pointing at a role the template no longer declares is DROPPED by
		// buildTemplateRows, so leaving it behind would be an invisible row that
		// silently reappears if the key is ever reused.
		expect(after?.rows.map((r) => r.id)).not.toContain(anyRow.id);
	});
```

Add a `claimFirstSlotFor(roleKey, memberId)` helper to the file that finds the slot whose role definition has that key on `club.meetingId` and sets `assignedMemberId` + `status: "claimed"`.

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts`
Expected: FAIL — the role mutators are not exported.

- [ ] **Step 3: Implement**

```ts
/** `Zoom Master` → `zoom_master`, uniquified against the template's own keys.
 *  Keys are the stable, rename-proof identity every surface binds on (#368), so
 *  they are derived once at creation and never follow a later rename. */
function deriveRoleKey(name: string, taken: Set<string>): string {
	const base =
		[...name.toLowerCase()]
			.map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
			.join("")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "") || "role";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export async function addAgendaRole(input: {
	meetingId: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
}): Promise<AgendaDraftRole> {
	assertWithin(input.name, MAX_TEMPLATE_LABEL_CHARS, "role name");
	if (input.defaultCount < 0 || input.defaultCount > MAX_ROLE_REPEAT_SLOTS) {
		throw new Error(
			`A role can have between 0 and ${MAX_ROLE_REPEAT_SLOTS} places.`,
		);
	}

	return database.transaction(async (tx) => {
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const [meeting] = await tx
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1);
		if (!meeting) throw new Error("Meeting not found.");

		const existing = await tx
			.select({
				key: meetingTemplateRoles.key,
				sortOrder: meetingTemplateRoles.sortOrder,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId));
		if (existing.length >= MAX_TEMPLATE_ROLES) {
			throw new Error(
				`This agenda has too many roles (max ${MAX_TEMPLATE_ROLES}).`,
			);
		}
		const key = deriveRoleKey(input.name, new Set(existing.map((r) => r.key)));
		const sortOrder =
			existing.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10;

		await tx.insert(meetingTemplateRoles).values({
			templateId,
			key,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			sortOrder,
			isSpeakerRole: input.isSpeakerRole,
		});
		// Materialize so the role is claimable: role_slots.role_definition_id is
		// NOT NULL and restricting, so a role with no definition row can never own
		// a slot and the agenda row would be decorative.
		await materializeTemplateRoles(tx, meeting.clubId, templateId);

		const defs = await tx
			.select({ id: roleDefinitions.id, defaultCount: roleDefinitions.defaultCount })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, meeting.clubId),
					eq(roleDefinitions.templateId, templateId),
					eq(roleDefinitions.key, key),
				),
			);
		const rows = generateSlotRows(defs, input.meetingId);
		if (rows.length > 0) await tx.insert(roleSlots).values(rows);

		return {
			key,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			isSpeakerRole: input.isSpeakerRole,
		};
	});
}

/** Who a role removal would release. PURE READ — showing an officer what a
 *  change would do must not itself change anything, the same rule
 *  `planTemplateConversion` follows. */
export async function planRoleRemoval(input: {
	meetingId: string;
	roleKey: string;
}): Promise<ReleasedHolder[]> {
	const [meeting] = await database
		.select({ clubId: meetings.clubId, templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting?.templateId) return [];

	const rows = await database
		.select({
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			memberName: members.displayName,
			guestName: guests.name,
			roleName: roleDefinitions.name,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(
			and(
				eq(roleSlots.meetingId, input.meetingId),
				eq(roleDefinitions.templateId, meeting.templateId),
				eq(roleDefinitions.key, input.roleKey),
			),
		);

	return rows
		.filter((r) => r.memberId != null || r.guestId != null)
		.map((r) => ({
			memberId: r.memberId,
			guestId: r.guestId,
			name: r.memberName ?? r.guestName ?? "Someone",
			roleName: r.roleName,
		}));
}

export async function removeAgendaRole(input: {
	meetingId: string;
	roleKey: string;
	actorMemberId: string | null;
}): Promise<ReleasedHolder[]> {
	const released = await planRoleRemoval({
		meetingId: input.meetingId,
		roleKey: input.roleKey,
	});

	await database.transaction(async (tx) => {
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const [meeting] = await tx
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1);
		if (!meeting) throw new Error("Meeting not found.");

		const defs = await tx
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, meeting.clubId),
					eq(roleDefinitions.templateId, templateId),
					eq(roleDefinitions.key, input.roleKey),
				),
			);
		const defIds = defs.map((d) => d.id);
		if (defIds.length > 0) {
			// Release, then delete — "a slot is released before it disappears"
			// stays true at every intermediate state. The speech is Person-owned
			// (ADR-0009), so it survives regardless.
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					speechId: null,
					status: "open",
					claimedAt: null,
				})
				.where(
					and(
						eq(roleSlots.meetingId, input.meetingId),
						inArray(roleSlots.roleDefinitionId, defIds),
					),
				);
			await tx
				.delete(roleSlots)
				.where(
					and(
						eq(roleSlots.meetingId, input.meetingId),
						inArray(roleSlots.roleDefinitionId, defIds),
					),
				);
			await tx
				.delete(roleDefinitions)
				.where(inArray(roleDefinitions.id, defIds));
		}

		// Rows bound to a role the template no longer declares are DROPPED by
		// buildTemplateRows, so leaving them is an invisible row that reappears
		// if the key is reused. Delete them with the role.
		await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.roleKey, input.roleKey),
				),
			);
		await tx
			.delete(meetingTemplateRoles)
			.where(
				and(
					eq(meetingTemplateRoles.templateId, templateId),
					eq(meetingTemplateRoles.key, input.roleKey),
				),
			);

		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_agenda_role_removed",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { roleKey: input.roleKey, released: released.length },
		});
	});

	return released;
}
```

Add imports: `guests`, `members`, `roleDefinitions`, `roleSlots` from `#/db/schema`; `inArray` from `drizzle-orm`; `generateSlotRows` from `#/lib/agenda`; `logActivity` from `./activity`; `materializeTemplateRoles` and the `ReleasedHolder` type from `./meeting-templates-logic`; `MAX_TEMPLATE_ROLES` and `MAX_ROLE_REPEAT_SLOTS` from `#/lib/meeting-template-limits`.

- [ ] **Step 4: Add the three server fns**

```ts
const roleAddInput = z.object({
	meetingId: z.string().uuid(),
	name: z.string().min(1),
	category: z.enum(["leadership", "speaker", "evaluator", "functionary"]),
	defaultCount: z.number().int().min(0),
	isSpeakerRole: z.boolean(),
});
const roleKeyInput = z.object({
	meetingId: z.string().uuid(),
	roleKey: z.string().min(1),
});

export const addAgendaRoleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => roleAddInput.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingTemplateEditor(data.meetingId);
		return addAgendaRole(data);
	});

export const planRoleRemovalFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => roleKeyInput.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingTemplateEditor(data.meetingId);
		return planRoleRemoval(data);
	});

export const removeAgendaRoleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => roleKeyInput.parse(input))
	.handler(async ({ data }) => {
		const { membership } = await requireMeetingTemplateEditor(data.meetingId);
		return removeAgendaRole({ ...data, actorMemberId: membership.id });
	});
```

- [ ] **Step 5: Run everything and commit**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/
bun run typecheck
bunx biome check --diagnostic-level=error src/ scripts/
git add src/server/meeting-agenda-edit-logic.ts src/server/meeting-agenda-edit.ts src/server/meeting-agenda-edit-logic.integration.test.ts
git commit -m "feat(agenda): create and remove a meeting's roles from the editor

A created role is materialized into role_definitions and given slots, so
it is claimable rather than decorative. Removal names the holders it
releases first, because notifications cascade-delete with the slot and
nobody can be told afterwards."
```

---

### Task 9: The editor page

**Files:**
- Create: `src/routes/club.$clubId.meeting.$meetingId.agenda.tsx`
- Create: `src/components/agenda/agenda-editor.tsx`
- Create: `src/components/agenda/agenda-editor.test.tsx`
- Create: `src/routes/agenda-editor-wiring.guard.test.ts`
- Modify: `src/components/agenda/meeting-agenda.tsx` (the "Edit agenda" button, near the "Change meeting type" button at line ~355)
- Modify: `src/routeTree.gen.ts` (generated — run `bun run generate-routes`, never hand-edit)

**Interfaces:**
- Consumes: `getAgendaDraft`, `addAgendaRowFn`, `updateAgendaRowFn`, `removeAgendaRowFn`, `moveAgendaRowFn`, `addAgendaRoleFn`, `planRoleRemovalFn`, `removeAgendaRoleFn` (Tasks 6-8).
- Produces: `AgendaEditor` — a presentational component taking `draft: AgendaDraft` and callback props, so it is reachable from vitest without the Start runtime (the same shape `MeetingTemplateDialog` uses).

- [ ] **Step 1: Write the failing component test**

Create `src/components/agenda/agenda-editor.test.tsx`. Test through props — mount `AgendaEditor` with a two-row draft and assert:

```tsx
	it("renders one control row per agenda row, in order", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		const labels = screen.getAllByLabelText("Row label");
		expect(labels.map((el) => (el as HTMLInputElement).value)).toEqual([
			"OPENING",
			"Welcome",
		]);
	});

	it("hides every mutating control when the draft is not editable", () => {
		// A completed meeting's agenda is the record it became. The server refuses
		// the write regardless; this is so an officer is not offered a button that
		// will fail.
		render(<AgendaEditor draft={{ ...draft, editable: false }} {...noopHandlers} />);
		expect(screen.queryByRole("button", { name: /add row/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
	});

	it("asks for confirmation and NAMES the holders before removing a role", async () => {
		const onRemoveRole = vi.fn();
		const planRoleRemoval = vi.fn().mockResolvedValue([
			{ memberId: "m1", guestId: null, name: "Ada Lovelace", roleName: "Zoom Master" },
		]);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				planRoleRemoval={planRoleRemoval}
				onRemoveRole={onRemoveRole}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /remove zoom master/i }));
		expect(await screen.findByText(/Ada Lovelace/)).toBeInTheDocument();
		// Not removed on ASKING.
		expect(onRemoveRole).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: /remove anyway/i }));
		expect(onRemoveRole).toHaveBeenCalledWith("zoom_master");
	});

	it("does not confirm when nothing is claimed", () => {
		// Friction scales with damage — a confirm on every change trains officers
		// to click through the one that matters.
		// … assert a single click calls onRemoveRole when planRoleRemoval returns [].
	});
```

Fill the last case in fully following the pattern above; do not leave it as a comment.

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build `AgendaEditor`**

A presentational component. Props: `draft: AgendaDraft`, `onAddRow(afterRowId, kind)`, `onUpdateRow(rowId, patch)`, `onRemoveRow(rowId)`, `onMoveRow(rowId, direction)`, `onAddRole(role)`, `planRoleRemoval(roleKey)`, `onRemoveRole(roleKey)`. Follow `MeetingTemplateDialog`'s shape: server fns are passed IN, never imported, so the whole component is reachable from vitest without the Start runtime.

Use shadcn primitives already in `src/components/ui`. Each row is a card with: a kind badge, a label input, a detail input, a minutes input, a role select (role rows only, populated from `draft.roles` plus "nobody"), a once/per-holder toggle (writes `repeatsRoleKey = roleKey` or `null`), three mark inputs, and move-up / move-down / remove buttons. Below the rows, an "Add row" control per kind and a roles panel with an add form and per-role remove.

Anchor the once/per-holder toggle's copy in what it means on the sheet, not in the column name: "One row" / "One row per person holding this role".

- [ ] **Step 4: Build the route and wire the button**

`src/routes/club.$clubId.meeting.$meetingId.agenda.tsx` — loader calls `getAgendaDraft({ data: { meetingId } })`, redirects to the meeting page when it returns null, renders `<AgendaEditor>` with handlers that call the server fns and then `router.invalidate()`.

In `src/components/agenda/meeting-agenda.tsx`, beside the existing "Change meeting type" button (~line 355), add — inside the same `viewer.canManage` gate:

```tsx
			{viewer.canManage && meeting.templateId ? (
				<Button type="button" variant="outline" size="sm" asChild>
					<Link
						to="/club/$clubId/meeting/$meetingId/agenda"
						params={{ clubId: meeting.clubId, meetingId: meeting.id }}
					>
						Edit agenda
					</Link>
				</Button>
			) : null}
```

Note the global unlayered `a` rule in `src/styles.css` repaints bare anchors link-teal and beats any layered utility. `<Button asChild>` is already excluded via `:not([data-slot="button"])`, so this is safe — but do not swap it for a bare `<Link>`.

- [ ] **Step 5: Regenerate the route tree**

Run: `bun run generate-routes`
Never hand-edit `src/routeTree.gen.ts`.

- [ ] **Step 6: Write the wiring guard**

Create `src/routes/agenda-editor-wiring.guard.test.ts` using `readSource` from `#/test/guard-source` (comment-blind — its own header quotes the patterns it asserts, which would otherwise match themselves). Pin:

- the meeting page's button gates on BOTH `viewer.canManage` and `meeting.templateId`, so a standard meeting never offers an editor that redirects straight back;
- the route's loader redirects when `getAgendaDraft` returns null;
- the editor route passes `draft` from the loader, not a re-derived value.

This exists because a route cannot be mounted in vitest and a prop-fed component test cannot see a wrong prop (#319).

- [ ] **Step 7: Run everything**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"
bun run test
bun run typecheck
bunx biome check --diagnostic-level=error src/ scripts/
```
Expected: all pass. `print-page-reset.guard.test.ts` walks `src/routes/` recursively — the editor route defines no `.pgwrap` padding, so it passes.

- [ ] **Step 8: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.agenda.tsx src/components/agenda/agenda-editor.tsx src/components/agenda/agenda-editor.test.tsx src/routes/agenda-editor-wiring.guard.test.ts src/components/agenda/meeting-agenda.tsx src/routeTree.gen.ts
git commit -m "feat(agenda): the per-meeting agenda editor page"
```

---

### Task 10: Measure the caps, and the all-axes-hostile fixture

**Files:**
- Modify: `src/lib/meeting-template-limits.ts`
- Create: `src/lib/meeting-template-limits.bench.test.ts`
- Modify: `src/components/agenda/print-density.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: measured ceilings replacing the current unprofiled bounds.

- [ ] **Step 1: Write the measurement harness**

`meeting-template-limits.bench.test.ts` renders `buildTemplateRows` through `resolveAgendaRows` at increasing sizes and records wall-clock. The fixture is **all axes hostile at once**, from a written list: label at `MAX_TEMPLATE_LABEL_CHARS`, detail at `MAX_TEMPLATE_DETAIL_CHARS`, beats at `MAX_TEMPLATE_BEATS`, roles at `MAX_TEMPLATE_ROLES`, repeat slots at `MAX_ROLE_REPEAT_SLOTS`, and every string built from **emoji, not ASCII** — #522 measured emoji rows at ~13× ASCII through the same renderer at the same capped size, so an all-ASCII fixture sizes a cap several times too high.

```ts
	it("renders the worst legal template well under a second", () => {
		const t0 = performance.now();
		buildTemplateRows(hostileBeats(), hostileRoles(), hostileSlots());
		const ms = performance.now() - t0;
		// ABSOLUTE, in the unit the complaint would be made in. Not
		// `toBeLessThan(SOME_BUDGET_CONSTANT)`, which passes for every value of
		// the constant.
		expect(ms).toBeLessThan(250);
	});
```

- [ ] **Step 2: Run the curve and record the numbers**

Run: `bunx vitest run src/lib/meeting-template-limits.bench.test.ts`
Record the measured milliseconds at 25 / 50 / 100 / 200 beats with the hostile fixture. Find the knee.

- [ ] **Step 3: Reset the ceilings to sit below the knee**

Edit `src/lib/meeting-template-limits.ts`: replace each constant with the measured value, and **replace the HONESTY NOTE** — it currently says "these are BOUNDS, not measurements … BEFORE Phase 2 exposes a template editor, measure the render cost". Write what was actually measured, with the numbers and the date, and state that an editor is now the writer. Do not leave a comment claiming a measurement that did not happen, and do not leave one denying a measurement that did.

- [ ] **Step 4: Add the worst-case print fixture**

In `print-density.test.tsx`, add a case rendering a template at the new ceiling and assert the printed body clears `EDITORIAL_DENSE_MIN_PRINTED_PT`. A user-authored agenda can now be far longer than the seeded contest, and page count cannot see legibility.

- [ ] **Step 5: Run everything and commit**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"
bun run test && bun run typecheck && bunx biome check --diagnostic-level=error src/ scripts/
git add src/lib/meeting-template-limits.ts src/lib/meeting-template-limits.bench.test.ts src/components/agenda/print-density.test.tsx
git commit -m "perf(templates): measure the template caps now an editor writes them

They were honest bounds nobody had profiled, which was defensible while
the seed was the only writer. Measured on an all-axes-hostile emoji
fixture and reset below the knee."
```

---

### Task 11: Documentation

**Files:**
- Modify: `CONTEXT.md` (the **Meeting template** entry)
- Modify: `TODOS.md` (the **Agenda templates** section)
- Modify: `CHANGELOG.md`, `VERSION`, `package.json` — leave to `/ship`, which writes all three

- [ ] **Step 1: Update `CONTEXT.md`**

Add to the **Meeting template** entry: a templated meeting owns a PRIVATE template row (`meeting_templates.meeting_id`), conversion deep-copies, reverting deletes the copy, and `listAvailableTemplates` excludes private rows. State that `repeats_role_key` is the once/per-holder flag rather than a separate column, and that a non-repeating role beat now emits one row naming every holder.

- [ ] **Step 2: Update `TODOS.md`**

Close **Phase 2: per-meeting agenda editing** and the **repeat-block binding is unexercised in two shapes** entry (D4 made both shapes unauthorable). Leave the `MIN_FIT_SCALE` legibility-cliff entry open and note the editor makes it easier to hit, since a user-authored agenda can now land anywhere on the curve. Add "save this shape as a template" as the next increment.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md TODOS.md
git commit -m "docs: record per-meeting agenda editing in CONTEXT and TODOS"
```

---

## Self-Review

**Spec coverage.** D1 → Tasks 1-3. D2 → Task 3. D3 → Task 1 (both indexes, plus the `db:push` predicate verification). D4 → Task 5, which needs no migration because `repeats_role_key` already carries the per-holder meaning. D5 → Task 4. D6 (gating dropped) → no task, correctly. D7 → Tasks 6-9. D8 → Task 8. Testing requirements 1-3 → Task 10; 4 → Task 10; 5 → Tasks 9-10; 6-7 → the Global Constraints and every integration task's `afterEach`; 8 → Task 9; 9 → not needed, no task adds a guard whose only effect is avoided work. Track A shipped separately and is already committed.

**Type consistency.** `AgendaDraftRow` / `AgendaDraftRole` / `AgendaDraft` are defined in Task 6 and used unchanged in 7-9. `copyTemplateForMeeting` (Task 3) is consumed by `ensureAgendaDraft` (Task 7). `ReleasedHolder` is the existing type from `meeting-templates-logic.ts`, reused rather than redefined. `requireMeetingTemplateEditor` returns `{ clubId, membership }`; Task 8's `removeAgendaRoleFn` uses `membership.id`, matching how `applyTemplateToMeeting` already uses it.

**One deliberate deviation from the spec**, worth flagging in review: the spec's D4 describes once/per-holder as though it needed a stored setting. It does not — `repeats_role_key` is already that flag, since a repeat block must name its role for the rows in the block that own none. Task 5 therefore changes only the renderer and the seed. If a reviewer prefers an explicit column for legibility, that is a schema addition on top, not a prerequisite.
