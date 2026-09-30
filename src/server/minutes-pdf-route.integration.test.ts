/**
 * GET /api/meetings/$id/minutes/pdf, and its `?view=guests` copy (#903),
 * against real Postgres with the route's real gates.
 *
 * The guest copy is what the officer attaches to the minutes email they now
 * send themselves, to a list that includes guests — some self-registered through
 * the public guest book. So two properties matter, and each is pinned here:
 *
 *   - the guest copy never carries the club's internal action items (#529);
 *   - asking for it changes WHAT is rendered, never WHO may have it: the gates
 *     (401 anonymous, 403 non-member, 403 member before completion, 404
 *     archived) are the same with and without the parameter.
 *
 * The session is faked at the library boundary, like
 * `club-export-route.integration.test.ts`: `getSessionUser`, `getMembership`,
 * `isReadableClub` and the renderer all run for real against the seeded rows.
 * `renderMinutesPdf` is wrapped (not replaced) so a test can read the audience
 * the route asked for.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { clubs, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { isUninflated, readPdfContent } from "#/test/pdf-content";

let sessionUserId: string | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => ({ headers: new Headers() }),
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/server/minutes-pdf-logic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./minutes-pdf-logic")>();
	return { ...actual, renderMinutesPdf: vi.fn(actual.renderMinutesPdf) };
});

const { Route } = await import("#/routes/api/meetings.$id.minutes.pdf");
const { renderMinutesPdf } = await import("#/server/minutes-pdf-logic");
const { createActionItem } = await import("#/server/action-items-logic");

type Get = (input: {
	request: Request;
	params: { id: string };
}) => Promise<Response>;
const GET = (
	Route as unknown as { options: { server: { handlers: { GET: Get } } } }
).options.server.handlers.GET;

async function download(
	meetingId: string,
	as: string | null,
	query = "",
): Promise<Response> {
	sessionUserId = as;
	return GET({
		request: new Request(
			`http://localhost/api/meetings/${meetingId}/minutes/pdf${query}`,
		),
		params: { id: meetingId },
	});
}

/** The audience of the ONE render the last request triggered. */
function renderedAudience(): string | undefined {
	const calls = vi.mocked(renderMinutesPdf).mock.calls;
	expect(calls).toHaveLength(1);
	return calls[0]?.[1];
}

/**
 * The text a PDF shows, one line per `TJ` array. react-pdf writes the minutes
 * in the standard Helvetica faces, so each glyph run is a hex string of
 * WinAnsi bytes inside a `[<hex> kern <hex> ...] TJ` array; joining a run's hex
 * chunks and decoding them as latin1 gives back the rendered line. Streams are
 * inflated by `readPdfContent` (node:zlib, no new dependency). An uninflatable
 * stream fails the test rather than reading as "text absent".
 */
function pdfText(bytes: Uint8Array): string {
	const { streams } = readPdfContent(bytes);
	const lines: string[] = [];
	for (const stream of streams) {
		if (isUninflated(stream)) continue; // fonts/images; asserted non-empty below
		for (const [, arr] of stream.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
			const hex = [...(arr ?? "").matchAll(/<([0-9a-fA-F]*)>/g)]
				.map((m) => m[1] ?? "")
				.join("");
			lines.push(Buffer.from(hex, "hex").toString("latin1"));
		}
	}
	expect(
		lines.length,
		"no text runs found; the extractor has drifted",
	).toBeGreaterThan(0);
	return lines.join("\n");
}

async function setStatus(meetingId: string, status: "scheduled" | "completed") {
	await testDb
		.update(meetings)
		.set({ status })
		.where(eq(meetings.id, meetingId));
}

/** A club-internal action item, unique per run. */
const ACTION_TOKEN = `ChaseLapsedMembers${randomUUID().slice(0, 8)}`;

