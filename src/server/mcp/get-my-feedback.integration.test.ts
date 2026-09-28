/**
 * DB-backed tests for `get_my_feedback` (#987), called over a real minted
 * token, the way `/api/mcp` calls it.
 *
 * The two properties the tool exists to keep: it returns only the TOKEN
 * OWNER's notes (whose notes comes from the credential, never from input), and
 * nothing from a meeting whose scheduled end has not passed. Both are the
 * shared `recipientMayTouch` rule, so each is mutation-checked against it
 * (`bun run mutate src/server/role-feedback-logic.ts …`), and each refusal
 * first proves the same call returns the owner's note, so an empty answer
 * cannot pass on a broken fixture.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiTokens, clubs, meetings, roleFeedbackNotes } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getMyFeedbackTool } = await import(
	"#/server/mcp/tools/get-my-feedback"
);
const { loadFeedbackForUser } = await import("#/server/role-feedback-logic");
const { hashApiToken } = await import("#/server/api-tokens-logic");

type Result = Awaited<ReturnType<typeof loadFeedbackForUser>>;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function setMeeting(
	meetingId: string,
	scheduledAt: Date,
	lengthMinutes = 90,
) {
	await testDb
		.update(meetings)
		.set({ scheduledAt, lengthMinutes })
		.where(eq(meetings.id, meetingId));
}

async function note(
	s: SeededClub,
	recipientMemberId: string,
	wentWell: string,
	meetingId: string = s.meetingId,
) {
	await testDb.insert(roleFeedbackNotes).values({
		clubId: s.clubId,
		meetingId,
		recipientMemberId,
		roleLabel: "Timer",
		wentWell,
	});
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

function call(token: string, args: Record<string, unknown> = {}) {
	return getMyFeedbackTool.handler(args, {
		rawToken: token,
	}) as Promise<Result>;
}

const texts = (r: Result) =>
	r.meetings.flatMap((m) =>
		m.roles.flatMap((x) => x.notes.map((n) => n.wentWell)),
	);

describe.skipIf(!hasTestDb)("get_my_feedback (#987)", () => {
	it("two users at one meeting each get exactly what loadFeedbackForUser gives them, and only their own", async () => {
		const s = await club();
		await setMeeting(s.meetingId, new Date(Date.now() - DAY));
		await note(s, s.memberId, "for the member");
		await note(s, s.adminMemberId, "for the admin");

		const asMember = await call(await tokenFor(s.memberUserId));
		const asAdmin = await call(await tokenFor(s.adminUserId));

		expect(texts(asMember)).toEqual(["for the member"]);
		expect(texts(asAdmin)).toEqual(["for the admin"]);
		expect(asMember).toEqual(await loadFeedbackForUser(s.memberUserId));
		expect(asAdmin).toEqual(await loadFeedbackForUser(s.adminUserId));
	});

	it("ignores an identity smuggled into the input: whose notes comes from the token", async () => {
		const s = await club();
		await setMeeting(s.meetingId, new Date(Date.now() - DAY));
		await note(s, s.adminMemberId, "for the admin");
		const memberToken = await tokenFor(s.memberUserId);

		const res = await call(memberToken, {
			userId: s.adminUserId,
			memberId: s.adminMemberId,
		});
		expect(res).toEqual({ meetings: [], unseenCount: 0 });
	});

	it("returns nothing from a meeting that has not ended, then the note once it has", async () => {
		const s = await club();
		// Started half an hour ago, runs 90 minutes: in progress.
		await setMeeting(s.meetingId, new Date(Date.now() - 30 * MIN));
		await note(s, s.memberId, "too early");
		const token = await tokenFor(s.memberUserId);

		expect(await call(token)).toEqual({ meetings: [], unseenCount: 0 });
		expect(await call(token, { meetingId: s.meetingId })).toEqual({
			meetings: [],
			unseenCount: 0,
		});

		// The control: the SAME note, the same token, once the meeting has ended.
		await setMeeting(s.meetingId, new Date(Date.now() - DAY));
		expect(texts(await call(token))).toEqual(["too early"]);
	});

	it("a meetingId the caller has no notes for is an empty list, not an error", async () => {
		const s = await club();
		await setMeeting(s.meetingId, new Date(Date.now() - DAY));
		await note(s, s.adminMemberId, "for the admin");
		const memberToken = await tokenFor(s.memberUserId);

		// A real, ended meeting holding someone else's note.
		expect(await call(memberToken, { meetingId: s.meetingId })).toEqual({
			meetings: [],
			unseenCount: 0,
		});
		// A meeting that does not exist.
		expect(await call(memberToken, { meetingId: randomUUID() })).toEqual({
			meetings: [],
			unseenCount: 0,
		});
		// The control: the owner, same meetingId.
		expect(
			texts(
				await call(await tokenFor(s.adminUserId), { meetingId: s.meetingId }),
			),
		).toEqual(["for the admin"]);
	});

	it("from/to are CLUB-LOCAL dates, inclusive, and unseenCount counts only what is kept", async () => {
		const s = await club();
		await testDb
			.update(clubs)
			.set({ timezone: "America/Los_Angeles" })
			.where(eq(clubs.id, s.clubId));
		// 7pm Saturday 2026-03-07 in Los Angeles = 03:00 Sunday 2026-03-08 UTC.
		await setMeeting(s.meetingId, new Date("2026-03-08T03:00:00Z"));
		await note(s, s.memberId, "saturday night");
		const token = await tokenFor(s.memberUserId);

		const sat = await call(token, { from: "2026-03-07", to: "2026-03-07" });
		expect(texts(sat)).toEqual(["saturday night"]);
		expect(sat.unseenCount).toBe(1);

		const sun = await call(token, { from: "2026-03-08", to: "2026-03-08" });
		expect(sun).toEqual({ meetings: [], unseenCount: 0 });
		expect(texts(await call(token, { to: "2026-03-06" }))).toEqual([]);
		expect(texts(await call(token, { from: "2026-03-07" }))).toEqual([
			"saturday night",
		]);
	});

	it("refuses a range whose from is after its to, and a date that is not on the calendar", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await expect(
			call(token, { from: "2026-03-08", to: "2026-03-07" }),
		).rejects.toThrow(/after/);
		await expect(call(token, { from: "2026-02-30" })).rejects.toThrow();
	});

	it("401s without a valid token", async () => {
		await expect(call("tmk_not_a_real_token")).rejects.toThrow();
	});
});
