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

	it("is otherwise byte-identical to the reminder that shipped before #731", () => {
		// The whole no-link path is the common one — most clubs meet in a room —
		// so a change that quietly reworded it for everyone would be a regression
		// dressed as a feature.
		expect(build({ joinUrl: null })).toEqual(build());
	});
});

describe("the href cannot be broken out of (AC 7b)", () => {
	/**
	 * `normalizePresentationUrl` percent-encodes a quote, so no value written
	 * through the app can reach this. The guard is for a row that arrived some
	 * other way — a hand-run SQL fix, a future importer — because the escaping
	 * is what decides whether that becomes a broken link or an injected tag.
	 */
	it("escapes a double quote instead of closing the attribute", () => {
		const email = build({
			joinUrl: 'https://evil.example.com/"><script>alert(1)</script>',
		});
		expect(email.html).not.toContain("<script>");
		expect(email.html).toContain("&quot;");
		// The `>` of the injected tag is escaped too, so nothing reopens.
		expect(email.html).toContain("&gt;");
	});

	it("escapes the angle brackets of an injected tag in the club name too", () => {
		// Same escaper, and the regression that would silently drop the new arm.
		const email = build({ clubName: 'Club "<b>X</b>"' });
		expect(email.html).not.toContain("<b>");
		expect(email.html).toContain("&quot;");
	});
});
