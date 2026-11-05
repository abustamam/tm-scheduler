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
	nextEasySpeakExport: vi.fn(),
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

const listings = vi.hoisted(() => ({
	EXTENSION_LISTINGS: {
		chrome: null as string | null,
		firefox: null as string | null,
	},
}));
vi.mock("#/lib/extension-listings", () => listings);

import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
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
	linkedMembers: 0,
	newActiveMembers: 0,
	newOfficers: 0,
	newFormerMembers: 0,
	erasedAccounts: 0,
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
		memberList: 0,
		mentorChart: 0,
		speechRequests: 0,
		guestCategories: [],
	},
	listOnly: false,
	needsDecision: true,
};

const PLAN_HASH = "a".repeat(64);

function previewFor(
	resolved: boolean,
	report: unknown = null,
	appliedAt: Date | null = null,
	range: { fromMonth: string } | null = null,
) {
	return {
		range,
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
		contacts: { emails: 0, phones: 0, warnings: [] },
		officialRoster: { official: 6, active: 6, complete: true },
		unresolvedCount: resolved ? 0 : 1,
		canApply: resolved,
		savedResolutions: {},
		report,
	};
}

function renderPanel(props: { isSuperadmin?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ImportHistoryPanel clubId={CLUB} clubName="Test Club" {...props} />
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

describe("the next export and the bundle's range (#1491)", () => {
	// protects=the admin knowing which month the next extension export should start from, and that a bounded bundle holds only part of the history;
	// fails_when=the line shows another month, shows nothing for a null month, or the range line appears for a full bundle;
	// no_claim=that the server computes the month (its integration test); the server fns are mocked
	it("shows where the next export starts, or the full history", async () => {
		fns.nextEasySpeakExport.mockResolvedValue({ fromMonth: "2026-05" });
		const first = renderPanel();
		expect((await screen.findByTestId("import-next-export")).textContent).toBe(
			"Next export: from May 2026.",
		);
		first.unmount();
		fns.nextEasySpeakExport.mockResolvedValue({ fromMonth: null });
		renderPanel();
		expect((await screen.findByTestId("import-next-export")).textContent).toBe(
			"Next export: the full history.",
		);
	});

	it("says a bounded bundle holds meetings from its month on, and a full one says nothing", async () => {
		fns.nextEasySpeakExport.mockResolvedValue({ fromMonth: null });
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(true, null, null, { fromMonth: "2026-05" }),
		);
		await openImport();
		expect((await screen.findByTestId("import-bundle-range")).textContent).toBe(
			"This bundle holds meetings from May 2026 on.",
		);
		cleanup();
		fns.previewEasySpeakImport.mockResolvedValue(previewFor(true));
		await openImport();
		await screen.findByRole("button", { name: "Apply import" });
		expect(screen.queryByTestId("import-bundle-range")).toBeNull();
	});
});

describe("ImportHistoryPanel (#1051)", () => {
	// protects=the panel says the bundle is kept with the club and that only the 5 newest unapplied uploads are kept, without contradiction;
	// fails_when=the sentence is dropped or reverts to the per-person wording;
	// no_claim=the server cap itself.
	it("states the retention and the unapplied-upload cap", () => {
		renderPanel();
		expect(
			screen.getByText(
				/The uploaded bundle, with every guest's name, is kept until the club is deleted\. Only the club's 5 most recent unapplied uploads are kept; an older one is replaced\./,
			),
		).toBeTruthy();
	});

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
				// No contacts pasted: an empty string rides along (#1240).
				contacts: "",
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
		expect(screen.queryByText(/1472117/)).toBeNull();
		fireEvent.click(screen.getByText(/Show source ids/));
		expect(screen.getByText("1472117")).toBeTruthy();
		expect(screen.getByText(/644360: boom/)).toBeTruthy();
		expect(screen.getByText(/Mentors: 7/)).toBeTruthy();
	});

	const reportWith = (over: Record<string, unknown>) => ({
		reconciled: true,
		counts: [],
		meetings: { applied: 1, failed: [] },
		notImported: [],
		skippedPeople: [],
		created: { guests: 0, roleDefinitions: [] },
		...over,
	});

	// protects=the report says up front how many counts differ, above the table;
	// fails_when=the sentence is dropped or counts every row rather than the differing ones;
	// no_claim=the table's layout.
	it("states how many counts have unexplained differences above the table", async () => {
		const row = (key: string, missing: string[]) => ({
			key,
			label: key,
			bundle: 5,
			gavelup: 5 - missing.length,
			missing,
		});
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(
				true,
				reportWith({
					reconciled: false,
					counts: [row("a", ["1"]), row("b", []), row("c", ["2", "3"])],
				}),
			),
		);
		await openImport();
		const line = await screen.findByText(
			"2 counts with unexplained differences",
		);
		const table = document.querySelector("table");
		expect(
			line.compareDocumentPosition(table as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	// protects=a long list of source ids stays out of the page until asked for;
	// fails_when=the ids are rendered inline (collapsed by CSS or not) or the count line drops;
	// no_claim=the server's id cap.
	it("keeps a grouped line's 1,000 source ids out of the page until its disclosure is opened", async () => {
		const ids = Array.from({ length: 1000 }, (_, i) => `src-${i}`);
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(
				true,
				reportWith({
					notImported: [
						{
							what: "Role assignments",
							count: 1204,
							reason: "Erased Easy-Speak account",
							sourceIds: ids,
						},
					],
				}),
			),
		);
		await openImport();
		expect(
			await screen.findByText(
				/Role assignments: 1,204\. Erased Easy-Speak account/,
			),
		).toBeTruthy();
		expect(document.body.textContent).not.toContain("src-999");
		fireEvent.click(screen.getByText(/Show source ids/));
		expect(document.body.textContent).toContain("src-999");
		expect(screen.getByText(/every count matches/)).toBeTruthy();
		expect(
			screen.getByText(/No counts with unexplained differences/),
		).toBeTruthy();
	});

	// protects=a report stored before #1496 (no sourceIds, no notes) renders;
	// fails_when=the panel reads a field only a new report has;
	// no_claim=the report's contents.
	it("renders a stored report with none of the newer fields", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(
			previewFor(
				true,
				reportWith({
					reconciled: false,
					counts: [
						{
							key: "awards",
							label: "Awards",
							bundle: 3,
							gavelup: 2,
							missing: ["a1"],
						},
					],
					notImported: [
						{ what: "Mentors", count: 7, reason: "Imported elsewhere." },
					],
				}),
			),
		);
		await openImport();
		expect(await screen.findByText(/Mentors: 7/)).toBeTruthy();
		expect(screen.getByText(/differences found/)).toBeTruthy();
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

	it("tells an over-cap file from an older extension to update it, reading at most 64 KiB", async () => {
		// protects=the admin learning WHY a stale export is too big; fails_when=the toast is the bare size error, the whole file is read, or the server is called; no_claim=a real 60 MB file (size is stubbed, the head is a small File)
		fns.listEasySpeakImports.mockResolvedValue([]);
		renderPanel();
		const input = await screen.findByLabelText("Easy-Speak bundle");
		const head =
			'{"format":"gavelup.easy-speak-bundle","version":1,"exportedAt":"x"';
		const file = new File([head], "bundle.json", { type: "application/json" });
		Object.defineProperty(file, "size", { value: 60 * 1024 * 1024 });
		const slice = vi.spyOn(file, "slice");
		const read = vi.spyOn(file, "text");
		fireEvent.change(input, { target: { files: [file] } });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"That file is 60.0 MB; the limit is 50.0 MB. This file came from an older GavelUp extension (format 1). Install the latest and export again.",
			),
		);
		expect(slice).toHaveBeenCalledTimes(1);
		expect(slice.mock.calls[0][1]).toBeLessThanOrEqual(65536);
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
				// The same unresolved pair twice: the list's React keys must not collide.
				{
					mentee: { esUserId: null, name: "Una Unmatched" },
					mentor: { esUserId: "8", name: "Omar Mentor" },
					reason: "mentee_unresolved",
				},
				{
					mentee: { esUserId: null, name: "Una Unmatched" },
					mentor: { esUserId: "8", name: "Omar Mentor" },
					reason: "mentee_unresolved",
				},
			],
			willing: {
				set: 3,
				alreadyWilling: 2,
				previouslyImported: 4,
				skipped: [
					{
						person: { esUserId: "9", name: "Wanda Wants" },
						reason: "unresolved",
					},
					{
						person: { esUserId: "4", name: "Lapsed Lee" },
						reason: "not_member",
					},
				],
			},
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
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
			[...(result.querySelector("dl")?.querySelectorAll("dt") ?? [])].map(
				(dt) => [dt.textContent, dt.nextElementSibling?.textContent],
			),
		);
		expect(shown).toEqual({
			"Rows in the bundle": "6",
			"Pairs in the bundle": "4",
			Imported: "2",
			"Already imported": "1",
			"Already paired": "0",
			Skipped: "3",
			"No mentor named": "2",
		});
		const skipped = screen.getByTestId("mentors-skipped");
		expect(skipped.textContent).toContain(
			"Maya Mentee (mentee) with Omar Mentor (mentor): the mentor is not an active member",
		);
		expect(skipped.querySelectorAll("li")).toHaveLength(3);
		expect(skipped.textContent).toContain(
			"Una Unmatched (mentee) with Omar Mentor (mentor): the import never matched the mentee to a member",
		);
		// React warns on a duplicate key; none may have been logged.
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
		const willing = Object.fromEntries(
			[...screen.getByTestId("mentors-willing").querySelectorAll("dt")].map(
				(dt) => [dt.textContent, dt.nextElementSibling?.textContent],
			),
		);
		expect(willing).toEqual({
			"Now willing to mentor": "3",
			"Already willing": "2",
			"Handled by an earlier import": "4",
			"Not an active member": "2",
		});
		const willingSkipped = screen.getByTestId("mentors-willing-skipped");
		expect(willingSkipped.textContent).toContain(
			"Wanda Wants: the import never matched them to a member",
		);
		expect(willingSkipped.textContent).toContain(
			"Lapsed Lee: not an active member",
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
			willing: {
				set: 0,
				alreadyWilling: 0,
				previouslyImported: 0,
				skipped: [],
			},
		});
		await openImport();
		const button = (await screen.findByRole("button", {
			name: "Import mentor pairs",
		})) as HTMLButtonElement;
		await waitFor(() => expect(button.disabled).toBe(false));
		fireEvent.click(button);
		await screen.findByTestId("mentors-result");
		expect(screen.queryByTestId("mentors-skipped")).toBeNull();
		expect(screen.queryByTestId("mentors-willing-skipped")).toBeNull();
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

describe("people named only by the lists (#1203)", () => {
	const listAppearances = {
		roles: 0,
		attendance: 0,
		awards: 0,
		tableTopics: 0,
		introducedBy: 0,
		memberList: 0,
		mentorChart: 0,
		speechRequests: 0,
		guestCategories: [],
	};
	const listPerson = (over: Record<string, unknown>) => ({
		...person,
		listOnly: true,
		...over,
	});

	it("shows an unmatched list-only person as information, not a decision, and leaves Apply on", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true),
			people: [
				listPerson({
					key: "es:900100",
					name: "Pat Pending",
					status: "unmatched",
					candidates: [],
					needsDecision: false,
					appearances: { ...listAppearances, mentorChart: 1 },
				}),
				listPerson({
					key: "es:900101",
					name: "Quinn Quartz",
					status: "member",
					via: "exact",
					memberId: M1,
					candidates: [],
					needsDecision: false,
					appearances: { ...listAppearances, memberList: 1 },
				}),
			],
		});
		await openImport();
		const info = await screen.findByTestId("list-only-people");
		expect(info.textContent).toContain("1 on the member list");
		expect(screen.getByTestId("list-only-es:900100").textContent).toContain(
			"Pat Pending: in the mentor chart",
		);
		expect(screen.queryByTestId("resolve-es:900100")).toBeNull();
		expect(screen.queryByText("People to decide")).toBeNull();
		expect(
			(
				(await screen.findByRole("button", {
					name: "Apply import",
				})) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("asks for an ambiguous list-only person but does not offer a guest", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(false),
			people: [
				listPerson({
					appearances: { ...listAppearances, speechRequests: 1 },
					needsDecision: true,
				}),
			],
		});
		await openImport();
		const select = (await screen.findByLabelText(
			"What to do with Elliot Dovecott",
		)) as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual([
			"",
			"member",
			"skip",
		]);
		expect(screen.getByTestId("resolve-es:900005").textContent).toContain(
			"in the speech requests",
		);
	});
});

