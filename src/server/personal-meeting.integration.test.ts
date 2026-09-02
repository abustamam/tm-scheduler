/**
 * DB-backed tests for `loadPublicPersonalMeetingView` (#665) — the public,
 * session-less read seam behind the personal meeting page.
 *
 * ## Every gate case is a BEFORE/AFTER pair
 *
 * Read this before adding a case. Asserting that the reader returns `null` for
 * an archived club is worth nothing on its own: it returns `null` for an empty
 * club too, so with the gate DELETED the assertion still passes and would sit
 * here reading like proof. This is the repo's "empty-list guard is invisible to
 * a result assertion" trap. So each gate case seeds data, asserts the reader
 * DOES return it, then breaks exactly one precondition and asserts `null` — the
 * first half is what fails when someone removes the gate.
 *
 * Verified by mutation: removing the `archive()` step from the first case makes
 * exactly that case fail and no other, so its `toBeNull()` genuinely tracks the
 * club's archive state rather than passing on an empty fixture. The membership
 * and inactive cases carry their own proof inline — each breaks one
 * precondition, asserts `null`, then RESTORES it and asserts the same id
 * resolves, so neither can pass by returning `null` unconditionally.
 *
 * ## The seam takes a URL SEGMENT, not a meeting id
 *
 * `meetingKey` is whatever sat in `$meetingId`: a club-local `YYYY-MM-DD`, a
 * `YYYY-MM-DD-HHmm`, or a uuid. The first cut assumed a uuid, which rejected
 * every canonical nudge link (`nudgeShareUrl` is built from `meetingUrlKey`).
 * `resolvesByDateKey` below is the case that pins it.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/personal-meeting.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { meetingUrlKey } from "#/lib/meeting-url";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting-logic"
);
const { getPlanStatus, setPlanStatus } = await import(
	"#/server/attendance-plan-logic"
);

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

async function seedPersonal(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	// Give the seeded member the seeded slot, so "holds a role" is the default
	// shape and the no-role case is the one that has to opt out.
	await testDb
		.update(roleSlots)
		.set({ assignedMemberId: s.memberId, status: "claimed" })
		.where(eq(roleSlots.id, s.slotId));
	return s;
}

/** The common call: this club, this club's meeting, by uuid. Individual cases
 *  override `meetingKey` / `clubId` where that is the thing under test. */
const viewOf = (
	s: SeededClub,
	memberId: string,
	over: { clubId?: string; meetingKey?: string } = {},
) =>
	loadPublicPersonalMeetingView({
		clubId: over.clubId ?? s.clubId,
		meetingKey: over.meetingKey ?? s.meetingId,
		memberId,
	});

const archive = (clubId: string) =>
	testDb
		.update(clubs)
		.set({ archivedAt: new Date() })
		.where(eq(clubs.id, clubId));

