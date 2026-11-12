import { describe, expect, it } from "vitest";
import type { FileRoutesByFullPath } from "#/routeTree.gen";
import {
	buildEmailBlast,
	buildEmailBlocks,
	buildFlyerBlocks,
	buildFlyerContent,
	buildWhatsAppBlast,
	buildWhatsAppBlocks,
	DEFAULT_PROMO_TEMPLATE,
	examplePromoMeeting,
	FLYER_MEETING_FIELDS,
	MAILTO_MAX_LENGTH,
	normalizePromoName,
	ONLINE_TEXT,
	PROMO_LIMITS,
	PROMO_PLACEHOLDERS,
	PROMO_VARIABLE_GROUPS,
	PROMO_VARIABLES,
	type PromoClub,
	type PromoMeeting,
	type PromoTemplate,
	type PublicFlyerMeeting,
	projectFlyerMeeting,
	promoAgendaPath,
	promoMailtoHref,
	promoRsvpPath,
	promoTemplateSchema,
	promoValues,
	renderPromoLines,
	renderPromoText,
	resolvePromoTemplate,
	resolvePromoTemplateState,
	rsvpPageUrl,
	suggestPlaceholder,
	templatesEqual,
	templateWarnings,
	toEditorText,
	toStoredText,
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
const RSVP = `${LINK}/rsvp`;
const AGENDA = `${LINK}/agenda`;
const FOOTER = `RSVP: ${RSVP}\nAgenda: ${AGENDA}`;

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

	it("links to the meeting, RSVP, agenda and club pages, absolute", () => {
		const v = values();
		expect(v.meetingLink).toBe(LINK);
		expect(v.rsvpLink).toBe(RSVP);
		expect(v.agendaLink).toBe(AGENDA);
		expect(v.clubLink).toBe("https://gavelup.app/club/downtown");
	});

	it("builds the RSVP and agenda paths of routes that exist", () => {
		// Typed against the generated route tree: renaming either route fails
		// typecheck here instead of silently breaking every blast's links.
		const rsvp: keyof FileRoutesByFullPath =
			"/club/$clubId/meeting/$meetingId/rsvp";
		const agenda: keyof FileRoutesByFullPath =
			"/club/$clubId/meeting/$meetingId/agenda";
		expect(promoRsvpPath("$clubId", "$meetingId")).toBe(rsvp);
		expect(promoAgendaPath("$clubId", "$meetingId")).toBe(agenda);
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
			status: "cancelled",
			notes: "private",
		} as unknown as PublicFlyerMeeting);
		expect(JSON.stringify(projected)).not.toContain(ROOM);
		expect(Object.keys(projected).sort()).toEqual(
			[...FLYER_MEETING_FIELDS].sort(),
		);
		expect(FLYER_MEETING_FIELDS.join(" ")).not.toMatch(/join/i);
	});

	// #1057: the flyer is marked cancelled from the row it is drawn from, so
	// the projection must keep the status the route reads that mark off.
	it("the flyer projection keeps the meeting's status", () => {
		const projected = projectFlyerMeeting({
			...widened,
			id: "m1",
			status: "cancelled",
		} as PublicFlyerMeeting);
		expect(projected.status).toBe("cancelled");
	});
});

describe("{joinLink} (#1534)", () => {
	const optIn: PromoTemplate = {
		...DEFAULT_PROMO_TEMPLATE,
		intro: `${DEFAULT_PROMO_TEMPLATE.intro}\nJoin: {joinLink}`,
		channels: {
			whatsapp: { intro: true, whyJoin: true, callToAction: true },
			email: { intro: true, whyJoin: true, callToAction: true },
			flyer: { intro: true, whyJoin: true, callToAction: true },
		},
	};
	const withLink = promoValues(CLUB, { ...MEETING, joinLink: ROOM }, ORIGIN);

	it("the seeded default does not place it", () => {
		const text = JSON.stringify(DEFAULT_PROMO_TEMPLATE);
		expect(text).not.toContain("joinLink");
		expect(buildWhatsAppBlast(DEFAULT_PROMO_TEMPLATE, withLink)).not.toContain(
			ROOM,
		);
	});

	it("a template that places it gets the link in WhatsApp and email", () => {
		expect(buildWhatsAppBlast(optIn, withLink)).toContain(`Join: ${ROOM}`);
		expect(buildEmailBlast(optIn, withLink).text).toContain(`Join: ${ROOM}`);
	});

	it("a meeting with no link drops the line", () => {
		const none = promoValues(CLUB, { ...MEETING, joinLink: null }, ORIGIN);
		expect(buildWhatsAppBlast(optIn, none)).not.toContain("Join:");
		expect(templateWarnings(optIn)).toEqual([]);
	});

	it("the flyer never prints it, even when handed values that carry it", () => {
		const flyer = JSON.stringify(buildFlyerContent(optIn, withLink));
		expect(flyer).not.toContain(ROOM);
		expect(flyer).not.toContain("Join:");
	});

	it("the flyer projection drops it", () => {
		const projected = projectFlyerMeeting({
			...MEETING,
			joinLink: ROOM,
			id: "m1",
			status: "scheduled",
		} as PublicFlyerMeeting);
		expect(JSON.stringify(projected)).not.toContain(ROOM);
	});
});

