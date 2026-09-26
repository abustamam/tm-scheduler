import { describe, expect, it } from "vitest";
import {
	buildEmailBlast,
	buildFlyerContent,
	buildWhatsAppBlast,
	DEFAULT_PROMO_TEMPLATE,
	FLYER_MEETING_FIELDS,
	MAILTO_MAX_LENGTH,
	ONLINE_TEXT,
	PROMO_LIMITS,
	PROMO_PLACEHOLDERS,
	type PromoClub,
	type PromoMeeting,
	type PromoTemplate,
	projectFlyerMeeting,
	promoMailtoHref,
	promoTemplateSchema,
	promoValues,
	renderPromoText,
	resolvePromoTemplate,
	resolvePromoTemplateState,
	templateWarnings,
	unknownPlaceholders,
} from "./promo-template";

const CLUB: PromoClub = {
	name: "Downtown Speakers",
	slug: "downtown",
	timezone: "America/Chicago",
};

// 2026-10-02 00:30 UTC is 7:30 PM on Thursday, October 1 in Chicago (CDT) —
// and already FRIDAY, October 2 in UTC, so a formatter that ignored the club's
// timezone would print the wrong day.
const MEETING: PromoMeeting = {
	urlKey: "2026-10-01",
	scheduledAt: "2026-10-02T00:30:00Z",
	location: "Library, Room 4",
	online: true,
	theme: "Beginnings",
	wordOfTheDay: "Ephemeral",
	meetingNumber: 57,
	promoNote: "It's our open house, bring a friend!",
};

const ORIGIN = "https://gavelup.app";
const LINK = "https://gavelup.app/club/downtown/meeting/2026-10-01";

/** A video-call link as a careless caller might hand it over. */
const ROOM = "https://zoom.example/j/931-secret-room";

const values = (m: Partial<PromoMeeting> = {}) =>
	promoValues(CLUB, { ...MEETING, ...m }, ORIGIN);

describe("promoValues", () => {
	it("formats the date and time in the CLUB's timezone", () => {
		const v = values();
		expect(v.date).toBe("Thursday, October 1");
		expect(v.time).toBe("7:30 PM");
	});

	it("the same instant reads as a different day in another zone (control)", () => {
		const v = promoValues({ ...CLUB, timezone: "UTC" }, MEETING, ORIGIN);
		expect(v.date).toBe("Friday, October 2");
	});

	it("links to the public meeting page and the club page, absolute", () => {
		const v = values();
		expect(v.meetingLink).toBe(LINK);
		expect(v.clubLink).toBe("https://gavelup.app/club/downtown");
	});

	it("says the meeting is online without carrying a link", () => {
		expect(values().online).toBe(ONLINE_TEXT);
		expect(values({ online: false }).online).toBe("");
		expect(ONLINE_TEXT).not.toMatch(/https?:/);
	});

	it("has a value for every placeholder and no other key", () => {
		expect(Object.keys(values()).sort()).toEqual(
			[...PROMO_PLACEHOLDERS].sort(),
		);
	});
});

describe("renderPromoText", () => {
	it("fills in known placeholders", () => {
		expect(renderPromoText("{club} meets {date} at {time}", values())).toBe(
			"Downtown Speakers meets Thursday, October 1 at 7:30 PM",
		);
	});

	it("drops the whole line when a placeholder on it is empty", () => {
		const text = "Theme: {theme}\nWhere: {location}";
		expect(renderPromoText(text, values({ theme: null }))).toBe(
			"Where: Library, Room 4",
		);
		// Whitespace-only is empty too.
		expect(renderPromoText(text, values({ theme: "   " }))).toBe(
			"Where: Library, Room 4",
		);
	});

	it("drops the {note} line when there is no promo note, and keeps it when there is", () => {
		const text = "Hello\n{note}\nBye";
		expect(renderPromoText(text, values())).toBe(
			"Hello\nIt's our open house, bring a friend!\nBye",
		);
		expect(renderPromoText(text, values({ promoNote: null }))).toBe(
			"Hello\nBye",
		);
	});

	it("leaves an UNKNOWN placeholder as typed rather than blanking it", () => {
		expect(renderPromoText("Theme: {thme}", values())).toBe("Theme: {thme}");
	});

	it("collapses the blank lines a dropped line leaves behind", () => {
		const text = "A\n\n{theme}\n\nB";
		expect(renderPromoText(text, values({ theme: null }))).toBe("A\n\nB");
	});
});

