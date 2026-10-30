// @vitest-environment jsdom
//
// "Add to calendar" (#1423). jsdom performs no layout: assertions are about DOM
// text, roles, the Blob handed to the download and the URL handed to window.open.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/personal-meeting", () => ({
	getPublicPersonalMeetingView: vi.fn(),
}));
vi.mock("#/server/availability", () => ({
	markUnavailableReleasing: vi.fn(async () => ({ ok: true, released: 1 })),
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: vi.fn(async () => ({ ok: true, confirmedRoles: [] })),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const { getPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting"
);
const { AddToCalendarButton } = await import("./add-to-calendar-button");
const { MeetingYourJobs } = await import("./meeting-your-jobs");
const { PersonalMeetingBody } = await import("./personal-meeting-body");
type PersonalMeetingView =
	import("#/server/personal-meeting").PersonalMeetingView;

afterEach(() => {
	vi.useRealTimers();
	cleanup();
	vi.restoreAllMocks();
});
beforeEach(() => vi.clearAllMocks());

const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const PAST = new Date(Date.now() - 7 * 86_400_000);
const MEMBER = "33333333-3333-4333-8333-333333333333";

function button(over: Partial<Parameters<typeof AddToCalendarButton>[0]> = {}) {
	return (
		<AddToCalendarButton
			clubName="Harbor City"
			clubId="harbor"
			timezone="America/Chicago"
			meetingKey="2026-11-03"
			status="scheduled"
			scheduledAt={FUTURE}
			lengthMinutes={90}
			slotId="slot-1"
			roleName="Toastmaster"
			roleKey="toastmaster_of_the_day"
			{...over}
		/>
	);
}

function twoRoleView(status: "scheduled", at: Date) {
	const role = (slotId: string, roleName: string, roleKey: string) => ({
		slotId,
		roleName,
		roleKey,
		speechTitle: null,
		status: "claimed" as const,
	});
	return {
		club: { id: "club-uuid", name: "Harbor", timezone: "America/Chicago" },
		meeting: {
			id: "meeting-uuid",
			scheduledAt: at,
			lengthMinutes: 90,
			theme: null,
			wordOfTheDay: null,
			tableTopicsNotes: null,
			hasTiming: false,
			status,
		},
		member: { id: MEMBER, name: "Marcus" },
		roles: [
			role("slot-a", "Toastmaster", "toastmaster_of_the_day"),
			role("slot-b", "Timer", "timer"),
		],
		planStatus: null,
	} satisfies PersonalMeetingView;
}

async function inRouter(node: ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{node}</> });
	rootRoute.addChildren(
		[
			"/club/$clubId/meeting/$meetingId",
			"/club/$clubId/meeting/$meetingId/me",
			"/club/$clubId/meeting/$meetingId/me/theme",
			"/club/$clubId/meeting/$meetingId/me/word",
			"/club/$clubId/meeting/$meetingId/me/topics",
			"/club/$clubId/meeting/$meetingId/me/timer",
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
}

const triggers = () =>
	screen.queryAllByRole("button", { name: /add to calendar/i });

describe("AddToCalendarButton (#1423)", () => {
	// protects=one trigger for an upcoming meeting; fails_when=it is missing or
	// duplicated; no_claim=the menu contents (next test).
	it("renders one trigger for a scheduled, upcoming meeting", () => {
		render(button());
		expect(triggers()).toHaveLength(1);
	});

	// protects=no export for a cancelled or finished meeting; fails_when=either
	// still offers a calendar entry; no_claim=a completed-status meeting, which
	// `isMeetingOver` already covers by its own tests.
	it.each([
		["cancelled", FUTURE],
		["scheduled", PAST],
	] as const)("renders nothing for a %s meeting at %s", (status, at) => {
		render(button({ status, scheduledAt: at }));
		expect(triggers()).toHaveLength(0);
	});

	// protects=the download path when scheduledAt arrives as an ISO string, as
	// after hydration; fails_when=the string is used unparsed; no_claim=the menu.
	it("downloads an .ics when scheduledAt is an ISO string", async () => {
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((b: Blob) => {
			blobs.push(b);
			return "blob:x";
		});
		URL.revokeObjectURL = vi.fn();
		const names: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			names.push(this.download);
		});
		const user = userEvent.setup();
		vi.useFakeTimers({
			toFake: ["Date"],
			now: new Date("2026-11-01T00:00:00Z"),
		});
		render(button({ scheduledAt: "2026-11-13T01:00:00.000Z" }));
		await user.click(screen.getByRole("button", { name: /add to calendar/i }));
		await user.click(
			await screen.findByRole("menuitem", { name: /Apple \/ Outlook/ }),
		);
		expect(names).toEqual(["harbor-city-2026-11-12-toastmaster.ics"]);
		expect(await blobs[0]?.text()).toContain("DTSTART:20261113T010000Z");
	});

	// protects=the .ics download: filename, MIME and the event's content, with
	// no location; fails_when=the file is not offered, is misnamed, or carries a
	// contact/location; no_claim=a calendar app accepts the file.
	it("downloads an .ics named for club, local date and role", async () => {
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((b: Blob) => {
			blobs.push(b);
			return "blob:x";
		});
		URL.revokeObjectURL = vi.fn();
		const names: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			names.push(this.download);
		});
		const user = userEvent.setup();
		// A fixed 2026-11-13 meeting would be "past" later; pin only Date.
		vi.useFakeTimers({
			toFake: ["Date"],
			now: new Date("2026-11-01T00:00:00Z"),
		});
		render(button({ scheduledAt: new Date("2026-11-13T01:00:00Z") }));
		await user.click(screen.getByRole("button", { name: /add to calendar/i }));
		await user.click(
			await screen.findByRole("menuitem", { name: /Apple \/ Outlook/ }),
		);
		expect(names).toEqual(["harbor-city-2026-11-12-toastmaster.ics"]);
		expect(blobs[0]?.type).toBe("text/calendar;charset=utf-8");
		const text = await blobs[0]?.text();
		expect(text).toContain("UID:slot-1@gavelup");
		expect(text).toContain("DTSTART:20261113T010000Z");
		expect(text).toContain(
			`${window.location.origin}/club/harbor/meeting/2026-11-03`,
		);
		expect(text).not.toMatch(/LOCATION|ATTENDEE/);
	});

	// protects=Google link opens in a new tab with noopener,noreferrer;
	// fails_when=it navigates this tab or leaks the opener; no_claim=Google
	// accepts the link.
	it("opens the Google link in a new tab without an opener", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const user = userEvent.setup();
		render(button());
		await user.click(screen.getByRole("button", { name: /add to calendar/i }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Google Calendar" }),
		);
		expect(open).toHaveBeenCalledTimes(1);
		const [url, target, features] = open.mock.calls[0] ?? [];
		expect(String(url)).toMatch(
			/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=/,
		);
		expect(target).toBe("_blank");
		expect(features).toBe("noopener,noreferrer");
	});
});

