// @vitest-environment jsdom

// "Who can cover <Role>?" (#1439): what the sheet shows, what each button
// writes and in which order, and what happens when the share fails.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	askForCover,
	loadCoverCandidates,
	releaseOwnSlotForCover,
	undoReleaseForCover,
	toastSuccess,
	toastDismiss,
	toastError,
} = vi.hoisted(() => ({
	askForCover: vi.fn(async (_a: unknown) => ({ ok: true })),
	loadCoverCandidates: vi.fn(async (_a: unknown) => [] as unknown[]),
	releaseOwnSlotForCover: vi.fn(async (_a: unknown) => ({ ok: true })),
	undoReleaseForCover: vi.fn(async (_a: unknown) => ({ ok: true })),
	toastSuccess: vi.fn(),
	toastDismiss: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/cover", () => ({
	askForCover,
	loadCoverCandidates,
	releaseOwnSlotForCover,
	undoReleaseForCover,
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: toastSuccess,
		error: toastError,
		dismiss: toastDismiss,
	}),
}));

import { CoverSheet, type CoverSlot } from "#/components/club/cover-sheet";
import {
	coverDraft,
	coverSlotFromCommitment,
	meetingDayWord,
	opensCoverSheet,
} from "#/lib/cover-sheet-logic";

const slot: CoverSlot = {
	slotId: "11111111-1111-4111-8111-111111111111",
	meetingId: "22222222-2222-4222-8222-222222222222",
	roleLabel: "Timer",
	scheduledAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
	clubSlug: "demo",
	urlKey: "2026-11-04",
	timeZone: "UTC",
};

const priya = {
	memberId: "p",
	name: "Priya Patel",
	lastServedAt: null,
};
const sam = {
	memberId: "s",
	name: "Sam Lee",
	lastServedAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
};

function mount(over: Partial<React.ComponentProps<typeof CoverSheet>> = {}) {
	const onClose = vi.fn();
	const onChanged = vi.fn();
	render(
		<CoverSheet
			slots={[slot]}
			onClose={onClose}
			onChanged={onChanged}
			{...over}
		/>,
	);
	return { onClose, onChanged };
}

beforeEach(() => {
	loadCoverCandidates.mockResolvedValue([priya, sam]);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	// biome-ignore lint/suspicious/noExplicitAny: jsdom has no share
	delete (navigator as any).share;
});

function stubShare(impl: (d: ShareData) => Promise<void>) {
	const share = vi.fn(impl);
	Object.defineProperty(navigator, "share", {
		value: share,
		configurable: true,
	});
	return share;
}
function stubClipboard() {
	const writeText = vi.fn(async (_t: string) => {});
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	return writeText;
}

