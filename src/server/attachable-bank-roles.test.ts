/**
 * `attachableBankRoles` — the set arithmetic behind the agenda editor's Roles
 * panel picker (#802).
 *
 * A PLAIN unit test with no database, which is the whole reason the subtraction
 * is a pure exported function rather than a `WHERE NOT IN` inside
 * `loadAgendaDraft`'s query. What it decides is which of a club's roles an
 * officer can even see, and every exclusion mirrors a refusal `addAgendaRole`
 * makes — the two have to agree, and a rule expressed in SQL can only be
 * checked against a live Postgres by someone who has one.
 *
 * `#/db` is mocked rather than reached: `meeting-agenda-edit-logic.ts` imports
 * it at module load (transitively, through `activity` / `meeting-slots-logic` /
 * `meeting-templates-logic` as well), and this suite runs on every machine,
 * `TEST_DATABASE_URL` or not. The deferred import below is what makes the mock
 * win the race — the same pattern the integration suites in this directory use.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { attachableBankRoles } = await import("./meeting-agenda-edit-logic");

type Bank = Parameters<typeof attachableBankRoles>[0][number];
type Declared = Parameters<typeof attachableBankRoles>[1][number];

function bankRole(over: Partial<Bank> & { key: string | null }): Bank {
	return {
		name: "Timer",
		category: "functionary",
		defaultCount: 1,
		isSpeakerRole: false,
		standing: true,
		enabled: true,
		...over,
	};
}

function declared(over: Partial<Declared> & { key: string }): Declared {
	return { name: "Timer", ...over };
}

describe("attachableBankRoles", () => {
	it("is the bank MINUS what the agenda already declares", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: "toastmaster_of_the_day", name: "Toastmaster" }),
				bankRole({ key: "timer", name: "Timer" }),
				bankRole({ key: "grammarian", name: "Grammarian" }),
			],
			[declared({ key: "toastmaster_of_the_day", name: "Toastmaster" })],
		);

		expect(picker.map((r) => r.key)).toEqual(["timer", "grammarian"]);
	});

	// The four the standard run of show names in beat COPY and in its
	// `requiresAnyOf` / `fallbacks` gates but never as a beat's own `roleKey`, so
	// `materialiseForMeeting` declares five roles and the panel listed five.
	// Before this picker the only way to reach them was to already know the club
	// had them and type the name exactly.
	it("offers the four functionaries the run of show never declares as a beat's roleKey", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: "timer", name: "Timer" }),
				bankRole({ key: "ah_counter", name: "Ah-Counter" }),
				bankRole({ key: "grammarian", name: "Grammarian" }),
				bankRole({ key: "vote_counter", name: "Vote Counter" }),
			],
			[
				declared({ key: "toastmaster_of_the_day", name: "Toastmaster" }),
				declared({ key: "speaker", name: "Speaker" }),
				declared({ key: "evaluator", name: "Evaluator" }),
				declared({ key: "general_evaluator", name: "General Evaluator" }),
				declared({ key: "table_topics_master", name: "Table Topics Master" }),
			],
		);

		expect(picker.map((r) => r.name)).toEqual([
			"Timer",
			"Ah-Counter",
			"Grammarian",
			"Vote Counter",
		]);
	});

	it("INCLUDES a non-standing role, and carries the flag so the picker can mark it", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: "timer", name: "Timer" }),
				bankRole({ key: "chief_judge", name: "Chief Judge", standing: false }),
			],
			[],
		);

		expect(picker).toEqual([
			expect.objectContaining({ key: "timer", standing: true }),
			expect.objectContaining({ key: "chief_judge", standing: false }),
		]);
	});

	// `addAgendaRole` refuses a disabled role outright, because a declaration
	// whose places `generateSlotRows` drops on `enabled` is a role sitting on the
	// agenda that can never get a slot and that nobody can hand-add either.
	// Offering it here would be offering a guaranteed error.
	it("EXCLUDES a role the club has turned off", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: "timer", name: "Timer" }),
				bankRole({ key: "ah_counter", name: "Ah-Counter", enabled: false }),
			],
			[],
		);

		expect(picker.map((r) => r.key)).toEqual(["timer"]);
	});

	// `meeting_template_roles.key` is NOT NULL, so a bank row minted before #801
	// wrote keys cannot be declared by any agenda at all. `addAgendaRole` says so
	// in a sentence; the picker just does not offer it.
	it("EXCLUDES a keyless bank row, which no agenda can declare", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: null, name: "Zoom Host" }),
				bankRole({ key: "timer", name: "Timer" }),
			],
			[],
		);

		expect(picker.map((r) => r.name)).toEqual(["Timer"]);
	});

	// `addAgendaRole` checks the folded NAME against the declarations BEFORE it
	// looks at keys, so a bank role sharing a declared role's name is refused
	// even when the keys differ — which is what a rename leaves behind.
	it("EXCLUDES a bank role whose NAME a declaration already carries, under a different key", () => {
		const picker = attachableBankRoles(
			[bankRole({ key: "timekeeper", name: "  TIMER  " })],
			[declared({ key: "timer", name: "Timer" })],
		);

		expect(picker).toEqual([]);
	});

	// The one refusal this deliberately does NOT mirror. Two rows the club named
	// the same thing are unattachable until one is renamed, and `addAgendaRole`
	// says exactly that — so both stay listed. Hiding a role the club owns from
	// the only picker that lists it would leave the officer with nothing to act
	// on and no way to find out why.
	it("KEEPS both halves of an ambiguous name, whose refusal is the actionable one", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: "timer", name: "Timer" }),
				bankRole({ key: "timer_2", name: "timer" }),
			],
			[],
		);

		expect(picker.map((r) => r.key)).toEqual(["timer", "timer_2"]);
	});

	it("preserves the order it was handed, which is the club's own", () => {
		const picker = attachableBankRoles(
			[
				bankRole({ key: "grammarian", name: "Grammarian" }),
				bankRole({ key: "ah_counter", name: "Ah-Counter" }),
				bankRole({ key: "timer", name: "Timer" }),
			],
			[],
		);

		expect(picker.map((r) => r.key)).toEqual([
			"grammarian",
			"ah_counter",
			"timer",
		]);
	});

	it("carries the four fields the attach call sends, off the BANK row", () => {
		const [picked] = attachableBankRoles(
			[
				bankRole({
					key: "contestant_prepared",
					name: "Contestant",
					category: "speaker",
					defaultCount: 4,
					isSpeakerRole: true,
					standing: false,
				}),
			],
			[],
		);

		expect(picked).toEqual({
			key: "contestant_prepared",
			name: "Contestant",
			category: "speaker",
			defaultCount: 4,
			isSpeakerRole: true,
			standing: false,
		});
	});
});
