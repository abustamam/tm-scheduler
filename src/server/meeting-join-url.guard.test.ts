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
 * Covers: the two payload readers, over a real DB, and the same payload run
 * through seroval (the serializer TanStack Start dehydrates loader data with)
 * for a request that carries no cookie, so "signed out" is the absence of a
 * credential on the request and not a flag the test sets. The link pasted into
 * `location` / `notes` is scrubbed. No server fn returns the link behind a
 * self-asserted gate (see `meeting-join-url-no-editor-reader.guard.test.ts`).
 * Does NOT cover: a real browser (`credentials: "omit"`, the HTTP response
 * body), nor Better Auth resolving a real cookie: the session lookup is
 * mocked, reading the request's cookie. The exceptions, `submitGuestRsvp`'s
 * confirmation and the member RSVP, are covered by their own tests.
 */
import { randomUUID } from "node:crypto";
import { eq, getTableColumns } from "drizzle-orm";
import { serialize } from "seroval";
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

// The session is a cookie on the request: signed out is a request WITHOUT one.
// `signInAs` sets it, `signOut` removes it, and the mocked `getSession` below
// reads it back off the headers it is handed.
const request = { headers: new Headers() };
function signInAs(userId: string | null) {
	request.headers = new Headers(userId ? { cookie: `uid=${userId}` } : {});
}
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async ({ headers }: { headers: Headers }) => {
				const uid = /uid=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
				return uid ? { user: { id: uid } } : null;
			},
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

describe("the link pasted into free text", () => {
	// protects=a club that pasted its video link into location, notes or a
	//   reminder does not hand it to a non-member through them.
	// fails_when=nonMemberMeetingRow keeps those fields as stored, or only strips
	//   the exact stored spelling (a trailing slash, no scheme or another case).
	it("takes the link out of location, notes and reminders, in any spelling", () => {
		const row = {
			id: "m",
			joinUrl: JOIN_URL,
			location: `Room 4 or ${JOIN_URL}`,
			notes: `Join here: ${JOIN_URL}/ \nBring a pen`,
			reminders: `${JOIN_URL.replace("https://", "").toUpperCase()}`,
			promoNote: "Come and see us",
		};
		const out = nonMemberMeetingRow(row);
		expect(JSON.stringify(out).toLowerCase()).not.toContain("secret-room-4471");
		// A place that held the link is dropped, not left half-sentenced.
		expect(out.location).toBeNull();
		expect(out.notes).toBe("Join here:\nBring a pen");
		expect(out.reminders).toBeNull();
		// Text that never held it is untouched.
		expect(out.promoNote).toBe("Come and see us");
	});

	it("leaves a row with no link, or text without it, as it was", () => {
		const row = { id: "m", location: "12 Main St", notes: "Hi", joinUrl: null };
		expect(nonMemberMeetingRow(row)).toEqual({
			id: "m",
			location: "12 Main St",
			notes: "Hi",
		});
	});
});

describe.skipIf(!hasTestDb)("the meeting detail payload", () => {
	let seeded: SeededClub | null = null;
	afterEach(async () => {
		signInAs(null);
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
			signInAs(user);
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

	// protects=D6(a) through the serializer: the dehydrated loader data of a
	//   request with no cookie holds neither the URL nor a joinUrl key, and a
	//   cookie-carrying member's does.
	// fails_when=the strip is skipped for a cookie-less request, or the URL rides
	//   a field the serializer emits.
	it("serialises without the URL for a request that carries no cookie", async () => {
		const s = await seed();
		signInAs(null);
		expect(request.headers.get("cookie")).toBeNull();
		for (const [name, read] of Object.entries(readers(s))) {
			const wire = serialize(await read());
			expect(wire, name).not.toContain(JOIN_URL);
			expect(wire, name).not.toContain("secret-room-4471");
			expect(wire, name).not.toContain("joinUrl");
		}
		signInAs(s.memberUserId);
		expect(serialize(await readers(s).getMeeting())).toContain(JOIN_URL);
	});

	// protects=the same, for a club that pasted the link into location / notes.
	// fails_when=the payload keeps location or notes verbatim for a stranger.
	it("does not leak the link through location or notes", async () => {
		const s = await seed();
		await testDb
			.update(meetings)
			.set({ location: JOIN_URL, notes: `Call in: ${JOIN_URL} (video)` })
			.where(eq(meetings.id, s.meetingId));
		for (const user of [null, randomUUID()]) {
			signInAs(user);
			for (const [name, read] of Object.entries(readers(s))) {
				const data = await read();
				expect(serialize(data), `${name} as ${user}`).not.toContain(
					"secret-room-4471",
				);
				expect(data.meeting.location).toBeNull();
				expect(data.meeting.notes).toBe("Call in: (video)");
			}
		}
		// A member still reads the stored text.
		signInAs(s.memberUserId);
		const member = await readers(s).getMeeting();
		expect(member.meeting.location).toBe(JOIN_URL);
	});

	// protects=the public reader never ships it, whoever is signed in.
	// fails_when=getPublicMeetingByKey starts reading the session's membership.
	it("never carries it on the public reader, even for a signed-in admin", async () => {
		const s = await seed();
		signInAs(s.adminUserId);
		const data = await readers(s).getPublicMeetingByKey();
		expect(JSON.stringify(data)).not.toContain(JOIN_URL);
	});

	// protects=D6(a), the member half: the page the link exists for still has it.
	// fails_when=the strip is applied to members and managers too.
	it("carries it for a member and for a manager", async () => {
		const s = await seed();
		for (const user of [s.memberUserId, s.adminUserId]) {
			signInAs(user);
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
		signInAs(null);
		expect((await readers(s).getMeeting()).hasJoinLink).toBe(false);
	});
});
