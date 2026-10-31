/**
 * The video-call link reaches a MEMBER of the club and no one else (#1444, D6).
 *
 * Two halves. The SCHEMA half holds the allowlist honest: every `meetings`
 * column is either named in `NON_MEMBER_MEETING_FIELDS` or withheld on purpose,
 * so a column added next year is withheld from strangers until someone decides.
 * The PAYLOAD half calls the real `getMeeting` and `getPublicMeetingByKey` and
 * asserts over what they return, the object TanStack Start serialises into the
 * served document, serialised here the same blunt way: the URL appears nowhere
 * in it for a non-member, signed in or not, and does for a member and a manager.
 *
 * Covers: the two payload readers, over a real DB. Does NOT cover the browser
 * round trip (credentials omit, seroval); the exceptions, `submitGuestRsvp`'s
 * confirmation and the member RSVP, are covered by their own tests.
 */
import { randomUUID } from "node:crypto";
import { eq, getTableColumns } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetings } from "#/db/schema";
import {
	NON_MEMBER_MEETING_FIELDS,
	nonMemberMeetingRow,
	WITHHELD_MEETING_FIELDS,
} from "#/lib/public-meeting-payload";
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

const { getMeeting, getPublicMeetingByKey } = await import("#/server/meetings");

const JOIN_URL = "https://meet.example/secret-room-4471";

describe("the allowlist", () => {
	// protects=D6(b): a meetings column is never silently shipped to a stranger.
	// fails_when=a column is added to the table and to neither list, or joinUrl is
	// moved into the allowlist.
	it("names every meetings column as allowed or withheld, and joinUrl as withheld", () => {
		const columns = Object.keys(getTableColumns(meetings)).sort();
		const allowed: readonly string[] = NON_MEMBER_MEETING_FIELDS;
		const withheld: readonly string[] = WITHHELD_MEETING_FIELDS;
		expect([...allowed, ...withheld].sort()).toEqual(columns);
		expect(withheld).toContain("joinUrl");
		expect(allowed).not.toContain("joinUrl");
	});

	// protects=the narrowing itself: joinUrl out, everything else through.
	// fails_when=nonMemberMeetingRow copies the row whole.
	it("drops the link and keeps the rest of the row", () => {
		const row = { id: "m", theme: "Hope", joinUrl: JOIN_URL, location: null };
		const out = nonMemberMeetingRow(row);
		expect(out).toEqual({ id: "m", theme: "Hope", location: null });
		expect("joinUrl" in out).toBe(false);
	});
});

describe.skipIf(!hasTestDb)("the meeting detail payload", () => {
	let seeded: SeededClub | null = null;
	afterEach(async () => {
		sessionUserId = null;
		if (!seeded) return;
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	});

	async function seed() {
		seeded = await seedClub();
		await testDb
			.update(meetings)
			.set({ joinUrl: JOIN_URL })
			.where(eq(meetings.id, seeded.meetingId));
		return seeded;
	}

	const readers = (s: SeededClub) => ({
		getMeeting: () => getMeeting({ data: s.meetingId }),
		getPublicMeetingByKey: () =>
			getPublicMeetingByKey({ data: { clubId: s.clubId, key: s.meetingId } }),
	});

	// protects=D6(a), the non-member half: nothing a stranger can read holds the
	// URL, and they are told a link exists so the page can offer the RSVP.
	// fails_when=either reader returns joinUrl, or the URL rides some other field.
	it("carries no join URL for a signed-out reader or a non-member, and says one exists", async () => {
		const s = await seed();
		for (const user of [null, randomUUID()]) {
			sessionUserId = user;
			for (const [name, read] of Object.entries(readers(s))) {
				const data = await read();
				expect(JSON.stringify(data), `${name} as ${user}`).not.toContain(
					JOIN_URL,
				);
				expect(Object.hasOwn(data.meeting, "joinUrl")).toBe(false);
				expect(data.hasJoinLink).toBe(true);
			}
		}
	});

	// protects=the public reader never ships it, whoever is signed in.
	// fails_when=getPublicMeetingByKey starts reading the session's membership.
	it("never carries it on the public reader, even for a signed-in admin", async () => {
		const s = await seed();
		sessionUserId = s.adminUserId;
		const data = await readers(s).getPublicMeetingByKey();
		expect(JSON.stringify(data)).not.toContain(JOIN_URL);
	});

	// protects=D6(a), the member half: the page the link exists for still has it.
	// fails_when=the strip is applied to members and managers too.
	it("carries it for a member and for a manager", async () => {
		const s = await seed();
		for (const user of [s.memberUserId, s.adminUserId]) {
			sessionUserId = user;
			const data = await readers(s).getMeeting();
			expect(data.meeting.joinUrl).toBe(JOIN_URL);
			expect(data.hasJoinLink).toBe(true);
		}
	});

	// protects=a meeting with no link says so, so no RSVP offer is made for it.
	it("reports no link when the meeting has none", async () => {
		const s = await seed();
		await testDb
			.update(meetings)
			.set({ joinUrl: null })
			.where(eq(meetings.id, s.meetingId));
		sessionUserId = null;
		expect((await readers(s).getMeeting()).hasJoinLink).toBe(false);
	});
});
