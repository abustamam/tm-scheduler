// @vitest-environment jsdom
//
// The meeting's promo note (#931) in the "Edit meeting" dialog. Admin-only:
// the field renders only for an admin, and the key is SENT only then, because
// `applyMeetingMetaPatch` refuses it on presence from anyone else — a TMOD's
// ordinary save carrying `promoNote: ""` would be refused outright.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({
	updateMeeting: vi.fn(async () => ({ clubId: "c1" })),
}));

const { updateMeeting } = await import("#/server/meetings");
const { MeetingMetaDialog } = await import("./meeting-meta-dialog");

afterEach(() => {
	cleanup();
	vi.mocked(updateMeeting).mockClear();
});

type MeetingProp = Parameters<typeof MeetingMetaDialog>[0]["meeting"];

const meeting = (over: Record<string, unknown> = {}) =>
	({
		id: "22222222-2222-4222-8222-222222222222",
		scheduledAt: new Date("2026-09-15T00:00:00Z"),
		lengthMinutes: 90,
		meetingNumber: null,
		location: "Room 5",
		joinUrl: null,
		theme: null,
		wordOfTheDay: null,
		wodDefinition: null,
		wodExample: null,
		notes: null,
		reminders: null,
		promoNote: null,
		...over,
	}) as unknown as MeetingProp;

function renderDialog(canReschedule: boolean, over = {}) {
	render(
		<MeetingMetaDialog
			open
			onOpenChange={() => {}}
			meeting={meeting(over)}
			timezone="America/Chicago"
			selfMemberId={
				canReschedule ? null : "33333333-3333-4333-8333-333333333333"
			}
			canReschedule={canReschedule}
			onSaved={vi.fn(async () => {})}
		/>,
	);
	return userEvent.setup();
}

const sent = () =>
	vi.mocked(updateMeeting).mock.calls[0]?.[0]?.data as Record<string, unknown>;

describe("the promo note (#931)", () => {
	it("an admin sees it prefilled and saves what they typed", async () => {
		const user = renderDialog(true, { promoNote: "Old note" });
		const input = screen.getByLabelText("Promo note") as HTMLInputElement;
		expect(input.value).toBe("Old note");
		await user.clear(input);
		await user.type(input, "Open house, bring a friend!");
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalledTimes(1));
		expect(sent().promoNote).toBe("Open house, bring a friend!");
	});

	it("an admin clearing it sends a blank, which is how it is cleared", async () => {
		const user = renderDialog(true, { promoNote: "Old note" });
		await user.clear(screen.getByLabelText("Promo note"));
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalledTimes(1));
		expect(sent().promoNote).toBe("");
	});

	it("a self-serve TMOD neither sees it nor sends the key", async () => {
		const user = renderDialog(false, { promoNote: "Admin's note" });
		expect(screen.queryByLabelText("Promo note")).toBeNull();
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalledTimes(1));
		expect(Object.hasOwn(sent(), "promoNote")).toBe(false);
	});
});
