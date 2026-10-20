// @vitest-environment jsdom
//
// The one-upload preview (#1240): a summary line instead of a list of everyone
// the rules placed, the optional contacts box, its warnings, and the contacts
// riding with the preview and the apply. The server fns are mocked; the plan and
// the write are held by the plan and integration tests.
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

const counts = {
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
	newGuests: 1,
	newRoleDefinitions: 0,
	linkedMembers: 5,
	newActiveMembers: 2,
	newOfficers: 1,
	newFormerMembers: 3,
	erasedAccounts: 4,
};

function previewFor(contacts: string) {
	return {
		importId: IMPORT,
		planHash: "a".repeat(64),
		appliedAt: null,
		bundleClub: { name: "Fixture Speakers", number: "9999" },
		club: { name: "Test Club", number: null },
		warnings: [],
		counts,
		// Everyone the rules placed is in the data, and none of them is listed.
		people: [
			{
				key: "es:1",
				name: "Pia President",
				esUserId: "1",
				status: "create",
				via: null,
				memberId: null,
				kind: null,
				reason: null,
				candidates: [],
				rejectedChoice: null,
				appearances: {
					roles: 0,
					attendance: 0,
					awards: 0,
					tableTopics: 0,
					introducedBy: 0,
					memberList: 1,
					mentorChart: 0,
					speechRequests: 0,
					guestCategories: [],
				},
				listOnly: true,
				needsDecision: false,
			},
		],
		roleDefinitions: [],
		futureMeetings: [],
		roster: [],
		unresolvedCount: 0,
		contacts: contacts.trim()
			? {
					emails: 1,
					phones: 2,
					warnings: [
						"Contact row 2 (Nobody Known) matches no one being linked or created; it is applied to no one.",
					],
				}
			: { emails: 0, phones: 0, warnings: [] },
		canApply: true,
		savedResolutions: {},
		report: null,
	};
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function openImport() {
	fns.listEasySpeakImports.mockResolvedValue([
		{
			importId: IMPORT,
			createdAt: new Date("2026-10-12T00:00:00Z"),
			appliedAt: null,
			clubName: "Fixture Speakers",
			meetings: 1,
			reconciled: null,
		},
	]);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ImportHistoryPanel clubId={CLUB} clubName="Test Club" />
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByText(/Fixture Speakers, 1 meetings/));
}

describe("ImportHistoryPanel one-upload preview (#1240)", () => {
	// protects=the preview says in one line how many it will link, create (active,
	// officers, former), add as guests and skip as erased, and does not list the
	// people the rules placed;
	// fails_when=a count is mislabelled or dropped, or a created person is listed
	// as a decision;
	// no_claim=the numbers are the mocked plan's; the plan tests own them.
	it("shows one summary line and no per-person list for placed people", async () => {
		fns.previewEasySpeakImport.mockImplementation(
			async ({ data }: { data: { contacts?: string } }) =>
				previewFor(data.contacts ?? ""),
		);
		await openImport();
		const line = await screen.findByTestId("import-people-summary");
		expect(line.textContent?.replace(/\s+/gu, " ")).toBe(
			"Will link 5 existing members, create 2 active members (1 officer) and 3 former members, add 1 guest, and skip 4 erased accounts.",
		);
		expect(screen.queryByText("People to decide")).toBeNull();
		expect(screen.queryByText("Pia President")).toBeNull();
	});

	// protects=pasted contacts reach the preview when the box loses focus and the
	// apply with it, the preview's warnings render, and the apply is enabled;
	// fails_when=the contacts are not sent, are sent per keystroke, or a warning
	// is not shown;
	// no_claim=what the server does with them (integration tests).
	it("sends the contacts with the preview and the apply, and shows the warnings", async () => {
		fns.previewEasySpeakImport.mockImplementation(
			async ({ data }: { data: { contacts?: string } }) =>
				previewFor(data.contacts ?? ""),
		);
		fns.applyEasySpeakImport.mockResolvedValue({
			report: {
				reconciled: true,
				counts: [],
				meetings: { applied: 1, failed: [] },
				notImported: [],
				skippedPeople: [],
				created: { guests: 1, roleDefinitions: [] },
			},
		});
		await openImport();
		await screen.findByTestId("import-people-summary");
		const box = screen.getByLabelText("Contacts (optional)");
		const pasted = "Pia President, pia@example.com, 555-0101";
		fireEvent.change(box, { target: { value: pasted } });
		// Not read until the box loses focus.
		expect(
			fns.previewEasySpeakImport.mock.calls.some(
				(c) => c[0].data.contacts === pasted,
			),
		).toBe(false);
		fireEvent.blur(box);

		const warnings = await screen.findByTestId("import-contact-warnings");
		expect(warnings.textContent).toContain("Contact row 2 (Nobody Known)");
		expect(warnings.textContent).not.toContain("pia@example.com");
		expect(
			screen.getByText(/Contacts will set 1 email and 2 phones/),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
		fireEvent.click(await screen.findByRole("button", { name: "Yes, apply" }));
		await waitFor(() => expect(fns.applyEasySpeakImport).toHaveBeenCalled());
		expect(fns.applyEasySpeakImport.mock.calls[0]?.[0].data.contacts).toBe(
			pasted,
		);
	});
});
