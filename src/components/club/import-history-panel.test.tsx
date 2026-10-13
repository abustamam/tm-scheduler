// @vitest-environment jsdom
//
// The superadmin import panel (#1051): Apply stays disabled until the preview
// says every person is decided, an ambiguous person's choice is sent back as a
// resolution, and the stored report shows. The server fns are mocked; what they
// refuse is held by the authz tests.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
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
const M2 = "22222222-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

const counts = {
	meetings: 1,
	meetingsToCreate: 1,
	meetingsToAdopt: 0,
	meetingsToUpdate: 0,
	meetingsToSkip: 2,
	futureMeetingsSkipped: 2,
	roleAssignments: 14,
	speeches: 2,
	speechesWithIntroduction: 0,
	evaluatorLinks: 2,
	attendanceRecords: 4,
	awards: 3,
	tableTopicsSpeakers: 0,
	newGuests: 3,
	newRoleDefinitions: 2,
};

const person = {
	key: "es:900005",
	name: "Elliot Dovecott",
	esUserId: "900005",
	status: "ambiguous",
	via: null,
	memberId: null,
	kind: null,
	reason: null,
	candidates: [
		{ memberId: M1, name: "Elliot Dovecott" },
		{ memberId: M2, name: "Elliot Dovecott" },
	],
	rejectedChoice: null,
	appearances: {
		roles: 1,
		attendance: 1,
		awards: 0,
		tableTopics: 0,
		introducedBy: 0,
		guestCategories: [],
	},
};

const PLAN_HASH = "a".repeat(64);

function previewFor(
	resolved: boolean,
	report: unknown = null,
	appliedAt: Date | null = null,
) {
	return {
		importId: IMPORT,
		planHash: PLAN_HASH,
		appliedAt,
		bundleClub: { name: "Fixture Speakers", number: "9999" },
		club: { name: "Test Club", number: null },
		warnings: [],
		counts,
		people: resolved ? [] : [person],
		roleDefinitions: [],
		futureMeetings: [],
		roster: [
			{ memberId: M1, name: "Elliot Dovecott" },
			{ memberId: M2, name: "Elliot Dovecott" },
		],
		unresolvedCount: resolved ? 0 : 1,
		canApply: resolved,
		savedResolutions: {},
		report,
	};
}

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ImportHistoryPanel clubId={CLUB} clubName="Test Club" />
		</QueryClientProvider>,
	);
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
			meetings: 3,
			reconciled: null,
		},
	]);
	renderPanel();
	fireEvent.click(await screen.findByText(/Fixture Speakers, 3 meetings/));
}

