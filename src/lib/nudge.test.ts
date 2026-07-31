import { describe, expect, it } from "vitest";
import { buildNudge } from "./nudge";

const base = {
	name: "Jane",
	roleName: "Timer",
	meetingDate: "Thu, Jul 23",
	shareUrl: "https://gavelup.app/club/mcf/meeting/abc",
};

describe("buildNudge", () => {
	it("confirm mode names the role and includes the link", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		expect(r.message).toBe(
			"Hi Jane, just confirming you're our Timer for the Thu, Jul 23 meeting. Details: https://gavelup.app/club/mcf/meeting/abc",
		);
	});

	it("recruit mode uses the ask phrasing", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "recruit" });
		expect(r.message).toBe(
			"Hi Jane, would you be open to taking Timer at our Thu, Jul 23 meeting? Info here: https://gavelup.app/club/mcf/meeting/abc",
		);
	});

	it("builds a wa.me link from a phone, stripping +, spaces, dashes", () => {
		const r = buildNudge({
			...base,
			phone: "+1 (415) 555-2671",
			mode: "confirm",
			platform: "mobile",
		});
		expect(r.whatsappUrl).toBe(
			`https://wa.me/14155552671?text=${encodeURIComponent(r.message)}`,
		);
	});

	it("defaults to the mobile wa.me link when no platform is given", () => {
		const r = buildNudge({ ...base, phone: "14155552671", mode: "confirm" });
		expect(r.whatsappUrl).toBe(
			`https://wa.me/14155552671?text=${encodeURIComponent(r.message)}`,
		);
	});

	it("sends desktop straight to WhatsApp Web, not the wa.me interstitial", () => {
		// `wa.me` on a desktop dead-ends on "open in app" (#485).
		const r = buildNudge({
			...base,
			phone: "+1 (415) 555-2671",
			mode: "confirm",
			platform: "desktop",
		});
		expect(r.whatsappUrl).toBe(
			`https://web.whatsapp.com/send/?phone=14155552671&text=${encodeURIComponent(
				r.message,
			)}&type=phone_number&app_absent=0`,
		);
		expect(r.whatsappUrl).not.toContain("wa.me");
	});

	it("carries the same digits and message on both platforms", () => {
		const args = {
			...base,
			phone: "+1 (415) 555-2671",
			mode: "confirm" as const,
		};
		const mobile = buildNudge({ ...args, platform: "mobile" });
		const desktop = buildNudge({ ...args, platform: "desktop" });
		expect(desktop.message).toBe(mobile.message);
		const text = (u: string) =>
			decodeURIComponent(new URL(u).searchParams.get("text") ?? "");
		expect(text(desktop.whatsappUrl ?? "")).toBe(
			text(mobile.whatsappUrl ?? ""),
		);
		expect(new URL(desktop.whatsappUrl ?? "").searchParams.get("phone")).toBe(
			"14155552671",
		);
	});

	it("omits whatsappUrl when there is no phone", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		expect(r.whatsappUrl).toBeUndefined();
	});

	it("builds a mailto with subject + body, omits it when no email", () => {
		const withEmail = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		expect(withEmail.mailtoUrl).toBe(
			`mailto:j@x.io?subject=${encodeURIComponent(
				"Confirming your Timer role — Thu, Jul 23",
			)}&body=${encodeURIComponent(withEmail.message)}`,
		);
		const noEmail = buildNudge({
			...base,
			phone: "14155552671",
			mode: "confirm",
		});
		expect(noEmail.mailtoUrl).toBeUndefined();
	});

	it("recruit subject asks about the open role", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "recruit" });
		expect(r.mailtoUrl).toContain(
			encodeURIComponent("Open Timer role — Thu, Jul 23 meeting?"),
		);
	});

	it("keeps special characters in names intact through URL encoding", () => {
		const r = buildNudge({
			...base,
			name: "O'Brien",
			phone: "14155552671",
			email: "o@x.io",
			mode: "confirm",
		});
		expect(r.message).toContain("Hi O'Brien,");
		// The name survives encoding: decoding the channel payload recovers it.
		// (encodeURIComponent leaves apostrophes literal, so don't assert %27.)
		const waText = decodeURIComponent(r.whatsappUrl?.split("?text=")[1] ?? "");
		expect(waText).toContain("O'Brien");
		const mailBody = decodeURIComponent(r.mailtoUrl?.split("&body=")[1] ?? "");
		expect(mailBody).toContain("O'Brien");
	});

	it("returns neither channel when no contact is present", () => {
		const r = buildNudge({ ...base, mode: "confirm" });
		expect(r.whatsappUrl).toBeUndefined();
		expect(r.mailtoUrl).toBeUndefined();
	});
});