describe("unknown placeholders are flagged", () => {
	it("lists each unknown name once", () => {
		expect(unknownPlaceholders("{club} {thme} {thme} {venue}")).toEqual([
			"thme",
			"venue",
		]);
	});

	it("the default template has none", () => {
		expect(templateWarnings(DEFAULT_PROMO_TEMPLATE)).toEqual([]);
	});

	it("finds one in any part of the template", () => {
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			whyJoin: ["Meet {host}"],
			callToAction: "RSVP to {rsvp}",
		};
		expect(templateWarnings(t)).toEqual(["host", "rsvp"]);
	});
});

describe("the video-call link is in no output", () => {
	// The value map has no slot for it, so the only way in is a template naming
	// it — and an unknown placeholder renders literally, never as a value.
	const leaky: PromoTemplate = {
		...DEFAULT_PROMO_TEMPLATE,
		intro: `${DEFAULT_PROMO_TEMPLATE.intro}\nJoin: {joinUrl}`,
		channels: {
			whatsapp: { intro: true, whyJoin: true, callToAction: true },
			email: { intro: true, whyJoin: true, callToAction: true },
			flyer: { intro: true, whyJoin: true, callToAction: true },
		},
	};
	// A caller handing the whole meeting row over, link included.
	const widened = { ...MEETING, joinUrl: ROOM } as PromoMeeting;
	const v = promoValues(CLUB, widened, ORIGIN);

	it("is not in the value map", () => {
		expect(JSON.stringify(v)).not.toContain(ROOM);
	});

	it("is not in the WhatsApp message, the email or the flyer", () => {
		const email = buildEmailBlast(leaky, v);
		const outputs = [
			buildWhatsAppBlast(leaky, v),
			email.subject,
			email.text,
			email.html,
			JSON.stringify(buildFlyerContent(leaky, v)),
		];
		for (const out of outputs) expect(out).not.toContain(ROOM);
		// …and the placeholder asking for it is left visible, not filled.
		expect(buildWhatsAppBlast(leaky, v)).toContain("{joinUrl}");
		expect(templateWarnings(leaky)).toContain("joinUrl");
	});

	it("the flyer projection drops it (and anything else unlisted)", () => {
		const projected = projectFlyerMeeting({
			...widened,
			id: "m1",
			notes: "private",
		} as unknown as PromoMeeting & { id: string });
		expect(JSON.stringify(projected)).not.toContain(ROOM);
		expect(Object.keys(projected).sort()).toEqual(
			[...FLYER_MEETING_FIELDS].sort(),
		);
		expect(FLYER_MEETING_FIELDS.join(" ")).not.toMatch(/join/i);
	});
});

describe("buildWhatsAppBlast", () => {
	const msg = buildWhatsAppBlast(DEFAULT_PROMO_TEMPLATE, values());

	it("bolds the headline with WhatsApp's own markup", () => {
		expect(msg.split("\n")[0]).toBe(
			"*You're invited: Downtown Speakers, Thursday, October 1*",
		);
	});

	it("puts the meeting link alone on the last line", () => {
		const lines = msg.split("\n");
		expect(lines[lines.length - 1]).toBe(LINK);
		expect(lines[lines.length - 2]).toBe("");
	});

	it("carries the why-join bullets, the call to action and the note", () => {
		expect(msg).toContain("• Practice public speaking in a supportive room");
		expect(msg).toContain(DEFAULT_PROMO_TEMPLATE.callToAction);
		expect(msg).toContain("It's our open house, bring a friend!");
		expect(msg).toContain(ONLINE_TEXT);
	});

	it("the default fits a group chat", () => {
		expect(msg.length).toBeLessThanOrEqual(PROMO_LIMITS.whatsappSoft);
	});

	it("honours the channel toggles", () => {
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			channels: {
				...DEFAULT_PROMO_TEMPLATE.channels,
				whatsapp: { intro: false, whyJoin: false, callToAction: false },
			},
		};
		expect(buildWhatsAppBlast(t, values())).toBe(
			`*You're invited: Downtown Speakers, Thursday, October 1*\n\n${LINK}`,
		);
	});
});

describe("buildEmailBlast", () => {
	const email = buildEmailBlast(DEFAULT_PROMO_TEMPLATE, values());

	it("uses the headline as a one-line subject", () => {
		expect(email.subject).toBe(
			"You're invited: Downtown Speakers, Thursday, October 1",
		);
	});

	it("ends the body on the meeting link", () => {
		expect(email.text.endsWith(`Details and agenda: ${LINK}`)).toBe(true);
		expect(email.html).toContain(`<a href="${LINK}">`);
	});

	it("escapes what an officer typed in the HTML body", () => {
		const t = { ...DEFAULT_PROMO_TEMPLATE, callToAction: "<b>Bring</b> & go" };
		const html = buildEmailBlast(t, values()).html;
		expect(html).toContain("&lt;b&gt;Bring&lt;/b&gt; &amp; go");
		expect(html).not.toContain("<b>Bring");
	});
});