describe("surfaces (#1423)", () => {
	// protects=one button per held role on the meeting page's jobs card;
	// fails_when=the card shows none, or one for several roles, or any for a
	// past meeting (a cancelled one renders no card at all, so it could not
	// prove anything here; the button's own cancelled gate has its test above);
	// no_claim=the card's other contents.
	it.each([
		[FUTURE, 2],
		[PAST, 0],
	] as const)("jobs card, meeting at %s: %i buttons for two roles", async (at, n) => {
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(
			twoRoleView("scheduled", at),
		);
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await inRouter(
			<QueryClientProvider client={qc}>
				<MeetingYourJobs
					clubId="harbor"
					clubUuid="club-uuid"
					meetingKey="2026-11-03"
					memberId={MEMBER}
					source="session"
				/>
			</QueryClientProvider>,
		);
		await screen.findByRole("heading", { name: "Your jobs" });
		expect(triggers()).toHaveLength(n);
	});

	// protects=one button per held role on /me, none once the meeting is past;
	// fails_when=the body drops the button or ignores `isMeetingOver`;
	// no_claim=the body's other states.
	it.each([
		[FUTURE, 2],
		[PAST, 0],
	] as const)("/me body at %s: %i buttons for two roles", async (at, n) => {
		await inRouter(
			<PersonalMeetingBody
				view={twoRoleView("scheduled", at)}
				clubId="harbor"
				meetingId="2026-11-03"
				onChanged={async () => {}}
				onNotYou={() => {}}
				canRepick
				roleGuides={[]}
			/>,
		);
		await screen.findByRole("heading", { name: "Toastmaster" });
		expect(triggers()).toHaveLength(n);
	});
});