describe("buildWhatsAppBlast", () => {
	const msg = buildWhatsAppBlast(DEFAULT_PROMO_TEMPLATE, values());

	it("bolds the headline with WhatsApp's own markup", () => {
		expect(msg.split("\n")[0]).toBe(
			"*You're invited to Toastmasters: Downtown Speakers, Thursday, October 1*",
		);
	});

	it("ends on the RSVP and agenda links, not the bare meeting page", () => {
		expect(msg.endsWith(`\n\n${FOOTER}`)).toBe(true);
		expect(msg.split("\n")).not.toContain(LINK);
	});

	it("appends no link lines when the origin is not known yet", () => {
		const noOrigin = buildWhatsAppBlast(
			DEFAULT_PROMO_TEMPLATE,
			promoValues(CLUB, MEETING, ""),
		);
		expect(noOrigin).not.toContain("RSVP:");
		expect(noOrigin).not.toContain("Agenda:");
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

	it("the default fills most of the soft limit, so the limit is not slack", () => {
		// 678 characters with every optional line filled. Pins that the limit
		// was raised for the second link, not loosened past what the default
		// needs: a cut of the limit below the default fails the test above.
		expect(msg.length).toBeGreaterThan(600);
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
			`*You're invited to Toastmasters: Downtown Speakers, Thursday, October 1*\n\n${FOOTER}`,
		);
	});
});

describe("buildEmailBlast", () => {
	const email = buildEmailBlast(DEFAULT_PROMO_TEMPLATE, values());

	it("uses the headline as a one-line subject", () => {
		expect(email.subject).toBe(
			"You're invited to Toastmasters: Downtown Speakers, Thursday, October 1",
		);
	});

	it("ends the body on the RSVP and agenda links", () => {
		expect(email.text.endsWith(FOOTER)).toBe(true);
		expect(email.html).toContain(
			`<p>RSVP: <a href="${RSVP}">${RSVP}</a><br>Agenda: <a href="${AGENDA}">${AGENDA}</a></p>`,
		);
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

	it("appends no RSVP or agenda lines beside it", () => {
		expect(buildWhatsAppBlast(t, values())).not.toContain("RSVP: ");
		expect(buildEmailBlast(t, values()).html).not.toContain("Agenda: <a");
	});

	it("a toggled-OFF part does not count as placing it", () => {
		const off: PromoTemplate = {
			...t,
			channels: {
				...t.channels,
				whatsapp: { ...t.channels.whatsapp, callToAction: false },
			},
		};
		const msg = buildWhatsAppBlast(off, values());
		expect(msg.endsWith(FOOTER)).toBe(true);
		// Each link once: the footer's, and no bare meeting-page line.
		expect(msg.split(RSVP).length - 1).toBe(1);
		expect(msg.split(AGENDA).length - 1).toBe(1);
		expect(msg.split("\n")).not.toContain(LINK);
	});

	it("the default template does not place it, so the footer is appended (control)", () => {
		expect(buildWhatsAppBlast(DEFAULT_PROMO_TEMPLATE, values())).toContain(
			FOOTER,
		);
		expect(buildEmailBlast(DEFAULT_PROMO_TEMPLATE, values()).text).toContain(
			FOOTER,
		);
	});
});

describe("a template that places {rsvpLink} or {agendaLink} itself", () => {
	const count = (s: string, link: string) => s.split(link).length - 1;

	it("each link appears once, and only the unplaced one is appended", () => {
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			callToAction: "Save your seat: {rsvpLink}",
		};
		const msg = buildWhatsAppBlast(t, values());
		const email = buildEmailBlast(t, values());
		expect(msg).toContain(`Save your seat: ${RSVP}`);
		expect(msg).not.toContain("RSVP: ");
		expect(msg.endsWith(`Agenda: ${AGENDA}`)).toBe(true);
		expect(count(email.text, RSVP)).toBe(1);
		expect(email.text.endsWith(`Agenda: ${AGENDA}`)).toBe(true);
		expect(email.html).toContain(
			`<p>Agenda: <a href="${AGENDA}">${AGENDA}</a></p>`,
		);
		expect(email.html).not.toContain("<br>Agenda");
		expect(count(email.html, `RSVP: <a`)).toBe(0);
	});

	it("placing only {agendaLink} appends only the RSVP line", () => {
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			callToAction: "See the agenda: {agendaLink}",
		};
		const msg = buildWhatsAppBlast(t, values());
		const email = buildEmailBlast(t, values());
		expect(count(msg, AGENDA)).toBe(1);
		expect(msg).not.toContain("Agenda: ");
		expect(msg.endsWith(`RSVP: ${RSVP}`)).toBe(true);
		expect(email.text.endsWith(`RSVP: ${RSVP}`)).toBe(true);
		expect(email.html).toContain(`<p>RSVP: <a href="${RSVP}">${RSVP}</a></p>`);
	});

	it("placing both appends nothing", () => {
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			callToAction: "RSVP {rsvpLink} · agenda {agendaLink}",
		};
		const msg = buildWhatsAppBlast(t, values());
		expect(count(msg, RSVP)).toBe(1);
		expect(count(msg, AGENDA)).toBe(1);
		expect(msg.endsWith("agenda " + AGENDA)).toBe(true);
	});

	it("a placed link in the email SUBJECT still appends it to the body", () => {
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			headline: "RSVP {rsvpLink}",
		};
		expect(buildEmailBlast(t, values()).text.endsWith(FOOTER)).toBe(true);
	});
});

