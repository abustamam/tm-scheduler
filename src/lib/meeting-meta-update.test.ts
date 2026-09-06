/**
 * The theme-only `updateMeeting` payload (#666).
 *
 * ## The bug this file exists to make un-shippable
 *
 * `applyMeetingUpdate` is a full REPLACE: every free-text field it is not given
 * is written as `null`. A focused one-field editor that posts
 * `{ meetingId, scheduledAt, theme }` therefore erases the club's location, its
 * Word of the Day, that word's definition and example, the announcements and
 * the organizer's notes — and the write SUCCEEDS, so nothing surfaces except a
 * theme appearing. `themeOnlyUpdate` is the round trip that prevents it.
 *
 * ## Why the enrollment sweep at the bottom is the important half
 *
 * The per-field assertions here prove the six fields that exist TODAY survive.
 * They say nothing about the seventh. `updateMeetingSchema` is one `z.object`
 * in `server/meetings.ts`, and the day someone adds `subtitle` to it beside a
 * matching `subtitle: input.subtitle?.trim() || null` in the writer, this
 * module starts silently clearing it with every test in this file green — the
 * same shape as the parity trap in CODING_STANDARDS ("a test cannot see a
 * defect present on both sides"). So the last describe DERIVES its field list
 * from that schema's source and fails on any key that is neither echoed nor
 * waived with a stated reason, which enrolls the next field automatically
 * rather than relying on the next author having read this comment.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	type MeetingMetaEcho,
	type ThemeOnlyUpdateInput,
	themeOnlyUpdate,
} from "./meeting-meta-update";

/** Every echoed field carries a DISTINCT value, so a payload that crosses two
 *  of them (a copy-paste in the builder) fails instead of passing on a shared
 *  fixture string. */
const STORED: MeetingMetaEcho = {
	location: "The Old Library, Room 5",
	wordOfTheDay: "ineffable",
	wodDefinition: "too great to be expressed in words",
	wodExample: "an ineffable joy",
	notes: "Bring the spare timing lights",
	reminders: "Contest entries close Friday",
};

const BASE: ThemeOnlyUpdateInput = {
	meetingId: "22222222-2222-4222-8222-222222222222",
	selfMemberId: "33333333-3333-4333-8333-333333333333",
	scheduledAt: "2026-09-15T19:00",
	theme: "New beginnings",
	current: STORED,
};

const build = (over: Partial<ThemeOnlyUpdateInput> = {}) =>
	themeOnlyUpdate({ ...BASE, ...over });

describe("themeOnlyUpdate — the new theme", () => {
	it("carries the theme through", () => {
		expect(build().theme).toBe("New beginnings");
	});

	it("sends a blank theme as undefined, which the server stores as null", () => {
		// Clearing a theme is a legitimate edit, and `""` through the truncating
		// validator is a pointless round trip that lands on the same null.
		expect(build({ theme: "" }).theme).toBeUndefined();
		expect(build({ theme: "   " }).theme).toBeUndefined();
	});

	it("passes the identity fields the writer requires", () => {
		const payload = build();
		expect(payload.meetingId).toBe(BASE.meetingId);
		expect(payload.selfMemberId).toBe(BASE.selfMemberId);
		// REQUIRED by the schema with no stored fallback, and compared to the
		// minute against the stored time for a caller who may not reschedule.
		expect(payload.scheduledAt).toBe("2026-09-15T19:00");
	});

	it("keeps a null selfMemberId null (the signed-in admin path)", () => {
		expect(build({ selfMemberId: null }).selfMemberId).toBeNull();
	});
});

