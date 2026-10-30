// @vitest-environment jsdom

// "Who can cover <Role>?" (#1439): what the sheet shows, what each button
// writes and in which order, and what happens when the share fails.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	askForCover,
	loadCoverCandidates,
	releaseOwnSlotForCover,
	undoReleaseForCover,
	toastSuccess,
} = vi.hoisted(() => ({
	askForCover: vi.fn(async (_a: unknown) => ({ ok: true })),
	loadCoverCandidates: vi.fn(async (_a: unknown) => [] as unknown[]),
	releaseOwnSlotForCover: vi.fn(async (_a: unknown) => ({ ok: true })),
	undoReleaseForCover: vi.fn(async (_a: unknown) => ({ ok: true })),
	toastSuccess: vi.fn(),
}));
vi.mock("#/server/cover", () => ({
	askForCover,
	loadCoverCandidates,
	releaseOwnSlotForCover,
	undoReleaseForCover,
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn() }),
}));

import { CoverSheet, type CoverSlot } from "#/components/club/cover-sheet";
import { coverDraft, meetingDayWord } from "#/lib/cover-sheet-logic";

const slot: CoverSlot = {
	slotId: "11111111-1111-4111-8111-111111111111",
	meetingId: "22222222-2222-4222-8222-222222222222",
	roleLabel: "Timer",
	scheduledAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
	clubSlug: "demo",
	urlKey: "2026-11-04",
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
	});

	it("renders nothing when there are no slots", () => {
		// protects=closed means closed
		// fails_when=the sheet opens on an empty list
		mount({ slots: [] });
		expect(screen.queryByRole("heading")).toBeNull();
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
			timeZone: "UTC",
			firstName: "Priya",
		});
		expect(text.startsWith("Hi Priya! I can't make ")).toBe(true);
		expect(text).toContain("https://x.test/club/demo/meeting/2026-11-04");
	});
});