// ─── #1535: variable metadata, aliases, line rendering, suggestions, blocks ───
//
// Each test states its card: protects=<observable>; fails_when=<wrong result>;
// no_claim=<what green does not prove>.

const TEMPLATE_FIXTURES = [
	"{club} meets {date} at {time}",
	"Theme: {theme}\nWhere: {location}",
	"Hello\n{note}\nBye",
	"A\n\n\nTheme: {theme}\n\n\nB",
	"Typo {thme} stays; {Word of Day} too",
	"{wordOfTheDay} and {meetingNumber}\n   \n{online}",
	"line one  \r\nline two {clubLink}",
	...Object.values({
		headline: DEFAULT_PROMO_TEMPLATE.headline,
		intro: DEFAULT_PROMO_TEMPLATE.intro,
		cta: DEFAULT_PROMO_TEMPLATE.callToAction,
	}),
	...DEFAULT_PROMO_TEMPLATE.whyJoin,
];

describe("PROMO_VARIABLES", () => {
	it("derives the 14 placeholders in table order, groups contiguous in menu order", () => {
		// protects=PROMO_PLACEHOLDERS is exactly the variable keys, in order;
		// fails_when=a key is added to one list and not the other, or reordered;
		// no_claim=that every caller's switch over keys handles the new key.
		expect(PROMO_PLACEHOLDERS).toEqual(PROMO_VARIABLES.map((v) => v.key));
		expect(PROMO_PLACEHOLDERS).toHaveLength(14);
		const groupOrder = PROMO_VARIABLE_GROUPS.map((g) => g.id);
		const seen = PROMO_VARIABLES.map((v) => v.group).filter(
			(g, i, all) => all.indexOf(g) === i,
		);
		expect(seen).toEqual(groupOrder);
		const lastIndex = (g: string) =>
			PROMO_VARIABLES.map((v) => v.group).lastIndexOf(g as never);
		const firstIndex = (g: string) =>
			PROMO_VARIABLES.map((v) => v.group).indexOf(g as never);
		for (const g of groupOrder) {
			expect(lastIndex(g) - firstIndex(g) + 1).toBe(
				PROMO_VARIABLES.filter((v) => v.group === g).length,
			);
		}
	});

	it("gives every row a non-empty label and description, and unique keys", () => {
		// protects=the menu never shows a blank row; fails_when=a label or
		// description is "" or a key repeats; no_claim=the copy reads well.
		for (const v of PROMO_VARIABLES) {
			expect(v.label.trim()).not.toBe("");
			expect(v.description.trim()).not.toBe("");
		}
		expect(new Set(PROMO_VARIABLES.map((v) => v.key)).size).toBe(
			PROMO_VARIABLES.length,
		);
	});

	it("has unique normalised labels, none equal to another variable's normalised key", () => {
		// protects=an alias always names exactly one variable; fails_when=two
		// labels, or one label and another variable's key, normalise alike;
		// no_claim=that a label is unambiguous to a human.
		const labels = PROMO_VARIABLES.map((v) => normalizePromoName(v.label));
		expect(new Set(labels).size).toBe(labels.length);
		for (const v of PROMO_VARIABLES) {
			for (const other of PROMO_VARIABLES) {
				if (other.key === v.key) continue;
				expect(normalizePromoName(v.label)).not.toBe(
					normalizePromoName(other.key),
				);
			}
			// A label is never a canonical key, so toEditorText is idempotent.
			expect(PROMO_PLACEHOLDERS).not.toContain(v.label);
		}
	});
});