describe("promoMailtoHref", () => {
	it("carries the subject and body, and no recipient", () => {
		const href = promoMailtoHref("Hi & bye", "Line 1\nLine 2");
		expect(href).toBe(
			"mailto:?subject=Hi%20%26%20bye&body=Line%201%0ALine%202",
		);
	});

	it("returns null when the draft is too long to open reliably", () => {
		expect(promoMailtoHref("s", "x".repeat(MAILTO_MAX_LENGTH))).toBeNull();
	});
});

describe("buildFlyerContent", () => {
	it("prints the meeting's details and leaves the intro off by default", () => {
		const f = buildFlyerContent(DEFAULT_PROMO_TEMPLATE, values());
		expect(f.intro).toBe("");
		expect(f.date).toBe("Thursday, October 1");
		expect(f.location).toBe("Library, Room 4");
		expect(f.theme).toBe("Beginnings");
		expect(f.whyJoin).toHaveLength(5);
		expect(f.meetingLink).toBe(LINK);
	});
});

describe("the stored template", () => {
	it("null is the seeded default — what a new club gets", () => {
		expect(resolvePromoTemplate(null)).toEqual(DEFAULT_PROMO_TEMPLATE);
	});

	it("says when a STORED value could not be parsed, and not when there is none", () => {
		expect(resolvePromoTemplateState({ headline: 3 }).storedInvalid).toBe(true);
		expect(resolvePromoTemplateState(null).storedInvalid).toBe(false);
		expect(
			resolvePromoTemplateState(DEFAULT_PROMO_TEMPLATE).storedInvalid,
		).toBe(false);
	});

	it("a malformed value falls back to the default rather than crashing", () => {
		expect(resolvePromoTemplate({ headline: 3 })).toEqual(
			DEFAULT_PROMO_TEMPLATE,
		);
	});

	it("a valid value round-trips", () => {
		const t = { ...DEFAULT_PROMO_TEMPLATE, headline: "Come to {club}" };
		expect(resolvePromoTemplate(t)).toEqual(t);
	});

	it("the default passes its own schema", () => {
		expect(promoTemplateSchema.safeParse(DEFAULT_PROMO_TEMPLATE).success).toBe(
			true,
		);
	});

	it("refuses a blank headline and too many bullets", () => {
		expect(
			promoTemplateSchema.safeParse({
				...DEFAULT_PROMO_TEMPLATE,
				headline: " ",
			}).success,
		).toBe(false);
		expect(
			promoTemplateSchema.safeParse({
				...DEFAULT_PROMO_TEMPLATE,
				whyJoin: Array(PROMO_LIMITS.bullets + 1).fill("x"),
			}).success,
		).toBe(false);
	});
});

describe("a template that places {meetingLink} itself", () => {
	const t: PromoTemplate = {
		...DEFAULT_PROMO_TEMPLATE,
		callToAction: "RSVP and see the agenda: {meetingLink}",
	};
	const count = (s: string) => s.split(LINK).length - 1;

	it("WhatsApp carries the link once, not appended again", () => {
		expect(count(buildWhatsAppBlast(t, values()))).toBe(1);
	});

	it("the email body carries it once, in text and in HTML", () => {
		const e = buildEmailBlast(t, values());
		expect(count(e.text)).toBe(1);
		expect(e.html).not.toContain("Details and agenda");
	});

	it("a toggled-OFF part does not count as placing it", () => {
		const off: PromoTemplate = {
			...t,
			channels: {
				...t.channels,
				whatsapp: { ...t.channels.whatsapp, callToAction: false },
			},
		};
		expect(count(buildWhatsAppBlast(off, values()))).toBe(1);
		expect(buildWhatsAppBlast(off, values()).endsWith(LINK)).toBe(true);
	});

	it("the default template does not place it, so it is appended (control)", () => {
		expect(count(buildWhatsAppBlast(DEFAULT_PROMO_TEMPLATE, values()))).toBe(1);
		expect(buildEmailBlast(DEFAULT_PROMO_TEMPLATE, values()).text).toContain(
			`Details and agenda: ${LINK}`,
		);
	});
});
