import { describe, expect, it } from "vitest";
import { buildPanelRoleMap } from "#/lib/attendance-panel";
import {
	GRAMMARIAN_ROLE_KEY,
	TIMER_ROLE_KEY,
	TMOD_ROLE_KEY,
} from "#/lib/meeting-roles";
import { dutiesForRole, personalMeetingHref } from "#/lib/role-duties";
import {
	buildNudge,
	outstandingDuties,
	outstandingDutiesByMember,
	personalNudgeUrl,
} from "./nudge";

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

	describe("arriving mode (roll call, F6)", () => {
		// A separate mode rather than a reuse of `attendance`, because roll rows
		// render DURING the meeting (contact stays until it is `completed`) and the
		// `attendance` draft is a pre-meeting ask. Sent from the room at 7:45pm it
		// read "are you able to make our Tuesday 18 August meeting?" under the
		// subject "Are you coming?", about the meeting the recipient could hear
		// starting.
		it("asks whether they are on their way, not whether they can make it", () => {
			const n = buildNudge({
				name: "Sam Rivera",
				phone: "+15551234567",
				email: null,
				meetingDate: "Tue 19 Aug",
				shareUrl: "https://club.example/m/2026-08-19",
				mode: "arriving",
			});
			expect(n.message).toBe(
				"Hi Sam, we've started our Tue 19 Aug meeting — are you on your way? Agenda here: https://club.example/m/2026-08-19",
			);
			// The pre-meeting phrasing must be GONE, not merely joined: a mode that
			// fell through to the `attendance` template would still contain the date,
			// the URL and the greeting, and pass a looser assertion.
			expect(n.message).not.toContain("are you able to make");
			// Role-less, like `attendance`.
			expect(n.message).not.toContain("undefined");
			expect(n.message).not.toContain("role");
		});

		it("greets by preferred name, like every other mode (#486)", () => {
			const n = buildNudge({
				name: "Zabihullah Kogyani",
				preferredName: "Zabi",
				phone: "+15551234567",
				email: null,
				meetingDate: "Tue 19 Aug",
				shareUrl: "https://club.example/m",
				mode: "arriving",
			});
			expect(n.message).toContain("Hi Zabi,");
		});

		it("carries its own subject line, not the pre-meeting one", () => {
			const n = buildNudge({
				name: "Sam Rivera",
				phone: null,
				email: "sam@example.com",
				meetingDate: "Tue 19 Aug",
				shareUrl: "https://club.example/m",
				mode: "arriving",
			});
			const decoded = decodeURIComponent(n.mailtoUrl as string);
			expect(decoded).toContain("Are you on your way? — Tue 19 Aug");
			expect(decoded).not.toContain("Are you coming?");
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

/**
 * Duty-aware drafts (#667).
 *
 * Every fixture takes its clauses from the REGISTRY (`dutiesForRole`) rather
 * than from a literal spelled here. A restated clause agrees with whichever
 * copy the test author had in mind and stops agreeing with the checklist the
 * recipient actually lands on — which is the exact disagreement the shared
 * registry exists to prevent, reintroduced inside its own test.
 */
const grammarian = { roleName: "Grammarian", roleKey: GRAMMARIAN_ROLE_KEY };
const tmod = { roleName: "Toastmaster of the Day", roleKey: TMOD_ROLE_KEY };
const timer = { roleName: "Timer", roleKey: TIMER_ROLE_KEY };
const speaker = { roleName: "Speaker", roleKey: "speaker" };

describe("outstandingDuties", () => {
	it("keeps a duty nobody has done yet", () => {
		expect(outstandingDuties(grammarian, {}).map((d) => d.id)).toEqual([
			"word_of_the_day",
		]);
	});

	it("drops a duty the data says is finished", () => {
		// The registry still OWNS the duty — the filter is what removes it, which
		// is the difference between "this role has no job" and "the job is done".
		expect(dutiesForRole(grammarian)).toHaveLength(1);
		expect(
			outstandingDuties(grammarian, { wordOfTheDay: "Ebullient" }),
		).toEqual([]);
	});

	it("reads a blank answer as not done, like the checklist does", () => {
		// `"  "` is the case a hand-rolled `if (!theme)` gets wrong, and getting it
		// wrong here silently suppresses the nudge that exists to get a real one.
		expect(outstandingDuties(tmod, { theme: "   " })).toHaveLength(1);
	});

	it("reads the TBA sentinel as not done", () => {
		// A blank speech title is STORED as "TBA", so a non-blank check reads the
		// app's own placeholder as a finished speech.
		expect(outstandingDuties(speaker, { speechTitle: "TBA" })).toHaveLength(1);
		expect(outstandingDuties(speaker, { speechTitle: "My talk" })).toEqual([]);
	});

	it("gives a role with nothing recordable no clauses at all", () => {
		// Five of the nine standard roles. This is the COMMON case, which is why
		// the empty draft below has to stay byte-identical.
		expect(outstandingDuties({ roleName: "Ah-Counter" }, {})).toEqual([]);
	});
});

describe("buildNudge duty clauses (#667)", () => {
	const link = "https://gavelup.app/club/mcf/meeting/abc/me?as=m1";

	it("names what the role still owes, and links somewhere they can do it", () => {
		const r = buildNudge({
			...base,
			roleName: "Grammarian",
			email: "j@x.io",
			mode: "confirm",
			duties: outstandingDuties(grammarian, {}),
			personalUrl: link,
		});
		expect(r.message).toBe(
			"Hi Jane, just confirming you're our Grammarian for the Thu, Jul 23 meeting — " +
				`you'll also need to set the Word of the Day. Confirm and do that here: ${link}`,
		);
	});

	it("says nothing about a job already done, and still reads as a sentence", () => {
		// Suppression is the requirement, not a nicety: a nudge about a finished
		// job teaches the recipient these messages are not worth reading.
		const r = buildNudge({
			...base,
			roleName: "Grammarian",
			email: "j@x.io",
			mode: "confirm",
			duties: outstandingDuties(grammarian, { wordOfTheDay: "Ebullient" }),
			personalUrl: link,
		});
		expect(r.message).toBe(
			`Hi Jane, just confirming you're our Grammarian for the Thu, Jul 23 meeting. Details: ${link}`,
		);
		// The dangling-clause failures, each asserted rather than implied by the
		// exact match above: an empty list must not leave the em dash, the lead-in
		// or the word it was going to interpolate.
		expect(r.message).not.toContain("Word of the Day");
		expect(r.message).not.toContain("you'll also need to");
		expect(r.message).not.toContain("—");
	});

	it("leaves a duty-less role's draft byte-identical apart from the link", () => {
		// The property the issue states outright, checked as a property rather
		// than as a second copy of the template: swap the URL back and the two
		// strings must be the same bytes.
		const today = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		const now = buildNudge({
			...base,
			email: "j@x.io",
			mode: "confirm",
			duties: outstandingDuties({ roleName: "Ah-Counter" }, {}),
			personalUrl: link,
		});
		expect(now.message.replace(link, base.shareUrl)).toBe(today.message);
		// And the subject line — the other half of a mail draft — is untouched.
		expect(now.mailtoUrl?.split("&body=")[0]).toBe(
			today.mailtoUrl?.split("&body=")[0],
		);
	});

	it("reads several outstanding duties as a list, not a run-on", () => {
		const r = buildNudge({
			...base,
			roleName: "Toastmaster of the Day",
			email: "j@x.io",
			mode: "confirm",
			// No single role owns three today; the builder must still be the thing
			// that decides how a list reads, rather than the registry happening to
			// hold one duty per role.
			duties: [
				...outstandingDuties(tmod, {}),
				...outstandingDuties(grammarian, {}),
				...outstandingDuties(speaker, {}),
			],
			personalUrl: link,
		});
		expect(r.message).toContain(
			"you'll also need to set the meeting theme, set the Word of the Day and add your speech details.",
		);
		// The two shapes a naive join produces, both of which a reader notices.
		expect(r.message).not.toContain(", and ");
		expect(r.message).not.toContain("day set");
	});

	it("joins exactly two duties with `and`, no comma", () => {
		const r = buildNudge({
			...base,
			roleName: "Toastmaster of the Day",
			mode: "confirm",
			duties: [...outstandingDuties(tmod, {}), ...outstandingDuties(timer, {})],
		});
		expect(r.message).toContain(
			"you'll also need to set the meeting theme and time the speeches.",
		);
	});

	it("asks rather than tells in a recruit draft", () => {
		// "You'd", not "you'll": nobody has said yes yet.
		const r = buildNudge({
			...base,
			roleName: "Grammarian",
			email: "j@x.io",
			mode: "recruit",
			duties: outstandingDuties(grammarian, {}),
			personalUrl: link,
		});
		expect(r.message).toBe(
			"Hi Jane, would you be open to taking Grammarian at our Thu, Jul 23 meeting? " +
				`You'd also need to set the Word of the Day. Info here: ${link}`,
		);
		expect(r.message).not.toContain("you'll also need");
	});

	it("tells a Timer they will be timing the speeches (#730 duty, #667 amendment)", () => {
		// `hasTiming` is absent from every nudge caller's context — a
		// `meeting_timings` row only exists once timing starts during the meeting,
		// and `loadMeetingDetail` loads none — so an absent field reads as NOT
		// DONE and the clause is the truthful thing to send.
		const r = buildNudge({
			...base,
			email: "j@x.io",
			mode: "confirm",
			duties: outstandingDuties(timer, {}),
			personalUrl: link,
		});
		expect(r.message).toContain("you'll also need to time the speeches.");
	});

	it("drops the timing clause once a timing exists, and still reads", () => {
		const r = buildNudge({
			...base,
			email: "j@x.io",
			mode: "confirm",
			duties: outstandingDuties(timer, { hasTiming: true }),
			personalUrl: link,
		});
		expect(r.message).toBe(
			`Hi Jane, just confirming you're our Timer for the Thu, Jul 23 meeting. Details: ${link}`,
		);
		expect(r.message).not.toContain("time the speeches");
	});

	it("carries the Timer's clause into a recruit draft too", () => {
		const r = buildNudge({
			...base,
			mode: "recruit",
			duties: outstandingDuties(timer, {}),
		});
		expect(r.message).toContain("You'd also need to time the speeches.");
	});

	it("carries the clause into BOTH channel payloads, not just the message", () => {
		// The message is what a reviewer reads; the hrefs are what the recipient
		// gets. Dropping `message` out of either payload leaves the assertion
		// above green.
		const r = buildNudge({
			...base,
			roleName: "Grammarian",
			phone: "14155552671",
			email: "j@x.io",
			mode: "confirm",
			duties: outstandingDuties(grammarian, {}),
			personalUrl: link,
		});
		const waText = decodeURIComponent(
			new URL(r.whatsappUrl ?? "").searchParams.get("text") ?? "",
		);
		expect(waText).toContain("set the Word of the Day");
		expect(waText).toContain(link);
		const mailBody = decodeURIComponent(r.mailtoUrl?.split("&body=")[1] ?? "");
		expect(mailBody).toContain("set the Word of the Day");
		expect(mailBody).toContain(link);
	});

	it("still escapes a hostile address once the draft carries duty text", () => {
		// `mailto.guard.test.ts` exists because this sink is a draft a VPE TAPS TO
		// SEND. #667 adds text to that draft, so the escape is re-asserted against
		// the new body rather than assumed to have survived.
		const r = buildNudge({
			...base,
			roleName: "Grammarian",
			email: "ada@club.org?bcc=attacker@evil.com&body=I resign",
			mode: "confirm",
			duties: outstandingDuties(grammarian, {}),
			personalUrl: link,
		});
		const sections = (r.mailtoUrl ?? "").split("?");
		expect(sections).toHaveLength(2);
		const params = new URLSearchParams(sections[1]);
		expect([...params.keys()]).toEqual(["subject", "body"]);
		expect(params.get("body")).toBe(r.message);
		expect(sections[1]).not.toContain("bcc");
	});

	it("keeps the role-less modes out of all of it", () => {
		// The union is what enforces this, so the compile-time half is asserted
		// with `@ts-expect-error` (typecheck fails if the error ever stops being
		// an error) and the runtime half by the message itself.
		const n = buildNudge({
			name: "Sam Rivera",
			phone: null,
			email: null,
			meetingDate: "Tue 19 Aug",
			shareUrl: "https://club.example/m",
			mode: "attendance",
			// @ts-expect-error — `duties` and `personalUrl` live on the ROLE arms.
			// A draft that names no role has no duty to name and no checklist to
			// send anyone to; this is the same rule `roleName` is on the union for.
			duties: outstandingDuties(grammarian, {}),
		});
		expect(n.message).not.toContain("also need");
		expect(n.message).toContain("https://club.example/m");
	});
});

describe("personalNudgeUrl (#665 link, #667 producer)", () => {
	const target = { clubId: "mcf", meetingKey: "2026-09-09" };

	it("is the registry's own personal path plus the `?as=` seed", () => {
		// Asserted against `personalMeetingHref`, never against a literal `/me`:
		// the registry owns where a duty is done and therefore the way back, and
		// a second spelling here is how a draft comes to point at a 404.
		expect(
			personalNudgeUrl({ origin: "https://gavelup.app", ...target }, "m1"),
		).toBe(
			`https://gavelup.app${personalMeetingHref({
				clubId: target.clubId,
				meetingId: target.meetingKey,
			})}?as=m1`,
		);
	});

	it("stays relative during SSR, like the share link beside it", () => {
		expect(personalNudgeUrl({ origin: "", ...target }, "m1")).toBe(
			"/club/mcf/meeting/2026-09-09/me?as=m1",
		);
	});

	it("escapes the id, so it cannot open a second query parameter", () => {
		expect(personalNudgeUrl({ origin: "", ...target }, "m1&admin=1")).toBe(
			"/club/mcf/meeting/2026-09-09/me?as=m1%26admin%3D1",
		);
	});

	it("is what a role draft links to, with `shareUrl` as the fallback", () => {
		const personal = personalNudgeUrl(
			{ origin: "https://x.test", ...target },
			"m1",
		);
		const withLink = buildNudge({
			...base,
			mode: "confirm",
			personalUrl: personal,
		});
		expect(withLink.message).toContain(personal);
		expect(withLink.message).not.toContain(base.shareUrl);
		// A GUEST holder has no `members` row and so no `?as=` identity. The draft
		// keeps its link rather than losing it — and a BLANK personal URL (what a
		// surface gated off passes) falls back the same way `??` would not.
		for (const personalUrl of [null, undefined, ""]) {
			const guest = buildNudge({ ...base, mode: "confirm", personalUrl });
			expect(guest.message).toContain(base.shareUrl);
		}
	});
});

describe("outstandingDutiesByMember", () => {
	const slot = (over: {
		assigneeId: string | null;
		roleName: string;
		roleKey?: string | null;
		speechTitle?: string | null;
		roleDefinitionId?: string;
		slotIndex?: number;
	}) => ({
		roleDefinitionId: over.roleDefinitionId ?? `rd-${over.roleName}`,
		slotIndex: over.slotIndex ?? 0,
		status: "claimed" as const,
		speechTitle: null,
		roleKey: null,
		...over,
	});

	it("keys the rail's duties by member", () => {
		const map = outstandingDutiesByMember(
			[
				slot({
					assigneeId: "m1",
					roleName: "Grammarian",
					roleKey: GRAMMARIAN_ROLE_KEY,
				}),
			],
			{ theme: null, wordOfTheDay: null },
		);
		expect(map.get("m1")?.map((d) => d.id)).toEqual(["word_of_the_day"]);
	});

	it("suppresses a duty the meeting already has an answer for", () => {
		const map = outstandingDutiesByMember(
			[
				slot({
					assigneeId: "m1",
					roleName: "Toastmaster of the Day",
					roleKey: TMOD_ROLE_KEY,
				}),
			],
			{ theme: "Beginnings", wordOfTheDay: null },
		);
		expect(map.get("m1")).toEqual([]);
	});

	it("reads speech titles per SLOT, so one finished talk cannot silence the other", () => {
		const slots = [
			slot({
				assigneeId: "m1",
				roleName: "Speaker",
				roleKey: "speaker",
				speechTitle: "My finished talk",
				slotIndex: 0,
			}),
			slot({
				assigneeId: "m2",
				roleName: "Speaker",
				roleKey: "speaker",
				speechTitle: "TBA",
				slotIndex: 1,
			}),
		];
		const map = outstandingDutiesByMember(slots, {});
		expect(map.get("m1")).toEqual([]);
		expect(map.get("m2")?.map((d) => d.id)).toEqual(["speech_details"]);
	});

	it("skips open and guest-held slots, which have no member to key on", () => {
		const map = outstandingDutiesByMember(
			[
				slot({
					assigneeId: null,
					roleName: "Grammarian",
					roleKey: GRAMMARIAN_ROLE_KEY,
				}),
			],
			{},
		);
		expect(map.size).toBe(0);
	});

	it("leaves a Timer's timing duty outstanding, since no caller loads timings", () => {
		const map = outstandingDutiesByMember(
			[slot({ assigneeId: "m1", roleName: "Timer", roleKey: TIMER_ROLE_KEY })],
			{},
		);
		expect(map.get("m1")?.map((d) => d.id)).toEqual(["timing"]);
	});

	it("answers nothing for a key nobody wrote, including `__proto__`", () => {
		// The rule `DUTIES_BY_ROLE_KEY` states one module over, carried across
		// this boundary by the TYPE: a `Record` would answer for `__proto__` and
		// `constructor` with something that is not a duty list, and the panel
		// indexes this with an id taken off a row.
		const map = outstandingDutiesByMember(
			[
				slot({
					assigneeId: "m1",
					roleName: "Grammarian",
					roleKey: GRAMMARIAN_ROLE_KEY,
				}),
			],
			{},
		);
		expect(map.get("__proto__")).toBeUndefined();
		expect(map.get("constructor")).toBeUndefined();
	});

	it("takes the SAME slot of a double-booked member that the rail's badge does", () => {
		// The rail names ONE role per member and this map lists ONE role's duties;
		// built with opposite tie-breaks they would name the Grammarian and list
		// the Toastmaster's theme in the same sentence. Asserted against
		// `buildPanelRoleMap` itself rather than against "first wins", so the two
		// cannot drift apart without a failure here.
		const slots = [
			slot({
				assigneeId: "m1",
				roleName: "Toastmaster of the Day",
				roleKey: TMOD_ROLE_KEY,
				roleDefinitionId: "rd-tmod",
			}),
			slot({
				assigneeId: "m1",
				roleName: "Grammarian",
				roleKey: GRAMMARIAN_ROLE_KEY,
				roleDefinitionId: "rd-gram",
			}),
		];
		const named = buildPanelRoleMap(slots).m1?.roleName;
		expect(named).toBe("Toastmaster of the Day");
		const expected = outstandingDuties(
			{ roleName: named ?? "", roleKey: TMOD_ROLE_KEY },
			{},
		);
		// The FLOOR. Two implementations agreeing on `[]` agree about nothing —
		// and every way this fixture could go wrong (a theme already set, a role
		// key that resolves to no duties, a slot the map skipped) produces exactly
		// that vacuous pass.
		expect(expected).toHaveLength(1);
		expect(outstandingDutiesByMember(slots, {}).get("m1")).toEqual(expected);
	});
});