describe("rsvpPageUrl", () => {
	it("is what promoRsvpPath is built on", () => {
		// protects=one definition of "/rsvp"; fails_when=promoRsvpPath appends it
		// itself again and the two drift; no_claim=the route exists (typed above).
		expect(rsvpPageUrl("/club/a/meeting/b")).toBe("/club/a/meeting/b/rsvp");
		expect(promoRsvpPath("a", "b")).toBe(rsvpPageUrl("/club/a/meeting/b"));
	});
});

describe("toEditorText / toStoredText", () => {
	it("shows a stored key as its label and stores the label back", () => {
		// protects=the editor's friendly face; fails_when=the label is wrong or the
		// stored form is not restored; no_claim=pills render at the right width.
		expect(toEditorText("{wordOfTheDay} at {time}")).toBe(
			"{Word of the Day} at {Time}",
		);
		expect(toStoredText("{Word of the Day} at {Time}")).toBe(
			"{wordOfTheDay} at {time}",
		);
	});

	it("stores every spelling of a variable as its key", () => {
		// protects=pasted and hand-typed tokens normalise; fails_when=any spelling
		// is left as typed; no_claim=single-word look-alikes like {DATE} (below).
		for (const t of [
			"{WORD OF THE DAY}",
			"{ word of the day }",
			"{Word of the Day}",
			"{wordOfTheDay}",
			"{ Word  of the Day! }",
		]) {
			expect(toStoredText(t)).toBe("{wordOfTheDay}");
		}
	});

	it("leaves a near miss as typed, in both directions", () => {
		// protects=a typo is never silently rewritten; fails_when={Word of Day} is
		// converted; no_claim=that it is flagged (unknownPlaceholders does that).
		expect(toStoredText("{Word of Day}")).toBe("{Word of Day}");
		expect(toEditorText("{Word of Day}")).toBe("{Word of Day}");
		expect(toEditorText("{nope} {Date}")).toBe("{nope} {Date}");
	});

	it("converts canonical keys only when loading: {DATE} and {Date!} stay literal", () => {
		// protects=a stored template never changes meaning on load; fails_when=
		// toEditorText rewrites a token the renderer treats as a literal;
		// no_claim=the editor's Fix prompt (second issue).
		expect(toEditorText("{DATE}")).toBe("{DATE}");
		expect(toEditorText("{Date!}")).toBe("{Date!}");
		const stored = "On {DATE}, {Date!} and {date}";
		expect(toEditorText(stored)).toBe("On {DATE}, {Date!} and {Date}");
	});

	it("round-trips every default-template field", () => {
		// protects=the editor never starts dirty on a default template;
		// fails_when=a field changes through the pair; no_claim=non-canonical
		// multi-word look-alikes: {word of the day} stored is read as typed text
		// by toEditorText and stored as {wordOfTheDay} (reported in the PR).
		const fields = [
			DEFAULT_PROMO_TEMPLATE.headline,
			DEFAULT_PROMO_TEMPLATE.intro,
			DEFAULT_PROMO_TEMPLATE.callToAction,
			...DEFAULT_PROMO_TEMPLATE.whyJoin,
			"On {DATE}, {Date!}, {nope} and {date}",
		];
		for (const f of fields) {
			expect(toStoredText(toEditorText(f))).toBe(f);
		}
	});

	it("stores a literal exact label or padded name as its key: the documented exception", () => {
		// protects=the exception in the module header; fails_when=an exact label
		// or padded key stops converting, or a literal that is not one starts to;
		// no_claim=that the old editor's "Not a placeholder" flag still shows.
		expect(toStoredText(toEditorText("{Date}"))).toBe("{date}");
		expect(toStoredText(toEditorText("{Time}"))).toBe("{time}");
		expect(toStoredText(toEditorText("{ date }"))).toBe("{date}");
	});

	it("round-trips every other stored token unchanged", () => {
		// protects=the rule that only exact labels and padded names convert;
		// fails_when={DATE}, {Date!}, {nope}, a canonical key or plain text changes
		// through the pair; no_claim=the exception above.
		const stored =
			"Plain text. {DATE} {Date!} {nope} {wordOfTheDay} {date} end";
		expect(toStoredText(toEditorText(stored))).toBe(stored);
	});

	it("is idempotent in both directions", () => {
		// protects=applying a conversion twice is harmless; fails_when=a second
		// pass changes the text; no_claim=nothing about unbalanced braces.
		for (const f of TEMPLATE_FIXTURES) {
			expect(toEditorText(toEditorText(f))).toBe(toEditorText(f));
			expect(toStoredText(toStoredText(f))).toBe(toStoredText(f));
		}
	});
});

