// @vitest-environment jsdom
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
		location: null,
		joinUrl: null,
		theme: "New beginnings",
		wordOfTheDay: null,
		wodDefinition: null,
		wodExample: null,
		notes: null,
		reminders: null,
		...over,
	}) as unknown as MeetingProp;
const field = () =>
	screen.getByLabelText("Video call link") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /save changes/i });
const sentData = () =>
	vi.mocked(updateMeeting).mock.calls[0][0] as unknown as {
		data: Record<string, unknown>;
	};

function setup(over: Record<string, unknown> = {}) {
	render(
		<MeetingMetaDialog
			open
			onOpenChange={() => {}}
			meeting={meeting(over)}
			timezone="America/Chicago"
			selfMemberId={null}
			canReschedule={false}
			onSaved={vi.fn(async () => {})}
		/>,
	);
	return { user: userEvent.setup(), input: field(), save: saveButton() };
}

/**
 * #1444, D6. A viewer who may edit but is not a member (a roster-picked
 * Toastmaster) gets a payload with NO `joinUrl` key. The field then starts
 * empty without meaning "no link", so an untouched field must not send a blank:
 * that would clear the stored link on a theme or Word of the Day save.
 */
describe("a payload that withholds the link", () => {
	const withheld = (hasJoinLink = true) => {
		const m = meeting() as unknown as Record<string, unknown>;
		delete m.joinUrl;
		return (
			<MeetingMetaDialog
				open
				onOpenChange={() => {}}
				meeting={m as unknown as MeetingProp}
				timezone="America/Chicago"
				selfMemberId={null}
				canReschedule={false}
				hasJoinLink={hasJoinLink}
				onSaved={vi.fn(async () => {})}
			/>
		);
	};

	it("omits joinUrl when the field is untouched", async () => {
		render(withheld());
		await userEvent.click(saveButton());
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect("joinUrl" in sentData().data).toBe(false);
	});

	it("sends a link the user typed", async () => {
		render(withheld());
		await userEvent.type(field(), "https://meet.google.com/abc-defg-hij");
		await userEvent.click(saveButton());
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(sentData().data.joinUrl).toBe(
			"https://meet.google.com/abc-defg-hij",
		);
	});

	it("says a link is set only when one is, and the field stays empty", () => {
		render(withheld(true));
		expect(field().value).toBe("");
		expect(field().placeholder).toMatch(/link is set/i);
		cleanup();
		render(withheld(false));
		expect(field().placeholder).not.toMatch(/link is set/i);
	});

	it("still clears when a member (key present) blanks the field", async () => {
		const { user, input, save } = setup({
			joinUrl: "https://zoom.us/j/1234567890",
		});
		await user.clear(input);
		await user.click(save);
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(sentData().data.joinUrl).toBe("");
	});
});
