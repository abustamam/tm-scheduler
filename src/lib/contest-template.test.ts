import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import { buildTemplateRows } from "./agenda-template-rows";
import { CONTEST_TEMPLATE, CONTEST_TEMPLATE_KEY } from "./contest-template";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_ROLES,
} from "./meeting-template-limits";

const roles = CONTEST_TEMPLATE.roles.map((r) => ({
	key: r.key,
	name: r.name,
	isSpeakerRole: r.isSpeakerRole,
}));

/** Slots as `generateSlotRows` would create them, with `contestants` in the
 *  contest's one speaker role and `defaultCount` everywhere else. */
function slotsFor(contestants: number): AgendaSlot[] {
	return CONTEST_TEMPLATE.roles.flatMap((r) => {
		const n = r.isSpeakerRole ? contestants : r.defaultCount;
		return Array.from({ length: n }, (_, i) => ({
			id: `${r.key}-${i}`,
			roleName: r.name,
			roleKey: r.key,
			category: r.category,
			isSpeakerRole: r.isSpeakerRole,
			slotIndex: i,
			assigneeName: null,
			speechTitle: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			evaluatesSlotId: null,
			evaluates: null,
		}));
	});
}

describe("contest template seed", () => {
	it("stays within the size ceilings", () => {
		// ABSOLUTE counts, not `toBeLessThan(CAP)` — that passes for every value
		// of the cap, including one that reintroduces the bug (#519).
		expect(CONTEST_TEMPLATE.beats).toHaveLength(15);
		expect(CONTEST_TEMPLATE.roles).toHaveLength(7);
		expect(CONTEST_TEMPLATE.beats.length).toBeLessThan(MAX_TEMPLATE_BEATS);
		expect(CONTEST_TEMPLATE.roles.length).toBeLessThan(MAX_TEMPLATE_ROLES);
	});

	/**
	 * Unchanged on purpose when the template's CONTENT was rewritten:
	 * `seedTemplate` is idempotent on the key and replaces roles and beats in
	 * place, so an already-seeded database is corrected by re-running the seed.
	 * A new key would have created a second row and left the old one behind,
	 * which `meetings.template_id`'s ON DELETE RESTRICT makes awkward to retire.
	 */
	it("has a stable key", () => {
		expect(CONTEST_TEMPLATE_KEY).toBe("speech_contest");
		expect(CONTEST_TEMPLATE.key).toBe(CONTEST_TEMPLATE_KEY);
	});

	it("uses generic segment labels, not TI marks", () => {
		const labels = CONTEST_TEMPLATE.beats.map((b) => b.label);
		expect(labels).toContain("OPENING");
		expect(labels).toContain("SPEECHES");
		expect(labels).toContain("RESULTS AND CLOSING");
		const joined = labels.join(" | ");
		expect(joined).not.toContain("International Speech Contest");
		expect(joined).not.toContain("Table Topics Contest");
	});

	/**
	 * The template describes ONE contest. It used to describe three as
	 * sequential segments, and a club running one of them could not remove the
	 * other two: deleting the contestant slots collapses their repeat blocks,
	 * but the section bands, briefings, break and evaluation-prep window bind to
	 * no contestant role, so 28 minutes of a contest that was not happening
	 * printed anyway. Templates have no gating by design, so this is enforced at
	 * the seed: nothing here may name a contest this template does not run.
	 */
	it("describes exactly one contest", () => {
		const text = CONTEST_TEMPLATE.beats
			.flatMap((b) => [b.label, b.detail ?? "", b.roleKey ?? ""])
			.concat(CONTEST_TEMPLATE.roles.flatMap((r) => [r.key, r.name]))
			.join(" | ")
			.toLowerCase();
		// WORD BOUNDARIES, not `toContain`: "contest speech" contains the
		// substring "test speech", so a plain substring check fails on correct
		// content and teaches the next person to weaken the assertion.
		for (const absent of [
			"impromptu",
			"evaluation",
			"test speech",
			"test_speaker",
			"tall tales",
		]) {
			expect(text, `template still mentions "${absent}"`).not.toMatch(
				new RegExp(`\\b${absent.replace(/[_ ]/g, "[_ ]")}\\b`),
			);
		}
		const repeatKeys = new Set(
			CONTEST_TEMPLATE.beats
				.map((b) => b.repeatsRoleKey)
				.filter((k): k is string => k !== null),
		);
		expect(repeatKeys).toEqual(new Set(["contestant_prepared"]));
	});

	/**
	 * `pickSpeakerAndEvaluatorRoles` (`meeting-roles.ts:198`) takes the LOWEST
	 * sortOrder among speaker roles, and that one role is what the agenda's +/-
	 * speaker controls act on. With several speaker roles those controls can only
	 * ever reach the first, and every other contestant count is frozen at
	 * whatever `defaultCount` said — which is how the three-contest version left
	 * two segments unadjustable.
	 */
	it("declares exactly one speaker role, so +/- can reach it", () => {
		const speakers = CONTEST_TEMPLATE.roles.filter((r) => r.isSpeakerRole);
		expect(speakers).toHaveLength(1);
		expect(speakers[0]?.key).toBe("contestant_prepared");
	});

	it("makes the contestant speaker-category so speeches attach", () => {
		const r = CONTEST_TEMPLATE.roles.find(
			(x) => x.key === "contestant_prepared",
		);
		expect(r?.category).toBe("speaker");
		expect(r?.isSpeakerRole).toBe(true);
	});

	it("declares every roleKey its beats reference", () => {
		const keys = new Set(CONTEST_TEMPLATE.roles.map((r) => r.key));
		for (const b of CONTEST_TEMPLATE.beats) {
			if (b.roleKey) expect(keys.has(b.roleKey)).toBe(true);
			if (b.repeatsRoleKey) expect(keys.has(b.repeatsRoleKey)).toBe(true);
		}
	});

	/**
	 * `buildTemplateRows` prints a BARE role row when a role beat has no slot,
	 * so the shape survives an unfilled position. At the template's own default
	 * counts nothing should be taking that branch — a beat owned by a role the
	 * seed gives zero slots is a row nobody can ever claim or remove.
	 */
	it("gives every role beat at least one slot at default counts", () => {
		const counts = new Map(
			CONTEST_TEMPLATE.roles.map((r) => [r.key, r.defaultCount]),
		);
		for (const b of CONTEST_TEMPLATE.beats) {
			if (!b.roleKey) continue;
			expect(
				counts.get(b.roleKey) ?? 0,
				`${b.label} owns no slot`,
			).toBeGreaterThan(0);
		}
	});

	it("has strictly increasing sortOrder and at most one flex beat", () => {
		const orders = CONTEST_TEMPLATE.beats.map((b) => b.sortOrder);
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
		expect(new Set(orders).size).toBe(orders.length);
		// No flex beat, deliberately: in a contest every beat is rule-bound, so
		// nothing may silently absorb the meeting's slack.
		expect(CONTEST_TEMPLATE.beats.filter((b) => b.flex)).toHaveLength(0);
	});

	it("keeps every repeat block's rows CONSECUTIVE in sortOrder", () => {
		// `buildTemplateRows` groups a block from adjacent rows sharing the key. A
		// non-repeating beat wedged between two of them silently splits the block
		// into two, doubling the segment.
		const ordered = [...CONTEST_TEMPLATE.beats].sort(
			(a, b) => a.sortOrder - b.sortOrder,
		);
		const seen = new Set<string>();
		let prev: string | null = null;
		for (const b of ordered) {
			const k = b.repeatsRoleKey;
			if (k !== prev && k !== null) {
				expect(seen.has(k), `${k} block is not contiguous`).toBe(false);
				seen.add(k);
			}
			prev = k;
		}
	});
});

