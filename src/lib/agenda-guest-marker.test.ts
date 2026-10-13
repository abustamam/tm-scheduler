/**
 * A guest's marker on the agenda strings (#151, #1208): "Name · Guest" wherever
 * a guest holds a role. There is no kind caption any more, so a visiting
 * Toastmaster and a Visitor are marked alike.
 */
import { describe, expect, it } from "vitest";
import {
	assigneeDisplayName,
	buildRosterEntries,
	GUEST_MARKER,
	OPEN_LABEL,
} from "#/lib/agenda";
import {
	type AgendaSlot,
	assigneeDisplay,
	buildRunOfShow,
	expandRunSheet,
} from "#/lib/agenda-runsheet";
import { GUEST_KIND_LABELS } from "#/lib/guest-profile";

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

describe("assigneeDisplayName", () => {
	// protects=a member's slot reads as the bare name, with no guest marker;
	// fails_when=a member is marked "· Guest", or the name is altered;
	// no_claim=none beyond protects.
	it("returns a member's name as it is", () => {
		expect(assigneeDisplayName("Ann Lee", false)).toBe("Ann Lee");
		expect(assigneeDisplayName("Ann Lee")).toBe("Ann Lee");
	});

	// protects=a guest (a Visitor, kind `visitor`) reads "Name · Guest";
	// fails_when=the marker is missing, reworded or separated differently;
	// no_claim=the kind is not a parameter: this does not prove which guest kinds
	// reach it, the loader integration test does.
	it("appends the Guest marker to a guest's name", () => {
		expect(assigneeDisplayName("Ben Carter", true)).toBe(
			`Ben Carter · ${GUEST_MARKER}`,
		);
		expect(GUEST_MARKER).toBe("Guest");
		// One word for the `visitor` kind everywhere it is labelled.
		expect(GUEST_MARKER).toBe(GUEST_KIND_LABELS.visitor);
	});

	// protects=a visiting Toastmaster, who is a guest with a home club, reads the
	// same "Name · Guest" as a Visitor, and a third argument (the old caption) is
	// no longer an input: nothing can put a club name next to the name;
	// fails_when=a caption such as "Visiting Toastmaster, <club>" or a caption
	// parameter comes back;
	// no_claim=the home club is not passed, so this proves the formatter, not the
	// loader that decides what to pass.
	it("marks a visiting Toastmaster exactly as a Visitor, whatever else is passed", () => {
		const call = assigneeDisplayName as (...a: unknown[]) => string | null;
		expect(call("Ana Ruiz", true, "Visiting Toastmaster, Downtown #12")).toBe(
			`Ana Ruiz · ${GUEST_MARKER}`,
		);
	});

	// protects=an open slot stays null so the caller shows "open", guest or not;
	// fails_when=an empty name is turned into " · Guest";
	// no_claim=none beyond protects.
	it("leaves an open slot null", () => {
		expect(assigneeDisplayName(null, true)).toBeNull();
		expect(assigneeDisplayName(null, false)).toBeNull();
	});
});

describe("the marker on every agenda surface", () => {
	const guest = slot({});
	const expected = "Ben Carter · Guest";

	// protects=the roster, the run sheet's row and holder and the slides'
	// assignee all carry the one string;
	// fails_when=a surface formats the guest itself, or drops the marker;
	// no_claim=in-memory slots stand in for what `loadMeetingSlots` returns.
	it("reaches the roster, the run sheet and the slides' assignee", () => {
		expect(buildRosterEntries([guest])[0]?.name).toBe(expected);
		expect(assigneeDisplay(guest)).toBe(expected);
		const row = expandRunSheet(
			[guest],
			buildRunOfShow({ geIntroducesFunctionaries: false }),
		).find((r) => r.slotId === "sp");
		expect(row?.who).toBe(`Speaker · ${expected}`);
		expect(row?.holder).toBe(expected);
	});

	// protects=an unassigned slot still prints the open placeholder;
	// fails_when=the guest flag on a nameless slot prints a marker;
	// no_claim=none beyond protects.
	it("keeps an open slot open", () => {
		expect(
			assigneeDisplay(slot({ assigneeName: null, assigneeIsGuest: true })),
		).toBe(OPEN_LABEL);
	});
});
