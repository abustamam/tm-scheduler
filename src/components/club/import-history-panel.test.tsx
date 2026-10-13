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

function previewFor(resolved: boolean, report: unknown = null) {
	return {
		importId: IMPORT,
		planHash: PLAN_HASH,
		appliedAt: null,
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
});
