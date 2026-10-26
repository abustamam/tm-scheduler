// The digital agenda's loader (#1335).
// Each test's card: protects=...; fails_when=...; no_claim=...
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/server/role-definitions", () => ({ getPublicClubRoles: vi.fn() }));
// Reached through the page component; the loader must never call either.
vi.mock("#/lib/auth-client", () => ({
	authClient: { useSession: vi.fn() },
}));
vi.mock("#/server/ballot-session-voter", () => ({
	getBallotSessionVoter: vi.fn(),
}));

import { notFound } from "@tanstack/react-router";
import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getPublicClubRoles } from "#/server/role-definitions";
import { Route } from "./club.$clubId_.meeting.$meetingId.agenda";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const ctx = {
	params: { clubId: "downtown", meetingId: "2026-07-31" },
	location: { href: "/club/downtown/meeting/2026-07-31/agenda" },
};

// biome-ignore lint/suspicious/noExplicitAny: loader union has no call signature
const runLoader = (): Promise<any> => (Route.options as any).loader(ctx);

const isNotFound = (e: unknown) =>
	typeof e === "object" && e !== null && "isNotFound" in e;

function detail(status = "scheduled", clubId = CLUB_ID) {
	return {
		meeting: {
			id: MEETING_ID,
			clubId,
			status,
			scheduledAt: "2026-07-31T18:45:00Z",
			lengthMinutes: 60,
			location: "Room 4",
			theme: null,
			joinUrl: "https://zoom.example/j/secret-1335",
			notes: "private organizer note 1335",
		},
		slots: [],
		timezone: "UTC",
		clubName: "Downtown Toastmasters",
		geIntroducesFunctionaries: false,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
		template: null,
		nextMeeting: null,
		// biome-ignore lint/suspicious/noExplicitAny: partial payload is enough
	} as any;
}

beforeEach(() => {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		name: "Downtown Toastmasters",
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
	} as any);
	vi.mocked(getClubLogoMeta).mockResolvedValue(null);
	vi.mocked(getPublicClubRoles).mockResolvedValue([]);
	vi.mocked(getPublicMeetingByKey).mockResolvedValue(detail());
});
afterEach(() => vi.clearAllMocks());

describe("404s", () => {
	// protects=a mistyped key is the not-found page, not a 500;
	// fails_when=the not-found error is not translated;
	// no_claim=says nothing about non-not-found failures
	it("an unknown meeting key is a 404", async () => {
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(
			new Error("Meeting not found."),
		);
		await expect(runLoader()).rejects.toSatisfy(isNotFound);
	});

	// protects=a real failure is not disguised as "wrong link";
	// fails_when=every error becomes a 404;
	// no_claim=none
	it("rethrows any other failure", async () => {
		const boom = new Error("connection terminated");
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(boom);
		await expect(runLoader()).rejects.toBe(boom);
	});

	// protects=another club's meeting never renders under this club's name;
	// fails_when=the cross-club check is dropped;
	// no_claim=says nothing about how the reader scopes by club
	it("a meeting from another club is a 404", async () => {
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(
			detail("scheduled", "99999999-9999-4999-8999-999999999999"),
		);
		await expect(runLoader()).rejects.toSatisfy(isNotFound);
	});

	// protects=an archived club's agenda is not served (club resolution refuses it);
	// fails_when=the loader swallows the refusal and goes on to read the meeting;
	// no_claim=does not exercise resolveClubOrRedirect's own archive logic
	it("an archived club is a 404 and reads nothing", async () => {
		vi.mocked(resolveClubOrRedirect).mockRejectedValue(notFound());
		await expect(runLoader()).rejects.toSatisfy(isNotFound);
		expect(getPublicMeetingByKey).not.toHaveBeenCalled();
	});
});

describe("payload", () => {
	// protects=cancelled is derived from the meeting status;
	// fails_when=the flag is hardcoded or reads another field;
	// no_claim=says nothing about how the page draws it
	it.each([
		["cancelled", true],
		["scheduled", false],
	])("a %s meeting yields cancelled=%s", async (status, expected) => {
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(detail(status));
		await expect(runLoader()).resolves.toMatchObject({ cancelled: expected });
	});

	// protects=descriptions are keyed by role key, else name, and blanks are dropped;
	// fails_when=a null description is kept, or a keyless role is lost;
	// no_claim=says nothing about which row shows which description
	it("keys role descriptions by key, then name, only when set", async () => {
		vi.mocked(getPublicClubRoles).mockResolvedValue([
			{ key: "timer", name: "Timer", description: "Keeps time." },
			{ key: null, name: "Hype Person", description: "Warms the room." },
			{ key: "speaker", name: "Speaker", description: null },
		] as never);
		const { roleDescriptions } = await runLoader();
		expect(roleDescriptions).toEqual({
			timer: "Keeps time.",
			"Hype Person": "Warms the room.",
		});
	});

	// protects=a failing roles read costs nobody the agenda;
	// fails_when=the rejection propagates;
	// no_claim=says nothing about retrying
	it("still loads when the roles fetch fails", async () => {
		vi.mocked(getPublicClubRoles).mockRejectedValue(new Error("db down"));
		const data = await runLoader();
		expect(data.roleDescriptions).toEqual({});
		expect(data.clubName).toBe("Downtown Toastmasters");
	});

	// protects=the join link and organizer notes never ride the payload;
	// fails_when=the payload spreads the whole meeting row;
	// no_claim=the full allowlist is the guard test's job
	it("ships neither the join link nor the notes", async () => {
		const shipped = JSON.stringify(await runLoader());
		expect(shipped).not.toContain("zoom.example");
		expect(shipped).not.toContain("private organizer note 1335");
	});
});

describe("the loader reads no session (AC 5)", () => {
	// protects=every visitor is served the same data, so the HTML is cacheable and hydrates;
	// fails_when=the loader branches on the viewer, or touches the auth client;
	// no_claim=the auth mock is not wired into the loader, so equality is by construction plus the source check below
	it("returns deep-equal data signed in and signed out", async () => {
		vi.mocked(authClient.useSession).mockReturnValue({
			data: { user: { id: "u1" } },
			isPending: false,
		} as never);
		const signedIn = await runLoader();
		vi.mocked(authClient.useSession).mockReturnValue({
			data: null,
			isPending: false,
		} as never);
		const signedOut = await runLoader();
		expect(signedIn).toEqual(signedOut);
		expect(authClient.useSession).not.toHaveBeenCalled();
	});

	// protects=the route module itself cannot reach a session;
	// fails_when=an import of the server auth context or the auth client is added to the route;
	// no_claim=the page component lives in another module, which may use the client hook
	it("imports nothing from auth-context or auth-client", () => {
		const src = readFileSync(
			resolve(__dirname, "club.$clubId_.meeting.$meetingId.agenda.tsx"),
			"utf8",
		);
		expect(src).not.toMatch(/from\s+["']#\/server\/auth-context["']/);
		expect(src).not.toMatch(/from\s+["']#\/lib\/auth-client["']/);
		expect(src.length).toBeGreaterThan(500);
	});
});