describe("contest template rendered", () => {
	it("emits one row per contestant, not N squared", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		expect(rows.filter((r) => r.who.startsWith("Contest speech"))).toHaveLength(
			4,
		);
		expect(
			rows.filter((r) => r.who.startsWith("One minute of silence")),
		).toHaveLength(4);
	});

	it("grows by exactly 6 rows from 3 to 6 contestants", () => {
		// 3 extra contestants x (1 speech row + 1 silence row). An exact delta,
		// not `toBeGreaterThan` — the latter is true for both correct and
		// quadratic output, which is what hid the original defect.
		const three = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(3));
		const six = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(6));
		expect(six.length - three.length).toBe(6);
	});

	it("keeps every Contest Chair beat distinguishable by its label", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const chairRows = rows.filter((r) => r.roleKey === "contest_chair");
		expect(chairRows.length).toBeGreaterThan(3);
		// Every one names a different activity, rather than repeating the role.
		expect(new Set(chairRows.map((r) => r.who)).size).toBe(chairRows.length);
	});

	/**
	 * A non-repeating role beat emits one row PER SLOT, so binding "Tallying" to
	 * a two-slot `ballot_counter` printed it TWICE at ten minutes each — twenty
	 * minutes for an activity two people perform together once, on the clock the
	 * Contest Chair runs the night from. Both beats now avoid multi-slot roles.
	 * Asserted at 2 counters and 2 timers specifically: the bug was invisible at
	 * one of each.
	 */
	it("prints the tally and the timers' report once each", () => {
		const counters = CONTEST_TEMPLATE.roles.find(
			(r) => r.key === "ballot_counter",
		);
		const timers = CONTEST_TEMPLATE.roles.find(
			(r) => r.key === "contest_timer",
		);
		expect(counters?.defaultCount).toBe(2);
		expect(timers?.defaultCount).toBe(2);

		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		expect(rows.filter((r) => r.who.startsWith("Tallying"))).toHaveLength(1);
		expect(rows.filter((r) => r.who.startsWith("Timers' report"))).toHaveLength(
			1,
		);
	});

	it("keeps the contest's own timer marks", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const speech = rows.find((r) => r.who.startsWith("Contest speech"));
		// Would be null (and minutes 7 by coincidence) if these went through
		// expandRunSheet's speaker arm, which reads the SLOT's speech window.
		expect(speech?.marks).toEqual({ green: 5, yellow: 6, red: 7 });
		expect(speech?.minutes).toBe(7);
	});

	it("prints one section band per segment", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		expect(rows.filter((r) => r.section)).toHaveLength(3);
	});

	/**
	 * ABSOLUTE minutes at a stated contestant count, plus the per-contestant
	 * delta. `toBeLessThanOrEqual(CONTEST_TEMPLATE.defaultLengthMinutes)` — what
	 * this used to assert — passes for every value of that constant, including
	 * one that no longer matches the agenda at all.
	 */
	it("books a known clock that grows 8 minutes per contestant", () => {
		const total = (n: number) =>
			buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(n)).reduce(
				(sum, r) => sum + r.minutes,
				0,
			);
		expect(total(3)).toBe(84);
		expect(total(4) - total(3)).toBe(8);
		expect(CONTEST_TEMPLATE.defaultLengthMinutes).toBe(90);
	});
});