describe("the token regex", () => {
	it("flags a token with spaces as unknown, and renders it as typed", () => {
		// protects=a spaced typo is no longer invisible; fails_when={Word of Day}
		// is missing from the warnings or is blanked in the output;
		// no_claim=anything about nested braces.
		expect(unknownPlaceholders("{Word of Day}")).toEqual(["Word of Day"]);
		expect(renderPromoText("x {Word of Day} y", values())).toBe(
			"x {Word of Day} y",
		);
		expect(unknownPlaceholders("{ date }")).toEqual([" date "]);
	});
});

describe("renderPromoLines", () => {
	it("returns one entry per source line, blanks included, nothing trimmed away", () => {
		// protects=the preview can lay out every line; fails_when=a blank line or a
		// dropped line is missing; no_claim=CRLF handling beyond splitting.
		const lines = renderPromoLines("A\n\nB\r\nC", values());
		expect(lines.map((l) => l.source)).toEqual(["A", "", "B", "C"]);
		expect(lines.every((l) => l.droppedBy === null)).toBe(true);
	});

	it("keeps a filled line with its rendered text", () => {
		// protects=kept lines carry rendered text and no reason; fails_when=text is
		// the source or droppedBy is set; no_claim=trailing whitespace on the source.
		expect(renderPromoLines("When: {date}  ", values())).toEqual([
			{
				source: "When: {date}  ",
				text: "When: Thursday, October 1",
				droppedBy: null,
			},
		]);
	});

	it("drops a line holding an empty placeholder and names the FIRST empty one", () => {
		// protects=the preview's "hidden: no Theme set" reason; fails_when=the
		// wrong placeholder is named or the text survives; no_claim=that the
		// reason reads well in the UI.
		const v = values({ theme: null, wordOfTheDay: null });
		expect(renderPromoLines("{wordOfTheDay} / {theme}", v)).toEqual([
			{
				source: "{wordOfTheDay} / {theme}",
				text: "",
				droppedBy: "wordOfTheDay",
			},
		]);
		expect(renderPromoLines("Theme: {theme}", v)[0].droppedBy).toBe("theme");
	});

	it("does not drop a line for an unknown placeholder", () => {
		// protects=a typo stays visible; fails_when=an unknown token drops its line;
		// no_claim=nothing about the warning.
		expect(renderPromoLines("{thme}", values())[0]).toMatchObject({
			text: "{thme}",
			droppedBy: null,
		});
	});

	it("renderPromoText is the collapse-and-trim of the kept lines, for every fixture", () => {
		// protects=the string renderer and the line renderer cannot disagree;
		// fails_when=either changes alone; no_claim=that the collapse rule is the
		// right one (the older tests pin that).
		const empties = [
			values(),
			values({ theme: null, promoNote: null, location: null }),
			promoValues(CLUB, MEETING, ""),
		];
		for (const t of TEMPLATE_FIXTURES) {
			for (const v of empties) {
				const kept: string[] = [];
				for (const l of renderPromoLines(t, v)) {
					if (l.droppedBy !== null) continue;
					if (
						!l.text.trim() &&
						kept.length > 0 &&
						!kept[kept.length - 1].trim()
					)
						continue;
					kept.push(l.text);
				}
				expect(renderPromoText(t, v)).toBe(kept.join("\n").trim());
			}
		}
	});
});

