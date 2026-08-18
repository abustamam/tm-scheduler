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

	it("fires onContacted when the Email draft link is clicked", async () => {
		const onContacted = vi.fn();
		const user = userEvent.setup();
		render(
			<NudgeButtons
				{...base}
				phone={null}
				email="j@x.io"
				onContacted={onContacted}
			/>,
		);
		const mail = await screen.findByRole("link", { name: /email/i });
		await user.click(mail);
		expect(onContacted).toHaveBeenCalledTimes(1);
	});

	it("renders an attendance draft with no role name", () => {
		const { getByRole } = render(
			<NudgeButtons
				name="Sam Rivera"
				phone="+15551234567"
				email={null}
				meetingDate="Tue 19 Aug"
				shareUrl="https://club.example/m"
				mode="attendance"
			/>,
		);
		const link = getByRole("link", { name: /whatsapp/i });
		const href = decodeURIComponent(link.getAttribute("href") ?? "");
		expect(href).toContain("are you able to make our Tue 19 Aug meeting");
		expect(href).not.toContain("undefined");
	});

	it("keeps its labels by default, so the agenda and recruit picker are untouched", () => {
		render(<NudgeButtons {...base} phone="14155552671" email="j@x.io" />);
		const wa = screen.getByRole("link", { name: "WhatsApp" });
		const mail = screen.getByRole("link", { name: "Email" });
		expect(wa).toBeTruthy();
		expect(mail).toBeTruthy();
		// accname SKIPS a whitespace-only `aria-label` and falls through to
		// content, so the role query above passes whether the attribute is
		// absent or merely empty. Pin absent explicitly — matches the idiom at
		// `whatsapp-phone-link.test.tsx:211` — so a future `aria-label=""` leak
		// on the labelled path cannot hide behind this test.
		expect(wa.getAttribute("aria-label")).toBeNull();
		expect(mail.getAttribute("aria-label")).toBeNull();
		// Same reasoning applies to `title`: content already wins the accessible
		// name here, so an unconditional `title` would leak a tooltip neither the
		// agenda slot cards nor the recruit picker ever asked for, and nothing
		// above would notice — accname only falls back to `title` when content
		// AND `aria-label` are both absent.
		expect(wa.getAttribute("title")).toBeNull();
		expect(mail.getAttribute("title")).toBeNull();
	});

	it("iconOnly drops the text but NOT the accessible name", () => {
		// The visible text WAS the accessible name. Removing it without putting one
		// back leaves a screen reader announcing "link", and leaves the buttons
		// unqueryable by anything but position. Note the existing tests in this
		// file query `/whatsapp/i`, which matches BOTH the label and the new
		// aria-label — so those cannot catch a missing accessible name, and these
		// assert the exact strings instead.
		const waLabel = "Message Jane on WhatsApp, opens in a new tab";
		const mailLabel = "Email Jane";
		render(
			<NudgeButtons
				{...base}
				iconOnly
				// `name`, not `preferredName`: giving the fixture a DIFFERENT
				// `preferredName` ("Janey") means a mutation that swaps the label
				// const from `name` to `preferredName` produces "Message Janey on
				// WhatsApp…" — a real mismatch against `waLabel` above — rather than
				// "Message undefined on WhatsApp…", which would fail this test for
				// the wrong reason (`base` carries no `preferredName` at all) and
				// prove nothing about which field the label is actually pinned to.
				preferredName="Janey"
				phone="14155552671"
				email="j@x.io"
			/>,
		);
		expect(screen.queryByText("WhatsApp")).toBeNull();
		expect(screen.queryByText("Email")).toBeNull();
		expect(screen.getByRole("link", { name: waLabel })).toBeTruthy();
		expect(screen.getByRole("link", { name: mailLabel })).toBeTruthy();

		// ATTRIBUTE-level, deliberately. The role query above passes on `title`
		// alone — accname falls back to it when the content is empty and the icon
		// is `aria-hidden` — so on its own it cannot tell the two apart. `title`
		// is not announced by touch screen readers, and this rail runs on a
		// tablet, so the `aria-label` is the one that has to be there.
		const wa = screen.getByRole("link", { name: waLabel });
		expect(wa.getAttribute("aria-label")).toBe(waLabel);
		const mail = screen.getByRole("link", { name: mailLabel });
		expect(mail.getAttribute("aria-label")).toBe(mailLabel);

		// `title` is a SEPARATE attribute from `aria-label` — accname reads
		// content-then-aria-label-then-title, so nothing above proves `title` is
		// still set once `aria-label` is present. Pin it independently: the
		// comment two lines up spends five lines contrasting the two, which
		// would otherwise mislead the next reader into thinking `title` is
		// covered by the role query.
		expect(wa.getAttribute("title")).toBe(waLabel);
		expect(mail.getAttribute("title")).toBe(mailLabel);

		// `icon-sm` is the flag's REASON TO EXIST — dropping the text saves ~40px,
		// dropping `sm`'s padding for `icon-sm` saves the rest. Deleting the size
		// change left every other assertion green, so this is the only thing
		// standing between the feature and a silent revert.
		//
		// `data-size`, not the Tailwind class: this pins the DECISION (we asked
		// for icon-sm) rather than Tailwind's current rendering of it, so a
		// shadcn/Tailwind bump that redefines the `icon-sm` token does not fail a
		// test that is still correct — `button.tsx` emits `data-size={size}` onto
		// `Comp`, which under `asChild` is `Slot.Root`, so it rides onto this `<a>`
		// the same way `className` does. A `className.toContain("size-8")` check
		// would also pass on a hypothetical `size-80`; `data-size` cannot.
		expect(wa.getAttribute("data-size")).toBe("icon-sm");
		expect(mail.getAttribute("data-size")).toBe("icon-sm");
	});

	it("still says so when there is no contact, iconOnly or not", () => {
		// The widest thing this component renders, and the one branch the flag
		// deliberately leaves alone. Nothing else observes that decision. Renders
		// BOTH cases — the name promises "iconOnly or not", so it renders both,
		// rather than leaving the "or not" half to the older, differently-named
		// no-contact test ~90 lines up.
		const iconOnlyRender = render(
			<NudgeButtons {...base} iconOnly phone={null} email={null} />,
		);
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
		iconOnlyRender.unmount();

		render(<NudgeButtons {...base} phone={null} email={null} />);
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});
});
