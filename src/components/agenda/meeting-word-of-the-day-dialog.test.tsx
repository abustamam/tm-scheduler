// @vitest-environment jsdom
//
// The meeting page's Word-of-the-Day dialog, and the one behaviour #793 could
// have taken from it (#296 built it, #302 lifted it here).
//
// ## Why this file exists at all, given the dialog is unchanged in shape
//
// `applyWordOfTheDayUpdate` became a PATCH in #793 so the Grammarian's focused
// editor could stop writing back a page-load snapshot. A patch writer leaves an
// omitted field alone — which silently removes a form's only way to CLEAR a
// field unless the form changes in the same breath. That is not a hypothetical:
// it is the trap #772 hit one file over, on the meeting-meta dialog, and it had
// to be undone in the same change there too.
//
// This dialog submits all three columns every time, so the only arm that moved
// is the blank one: `String(form.get(…)).trim() || undefined` had to become the
// bare trim. Nothing else in the repo can see that. The focused editor's clear
// path is render-tested in `club/personal-meeting-editors.test.tsx`, the
// writer's is in `server/personal-duty-edit.integration.test.ts`, and this is
// the third surface — the one a club actually uses from the agenda.
//
// `#/server/meetings` is mocked because importing it reaches `#/db` and throws
// "DATABASE_URL is not set"; `meeting-meta-dialog.test.tsx` next door is the
// precedent for the whole harness.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({
	updateWordOfTheDay: vi.fn(async () => ({ clubId: "c1" })),
}));

const { updateWordOfTheDay } = await import("#/server/meetings");
const { MeetingWordOfTheDayDialog } = await import(
	"./meeting-word-of-the-day-dialog"
);

afterEach(() => {
	cleanup();
	vi.mocked(updateWordOfTheDay).mockClear();
});

const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

/** All three stored, with distinct values so a payload that crosses two fields
 *  fails rather than passing on a shared one. */
const STORED = {
	id: MEETING_ID,
	wordOfTheDay: "ineffable",
	wodDefinition: "too great to be expressed in words",
	wodExample: "an ineffable joy",
};

function renderDialog(over: Partial<typeof STORED> = {}) {
	const onSaved = vi.fn(async () => {});
	render(
		<MeetingWordOfTheDayDialog
			open
			onOpenChange={() => {}}
			meeting={{ ...STORED, ...over }}
			selfMemberId={MEMBER}
			onSaved={onSaved}
		/>,
	);
	return { onSaved };
}

/** One of the three inputs. `{ selector: "input" }` is load-bearing on the word:
 *  the dialog's TITLE is also "Word of the day", and Radix points the content's
 *  `aria-labelledby` at it, so a bare `getByLabelText` matches two elements. */
const field = (label: string) =>
	screen.getByLabelText(label, { selector: "input" }) as HTMLInputElement;

/** The payload the assertions read. Throws rather than optional-chaining to
 *  `undefined`: an assertion against a writer that was never called is the
 *  vacuous pass this file exists to avoid. */
function payload() {
	const call = vi.mocked(updateWordOfTheDay).mock.calls[0];
	if (!call) throw new Error("updateWordOfTheDay was never called");
	return (call[0] as { data: Record<string, unknown> }).data;
}

async function save() {
	await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
	await waitFor(() => expect(updateWordOfTheDay).toHaveBeenCalledTimes(1));
	return payload();
}

describe("MeetingWordOfTheDayDialog", () => {
	it("prefills the three stored fields", () => {
		renderDialog();
		expect(field("Word of the day").value).toBe(STORED.wordOfTheDay);
		expect(field("Definition").value).toBe(STORED.wodDefinition);
		expect(field("Example sentence").value).toBe(STORED.wodExample);
	});

	it("sends a blanked input as an explicit clear, not as silence (#793)", async () => {
		// The assertion the writer's change would otherwise have broken: a
		// Grammarian who clears the example means to clear it, and `undefined` now
		// means "leave it alone" — so this dialog would have reported success and
		// changed nothing, on the only surface a club has for removing one.
		renderDialog();
		await userEvent.clear(field("Example sentence"));
		const data = await save();
		expect("wodExample" in data).toBe(true);
		expect(data.wodExample).toBe("");
		// The two it did not touch still ride along, because this form renders and
		// submits all three: what it sends is what the Grammarian sees.
		expect(data.wordOfTheDay).toBe(STORED.wordOfTheDay);
		expect(data.wodDefinition).toBe(STORED.wodDefinition);
	});

	it("clears every column when all three are blanked", async () => {
		renderDialog();
		await userEvent.clear(field("Word of the day"));
		await userEvent.clear(field("Definition"));
		await userEvent.clear(field("Example sentence"));
		const data = await save();
		expect(data.wordOfTheDay).toBe("");
		expect(data.wodDefinition).toBe("");
		expect(data.wodExample).toBe("");
	});

	it("trims what it sends, and carries the identity fields", async () => {
		renderDialog({ wordOfTheDay: "" });
		await userEvent.type(field("Word of the day"), "  loquacious  ");
		const data = await save();
		expect(data.wordOfTheDay).toBe("loquacious");
		expect(data.meetingId).toBe(MEETING_ID);
		expect(data.selfMemberId).toBe(MEMBER);
	});

	it("does NOT hand back to the page when the write fails", async () => {
		vi.mocked(updateWordOfTheDay).mockRejectedValueOnce(new Error("nope"));
		const { onSaved } = renderDialog();
		await userEvent.click(
			screen.getByRole("button", { name: /save changes/i }),
		);
		await waitFor(() => expect(updateWordOfTheDay).toHaveBeenCalled());
		expect(onSaved).not.toHaveBeenCalled();
	});
});
