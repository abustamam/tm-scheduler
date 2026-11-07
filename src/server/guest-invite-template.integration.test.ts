/**
 * Guest invite templates (#1547) against the real schema: who may write them,
 * normalization to NULL, per-kind reset, the invalid-value fallback, and the
 * invite context's `{joinLink}`.
 *
 * The server fns are called through a `createServerFn` stand-in so the real
 * `requireClubRole` / `requireClubAdminView` run against the database; only the
 * session lookup (`requireUser`) is replaced by `signedInAs`.
 * Does NOT cover: Better Auth resolving a real cookie.
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips without it.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings, members, officerTerms } from "#/db/schema";
import { DEFAULT_GUEST_INVITE_TEMPLATES } from "#/lib/guest-invite-template";
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

let signedInAs = "";
vi.mock("#/server/guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/server/guards")>()),
	requireUser: async () => ({ id: signedInAs }),
}));

const {
	getGuestInviteTemplates,
	resetGuestInviteTemplate,
	updateGuestInviteTemplates,
} = await import("#/server/guest-invite-template");
const { getGuestInviteContext } = await import("#/server/guest-pipeline");
const { loadNextMeetingSummary } = await import("#/server/meetings-logic");

type Call = (a: { data: unknown }) => Promise<unknown>;
const update = updateGuestInviteTemplates as unknown as Call;
const reset = resetGuestInviteTemplate as unknown as Call;
const read = getGuestInviteTemplates as unknown as Call;
const context = getGuestInviteContext as unknown as Call;

describe.skipIf(!hasTestDb)("guest invite templates (#1547)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		signedInAs = seed.adminUserId;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const stored = async () =>
		(
			await testDb
				.select({ t: clubs.guestInviteTemplates })
				.from(clubs)
				.where(eq(clubs.id, seed.clubId))
		)[0]?.t;

	const TEXT = {
		never: { body: "Hello {guestName}", subject: "Come to {club}" },
		lapsed: { body: "Miss you, {guestName}! Last here {lastVisit}." },
	};

	// protects=acceptance 5, the refusal half; fails_when=a plain member's write
	// lands or either server fn skips its gate; no_claim=a real session cookie.
	it("refuses a plain member on update and reset, and writes nothing", async () => {
		await update({ data: { clubId: seed.clubId, templates: TEXT } });
		signedInAs = seed.memberUserId;
		await expect(
			update({ data: { clubId: seed.clubId, templates: {} } }),
		).rejects.toThrow();
		await expect(
			reset({ data: { clubId: seed.clubId, kind: "never" } }),
		).rejects.toThrow();
		await expect(read({ data: seed.clubId })).rejects.toThrow();
		expect(await stored()).toEqual(TEXT);
	});

	// protects=acceptance 5, the allowed half (#202); fails_when=an open-term
	// officer with club_role=member is refused, or a CLOSED term still passes;
	// no_claim=none beyond protects.
	it("admits an open-term officer whose club_role is member, not a closed term", async () => {
		const [row] = await testDb
			.select({ role: members.clubRole })
			.from(members)
			.where(eq(members.id, seed.memberId));
		expect(row?.role).toBe("member");
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: seed.memberId,
				position: "vp_membership",
				termStart: new Date(Date.now() - 86_400_000),
				termEnd: null,
			})
			.returning({ id: officerTerms.id });
		signedInAs = seed.memberUserId;
		await update({ data: { clubId: seed.clubId, templates: TEXT } });
		expect(await stored()).toEqual(TEXT);
		await reset({ data: { clubId: seed.clubId, kind: "never" } });
		expect(await stored()).toEqual({ lapsed: TEXT.lapsed });

		await testDb
			.update(officerTerms)
			.set({ termEnd: new Date(Date.now() - 1000) })
			.where(eq(officerTerms.id, term?.id ?? ""));
		await expect(
			update({ data: { clubId: seed.clubId, templates: {} } }),
		).rejects.toThrow();
	});

	// protects=acceptance 6; fails_when=a default or blank field is stored, an
	// emptied draft survives, or all-default is not null;
	// no_claim=none beyond protects.
	it("stores no entry for a default or blank field, and null when none is left", async () => {
		await update({
			data: {
				clubId: seed.clubId,
				templates: {
					never: {
						body: DEFAULT_GUEST_INVITE_TEMPLATES.never.body,
						subject: "  ",
					},
					lapsed: {
						body: "Custom {club}",
						subject: DEFAULT_GUEST_INVITE_TEMPLATES.lapsed.subject,
					},
				},
			},
		});
		expect(await stored()).toEqual({ lapsed: { body: "Custom {club}" } });

		await update({
			data: {
				clubId: seed.clubId,
				templates: {
					firstRecent: {
						body: DEFAULT_GUEST_INVITE_TEMPLATES.firstRecent.body,
						subject: DEFAULT_GUEST_INVITE_TEMPLATES.firstRecent.subject,
					},
					lapsed: { body: "" },
				},
			},
		});
		expect(await stored()).toBeNull();
	});

	// protects=acceptance 7; fails_when=reset clears other kinds or does nothing;
	// no_claim=none beyond protects.
	it("resets only the named kind", async () => {
		await update({
			data: {
				clubId: seed.clubId,
				templates: { ...TEXT, repeatRecent: { subject: "Again {club}" } },
			},
		});
		await reset({ data: { clubId: seed.clubId, kind: "never" } });
		expect(await stored()).toEqual({
			lapsed: TEXT.lapsed,
			repeatRecent: { subject: "Again {club}" },
		});
		await reset({ data: { clubId: seed.clubId, kind: "lapsed" } });
		await reset({ data: { clubId: seed.clubId, kind: "repeatRecent" } });
		expect(await stored()).toBeNull();
	});

	// protects=acceptance 8; fails_when=a value failing the schema throws or is
	// returned half-parsed; no_claim=the page itself (see vp-membership.test.tsx).
	it("reads a stored value that fails the schema as {}", async () => {
		for (const bad of [
			{ lapsed: "oops" },
			{ never: { body: "x".repeat(1001) } },
		]) {
			await testDb
				.update(clubs)
				.set({ guestInviteTemplates: bad })
				.where(eq(clubs.id, seed.clubId));
			expect(await read({ data: seed.clubId })).toEqual({});
		}
	});

	// protects=acceptance 4; fails_when=the invite context omits the next
	// meeting's link, reads another meeting's, or the shared summary grows a join
	// field; no_claim=a real browser.
	describe("the invite context's joinLink", () => {
		const ROOM = `https://zoom.example/j/${randomUUID()}`;

		it("carries the next meeting's link, and null when it has none", async () => {
			expect(
				((await context({ data: seed.clubId })) as { joinLink: unknown })
					.joinLink,
			).toBeNull();
			await testDb
				.update(meetings)
				.set({ joinUrl: ` ${ROOM} ` })
				.where(eq(meetings.id, seed.meetingId));
			const ctx = (await context({ data: seed.clubId })) as {
				joinLink: string | null;
				nextMeeting: { id: string } | null;
			};
			expect(ctx.joinLink).toBe(ROOM);
			expect(ctx.nextMeeting?.id).toBe(seed.meetingId);
		});

		it("refuses a non-officer", async () => {
			signedInAs = seed.memberUserId;
			await expect(context({ data: seed.clubId })).rejects.toThrow();
		});

		it("loadNextMeetingSummary never carries the link", async () => {
			await testDb
				.update(meetings)
				.set({ joinUrl: ROOM })
				.where(eq(meetings.id, seed.meetingId));
			const summary = await loadNextMeetingSummary(seed.clubId, new Date());
			expect(JSON.stringify(summary)).not.toContain(ROOM);
			expect(Object.keys(summary)).not.toContain("joinLink");
			expect(Object.keys(summary.nextMeeting ?? {})).not.toContain("joinUrl");
			// Type level: the summary has no join field to read.
			// @ts-expect-error `joinLink` is not on the shared summary
			summary.joinLink;
		});
	});
});