describe("ImportHistoryPanel self-serve (#1492)", () => {
	const REFUSAL =
		"This export is from Other Speakers, not Fixture Speakers, the Easy-Speak club this club was imported from.";

	async function uploadFile() {
		const input = await screen.findByLabelText("Easy-Speak bundle");
		const file = new File(["{}"], "bundle.json", { type: "application/json" });
		fireEvent.change(input, { target: { files: [file] } });
		return file;
	}

	// protects=the first import's preview leads with the Easy-Speak club -> this
	// club, number part omitted when null, and a later import shows no such line;
	// fails_when=the line shows once bound, or its number part prints "null";
	// no_claim=that the server computed the binding (the logic integration test).
	it("leads the first preview with the binding, and only the first", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true),
			binding: {
				esName: "Fixture Speakers",
				esNumber: null,
				clubName: "Test Club",
			},
		});
		await openImport();
		expect((await screen.findByTestId("import-binding")).textContent).toBe(
			"Easy-Speak club Fixture Speakers → Test Club",
		);
		cleanup();
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true),
			binding: {
				esName: "Fixture Speakers",
				esNumber: "9999",
				clubName: "Test Club",
			},
		});
		await openImport();
		expect((await screen.findByTestId("import-binding")).textContent).toBe(
			"Easy-Speak club Fixture Speakers (#9999) → Test Club",
		);
		cleanup();
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true),
			binding: null,
		});
		await openImport();
		await screen.findByText(/Bundle from/);
		expect(screen.queryByTestId("import-binding")).toBeNull();
	});

	// protects=the override checkbox appears only for a superadmin and only after
	// a binding refusal, and a ticked retry sends overrideClubBinding: true;
	// fails_when=it is always shown, shown to a club admin, or never sent;
	// no_claim=that the server refuses the flag from a non-superadmin (authz test).
	it("offers the override to a superadmin only after a binding refusal, and sends it", async () => {
		fns.listEasySpeakImports.mockResolvedValue([]);
		fns.uploadEasySpeakBundle.mockRejectedValueOnce(new Error(REFUSAL));
		renderPanel({ isSuperadmin: true });
		expect(screen.queryByText(/Import anyway/)).toBeNull();
		await uploadFile();
		const box = await screen.findByLabelText(
			"Import anyway (another Easy-Speak club)",
		);
		expect(
			fns.uploadEasySpeakBundle.mock.calls[0]?.[0].data,
		).not.toHaveProperty("overrideClubBinding");
		fns.uploadEasySpeakBundle.mockResolvedValue({
			importId: IMPORT,
			reused: false,
			appliedAt: null,
		});
		fireEvent.click(box);
		fireEvent.click(
			await screen.findByRole("button", { name: "Upload again" }),
		);
		await waitFor(() =>
			expect(fns.uploadEasySpeakBundle).toHaveBeenCalledTimes(2),
		);
		expect(fns.uploadEasySpeakBundle.mock.calls[1]?.[0].data).toMatchObject({
			clubId: CLUB,
			overrideClubBinding: true,
		});
	});

	// protects=a club admin never sees the "Import anyway" override, even after the
	// server's binding refusal reached the panel;
	// fails_when=the checkbox is rendered without the isSuperadmin gate;
	// no_claim=the server also refuses the flag (the authz integration test).
	it("never renders the override for a club admin, even after a binding refusal", async () => {
		fns.listEasySpeakImports.mockResolvedValue([]);
		fns.uploadEasySpeakBundle.mockRejectedValueOnce(new Error(REFUSAL));
		renderPanel({ isSuperadmin: false });
		await uploadFile();
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REFUSAL));
		expect(screen.queryByText(/Import anyway/)).toBeNull();
	});

	// protects=the install line links each listing that exists and falls back to
	// "ask support" when none does;
	// fails_when=a null listing renders a dead link, or the fallback is missing;
	// no_claim=the listing URLs themselves (the maintainer pastes them).
	it("links the listings that exist and falls back when none does", async () => {
		fns.listEasySpeakImports.mockResolvedValue([]);
		listings.EXTENSION_LISTINGS.chrome = null;
		listings.EXTENSION_LISTINGS.firefox = null;
		renderPanel();
		await screen.findByLabelText("Easy-Speak bundle");
		expect(
			screen.getByText("Ask GavelUp support for the browser extension."),
		).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Chrome" })).toBeNull();
		cleanup();
		listings.EXTENSION_LISTINGS.chrome = "https://chromewebstore.example/ext";
		renderPanel();
		await screen.findByLabelText("Easy-Speak bundle");
		const chrome = screen.getByRole("link", { name: "Chrome" });
		expect(chrome.getAttribute("href")).toBe(
			"https://chromewebstore.example/ext",
		);
		expect(screen.queryByRole("link", { name: "Firefox" })).toBeNull();
		expect(screen.queryByText(/Ask GavelUp support/)).toBeNull();
		listings.EXTENSION_LISTINGS.chrome = null;
	});
});