describe("CoverSheet", () => {
	it("lists candidates with how recently they held the role, and releases nothing on open", async () => {
		// protects=AC 1: opening the sheet writes nothing; the copy and the
		//   "never been" / "N weeks ago" lines render
		// fails_when=the sheet releases on mount, or a candidate line is lost
		mount();
		expect(
			screen.getByRole("heading", { name: "Who can cover Timer?" }),
		).toBeTruthy();
		expect(await screen.findByText("Priya Patel")).toBeTruthy();
		expect(screen.getByText("coming · never been Timer")).toBeTruthy();
		expect(screen.getByText(/coming · Timer 3 wks ago/)).toBeTruthy();
		expect(screen.getByText(/your VPE finds out at the meeting/)).toBeTruthy();
		expect(releaseOwnSlotForCover).not.toHaveBeenCalled();
		expect(loadCoverCandidates).toHaveBeenCalledWith({
			data: { meetingId: slot.meetingId, slotId: slot.slotId },
		});
	});

	it("says nobody is coming yet, and still offers Ask with a generic draft and Drop it anyway", async () => {
		// protects=AC 3: an empty list is not a dead end
		// fails_when=the empty state drops Ask or Drop it anyway, or the draft
		//   carries a name
		loadCoverCandidates.mockResolvedValue([]);
		const share = stubShare(async () => {});
		mount();
		expect(
			await screen.findByText("Nobody has said they're coming yet."),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Drop it anyway" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Ask" }));
		await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
		const text = share.mock.calls[0][0].text as string;
		expect(text.startsWith("Hi! ")).toBe(true);
		expect(text).toContain("/club/demo/meeting/2026-11-04?cover=");
	});

	it("Ask releases once as finding_cover, then shares a draft naming the first name", async () => {
		// protects=the order (release, then share), the kind, and the name in the
		//   draft; a second Ask only shares
		// fails_when=Ask shares before releasing, releases twice, or drops the name
		const share = stubShare(async () => {});
		const order: string[] = [];
		releaseOwnSlotForCover.mockImplementation(async () => {
			order.push("release");
			return { ok: true };
		});
		share.mockImplementation(async () => {
			order.push("share");
		});
		mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
		expect(order).toEqual(["release", "share"]);
		expect(releaseOwnSlotForCover).toHaveBeenCalledWith({
			data: { slotId: slot.slotId, kind: "finding_cover" },
		});
		expect(share.mock.calls[0][0].text).toMatch(/^Hi Priya! /);

		await userEvent.click(screen.getByRole("button", { name: "Ask Sam Lee" }));
		await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
		expect(releaseOwnSlotForCover).toHaveBeenCalledTimes(1);
		expect(share.mock.calls[1][0].text).toMatch(/^Hi Sam! /);
	});

	it("the release toast's Undo calls undoReleaseForCover", async () => {
		// protects=eng review D4: Undo restores status, claim time and speech
		// fails_when=Undo re-claims instead
		stubShare(async () => {});
		const { onChanged } = mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		const action = (
			toastSuccess.mock.calls[0][1] as {
				action: { onClick: () => Promise<void> };
			}
		).action;
		await action.onClick();
		expect(undoReleaseForCover).toHaveBeenCalledWith({
			data: { slotId: slot.slotId },
		});
		expect(onChanged).toHaveBeenCalled();
	});

	it("copies a plain-text draft where there is no share sheet", async () => {
		// protects=eng review O9: a plain clipboard write of the draft, with the
		//   origin-free text intact, plus the "Copied" toast
		// fails_when=the fallback goes through copyShareLink (origin prepended) or
		//   is silent
		const writeText = stubClipboard();
		mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toMatch(/^Hi Priya! I can't make /);
		expect(writeText.mock.calls[0][0]).not.toMatch(/^http/);
		expect(toastSuccess).toHaveBeenCalledWith("Copied. Paste it to Priya.");
	});

	it("keeps the release and shows 'Not sent' when the share sheet is cancelled", async () => {
		// protects=a cancelled share after the release does not undo or close it
		// fails_when=the sheet closes, or the message is missing
		stubShare(async () => {
			throw new DOMException("cancelled", "AbortError");
		});
		const { onClose } = mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		expect(
			await screen.findByText("Not sent. Ask someone else, or close."),
		).toBeTruthy();
		expect(releaseOwnSlotForCover).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("Drop it anyway releases as dropped and closes", async () => {
		// protects=the other button: kind dropped, no share, sheet closes
		// fails_when=it asks someone, or leaves the sheet open
		const share = stubShare(async () => {});
		const { onClose } = mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Drop it anyway" }),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(releaseOwnSlotForCover).toHaveBeenCalledWith({
			data: { slotId: slot.slotId, kind: "dropped" },
		});
		expect(share).not.toHaveBeenCalled();
	});

	it("already-released mode calls askForCover per slot and never releases", async () => {
		// protects=eng review D5: the decline-freed list (#1442) asks, it does not
		//   release, and offers no Drop it anyway
		// fails_when=Ask calls releaseOwnSlotForCover, or Drop it anyway shows
		const share = stubShare(async () => {});
		mount({ mode: "released" });
		expect(screen.queryByRole("button", { name: "Drop it anyway" })).toBeNull();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
		expect(askForCover).toHaveBeenCalledWith({
			data: { slotId: slot.slotId },
		});
		expect(releaseOwnSlotForCover).not.toHaveBeenCalled();
		// No release happened here, so there is nothing for an Undo to give back.
		await screen.findByText(/is open and the request is in/);
		expect(
			screen.queryByRole("button", { name: /Undo: I'll keep/ }),
		).toBeNull();
	});

	it("Undo while the sheet is open returns it to its pre-release state", async () => {
		// protects=finding 1: after Undo the role is held again, so the sheet
		//   says so, offers Drop it anyway, and the next Ask releases again
		// fails_when=Undo leaves the slot in handedOff (sheet still reads "open
		//   and the request is in", Drop it anyway hidden, next Ask only shares)
		stubShare(async () => {});
		mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await screen.findByText(/is open and the request is in/);
		expect(screen.queryByRole("button", { name: "Drop it anyway" })).toBeNull();
		const action = (
			toastSuccess.mock.calls[0][1] as {
				action: { onClick: () => Promise<void> };
			}
		).action;
		await act(async () => {
			await action.onClick();
		});
		expect(screen.queryByText(/is open and the request is in/)).toBeNull();
		expect(screen.getByText(/your VPE finds out at the meeting/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Drop it anyway" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Ask Sam Lee" }));
		await waitFor(() =>
			expect(releaseOwnSlotForCover).toHaveBeenCalledTimes(2),
		);
	});

	it("the sheet carries its own Undo, because the overlay covers the toast's", async () => {
		// protects=#1455: the toast's Undo is unclickable under the modal overlay
		// fails_when=the in-sheet Undo button is removed
		stubShare(async () => {});
		mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await screen.findByText(/is open and the request is in/);
		await userEvent.click(
			screen.getByRole("button", { name: /Undo: I'll keep/ }),
		);
		await waitFor(() => expect(undoReleaseForCover).toHaveBeenCalledTimes(1));
		expect(undoReleaseForCover).toHaveBeenCalledWith({
			data: { slotId: slot.slotId },
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Drop it anyway" }),
			).toBeTruthy(),
		);
		expect(
			screen.queryByRole("button", { name: /Undo: I'll keep/ }),
		).toBeNull();
	});

	async function askAndOpenUndo() {
		stubShare(async () => {});
		toastSuccess.mockReturnValueOnce("release-toast");
		mount();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await screen.findByText(/is open and the request is in/);
		return screen.getByRole("button", { name: /Undo: I'll keep/ });
	}

	it("a double-tap on the in-sheet Undo fires one undo, and Ask waits for it", async () => {
		// protects=the busy guard on undoRelease: no double undo, no Ask mid-undo
		// fails_when=undoRelease ignores busy
		const undo = await askAndOpenUndo();
		let finish: (v: { ok: boolean }) => void = () => {};
		undoReleaseForCover.mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				}),
		);
		await userEvent.dblClick(undo);
		expect(undoReleaseForCover).toHaveBeenCalledTimes(1);
		expect(
			(
				screen.getByRole("button", {
					name: /Undo: I'll keep/,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Ask Priya Patel",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await act(async () => {
			finish({ ok: true });
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Drop it anyway" }),
			).toBeTruthy(),
		);
	});

	it("the toast's Undo tapped twice (after the sheet's) fires one undo", async () => {
		// protects=the early return in undoRelease, which the disabled button
		//   cannot cover: the toast action is a second entry point
		// fails_when=undoRelease does not return while busy
		await askAndOpenUndo();
		const action = (
			toastSuccess.mock.calls[0][1] as {
				action: { onClick: () => Promise<void> };
			}
		).action;
		let finish: (v: { ok: boolean }) => void = () => {};
		undoReleaseForCover.mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				}),
		);
		await act(async () => {
			void action.onClick();
		});
		await act(async () => {
			await action.onClick();
		});
		expect(undoReleaseForCover).toHaveBeenCalledTimes(1);
		await act(async () => {
			finish({ ok: true });
		});
	});

	it("a successful in-sheet Undo dismisses the release toast", async () => {
		// protects=a stale toast Undo that would later hit "Someone already took it"
		// fails_when=the release toast id is not dismissed on Undo
		const undo = await askAndOpenUndo();
		await userEvent.click(undo);
		await waitFor(() =>
			expect(toastDismiss).toHaveBeenCalledWith("release-toast"),
		);
	});

	it("a failed in-sheet Undo says so and keeps the sheet in its released state", async () => {
		// protects=the error path of undoRelease
		// fails_when=the error is swallowed, or the sheet reads as undone
		const undo = await askAndOpenUndo();
		undoReleaseForCover.mockRejectedValueOnce(
			new Error("Someone already took it."),
		);
		await userEvent.click(undo);
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Someone already took it."),
		);
		expect(toastDismiss).not.toHaveBeenCalled();
		expect(screen.getByText(/is open and the request is in/)).toBeTruthy();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: /Undo: I'll keep/,
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
	});

	it("a failed candidate load says so, and still offers Ask and Drop it anyway", async () => {
		// protects=finding 3: an error is not "nobody is coming yet"
		// fails_when=the failure reads as the empty state, or drops a button
		loadCoverCandidates.mockRejectedValue(new Error("boom"));
		const share = stubShare(async () => {});
		mount();
		expect(await screen.findByText("Couldn't load who's coming.")).toBeTruthy();
		expect(screen.queryByText(/Nobody has said/)).toBeNull();
		expect(screen.getByRole("button", { name: "Drop it anyway" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Ask" }));
		await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
		expect(share.mock.calls[0][0].text as string).toMatch(/^Hi! /);
	});

	it("already-released mode does not claim the request is in before Ask", async () => {
		// protects=finding 4: the copy is true at each point
		// fails_when=released mode says "the request is in" before askForCover ran
		stubShare(async () => {});
		mount({ mode: "released" });
		expect(screen.queryByText(/the request is in/)).toBeNull();
		expect(screen.getByText(/Timer is open\. Ask someone/)).toBeTruthy();
		await userEvent.click(
			await screen.findByRole("button", { name: "Ask Priya Patel" }),
		);
		await screen.findByText(/is open and the request is in/);
	});

	it("renders nothing when there are no slots", () => {
		// protects=closed means closed
		// fails_when=the sheet opens on an empty list
		mount({ slots: [] });
		expect(screen.queryByRole("heading")).toBeNull();
	});
});

describe("opensCoverSheet (the gate /me and club home call)", () => {
	// Those two routes cannot mount in vitest (they import the database), so
	// their AC2 behaviour is tested at the gate they both call; the source
	// guard in cover-sheet-wiring.guard.test.ts pins that they call it first.
	const now = new Date("2026-11-03T12:00:00Z");
	const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
	it("opens only for an own role inside 48h", () => {
		// protects=AC2: >48h own and another's row keep the immediate release
		// fails_when=the 48h bound or the own-row term is dropped
		expect(opensCoverSheet({ isOwnRole: true, scheduledAt: at(20), now })).toBe(
			true,
		);
		expect(
			opensCoverSheet({ isOwnRole: true, scheduledAt: at(100), now }),
		).toBe(false);
		expect(
			opensCoverSheet({ isOwnRole: false, scheduledAt: at(20), now }),
		).toBe(false);
	});
});

describe("coverSlotFromCommitment", () => {
	it("carries the covered row's own zone, and the caller's link parts", () => {
		// protects=finding 5: the zone comes from the row, not a neighbour
		// fails_when=the zone is dropped or the link parts are swapped
		const out = coverSlotFromCommitment(
			{
				slotId: "s",
				meetingId: "m",
				roleName: "Timer",
				scheduledAt: "2026-11-04T01:00:00Z",
				timezone: "Asia/Tokyo",
			},
			{ clubSlug: "demo", urlKey: "m" },
		);
		expect(out).toEqual({
			slotId: "s",
			meetingId: "m",
			roleLabel: "Timer",
			scheduledAt: "2026-11-04T01:00:00Z",
			clubSlug: "demo",
			urlKey: "m",
			timeZone: "Asia/Tokyo",
		});
	});
});

describe("cover sheet words", () => {
	const now = new Date("2026-11-03T12:00:00Z");
	it("says tomorrow, today, or the weekday", () => {
		// protects=the warning line's day word
		// fails_when=tomorrow reads as a weekday, or a day out reads as tomorrow
		expect(meetingDayWord(new Date("2026-11-04T01:00:00Z"), now, "UTC")).toBe(
			"tomorrow",
		);
		expect(meetingDayWord(new Date("2026-11-03T18:00:00Z"), now, "UTC")).toBe(
			"today",
		);
		expect(meetingDayWord(new Date("2026-11-05T01:00:00Z"), now, "UTC")).toBe(
			"Thursday",
		);
	});
	it("puts the first name in place of the leading Hi!", () => {
		// protects=buildCoverAsk's name-less draft is personalised, not rewritten
		// fails_when=the replacement hits a later "Hi!" or leaves the generic one
		const text = coverDraft({
			slot,
			origin: "https://x.test",
			firstName: "Priya",
		});
		expect(text.startsWith("Hi Priya! I can't make ")).toBe(true);
		expect(text).toContain("https://x.test/club/demo/meeting/2026-11-04");
	});
});
