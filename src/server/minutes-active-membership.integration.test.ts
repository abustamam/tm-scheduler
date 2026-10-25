/**
 * DB-backed tests that `getMinutes` treats a membership which is not `active`
 * as no membership: neither a member's read of a completed meeting's minutes nor
 * an admin's read of a meeting that is not completed.
 *
 * Ending (`former`) or deactivating (`inactive`) a membership keeps its stored
 * `club_role`, so the rows below hold the role "admin" with a status that is
 * not `active`.
 * `getMinutes` is called through the real server fn, with `createServerFn` and
 * the session mocked.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { impersonationSessions, meetings, members, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { getMinutes } = await import("#/server/minutes");

type NotActive = "inactive" | "former";
const NOT_ACTIVE: NotActive[] = ["inactive", "former"];
const EMPTY = { visible: false, canEdit: false, data: null, program: [] };

let seeded: SeededClub | null = null;
afterEach(async () => {
	sessionUserId = null;
	if (!seeded) return;
	await testDb
		.delete(impersonationSessions)
		.where(eq(impersonationSessions.clubId, seeded.clubId));
	await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	seeded = null;
});

async function seed(
	meetingStatus: "scheduled" | "completed",
): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	await testDb
		.update(meetings)
		.set({ status: meetingStatus })
		.where(eq(meetings.id, s.meetingId));
	return s;
}

/** Change only the status column, as ending or deactivating a membership does. */
async function setStatus(memberId: string, status: "active" | NotActive) {
	await testDb
		.update(members)
		.set({ status, endedAt: status === "former" ? "2026-01-01" : null })
		.where(eq(members.id, memberId));
}

async function minutesFor(s: SeededClub, userId: string | null) {
	sessionUserId = userId;
	return getMinutes({ data: s.meetingId });
}

describe.skipIf(!hasTestDb)(
	"getMinutes: a membership that is not active grants no read",
	() => {
		it("an active member reads a completed meeting's minutes, read-only", async () => {
			const s = await seed("completed");
			const result = await minutesFor(s, s.memberUserId);
			expect(result.visible).toBe(true);
			expect(result.canEdit).toBe(false);
			expect(result.data).not.toBeNull();
		});

		it("an active member reads nothing of a meeting that is not completed", async () => {
			const s = await seed("scheduled");
			expect(await minutesFor(s, s.memberUserId)).toEqual(EMPTY);
		});

		it("an active admin reads, and can edit, minutes of a meeting that is not completed", async () => {
			const s = await seed("scheduled");
			const result = await minutesFor(s, s.adminUserId);
			expect(result.visible).toBe(true);
			expect(result.canEdit).toBe(true);
		});

		it.each(
			NOT_ACTIVE,
		)("a %s member reads nothing, even of a completed meeting", async (status) => {
			// protects=a membership that is not active is not a member for the minutes read; fails_when=getMinutes treats any membership row as a member; no_claim=the PDF route has its own status test
			const s = await seed("completed");
			await setStatus(s.memberId, status);
			expect(await minutesFor(s, s.memberUserId)).toEqual(EMPTY);
		});

		it.each(
			NOT_ACTIVE,
		)("a %s admin reads nothing, of a completed meeting or of one that is not", async (status) => {
			// protects=a stored admin role grants nothing once the membership is not active; fails_when=isAdmin is taken from clubRole of any membership row; no_claim=none
			const completed = await seed("completed");
			await setStatus(completed.adminMemberId, status);
			expect(await minutesFor(completed, completed.adminUserId)).toEqual(EMPTY);
			await cleanup(completed.clubId, [
				completed.adminUserId,
				completed.memberUserId,
			]);

			const scheduled = await seed("scheduled");
			await setStatus(scheduled.adminMemberId, status);
			expect(await minutesFor(scheduled, scheduled.adminUserId)).toEqual(EMPTY);
		});

		it("a member who becomes active again reads again", async () => {
			const s = await seed("completed");
			await setStatus(s.memberId, "former");
			expect(await minutesFor(s, s.memberUserId)).toEqual(EMPTY);
			await setStatus(s.memberId, "active");
			expect((await minutesFor(s, s.memberUserId)).visible).toBe(true);
		});

		it("a signed-out caller reads nothing", async () => {
			const s = await seed("completed");
			expect(await minutesFor(s, null)).toEqual(EMPTY);
		});

		it.each(
			NOT_ACTIVE,
		)("a read_only impersonation reads nothing, for a superadmin whose own membership is %s", async (status) => {
			// protects=only a read_write impersonation reads the minutes of a meeting that is not completed, and a membership that is not active does not widen a read_only one; fails_when=a non-active membership or a read_only session grants the read or the edit; no_claim=none
			const s = await seed("scheduled");
			await testDb
				.update(user)
				.set({ isSuperadmin: true })
				.where(eq(user.id, s.adminUserId));
			await setStatus(s.adminMemberId, status);
			await testDb.insert(impersonationSessions).values({
				superadminUserId: s.adminUserId,
				clubId: s.clubId,
				mode: "read_only",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			});
			expect(await minutesFor(s, s.adminUserId)).toEqual(EMPTY);
		});

		it.each(
			NOT_ACTIVE,
		)("a read_write impersonation still reads and edits, for a superadmin whose own membership is %s", async (status) => {
			// protects=the impersonation arm is kept: a non-active membership falls through to it; fails_when=a non-active membership returns before the impersonation lookup; no_claim=read_only impersonation is not given edit here
			const s = await seed("scheduled");
			await testDb
				.update(user)
				.set({ isSuperadmin: true })
				.where(eq(user.id, s.adminUserId));
			await setStatus(s.adminMemberId, status);
			expect(await minutesFor(s, s.adminUserId)).toEqual(EMPTY);

			await testDb.insert(impersonationSessions).values({
				superadminUserId: s.adminUserId,
				clubId: s.clubId,
				mode: "read_write",
				reason: "test",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000),
			});
			const result = await minutesFor(s, s.adminUserId);
			expect(result.visible).toBe(true);
			expect(result.canEdit).toBe(true);
		});
	},
);