describe("ImportHistoryPanel upcoming meetings (#1495)", () => {
	const upcomingFor = (defaultIncluded: boolean) => ({
		included: defaultIncluded,
		defaultIncluded,
		skipRoles: [] as string[],
		toCreate: 2,
		toAdopt: 1,
		toUpdate: 0,
		leftAlone: [
			{ esMeetingId: "7", date: "2026-10-27", reason: "Cancelled in GavelUp." },
		],
		roleAssignments: 30,
		keptGavelUpHolder: 0,
		rsvps: 20,
		timeNotes: [],
		unslottedRoles: [
			{
				planKey: "own:joke master",
				name: "Joke Master",
				meetings: 2,
				holders: 2,
				skipped: false,
			},
		],
	});
	const previewWith = (defaultIncluded: boolean) => ({
		...previewFor(true),
		upcoming: upcomingFor(defaultIncluded),
	});
	const box = () =>
		screen.getByRole("checkbox", {
			name: "Import upcoming meetings",
		}) as HTMLInputElement;

	it("ticks the box by the server's default and keeps the admin's choice", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewWith(true));
		await openImport();
		await screen.findByTestId("import-upcoming");
		expect(box().checked).toBe(true);
		fireEvent.click(box());
		await waitFor(() => expect(box().checked).toBe(false));
		cleanup();
		vi.clearAllMocks();

		fns.previewEasySpeakImport.mockResolvedValue(previewWith(false));
		await openImport();
		await screen.findByTestId("import-upcoming");
		expect(box().checked).toBe(false);
	});

	it("summarises what ticking the box would do and says what is left alone", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewWith(true));
		await openImport();
		const summary = await screen.findByTestId("import-upcoming-summary");
		expect(summary.textContent).toContain(
			"create 2, fill 1 already in GavelUp",
		);
		expect(summary.textContent).toContain("leave 1 as they are");
		expect(summary.textContent).toContain("30 role holders and 20 RSVPs");
		expect(screen.getByTestId("import-upcoming-notes").textContent).toContain(
			"2026-10-27: Cancelled in GavelUp.",
		);
	});

	it("labels the numbers 'up to' while the box is unticked (S3)", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewWith(true));
		await openImport();
		const summary = await screen.findByTestId("import-upcoming-summary");
		expect(summary.textContent).not.toContain("up to");
		fireEvent.click(box());
		await waitFor(() =>
			expect(
				screen.getByTestId("import-upcoming-summary").textContent,
			).toContain(
				"create up to 2, fill up to 1 already in GavelUp, leave 1 as they are; place up to 30 role holders and up to 20 RSVPs",
			),
		);
	});

	it("shows the report's upcoming notes beside the contact notes (S3)", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewWith(false),
			report: {
				reconciled: true,
				counts: [],
				meetings: { applied: 1, failed: [] },
				notImported: [],
				skippedPeople: [],
				created: { guests: 0, roleDefinitions: [] },
				upcomingNotes: [
					"Easy-Speak has the meeting at 19:00; GavelUp's 11:00 stands.",
				],
			},
		});
		await openImport();
		const notes = await screen.findByTestId("report-upcoming-notes");
		expect(notes.textContent).toContain("GavelUp's 11:00 stands");
	});

	it("sends the Add or Skip answer with the preview and the apply", async () => {
		fns.previewEasySpeakImport.mockResolvedValue(previewWith(true));
		fns.applyEasySpeakImport.mockResolvedValue({
			report: {
				reconciled: true,
				counts: [],
				meetings: { applied: 1, failed: [] },
				notImported: [],
				skippedPeople: [],
				created: { guests: 0, roleDefinitions: [] },
			},
		});
		await openImport();
		fireEvent.change(
			await screen.findByLabelText("What to do with the Joke Master role"),
			{ target: { value: "skip" } },
		);
		await waitFor(() => {
			const last = fns.previewEasySpeakImport.mock.calls.at(-1)?.[0];
			expect(last.data.upcoming).toEqual({
				include: true,
				skipRoles: ["own:joke master"],
			});
		});
		fireEvent.click(
			await screen.findByRole("button", { name: "Apply import" }),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Yes, apply" }));
		await waitFor(() => expect(fns.applyEasySpeakImport).toHaveBeenCalled());
		expect(fns.applyEasySpeakImport.mock.calls[0]?.[0].data.upcoming).toEqual({
			include: true,
			skipRoles: ["own:joke master"],
		});
	});
});

