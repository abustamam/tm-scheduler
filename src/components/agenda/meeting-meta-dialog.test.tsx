// @vitest-environment jsdom
//
// The "Edit meeting" dialog's video-call join link (#731).
//
// ## Why a render test rather than a source grep
//
// The dialog is the ONLY place a club sets or clears its join link, and three
// of its four behaviours are decisions this component makes and no other module
// can see:
//
//  1. the field is always SENT, blank included — `updateMeeting` is a full
//     REPLACE, so omitting it is indistinguishable from clearing it, and a
//     dialog that only sent a non-empty value could never clear one;
//  2. a non-empty value that normalizes to null is REFUSED before the round
//     trip, because the server would store null for `"tbd"` just as happily and
//     the officer would be told the meeting saved while the link quietly went;
//  3. the blur check and the submit check are the same check, so the message a
//     user sees on blur is the one that blocks the save.
//
// `#/server/meetings` is mocked because importing it reaches `#/db` and throws
// "DATABASE_URL is not set" — the pattern `personal-meeting-editors.test.tsx`
// established for exactly this.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({
	updateMeeting: vi.fn(async () => ({ clubId: "c1" })),
}));

const { updateMeeting } = await import("#/server/meetings");
const { MeetingMetaDialog, JOIN_URL_ERROR } = await import(
	"./meeting-meta-dialog"
);

afterEach(() => {
	cleanup();
	vi.mocked(updateMeeting).mockClear();
});

type MeetingProp = Parameters<typeof MeetingMetaDialog>[0]["meeting"];

/** The columns this dialog reads. Cast because the prop is the whole `meetings`
 *  row and the other ~20 columns are irrelevant to every assertion here. */
const meeting = (over: Record<string, unknown> = {}) =>
	({
		id: "22222222-2222-4222-8222-222222222222",
		scheduledAt: new Date("2026-09-15T00:00:00Z"),
		lengthMinutes: 90,
		meetingNumber: null,
		location: "The Old Library, Room 5",
		joinUrl: null,
		theme: "New beginnings",
		wordOfTheDay: null,
		wodDefinition: null,
		wodExample: null,
		notes: null,
		reminders: null,
		...over,
	}) as unknown as MeetingProp;

/** The dialog exactly as `meeting-agenda.tsx` mounts it: ALWAYS rendered when
 *  the viewer may edit meta, with `open` toggling — not conditionally mounted. */
const dialog = (
	open: boolean,
	over: Record<string, unknown> = {},
): ReactElement => (
	<MeetingMetaDialog
		open={open}
		onOpenChange={() => {}}
		meeting={meeting(over)}
		timezone="America/Chicago"
		selfMemberId={null}
		canReschedule
		onSaved={vi.fn(async () => {})}
	/>
);

/** Re-query every time: Radix unmounts `DialogContent`'s children on close, so
 *  a node captured before a close/reopen cycle is stale. */
const field = () =>
	screen.getByLabelText("Video call link") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /save changes/i });

function setup(over: Record<string, unknown> = {}) {
	const view = render(dialog(true, over));
	return {
		user: userEvent.setup(),
		input: field(),
		save: saveButton(),
		/** Close the dialog and reopen it, the way Cancel then the toolbar do. */
		async reopen() {
			view.rerender(dialog(false, over));
			view.rerender(dialog(true, over));
		},
	};
}

/** The `data` the dialog handed `updateMeeting`. */
const sentData = () =>
	vi.mocked(updateMeeting).mock.calls[0][0] as unknown as {
		data: Record<string, unknown>;
	};

describe("the video call link input", () => {
	it("prefills from the stored link", () => {
		const { input } = setup({ joinUrl: "https://zoom.us/j/1234567890" });
		expect(input.value).toBe("https://zoom.us/j/1234567890");
	});

	it("is empty, and not the string 'null', when the club has no link", () => {
		expect(setup().input.value).toBe("");
	});

	it("is NOT type=url — the browser would reject a bare host the app accepts", () => {
		// `normalizePresentationUrl` coerces "zoom.us/j/123" to https://. Native
		// URL validation refuses it outright, with a tooltip this dialog cannot
		// word, so the one shape most likely to be pasted would be unsavable.
		expect(setup().input.getAttribute("type")).toBe("text");
	});
});

describe("what the dialog sends", () => {
	it("sends a typed link", async () => {
		const { user, input, save } = setup();
		await user.type(input, "https://meet.google.com/abc-defg-hij");
		await user.click(save);
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(sentData().data.joinUrl).toBe(
			"https://meet.google.com/abc-defg-hij",
		);
	});

	it("sends a bare host through untouched — the SERVER adds the scheme", async () => {
		// The client validator only decides whether to refuse. Normalizing here as
		// well would give two sources of truth for the stored value.
		const { user, input, save } = setup();
		await user.type(input, "zoom.us/j/1234567890");
		await user.click(save);
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(sentData().data.joinUrl).toBe("zoom.us/j/1234567890");
	});

	it("sends an empty string when the officer clears the field, which CLEARS the link", async () => {
		// Not `undefined`. `updateMeeting` is a full replace, so both land on null
		// — but a dialog that omitted the key could never distinguish "leave it"
		// from "clear it", and this is the only surface that can clear it at all.
		const { user, input, save } = setup({
			joinUrl: "https://zoom.us/j/1234567890",
		});
		await user.clear(input);
		await user.click(save);
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(sentData().data.joinUrl).toBe("");
	});

	it("always carries the key, even when the club never had a link", async () => {
		// The omission this guards is the data-loss shape `MeetingMetaEcho`
		// documents, seen from the other side.
		const { user, save } = setup();
		await user.click(save);
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect("joinUrl" in sentData().data).toBe(true);
	});
});

