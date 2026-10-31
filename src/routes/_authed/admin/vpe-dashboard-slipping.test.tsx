// @vitest-environment jsdom
//
// The "Slipping" tier and Reach out on the lapse rows (#1445). Same harness as
// vpe-dashboard.test.tsx: mock the server-fn module, stub the loader data.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttendanceLapseRow, LapseReachOut } from "#/lib/attendance-lapse";

vi.mock("#/server/reporting", () => ({
	getSpeakerRotation: vi.fn(),
	getOverdueMembers: vi.fn(),
	getAttendanceLapse: vi.fn(),
	getEvaluatorPairings: vi.fn(),
	getLevelProximity: vi.fn(),
}));

vi.mock("#/server/speech-requests", () => ({
	getSpeechRequestQueue: vi.fn(),
	getSchedulableSpeakerSlots: vi.fn(),
	scheduleRequestedSpeech: vi.fn(),
}));

import { Route } from "./vpe-dashboard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

type Row = AttendanceLapseRow & Partial<LapseReachOut>;

function row(over: Partial<Row>): Row {
	return {
		memberId: "22222222-2222-4222-8222-222222222222",
		name: "Dana Drift",
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		streak: 2,
		presentCount: 2,
		eligibleCount: 8,
		rate: 0.25,
		lastSeenAt: new Date("2026-05-06T00:00:00Z"),
		isLapsed: false,
		phone: "+14155550123",
		email: null,
		preferredName: null,
		preferredContact: null,
		suggestedRole: null,
		suggestedForMeetingId: "33333333-3333-4333-8333-333333333333",
		...over,
	};
}

async function renderRoute(lapse: Row[], withMeeting = true) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: [],
		overdue: [],
		lapse,
		pairings: [],
		proximity: [],
		orientation: [],
		speechRequests: [],
		timezone: "UTC",
		now: Date.parse("2026-09-15T12:00:00Z"),
		clubName: "Downtown Club",
		clubId: "11111111-1111-4111-8111-111111111111",
		clubSlug: "downtown",
		nextMeeting: withMeeting
			? {
					id: "33333333-3333-4333-8333-333333333333",
					urlKey: "2026-09-16",
					scheduledAt: new Date("2026-09-16T18:00:00Z"),
					location: null,
				}
			: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

function sectionOf(title: string): HTMLElement {
	const h = screen.getByText(title, { selector: "h2, h3" });
	// Section = heading block + a sibling card holding the rows.
	const section = h.parentElement?.parentElement;
	if (!section) throw new Error(`no section for ${title}`);
	return section as HTMLElement;
}

describe("VPE dashboard — Slipping tier (#1445)", () => {
	it("puts a streak of 2 under Slipping and a streak of 3 under Stopped", async () => {
		await renderRoute([
			row({ memberId: "a", name: "Sly Slipping", streak: 2 }),
			row({ memberId: "b", name: "Stan Stopped", streak: 3, isLapsed: true }),
		]);
		const slipping = sectionOf("Slipping");
		const stopped = sectionOf("Stopped attending");
		expect(slipping.textContent).toContain("Sly Slipping");
		expect(slipping.textContent).not.toContain("Stan Stopped");
		expect(stopped.textContent).toContain("Stan Stopped");
		expect(stopped.textContent).not.toContain("Sly Slipping");
	});

	it("names the suggested role in the Reach out draft", async () => {
		await renderRoute([row({ suggestedRole: "Timer" })]);
		const link = await screen.findByLabelText(/Message Dana Drift on WhatsApp/);
		const href = link.getAttribute("href") ?? "";
		const text = decodeURIComponent(href.split("text=")[1] ?? "");
		expect(text).toContain("we've missed you at Downtown Club!");
		expect(text).toContain("Timer is open on");
		expect(text).toContain("/downtown/");
	});

	it("falls back to the meeting-only draft without a suggested role", async () => {
		await renderRoute([row({ suggestedRole: null })]);
		const link = await screen.findByLabelText(/Message Dana Drift on WhatsApp/);
		const text = decodeURIComponent(
			(link.getAttribute("href") ?? "").split("text=")[1] ?? "",
		);
		expect(text).toContain("Hope to see you on");
		expect(text).not.toContain("is open on");
	});

	it("keeps the row's member link off the Reach out buttons", async () => {
		await renderRoute([row({})]);
		const link = await screen.findByLabelText(/Message Dana Drift on WhatsApp/);
		// No anchor inside an anchor: the draft link has no anchor ancestor.
		expect(link.parentElement?.closest("a")).toBeNull();
		expect(link.querySelector("a")).toBeNull();
	});

	it("shows the empty state when nobody is slipping", async () => {
		await renderRoute([
			row({ memberId: "b", name: "Stan Stopped", streak: 3, isLapsed: true }),
			row({ memberId: "c", name: "Fine Fran", streak: 0 }),
		]);
		expect(sectionOf("Slipping").textContent).toContain(
			"Nobody is slipping right now.",
		);
		expect(sectionOf("Slipping").textContent).not.toContain("Fine Fran");
	});

	it("drops the role when it was suggested for a different meeting than the draft names", async () => {
		await renderRoute([
			row({
				suggestedRole: "Timer",
				suggestedForMeetingId: "99999999-9999-4999-8999-999999999999",
			}),
		]);
		const link = await screen.findByLabelText(/Message Dana Drift on WhatsApp/);
		const text = decodeURIComponent(
			(link.getAttribute("href") ?? "").split("text=")[1] ?? "",
		);
		expect(text).not.toContain("Timer");
		expect(text).toContain("Hope to see you on");
	});
});