describe("ImportHistoryPanel close names and the contacts hint (#1493)", () => {
	const bob = {
		...person,
		key: "es:910001",
		name: "Bob Smith",
		esUserId: "910001",
		status: "possible_match",
		candidates: [{ memberId: M1, name: "Robert Smith" }],
	};

	// protects=a possible match is offered "Create a new member" (and an ambiguous one is not), and the answer is sent as a create resolution;
	// fails_when=the option is missing for a possible match, shown for an ambiguous person, or the choice sends another action;
	// no_claim=what the server does with the answer (its integration test); the server fns are mocked.
	it("offers Create a new member only for a possible match, and sends it", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(false),
			people: [bob, person],
		});
		await openImport();
		const select = (await screen.findByLabelText(
			"What to do with Bob Smith",
		)) as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toContain("create");
		expect(screen.getByTestId("resolve-es:910001").textContent).toContain(
			"may be a member already",
		);
		const ambiguous = (await screen.findByLabelText(
			"What to do with Elliot Dovecott",
		)) as HTMLSelectElement;
		expect([...ambiguous.options].map((o) => o.value)).not.toContain("create");
		fireEvent.change(select, { target: { value: "create" } });
		await waitFor(() => {
			const last = fns.previewEasySpeakImport.mock.calls.at(-1)?.[0];
			expect(last.data.resolutions["es:910001"]).toEqual({ action: "create" });
		});
	});

	// protects=the hint under Contacts appears only while the box is empty and someone would be created or asked about;
	// fails_when=it shows with contacts pasted, or with nobody to match;
	// no_claim=none beyond protects.
	it("hints at pasting the member list only while Contacts is empty and a create or possible match exists", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(false),
			people: [bob],
		});
		await openImport();
		expect((await screen.findByTestId("contacts-hint")).textContent).toContain(
			"Paste Easy-Speak's member list into Contacts to match people by email.",
		);
		const box = screen.getByLabelText("Contacts (optional)");
		fireEvent.change(box, { target: { value: "Bob Smith, b@example.test" } });
		fireEvent.blur(box);
		await waitFor(() =>
			expect(screen.queryByTestId("contacts-hint")).toBeNull(),
		);
		cleanup();
		fns.previewEasySpeakImport.mockResolvedValue(previewFor(true));
		await openImport();
		await screen.findByRole("button", { name: "Apply import" });
		expect(screen.queryByTestId("contacts-hint")).toBeNull();
	});

	// protects=a person the plan would create (no close member) still brings the hint while Contacts is empty;
	// fails_when=the hint is gated on a possible match alone, so a plain create shows none;
	// no_claim=the hint's wording, covered above.
	it("shows the contacts hint when the only person is a create", async () => {
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(false),
			people: [
				{
					...bob,
					key: "es:910002",
					name: "Zed Newcomer",
					status: "create",
					candidates: [],
				},
			],
		});
		await openImport();
		expect(await screen.findByTestId("contacts-hint")).toBeTruthy();
	});
});