describe("ImportHistoryPanel (#1051)", () => {
	it("keeps Apply disabled until the person is decided, then sends the decision", async () => {
		fns.previewEasySpeakImport.mockImplementation(
			async ({ data }: { data: { resolutions?: Record<string, unknown> } }) =>
				previewFor(Boolean(data.resolutions?.["es:900005"])),
		);
		fns.applyEasySpeakImport.mockResolvedValue({
			report: {
				reconciled: true,
				counts: [],
				meetings: { applied: 1, failed: [] },
				notImported: [],
				skippedPeople: [],
				created: { guests: 3, roleDefinitions: [] },
			},
		});
		await openImport();

		const apply = await screen.findByRole("button", { name: "Apply import" });
		expect((apply as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/1 person needs a decision/)).toBeTruthy();

		fireEvent.change(screen.getByLabelText("What to do with Elliot Dovecott"), {
			target: { value: "member" },
		});
		fireEvent.change(screen.getByLabelText("Which member is Elliot Dovecott"), {
			target: { value: M2 },
		});

		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "Apply import",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
		expect(screen.getByText("Left as they are in GavelUp")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
		fireEvent.click(await screen.findByRole("button", { name: "Yes, apply" }));
		await waitFor(() => expect(fns.applyEasySpeakImport).toHaveBeenCalled());
		expect(fns.applyEasySpeakImport.mock.calls[0]?.[0]).toEqual({
			data: {
				clubId: CLUB,
				importId: IMPORT,
				resolutions: { "es:900005": { action: "member", memberId: M2 } },
				// The apply names the preview it confirms.
				planHash: PLAN_HASH,
			},
		});
	});

	it("does not send a skip without a reason", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewFor(false));
		await openImport();
		fireEvent.change(
			await screen.findByLabelText("What to do with Elliot Dovecott"),
			{
				target: { value: "skip" },
			},
		);
		await screen.findByLabelText("Why skip Elliot Dovecott");
		const last = fns.previewEasySpeakImport.mock.calls.at(-1)?.[0];
		expect(last.data.resolutions).toEqual({});
	});

	it("shows the stored reconciliation report and what was not imported", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, {
				reconciled: false,
				counts: [
					{
						key: "speeches",
						label: "Speeches",
						bundle: 2,
						gavelup: 1,
						missing: ["1472117"],
					},
				],
				meetings: {
					applied: 1,
					failed: [{ esMeetingId: "644360", message: "boom" }],
				},
				notImported: [
					{
						what: "Mentors",
						count: 7,
						reason: "Imported by the mentor import.",
					},
				],
				skippedPeople: [],
				created: { guests: 0, roleDefinitions: [] },
			}),
		);
		await openImport();
		expect(await screen.findByText(/differences found/)).toBeTruthy();
		expect(screen.getByText("1472117")).toBeTruthy();
		expect(screen.getByText(/644360: boom/)).toBeTruthy();
		expect(screen.getByText(/Mentors: 7/)).toBeTruthy();
	});

	it("refuses a file over the cap by its size, before it reads the file or calls the server", async () => {
		fns.listEasySpeakImports.mockResolvedValue([]);
		renderPanel();
		const input = await screen.findByLabelText("Easy-Speak bundle");
		const file = new File(["{}"], "bundle.json", { type: "application/json" });
		// The literal, not the constant: a test relative to the constant cannot fail.
		Object.defineProperty(file, "size", { value: 60 * 1024 * 1024 });
		const read = vi.spyOn(file, "text");
		fireEvent.change(input, { target: { files: [file] } });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"That file is 60.0 MB; the limit is 50.0 MB.",
			),
		);
		expect(read).not.toHaveBeenCalled();
		expect(fns.uploadEasySpeakBundle).not.toHaveBeenCalled();
	});

	it("keeps Import speech requests disabled until the import is applied", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewFor(false));
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import speech requests",
		})) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(screen.getByText("Apply the import first.")).toBeTruthy();
		fireEvent.click(button);
		expect(fns.importEasySpeakSpeechRequests).not.toHaveBeenCalled();
	});

	it("imports the speech requests once applied and shows each count", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, null, new Date("2026-10-12T00:00:00Z")),
		);
		fns.importEasySpeakSpeechRequests.mockResolvedValue({
			total: 29,
			imported: 12,
			alreadyImported: 3,
			skippedScheduled: 5,
			skippedCompleted: 4,
			skippedUnknownStatus: 1,
			skippedNoMember: 4,
		});
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import speech requests",
		})) as HTMLButtonElement;
		await waitFor(() => expect(button.disabled).toBe(false));
		expect(screen.queryByText("Apply the import first.")).toBeNull();

		fireEvent.click(button);

		await waitFor(() =>
			expect(fns.importEasySpeakSpeechRequests).toHaveBeenCalledWith({
				data: { clubId: CLUB, importId: IMPORT },
			}),
		);
		const result = await screen.findByTestId("speech-requests-result");
		const shown = Object.fromEntries(
			[...result.querySelectorAll("dt")].map((dt) => [
				dt.textContent,
				dt.nextElementSibling?.textContent,
			]),
		);
		expect(shown).toEqual({
			"Requests in the bundle": "29",
			Imported: "12",
			"Already imported": "3",
			"Skipped: scheduled": "5",
			"Skipped: completed": "4",
			"Skipped: no matching member": "4",
			"Skipped: unknown status": "1",
		});
		expect(toast.success).toHaveBeenCalledWith("Imported 12 speech requests.");
	});

	it("reports a refusal from the server and shows no counts", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, null, new Date("2026-10-12T00:00:00Z")),
		);
		fns.importEasySpeakSpeechRequests.mockRejectedValue(new Error("Nope."));
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import speech requests",
		})) as HTMLButtonElement;
		await waitFor(() => expect(button.disabled).toBe(false));
		fireEvent.click(button);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope."));
		expect(screen.queryByTestId("speech-requests-result")).toBeNull();
	});

	it("keeps Import mentor pairs disabled until the import is applied", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewFor(false));
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import mentor pairs",
		})) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(
			screen.getByText("Apply the import before importing mentor pairs."),
		).toBeTruthy();
		fireEvent.click(button);
		expect(fns.importEasySpeakMentors).not.toHaveBeenCalled();
	});

	it("imports the mentor pairs once applied, shows each count and lists every skipped pair and the unmapped flag", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, null, new Date("2026-10-12T00:00:00Z")),
		);
		fns.importEasySpeakMentors.mockResolvedValue({
			total: 6,
			pairs: 4,
			noMentor: 2,
			imported: 2,
			alreadyImported: 1,
			alreadyPaired: 0,
			skipped: [
				{
					mentee: { esUserId: "7", name: "Maya Mentee" },
					mentor: { esUserId: "8", name: "Omar Mentor" },
					reason: "mentor_not_member",
				},
			],
			wantsMenteeNotImported: [{ esUserId: "9", name: "Wanda Wants" }],
		});
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import mentor pairs",
		})) as HTMLButtonElement;
		await waitFor(() => expect(button.disabled).toBe(false));

		fireEvent.click(button);

		await waitFor(() =>
			expect(fns.importEasySpeakMentors).toHaveBeenCalledWith({
				data: { clubId: CLUB, importId: IMPORT },
			}),
		);
		const result = await screen.findByTestId("mentors-result");
		const shown = Object.fromEntries(
			[...result.querySelectorAll("dt")].map((dt) => [
				dt.textContent,
				dt.nextElementSibling?.textContent,
			]),
		);
		expect(shown).toEqual({
			"Rows in the bundle": "6",
			"Pairs in the bundle": "4",
			Imported: "2",
			"Already imported": "1",
			"Already paired": "0",
			Skipped: "1",
			"No mentor named": "2",
		});
		expect(screen.getByTestId("mentors-skipped").textContent).toContain(
			"Maya Mentee (mentee) with Omar Mentor (mentor): the mentor is not an active member",
		);
		expect(screen.getByTestId("mentors-wants-mentee").textContent).toContain(
			"Wanda Wants",
		);
		expect(toast.success).toHaveBeenCalledWith("Imported 2 mentor pairs.");
	});

	it("shows no skipped list when nothing was skipped, and reports a refusal with no counts", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, null, new Date("2026-10-12T00:00:00Z")),
		);
		fns.importEasySpeakMentors.mockResolvedValueOnce({
			total: 1,
			pairs: 1,
			noMentor: 0,
			imported: 0,
			alreadyImported: 1,
			alreadyPaired: 0,
			skipped: [],
			wantsMenteeNotImported: [],
		});
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import mentor pairs",
		})) as HTMLButtonElement;
		await waitFor(() => expect(button.disabled).toBe(false));
		fireEvent.click(button);
		await screen.findByTestId("mentors-result");
		expect(screen.queryByTestId("mentors-skipped")).toBeNull();
		expect(screen.queryByTestId("mentors-wants-mentee")).toBeNull();
		expect(toast.success).toHaveBeenCalledWith(
			"No new mentor pairs to import.",
		);
	});

	it("reports a mentor-step refusal from the server", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, null, new Date("2026-10-12T00:00:00Z")),
		);
		fns.importEasySpeakMentors.mockRejectedValue(new Error("Nope."));
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import mentor pairs",
		})) as HTMLButtonElement;
		await waitFor(() => expect(button.disabled).toBe(false));
		fireEvent.click(button);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope."));
		expect(screen.queryByTestId("mentors-result")).toBeNull();
	});
});
