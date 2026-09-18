/**
 * The enrollment sweep for the meeting-meta patch (#772).
 *
 * ## What this replaces, and why it has to exist at all
 *
 * #666 mitigated a full-REPLACE writer with an ECHO (`themeOnlyUpdate`) and
 * guarded it with a sweep that read the field list off `updateMeetingSchema`
 * itself, so a NEW field could not quietly fall outside the echo. #772 deleted
 * the echo by making the writer a patch — but the failure the sweep existed for
 * did not go away, it changed shape:
 *
 *   then  a field the echo forgot was NULLED by every one-field save
 *   now   a field the writer forgets is IGNORED by every save
 *
 * Both are silent, both pass typecheck, and both look like a working save. So
 * the sweep moves rather than retires: it reads the schema's keys and demands
 * that each one is (a) expressible as `null` on the wire and (b) actually read
 * by the writer.
 *
 * These are source greps, not behaviour, and that is forced: `updateMeeting` is
 * a `createServerFn` and cannot be invoked from vitest, so its schema is
 * reachable only as text. The BEHAVIOUR of each state is asserted against the
 * real database in `meeting-meta-patch.integration.test.ts`; this file exists
 * only to catch the field that never got there.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const here = () => new URL(".", import.meta.url).pathname;
const meetingsSrc = readSource(resolve(here(), "./meetings.ts"));
const logicSrc = readSource(resolve(here(), "./meetings-logic.ts"));

/**
 * RAW, comments included — and deliberately NOT through `readSource`.
 * `guard-source.ts` states the rule: a guard of the form "the offender list must
 * be empty" must not read stripped source, because there a comment can only
 * produce a false FAILURE, so stripping LOOSENS it. The `not.toContain`
 * assertions at the bottom of this file are exactly that form: a comment that
 * reintroduces the echo's NAME should fail them, since the next author greps for
 * it. Everything else here reads stripped, because this file's own prose names
 * the fields it sweeps for.
 */
const rawMeetings = readFileSync(resolve(here(), "./meetings.ts"), "utf8");
const rawLogic = readFileSync(resolve(here(), "./meetings-logic.ts"), "utf8");

/**
 * The writer's OWN body. `meetings-logic.ts` holds five other writers that take
 * an `input` (`applyCreateMeeting`, `applyWordOfTheDayUpdate`,
 * `applyCompleteMeeting`, `applyReopenMeeting`, `applyMeetingDigitalVoting`), so
 * a sweep run against the whole file passes when a field is read by ANY of them.
 * MEASURED: adding `subtitle` to the schema plus one `if (input.subtitle !==
 * undefined) {}` inside `applyWordOfTheDayUpdate` left the sweep green — the
 * "silently a no-op" failure it exists to catch. CODING_STANDARDS says it
 * directly: anchor every search inside the construct you mean.
 */
const writerBody = (() => {
	const start = logicSrc.indexOf(
		"export async function applyMeetingMetaPatch(",
	);
	expect(start, "applyMeetingMetaPatch not found").toBeGreaterThan(-1);
	const after = logicSrc.indexOf("\nexport ", start + 1);
	return logicSrc.slice(start, after === -1 ? undefined : after);
})();

/** The schema body, comment-blind — this file's own prose names these fields. */
const schemaBody = (() => {
	const start = meetingsSrc.indexOf("const updateMeetingSchema = z.object({");
	expect(start, "updateMeetingSchema not found in meetings.ts").toBeGreaterThan(
		-1,
	);
	return meetingsSrc.slice(start, meetingsSrc.indexOf("});", start));
})();

const keys = [...schemaBody.matchAll(/^\t(\w+):/gm)].map((m) => m[1]);

/**
 * Not a patchable meta field, each for a reason that does NOT generalise:
 *
 *   meetingId      identity — which row to patch.
 *   selfMemberId   identity — who the caller claims to be.
 *   scheduledAt    a wall-time string turned into a `Date` against the club's
 *                  timezone, so it has no "null" state; omitted means unchanged
 *                  and there is no "clear the date".
 *   lengthMinutes  `if (input.lengthMinutes != null)` — a positive integer with
 *                  no clear state either; the club default is the fallback.
 *   meetingNumber  a number, already tri-state via `=== undefined` (#358).
 *
 * A new FREE-TEXT field does not belong here. It belongs in `META_TEXT_FIELDS`.
 */
const NON_TEXT = new Set([
	"meetingId",
	"selfMemberId",
	"scheduledAt",
	"lengthMinutes",
	"meetingNumber",
]);

