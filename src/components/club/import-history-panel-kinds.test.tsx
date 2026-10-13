// @vitest-environment jsdom
//
// The import preview's guest-kind select (#1208): two options, "Guest" and
// "Visiting Toastmaster". Its own file because `import-history-panel.test.tsx`
// is not part of this change; the mocks repeat that file's.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	listEasySpeakImports: vi.fn(),
	uploadEasySpeakBundle: vi.fn(),
	previewEasySpeakImport: vi.fn(),
	applyEasySpeakImport: vi.fn(),
	importEasySpeakSpeechRequests: vi.fn(),
	importEasySpeakMentors: vi.fn(),
}));
vi.mock("#/server/history-import", () => fns);
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { ImportHistoryPanel } from "./import-history-panel";

const CLUB = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";
const IMPORT = "9a1b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";
const M1 = "11111111-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

const preview = {
	importId: IMPORT,
	planHash: "a".repeat(64),
	appliedAt: null,
	bundleClub: { name: "Fixture Speakers", number: "9999" },
	club: { name: "Test Club", number: null },
	warnings: [],
	counts: {
		meetings: 1,
		meetingsToCreate: 1,
		meetingsToAdopt: 0,
		meetingsToUpdate: 0,
		meetingsToSkip: 0,
		futureMeetingsSkipped: 0,
		roleAssignments: 1,
		speeches: 0,
		speechesWithIntroduction: 0,
		evaluatorLinks: 0,
		attendanceRecords: 0,
		awards: 0,
		tableTopicsSpeakers: 0,
		newGuests: 0,
		newRoleDefinitions: 0,
	},
	people: [
		{
			key: "es:900005",
			name: "Elliot Dovecott",
			esUserId: "900005",
			status: "ambiguous",
			via: null,
			memberId: null,
			kind: null,
			reason: null,
			candidates: [{ memberId: M1, name: "Elliot Dovecott" }],
			rejectedChoice: null,
			appearances: {
				roles: 1,
				attendance: 1,
				awards: 0,
				tableTopics: 0,
				introducedBy: 0,
				guestCategories: [],
			},
		},
	],
	roleDefinitions: [],
	futureMeetings: [],
	roster: [{ memberId: M1, name: "Elliot Dovecott" }],
	unresolvedCount: 1,
	canApply: false,
	savedResolutions: {},
	report: null,
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ImportHistoryPanel guest kind select (#1208)", () => {
	// protects=choosing "a guest" for an unmatched person offers exactly two
	// kinds, labelled "Guest" (stored `visitor`) and "Visiting Toastmaster";
	// fails_when=a third option (the retired guest speaker) comes back, or the
	// first reads "Visitor";
	// no_claim=what the apply stores for the chosen kind; the server fns are
	// mocked and the options come from the real `GUEST_KINDS` and labels.
	it("lists the two kinds, labelled Guest and Visiting Toastmaster", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(preview);
		fns.listEasySpeakImports.mockResolvedValue([
			{
				importId: IMPORT,
				createdAt: new Date("2026-10-12T00:00:00Z"),
				appliedAt: null,
				clubName: "Fixture Speakers",
				meetings: 3,
				reconciled: null,
			},
		]);
		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<ImportHistoryPanel clubId={CLUB} clubName="Test Club" />
			</QueryClientProvider>,
		);
		fireEvent.click(await screen.findByText(/Fixture Speakers, 3 meetings/));
		fireEvent.change(
			await screen.findByLabelText("What to do with Elliot Dovecott"),
			{ target: { value: "guest" } },
		);
		const kind = (await screen.findByLabelText(
			"What kind of guest is Elliot Dovecott",
		)) as HTMLSelectElement;
		await waitFor(() =>
			expect(
				Array.from(kind.options).map((o) => [o.value, o.textContent]),
			).toEqual([
				["visitor", "Guest"],
				["visiting_toastmaster", "Visiting Toastmaster"],
			]),
		);
	});
});
