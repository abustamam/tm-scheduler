// @vitest-environment jsdom
//
// "Email the minutes" (#903). GavelUp used to send the minutes itself; every
// message to a person is now sent by a human, so this dialog composes a DRAFT
// the officer opens in their own mail app, and hands them the guest copy of the
// PDF to attach. What that has to hold, and this file pins:
//
//   - the download is the GUEST copy (`?view=guests`), the one without the
//     club's internal action items, because guests are on the list;
//   - the draft puts every recipient in bcc, and follows the officer's edits;
//   - "Copy addresses" is there for mail apps that drop a long `mailto:`, and
//     past 1,900 characters the dialog says so;
//   - nothing is sent: no request of any kind leaves the dialog.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINUTES_MAILTO_WARN_LENGTH } from "#/lib/minutes-mailto";
import { readSource } from "#/test/guard-source";
import { parseMailto } from "#/test/mailto-parse";
import { SendMinutesDialog } from "./send-minutes-dialog";

const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const LONG_NOTICE = /your list is long/i;

const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));

beforeEach(() => {
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	cleanup();
	fetchSpy.mockClear();
	vi.unstubAllGlobals();
});

function renderOpen(
	recipients: { name: string; email: string }[] = [
		{ name: "Ada", email: "ada@club.org" },
		{ name: "Gwen", email: "gwen@guest.example" },
	],
) {
	render(
		<SendMinutesDialog
			meetingId={MEETING_ID}
			clubName="Acme TM"
			meetingDate={new Date("2026-07-10T18:00:00Z")}
			timezone="UTC"
			initialRecipients={recipients}
			skipped={[{ name: "Nomail Ned" }]}
		/>,
	);
	return userEvent.click(
		screen.getByRole("button", { name: /email the minutes/i }),
	);
}

const draftLink = () =>
	screen.getByRole("link", { name: /open email draft/i }) as HTMLAnchorElement;

/** The draft's raw header section, split the way a mail client reads it. */
function draftHeaders(): Map<string, string> {
	const { to, headers } = parseMailto(draftLink().getAttribute("href") ?? "");
	expect(to).toBe("");
	return new Map(headers);
}

