// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	MeetingReadiness,
	ReadinessGap,
	ReadinessItem,
} from "#/lib/meeting-readiness";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingReadinessPanel } from "./meeting-readiness-panel";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(cleanup);

const gap = (n: number, holderName: string | null = null): ReadinessGap => ({
	slotId: `s${n}`,
	slotLabel: `Role ${n}`,
	holderName,
});

function item(
	over: Partial<ReadinessItem> & Pick<ReadinessItem, "id" | "label">,
): ReadinessItem {
	const gaps = over.gaps ?? [];
	const total = over.total ?? 4;
	return {
		done: gaps.length === 0,
		doneCount: total - gaps.length,
		total,
		gaps,
		...over,
	};
}

async function renderPanel(readiness: MeetingReadiness) {
	await renderUnderMemoryRouter(
		<MeetingReadinessPanel
			readiness={readiness}
			clubId="downtown"
			meetingId="2026-10-10"
			timezone="America/Chicago"
		/>,
	);
}

describe("MeetingReadinessPanel (#963)", () => {
	it("not ready: a card titled 'Before the meeting' with one row per item and its counts", async () => {
		await renderPanel({
			ready: false,
			items: [
				item({
					id: "roles_filled",
					label: "Roles filled",
					total: 5,
					gaps: [
						{ slotId: "a", slotLabel: "Ah-Counter", holderName: null },
						{ slotId: "b", slotLabel: "Speaker 2", holderName: "Pat" },
					],
				}),
				item({ id: "meeting_theme", label: "Theme set", total: 1 }),
			],
		});
		expect(
			screen.getByRole("heading", { name: "Before the meeting" }),
		).toBeTruthy();
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("Roles filled");
		expect(rows[0]?.textContent).toContain("3/5");
		// An open slot reads "(open)"; a held one names its holder.
		expect(rows[0]?.textContent).toContain("Ah-Counter (open)");
		expect(rows[0]?.textContent).toContain("Speaker 2 (Pat)");
		expect(rows[0]?.getAttribute("data-done")).toBe("false");
		// A done row carries no gap line and is announced as done.
		expect(rows[1]?.textContent).toContain("Theme set");
		expect(rows[1]?.textContent).toContain("1/1");
		expect(rows[1]?.getAttribute("data-done")).toBe("true");
		expect(within(rows[1] as HTMLElement).queryByText(/\(open\)/)).toBeNull();
		// The page says "Everything's set" ONLY when it is.
		expect(screen.queryByText(/Everything's set/)).toBeNull();
	});

	it("names three gaps at most, then '+N more'; three exactly says no more", async () => {
		await renderPanel({
			ready: false,
			items: [
				item({
					id: "roles_filled",
					label: "Roles filled",
					total: 8,
					gaps: [1, 2, 3, 4, 5].map((n) => gap(n, `Holder ${n}`)),
				}),
				item({
					id: "roles_confirmed",
					label: "Roles confirmed",
					total: 8,
					gaps: [1, 2, 3].map((n) => gap(n, `Holder ${n}`)),
				}),
			],
		});
		const [filled, confirmed] = screen.getAllByRole("listitem");
		const filledText = filled?.textContent ?? "";
		expect(filledText).toContain("Role 1 (Holder 1)");
		expect(filledText).toContain("Role 3 (Holder 3)");
		expect(filledText).not.toContain("Role 4");
		expect(filledText).not.toContain("Role 5");
		expect(filledText).toContain("+2 more");
		const confirmedText = confirmed?.textContent ?? "";
		expect(confirmedText).toContain("Role 3 (Holder 3)");
		expect(confirmedText).not.toContain("more");
	});

	it("ready: no item rows, just the one line and the deck link", async () => {
		await renderPanel({
			ready: true,
			items: [
				item({ id: "roles_filled", label: "Roles filled" }),
				item({ id: "meeting_theme", label: "Theme set", total: 1 }),
			],
		});
		expect(screen.getByText("Everything's set for this meeting")).toBeTruthy();
		expect(screen.queryAllByRole("listitem")).toHaveLength(0);
		expect(screen.queryByText("Roles filled")).toBeNull();
		expect(screen.queryByRole("heading")).toBeNull();
		expect(screen.getByRole("link", { name: "Preview the deck" })).toBeTruthy();
	});

	it("links to the deck on the present route, in a new tab, in both states", async () => {
		for (const ready of [false, true]) {
			await renderPanel({
				ready,
				items: ready
					? []
					: [
							item({
								id: "roles_filled",
								label: "Roles filled",
								gaps: [gap(1)],
							}),
						],
			});
			const link = screen.getByRole("link", { name: "Preview the deck" });
			expect(link.getAttribute("href")).toBe(
				"/club/downtown/meeting/2026-10-10/present",
			);
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toContain("noopener");
			cleanup();
		}
	});

	it("is read-only: the deck link is the only interactive control", async () => {
		await renderPanel({
			ready: false,
			items: [
				item({
					id: "roles_confirmed",
					label: "Roles confirmed",
					gaps: [gap(1, "Pat")],
				}),
			],
		});
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(screen.getAllByRole("link")).toHaveLength(1);
	});

	describe("cover gaps (#1441)", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
			vi.clearAllMocks();
		});
		const coverGap = (
			n: number,
			status: "dropped" | "finding_cover",
		): ReadinessGap => ({
			slotId: `c${n}`,
			slotLabel: "Timer",
			holderName: null,
			cover: {
				status,
				releasedName: "Sam",
				// Tue 9:14pm in Chicago
				releasedAt: "2026-10-28T02:14:00.000Z",
				weekday: "Saturday",
			},
		});
		const cover = (gaps: ReadinessGap[]): MeetingReadiness => ({
			ready: false,
			items: [item({ id: "roles_filled", label: "Roles filled", gaps })],
		});

		it("shows the dropped note and the finding-cover note", async () => {
			await renderPanel(
				cover([coverGap(1, "dropped"), coverGap(2, "finding_cover")]),
			);
			expect(screen.getByTestId("readiness-cover-c1").textContent).toContain(
				"Open: Sam dropped it Tue 9:14pm",
			);
			expect(screen.getByTestId("readiness-cover-c2").textContent).toContain(
				"Sam is finding cover",
			);
		});

		const click = (name = 'Copy "we need a Timer"') =>
			fireEvent.click(screen.getByRole("button", { name }));
		const phone = (coarse: boolean) =>
			vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: coarse }));

		it("the button copies the role, the weekday and the cover link", async () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { clipboard: { writeText } });
			phone(false);
			await renderPanel(cover([coverGap(1, "dropped")]));
			click();
			await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
			const text = writeText.mock.calls[0][0] as string;
			expect(text).toContain("Timer");
			expect(text).toContain("Saturday");
			expect(text).toContain("/club/downtown/meeting/2026-10-10?cover=c1");
			await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
			expect(toast.error).not.toHaveBeenCalled();
		});

		it("uses the share sheet on a phone (share and a coarse pointer)", async () => {
			const share = vi.fn().mockResolvedValue(undefined);
			const writeText = vi.fn();
			vi.stubGlobal("navigator", { share, clipboard: { writeText } });
			phone(true);
			await renderPanel(cover([coverGap(1, "dropped")]));
			click();
			await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
			expect(share.mock.calls[0][0].text).toContain("?cover=c1");
			expect(writeText).not.toHaveBeenCalled();
		});

		it("a desktop browser with navigator.share still copies", async () => {
			const share = vi.fn();
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { share, clipboard: { writeText } });
			phone(false);
			await renderPanel(cover([coverGap(1, "dropped")]));
			click();
			await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
			expect(share).not.toHaveBeenCalled();
		});

		it("closing the share sheet is silent", async () => {
			const share = vi
				.fn()
				.mockRejectedValue(new DOMException("closed", "AbortError"));
			vi.stubGlobal("navigator", { share });
			phone(true);
			await renderPanel(cover([coverGap(1, "dropped")]));
			click();
			await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
			await new Promise((r) => setTimeout(r, 0));
			expect(toast.error).not.toHaveBeenCalled();
			expect(toast.success).not.toHaveBeenCalled();
		});

		it("a blocked clipboard write shows the error toast", async () => {
			const writeText = vi.fn().mockRejectedValue(new Error("denied"));
			vi.stubGlobal("navigator", { clipboard: { writeText } });
			phone(false);
			await renderPanel(cover([coverGap(1, "dropped")]));
			click();
			await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
			expect(toast.success).not.toHaveBeenCalled();
		});

		it("the label takes 'an' before a vowel", async () => {
			vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
			await renderPanel(
				cover([
					{ ...coverGap(1, "dropped"), slotLabel: "Evaluator" },
					{ ...coverGap(2, "dropped"), slotLabel: "Ah-Counter" },
				]),
			);
			screen.getByRole("button", { name: 'Copy "we need an Evaluator"' });
			screen.getByRole("button", { name: 'Copy "we need an Ah-Counter"' });
		});

		it("a plain gap has no button, and cover rows do not repeat in the plain list", async () => {
			await renderPanel(cover([coverGap(1, "dropped"), gap(2)]));
			expect(screen.getAllByRole("button")).toHaveLength(1);
			expect(
				screen.getByTestId("readiness-item-roles_filled").textContent,
			).toContain("Role 2 (open)");
			expect(
				screen.getByTestId("readiness-item-roles_filled").textContent,
			).not.toContain("Timer (open)");
		});
	});
});