describe.skipIf(!hasTestDb)("GET /api/meetings/$id/minutes/pdf (#903)", () => {
	let club: SeededClub;
	let other: SeededClub;
	let archived: SeededClub;

	beforeAll(async () => {
		[club, other, archived] = await Promise.all([
			seedClub(),
			seedClub(),
			seedClub(),
		]);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, archived.clubId));
		// Club business the guest copy must leave out, as one unbroken token so a
		// line wrap cannot split it in the rendered text.
		await createActionItem({ clubId: club.clubId, text: ACTION_TOKEN });
	});

	afterAll(async () => {
		for (const c of [club, other, archived]) {
			if (c) await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		sessionUserId = null;
	});

	beforeEach(async () => {
		vi.mocked(renderMinutesPdf).mockClear();
		await setStatus(club.meetingId, "scheduled");
	});

	it("serves an admin the guest copy, named as one", async () => {
		const res = await download(
			club.meetingId,
			club.adminUserId,
			"?view=guests",
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(renderedAudience()).toBe("guests");
		expect(res.headers.get("content-disposition")).toMatch(
			/ \(guest copy\)\.pdf"$/,
		);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
	});

	it("the guest copy leaves out the member-only action items (read from the PDF's text)", async () => {
		// THIS test holds the #529 property for the attachment path: the seeded
		// action item is in the member copy's rendered text and absent from the
		// guest copy's, read out of the bytes the route actually served.
		const member = pdfText(
			new Uint8Array(
				await (await download(club.meetingId, club.adminUserId)).arrayBuffer(),
			),
		);
		const guest = pdfText(
			new Uint8Array(
				await (
					await download(club.meetingId, club.adminUserId, "?view=guests")
				).arrayBuffer(),
			),
		);
		// The control: the extractor can see the token at all.
		expect(member).toContain(ACTION_TOKEN);
		expect(member).toContain("Action Items");
		// Same meeting, same club name — only the action items differ.
		expect(guest).toContain("Test Club");
		expect(guest).not.toContain(ACTION_TOKEN);
		expect(guest).not.toContain("Action Items");
	});

	it("a completed member's guest copy has no action items either", async () => {
		await setStatus(club.meetingId, "completed");
		const text = pdfText(
			new Uint8Array(
				await (
					await download(club.meetingId, club.memberUserId, "?view=guests")
				).arrayBuffer(),
			),
		);
		expect(text).toContain("Test Club");
		expect(text).not.toContain(ACTION_TOKEN);
	});

	it("serves an active member the guest copy once the meeting is completed", async () => {
		await setStatus(club.meetingId, "completed");
		const res = await download(
			club.meetingId,
			club.memberUserId,
			"?view=guests",
		);
		expect(res.status).toBe(200);
		expect(renderedAudience()).toBe("guests");
	});

	it("still refuses a member before the meeting is completed, with or without view", async () => {
		for (const q of ["", "?view=guests"]) {
			const res = await download(club.meetingId, club.memberUserId, q);
			expect(res.status, `query "${q}"`).toBe(403);
		}
		expect(renderMinutesPdf).not.toHaveBeenCalled();
	});

	it("still 403s a non-member, with or without view", async () => {
		await setStatus(club.meetingId, "completed");
		for (const q of ["", "?view=guests"]) {
			const res = await download(club.meetingId, other.adminUserId, q);
			expect(res.status, `query "${q}"`).toBe(403);
		}
		expect(renderMinutesPdf).not.toHaveBeenCalled();
	});

	it("still 401s without a session, with or without view", async () => {
		for (const q of ["", "?view=guests"]) {
			expect((await download(club.meetingId, null, q)).status).toBe(401);
		}
		expect(renderMinutesPdf).not.toHaveBeenCalled();
	});

	it("still 404s an archived club, even for its own admin asking for the guest copy", async () => {
		for (const q of ["", "?view=guests"]) {
			const res = await download(archived.meetingId, archived.adminUserId, q);
			expect(res.status, `query "${q}"`).toBe(404);
		}
		expect(renderMinutesPdf).not.toHaveBeenCalled();
	});

	it("serves the member copy with no view, unnamed as a guest copy", async () => {
		const res = await download(club.meetingId, club.adminUserId);
		expect(res.status).toBe(200);
		expect(renderedAudience()).toBe("members");
		expect(res.headers.get("content-disposition")).not.toContain("guest copy");
	});

	it.each([
		"?view=members",
		"?view=GUESTS",
		"?view=guest",
		"?view=",
		"?view=guests%20",
	])("serves the member copy for any other view value (%s)", async (q) => {
		const res = await download(club.meetingId, club.adminUserId, q);
		expect(res.status).toBe(200);
		expect(renderedAudience()).toBe("members");
	});
});