describe("themeOnlyUpdate — the round trip", () => {
	it("echoes every other stored meta field unchanged", () => {
		const payload = build();
		expect(payload.location).toBe(STORED.location);
		expect(payload.wordOfTheDay).toBe(STORED.wordOfTheDay);
		expect(payload.wodDefinition).toBe(STORED.wodDefinition);
		expect(payload.wodExample).toBe(STORED.wodExample);
		expect(payload.notes).toBe(STORED.notes);
		expect(payload.reminders).toBe(STORED.reminders);
	});

	it("leaves an already-empty field undefined rather than inventing a blank", () => {
		const payload = build({
			current: {
				location: null,
				wordOfTheDay: null,
				wodDefinition: null,
				wodExample: null,
				notes: "  ",
				reminders: "",
			},
		});
		expect(payload.location).toBeUndefined();
		expect(payload.wordOfTheDay).toBeUndefined();
		expect(payload.wodDefinition).toBeUndefined();
		expect(payload.wodExample).toBeUndefined();
		expect(payload.notes).toBeUndefined();
		expect(payload.reminders).toBeUndefined();
	});

	it("does NOT send lengthMinutes or meetingNumber", () => {
		// For these two, and ONLY these two, omission really does mean "leave it
		// alone": `applyMeetingUpdate` falls back to the stored value. Sending
		// them would work but would teach the next reader that the other six are
		// optional in the same way. They are not.
		const payload = build() as Record<string, unknown>;
		expect("lengthMinutes" in payload).toBe(false);
		expect("meetingNumber" in payload).toBe(false);
	});
});

/**
 * The enrollment sweep. Reads the fields off `updateMeetingSchema` itself, so a
 * field added to the writer's contract cannot quietly fall outside the echo.
 */
describe("every updateMeeting field is echoed or waived", () => {
	/**
	 * Not echoed, each for a reason that does NOT generalise to a new field:
	 *
	 *   meetingId / selfMemberId  identity, supplied by the caller and asserted
	 *                             present above.
	 *   scheduledAt               required by the schema; the caller resubmits the
	 *                             meeting's current wall time.
	 *   theme                     the field being edited.
	 *   lengthMinutes             `input.lengthMinutes != null ? … : meeting.lengthMinutes`
	 *   meetingNumber             `input.meetingNumber === undefined ? meeting.meetingNumber : …`
	 *
	 * A new free-text field belongs in `MeetingMetaEcho`, not here.
	 */
	const WAIVED = new Set([
		"meetingId",
		"selfMemberId",
		"scheduledAt",
		"theme",
		"lengthMinutes",
		"meetingNumber",
	]);

	/** Comment-blind: this file's own header names several of these fields, and
	 *  the extraction below must see the SCHEMA rather than prose about it. */
	const src = readSource("src/server/meetings.ts");
	const start = src.indexOf("const updateMeetingSchema = z.object({");
	const body = src.slice(start, src.indexOf("});", start));
	const keys = [...body.matchAll(/^\t(\w+):/gm)].map((m) => m[1]);

	it("finds the schema (vacuity floor)", () => {
		expect(start).toBeGreaterThan(-1);
		// Counts the STRUCTURE — the schema's own keys — rather than a lexical
		// proxy like quoted literals, which is the erosion CODING_STANDARDS
		// describes. 12 keys as of #666; a schema that shrinks below the waiver
		// list plus the echo has lost fields, which is also worth failing on.
		expect(keys.length).toBeGreaterThanOrEqual(12);
	});

	it("echoes every non-waived field back to the writer", () => {
		const payload = build() as Record<string, unknown>;
		const missing = keys.filter(
			(k) => !WAIVED.has(k) && payload[k] === undefined,
		);
		expect(
			missing,
			`updateMeetingSchema fields neither echoed by themeOnlyUpdate nor waived: ${missing.join(", ")}. A theme-only save will NULL each of them.`,
		).toEqual([]);
	});

	it("waives nothing that no longer exists on the schema", () => {
		// A waiver for a deleted field is a comment claiming a reason that is no
		// longer checkable, and it hides the next field that inherits the name.
		const stale = [...WAIVED].filter((k) => !keys.includes(k));
		expect(stale, `waived but absent from updateMeetingSchema`).toEqual([]);
	});
});