describe("the roster notice (#1498)", () => {
	// protects=an admin hears to load the roster before importing into a thin one;
	// fails_when=the notice shows for a complete roster or after the apply, or omits the counts;
	// no_claim=the counts' source (server integration test); the server fns are mocked.
	it("shows with the counts and a roster link while incomplete, hidden when complete", async () => {
		fns.nextEasySpeakExport.mockResolvedValue({ fromMonth: null });
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true),
			officialRoster: { official: 1, active: 8, complete: false },
		});
		await openImport();
		const notice = await screen.findByTestId("import-roster-notice");
		expect(notice.textContent).toContain("Only 1 of your 8 members");
		expect(notice.querySelector("a")).not.toBeNull();
		cleanup();
		fns.previewEasySpeakImport.mockResolvedValue(previewFor(true));
		await openImport();
		await screen.findByRole("button", { name: "Apply import" });
		expect(screen.queryByTestId("import-roster-notice")).toBeNull();
	});

	// protects=an applied import no longer nags about the roster;
	// fails_when=the notice shows when appliedAt is set;
	// no_claim=the notice's wording (the test above).
	it("is hidden once the import has been applied, even with a thin roster", async () => {
		fns.nextEasySpeakExport.mockResolvedValue({ fromMonth: null });
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true, null, new Date("2026-10-13T00:00:00Z")),
			officialRoster: { official: 1, active: 8, complete: false },
		});
		await openImport();
		await screen.findByText(/Fixture Speakers/);
		expect(screen.queryByTestId("import-roster-notice")).toBeNull();
	});

	// protects=the superadmin page never links to /roster (it opens the superadmin's own active club, not the club being imported into), while the club-admin page does;
	// fails_when=the link shows on the superadmin render, or disappears on the club-admin one;
	// no_claim=the roster page itself.
	it("keeps the notice but drops the roster link on the superadmin render", async () => {
		fns.nextEasySpeakExport.mockResolvedValue({ fromMonth: null });
		fns.previewEasySpeakImport.mockResolvedValue({
			...previewFor(true),
			officialRoster: { official: 1, active: 8, complete: false },
		});
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
		renderPanel({ isSuperadmin: true });
		fireEvent.click(await screen.findByText(/Fixture Speakers, 3 meetings/));
		const notice = await screen.findByTestId("import-roster-notice");
		expect(notice.textContent).toContain("Only 1 of your 8 members");
		expect(notice.querySelector("a")).toBeNull();
	});
});