/**
 * The dialog is mounted whenever `viewer.canEditMeetingMeta` (`meeting-agenda.tsx`),
 * NOT gated on `open`. Radix unmounts `DialogContent`'s children on close, so
 * every sibling input re-reads the row on each open because each is uncontrolled
 * with a `defaultValue`.
 *
 * The first cut of #731 held this one field in `useState(meeting.joinUrl ?? "")`
 * in the PARENT, which Radix never unmounts. That initializes once, for the
 * lifetime of the meeting page — and since the field is sent on every save, a
 * discarded edit came back and won:
 *
 *   link set → open → clear the field → CANCEL → reopen → save a theme
 *   → the club's join link is deleted.
 *
 * Which is the data-loss `MeetingMetaEcho` exists to prevent, reintroduced on
 * the client. These are the regression.
 */
describe("the field re-reads the row on every open", () => {
	it("discards an edit that was cancelled rather than saved", async () => {
		const { user, input, reopen } = setup({
			joinUrl: "https://zoom.us/j/1234567890",
		});
		await user.clear(input);
		expect(input.value).toBe("");
		await reopen();
		expect(field().value).toBe("https://zoom.us/j/1234567890");
	});

	it("does not resend a cancelled clear on the NEXT save", async () => {
		// The half that actually loses data: the stale value is what goes on the
		// wire, so asserting only the input's value would miss it.
		const { user, input, reopen } = setup({
			joinUrl: "https://zoom.us/j/1234567890",
		});
		await user.clear(input);
		await reopen();
		await user.click(saveButton());
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(sentData().data.joinUrl).toBe("https://zoom.us/j/1234567890");
	});

	it("picks up a link added by someone else since the dialog last opened", async () => {
		// `onMetaSaved()` refetches and the `meeting` prop changes underneath a
		// mounted dialog. State initialized once would stay diverged from the row.
		const view = render(dialog(true, { joinUrl: null }));
		expect(field().value).toBe("");
		view.rerender(dialog(false, { joinUrl: null }));
		view.rerender(dialog(true, { joinUrl: "https://meet.google.com/abc" }));
		expect(field().value).toBe("https://meet.google.com/abc");
	});

	it("clears a stale validation error on reopen", async () => {
		const { user, input, reopen } = setup();
		await user.type(input, "tbd");
		await user.tab();
		expect(await screen.findByText(JOIN_URL_ERROR)).toBeTruthy();
		await reopen();
		expect(screen.queryByText(JOIN_URL_ERROR)).toBeNull();
	});
});

describe("the inline error", () => {
	it("shows on blur for a value that is not a link, and names what to paste", async () => {
		const { user, input } = setup();
		await user.type(input, "tbd");
		await user.tab();
		expect(await screen.findByText(JOIN_URL_ERROR)).toBeTruthy();
		expect(input.getAttribute("aria-invalid")).toBe("true");
	});

	it("shows for a non-http scheme", async () => {
		const { user, input } = setup();
		await user.type(input, "javascript:alert(1)");
		await user.tab();
		expect(await screen.findByText(JOIN_URL_ERROR)).toBeTruthy();
	});

	it("does NOT show for a blank field — clearing the link is a legitimate edit", async () => {
		const { user, input } = setup({ joinUrl: "https://zoom.us/j/1234567890" });
		await user.clear(input);
		await user.tab();
		expect(screen.queryByText(JOIN_URL_ERROR)).toBeNull();
	});

	it("blocks the save, so a typo never reads as stored", async () => {
		// The half that matters. Without it the server normalizes "n/a" to null,
		// the toast says "Meeting updated", and the club's join link is gone.
		const { user, input, save } = setup({
			joinUrl: "https://zoom.us/j/1234567890",
		});
		await user.clear(input);
		await user.type(input, "n/a");
		await user.click(save);
		expect(await screen.findByText(JOIN_URL_ERROR)).toBeTruthy();
		expect(updateMeeting).not.toHaveBeenCalled();
	});

	it("clears as soon as the officer starts fixing it", async () => {
		const { user, input } = setup();
		await user.type(input, "tbd");
		await user.tab();
		expect(await screen.findByText(JOIN_URL_ERROR)).toBeTruthy();
		await user.type(input, "x");
		await waitFor(() => expect(screen.queryByText(JOIN_URL_ERROR)).toBeNull());
	});
});
