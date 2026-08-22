/**
 * DB-backed tests for converting a meeting to and from a template.
 *
 * Fixture facts that matter (`src/test/db.ts`): `seedClub()` creates ONE role
 * definition ("Timer", NULL key, defaultCount 1), ONE meeting and ONE slot. So
 * a club here has one standard slot, not nine — any assertion written against
 * a nine-role club can only fail. And GLOBAL templates survive `cleanup`,
 * which cascades from the club, so they are deleted explicitly.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-template-convert.integration.test.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyTemplateConversion,
	materializeTemplateRoles,
	planTemplateConversion,
} = await import("./meeting-templates-logic");

describe.skipIf(!hasTestDb)("meeting template conversion", () => {
	let club: SeededClub;
	let templateId: string;

	/**
	 * Templates THIS file created. `tm_test` is shared and vitest runs test FILES
	 * in parallel, so two unscoped operations break each other:
	 *   - a fixed global key collides on `meeting_templates_global_key_unique`;
	 *   - `delete(meetingTemplates)` with no WHERE deletes the OTHER file's rows,
	 *     which then fails the FK from its materialized role_definitions.
	 * So keys are unique per template and teardown deletes only what we made.
	 */
	const createdTemplateIds: string[] = [];

	beforeEach(async () => {
		club = await seedClub();
		templateId = await makeTemplate();
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		if (createdTemplateIds.length > 0) {
			await testDb
				.delete(meetingTemplates)
				.where(inArray(meetingTemplates.id, createdTemplateIds));
			createdTemplateIds.length = 0;
		}
	});

	async function makeTemplate() {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: null,
				key: `speech_contest-${crypto.randomUUID().slice(0, 8)}`,
				name: "Speech Contest",
				defaultLengthMinutes: 150,
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("Failed to insert template");
		createdTemplateIds.push(tpl.id);
		await testDb.insert(meetingTemplateRoles).values([
			{
				templateId: tpl.id,
				key: "contest_chair",
				name: "Contest Chair",
				category: "leadership",
				defaultCount: 1,
				sortOrder: 10,
			},
			{
				templateId: tpl.id,
				key: "contestant_prepared",
				name: "Contestant",
				category: "speaker",
				defaultCount: 3,
				sortOrder: 20,
				isSpeakerRole: true,
			},
		]);
		await testDb.insert(meetingTemplateBeats).values({
			templateId: tpl.id,
			sortOrder: 0,
			kind: "event",
			label: "Call to order",
			minutes: 2,
		});
		return tpl.id;
	}

	async function slotsFor(meetingId: string) {
		return testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, meetingId));
	}

	async function convert(to: string | null) {
		return applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId: to,
			actorMemberId: null,
		});
	}

	describe("preview", () => {
		it("changes nothing", async () => {
			const before = await slotsFor(club.meetingId);
			await planTemplateConversion(club.meetingId, templateId);
			expect(await slotsFor(club.meetingId)).toHaveLength(before.length);
		});

		it("counts the standard slots it will remove", async () => {
			const plan = await planTemplateConversion(club.meetingId, templateId);
			// The seed's single standard slot, unclaimed.
			expect(plan.openSlotsRemoved).toBe(1);
			expect(plan.claimedSlotsReleased).toBe(0);
		});

		/**
		 * The number the dialog promises ("adds 17 contest roles"). On a FIRST
		 * preview nothing is materialized, by design — so it has to come from the
		 * template's own rows, not from `role_definitions`.
		 */
		it("reports how many slots it will ADD before anything is materialized", async () => {
			const plan = await planTemplateConversion(club.meetingId, templateId);
			expect(plan.slotsAdded).toBe(4); // 1 chair + 3 contestants
		});

		/**
		 * OLD contract, now false. Before private copies, `applyTemplateConversion`
		 * materialized role_definitions under the SOURCE template's id, so a
		 * second preview of that same id saw them already there and reported a
		 * no-op. Task 3 materializes under the PRIVATE COPY's id instead — a
		 * fresh id every conversion — so nothing is ever materialized under the
		 * source id, and a preview of the source always falls back to the
		 * template's own rows, exactly like a first-time preview. This is the
		 * brief's own accepted consequence ("planTemplateConversion... already
		 * reads the SOURCE template's own rows when nothing is materialized").
		 */
		it("still previews a full add on the source id after applying, since nothing materializes there", async () => {
			await convert(templateId);
			const plan = await planTemplateConversion(club.meetingId, templateId);
			expect(plan.slotsAdded).toBe(4); // 1 chair + 3 contestants, same as a first preview
			expect(plan.openSlotsRemoved).toBe(4); // the private copy's own 4 slots, none "kept"
			expect(plan.claimedSlotsReleased).toBe(0);
		});
	});

	describe("apply", () => {
		it("replaces the standard slots with the template's", async () => {
			await convert(templateId);
			expect(await slotsFor(club.meetingId)).toHaveLength(4);
		});

		it("stamps template_id with a private copy and the template's default length", async () => {
			await convert(templateId);
			const [row] = await testDb
				.select()
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			// OLD contract was `row?.templateId === templateId` (the shared row).
			// Conversion now deep-copies, so the meeting points at a PRIVATE row
			// instead — asserted via its meetingId, not the id itself.
			expect(row?.templateId).not.toBe(templateId);
			const [copy] = await testDb
				.select({ meetingId: meetingTemplates.meetingId })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, row?.templateId ?? ""));
			expect(copy?.meetingId).toBe(club.meetingId);
			expect(row?.lengthMinutes).toBe(150);
		});

		it("leaves lengthMinutes alone when the template sets none", async () => {
			await testDb
				.update(meetingTemplates)
				.set({ defaultLengthMinutes: null })
				.where(eq(meetingTemplates.id, templateId));
			const [before] = await testDb
				.select()
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			await convert(templateId);
			const [after] = await testDb
				.select()
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			expect(after?.lengthMinutes).toBe(before?.lengthMinutes);
		});

		it("returns the MEMBER holder of a released slot", async () => {
			const [slot] = await slotsFor(club.meetingId);
			if (!slot) throw new Error("seed produced no slots");
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: club.memberId, status: "claimed" })
				.where(eq(roleSlots.id, slot.id));

			const plan = await convert(templateId);
			expect(plan.claimedSlotsReleased).toBe(1);
			expect(plan.releasedHolders).toHaveLength(1);
			expect(plan.releasedHolders[0]?.memberId).toBe(club.memberId);
			expect(plan.releasedHolders[0]?.name).toBeTruthy();
			expect(plan.releasedHolders[0]?.roleName).toBe("Timer");
		});

		/** Guests can hold slots (ADR-0013 / #151), so they must be reported too —
		 *  a visiting judge who loses their role needs telling just as much. */
		it("returns the GUEST holder of a released slot", async () => {
			const [guest] = await testDb
				.insert(guests)
				.values({ clubId: club.clubId, name: "Visiting Judge" })
				.returning({ id: guests.id });
			if (!guest) throw new Error("Failed to insert guest");
			const [slot] = await slotsFor(club.meetingId);
			if (!slot) throw new Error("seed produced no slots");
			await testDb
				.update(roleSlots)
				.set({ assignedGuestId: guest.id, status: "claimed" })
				.where(eq(roleSlots.id, slot.id));

			const plan = await convert(templateId);
			expect(plan.releasedHolders[0]?.guestId).toBe(guest.id);
			expect(plan.releasedHolders[0]?.memberId).toBeNull();
			expect(plan.releasedHolders[0]?.name).toBe("Visiting Judge");
		});

		/** Speeches are Person-owned (ADR-0009). Only the slot pointer clears —
		 *  the speech itself outlives the slot that referenced it. */
		it("keeps a speech alive when its slot is removed", async () => {
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: club.personId, title: "My speech" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to insert speech");
			const [slot] = await slotsFor(club.meetingId);
			if (!slot) throw new Error("seed produced no slots");
			await testDb
				.update(roleSlots)
				.set({ speechId: speech.id })
				.where(eq(roleSlots.id, slot.id));

			const plan = await convert(templateId);
			expect(plan.slotsWithSpeeches).toBe(1);
			expect(
				await testDb.select().from(speeches).where(eq(speeches.id, speech.id)),
			).toHaveLength(1);
		});

		it("writes exactly one activity row", async () => {
			await convert(templateId);
			const rows = await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId));
			expect(
				rows.filter((r) => r.action === "meeting_template_set"),
			).toHaveLength(1);
		});

		/**
		 * OLD comment, now false: "Idempotent: a second conversion must not
		 * duplicate them." That framing describes a no-op, and this is not one.
		 * Every conversion deep-copies a FRESH private template (Task 3), so the
		 * second call's role_definitions are different ROWS from the first's,
		 * even though the source `templateId` is identical — there is nothing
		 * for a second call to recognize as "already there" to skip. The count
		 * comes out the same (4 in, 4 out) because the first conversion's 4
		 * slots are torn down and 4 new ones built on top of the fresh copy, not
		 * because the second call did nothing. See the next test, which is what
		 * makes that distinction observable: a re-apply releases a claim.
		 */
		it("replaces the slots on a second identical conversion, rather than deduplicating them", async () => {
			await convert(templateId);
			await convert(templateId);
			expect(await slotsFor(club.meetingId)).toHaveLength(4);
		});

		/**
		 * The controller's ruling on this (fix round 1, finding 4): this stays a
		 * full teardown, deliberately, rather than gaining a short-circuit for
		 * "the target template is the one already applied." A short-circuit
		 * would be a FOURTH path through a transaction two prior orderings
		 * already got wrong, and the preview naming who loses a role — which
		 * `MeetingTemplateDialog` shows before anything is destroyed — is this
		 * app's established answer to exactly this situation, not a special
		 * case to avoid.
		 */
		it("releases a claimed slot's holder even when re-applying the SAME template", async () => {
			await convert(templateId);
			const [slot] = await slotsFor(club.meetingId);
			if (!slot) throw new Error("first conversion produced no slots");
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: club.memberId, status: "claimed" })
				.where(eq(roleSlots.id, slot.id));

			const plan = await convert(templateId);
			expect(plan.claimedSlotsReleased).toBe(1);
			expect(plan.releasedHolders).toHaveLength(1);
			expect(plan.releasedHolders[0]?.memberId).toBe(club.memberId);
		});
	});

	describe("converting back", () => {
		it("restores the club's standard shape", async () => {
			await convert(templateId);
			await convert(null);
			const [row] = await testDb
				.select()
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			expect(row?.templateId).toBeNull();
			// `seedClub` defines ONE standard role with defaultCount 1.
			expect(await slotsFor(club.meetingId)).toHaveLength(1);
		});
	});

	describe("private copy", () => {
		it("points the meeting at a PRIVATE copy, not the shared template", async () => {
			const source = await makeTemplate();
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
			const source = await makeTemplate();
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
			const source = await makeTemplate();
			const [second] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: new Date("2027-05-06T02:00:00Z"),
				})
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
			const source = await makeTemplate();
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

		it("re-converting an already-converted meeting replaces its private copy", async () => {
			// The private-template index is unique on meeting_id, so the OLD copy's
			// own meeting_id has to be cleared before the new copy can be inserted —
			// and it can't be fully deleted that early, because role_definitions
			// (ON DELETE RESTRICT) still points at it until the slot reconciliation
			// below reassigns those roles to the NEW copy. See the "Detach" comment
			// in applyTemplateConversion.
			const first = await makeTemplate();
			const second = await makeTemplate();
			await applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: first,
				actorMemberId: null,
			});
			const [afterFirst] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const firstCopy = afterFirst?.templateId ?? "";

			await applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: second,
				actorMemberId: null,
			});
			const [afterSecond] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));

			expect(afterSecond?.templateId).not.toBe(firstCopy);
			// The superseded copy is gone, not orphaned.
			const orphan = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, firstCopy));
			expect(orphan).toEqual([]);
		});
	});

	/**
	 * Fix round 1, finding 1. Before Task 3, `meeting_templates` held only
	 * GLOBAL rows, so a caller-supplied `templateId` was safe to trust
	 * unscoped — every id named something world-readable by design. Task 3
	 * created the first per-club rows (private copies), and `meeting.templateId`
	 * is readable off a public meeting page, so an admin of one club can read
	 * another club's private copy id and pass it straight through
	 * `applyTemplateToMeeting`, which authorizes only the TARGET meeting.
	 * Without `templateVisibleTo`, that deep-copies the victim club's authored
	 * agenda into the attacker's own club.
	 */
	describe("cross-club source protection", () => {
		it("refuses to copy from another club's PRIVATE template, even by exact id", async () => {
			const source = await makeTemplate();
			await applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: source,
				actorMemberId: null,
			});
			const [row] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const clubAPrivateCopyId = row?.templateId ?? "";

			const clubB = await seedClub();
			try {
				await expect(
					applyTemplateConversion({
						meetingId: clubB.meetingId,
						clubId: clubB.clubId,
						templateId: clubAPrivateCopyId,
						actorMemberId: null,
					}),
				).rejects.toThrow(/template/i);
				// And nothing was copied into club B's club.
				const leaked = await testDb
					.select({ id: meetingTemplates.id })
					.from(meetingTemplates)
					.where(eq(meetingTemplates.clubId, clubB.clubId));
				expect(leaked).toEqual([]);
			} finally {
				await cleanup(clubB.clubId, [clubB.adminUserId, clubB.memberUserId]);
			}
		});

		it("refuses to copy from another club's OWN (non-private, club-scoped) template", async () => {
			// Phase 2 (club-scoped, non-private templates) writes no rows yet in
			// product code, but the schema and this predicate already support
			// them — this is the defense-in-depth case for when it does.
			const [clubScoped] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: club.clubId,
					key: `club-scoped-${crypto.randomUUID().slice(0, 8)}`,
					name: "Club A's own template",
				})
				.returning({ id: meetingTemplates.id });
			if (!clubScoped) throw new Error("template insert failed");
			createdTemplateIds.push(clubScoped.id);
			await testDb.insert(meetingTemplateRoles).values({
				templateId: clubScoped.id,
				key: "chair",
				name: "Chair",
				category: "leadership",
				defaultCount: 1,
				sortOrder: 10,
			});

			const clubB = await seedClub();
			try {
				await expect(
					applyTemplateConversion({
						meetingId: clubB.meetingId,
						clubId: clubB.clubId,
						templateId: clubScoped.id,
						actorMemberId: null,
					}),
				).rejects.toThrow(/template/i);
			} finally {
				await cleanup(clubB.clubId, [clubB.adminUserId, clubB.memberUserId]);
			}
		});
	});

	/**
	 * Task 3b, part B. The WRITE path (`applyTemplateConversion`, above) is
	 * gated by `templateVisibleTo`; `planTemplateConversion` — the preview —
	 * was not. It falls back to reading `meetingTemplateRoles` by the raw
	 * `templateId` whenever nothing has been materialized for THIS club yet
	 * (see its own comment on the first-time-preview branch), with no
	 * ownership check of its own. A club-B admin who has read a club-A
	 * private copy's id off a public meeting page could preview against it
	 * and learn its role count — smaller than the deep-copy the write path
	 * guards against, but the same tenant boundary.
	 */
	describe("preview cross-club protection", () => {
		it("refuses to preview another club's PRIVATE template, even by exact id", async () => {
			const source = await makeTemplate();
			await applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: source,
				actorMemberId: null,
			});
			const [row] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const clubAPrivateCopyId = row?.templateId ?? "";

			const clubB = await seedClub();
			try {
				// Unfixed, this resolves with a plan reporting the private copy's
				// own role count (4: 1 chair + 3 contestants, mirrored from its
				// source) instead of refusing — the leak this test guards against.
				await expect(
					planTemplateConversion(clubB.meetingId, clubAPrivateCopyId),
				).rejects.toThrow(/template/i);
			} finally {
				await cleanup(clubB.clubId, [clubB.adminUserId, clubB.memberUserId]);
			}
		});
	});

	/**
	 * Fix round 1, finding 3. All 22 pre-fix-round tests passed with
	 * `eq(meetingTemplates.meetingId, meetingId)` deleted from
	 * `previousPrivateId`'s lookup, because every one of them reaches a
	 * non-null `meetings.template_id` only through `applyTemplateConversion`
	 * itself, which always makes a private copy. The state that predicate
	 * exists for — `meetings.template_id` pointing at a SHARED template,
	 * either a legacy row from before private copies existed or a direct
	 * write — was never seeded.
	 */
	describe("legacy shared-template pointer", () => {
		it("does not retire a GLOBAL template when a meeting converts away from it", async () => {
			// Simulate the pre-Task-3 shape directly, bypassing
			// applyTemplateConversion: a meeting whose template_id points at a
			// SHARED template, materialized the old way (role_definitions tagged
			// with the SOURCE's own id, not a private copy's).
			await materializeTemplateRoles(testDb, club.clubId, templateId);
			await testDb
				.update(meetings)
				.set({ templateId })
				.where(eq(meetings.id, club.meetingId));

			await applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: null,
				actorMemberId: null,
			});

			const survivors = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, templateId));
			expect(survivors).toHaveLength(1);

			const defs = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, templateId),
					),
				);
			expect(defs.length).toBeGreaterThan(0);
		});
	});

	describe("refusals", () => {
		it("refuses a COMPLETED meeting, with the canonical lock message", async () => {
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, club.meetingId));
			await expect(convert(templateId)).rejects.toThrow(MEETING_LOCKED_MESSAGE);
		});

		it("refuses a CANCELLED meeting", async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, club.meetingId));
			await expect(convert(templateId)).rejects.toThrow(/cancelled/i);
		});

		it("refuses an unknown template", async () => {
			await expect(convert(crypto.randomUUID())).rejects.toThrow(/template/i);
		});

		it("refuses a meeting belonging to another club", async () => {
			const other = await seedClub();
			try {
				await expect(
					applyTemplateConversion({
						meetingId: other.meetingId,
						clubId: club.clubId,
						templateId,
						actorMemberId: null,
					}),
				).rejects.toThrow(/not found/i);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});
});