// protects=the opened report at 375px: the table stays inside its container and
// the page does not scroll sideways, with a long unbroken id list open;
// fails_when=the ids go back inline in a nowrap cell, or the table loses its
// width bound; no_claim=any width but 375px. The markup is the REAL panel,
// serialised from jsdom, laid out with the app's compiled Tailwind.
describe("the import report 375px harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			findChrome(),
			"CI has no Chrome, so the import report 375px gate would skip",
		).not.toBeNull();
	});
});

describe.skipIf(findChrome() === null)(
	"the import report at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("keeps the report table inside its container with the ids open", async () => {
			const ids = Array.from({ length: 300 }, (_, i) => `${1472000 + i}`);
			// One id longer than the screen: only the cell's own wrapping holds it.
			ids[299] = `x${"y".repeat(120)}`;
			fns.previewEasySpeakImport.mockResolvedValue(
				previewFor(true, {
					reconciled: false,
					counts: [
						{
							key: "speeches",
							label: "Speeches with an introduction",
							bundle: 2000,
							gavelup: 1700,
							missing: ids,
						},
					],
					meetings: { applied: 1, failed: [] },
					notImported: [],
					skippedPeople: [],
					created: { guests: 0, roleDefinitions: [] },
				}),
			);
			await openImport();
			fireEvent.click(await screen.findByText(/Show source ids/));
			await screen.findByText(new RegExp(ids[299] as string));
			const table = document.querySelector("table");
			expect(table).not.toBeNull();
			const html = document.body.innerHTML;
			const css = await buildAppCss(candidatesIn(html));
			const script = `<script>
				const t=document.querySelector("table");
				const box=t.parentElement.getBoundingClientRect();
				document.title="doc="+(document.documentElement.scrollWidth>innerWidth)
					+";over="+(t.getBoundingClientRect().right-box.right);
			</script>`;
			const title = renderAndReadTitle({
				bodyHtml: html,
				css,
				script,
				viewport: { width: 375, height: 812 },
				tmpPrefix: "import-report-",
			});
			expect(title).toMatch(/doc=false/);
			expect(Number(/over=([-\d.]+)/.exec(title)?.[1])).toBeLessThanOrEqual(
				0.5,
			);
		});
	},
);
