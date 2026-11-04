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
