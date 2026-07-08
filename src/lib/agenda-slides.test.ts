import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-06-25T23:45:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
};

const club: ClubForDeck = {
	name: "MCF Toastmasters Club",
	clubNumber: "28677176",
	district: "District 39",
	timezone: "America/Chicago",
	meetingSchedule: "2nd & 4th Thursday",
};

const kinds = (slots: AgendaSlot[] = []) =>
	buildSlideDeck(meeting, club, slots).map((s) => s.kind);

describe("buildSlideDeck anchors", () => {
	it("always emits title, toastmaster, thankYou — even with no slots", () => {
		expect(kinds([])).toEqual(["title", "toastmaster", "thankYou"]);
	});

	it("title slide carries club identity + schedule time", () => {
		const [title] = buildSlideDeck(meeting, club, []);
		expect(title).toMatchObject({
			kind: "title",
			clubName: "MCF Toastmasters Club",
			clubNumber: "28677176",
			district: "District 39",
			timezone: "America/Chicago",
		});
	});

	it("toastmaster slide shows the assignee, else the open placeholder", () => {
		const withTmod = buildSlideDeck(meeting, club, [
			slot({ roleName: "Toastmaster of the Day", assigneeName: "Schinthia" }),
		]);
		expect(withTmod[1]).toMatchObject({ kind: "toastmaster", name: "Schinthia" });
		expect(buildSlideDeck(meeting, club, [])[1]).toMatchObject({
			kind: "toastmaster",
			name: "— open —",
		});
	});

	it("thankYou carries the club meeting schedule", () => {
		const deck = buildSlideDeck(meeting, club, []);
		expect(deck.at(-1)).toMatchObject({
			kind: "thankYou",
			meetingSchedule: "2nd & 4th Thursday",
		});
	});
});