describe("suggestPlaceholder", () => {
	it("repairs a typo by edit distance (insert, delete, substitute, transposition)", () => {
		// protects=the "Did you mean" Fix for one-slip typos, each OSA operation;
		// fails_when=any operation costs more than 1 or the threshold is off;
		// no_claim=ranking among equally-close candidates beyond table order.
		expect(suggestPlaceholder("date")?.key).toBe("date"); // identity
		expect(suggestPlaceholder("daet")?.key).toBe("date"); // transposition
		expect(suggestPlaceholder("tiem")?.key).toBe("time");
		expect(suggestPlaceholder("locaton")?.key).toBe("location"); // insert
		expect(suggestPlaceholder("datee")?.key).toBe("date"); // delete
		expect(suggestPlaceholder("themx")?.key).toBe("theme"); // substitute
	});

	it("allows two edits for a longer name, one for a short one", () => {
		// protects=the threshold; fails_when=it is raised or lowered by one;
		// no_claim=that it never over-suggests for 5-character names.
		expect(suggestPlaceholder("locatn")?.key).toBe("location"); // 2 edits
		expect(suggestPlaceholder("dxxe")).toBeNull(); // 2 edits, 4 chars
		expect(suggestPlaceholder("themme")?.key).toBe("theme");
		expect(suggestPlaceholder("thmmmx")).toBeNull(); // 3 edits
	});

	it("matches a label's words as a subsequence", () => {
		// protects=dropped small words are forgiven; fails_when=Word of Day misses
		// Word of the Day; no_claim=that every shortened label is found.
		expect(suggestPlaceholder("wordOfDay")?.label).toBe("Word of the Day");
		expect(suggestPlaceholder("Word of Day")?.label).toBe("Word of the Day");
	});

	it("matches by containment when exactly one variable fits", () => {
		// protects=rsvp finds RSVP link, clubname finds Club name;
		// fails_when=containment is dropped; no_claim=the 4-character floor.
		expect(suggestPlaceholder("rsvp")?.label).toBe("RSVP link");
		expect(suggestPlaceholder("clubname")?.label).toBe("Club name");
	});

	it("says nothing when the name is ambiguous or unrelated", () => {
		// protects=no wrong guess offered; fails_when=meeting or link picks one of
		// several; no_claim=that a null always means "no variable was meant".
		expect(suggestPlaceholder("meeting")).toBeNull();
		expect(suggestPlaceholder("link")).toBeNull();
		expect(suggestPlaceholder("xyz")).toBeNull();
		expect(suggestPlaceholder("")).toBeNull();
		expect(suggestPlaceholder("!!")).toBeNull();
	});

	it("prefers the closer variable, then table order", () => {
		// protects=a stable pick; fails_when=a farther match beats an exact one;
		// no_claim=nothing about equal-distance ties between non-adjacent rows.
		expect(suggestPlaceholder("Date")?.key).toBe("date");
		expect(suggestPlaceholder("meetinglink")?.key).toBe("meetingLink");
	});
});

describe("examplePromoMeeting", () => {
	const example = (now: string, tz: string) => {
		const m = examplePromoMeeting(new Date(now), tz);
		return { m, v: promoValues({ ...CLUB, timezone: tz }, m, ORIGIN) };
	};

	it("fills every value", () => {
		// protects=the preview and the menu have something to show for every
		// variable; fails_when=any value is empty; no_claim=origin "" (links drop).
		const { v } = example("2026-11-06T15:00:00Z", "America/Chicago");
		for (const key of PROMO_PLACEHOLDERS) expect(v[key]).not.toBe("");
	});

	it("is 14 calendar days out at 7:00 PM local, across a spring-forward", () => {
		// protects=calendar arithmetic in the zone; fails_when=+14*24h lands at
		// 6:00 or 8:00 PM; no_claim=zones with a transition at 19:00.
		const { v } = example("2026-03-01T12:00:00Z", "America/Los_Angeles");
		expect(v.date).toBe("Sunday, March 15");
		expect(v.time).toBe("7:00 PM");
	});

	it("uses the zone's date for 'today', not UTC's, and survives fall-back", () => {
		// protects=a late-evening club still counts its own day; fails_when=UTC's
		// date is used; no_claim=a southern-hemisphere zone.
		// 2026-03-02T03:00Z is still Mar 1 19:00 in Los Angeles.
		const west = example("2026-03-02T03:00:00Z", "America/Los_Angeles");
		expect(west.v.date).toBe("Sunday, March 15");
		expect(west.v.time).toBe("7:00 PM");
		const chicago = example("2026-10-28T12:00:00Z", "America/Chicago");
		expect(chicago.v.date).toBe("Wednesday, November 11");
		expect(chicago.v.time).toBe("7:00 PM");
	});

	it("carries the fixed example content", () => {
		// protects=the copy the maintainer specified; fails_when=a field drifts;
		// no_claim=the copy reads well.
		const { m } = example("2026-11-06T15:00:00Z", "America/Chicago");
		expect(m).toMatchObject({
			id: "example",
			urlKey: "example",
			online: true,
			theme: "Gratitude",
			wordOfTheDay: "Serendipity",
			meetingNumber: 412,
			location: "Community Hall, Room 2",
			promoNote: "Open house: bring a friend",
		});
	});
});

const kinds = (b: { kind: string }[]) => b.map((x) => x.kind);

