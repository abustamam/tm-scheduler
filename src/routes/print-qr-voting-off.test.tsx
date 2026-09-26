// @vitest-environment jsdom
//
// #913 AC6: a club with digital voting OFF still prints the meeting-page QR.
//
// Before #913 the print route handed every layout `ballotUrlFor(digitalVoting,
// …)`, which is null with voting off, so a paper-ballot club's agenda carried
// no code at all. The print route now builds the code with `meetingHubUrlFor`,
// which has no voting input — but "has no voting input" is a statement about
// source, and nothing rendered the route with a voting-off payload to show the
// code actually reaches the sheet. This mounts the real route component over a
// loader payload whose club AND meeting have voting off, on every layout, and
// reads the rendered footer.
//
// `useLoaderData` / `useSearch` / `useParams` are stubbed the way
// `club.$clubId_.meeting.$meetingId.word.test.tsx` does it; the component, the
// layouts and `meetingHubUrlFor` are all real.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));

import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { Route } from "./club.$clubId_.meeting.$meetingId.print";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const CLUB_KEY = "downtown";
const MEETING_KEY = "2026-07-31";

/** A loader payload for a meeting whose club votes on paper — both halves of
 *  the #770 switch off, so any lingering voting gate would withhold the code. */
function votingOffPayload() {
	return {
		meeting: {
			clubId: "11111111-1111-4111-8111-111111111111",
			scheduledAt: "2026-07-31T18:45:00Z",
			lengthMinutes: 60,
			theme: null,
			wordOfTheDay: null,
			location: null,
			reminders: null,
			digitalVotingDisabled: true,
		},
		slots: [],
		timezone: "UTC",
		clubName: "Downtown Toastmasters",
		clubNumber: null,
		clubDistrict: null,
		clubMission: null,
		clubMeetingSchedule: null,
		meetingNumber: null,
		officers: [],
		geIntroducesFunctionaries: false,
		tableTopicsMinSeconds: 60,
		tableTopicsMaxSeconds: 120,
		template: null,
		logoUrl: null,
		digitalVoting: false,
		clubDigitalVotingEnabled: false,
	};
}

async function renderPrint(layout: AgendaLayout) {
	vi.spyOn(Route, "useParams").mockReturnValue({
		clubId: CLUB_KEY,
		meetingId: MEETING_KEY,
	} as never);
	vi.spyOn(Route, "useSearch").mockReturnValue({ layout } as never);
	vi.spyOn(Route, "useLoaderData").mockReturnValue(votingOffPayload() as never);
	const Component = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Component />);
}

describe("the printed agenda carries the meeting-page QR with digital voting OFF (#913 AC6)", () => {
	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`prints it on the ${layout} layout`, async () => {
			await renderPrint(layout);
			// The origin arrives in an effect, so the code appears after mount.
			await waitFor(() =>
				expect(document.querySelector(".footer-qr svg")).not.toBeNull(),
			);
			for (const qr of document.querySelectorAll(".footer-qr")) {
				expect(qr.textContent).toContain("today's meeting");
			}
			expect(screen.queryByText(/scan to vote/i)).toBeNull();
		});
	}
});
