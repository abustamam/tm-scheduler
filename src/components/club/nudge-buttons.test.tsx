// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NudgeButtons } from "./nudge-buttons";

const base = {
	name: "Jane",
	roleName: "Timer",
	meetingDate: "Thu, Jul 23",
	shareUrl: "https://gavelup.app/club/mcf/meeting/abc",
	mode: "confirm" as const,
};

/** jsdom's own UA is desktop-shaped, so tests that want the mobile branch have
 *  to say so. Restored by `vi.restoreAllMocks` in afterEach. */
function pretendUserAgent(ua: string) {
	vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

describe("NudgeButtons", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("links a desktop viewer to WhatsApp Web, not the wa.me interstitial", () => {
		// jsdom reports a desktop UA, which is the case being asserted (#485).
		render(<NudgeButtons {...base} phone="14155552671" email={null} />);
		const wa = screen.getByRole("link", { name: /whatsapp/i });
		const href = wa.getAttribute("href") ?? "";
		expect(href).toContain("https://web.whatsapp.com/send/?phone=14155552671");
		expect(href).not.toContain("wa.me");
		expect(wa.getAttribute("target")).toBe("_blank");
	});

	it("links a mobile viewer to wa.me so the app takes over", () => {
		pretendUserAgent(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
		);
		render(<NudgeButtons {...base} phone="14155552671" email={null} />);
		const wa = screen.getByRole("link", { name: /whatsapp/i });
		expect(wa.getAttribute("href")).toContain("https://wa.me/14155552671");
	});

	it("shows an Email link when the target has an email", () => {
		render(<NudgeButtons {...base} phone={null} email="j@x.io" />);
		const mail = screen.getByRole("link", { name: /email/i });
		expect(mail.getAttribute("href")).toContain("mailto:j@x.io");
	});

	/** Guards the prop→draft wiring (#486). Without these, dropping
	 *  `preferredName` from the `buildNudge` call leaves every other test green. */
	function draftText(link: Element): string {
		const href = link.getAttribute("href") ?? "";
		const params = new URL(href.replace(/^mailto:/, "https://x/")).searchParams;
		return decodeURIComponent(params.get("text") ?? params.get("body") ?? "");
	}

	it("greets by first name when no goes-by name is recorded", () => {
		render(
			<NudgeButtons
				{...base}
				name="Zabihullah Kogyani"
				phone="14155552671"
				email={null}
			/>,
		);
		const draft = draftText(screen.getByRole("link", { name: /whatsapp/i }));
		expect(draft).toContain("Hi Zabihullah,");
		expect(draft).not.toContain("Kogyani");
	});

	it("greets by the recorded goes-by name on both channels", () => {
		render(
			<NudgeButtons
				{...base}
				name="Abdul-Rasheed Bustamam"
				preferredName="Rasheed"
				phone="14155552671"
				email="r@x.io"
			/>,
		);
		expect(
			draftText(screen.getByRole("link", { name: /whatsapp/i })),
		).toContain("Hi Rasheed,");
		expect(draftText(screen.getByRole("link", { name: /email/i }))).toContain(
			"Hi Rasheed,",
		);
	});

	it("shows only the present channel, not a disabled placeholder", () => {
		render(<NudgeButtons {...base} phone={null} email="j@x.io" />);
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
	});

	it("renders a muted no-contact state when neither is present", () => {
		render(<NudgeButtons {...base} phone={null} email={null} />);
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("fires onContacted when the WhatsApp draft link is clicked", async () => {
		const onContacted = vi.fn();
		const user = userEvent.setup();
		render(
			<NudgeButtons
				{...base}
				phone="14155552671"
				email={null}
				onContacted={onContacted}
			/>,
		);
		const wa = await screen.findByRole("link", { name: /whatsapp/i });
		await user.click(wa);
		expect(onContacted).toHaveBeenCalledTimes(1);
	});
});
