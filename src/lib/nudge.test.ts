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
		});
		expect(r.whatsappUrl).toBe(
			`https://wa.me/14155552671?text=${encodeURIComponent(r.message)}`,
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
