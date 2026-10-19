/**
 * DB-backed tests for the `former` membership status (#1239).
 *
 * Plain logic fns are called directly; `createServerFn` is replaced by a thin
 * adapter so `listFormerMembers` can be called with a stubbed session.
 * `#/db` is redirected to the test database.
 *
 * `account-invite.ts`'s inline filter sits inside a server-fn handler no test
 * can reach; `membership-status.guard.test.ts` pins it by source scan instead.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	duesPeriods,
	meetings,
	members,
	officerTerms,
	roleSlots,
} from "#/db/schema";
import { localDateKey } from "#/lib/meeting-url";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { currentUser } = vi.hoisted(() => ({ currentUser: { id: "" } }));
vi.mock("./guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("./guards")>()),
	requireUser: vi.fn(async () => ({ id: currentUser.id })),
}));

const { applySetMemberStatus, loadFormerMembers, loadPublicClubRoster } =
	await import("#/server/members-logic");
const { listFormerMembers } = await import("#/server/members");
const { requireMemberInClub } = await import("#/server/guards");
const { loadClubMembers, loadMemberProfile } = await import(
	"#/server/club-logic"
);
const { currentOfficersForClub } = await import("#/server/officer-terms-logic");
const { loadSeasonGrid } = await import("#/server/season-grid-logic");
const { loadPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting-logic"
);
const { getOverdueDues } = await import("#/server/dues-logic");
const { countActiveMembers } = await import("#/server/dcp-logic");
const { applyConvertGuestToMember, captureGuestVisit } = await import(
	"#/server/guest-pipeline-logic"
);

type Status = "active" | "inactive" | "former";

describe.skipIf(!hasTestDb)("former membership (#1239)", () => {
	let seed: SeededClub;
	const extraPersons: string[] = [];
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		extraPersons.length = 0;
	});

	async function addMember(
		name: string,
		status: Status = "active",
		over: Partial<typeof members.$inferInsert> = {},
	) {
		const personId = await seedPerson({ name });
		const [m] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId, name, status, ...over })
			.returning({ id: members.id });
		return m.id;
	}
	const rowOf = async (id: string) =>
		(await testDb.select().from(members).where(eq(members.id, id)))[0];
	const set = (memberId: string, status: Status) =>
		applySetMemberStatus({
			clubId: seed.clubId,
			memberId,
			status,
			actorMemberId: seed.adminMemberId,
		});
	const statusLogCount = async (memberId: string) =>
		(
			await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.action, "member_edit"),
						eq(activityLog.targetId, memberId),
					),
				)
		).length;
	const clubToday = async () => {
		const [c] = await testDb
			.select({ tz: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		return localDateKey(new Date(), c?.tz || "UTC");
	};
	const openTerm = (
		membershipId: string,
		position: "president" | "treasurer",
	) =>
		testDb
			.insert(officerTerms)
			.values({ membershipId, position })
			.returning({ id: officerTerms.id });

	describe("transition table", () => {
		// protects=an active member's end sets status former, ended_at = club-local today, logs once;
		// fails_when=ended_at is NULL/UTC-wrong, or no activity_log row is written;
		// no_claim=the date near a timezone midnight (computed with the same helper).
		it("active -> former sets ended_at to today and logs", async () => {
			const id = await addMember("Ann Active");
			await set(id, "former");
			const row = await rowOf(id);
			expect(row.status).toBe("former");
			expect(row.endedAt).toBe(await clubToday());
			expect(await statusLogCount(id)).toBe(1);
		});

		// protects=an inactive member's end also lands as former with ended_at;
		// fails_when=the from-inactive path skips ended_at;
		// no_claim=none beyond protects.
		it("inactive -> former sets ended_at and logs", async () => {
			const id = await addMember("Ina Inactive", "inactive");
			await set(id, "former");
			const row = await rowOf(id);
			expect(row.status).toBe("former");
			expect(row.endedAt).toBe(await clubToday());
			expect(await statusLogCount(id)).toBe(1);
		});

		// protects=reactivating clears ended_at, opens no officer term, logs;
		// fails_when=ended_at survives reactivation or a term is reopened;
		// no_claim=none beyond protects.
		it("former -> active clears ended_at, opens no term, logs", async () => {
			const id = await addMember("Fay Former", "former", {
				endedAt: "2020-01-02",
			});
			await set(id, "active");
			const row = await rowOf(id);
			expect(row.status).toBe("active");
			expect(row.endedAt).toBeNull();
			expect(
				await testDb
					.select()
					.from(officerTerms)
					.where(eq(officerTerms.membershipId, id)),
			).toHaveLength(0);
			expect(await statusLogCount(id)).toBe(1);
		});

		// protects=former -> inactive clears ended_at and logs;
		// fails_when=a stale end date stays on an inactive member;
		// no_claim=none beyond protects.
		it("former -> inactive clears ended_at and logs", async () => {
			const id = await addMember("Ian Former", "former", {
				endedAt: "2020-01-02",
			});
			await set(id, "inactive");
			const row = await rowOf(id);
			expect(row.status).toBe("inactive");
			expect(row.endedAt).toBeNull();
			expect(await statusLogCount(id)).toBe(1);
		});

		// protects=former -> former is a no-op (end date kept, nothing logged);
		// fails_when=a second End rewrites ended_at or writes an activity_log row;
		// no_claim=none beyond protects.
		it("former -> former changes nothing and writes no log row", async () => {
			const id = await addMember("Fin Former", "former", {
				endedAt: "2020-01-02",
			});
			await set(id, "former");
			const row = await rowOf(id);
			expect(row.endedAt).toBe("2020-01-02");
			expect(await statusLogCount(id)).toBe(0);
		});

		// protects=active <-> inactive keeps ended_at NULL, as before;
		// fails_when=the toggle stamps an end date;
		// no_claim=none beyond protects.
		it("active <-> inactive leaves ended_at NULL", async () => {
			const id = await addMember("Tog Gle");
			await set(id, "inactive");
			expect((await rowOf(id)).endedAt).toBeNull();
			await set(id, "active");
			expect((await rowOf(id)).endedAt).toBeNull();
		});
	});

	describe("officer terms", () => {
		// protects=ending a two-office member closes BOTH open terms today, and Reactivate opens none;
		// fails_when=a term stays open, or reactivation reopens one;
		// no_claim=a future-dated term (termStart after now) is clamped to its start in code only.
		it("closes every open term; reactivation opens none", async () => {
			const id = await addMember("Olive Officer");
			await openTerm(id, "president");
			await openTerm(id, "treasurer");
			await set(id, "former");
			const terms = await testDb
				.select()
				.from(officerTerms)
				.where(eq(officerTerms.membershipId, id));
			expect(terms).toHaveLength(2);
			for (const t of terms) {
				expect(t.termEnd).not.toBeNull();
				expect(localDateKey(t.termEnd as Date, "UTC")).toBe(await clubToday());
			}
			await set(id, "active");
			const after = await testDb
				.select()
				.from(officerTerms)
				.where(and(eq(officerTerms.membershipId, id)));
			expect(after.every((t) => t.termEnd !== null)).toBe(true);
			expect(after).toHaveLength(2);
		});

		// protects=ending is ONE transaction: a failing term close leaves status, ended_at and log untouched;
		// fails_when=the status commits before the term update throws;
		// no_claim=the failure is forced by a row-scoped DB trigger standing in for any term-write error.
		it("a failing term close rolls the status back", async () => {
			const id = await addMember("Rolf Rollback");
			await openTerm(id, "president");
			const fn = `fail_term_${randomUUID().replaceAll("-", "")}`;
			await testDb.execute(
				sql.raw(
					`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced term failure'; END $$ LANGUAGE plpgsql`,
				),
			);
			await testDb.execute(
				sql.raw(
					`CREATE TRIGGER ${fn} BEFORE UPDATE ON officer_terms FOR EACH ROW WHEN (OLD.membership_id = '${id}') EXECUTE FUNCTION ${fn}()`,
				),
			);
			try {
				await expect(set(id, "former")).rejects.toThrow();
			} finally {
				await testDb.execute(sql.raw(`DROP TRIGGER ${fn} ON officer_terms`));
				await testDb.execute(sql.raw(`DROP FUNCTION ${fn}()`));
			}
			const row = await rowOf(id);
			expect(row.status).toBe("active");
			expect(row.endedAt).toBeNull();
			expect(await statusLogCount(id)).toBe(0);
		});
	});

	describe("the six rewritten sites exclude former", () => {
		// protects=requireMemberInClub refuses a former member with the former copy, inactive keeps its own;
		// fails_when=a former member can be assigned a role;
		// no_claim=callers' own wiring of this guard.
		it("guards: refuses former, keeps the inactive message", async () => {
			const former = await addMember("Gus Guard", "former");
			const inactive = await addMember("Ivy Guard", "inactive");
			await expect(requireMemberInClub(former, seed.clubId)).rejects.toThrow(
				"That member is no longer a member of this club.",
			);
			await expect(requireMemberInClub(inactive, seed.clubId)).rejects.toThrow(
				"inactive",
			);
		});

		// protects=the public/picker roster lists only active members;
		// fails_when=a former member appears in the picker;
		// no_claim=none beyond protects.
		it("members-logic: loadPublicClubRoster omits former", async () => {
			const former = await addMember("Rhea Roster", "former");
			const ids = (await loadPublicClubRoster(seed.clubId)).map((m) => m.id);
			expect(ids).toContain(seed.memberId);
			expect(ids).not.toContain(former);
		});

		// protects=the season grid member axis omits a former member;
		// fails_when=a former member gets a grid row;
		// no_claim=none beyond protects.
		it("season-grid: member axis omits former", async () => {
			const former = await addMember("Sage Grid", "former");
			const grid = await loadSeasonGrid({ clubId: seed.clubId, count: 4 });
			expect(grid.members.map((m) => m.id)).not.toContain(former);
			expect(grid.members.map((m) => m.id)).toContain(seed.memberId);
		});

		// protects=a former member's personal meeting view is not served;
		// fails_when=a former member sees the member view;
		// no_claim=the public route wiring around it.
		it("personal-meeting: null for a former member", async () => {
			const former = await addMember("Pat Personal", "former");
			const view = await loadPublicPersonalMeetingView({
				clubId: seed.clubId,
				meetingKey: seed.meetingId,
				memberId: former,
			});
			expect(view).toBeNull();
		});

		// protects=a former officer is not listed as a current officer even with an open term;
		// fails_when=currentOfficersForClub names a former holder;
		// no_claim=the open term is seeded directly (ending closes it in real use).
		it("officer-terms: current officers skip a former holder", async () => {
			const former = await addMember("Otto Officer", "former");
			await openTerm(former, "president");
			const officers = await currentOfficersForClub(seed.clubId);
			expect(officers.find((o) => o.position === "president")?.name).toBeNull();
		});
	});

	describe("rosters, dues, DCP", () => {
		// protects=the roster read omits former and the admin list carries them, newest end first, unknown last;
		// fails_when=former on a roster segment, or the former order differs;
		// no_claim=none beyond protects.
		it("loadClubMembers omits former; loadFormerMembers orders them", async () => {
			const a = await addMember("Zed Old", "former", { endedAt: "2019-05-05" });
			const b = await addMember("Amy New", "former", { endedAt: "2024-05-05" });
			const c = await addMember("Bob Unknown", "former");
			const roster = (await loadClubMembers(seed.clubId)).map((m) => m.id);
			expect([a, b, c].some((id) => roster.includes(id))).toBe(false);
			const list = await loadFormerMembers(seed.clubId);
			expect(list.map((m) => m.id)).toEqual([b, a, c]);
			expect(list[2].endedAt).toBeNull();
		});

		// protects=dues owing never lists a former member;
		// fails_when=a former member shows as overdue;
		// no_claim=none beyond protects.
		it("dues owing excludes former", async () => {
			const former = await addMember("Dee Dues", "former");
			await testDb.insert(duesPeriods).values({
				clubId: seed.clubId,
				label: "Past period",
				dueDate: new Date(Date.now() - 86400000),
			});
			const rows = await getOverdueDues(seed.clubId);
			expect(rows.map((r) => r.membershipId)).not.toContain(former);
			expect(rows.length).toBeGreaterThan(0);
		});

		// protects=the DCP active count ignores former members;
		// fails_when=a former member inflates the membership base;
		// no_claim=none beyond protects.
		it("DCP active count excludes former", async () => {
			const before = await countActiveMembers(seed.clubId);
			await addMember("Dcp Former", "former");
			expect(await countActiveMembers(seed.clubId)).toBe(before);
		});

		// protects=listFormerMembers is admin-only: a plain member is refused, an admin is served;
		// fails_when=the gate is missing so any member can list former people;
		// no_claim=the session is stubbed (requireUser), the club-role check is real.
		it("listFormerMembers refuses a non-admin", async () => {
			const former = await addMember("Lea List", "former");
			currentUser.id = seed.memberUserId;
			await expect(
				Promise.resolve(listFormerMembers({ data: { clubId: seed.clubId } })),
			).rejects.toThrow();
			currentUser.id = seed.adminUserId;
			const rows = await listFormerMembers({ data: { clubId: seed.clubId } });
			expect(rows.map((r) => r.id)).toContain(former);
		});
	});

	// protects=a former member's past role slot is untouched by ending, still on their profile and the grid's name lookup;
	// fails_when=history is deleted/released or the profile is unreachable;
	// no_claim=a PAST meeting's slot only; rendering of the printed agenda is not exercised.
	it("history survives: past slot, profile, grid names", async () => {
		const id = await addMember("Hal History");
		const [past] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() - 3 * 86400000),
				theme: "Past",
			} as typeof meetings.$inferInsert)
			.returning({ id: meetings.id });
		await testDb
			.update(roleSlots)
			.set({ meetingId: past.id, assignedMemberId: id, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
		await set(id, "former");
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot.assignedMemberId).toBe(id);
		const profile = await loadMemberProfile(seed.clubId, id);
		expect(profile?.status).toBe("former");
		const grid = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 4,
			pastCount: 4,
		});
		expect(grid.memberNames.map((m) => m.id)).toContain(id);
	});

	// protects=guest-convert reactivates a former membership: active, ended_at cleared, reactivatedFrom "former";
	// fails_when=the former row stays former/dated, or the log records "inactive";
	// no_claim=the guest is matched by email, the usual dedup path.
	it("guest-pipeline reactivation of a former member", async () => {
		const email = `former-${randomUUID()}@example.com`;
		const personId = await seedPerson({ name: "Gwen Guest", email });
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: "Gwen Guest",
				status: "former",
				endedAt: "2020-02-02",
			})
			.returning({ id: members.id });
		const { guestId } = await captureGuestVisit({
			clubId: seed.clubId,
			name: "Gwen Guest",
			email,
		});
		await applyConvertGuestToMember({
			clubId: seed.clubId,
			guestId,
			actorMemberId: seed.adminMemberId,
			confirmedEmail: email,
		});
		const row = await rowOf(m.id);
		expect(row.status).toBe("active");
		expect(row.endedAt).toBeNull();
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "member_add"),
				),
			);
		expect(
			logs.some(
				(l) =>
					(l.detail as { reactivatedFrom?: string } | null)?.reactivatedFrom ===
					"former",
			),
		).toBe(true);
	});
});
