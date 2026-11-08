import { describe, expect, it } from "vitest";
import {
	customTemplateFor,
	DEFAULT_GUEST_INVITE_TEMPLATES,
	exampleGuestInviteValues,
	GUEST_INVITE_LIMITS,
	GUEST_INVITE_VARIABLES,
	guestInviteTemplatesSchema,
	guestInviteValues,
	INVITE_KINDS,
	renderGuestInviteText,
	resolveGuestInviteTemplates,
} from "#/lib/guest-invite-template";
import { buildNudge } from "#/lib/nudge";
import {
	PROMO_VARIABLES,
	toEditorText,
	toStoredText,
} from "#/lib/promo-template";

const values = guestInviteValues({
	guestName: "Ada",
	clubName: "Downtown Club",
	meeting: {
		scheduledAt: new Date("2026-10-09T23:00:00Z"),
		location: " Room 4 ",
	},
	shareUrl: "https://gavelup.app/club/d/meeting/x",
	joinLink: null,
	guest: {
		inviteFirstVisitAt: new Date("2026-09-04T23:00:00Z"),
		lastVisitAt: new Date("2026-09-25T23:00:00Z"),
		inviteVisitCount: 2,
	},
	timeZone: "America/Chicago",
});

describe("resolveGuestInviteTemplates", () => {
	// protects=a saved template round-trips; fails_when=a valid value is discarded;
	// no_claim=says nothing about how the value is stored.
	it("keeps a valid stored value", () => {
		const stored = { lapsed: { body: "Hi {guestName}" } };
		expect(resolveGuestInviteTemplates(stored)).toEqual(stored);
	});

	// protects=the VP Membership page drafts with defaults on bad data;
	// fails_when=a wrong shape or an over-long body throws or is partly kept;
	// no_claim=none beyond protects.
	it("reads a value that fails the schema as {}", () => {
		for (const bad of [
			"text",
			42,
			[],
			{ lapsed: "x" },
			{ never: { body: "x".repeat(GUEST_INVITE_LIMITS.body + 1) } },
			{ never: { subject: "x".repeat(GUEST_INVITE_LIMITS.subject + 1) } },
			{ never: { subject: "a\nBcc: x@evil.com" } },
		]) {
			expect(resolveGuestInviteTemplates(bad)).toEqual({});
		}
		expect(resolveGuestInviteTemplates(null)).toEqual({});
	});
});

describe("resolveGuestInviteTemplates, per kind and field", () => {
	// protects=one bad field does not wipe the club's other saved drafts;
	// fails_when=the whole document collapses to {} when one kind is invalid;
	// no_claim=says nothing about what the editor does with the result.
	it("keeps the valid kinds and fields and drops only the invalid ones", () => {
		expect(
			resolveGuestInviteTemplates({
				never: { body: 42 },
				lapsed: { body: "Keep this" },
			}),
		).toEqual({ lapsed: { body: "Keep this" } });
		expect(
			resolveGuestInviteTemplates({
				never: { body: "x".repeat(GUEST_INVITE_LIMITS.body + 1), subject: "S" },
			}),
		).toEqual({ never: { subject: "S" } });
	});
});

describe("GUEST_INVITE_LIMITS", () => {
	// protects=the spec's ceilings (1000 body, 200 subject);
	// fails_when=either limit is raised or lowered, even together;
	// no_claim=does not check the stored column.
	it("is exactly 1000 for the body and 200 for the subject", () => {
		expect(GUEST_INVITE_LIMITS.body).toBe(1000);
		expect(GUEST_INVITE_LIMITS.subject).toBe(200);
	});
});

describe("the subject is one line", () => {
	// protects=a CR or LF cannot reach the mailto subject header;
	// fails_when=guestInviteTemplatesSchema accepts a newline in a subject;
	// no_claim=does not cover the body, which may span lines.
	it("rejects CR and LF in a subject but allows them in a body", () => {
		for (const bad of ["a\nb", "a\rb", "a\r\nb"]) {
			expect(
				guestInviteTemplatesSchema.safeParse({ never: { subject: bad } })
					.success,
			).toBe(false);
		}
		expect(
			guestInviteTemplatesSchema.safeParse({
				never: { subject: "One line", body: "a\nb" },
			}).success,
		).toBe(true);
	});
});

