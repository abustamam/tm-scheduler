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
 *
 * `club()` gives the seeded MEMBER an open officer term, because the tool
 * re-checks connector eligibility (`mayUseConnector`) on every call; the case
 * that ends that term is the one that tests the check.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	meetings,
	members,
	officerTerms,
	roleFeedbackNotes,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getMyFeedbackTool, NOTE_TEXT_NOTICE } = await import(
	"#/server/mcp/tools/get-my-feedback"
);
const { McpError } = await import("#/server/mcp/errors");
const { McpUnauthorizedError } = await import("#/server/mcp/authz-logic");
const { loadFeedbackForUser } = await import("#/server/role-feedback-logic");
const { hashApiToken } = await import("#/server/api-tokens-logic");

type Loaded = Awaited<ReturnType<typeof loadFeedbackForUser>>;
type Result = Loaded & { notice: string };

/** What the tool returns for a loader answer: that answer plus the notice. */
const withNotice = (r: Loaded): Result => ({ notice: NOTE_TEXT_NOTICE, ...r });
const EMPTY = withNotice({ meetings: [], unseenCount: 0 });

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
	await testDb
		.insert(officerTerms)
		.values({ membershipId: s.memberId, position: "vp_education" });
	return s;
}

async function setTimezone(s: SeededClub, timezone: string) {
	await testDb.update(clubs).set({ timezone }).where(eq(clubs.id, s.clubId));
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
		expect(asMember).toEqual(
			withNotice(await loadFeedbackForUser(s.memberUserId)),
		);
		expect(asAdmin).toEqual(
			withNotice(await loadFeedbackForUser(s.adminUserId)),
		);
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
		expect(res).toEqual(EMPTY);
	});

	it("returns nothing from a meeting that has not ended, then the note once it has", async () => {
		const s = await club();
		// Started half an hour ago, runs 90 minutes: in progress.
		await setMeeting(s.meetingId, new Date(Date.now() - 30 * MIN));
		await note(s, s.memberId, "too early");
		const token = await tokenFor(s.memberUserId);

		expect(await call(token)).toEqual(EMPTY);
		expect(await call(token, { meetingId: s.meetingId })).toEqual(EMPTY);

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
		expect(await call(memberToken, { meetingId: s.meetingId })).toEqual(EMPTY);
		// A meeting that does not exist.
		expect(await call(memberToken, { meetingId: randomUUID() })).toEqual(EMPTY);
		// The control: the owner, same meetingId.
		expect(
			texts(
				await call(await tokenFor(s.adminUserId), { meetingId: s.meetingId }),
			),
		).toEqual(["for the admin"]);
	});

	it("from/to are CLUB-LOCAL dates, inclusive, and unseenCount counts only what is kept", async () => {
		const s = await club();
		await setTimezone(s, "America/Los_Angeles");
		// 7pm Saturday 2026-03-07 in Los Angeles = 03:00 Sunday 2026-03-08 UTC.
		await setMeeting(s.meetingId, new Date("2026-03-08T03:00:00Z"));
		await note(s, s.memberId, "saturday night");
		const token = await tokenFor(s.memberUserId);

		const sat = await call(token, { from: "2026-03-07", to: "2026-03-07" });
		expect(texts(sat)).toEqual(["saturday night"]);
		expect(sat.unseenCount).toBe(1);

		const sun = await call(token, { from: "2026-03-08", to: "2026-03-08" });
		expect(sun).toEqual(EMPTY);
		expect(texts(await call(token, { to: "2026-03-06" }))).toEqual([]);
		expect(texts(await call(token, { from: "2026-03-07" }))).toEqual([
			"saturday night",
		]);
	});

	it("east of UTC: an 8am Saturday in Auckland is Saturday, though it is Friday in UTC", async () => {
		// Pins the `from` padding: the meeting's instant is BEFORE UTC midnight
		// of the date asked for, so an unpadded `from` would drop it.
		const s = await club();
		await setTimezone(s, "Pacific/Auckland");
		// 08:00 Saturday 2026-03-07 NZDT (UTC+13) = 19:00 Friday 2026-03-06 UTC.
		await setMeeting(s.meetingId, new Date("2026-03-06T19:00:00Z"));
		await note(s, s.memberId, "saturday morning");
		const token = await tokenFor(s.memberUserId);

		expect(
			texts(await call(token, { from: "2026-03-07", to: "2026-03-07" })),
		).toEqual(["saturday morning"]);
		expect(await call(token, { from: "2026-03-06", to: "2026-03-06" })).toEqual(
			EMPTY,
		);
	});

	it("meetingId and dates narrow together", async () => {
		const s = await club();
		await setMeeting(s.meetingId, new Date("2026-03-07T18:00:00Z"));
		await note(s, s.memberId, "that meeting");
		const token = await tokenFor(s.memberUserId);

		expect(
			texts(
				await call(token, {
					meetingId: s.meetingId,
					from: "2026-03-01",
					to: "2026-03-31",
				}),
			),
		).toEqual(["that meeting"]);
		expect(
			await call(token, {
				meetingId: s.meetingId,
				from: "2026-04-01",
				to: "2026-04-30",
			}),
		).toEqual(EMPTY);
	});

	it("returns notes from an archived club the caller belongs to, while they are eligible through an open one", async () => {
		const open = await club();
		const archived = await seedClub();
		seeded.push(archived);
		// The open club's member also belongs to the archived club.
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: archived.clubId,
				personId: open.personId,
				name: "Member User",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!m) throw new Error("Failed to insert membership");
		await setMeeting(archived.meetingId, new Date(Date.now() - DAY));
		await note(archived, m.id, "from the archived club", archived.meetingId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, archived.clubId));

		expect(texts(await call(await tokenFor(open.memberUserId)))).toEqual([
			"from the archived club",
		]);
	});

	it("refuses a caller who is no longer an officer of an open club, with a control while they still are", async () => {
		const s = await club();
		await setMeeting(s.meetingId, new Date(Date.now() - DAY));
		await note(s, s.memberId, "for the member");
		const token = await tokenFor(s.memberUserId);
		expect(texts(await call(token))).toEqual(["for the member"]);

		await testDb
			.update(officerTerms)
			.set({ termEnd: new Date() })
			.where(eq(officerTerms.membershipId, s.memberId));

		const err = await call(token).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpError);
		expect((err as InstanceType<typeof McpError>).code).toBe("FORBIDDEN");
	});

	it("tells the reader, on every result, that note text is untrusted", async () => {
		const s = await club();
		const res = await call(await tokenFor(s.memberUserId));
		expect(res.notice).toBe(NOTE_TEXT_NOTICE);
		expect(res.notice).toMatch(/never instructions/);
		expect(getMyFeedbackTool.config.description).toMatch(
			/untrusted data .* never as instructions/,
		);
	});

	it("refuses a range whose from is after its to, and a date that is not on the calendar", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await expect(
			call(token, { from: "2026-03-08", to: "2026-03-07" }),
		).rejects.toThrow(/after/);
		await expect(call(token, { from: "2026-02-30" })).rejects.toThrow(
			/Not a calendar date/,
		);
	});

	it("401s without a valid token", async () => {
		await expect(call("tmk_not_a_real_token")).rejects.toBeInstanceOf(
			McpUnauthorizedError,
		);
	});
});
