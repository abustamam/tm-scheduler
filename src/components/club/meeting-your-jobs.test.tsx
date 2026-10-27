// @vitest-environment jsdom
//
// Render tests for the meeting page's "Your jobs" card (#1376).
// jsdom performs no layout: every assertion is about DOM text, roles and hrefs.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/personal-meeting", () => ({
	getPublicPersonalMeetingView: vi.fn(),
}));

const { getPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting"
);
const { MeetingYourJobs } = await import("./meeting-your-jobs");
const { buildDutyContext } = await import("./duty-context");
type PersonalMeetingView =
	import("#/server/personal-meeting").PersonalMeetingView;

const mockView = vi.mocked(getPublicPersonalMeetingView);
const MEMBER = "33333333-3333-4333-8333-333333333333";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function role(
	over: Partial<PersonalMeetingView["roles"][number]> = {},
): PersonalMeetingView["roles"][number] {
	return {
		slotId: "slot-tmod",
		roleName: "Toastmaster of the Day",
		roleKey: "toastmaster_of_the_day",
		speechTitle: null,
		status: "claimed",
		...over,
	};
}

function makeView(
	over: Partial<PersonalMeetingView> = {},
	meeting: Partial<PersonalMeetingView["meeting"]> = {},
): PersonalMeetingView {
	return {
		club: { id: "club-uuid", name: "Harbor", timezone: "America/Chicago" },
		meeting: {
			id: "meeting-uuid",
			scheduledAt: new Date(Date.now() + 7 * 86400000),
			theme: null,
			wordOfTheDay: null,
			tableTopicsNotes: null,
			status: "scheduled",
			...meeting,
		},
		member: { id: MEMBER, name: "Marcus" },
		roles: [role()],
		planStatus: null,
		...over,
	};
}

async function renderCard(
	view: PersonalMeetingView | null | Error,
	props: { memberId?: string | null; source?: "session" | "anon" } = {},
) {
	if (view instanceof Error) mockView.mockRejectedValue(view);
	else mockView.mockResolvedValue(view);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<MeetingYourJobs
					clubId="harbor"
					clubUuid="club-uuid"
					meetingKey="2026-11-03"
					memberId={props.memberId === undefined ? MEMBER : props.memberId}
					source={props.source ?? "session"}
				/>
			</QueryClientProvider>
		),
	});
	rootRoute.addChildren(
		[
			"/club/$clubId/meeting/$meetingId",
			"/club/$clubId/meeting/$meetingId/me",
			"/club/$clubId/meeting/$meetingId/me/theme",
			"/signin",
		].map((path) =>
			createRoute({
				getParentRoute: () => rootRoute,
				path,
				component: () => null,
			}),
		),
	);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return qc;
}