describe("SendMinutesDialog (#903)", () => {
	it("offers the GUEST copy of the PDF as a download", async () => {
		await renderOpen();
		const link = screen.getByRole("link", {
			name: /download the guest copy \(pdf\)/i,
		});
		expect(link.getAttribute("href")).toBe(
			`/api/meetings/${MEETING_ID}/minutes/pdf?view=guests`,
		);
		expect(link.hasAttribute("download")).toBe(true);
		expect(
			screen.getByText(/leaves out the club's internal action items/i),
		).toBeTruthy();
	});

	it("opens a draft with every recipient in bcc and the default subject", async () => {
		await renderOpen();
		const headers = draftHeaders();
		expect([...headers.keys()]).toEqual(["bcc", "subject", "body"]);
		expect(headers.get("bcc")).toBe("ada@club.org,gwen@guest.example");
		expect(decodeURIComponent(headers.get("subject") ?? "")).toContain(
			"Acme TM — Minutes for",
		);
		// Skipped people are listed, not silently dropped.
		expect(screen.getByText("Nomail Ned")).toBeTruthy();
	});

	it("the draft follows the officer's edits to the list and subject", async () => {
		await renderOpen();
		await userEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
		await userEvent.type(
			screen.getByPlaceholderText(/add another address/i),
			"extra@club.org{Enter}",
		);
		const subject = screen.getByLabelText("Subject");
		await userEvent.clear(subject);
		await userEvent.type(subject, "Our minutes");

		const headers = draftHeaders();
		expect(headers.get("bcc")).toBe("gwen@guest.example,extra@club.org");
		expect(decodeURIComponent(headers.get("subject") ?? "")).toBe(
			"Our minutes",
		);
	});

	it("falls back to the default subject when the officer empties it", async () => {
		await renderOpen();
		await userEvent.clear(screen.getByLabelText("Subject"));
		expect(decodeURIComponent(draftHeaders().get("subject") ?? "")).toContain(
			"Acme TM — Minutes for",
		);
	});

	it.each([
		["comma", "a@x.org,b@evil.example"],
		["semicolon", "a@x.org;b@evil.example"],
	])("a stored address with a %s is left out of the draft AND the copy, and the officer is told", async (_label, stored) => {
		const user = userEvent.setup();
		render(
			<SendMinutesDialog
				meetingId={MEETING_ID}
				clubName="Acme TM"
				meetingDate="2026-07-10T18:00:00Z"
				timezone="UTC"
				initialRecipients={[
					{ name: "Ada", email: "ada@club.org" },
					{ name: "Pat Pair", email: stored },
				]}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: /email the minutes/i }),
		);

		expect(draftHeaders().get("bcc")).toBe("ada@club.org");
		expect(draftLink().getAttribute("href")).not.toContain("evil");

		// Told, by name and by the stored value.
		expect(
			screen.getByText(/not included: invalid address \(1\)/i),
		).toBeTruthy();
		expect(screen.getByText(JSON.stringify(stored))).toBeTruthy();
		expect(screen.getByText(/recipients, in bcc \(1\)/i)).toBeTruthy();

		await user.click(screen.getByRole("button", { name: /copy addresses/i }));
		await waitFor(async () =>
			expect(await navigator.clipboard.readText()).toBe("ada@club.org"),
		);
	});

	it("refuses to add a typed address that is not one mailbox", async () => {
		await renderOpen();
		await userEvent.type(
			screen.getByPlaceholderText(/add another address/i),
			"x@club.org;y@evil.example{Enter}",
		);
		// Refused at the door: not on the list at all, so not even listed as
		// "not included".
		expect(screen.queryByText(/not included/i)).toBeNull();
		expect(screen.queryByText("x@club.org;y@evil.example")).toBeNull();
		expect(screen.getByText(/recipients, in bcc \(2\)/i)).toBeTruthy();
		expect(draftHeaders().get("bcc")).toBe("ada@club.org,gwen@guest.example");
	});

	it("Copy addresses puts the comma-separated list on the clipboard", async () => {
		// `setup()` installs a clipboard stub on navigator, so read it back
		// through the same session rather than spying on an object it replaces.
		const user = userEvent.setup();
		render(
			<SendMinutesDialog
				meetingId={MEETING_ID}
				clubName="Acme TM"
				meetingDate="2026-07-10T18:00:00Z"
				timezone="UTC"
				initialRecipients={[
					{ name: "Ada", email: "ada@club.org" },
					{ name: "Gwen", email: "gwen@guest.example" },
				]}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: /email the minutes/i }),
		);
		await user.click(screen.getByRole("button", { name: /copy addresses/i }));
		await waitFor(async () =>
			expect(await navigator.clipboard.readText()).toBe(
				"ada@club.org, gwen@guest.example",
			),
		);
	});

	it("says the list is long only once the draft link passes 1,900 characters", async () => {
		await renderOpen();
		expect(screen.queryByText(LONG_NOTICE)).toBeNull();
		cleanup();

		const many = Array.from({ length: 60 }, (_, i) => ({
			name: `Member ${i}`,
			email: `member.number.${i}@example-club.org`,
		}));
		await renderOpen(many);
		expect(draftLink().getAttribute("href")?.length).toBeGreaterThan(
			MINUTES_MAILTO_WARN_LENGTH,
		);
		expect(screen.getByText(LONG_NOTICE)).toBeTruthy();
		// The notice sits ABOVE the button it is about.
		const notice = screen.getByText(LONG_NOTICE);
		expect(
			notice.compareDocumentPosition(draftLink()) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("with nobody on the list, there is no draft to open", async () => {
		await renderOpen([]);
		expect(
			screen.queryByRole("link", { name: /open email draft/i }),
		).toBeNull();
		const button = screen.getByRole("button", { name: /open email draft/i });
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});

	it("sends nothing: no request leaves the dialog", async () => {
		await renderOpen();
		await userEvent.click(
			screen.getByRole("button", { name: /copy addresses/i }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("imports no server-fn module, so it has no POST to call", () => {
		// The behavioural test above sees only what this render clicked; the
		// import is what would bring a send back. `minutes-email-logic` (pure
		// subject/body builders) is fine — the server-fn module is not.
		const source = readSource("src/components/minutes/send-minutes-dialog.tsx");
		const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(imports).toContain("#/lib/minutes-mailto");
		expect(imports).not.toContain("#/server/minutes-email");
		expect(source).not.toMatch(/useMutation|createServerFn/);
	});
});