describe("updateMeetingSchema is a patch, field by field", () => {
	it("finds the writer's own body (vacuity floor)", () => {
		// If this slice ever came back empty the sweep below would pass on anything.
		expect(writerBody.length).toBeGreaterThan(500);
		expect(writerBody).toContain("META_TEXT_FIELDS");
		// And it must NOT have swallowed the next writer.
		expect(writerBody).not.toContain("applyWordOfTheDayUpdate");
	});

	it("finds the schema and its fields (vacuity floor)", () => {
		// Counts the schema's own KEYS rather than a lexical proxy. 13 as of #731,
		// unchanged by #772 — a schema that shrinks below the non-text list plus the
		// text fields has lost fields, which is also worth failing on.
		expect(keys.length).toBeGreaterThanOrEqual(13);
		expect(keys).toContain("theme");
		expect(keys).toContain("joinUrl");
	});

	it("waives nothing that no longer exists on the schema", () => {
		// A waiver for a deleted field is a comment claiming a reason that is no
		// longer checkable, and it hides the next field that inherits the name.
		const stale = [...NON_TEXT].filter((k) => !keys.includes(k));
		expect(stale, "waived but absent from updateMeetingSchema").toEqual([]);
	});

	it("lets every text field carry an explicit null, which is how it is CLEARED", () => {
		// Without `.nullable()` the only way to clear a field is `""`, which reads
		// as a client mistake rather than an intent — and `null` from the dialog
		// would be rejected at the validator with the officer's edit lost.
		const notNullable = keys
			.filter((k) => !NON_TEXT.has(k))
			.filter(
				(k) =>
					!new RegExp(`^\\t${k}:.*\\.nullable\\(\\)`, "m").test(schemaBody),
			);
		expect(
			notNullable,
			`text fields on updateMeetingSchema that cannot be sent as null: ${notNullable.join(", ")}. The dialog cannot CLEAR them.`,
		).toEqual([]);
	});

	it("lets every field be omitted, which is how it is left ALONE", () => {
		const notOptional = keys
			.filter((k) => k !== "meetingId")
			.filter(
				(k) =>
					!new RegExp(`^\\t${k}:.*\\.optional\\(\\)`, "m").test(schemaBody),
			);
		expect(
			notOptional,
			`fields a partial editor cannot omit: ${notOptional.join(", ")}`,
		).toEqual([]);
	});
});

describe("the writer reads every field the schema accepts", () => {
	/** The tri-state list the writer loops over. */
	const textFields = (() => {
		const start = logicSrc.indexOf("const META_TEXT_FIELDS = [");
		expect(start, "META_TEXT_FIELDS not found").toBeGreaterThan(-1);
		const body = logicSrc.slice(start, logicSrc.indexOf("] as const;", start));
		return [...body.matchAll(/"(\w+)"/g)].map((m) => m[1]);
	})();

	it("handles every schema field either in the loop or by name", () => {
		// The failure this catches: a field added to the schema and to the dialog,
		// and never read by the writer. Nothing throws — the save succeeds and the
		// value is dropped on the floor.
		const unread = keys
			.filter((k) => !NON_TEXT.has(k))
			.filter(
				(k) =>
					!textFields.includes(k) &&
					!new RegExp(`input\\.${k} !== undefined`).test(writerBody),
			);
		expect(
			unread,
			`updateMeetingSchema fields the patch writer never reads: ${unread.join(", ")}. A save carrying one is silently a no-op.`,
		).toEqual([]);
	});

	it("names nothing in the loop that the schema does not accept", () => {
		const stale = textFields.filter((f) => !keys.includes(f));
		expect(stale, "in META_TEXT_FIELDS but not on the schema").toEqual([]);
	});

	it("builds a SPARSE set, which is what makes an omitted field unchanged", () => {
		// The patch's whole mechanism, and the half a behavioural test of one field
		// cannot see: `next` starts empty and a key appears only because the caller
		// sent it. Initialising it from the stored row instead would satisfy every
		// "omitted field is unchanged" assertion while restoring the lost update,
		// because the write would name columns the caller never sent.
		expect(writerBody).toMatch(
			/const next: Partial<typeof meetings\.\$inferInsert> = \{\};/,
		);
		expect(writerBody).toMatch(/if \(value !== undefined\) next\[field\] =/);
	});

	it("keeps the deleted echo deleted", () => {
		// `themeOnlyUpdate` / `MeetingMetaEcho` were the #666 mitigation. A caller
		// echoing stored values back at a PATCH writer is a lost update with no
		// upside at all.
		expect(rawMeetings).not.toContain("themeOnlyUpdate");
		expect(rawLogic).not.toContain("themeOnlyUpdate");
		expect(rawMeetings).not.toContain("MeetingMetaEcho");
		expect(rawLogic).not.toContain("MeetingMetaEcho");
	});
});