describe("channel blocks", () => {
	it("WhatsApp: headline, intro, whyJoin, callToAction, footer, each with its kind", () => {
		// protects=the block order the preview renders; fails_when=a block is
		// missing or out of order; no_claim=the string form (older tests).
		expect(
			kinds(buildWhatsAppBlocks(DEFAULT_PROMO_TEMPLATE, values())),
		).toEqual(["headline", "intro", "whyJoin", "callToAction", "footer"]);
	});

	it("honours the channel's part toggles and omits an empty footer", () => {
		// protects=toggled-off parts are absent; fails_when=a disabled part shows;
		// no_claim=toggle UI.
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			channels: {
				...DEFAULT_PROMO_TEMPLATE.channels,
				email: { intro: false, whyJoin: false, callToAction: true },
			},
		};
		expect(kinds(buildEmailBlocks(t, values()).blocks)).toEqual([
			"callToAction",
			"footer",
		]);
		expect(
			kinds(buildWhatsAppBlocks(t, promoValues(CLUB, MEETING, ""))),
		).not.toContain("footer");
	});

	it("keeps a dropped line in its block with the placeholder that dropped it", () => {
		// protects=the preview can strike a dropped line in every channel;
		// fails_when=a dropped line disappears from a block; no_claim=the strike.
		const v = values({ theme: null });
		const hasDropped = (blocks: { lines: { droppedBy: unknown }[] }[]) =>
			blocks.some((b) => b.lines.some((l) => l.droppedBy === "theme"));
		expect(hasDropped(buildWhatsAppBlocks(DEFAULT_PROMO_TEMPLATE, v))).toBe(
			true,
		);
		expect(hasDropped(buildEmailBlocks(DEFAULT_PROMO_TEMPLATE, v).blocks)).toBe(
			true,
		);
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			channels: {
				...DEFAULT_PROMO_TEMPLATE.channels,
				flyer: { intro: true, whyJoin: true, callToAction: true },
			},
		};
		expect(hasDropped(buildFlyerBlocks(t, v))).toBe(true);
	});

	it("carries a dropped headline's reason in the email subject lines", () => {
		// protects=the subject is explainable; fails_when=subject loses droppedBy;
		// no_claim=a blank subject is refused anywhere.
		const t: PromoTemplate = { ...DEFAULT_PROMO_TEMPLATE, headline: "{theme}" };
		const { subject } = buildEmailBlocks(t, values({ theme: null }));
		expect(subject).toEqual([
			{ source: "{theme}", text: "", droppedBy: "theme" },
		]);
		expect(buildEmailBlast(t, values({ theme: null })).subject).toBe("");
	});

	it("puts the heading and bullet markers in the whyJoin block, only when a bullet is kept", () => {
		// protects=WHY_JOIN_HEADING and markers owned once; fails_when=a heading
		// stays over an all-dropped list; no_claim=email's "- " markers (below).
		const wa = buildWhatsAppBlocks(DEFAULT_PROMO_TEMPLATE, values()).find(
			(b) => b.kind === "whyJoin",
		);
		expect(wa?.lines[0].text).toBe("Why come?");
		expect(wa?.lines[1].text).toBe(`• ${DEFAULT_PROMO_TEMPLATE.whyJoin[0]}`);
		const em = buildEmailBlocks(DEFAULT_PROMO_TEMPLATE, values()).blocks.find(
			(b) => b.kind === "whyJoin",
		);
		expect(em?.lines[1].text).toBe(`- ${DEFAULT_PROMO_TEMPLATE.whyJoin[0]}`);
		const dropped: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			whyJoin: ["{theme}", "{theme} again"],
		};
		const none = buildWhatsAppBlocks(dropped, values({ theme: null })).find(
			(b) => b.kind === "whyJoin",
		);
		expect(none?.lines.map((l) => l.droppedBy)).toEqual(["theme", "theme"]);
		expect(none?.lines.map((l) => l.text).join("")).toBe("");
	});

	it("derives the three blast strings from the blocks", () => {
		// protects=one owner for the channel rules; fails_when=the strings differ
		// from the blocks' kept lines; no_claim=the exact copy (older tests).
		const t = DEFAULT_PROMO_TEMPLATE;
		const keptText = (
			blocks: { lines: { droppedBy: unknown; text: string }[] }[],
		) =>
			blocks
				.flatMap((b) => b.lines)
				.filter((l) => l.droppedBy === null)
				.map((l) => l.text)
				.filter(Boolean)
				.join("\n");
		const wa = buildWhatsAppBlast(t, values()).replace(/\n\n/g, "\n");
		expect(wa.replace(/\*/g, "")).toBe(
			keptText(buildWhatsAppBlocks(t, values())),
		);
		const email = buildEmailBlast(t, values());
		expect(email.text.replace(/\n\n/g, "\n")).toBe(
			keptText(buildEmailBlocks(t, values()).blocks),
		);
		const flyer = buildFlyerContent(t, values());
		expect(flyer.headline).toBe(buildFlyerBlocks(t, values())[0].lines[0].text);
		expect(flyer.whyJoin).toEqual(t.whyJoin);
	});

	it("flyer blocks are headline plus the toggled fields, with no footer", () => {
		// protects=the flyer's four fields per its toggles; fails_when=a footer or
		// a disabled intro appears; no_claim=the QR code.
		expect(kinds(buildFlyerBlocks(DEFAULT_PROMO_TEMPLATE, values()))).toEqual([
			"headline",
			"whyJoin",
			"callToAction",
		]);
	});
});

