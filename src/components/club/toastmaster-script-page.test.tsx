// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptLine } from "#/lib/toastmaster-script";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import {
	MEMBERS_ONLY_INTRO_NOTE,
	ToastmasterScriptPage,
} from "./toastmaster-script-page";

afterEach(cleanup);

const LINES: ScriptLine[] = [
	{
		kind: "mine",
		time: "6:30",
		minutes: 3,
		detail: "Opens meeting",
		backCue: null,
	},
	{
		kind: "speech",
		time: "6:40",
		minutes: 7,
		speaker: "Ann",
		title: null,
		evaluator: "Eval0",
		evaluatorAsk: "Evaluating this speech is Eval0.",
		say: "Introduce Ann.",
		introduction: "members-only",
		prepNote:
			"Their title isn't on the agenda yet. Ask them before the meeting.",
	},
	{
		kind: "others",
		time: "6:50",
		minutes: 20,
		summary: "Table Topics Master: Tom runs it (~20 min)",
	},
	{
		kind: "mine",
		time: "7:10",
		minutes: 1,
		detail: "Closes the meeting",
		backCue: "You're back when Gil hands back.",
	},
];

async function renderPage(over: {
	membersOnlyNote: boolean;
	signInRedirect: string | null;
}) {
	await renderUnderMemoryRouter(
		<ToastmasterScriptPage
			lines={LINES}
			when="Mon, Sep 8"
			clubName="Harbor City"
			theme="Hope"
			backHref="/club/harbor-city/meeting/2026-09-08/me"
			{...over}
		/>,
	);
}

describe("ToastmasterScriptPage (#1480)", () => {
	// protects=AC4: a signed-out viewer sees the fixed note with a Sign in link.
	// fails_when=the note or the link is missing for a signed-out viewer.
	// no_claim=that the link resolves (the route table is not mounted here).
	it("signed out: the members-only note with a Sign in link", async () => {
		await renderPage({
			membersOnlyNote: true,
			signInRedirect: "/club/harbor-city/meeting/2026-09-08/me/script",
		});
		expect(
			screen.getByText(MEMBERS_ONLY_INTRO_NOTE, { exact: false }),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
	});

	// protects=a signed-in non-member gets the note and no link; a member gets
	//   neither.
	// fails_when=the link shows for a signed-in non-member, or the note for a member.
	it("signed-in non-member: the note, no link; member: neither", async () => {
		await renderPage({ membersOnlyNote: true, signInRedirect: null });
		expect(
			screen.getByText(MEMBERS_ONLY_INTRO_NOTE, { exact: false }),
		).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
		cleanup();
		await renderPage({ membersOnlyNote: false, signInRedirect: null });
		expect(
			screen.queryByText(MEMBERS_ONLY_INTRO_NOTE, { exact: false }),
		).toBeNull();
	});

	// protects=the line kinds are all drawn, the prep note outside the quote, and
	//   the back cue above the Toastmaster's next line.
	// fails_when=a kind is not rendered, or the prep note is inside the blockquote.
	it("renders mine, speech, others and the back cue, with the prep note outside the quote", async () => {
		await renderPage({ membersOnlyNote: false, signInRedirect: null });
		expect(screen.getByText("Opens meeting")).toBeTruthy();
		expect(
			screen.getByText("Table Topics Master: Tom runs it (~20 min)", {
				exact: false,
			}),
		).toBeTruthy();
		expect(screen.getByText("You're back when Gil hands back.")).toBeTruthy();
		const quote = screen.getByText("Introduce Ann.");
		expect(quote.tagName).toBe("BLOCKQUOTE");
		const note = screen.getByText(/Their title isn't on the agenda yet/);
		expect(note.closest("blockquote")).toBeNull();
		expect(screen.getByText("Evaluating this speech is Eval0.").tagName).toBe(
			"BLOCKQUOTE",
		);
	});
});
