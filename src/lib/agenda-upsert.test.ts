/**
 * The pure half of `upsert_agendas` (#808).
 *
 * No database and no request, so every rule here is asserted directly rather
 * than through a planner that would need a club to exist first: the tri-state
 * normalisation, the field diff, and the refusal sentences whose DIFFERENCE is
 * the only thing that makes the locked guards testable one layer up.
 */
import { describe, expect, it } from "vitest";
import {
	AGENDA_ALREADY_APPLIED_MESSAGE,
	AGENDA_APPLIED_WHILE_OPEN_MESSAGE,
	AGENDA_EXPIRED_IN_LOCK_MESSAGE,
	AGENDA_EXPIRED_MESSAGE,
	AGENDA_FIELD_LABEL,
	AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
	AGENDA_META_FIELDS,
	type AgendaEntry,
	type AgendaMetaField,
	agendaCreateMeta,
	agendaFieldChanges,
	agendaPlanConfirmPath,
	agendaPlanConfirmUrl,
	normalizeMetaValue,
} from "./agenda-upsert";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "./assign-roles-plan";

const EMPTY: Record<AgendaMetaField, string | null> = {
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	location: null,
};

describe("normalizeMetaValue — the tri-state", () => {
	it("leaves an omitted field omitted", () => {
		expect(normalizeMetaValue(undefined)).toBeUndefined();
	});

	it("clears on null, on blank and on whitespace alike", () => {
		// The officer clearing an input, the caller sending null, and an LLM
		// sending "  " are the same edit — and `applyMeetingMetaPatch` collapses
		// all three to null one layer down, so the PLAN has to say so too. A plan
		// that showed `theme: — → "  "` and then stored null would be a diff the
		// reader could not have predicted from.
		expect(normalizeMetaValue(null)).toBeNull();
		expect(normalizeMetaValue("")).toBeNull();
		expect(normalizeMetaValue("   ")).toBeNull();
	});

	it("stores a value trimmed", () => {
		expect(normalizeMetaValue("  Harvest  ")).toBe("Harvest");
	});
});

describe("agendaFieldChanges — only what moves", () => {
	it("reports a field the entry sets over an empty column", () => {
		const entry: AgendaEntry = { date: "2026-10-06", theme: "Harvest" };
		expect(agendaFieldChanges(entry, EMPTY)).toStrictEqual([
			{ field: "theme", from: null, to: "Harvest" },
		]);
	});

	it("says nothing about a field the entry did not mention", () => {
		const entry: AgendaEntry = { date: "2026-10-06", theme: "Harvest" };
		const stored = { ...EMPTY, wordOfTheDay: "ebullient" };
		const changes = agendaFieldChanges(entry, stored);
		// THE property behind AC8: an untouched column is absent from the diff, so
		// it is absent from the patch, so the Word of the Day survives.
		expect(changes.map((c) => c.field)).toStrictEqual(["theme"]);
	});

	it("drops a field whose value already matches", () => {
		const entry: AgendaEntry = { date: "2026-10-06", theme: " Harvest " };
		expect(
			agendaFieldChanges(entry, { ...EMPTY, theme: "Harvest" }),
		).toStrictEqual([]);
	});

	it("reports a clear as a real change", () => {
		const entry: AgendaEntry = { date: "2026-10-06", theme: null };
		expect(
			agendaFieldChanges(entry, { ...EMPTY, theme: "Harvest" }),
		).toStrictEqual([{ field: "theme", from: "Harvest", to: null }]);
	});

	it("does not report clearing a column that is already empty", () => {
		const entry: AgendaEntry = { date: "2026-10-06", theme: "" };
		expect(agendaFieldChanges(entry, EMPTY)).toStrictEqual([]);
	});

	it("covers every declared field", () => {
		// Vacuity floor for the loop: a field added to `AGENDA_META_FIELDS` and
		// forgotten in `AgendaEntry` would make this case red rather than silently
		// dropping that field from every diff.
		const entry: AgendaEntry = {
			date: "2026-10-06",
			theme: "T",
			wordOfTheDay: "W",
			wodDefinition: "D",
			wodExample: "E",
			location: "L",
		};
		expect(agendaFieldChanges(entry, EMPTY).map((c) => c.field)).toStrictEqual([
			...AGENDA_META_FIELDS,
		]);
	});

	it("labels every declared field", () => {
		for (const field of AGENDA_META_FIELDS) {
			expect(AGENDA_FIELD_LABEL[field]).toBeTruthy();
		}
	});

	it("excludes notes and reminders, deliberately", () => {
		// #808 excluded both with a stated reason — `reminders` feeds the poller
		// that emails members. Asserted so re-adding one is a conscious edit to
		// this case rather than an incidental widening of the tool's blast radius.
		expect(AGENDA_META_FIELDS).not.toContain("notes");
		expect(AGENDA_META_FIELDS).not.toContain("reminders");
	});
});

describe("agendaCreateMeta", () => {
	it("resolves every field to a value or null — there is nothing to leave alone", () => {
		// A create writes the row, so "omitted" has no meaning: an unmentioned
		// field is a blank column, not an untouched one.
		expect(
			agendaCreateMeta({ date: "2026-10-06", theme: " Harvest " }),
		).toStrictEqual({
			theme: "Harvest",
			wordOfTheDay: null,
			wodDefinition: null,
			wodExample: null,
		});
	});

	it("carries no location — that is a NewMeeting column, not meta", () => {
		const meta = agendaCreateMeta({ date: "2026-10-06", location: "Hall" });
		expect(meta).not.toHaveProperty("location");
	});
});

describe("the refusal sentences differ where they must", () => {
	/**
	 * Each pair is a cheap pre-check and the locked guard behind it. The
	 * pre-check short-circuits every serial case, so a test can only prove the
	 * locked guard fires if the locked guard says something only it says — #806
	 * shipped that pair identical twice and the guard was unreachable by any
	 * assertion.
	 */
	it("already-applied: pre-check and locked guard", () => {
		expect(AGENDA_ALREADY_APPLIED_MESSAGE).not.toBe(
			AGENDA_APPLIED_WHILE_OPEN_MESSAGE,
		);
	});

	it("expired: pre-check and locked guard", () => {
		expect(AGENDA_EXPIRED_MESSAGE).not.toBe(AGENDA_EXPIRED_IN_LOCK_MESSAGE);
	});

	it("meeting locked: plan time and inside the club lock", () => {
		expect(MEETING_LOCKED_BLOCKING_MESSAGE).not.toBe(
			AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
		);
	});

	it("and none of them is empty", () => {
		// Vacuity floor: two empty strings are equal, so an assertion that they
		// DIFFER would be the one thing an accidental deletion could not break.
		for (const message of [
			AGENDA_ALREADY_APPLIED_MESSAGE,
			AGENDA_APPLIED_WHILE_OPEN_MESSAGE,
			AGENDA_EXPIRED_MESSAGE,
			AGENDA_EXPIRED_IN_LOCK_MESSAGE,
			AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
		]) {
			expect(message.length).toBeGreaterThan(10);
		}
	});
});

describe("the confirm link", () => {
	it("is one spelling, shared by the link and the route", () => {
		expect(agendaPlanConfirmPath("abc")).toBe("/agenda-plan/abc");
	});

	it("is absolute, and tolerates a trailing slash on the origin", () => {
		expect(agendaPlanConfirmUrl("https://gavelup.app/", "abc")).toBe(
			"https://gavelup.app/agenda-plan/abc",
		);
	});
});