describe("link footer, decided from the KEPT lines", () => {
	const dropsItsLink: PromoTemplate = {
		...DEFAULT_PROMO_TEMPLATE,
		intro: "Theme: {theme}, details at {meetingLink}",
	};

	it("a link placed only on a line that drops still gets the footer, in WhatsApp and email", () => {
		// protects=the message never goes out with no link (the #1531 hole);
		// fails_when=the footer is suppressed by an unrendered {meetingLink};
		// no_claim=the officer is told the line dropped (the preview does that).
		const v = values({ theme: null });
		const msg = buildWhatsAppBlast(dropsItsLink, v);
		expect(msg).not.toContain("details at");
		expect(msg.endsWith(FOOTER)).toBe(true);
		const email = buildEmailBlast(dropsItsLink, v);
		expect(email.text.endsWith(FOOTER)).toBe(true);
		expect(email.html).toContain(`RSVP: <a href="${RSVP}">`);
	});

	it("the same line, kept, still suppresses the whole footer", () => {
		// protects=#1531's rule where it was right; fails_when=a kept
		// {meetingLink} still gets a footer; no_claim=anything about {clubLink}.
		const blocks = buildWhatsAppBlocks(dropsItsLink, values());
		expect(kinds(blocks)).not.toContain("footer");
		expect(buildWhatsAppBlast(dropsItsLink, values())).toContain(
			`details at ${LINK}`,
		);
		expect(buildEmailBlast(dropsItsLink, values()).text).not.toContain("RSVP:");
	});

	it("a kept RSVP link is not mistaken for the meeting link it starts with", () => {
		// protects=placing {rsvpLink} still appends the agenda; fails_when=the
		// meeting URL's prefix match hides the footer; no_claim=query strings.
		const t: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			callToAction: "RSVP here: {rsvpLink}",
		};
		const footer = buildWhatsAppBlocks(t, values()).find(
			(b) => b.kind === "footer",
		);
		expect(footer?.lines.map((l) => l.text)).toEqual([`Agenda: ${AGENDA}`]);
	});
});

describe("templatesEqual", () => {
	it("is true for a copy with its keys in another order", () => {
		// protects=Discard changes hides when nothing changed; fails_when=key order
		// matters; no_claim=deep equality of unknown extra keys (zod strips them).
		const reordered: PromoTemplate = {
			channels: {
				flyer: { callToAction: true, whyJoin: true, intro: false },
				email: { callToAction: true, whyJoin: true, intro: true },
				whatsapp: { callToAction: true, whyJoin: true, intro: true },
			},
			callToAction: DEFAULT_PROMO_TEMPLATE.callToAction,
			whyJoin: [...DEFAULT_PROMO_TEMPLATE.whyJoin],
			intro: DEFAULT_PROMO_TEMPLATE.intro,
			headline: DEFAULT_PROMO_TEMPLATE.headline,
		};
		expect(JSON.stringify(reordered)).not.toBe(
			JSON.stringify(DEFAULT_PROMO_TEMPLATE),
		);
		expect(templatesEqual(reordered, DEFAULT_PROMO_TEMPLATE)).toBe(true);
	});

	it("is false when any one field, bullet or toggle differs", () => {
		// protects=every field is compared; fails_when=a field is skipped;
		// no_claim=trimmed or case-folded comparison (it is exact).
		const base = DEFAULT_PROMO_TEMPLATE;
		const variants: PromoTemplate[] = [
			{ ...base, headline: `${base.headline}!` },
			{ ...base, intro: `${base.intro}!` },
			{ ...base, callToAction: `${base.callToAction}!` },
			{ ...base, whyJoin: base.whyJoin.slice(1) },
			{ ...base, whyJoin: [`${base.whyJoin[0]}!`, ...base.whyJoin.slice(1)] },
		];
		for (const c of ["whatsapp", "email", "flyer"] as const) {
			for (const p of ["intro", "whyJoin", "callToAction"] as const) {
				variants.push({
					...base,
					channels: {
						...base.channels,
						[c]: { ...base.channels[c], [p]: !base.channels[c][p] },
					},
				});
			}
		}
		for (const v of variants) expect(templatesEqual(v, base)).toBe(false);
	});
});
