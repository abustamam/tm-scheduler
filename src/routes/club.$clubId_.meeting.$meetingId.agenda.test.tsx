// @vitest-environment jsdom
// The digital agenda's loader and route wiring (#1335).
// Each test's card: protects=...; fails_when=...; no_claim=...
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
// The server-side session readers: the loader must never call them (AC 5).
vi.mock("#/server/auth-context", () => ({ getAuthContext: vi.fn() }));
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
// Wraps the real seam so the route's props plumbing can be read off the call.
vi.mock("#/lib/agenda-runsheet", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/agenda-runsheet")>();
	return { ...actual, resolveAgendaRows: vi.fn(actual.resolveAgendaRows) };
});

import { notFound } from "@tanstack/react-router";
import { applyFlex, resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildTimeline } from "#/lib/agenda-timing";
import { auth } from "#/lib/auth";
import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getAuthContext } from "#/server/auth-context";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getPublicClubRoles } from "#/server/role-definitions";
import { readSource } from "#/test/guard-source";
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
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

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
	// fails_when=the loader branches on the viewer through either server-side session reader;
	// no_claim=a reader this test does not mock is caught only by the source check below
	it("returns deep-equal data signed in and signed out, and calls no reader", async () => {
		const member = {
			user: { id: "u1", email: "member@example.test" },
			session: { id: "s1" },
		};
		vi.mocked(getAuthContext).mockResolvedValueOnce(member as never);
		vi.mocked(auth.api.getSession).mockResolvedValueOnce(member as never);
		const signedIn = await runLoader();
		vi.mocked(getAuthContext).mockResolvedValueOnce(null as never);
		vi.mocked(auth.api.getSession).mockResolvedValueOnce(null as never);
		const signedOut = await runLoader();
		expect(signedIn).toEqual(signedOut);
		expect(getAuthContext).not.toHaveBeenCalled();
		expect(auth.api.getSession).not.toHaveBeenCalled();
		expect(authClient.useSession).not.toHaveBeenCalled();
	});

	// protects=the route module itself cannot reach a session;
	// fails_when=the route imports any auth module or calls getSession (comments are ignored);
	// no_claim=the page component lives in another module, which may use the client hook
	it("imports no auth module and calls no getSession", () => {
		const src = readSource(
			resolve(__dirname, "club.$clubId_.meeting.$meetingId.agenda.tsx"),
		);
		expect(src.length).toBeGreaterThan(500);
		expect(src).not.toMatch(/["']#\/lib\/auth(?:-client)?["']/);
		expect(src).not.toMatch(/["']#\/server\/auth-context["']/);
		expect(src).not.toMatch(/getSession|getAuthContext|useSession/);
	});
});

describe("parity with /print through the route (AC 1)", () => {
	// A real template with section rows, a non-default flow and a zone where
	// UTC and local differ: 02:30Z on Jul 31 is 7:30 PM on Jul 30 in Los Angeles.
	const ZONE = "America/Los_Angeles";
	const beat = (o: Record<string, unknown>) => ({
		detail: null,
		minutes: 5,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		clubGoverned: false,
		...o,
	});
	const TEMPLATE = {
		roles: [
			{ key: "contestant", name: "Contestant", isSpeakerRole: true },
			{ key: "contest_chair", name: "Contest Chair", isSpeakerRole: false },
		],
		beats: [
			beat({
				id: "b0",
				sortOrder: 0,
				kind: "section",
				label: "Opening",
				minutes: 0,
			}),
			beat({
				id: "b1",
				sortOrder: 1,
				kind: "event",
				label: "Welcome",
				minutes: 10,
			}),
			beat({
				id: "b2",
				sortOrder: 2,
				kind: "section",
				label: "Contest",
				minutes: 0,
			}),
			beat({
				id: "b3",
				sortOrder: 3,
				kind: "role",
				label: "Contest chair",
				minutes: 15,
				roleKey: "contest_chair",
			}),
			beat({
				id: "b4",
				sortOrder: 4,
				kind: "role",
				label: "Contest speeches",
				minutes: 20,
				roleKey: "contestant",
			}),
			beat({
				id: "b5",
				sortOrder: 5,
				kind: "event",
				label: "Results",
				minutes: 5,
			}),
		],
	};
	const slotRow = (o: Record<string, unknown>) => ({
		category: "speaker",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		assigneeId: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...o,
	});
	const SLOTS = [
		slotRow({
			id: "chair",
			roleKey: "contest_chair",
			roleName: "Contest Chair",
			category: "leadership",
			assigneeName: "Faisal Ali",
		}),
		slotRow({
			id: "c0",
			roleKey: "contestant",
			roleName: "Contestant",
			isSpeakerRole: true,
			assigneeName: "Rehanna Khan",
		}),
		slotRow({
			id: "c1",
			roleKey: "contestant",
			roleName: "Contestant",
			isSpeakerRole: true,
			slotIndex: 1,
			assigneeName: "Jagpal Singh",
		}),
	];

	function payload() {
		const d = detail();
		d.meeting.scheduledAt = "2026-07-31T02:30:00Z";
		d.timezone = ZONE;
		d.geIntroducesFunctionaries = true;
		d.tableTopicsMinSeconds = 90;
		d.tableTopicsMaxSeconds = 150;
		d.template = TEMPLATE;
		d.slots = SLOTS;
		return d;
	}

	async function renderRoute() {
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(payload());
		vi.mocked(authClient.useSession).mockReturnValue({
			data: null,
			isPending: false,
		} as never);
		const loaded = await runLoader();
		vi.spyOn(Route, "useLoaderData").mockReturnValue(loaded as never);
		vi.spyOn(Route, "useParams").mockReturnValue(ctx.params as never);
		const Page = (
			Route.options as unknown as { component: () => React.ReactNode }
		).component;
		const qc = new QueryClient();
		const rootRoute = createRootRoute({
			component: () => (
				<QueryClientProvider client={qc}>
					<Page />
				</QueryClientProvider>
			),
		});
		const router = createRouter({
			routeTree: rootRoute,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		render(<RouterProvider router={router} />);
		await waitFor(() => expect(router.state.status).toBe("idle"));
		await screen.findByRole("heading", { level: 1 });
		return loaded;
	}

	const drawn = () =>
		Array.from(
			document.querySelectorAll('[data-testid="run-of-show"] > li'),
		).map((li) => {
			const h2 = li.querySelector("h2");
			if (h2) return { who: h2.textContent, time: null };
			return {
				who: li.querySelector("p.font-semibold")?.textContent,
				time: li.querySelector("span.tabular-nums")?.textContent,
			};
		});

	// protects=the phone's order, labels and clock times (sections included) equal the print seam's, fed what the ROUTE passes;
	// fails_when=the route drops or swaps a prop (template, timezone, flow flag, Table Topics window), or the page stops using the seam;
	// no_claim=does not render /print itself; the golden times below stand in for it
	it("draws the same rows, labels and times as the print seam, with non-default options", async () => {
		const loaded = await renderRoute();

		// Wiring: what the route handed the seam is what the loader produced.
		expect(resolveAgendaRows).toHaveBeenCalledWith(
			expect.objectContaining({
				geIntroducesFunctionaries: true,
				tableTopicsLimits: { minSeconds: 90, maxSeconds: 150 },
				template: TEMPLATE,
			}),
		);

		const expected = buildTimeline(
			applyFlex(
				resolveAgendaRows({
					geIntroducesFunctionaries: true,
					tableTopicsLimits: { minSeconds: 90, maxSeconds: 150 },
					template: TEMPLATE as never,
					slots: SLOTS as never,
				}),
				loaded.meeting.lengthMinutes,
			).rows,
			"2026-07-31T02:30:00Z",
			ZONE,
		).map((r) =>
			r.section
				? { who: r.who, time: null }
				: { who: r.roleLabel ?? r.who, time: r.time },
		);
		expect(drawn()).toEqual(expected);

		// Golden: literals, so a defect on both sides cannot hide.
		expect(drawn()).toEqual([
			{ who: "Opening", time: null },
			{ who: "Welcome", time: "7:30" },
			{ who: "Contest", time: null },
			{ who: "Contest chair", time: "7:40" },
			{ who: "Contest speeches", time: "7:55" },
			{ who: "Results", time: "8:15" },
		]);
	});
});
