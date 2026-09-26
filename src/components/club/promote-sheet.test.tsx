// @vitest-environment jsdom
//
// The Promote sheet's drafts (#931): what Copy, Share and "Open in mail app"
// actually hand to the browser, and that a one-time edit is what gets copied.
// Nothing here sends anything — the assertions are on the clipboard, the share
// sheet and the mailto: navigation, which is the whole of what the app does.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/promo", () => ({ getPromoContext: vi.fn() }));

import {
	DEFAULT_PROMO_TEMPLATE,
	type FlyerMeeting,
	type PromoTemplate,
} from "#/lib/promo-template";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { PromoDrafts, plainTextToHtml } from "./promote-sheet";

const CLUB = {
	name: "Downtown Speakers",
	slug: "downtown",
	timezone: "America/Chicago",
};
const MEETING: FlyerMeeting = {
	id: "m1",
	urlKey: "2026-10-01",
	scheduledAt: "2026-10-02T00:30:00Z",
	location: "Library",
	online: true,
	theme: "Beginnings",
	wordOfTheDay: null,
	meetingNumber: 57,
	promoNote: null,
};
const ORIGIN = "https://gavelup.app";
const LINK = `${ORIGIN}/club/downtown/meeting/2026-10-01`;

let writeText: ReturnType<typeof vi.fn>;

/** After `userEvent.setup()`, which installs its own clipboard stub. */
function stubClipboard() {
	writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
}

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(navigator, "share");
});

async function renderDrafts(template: PromoTemplate = DEFAULT_PROMO_TEMPLATE) {
	await renderUnderMemoryRouter(
		<PromoDrafts
			club={CLUB}
			template={template}
			meeting={MEETING}
			origin={ORIGIN}
			logoUrl={null}
		/>,
	);
	const user = userEvent.setup();
	stubClipboard();
	return user;
}

describe("the WhatsApp draft", () => {
	it("Copy puts the drafted message on the clipboard", async () => {
		const user = await renderDrafts();
		await user.click(screen.getByRole("button", { name: /^copy$/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0]?.[0] as string;
		expect(copied.startsWith("*You're invited: Downtown Speakers")).toBe(true);
		expect(copied.endsWith(LINK)).toBe(true);
	});

	it("a one-time edit is what gets copied", async () => {
		const user = await renderDrafts();
		const box = screen.getByLabelText("WhatsApp message");
		await user.clear(box);
		await user.type(box, "Custom hello");
		await user.click(screen.getByRole("button", { name: /^copy$/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("Custom hello"));
	});

	it("Share appears only where the browser supports it, and shares the text", async () => {
		await renderDrafts();
		expect(screen.queryByRole("button", { name: /share/i })).toBeNull();
		cleanup();
		const share = vi.fn(async () => {});
		Object.defineProperty(navigator, "share", {
			value: share,
			configurable: true,
		});
		const user = await renderDrafts();
		await user.click(screen.getByRole("button", { name: /share/i }));
		await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
		expect(
			(share.mock.calls[0] as unknown as [{ text: string }])[0].text,
		).toContain(LINK);
	});
});

describe("a share that fails", () => {
	const withShare = (impl: () => Promise<void>) =>
		Object.defineProperty(navigator, "share", {
			value: vi.fn(impl),
			configurable: true,
		});

	it("a dismissed share sheet (AbortError) is silent — nothing copied", async () => {
		withShare(async () => {
			throw new DOMException("dismissed", "AbortError");
		});
		const user = await renderDrafts();
		await user.click(screen.getByRole("button", { name: /share/i }));
		await waitFor(() => expect(navigator.share).toHaveBeenCalled());
		expect(writeText).not.toHaveBeenCalled();
	});

	it("any other failure falls back to copying the message", async () => {
		withShare(async () => {
			throw new DOMException("no target", "NotAllowedError");
		});
		const user = await renderDrafts();
		await user.click(screen.getByRole("button", { name: /share/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0]?.[0]).toContain(LINK);
	});
});

describe("the email draft", () => {
	it("Copy subject copies the subject line", async () => {
		const user = await renderDrafts();
		await user.click(screen.getByRole("tab", { name: "Email" }));
		await user.click(screen.getByRole("button", { name: /copy subject/i }));
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(
				"You're invited: Downtown Speakers, Thursday, October 1",
			),
		);
	});

	it("Open in mail app navigates to a mailto: draft with subject and body", async () => {
		const assign = vi.fn();
		const original = window.location;
		Object.defineProperty(window, "location", {
			value: {
				...original,
				set href(v: string) {
					assign(v);
				},
			},
			configurable: true,
		});
		try {
			const user = await renderDrafts();
			await user.click(screen.getByRole("tab", { name: "Email" }));
			await user.click(
				screen.getByRole("button", { name: /open in mail app/i }),
			);
			expect(assign).toHaveBeenCalledTimes(1);
			const href = assign.mock.calls[0]?.[0] as string;
			expect(href.startsWith("mailto:?subject=")).toBe(true);
			expect(decodeURIComponent(href)).toContain(LINK);
		} finally {
			Object.defineProperty(window, "location", {
				value: original,
				configurable: true,
			});
		}
	});

	it("a body too long for a mail link is copied instead — subject AND body", async () => {
		const user = await renderDrafts();
		await user.click(screen.getByRole("tab", { name: "Email" }));
		const body = screen.getByLabelText("Body");
		await user.clear(body);
		await user.click(body);
		await user.paste("x".repeat(3000));
		await user.click(screen.getByRole("button", { name: /open in mail app/i }));
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(
				`You're invited: Downtown Speakers, Thursday, October 1\n\n${"x".repeat(3000)}`,
			),
		);
	});
});

describe("template warnings", () => {
	it("an unknown placeholder is flagged, not blanked", async () => {
		await renderDrafts({
			...DEFAULT_PROMO_TEMPLATE,
			callToAction: "RSVP to {hots}",
		});
		expect(screen.getByText(/isn't a placeholder/).textContent).toContain(
			"{hots}",
		);
		expect(
			(screen.getByLabelText("WhatsApp message") as HTMLTextAreaElement).value,
		).toContain("RSVP to {hots}");
	});
});

describe("plainTextToHtml", () => {
	it("keeps paragraphs and line breaks, and escapes markup", () => {
		expect(plainTextToHtml(`a <b title="x">'\nc\n\nd`)).toBe(
			"<p>a &lt;b title=&quot;x&quot;&gt;&#39;<br>c</p>\n<p>d</p>",
		);
	});
});