describe.skipIf(!hasTestDb)("loadPublicPersonalMeetingView (#665)", () => {
	it("returns the member's roles for a live club, and null once archived", async () => {
		const s = await seedPersonal();

		const before = await viewOf(s, s.memberId);
		expect(before).not.toBeNull();
		expect(before?.member.name).toBe("Member User");
		expect(before?.roles.map((r) => r.roleName)).toEqual(["Timer"]);
		expect(before?.club.id).toBe(s.clubId);

		await archive(s.clubId);

		// null, NOT a throw — an archived club is indistinguishable from one that
		// never existed, so the route needs no new error path.
		await expect(viewOf(s, s.memberId)).resolves.toBeNull();
	});

	// TWO zones, and both are set EXPLICITLY. The first cut hardcoded
	// "America/Chicago", which is `clubs.timezone`'s schema DEFAULT and is never
	// set by `seedClub` — so the fixture and the value under test agreed by
	// coincidence, and #669 has just made that column admin-settable. The key is
	// club-LOCAL, so the zone is the axis under test: `Pacific/Auckland` is far
	// enough east that the club-local date differs from the UTC date for much of
	// the day, which is exactly where the resolver's date arithmetic can be wrong.
	it.each([
		"America/Chicago",
		"Pacific/Auckland",
	])("resolves the club-local DATE KEY in %s, which is what links carry", async (tz) => {
		const s = await seedPersonal();
		await testDb
			.update(clubs)
			.set({ timezone: tz })
			.where(eq(clubs.id, s.clubId));
		const [row] = await testDb
			.select({ scheduledAt: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, s.meetingId))
			.limit(1);
		// `collides: false` — one meeting that day, so the bare date form, which
		// is the shape every producer emits for an ordinary meeting. Derived from
		// the SAME literal the club was set to, not from `view.club.timezone`,
		// which would make both sides agree by construction.
		const key = meetingUrlKey(row?.scheduledAt as Date, tz, false);

		const byKey = await viewOf(s, s.memberId, { meetingKey: key });
		const byUuid = await viewOf(s, s.memberId);
		expect(byKey).not.toBeNull();
		// The KEY is not the uuid — otherwise this case proves nothing.
		expect(key).not.toBe(s.meetingId);
		expect(byKey?.meeting.id).toBe(byUuid?.meeting.id);
		expect(byKey?.meeting.id).toBe(s.meetingId);
		// The zone travels, because the page formats the date with it.
		expect(byKey?.club.timezone).toBe(tz);
	});

	it("ships the role KEY, which is how a club-renamed role still resolves", async () => {
		// `dutiesForRole` matches on key first and name second, so dropping
		// `roleKey` from the payload silently breaks duty resolution for any club
		// that renamed a standard role — the exact case its docblock exists for,
		// and invisible to a test that only reads `roleName`.
		const s = await seedPersonal();
		await testDb
			.update(roleDefinitions)
			.set({ key: "timer", name: "Chief Timekeeper" })
			.where(eq(roleDefinitions.id, s.roleDefinitionId));

		const view = await viewOf(s, s.memberId);
		expect(view?.roles[0]?.roleKey).toBe("timer");
		expect(view?.roles[0]?.roleName).toBe("Chief Timekeeper");
	});

	it("ships the meeting status, which drives the write gate", async () => {
		const s = await seedPersonal();
		expect((await viewOf(s, s.memberId))?.meeting.status).toBe("scheduled");

		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		expect((await viewOf(s, s.memberId))?.meeting.status).toBe("cancelled");
	});

	it("refuses a meeting belonging to a DIFFERENT club than the caller's", async () => {
		// Without club scoping this rendered club B's meeting under a club-A URL,
		// and the route then wrote a club-B member into club A's identity slot.
		const s = await seedPersonal();
		const other = await seedClub();
		try {
			// Same meeting, correct club → resolves. This is the half that fails if
			// someone deletes the scoping and "fixes" the case by loosening it.
			await expect(
				loadPublicPersonalMeetingView({
					clubId: other.clubId,
					meetingKey: other.meetingId,
					memberId: other.memberId,
				}),
			).resolves.not.toBeNull();

			// Club A + club B's meeting → not-found, not club B's data.
			await expect(
				viewOf(s, s.memberId, { meetingKey: other.meetingId }),
			).resolves.toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("carries no contact details for the member it resolves", async () => {
		const s = await seedPersonal();
		// The seeded roster row HAS an email, so this can fail: a bare `select()`
		// on `members` would ship it. Phone is set here for the same reason —
		// asserting the absence of a column nothing populates proves nothing.
		await testDb
			.update(members)
			.set({ phone: "+15551234567" })
			.where(eq(members.id, s.memberId));

		const view = await viewOf(s, s.memberId);

		expect(view).not.toBeNull();
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("+15551234567");
		expect(serialized).not.toContain("@test.example");
		// The payload's own shape, so a future field cannot smuggle one back in.
		expect(Object.keys(view?.member ?? {}).sort()).toEqual(["id", "name"]);
	});

	it("rejects a member who is not in the meeting's club", async () => {
		const s = await seedPersonal();
		const other = await seedClub();
		try {
			// Present and active, but in a DIFFERENT club — the pairing check.
			await expect(viewOf(s, other.memberId)).resolves.toBeNull();
			// Same member id against its OWN club still resolves, which is what
			// makes the assertion above about the PAIRING rather than the member.
			await expect(
				loadPublicPersonalMeetingView({
					clubId: other.clubId,
					meetingKey: other.meetingId,
					memberId: other.memberId,
				}),
			).resolves.not.toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("rejects an inactive member, and resolves the same id once active", async () => {
		const s = await seedPersonal();

		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, s.memberId));
		await expect(viewOf(s, s.memberId)).resolves.toBeNull();

		await testDb
			.update(members)
			.set({ status: "active" })
			.where(eq(members.id, s.memberId));
		await expect(viewOf(s, s.memberId)).resolves.not.toBeNull();
	});

	it("rejects a malformed member id without throwing", async () => {
		const s = await seedPersonal();
		// A non-uuid compared against a `uuid` column makes Postgres THROW, so the
		// shape check has to happen before the query. `resolves` (not `rejects`)
		// is the assertion that matters here.
		for (const bad of ["not-a-uuid", "", "'; drop table members; --", "123"]) {
			await expect(viewOf(s, bad)).resolves.toBeNull();
		}
	});

	it("rejects a malformed or unknown meeting key without throwing", async () => {
		const s = await seedPersonal();
		await expect(
			viewOf(s, s.memberId, { meetingKey: "not-a-uuid" }),
		).resolves.toBeNull();
		await expect(
			viewOf(s, s.memberId, { meetingKey: randomUUID() }),
		).resolves.toBeNull();
		// A well-formed date key for a day this club never met.
		await expect(
			viewOf(s, s.memberId, { meetingKey: "1999-01-01" }),
		).resolves.toBeNull();
	});

	it("reports the member's stored rung, and null for no answer", async () => {
		const s = await seedPersonal();

		expect((await viewOf(s, s.memberId))?.planStatus).toBeNull();

		await setPlanStatus(testDb, {
			memberId: s.memberId,
			meetingId: s.meetingId,
			clubId: s.clubId,
			status: "coming",
			actorMemberId: s.memberId,
		});

		expect((await viewOf(s, s.memberId))?.planStatus).toBe("coming");

		// The other answered rung, which nothing exercised before: a member who
		// declined must read back as declined, not as "no answer".
		await setPlanStatus(testDb, {
			memberId: s.memberId,
			meetingId: s.meetingId,
			clubId: s.clubId,
			status: "not_coming",
			actorMemberId: s.memberId,
		});
		expect((await viewOf(s, s.memberId))?.planStatus).toBe("not_coming");
	});

	it("rejects a malformed club id and an empty key without throwing", async () => {
		// The loose `z.string()` validator's whole justification is that bad input
		// collapses to a not-found rather than a 500. That safety currently lives
		// two modules away in `isReadableClub`'s own shape check, with nothing
		// pinning it here — so pin it here.
		const s = await seedPersonal();
		await expect(
			viewOf(s, s.memberId, { clubId: "not-a-uuid" }),
		).resolves.toBeNull();
		await expect(viewOf(s, s.memberId, { meetingKey: "" })).resolves.toBeNull();
	});

	it("never reports reached_out, the officer's private record of having asked", async () => {
		const s = await seedPersonal();
		// The rung IS stored — this is not an empty-fixture assertion.
		await setPlanStatus(testDb, {
			memberId: s.memberId,
			meetingId: s.meetingId,
			clubId: s.clubId,
			status: "reached_out",
			actorMemberId: s.adminMemberId,
		});
		expect(
			await getPlanStatus(testDb, {
				memberId: s.memberId,
				meetingId: s.meetingId,
			}),
		).toBe("reached_out");

		// …but the public payload collapses it to "no answer". Shipping it would
		// tell any visitor holding a roster id which members an officer has
		// chased, and `meetings.ts` filters it out of its public half for the
		// same reason.
		const view = await viewOf(s, s.memberId);
		expect(view).not.toBeNull();
		expect(view?.planStatus).toBeNull();
		expect(JSON.stringify(view)).not.toContain("reached_out");
	});

	it("returns an empty role list for a member holding nothing", async () => {
		const s = await seedPersonal();
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: null, status: "open" })
			.where(eq(roleSlots.id, s.slotId));

		const view = await viewOf(s, s.memberId);
		// Resolves — this is the "Coming to the meeting?" shape, not not-found.
		expect(view).not.toBeNull();
		expect(view?.roles).toEqual([]);
	});

	it("carries the speech title for a speaking slot, for the duty checklist", async () => {
		const s = await seedPersonal();
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId: s.personId, title: "The Ice Breaker" })
			.returning({ id: speeches.id });
		await testDb
			.update(roleSlots)
			.set({ speechId: speech?.id })
			.where(eq(roleSlots.id, s.slotId));

		const view = await viewOf(s, s.memberId);
		expect(view?.roles[0]?.speechTitle).toBe("The Ice Breaker");
	});

	it("gives each slot its OWN speech title when a member holds two", async () => {
		// TODOS.md names this exact trap: `DutyContext` mixes meeting-scoped fields
		// with the slot-scoped `speechTitle`, so a consumer that builds ONE context
		// per member marks both of a member's speaker slots done off a single
		// title. Speaker `defaultCount` is 3, so holding two is ordinary, not
		// exotic. This payload is per-SLOT, and this is what pins that.
		const s = await seedPersonal();
		const [roleDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: s.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		const [told] = await testDb
			.insert(speeches)
			.values({ personId: s.personId, title: "Told" })
			.returning({ id: speeches.id });

		// Slot A carries a real title; slot B carries none.
		await testDb.insert(roleSlots).values([
			{
				meetingId: s.meetingId,
				roleDefinitionId: roleDef?.id as string,
				assignedMemberId: s.memberId,
				status: "claimed",
				slotIndex: 1,
				speechId: told?.id,
			},
			{
				meetingId: s.meetingId,
				roleDefinitionId: roleDef?.id as string,
				assignedMemberId: s.memberId,
				status: "claimed",
				slotIndex: 2,
			},
		]);

		const view = await viewOf(s, s.memberId);
		const speakers = view?.roles.filter((r) => r.roleName === "Speaker") ?? [];
		expect(speakers).toHaveLength(2);
		// The two must DIFFER. A per-member context would make these equal, which
		// is the whole failure mode — so asserting both values, not just one.
		expect(speakers[0]?.speechTitle).toBe("Told");
		expect(speakers[1]?.speechTitle).toBeNull();
	});

	it("carries the meeting's theme and word, which duties read as done/not-done", async () => {
		const s = await seedPersonal();
		await testDb
			.update(meetings)
			.set({ theme: "New Beginnings", wordOfTheDay: "auspicious" })
			.where(eq(meetings.id, s.meetingId));

		const view = await viewOf(s, s.memberId);
		expect(view?.meeting.theme).toBe("New Beginnings");
		expect(view?.meeting.wordOfTheDay).toBe("auspicious");
	});
});
