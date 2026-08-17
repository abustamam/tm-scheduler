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

	it("greets by first name, not the full stored name (#486)", () => {
		const r = buildNudge({
			...base,
			name: "Zabihullah Kogyani",
			email: "z@x.io",
			mode: "confirm",
		});
		expect(r.message).toMatch(/^Hi Zabihullah, just confirming/);
		expect(r.message).not.toContain("Kogyani");
	});

	it("greets a `Last, First` name correctly, with no doubled comma", () => {
		// Regression: the whitespace split returned "Khan," and the template adds
		// its own comma, producing "Hi Khan,, just confirming…" — addressing the
		// member by their family name, in a message a human is about to send.
		const r = buildNudge({
			...base,
			name: "Khan, Mois",
			email: "k@x.io",
			mode: "confirm",
		});
		expect(r.message).toMatch(/^Hi Mois, just confirming/);
		expect(r.message).not.toContain(",,");
		expect(r.message).not.toContain("Khan");
	});

	it("greets by the recorded name when the first token is wrong", () => {
		// The first token of the stored name is not what this person is called.
		const r = buildNudge({
			...base,
			name: "Abdul-Rasheed Bustamam",
			preferredName: "Rasheed",
			email: "r@x.io",
			mode: "recruit",
		});
		expect(r.message).toMatch(/^Hi Rasheed, would you be open/);
		expect(r.message).not.toContain("Abdul-Rasheed");
	});

	it("carries the greeting into both channel payloads", () => {
		const r = buildNudge({
			...base,
			name: "Abdul-Rasheed Bustamam",
			preferredName: "Rasheed",
			phone: "14155552671",
			email: "r@x.io",
			mode: "confirm",
			platform: "desktop",
		});
		const waText = decodeURIComponent(
			new URL(r.whatsappUrl ?? "").searchParams.get("text") ?? "",
		);
		expect(waText).toContain("Hi Rasheed,");
		const mailBody = decodeURIComponent(r.mailtoUrl?.split("&body=")[1] ?? "");
		expect(mailBody).toContain("Hi Rasheed,");
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

	describe("attendance mode (#planned-attendance D5)", () => {
		it("asks whether they can make the meeting, naming no role", () => {
			const n = buildNudge({
				name: "Sam Rivera",
				phone: "+15551234567",
				email: null,
				meetingDate: "Tue 19 Aug",
				shareUrl: "https://club.example/m/2026-08-19",
				mode: "attendance",
			});
			expect(n.message).toBe(
				"Hi Sam, are you able to make our Tue 19 Aug meeting? Agenda here: https://club.example/m/2026-08-19",
			);
			// The whole point of the mode: no role is being asked for. A template that
			// leaked `undefined` would still contain the date and the URL and pass a
			// looser assertion.
			expect(n.message).not.toContain("undefined");
			expect(n.message).not.toContain("role");
		});

		it("greets by preferred name, like the other modes (#486)", () => {
			const n = buildNudge({
				name: "Zabihullah Kogyani",
				preferredName: "Zabi",
				phone: "+15551234567",
				email: null,
				meetingDate: "Tue 19 Aug",
				shareUrl: "https://club.example/m",
				mode: "attendance",
			});
			expect(n.message).toContain("Hi Zabi,");
		});

		it("uses an attendance subject line for the email fallback", () => {
			const n = buildNudge({
				name: "Sam Rivera",
				phone: null,
				email: "sam@example.com",
				meetingDate: "Tue 19 Aug",
				shareUrl: "https://club.example/m",
				mode: "attendance",
			});
			expect(n.mailtoUrl).toContain("subject=");
			expect(decodeURIComponent(n.mailtoUrl as string)).toContain(
				"Are you coming? — Tue 19 Aug",
			);
		});
	});

	it("escapes a stored address so it cannot inject its own mailto headers", () => {
		// The worst of the four `mailto:` sinks, because this one is a draft the
		// VPE TAPS TO SEND rather than an address they read first. Interpolated
		// raw, this address opened a message that (a) blind-copied a third party
		// and (b) lost this app's own subject line — everything after the FIRST
		// `?` is headers, so the second `?subject=` became part of the injected
		// `body` instead of a header of its own.
		const r = buildNudge({
			...base,
			email: "ada@club.org?bcc=attacker@evil.com&body=I resign",
			mode: "confirm",
		});
		const url = r.mailtoUrl ?? "";

		// Exactly one header section: the one this module opened.
		const sections = url.split("?");
		expect(sections).toHaveLength(2);

		// And it holds exactly this module's two headers, in its own order — no
		// `bcc`, and the subject is still a SUBJECT rather than body text.
		const params = new URLSearchParams(sections[1]);
		expect([...params.keys()]).toEqual(["subject", "body"]);
		expect(params.get("subject")).toBe(
			"Confirming your Timer role — Thu, Jul 23",
		);
		expect(params.get("body")).toBe(r.message);
		// Asserted on the header SECTION, not on the whole URL: the escaped
		// address still contains the inert characters `bcc` (as `%3Fbcc%3D`),
		// which is exactly right — they are recipient text now, not a header.
		expect(sections[1]).not.toContain("bcc");

		// The address itself is preserved, just escaped — the recipient a client
		// parses is the whole stored string, not a truncation of it that could
		// silently address someone else.
		expect(decodeURIComponent(sections[0].slice("mailto:".length))).toBe(
			"ada@club.org?bcc=attacker@evil.com&body=I resign",
		);
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