describe("customTemplateFor", () => {
	const kind = "lapsed";
	// protects=unset/blank/default fields keep the hard-coded bytes;
	// fails_when=any of the three is returned as a custom template;
	// no_claim=does not check the stored column.
	it("is null when unset, blank after trim, or equal to the default", () => {
		expect(customTemplateFor({}, kind, "body")).toBeNull();
		expect(
			customTemplateFor({ lapsed: { body: " \n " } }, kind, "body"),
		).toBeNull();
		expect(
			customTemplateFor(
				{ lapsed: { body: DEFAULT_GUEST_INVITE_TEMPLATES.lapsed.body } },
				kind,
				"body",
			),
		).toBeNull();
		expect(
			customTemplateFor(
				{ lapsed: { subject: DEFAULT_GUEST_INVITE_TEMPLATES.lapsed.subject } },
				kind,
				"subject",
			),
		).toBeNull();
	});

	// protects=an edited field is used; fails_when=an edit is mistaken for the default;
	// no_claim=none beyond protects.
	it("returns the text when it differs from the default, per field", () => {
		const t = { lapsed: { body: "Miss you, {guestName}" } };
		expect(customTemplateFor(t, kind, "body")).toBe("Miss you, {guestName}");
		expect(customTemplateFor(t, kind, "subject")).toBeNull();
		expect(customTemplateFor(t, "never", "body")).toBeNull();
	});
});

describe("renderGuestInviteText", () => {
	// protects=acceptance 3: empty values vanish and no line is removed;
	// fails_when=a line holding an empty variable is dropped or collapsed;
	// no_claim=none beyond protects.
	it("renders an empty value as nothing and keeps every line", () => {
		const out = renderGuestInviteText("A {joinLink}\n\nB {lastVisit}.", {
			...values,
			joinLink: "",
			lastVisit: "",
		});
		expect(out).toBe("A \n\nB .");
	});

	// protects=decision A: an edited default with no venue reads like the built-in;
	// fails_when=", at ." (or ", at ") is left behind for an empty location, or the
	// clause collapses when a location IS set; no_claim=only the ", at {location}" clause collapses.
	it("collapses ', at {location}' only when the location is empty", () => {
		const now = new Date("2026-10-01T12:00:00Z");
		for (const kind of INVITE_KINDS) {
			const v = exampleGuestInviteValues(kind, now, "UTC");
			const bare = { ...v, location: "" };
			const rendered = renderGuestInviteText(
				DEFAULT_GUEST_INVITE_TEMPLATES[kind].body,
				bare,
			);
			expect(rendered).not.toContain(", at .");
			expect(rendered).not.toMatch(/, at\b/);
			const builtIn = buildNudge({
				mode: "invite",
				inviteKind: kind,
				name: "Alex",
				clubName: bare.club,
				meetingDate: bare.date,
				meetingTime: bare.time,
				location: "",
				shareUrl: bare.agendaLink,
			});
			expect(rendered).toBe(builtIn.message);
		}
		expect(
			renderGuestInviteText("Come {location}", { ...values, location: "" }),
		).toBe("Come ");
		expect(renderGuestInviteText("at 6, at {location}.", values)).toBe(
			"at 6, at Room 4.",
		);
	});

	// protects=a typo is visible to the officer; fails_when=an unknown token is
	// blanked or replaced; no_claim=does not prove the editor flags it.
	it("leaves an unknown token as typed", () => {
		expect(renderGuestInviteText("Hi {nope} {club} {Date}", values)).toBe(
			"Hi {nope} Downtown Club {Date}",
		);
	});

	// protects=stored text uses keys while the editor shows labels;
	// fails_when=a label reaches storage or the render, or a key is lost in the trip;
	// no_claim=only the ten guest variables.
	it("round-trips through the editor's labels for every variable", () => {
		const stored = GUEST_INVITE_VARIABLES.map((v) => `{${v.key}}`).join(" ");
		const editor = toEditorText(stored, GUEST_INVITE_VARIABLES);
		for (const v of GUEST_INVITE_VARIABLES)
			expect(editor).toContain(`{${v.label}}`);
		expect(toStoredText(editor, GUEST_INVITE_VARIABLES)).toBe(stored);
		expect(renderGuestInviteText(stored, values)).not.toMatch(/\{[a-zA-Z]+\}/);
	});
});

