/**
 * A guest's kind caption on the agenda strings (#1059): "Guest speaker,
 * Downtown Toastmasters" in place of the "· Guest" marker, wherever a guest
 * holds a role — and a Visitor, or a guest with no kind stored, reading exactly
 * as before.
 */
import { describe, expect, it } from "vitest";
import {
	assigneeDisplayName,
	buildRosterEntries,
	GUEST_MARKER,
	guestCaptionStart,
} from "./agenda";
import {
	type AgendaSlot,
	assigneeDisplay,
	buildRunOfShow,
	expandRunSheet,
} from "./agenda-runsheet";
import { guestKindCaption } from "./guest-profile";

const SPEAKER_CAPTION = guestKindCaption(
	"guest_speaker",
	"Downtown Toastmasters",
);

function slot(over: Partial<AgendaSlot>): AgendaSlot & { category: "speaker" } {
	return {
		id: "sp",
		roleKey: "speaker",
		roleName: "Speaker",
		isSpeakerRole: true,
		slotIndex: 0,
		assigneeName: "Ben Carter",
		assigneeIsGuest: true,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
		category: "speaker",
	};
}

describe("assigneeDisplayName with a guest caption", () => {
	it("puts the caption in the marker's place", () => {
		expect(assigneeDisplayName("Ben Carter", true, SPEAKER_CAPTION)).toBe(
			"Ben Carter · Guest speaker, Downtown Toastmasters",
		);
	});

	it("keeps today's marker for a Visitor and for a guest with no caption", () => {
		const visitor = guestKindCaption("visitor", "Leftover Club");
		expect(visitor).toBeNull();
		for (const caption of [visitor, null, undefined])
			expect(assigneeDisplayName("Ben Carter", true, caption)).toBe(
				`Ben Carter · ${GUEST_MARKER}`,
			);
	});

	it("collapses a home club's line breaks to one line", () => {
		expect(
			assigneeDisplayName(
				"Ben Carter",
				true,
				guestKindCaption("guest_speaker", "Downtown\n\tToastmasters\n#12"),
			),
		).toBe("Ben Carter · Guest speaker, Downtown Toastmasters #12");
	});

	it("ignores a caption on a member's slot, and an open slot stays open", () => {
		expect(assigneeDisplayName("Ann Lee", false, SPEAKER_CAPTION)).toBe(
			"Ann Lee",
		);
		expect(assigneeDisplayName(null, true, SPEAKER_CAPTION)).toBeNull();
	});
});

describe("the caption on every agenda surface", () => {
	const guest = slot({ assigneeGuestCaption: SPEAKER_CAPTION });
	const expected = "Ben Carter · Guest speaker, Downtown Toastmasters";

	it("reaches the roster", () => {
		expect(buildRosterEntries([guest])[0]?.name).toBe(expected);
	});

	it("reaches the run sheet's row and the slides' assignee", () => {
		expect(assigneeDisplay(guest)).toBe(expected);
		const row = expandRunSheet(
			[guest],
			buildRunOfShow({ geIntroducesFunctionaries: false }),
		).find((r) => r.slotId === "sp");
		expect(row?.who).toBe(`Speaker · ${expected}`);
		expect(row?.holder).toBe(expected);
	});

	it("leaves a Visitor's row exactly as today", () => {
		const visitor = slot({ assigneeGuestCaption: null });
		const row = expandRunSheet(
			[visitor],
			buildRunOfShow({ geIntroducesFunctionaries: false }),
		).find((r) => r.slotId === "sp");
		expect(row?.who).toBe("Speaker · Ben Carter · Guest");
		expect(buildRosterEntries([visitor])[0]?.name).toBe("Ben Carter · Guest");
	});
});

describe("guestCaptionStart", () => {
	it("finds where the caption begins, for both captioned kinds", () => {
		const text = `Speaker 1 · ${assigneeDisplayName("Ben", true, SPEAKER_CAPTION)}`;
		expect(text.slice(guestCaptionStart(text))).toBe(
			" · Guest speaker, Downtown Toastmasters",
		);
		const visiting = assigneeDisplayName(
			"Ana",
			true,
			guestKindCaption("visiting_toastmaster", null),
		) as string;
		expect(visiting.slice(guestCaptionStart(visiting))).toBe(
			" · Visiting Toastmaster",
		);
	});

	it("finds nothing in a plain guest, a member, or a role name", () => {
		for (const text of [
			"Speaker 1 · Ben · Guest",
			"Timer · Ann Lee",
			"Guest speaker introduction",
		])
			expect(guestCaptionStart(text), text).toBe(-1);
	});
});
