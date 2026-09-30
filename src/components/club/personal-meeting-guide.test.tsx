// @vitest-environment jsdom
//
// The role guide on the personal meeting page (#933): duties first, then each
// held role's Before/During guide, expanded by meeting phase — tested for
// before the day, on the day, and after it — plus the PDF link and the
// description fallback.
//
// The clock is pinned with `toFake: ["Date"]` only, so the router harness's
// own timers keep running; the club is on UTC so "the day" is unambiguous.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleGuideSource } from "#/lib/role-guide";
import { roleSeed } from "#/lib/role-template";

vi.mock("#/server/availability", () => ({
	markUnavailableReleasing: vi.fn(async () => ({ ok: true, released: 0 })),
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: vi.fn(async () => ({ ok: true, confirmedRoles: [] })),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const { PersonalMeetingBody } = await import("./personal-meeting-body");
type PersonalMeetingView =
	import("#/server/personal-meeting").PersonalMeetingView;

const NOW = new Date("2026-10-06T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const MEETING_UUID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const TMOD = roleSeed("Toastmaster of the Day");
const SPEAKER = roleSeed("Speaker");

const GUIDES: RoleGuideSource[] = [
	{ ...TMOD, name: "Toastmaster" },
	{ ...SPEAKER },
	{
		name: "Sergeant-at-Arms",
		key: "sergeant_at_arms",
		description: "Opens the meeting and keeps the room in order.",
		beforeNotes: null,
		duringNotes: null,
	},
];

function makeView(
	scheduledAt: Date,
	roles: PersonalMeetingView["roles"],
	status: PersonalMeetingView["meeting"]["status"] = "scheduled",
): PersonalMeetingView {
	return {
		club: {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Harbor City Speakers",
			timezone: "UTC",
		},
		meeting: {
			id: MEETING_UUID,
			scheduledAt,
			theme: null,
			wordOfTheDay: null,
			tableTopicsNotes: null,
			status,
		},
		member: { id: "33333333-3333-4333-8333-333333333333", name: "Marcus Lee" },
		roles,
		planStatus: null,
	};
}

const tmodRole = {
	slotId: "44444444-4444-4444-8444-444444444444",
	roleName: "Toastmaster",
	roleKey: "toastmaster_of_the_day",
	speechTitle: null,
	status: "claimed" as const,
};
const speakerRole = {
	slotId: "55555555-5555-4555-8555-555555555555",
	roleName: "Speaker",
	roleKey: "speaker",
	speechTitle: null,
	status: "confirmed" as const,
};
const customRole = {
	slotId: "66666666-6666-4666-8666-666666666666",
	roleName: "Sergeant-at-Arms",
	roleKey: "sergeant_at_arms",
	speechTitle: null,
	status: "confirmed" as const,
};

async function renderInRouter(node: ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{node}</> });
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/meeting/$meetingId",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

async function renderBody(view: PersonalMeetingView) {
	await renderInRouter(
		<PersonalMeetingBody
			view={view}
			clubId="harbor-city"
			meetingId="2026-10-13"
			onChanged={async () => {}}
			onNotYou={() => {}}
			canRepick
			roleGuides={GUIDES}
		/>,
	);
}

/** The card for one held role, found by its h3. */
function card(roleName: string): HTMLElement {
	const heading = screen.getByRole("heading", { level: 3, name: roleName });
	return heading.parentElement as HTMLElement;
}

function half(root: HTMLElement, label: string): HTMLDetailsElement {
	return within(root)
		.getByText(label, { selector: "summary" })
		.closest("details") as HTMLDetailsElement;
}

describe("the guide on /me, by meeting phase", () => {
	it("before the meeting day: Before open, During collapsed", async () => {
		await renderBody(makeView(new Date(NOW.getTime() + 7 * DAY), [tmodRole]));
		const c = card("Toastmaster");
		expect(half(c, "Before the meeting").open).toBe(true);
		expect(half(c, "During the meeting").open).toBe(false);
	});

	it("on the meeting day: it flips", async () => {
		await renderBody(
			makeView(new Date(NOW.getTime() + 3 * 60 * 60 * 1000), [tmodRole]),
		);
		const c = card("Toastmaster");
		expect(half(c, "Before the meeting").open).toBe(false);
		expect(half(c, "During the meeting").open).toBe(true);
	});

	it("after the meeting: both collapsed", async () => {
		await renderBody(makeView(new Date(NOW.getTime() - 2 * DAY), [tmodRole]));
		const c = card("Toastmaster");
		expect(half(c, "Before the meeting").open).toBe(false);
		expect(half(c, "During the meeting").open).toBe(false);
	});

	it("a completed meeting today counts as after", async () => {
		await renderBody(
			makeView(
				new Date(NOW.getTime() - 60 * 60 * 1000),
				[tmodRole],
				"completed",
			),
		);
		const c = card("Toastmaster");
		expect(half(c, "During the meeting").open).toBe(false);
	});
});

describe("the guide on /me, content", () => {
	it("puts the duties FIRST, then the guide", async () => {
		await renderBody(makeView(new Date(NOW.getTime() + 7 * DAY), [tmodRole]));
		const c = card("Toastmaster");
		const duty = within(c).getByRole("link", {
			name: /Set the meeting theme/i,
		});
		const guide = within(c).getByText("Before the meeting", {
			selector: "summary",
		});
		expect(
			duty.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("matches a renamed role by key and shows the club's text", async () => {
		await renderBody(makeView(new Date(NOW.getTime() + 7 * DAY), [tmodRole]));
		const firstStep = TMOD.beforeNotes.split("\n")[0] ?? "";
		expect(within(card("Toastmaster")).getByText(firstStep)).toBeTruthy();
	});

	it("links the meeting-aware PDF script for a role with a sheet", async () => {
		await renderBody(makeView(new Date(NOW.getTime() + 7 * DAY), [tmodRole]));
		const link = within(card("Toastmaster")).getByRole("link", {
			name: /Full script \(PDF\)/,
		});
		expect(link.getAttribute("href")).toBe(
			`/api/meetings/${MEETING_UUID}/role-sheets/toastmaster/pdf`,
		);
	});

	it("shows no PDF link for a role without a sheet", async () => {
		await renderBody(
			makeView(new Date(NOW.getTime() + 7 * DAY), [speakerRole]),
		);
		const c = card("Speaker");
		expect(
			within(c).getByText("Before the meeting", { selector: "summary" }),
		).toBeTruthy();
		expect(within(c).queryByRole("link", { name: /Full script/ })).toBeNull();
	});

	it("falls back to the description, with no empty headers, for a role with no guide", async () => {
		await renderBody(makeView(new Date(NOW.getTime() + 7 * DAY), [customRole]));
		const c = card("Sergeant-at-Arms");
		expect(
			within(c).getByText("Opens the meeting and keeps the room in order."),
		).toBeTruthy();
		expect(within(c).queryByText("Before the meeting")).toBeNull();
		expect(within(c).queryByText("During the meeting")).toBeNull();
	});

	it("shows only the duties for a role the guide does not list", async () => {
		await renderBody(
			makeView(new Date(NOW.getTime() + 7 * DAY), [
				{ ...customRole, roleName: "Disabled role", roleKey: "gone" },
			]),
		);
		const c = card("Disabled role");
		expect(within(c).queryByText("During the meeting")).toBeNull();
		expect(within(c).getAllByRole("listitem")).toHaveLength(1);
	});
});