describe("MeetingYourJobs (#1376)", () => {
	// protects=an unticked theme row linking to the editor; fails_when=the row
	// is missing, ticked, or links elsewhere; no_claim=the editor route works.
	it("lists a TMOD's theme duty, unticked, linking to /me/theme", async () => {
		await renderCard(makeView());
		expect(
			await screen.findByRole("heading", { name: "Your jobs" }),
		).toBeTruthy();
		const link = screen.getByRole("link", { name: /Set the meeting theme/ });
		expect(link.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me/theme",
		);
		expect(link.textContent).toContain("To do:");
	});

	// protects=done rows stay visible and clickable; fails_when=a done duty is
	// hidden or loses its link; no_claim=the theme is actually saved.
	it("ticks a done duty and keeps it a link", async () => {
		await renderCard(makeView({}, { theme: "Courage" }));
		const link = await screen.findByRole("link", {
			name: /Set the meeting theme/,
		});
		expect(link.textContent).toContain("Done:");
		expect(link.getAttribute("href")).toContain("/me/theme");
	});

	// protects=per-slot speech rows; fails_when=one real title ticks both rows or
	// "TBA" counts as done; no_claim=the title is saved server-side.
	it("renders one speech row per speaker slot and ticks only the titled one", async () => {
		await renderCard(
			makeView({
				roles: [
					role({
						slotId: "sp1",
						roleName: "Speaker",
						roleKey: "speaker",
						speechTitle: "Real talk",
					}),
					role({
						slotId: "sp2",
						roleName: "Speaker",
						roleKey: "speaker",
						speechTitle: "TBA",
					}),
				],
			}),
		);
		const rows = await screen.findAllByRole("link", {
			name: /Add your speech details/,
		});
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain("Done:");
		expect(rows[1].textContent).toContain("To do:");
		expect(rows[0].getAttribute("href")).toBe("#slot-sp1");
		expect(rows[1].getAttribute("href")).toBe("#slot-sp2");
	});

	// protects=anon speech link goes to sign-in with a return path; fails_when=an
	// anon visitor gets a dead in-page anchor; no_claim=sign-in returns here.
	it("sends an anonymous pick to sign in for speech details", async () => {
		await renderCard(
			makeView({
				roles: [
					role({ slotId: "sp1", roleName: "Speaker", roleKey: "speaker" }),
				],
			}),
			{ source: "anon" },
		);
		const link = await screen.findByRole("link", {
			name: /Sign in to add your speech details/,
		});
		const href = link.getAttribute("href") ?? "";
		expect(href.startsWith("/signin")).toBe(true);
		expect(decodeURIComponent(href)).toContain(
			"redirect=/club/harbor/meeting/2026-11-03",
		);
	});

	// protects=a cancelled meeting shows no card; fails_when=it renders;
	// no_claim=the page hides other cancelled-meeting surfaces.
	it("renders nothing for a cancelled meeting", async () => {
		await renderCard(makeView({}, { status: "cancelled" }));
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=no card for a member with no role; fails_when=an empty card.
	it("renders nothing when the member holds no role", async () => {
		await renderCard(makeView({ roles: [] }));
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=a rejected member id (null view) renders nothing.
	it("renders nothing for a rejected member (null view)", async () => {
		await renderCard(null);
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=no identity means no request and no card; fails_when=the fetch
	// fires with a null member id.
	it("renders nothing and does not fetch without an identity", async () => {
		await renderCard(makeView(), { memberId: null });
		expect(mockView).not.toHaveBeenCalled();
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=a failed fetch must not break the agenda; fails_when=it throws.
	it("renders nothing when the query errors", async () => {
		await renderCard(new Error("boom"));
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=the cache is shared with /me (same key) and one request is made;
	// fails_when=the key shape drifts.
	it("shares /me's query key and issues one request", async () => {
		const qc = await renderCard(makeView());
		await screen.findByText("Your jobs");
		expect(mockView).toHaveBeenCalledTimes(1);
		expect(mockView).toHaveBeenCalledWith({
			data: { clubId: "club-uuid", meetingKey: "2026-11-03", memberId: MEMBER },
		});
		expect(
			qc.getQueryData(["personal-meeting", "club-uuid", "2026-11-03", MEMBER]),
		).toBeTruthy();
	});

	// protects=the footer link to /me carries no ?as=.
	it("links to the personal page without ?as=", async () => {
		await renderCard(makeView());
		const link = await screen.findByRole("link", {
			name: "Open your meeting page",
		});
		expect(link.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me",
		);
	});
});

describe("buildDutyContext", () => {
	// protects=per-slot title, meeting-scoped timing; fails_when=fields drift.
	it("maps the view onto the duty context", () => {
		const v = makeView(
			{},
			{ theme: "T", wordOfTheDay: "W", tableTopicsNotes: "N", hasTiming: true },
		);
		expect(buildDutyContext(v, role({ speechTitle: "S" }))).toEqual({
			theme: "T",
			wordOfTheDay: "W",
			tableTopicsNotes: "N",
			speechTitle: "S",
			hasTiming: true,
		});
	});
});