describe("first-time Toastmaster note (#1481)", () => {
	const note = {
		memberId: "m-new",
		name: "Pat Newcomer",
		preferredName: "Pat",
		phone: null as string | null,
	};
	const notReady: MeetingReadiness = {
		ready: false,
		items: [
			item({
				id: "roles_filled",
				label: "Roles filled",
				total: 5,
				gaps: [gap(1)],
			}),
		],
	};
	const allDone: MeetingReadiness = {
		ready: true,
		items: [item({ id: "roles_filled", label: "Roles filled", total: 5 })],
	};

	async function renderWith(
		readiness: MeetingReadiness,
		over: {
			note?: typeof note | null;
			isOfficer?: boolean;
			viewerMemberId?: string | null;
		} = {},
	) {
		await renderUnderMemoryRouter(
			<MeetingReadinessPanel
				readiness={readiness}
				clubId="downtown"
				meetingId="2026-10-10"
				timezone="America/Chicago"
				firstTime={{
					note,
					isOfficer: true,
					viewerMemberId: "officer",
					meetingDate: "Sat, Oct 10",
					...over,
				}}
			/>,
		);
	}

	// protects=an officer sees the row with the member's preferred name and a Note button that copies the draft (script URL included) when there is no phone; fails_when=the row is not rendered, the name is the stored full name, or the draft lacks the /me/script link; no_claim=the WhatsApp path (next test)
	it("an officer sees the row, and the button copies the drafted note", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		await renderWith(notReady);
		expect(
			screen.getByText("Pat's first time as Toastmaster here."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Note to Pat" }));
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const text = writeText.mock.calls[0][0] as string;
		expect(text).toContain("Hi Pat,");
		expect(text).toContain("/club/downtown/meeting/2026-10-10/me/script");
		expect(text).toContain("Sat, Oct 10");
		vi.unstubAllGlobals();
	});

	// protects=with a phone the button is a WhatsApp link carrying the draft; fails_when=the phone is ignored and a copy button renders; no_claim=the number's formatting (nudge.test.ts)
	it("with a phone the button opens WhatsApp", async () => {
		await renderWith(notReady, {
			note: { ...note, phone: "+15555550122" },
		});
		const link = screen.getByRole("link", { name: "Note to Pat" });
		expect(link.getAttribute("href")).toContain("15555550122");
		expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain(
			"/me/script",
		);
	});

	// protects=an officer who IS the first-timer, a non-officer viewer (the Toastmaster the panel also opens for) and a null prop see no row; fails_when=any of the three gates is dropped; no_claim=who the route opens the panel for (the wiring guard)
	it("hides for the first-timer themselves, for a non-officer and for a null prop", async () => {
		await renderWith(notReady, { viewerMemberId: "m-new" });
		expect(screen.queryByTestId("first-time-toastmaster-note")).toBeNull();
		cleanup();
		await renderWith(notReady, { isOfficer: false });
		expect(screen.queryByTestId("first-time-toastmaster-note")).toBeNull();
		cleanup();
		await renderWith(notReady, { note: null });
		expect(screen.queryByTestId("first-time-toastmaster-note")).toBeNull();
	});

	// protects=the row shows beside "Everything's set" and neither state's rows change; fails_when=the ready branch returns before the note, or the note replaces a readiness row; no_claim=`meetingReadiness()`'s own `ready` (meeting-readiness tests)
	it("shows when everything is set, and in the not-ready card without touching its items", async () => {
		await renderWith(allDone);
		expect(screen.getByText("Everything's set for this meeting")).toBeTruthy();
		expect(screen.getByTestId("first-time-toastmaster-note")).toBeTruthy();
		cleanup();
		await renderWith(notReady);
		expect(screen.getByTestId("first-time-toastmaster-note")).toBeTruthy();
		expect(screen.getAllByTestId(/^readiness-item-/)).toHaveLength(1);
	});

	// protects=`ready` and `items` are not an input the note can change: the readiness object is passed through untouched; fails_when=the panel or a helper mutates the readiness it was given; no_claim=get_agenda's output (its own regression test)
	it("leaves the readiness it was given unchanged", async () => {
		const before = JSON.stringify(allDone);
		await renderWith(allDone);
		expect(JSON.stringify(allDone)).toBe(before);
		expect(allDone.ready).toBe(true);
	});
});