describe("GUEST_INVITE_VARIABLES", () => {
	// protects=acceptance 9 (exactly ten) and that shared keys read like Promote;
	// fails_when=a key is added, dropped, or a shared label drifts;
	// no_claim=does not render the menu.
	it("has the ten keys and shares Promote's labels", () => {
		expect(GUEST_INVITE_VARIABLES.map((v) => v.key).sort()).toEqual(
			[
				"agendaLink",
				"club",
				"date",
				"firstVisit",
				"guestName",
				"joinLink",
				"lastVisit",
				"location",
				"time",
				"visitCount",
			].sort(),
		);
		for (const v of GUEST_INVITE_VARIABLES) {
			const promo = PROMO_VARIABLES.find((p) => p.key === v.key);
			if (promo) expect(v.label).toBe(promo.label);
		}
	});
});

describe("guestInviteValues", () => {
	// protects=what a real draft fills in; fails_when=a value comes from the wrong
	// source (club tz, trimmed location, empty join link, instant-rule count);
	// no_claim=dates are asserted for one zone only.
	it("fills each value from its source", () => {
		expect(values).toEqual({
			guestName: "Ada",
			club: "Downtown Club",
			date: "Fri, Oct 9",
			time: "6:00 PM",
			location: "Room 4",
			agendaLink: "https://gavelup.app/club/d/meeting/x",
			joinLink: "",
			firstVisit: "Sep 4",
			lastVisit: "Sep 25",
			visitCount: "2",
		});
	});

	// protects=no visits means empty strings and "0"; fails_when=an Invalid Date
	// or "null" leaks; no_claim=none beyond protects.
	it("has empty visit fields and a zero count for a guest who never visited", () => {
		const v = exampleGuestInviteValues(
			"never",
			new Date("2026-10-01T12:00:00Z"),
			"UTC",
		);
		expect(v.firstVisit).toBe("");
		expect(v.lastVisit).toBe("");
		expect(v.visitCount).toBe("0");
	});
});

describe("exampleGuestInviteValues + the defaults", () => {
	// protects=the default templates stay faithful to the hard-coded texts, so the
	// editor's pre-fill reads like the real draft; fails_when=they drift apart;
	// no_claim=compared with a location set (the conditional clause is not a template).
	it("rendering each default template equals the hard-coded draft", () => {
		const now = new Date("2026-10-01T12:00:00Z");
		for (const kind of INVITE_KINDS) {
			const v = exampleGuestInviteValues(kind, now, "UTC");
			const real = buildNudge({
				mode: "invite",
				inviteKind: kind,
				name: "Alex",
				clubName: v.club,
				meetingDate: v.date,
				meetingTime: v.time,
				location: v.location,
				shareUrl: v.agendaLink,
			});
			expect(
				renderGuestInviteText(DEFAULT_GUEST_INVITE_TEMPLATES[kind].body, v),
			).toBe(real.message);
		}
	});

	// protects=the preview's example counts; fails_when=a kind gets the wrong count;
	// no_claim=none beyond protects.
	it("uses the documented visit counts", () => {
		const now = new Date("2026-10-01T12:00:00Z");
		expect(exampleGuestInviteValues("firstRecent", now, "UTC").visitCount).toBe(
			"1",
		);
		expect(
			exampleGuestInviteValues("repeatRecent", now, "UTC").visitCount,
		).toBe("3");
		expect(exampleGuestInviteValues("lapsed", now, "UTC").visitCount).toBe("2");
	});
});
