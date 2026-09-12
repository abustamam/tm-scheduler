/**
 * `buildNotificationEmail` — the reminder body (#271), and the video-call join
 * link it now carries (#731).
 *
 * ## Why this file exists
 *
 * The reminder is the one place the join link reaches a member who is NOT
 * looking at the app, which is the complaint the feature answers: "what's the
 * link?" in the group chat on meeting night. The builder is pure, so every
 * branch of it is assertable here — but `notifications-logic.ts` imports `db`
 * at module scope, so the module cannot be imported at all without the
 * `vi.mock("#/db")` + `await import(...)` dance. The pattern is
 * `notifications.integration.test.ts:23-30`; this file needs no database.
 *
 * ## The case a happy-path test would skip
 *
 * BOTH bodies. The plain-text half is what a text-only client renders — and a
 * locked-down work mail client is exactly where a member reads a reminder five
 * minutes before an online meeting starts. A link that exists only in the HTML
 * fails for the people most likely to need it, and an HTML-only assertion
 * cannot see that.
 */
import { describe, expect, it, vi } from "vitest";

// The module reaches `#/db` on import. Nothing here touches it.
vi.mock("#/db", () => ({ db: {} }));

const { buildNotificationEmail } = await import("./notifications-logic");
const { formatMeetingDate } = await import("#/lib/format");

const ROW = {
	recipientName: "Ada Lovelace",
	roleName: "Timer",
	clubName: "Harbor City Toastmasters",
	meetingScheduledAt: new Date("2026-09-15T19:00:00Z"),
	unsubscribeUrl: "https://gavelup.app/u/abc123",
};

const build = (over: Partial<typeof ROW> & { joinUrl?: string | null } = {}) =>
	buildNotificationEmail({ ...ROW, ...over });

describe("the reminder carries the join link in BOTH bodies", () => {
	const email = build({ joinUrl: "https://zoom.us/j/1234567890" });

	it("puts it in the plain-text body", () => {
		expect(email.text).toContain("https://zoom.us/j/1234567890");
	});

	it("puts it in the HTML body, as a clickable anchor", () => {
		expect(email.html).toContain(
			'<a href="https://zoom.us/j/1234567890">https://zoom.us/j/1234567890</a>',
		);
	});

	it("labels it, so the URL is not a bare line of text", () => {
		expect(email.text).toContain("Join the video call:");
		expect(email.html).toContain("Join the video call:");
	});

	it("leaves the subject alone", () => {
		// A URL in the subject line is a spam signal and reads as noise in an
		// inbox list; the subject stays the role reminder's identity.
		expect(email.subject).toBe(build({ joinUrl: null }).subject);
		expect(email.subject).not.toContain("zoom.us");
	});
});

describe("a meeting with no join link mentions it in neither body", () => {
	for (const [label, joinUrl] of [
		["null", null],
		["absent", undefined],
		["blank", "   "],
	] as const) {
		it(`says nothing when the field is ${label}`, () => {
			const email = build({ joinUrl });
			expect(email.text).not.toContain("Join the video call");
			expect(email.html).not.toContain("Join the video call");
		});
	}

	it("is byte-identical to the reminder that shipped before #731", () => {
		// The no-link path is the COMMON one — most clubs meet in a room — so a
		// change that quietly reworded it for everyone would be a regression
		// dressed as a feature.
		//
		// Pinned against the literal pre-#731 bodies, transcribed from the commit
		// before this change. An earlier version of this test compared
		// `build({joinUrl: null})` with `build()` — both the no-link branch, so it
		// asserted that one branch equals itself and would have passed over any
		// rewording at all.
		//
		// Only the DATE is interpolated, because `formatMeetingDate` drops the year
		// for a meeting in the current one — hardcoding its output would make this
		// test start failing in January for a reason unrelated to the email.
		// Everything else is the literal pre-#731 text.
		const when = formatMeetingDate(ROW.meetingScheduledAt);
		const email = build({ joinUrl: null });
		expect(email.text).toBe(
			[
				"Hi Ada Lovelace,",
				"",
				`This is a reminder that you're signed up as Timer for Harbor City Toastmasters's meeting on ${when}.`,
				"",
				"See you there!",
				"Harbor City Toastmasters",
				"",
				"—",
				"Don't want role reminders? Unsubscribe: https://gavelup.app/u/abc123",
			].join("\n"),
		);
		expect(
			email.html,
		).toBe(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;">
  <p>Hi Ada Lovelace,</p>
  <p>This is a reminder that you're signed up as <strong>Timer</strong> for Harbor City Toastmasters's meeting on <strong>${when}</strong>.</p>
  <p>See you there!<br>Harbor City Toastmasters</p>
  <p style="font-size:12px;color:#a1a1aa;margin-top:24px;">
    Don't want role reminders?
    <a href="https://gavelup.app/u/abc123" style="color:#71717a;">Unsubscribe</a>.
  </p>
</div>`);
	});
});

/**
 * The builder re-normalizes rather than trusting the column, exactly as the
 * meeting page does at render — and this is the more important of the two
 * places, because the page needs someone to be looking at it while a reminder
 * is PUSHED to every role holder from the club's own sender.
 */
describe("a row written some other way cannot put a bad link in the mail", () => {
	it("drops a javascript: scheme instead of linking it", () => {
		const email = build({ joinUrl: "javascript:alert(1)" });
		expect(email.html).not.toContain("javascript:");
		expect(email.text).not.toContain("javascript:");
		expect(email.html).not.toContain("Join the video call");
	});

	it("drops a credentials-in-URL link that reads as Zoom (#731 P1)", () => {
		// `https://zoom.us@evil.example.com/` has hostname evil.example.com. The
		// email renders link text == href, so it would read as a Zoom link to
		// every recipient.
		const email = build({ joinUrl: "https://zoom.us@evil.example.com/j/123" });
		expect(email.html).not.toContain("evil.example.com");
		expect(email.text).not.toContain("evil.example.com");
		expect(email.html).not.toContain("Join the video call");
	});

	it("still sends an ordinary stored link", () => {
		// The control: re-normalizing must not drop the good case.
		expect(build({ joinUrl: "https://zoom.us/j/1234567890" }).text).toContain(
			"https://zoom.us/j/1234567890",
		);
	});
});

describe("the href cannot be broken out of (AC 7b)", () => {
	/**
	 * `normalizePresentationUrl` percent-encodes a quote, so no value written
	 * through the app can reach this. The guard is for a row that arrived some
	 * other way — a hand-run SQL fix, a future importer — because the escaping
	 * is what decides whether that becomes a broken link or an injected tag.
	 */
	it("cannot close the href with a quote in the URL", () => {
		// TWO layers now, and the order matters for what this asserts.
		// `normalizePresentationUrl` runs first and percent-encodes `"`, `<` and
		// `>` in the path, so nothing hostile survives to reach the escaper at all.
		const email = build({
			joinUrl: 'https://evil.example.com/"><script>alert(1)</script>',
		});
		expect(email.html).not.toContain("<script>");
		expect(email.html).not.toContain('"><');
		expect(email.html).toContain("%22%3E%3Cscript%3E");
	});

	it("escapes the angle brackets of an injected tag in the club name too", () => {
		// Same escaper, and the regression that would silently drop the new arm.
		const email = build({ clubName: 'Club "<b>X</b>"' });
		expect(email.html).not.toContain("<b>");
		expect(email.html).toContain("&quot;");
	});
});
