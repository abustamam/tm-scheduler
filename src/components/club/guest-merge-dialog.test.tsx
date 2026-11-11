// @vitest-environment jsdom
/**
 * The guest merge dialog (#1609): pick the other record, choose which to keep,
 * read the preview, confirm.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	listMergeGuestCandidates,
	previewMergeGuests,
	mergeGuests,
	invalidate,
	toastSuccess,
	toastError,
} = vi.hoisted(() => ({
	listMergeGuestCandidates: vi.fn(),
	previewMergeGuests: vi.fn(),
	mergeGuests: vi.fn(),
	invalidate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/guest-merge", () => ({
	listMergeGuestCandidates,
	previewMergeGuests,
	mergeGuests,
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate }),
}));

import { GuestMergeDialog } from "#/components/club/guest-merge-dialog";

const PREVIEW = {
	moved: { meeting_attendance: 2, speeches: 1 },
	droppedAsDuplicate: { meeting_attendance: 1 },
	absorbedPersonDeleted: false,
	refusal: null,
};

function renderDialog(onMerged = vi.fn(), onOpenChange = vi.fn()) {
	render(
		<GuestMergeDialog
			guestId="g-this"
			guestName="Kay Keeper"
			clubId="c1"
			open
			onOpenChange={onOpenChange}
			onMerged={onMerged}
		/>,
	);
	return { onMerged, onOpenChange };
}

async function pickOther() {
	const select = await screen.findByLabelText("Other record");
	fireEvent.change(select, { target: { value: "g-other" } });
}

describe("GuestMergeDialog (#1609)", () => {
	beforeEach(() => {
		listMergeGuestCandidates.mockResolvedValue([
			{
				id: "g-other",
				name: "Abe Absorbed",
				kind: "visitor",
				stage: "prospect",
			},
		]);
		previewMergeGuests.mockResolvedValue(PREVIEW);
		mergeGuests.mockResolvedValue(PREVIEW);
		invalidate.mockResolvedValue(undefined);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("previews the counts and merges the opened record by default", async () => {
		// protects=the opened record is the default keeper; the preview shows what moves and the dropped duplicates; confirm calls mergeGuests with keep = this, absorb = the picked guest;
		// fails_when=the default keeper flips, the counts are not shown, or the ids are sent the wrong way round;
		// no_claim=that the server merges correctly (guest-merge.integration.test.ts)
		const { onMerged } = renderDialog();
		await pickOther();
		await screen.findByText("2 attendance records");
		expect(screen.getByText("1 speech")).toBeTruthy();
		expect(
			screen.getByText(/1 same-meeting duplicate is dropped/),
		).toBeTruthy();
		expect(previewMergeGuests).toHaveBeenLastCalledWith({
			data: { clubId: "c1", keepGuestId: "g-this", absorbGuestId: "g-other" },
		});
		expect(screen.getByText(/cannot be undone/i)).toBeTruthy();

		fireEvent.click(
			await screen.findByRole("button", { name: "Merge into Kay Keeper" }),
		);
		await waitFor(() => expect(mergeGuests).toHaveBeenCalledTimes(1));
		expect(mergeGuests).toHaveBeenCalledWith({
			data: { clubId: "c1", keepGuestId: "g-this", absorbGuestId: "g-other" },
		});
		await waitFor(() => expect(onMerged).toHaveBeenCalled());
		expect(toastSuccess).toHaveBeenCalled();
	});

	it("keeps the OTHER record when the admin chooses it, and re-previews that way round", async () => {
		// protects=choosing the other record as keeper swaps the ids sent to preview and to the merge, and the confirm button names it;
		// fails_when=the radio does not change the ids;
		// no_claim=anything about the server
		renderDialog();
		await pickOther();
		await screen.findByText("2 attendance records");
		fireEvent.click(screen.getByLabelText("Abe Absorbed"));
		fireEvent.click(
			await screen.findByRole("button", { name: "Merge into Abe Absorbed" }),
		);
		await waitFor(() => expect(mergeGuests).toHaveBeenCalledTimes(1));
		expect(mergeGuests).toHaveBeenCalledWith({
			data: { clubId: "c1", keepGuestId: "g-other", absorbGuestId: "g-this" },
		});
	});

	it("shows a refusal and offers no confirm", async () => {
		// protects=a refused merge shows the server's reason and the confirm button stays disabled;
		// fails_when=the refusal is dropped or the button is enabled;
		// no_claim=which refusals the server raises
		previewMergeGuests.mockResolvedValue({
			...PREVIEW,
			refusal: "Undo or finish the conversion first.",
		});
		renderDialog();
		await pickOther();
		await screen.findByText("Undo or finish the conversion first.");
		const button = screen.getByRole("button", {
			name: "Merge into Kay Keeper",
		});
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(mergeGuests).not.toHaveBeenCalled();
	});

	it("shows an error when the candidate list cannot be loaded", async () => {
		// protects=a failed picker load shows a message instead of a spinner that never ends;
		// fails_when=the load .catch is removed or the message is not rendered;
		// no_claim=the server's list
		listMergeGuestCandidates.mockRejectedValue(new Error("boom"));
		renderDialog();
		await waitFor(() =>
			expect(
				document.querySelector("[data-slot=guest-merge-load-error]"),
			).toBeTruthy(),
		);
		expect(screen.queryByLabelText("Other record")).toBeNull();
	});

	it("shows an error and offers no confirm when the preview throws", async () => {
		// protects=a preview that throws is shown as a refusal and the confirm stays disabled;
		// fails_when=the preview .catch is removed (unhandled rejection, confirm left enabled);
		// no_claim=the server's refusals
		previewMergeGuests.mockRejectedValue(new Error("preview boom"));
		renderDialog();
		await pickOther();
		await screen.findByRole("alert");
		const button = screen.getByRole("button", {
			name: "Merge into Kay Keeper",
		});
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(mergeGuests).not.toHaveBeenCalled();
	});

	it("toasts an error and stays open when the merge throws", async () => {
		// protects=a failed merge reports the error, does not call onMerged, and leaves the dialog open;
		// fails_when=the merge .catch is removed or the dialog closes / onMerged fires on failure;
		// no_claim=why the server failed
		mergeGuests.mockRejectedValue(new Error("merge boom"));
		const { onMerged, onOpenChange } = renderDialog();
		await pickOther();
		await screen.findByText("2 attendance records");
		fireEvent.click(
			await screen.findByRole("button", { name: "Merge into Kay Keeper" }),
		);
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(onMerged).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(toastSuccess).not.toHaveBeenCalled();
	});
});
