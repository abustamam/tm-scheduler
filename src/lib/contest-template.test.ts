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

/** Slots as `generateSlotRows` would create them, with `contestants` per
 *  contest segment. */
function slotsFor(contestants: number): AgendaSlot[] {
	return CONTEST_TEMPLATE.roles.flatMap((r) => {
		const n = r.key.startsWith("contestant_") ? contestants : r.defaultCount;
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
		expect(CONTEST_TEMPLATE.beats).toHaveLength(26);
		expect(CONTEST_TEMPLATE.roles).toHaveLength(10);
		expect(CONTEST_TEMPLATE.beats.length).toBeLessThan(MAX_TEMPLATE_BEATS);
		expect(CONTEST_TEMPLATE.roles.length).toBeLessThan(MAX_TEMPLATE_ROLES);
	});

	it("has a stable key", () => {
		expect(CONTEST_TEMPLATE_KEY).toBe("speech_contest");
		expect(CONTEST_TEMPLATE.key).toBe(CONTEST_TEMPLATE_KEY);
	});

	it("uses generic segment labels, not TI marks", () => {
		const labels = CONTEST_TEMPLATE.beats.map((b) => b.label);
		expect(labels).toContain("PREPARED SPEECH CONTEST");
		expect(labels).toContain("IMPROMPTU SPEAKING CONTEST");
		expect(labels).toContain("SPEECH EVALUATION CONTEST");
		const joined = labels.join(" | ");
		expect(joined).not.toContain("International Speech Contest");
		expect(joined).not.toContain("Table Topics Contest");
	});

	/**
	 * A single shared `contestant` role would put one member's slot in all three
	 * segments — printing them three times and booking their minutes three times.
	 */
	it("declares a SEPARATE contestant role per contest segment", () => {
		const keys = CONTEST_TEMPLATE.roles.map((r) => r.key);
		expect(keys).toContain("contestant_prepared");
		expect(keys).toContain("contestant_impromptu");
		expect(keys).toContain("contestant_evaluation");

		const repeatKeys = new Set(
			CONTEST_TEMPLATE.beats
				.map((b) => b.repeatsRoleKey)
				.filter((k): k is string => k !== null),
		);
		expect(repeatKeys).toEqual(
			new Set([
				"contestant_prepared",
				"contestant_impromptu",
				"contestant_evaluation",
			]),
		);
	});

	/**
	 * `pickSpeakerAndEvaluatorRoles` takes the LOWEST sortOrder among speaker
	 * roles, and that is the role "+ Add speaker" adds. If `test_speaker` sorted
	 * first the button would add a second Test Speaker, and nothing in the
	 * product could change the contestant count.
	 */
	it("sorts a contestant role ahead of the test speaker", () => {
		const speakers = CONTEST_TEMPLATE.roles
			.filter((r) => r.isSpeakerRole)
			.sort((a, b) => a.sortOrder - b.sortOrder);
		expect(speakers[0]?.key).toBe("contestant_prepared");
		const testSpeaker = CONTEST_TEMPLATE.roles.find(
			(r) => r.key === "test_speaker",
		);
		const prepared = CONTEST_TEMPLATE.roles.find(
			(r) => r.key === "contestant_prepared",
		);
		expect(prepared?.sortOrder).toBeLessThan(testSpeaker?.sortOrder ?? 0);
	});

	it("makes contestants speaker-category so speeches attach", () => {
		for (const key of [
			"contestant_prepared",
			"contestant_impromptu",
			"contestant_evaluation",
		]) {
			const r = CONTEST_TEMPLATE.roles.find((x) => x.key === key);
			expect(r?.category).toBe("speaker");
			expect(r?.isSpeakerRole).toBe(true);
		}
	});

	it("declares every roleKey its beats reference", () => {
		const keys = new Set(CONTEST_TEMPLATE.roles.map((r) => r.key));
		for (const b of CONTEST_TEMPLATE.beats) {
			if (b.roleKey) expect(keys.has(b.roleKey)).toBe(true);
			if (b.repeatsRoleKey) expect(keys.has(b.repeatsRoleKey)).toBe(true);
		}
	});

	it("has strictly increasing sortOrder and at most one flex beat", () => {
		const orders = CONTEST_TEMPLATE.beats.map((b) => b.sortOrder);
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
		expect(new Set(orders).size).toBe(orders.length);
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
	it("emits one row per contestant per segment, not N squared", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		// Each of the three segments: 4 contestant rows + 4 silence rows.
		expect(
			rows.filter((r) => r.who.startsWith("Prepared speech")),
		).toHaveLength(4);
		expect(
			rows.filter((r) => r.who.startsWith("Impromptu answer")),
		).toHaveLength(4);
		expect(
			rows.filter((r) => r.who.startsWith("Speech evaluation")),
		).toHaveLength(4);
	});

	it("grows by exactly 18 rows from 4 to 7 contestants", () => {
		// 3 segments x 3 extra contestants x (1 speech row + 1 silence row).
		// An exact delta, not `toBeGreaterThan` — the latter is true for both
		// correct and quadratic output, which is what hid the original defect.
		const four = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const seven = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(7));
		expect(seven.length - four.length).toBe(18);
	});

	it("keeps each segment's rows distinguishable", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		// The evaluation segment must NOT be byte-identical to the prepared one.
		const evaluation = rows.filter((r) =>
			r.who.startsWith("Speech evaluation"),
		);
		const prepared = rows.filter((r) => r.who.startsWith("Prepared speech"));
		expect(evaluation[0]?.who).not.toBe(prepared[0]?.who);
		expect(evaluation[0]?.roleKey).toBe("contestant_evaluation");
		expect(prepared[0]?.roleKey).toBe("contestant_prepared");
	});

	it("keeps every Contest Chair beat distinguishable by its label", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const chairRows = rows.filter((r) => r.roleKey === "contest_chair");
		expect(chairRows.length).toBeGreaterThan(4);
		// Every one names a different activity, rather than repeating the role.
		expect(new Set(chairRows.map((r) => r.who)).size).toBe(chairRows.length);
	});

	it("prints BOTH ballot counters and BOTH timers", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		expect(rows.filter((r) => r.who.startsWith("Tallying"))).toHaveLength(2);
		expect(rows.filter((r) => r.who.startsWith("Timers' report"))).toHaveLength(
			2,
		);
	});

	it("keeps the contest's own timer marks", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const impromptu = rows.find((r) => r.who.startsWith("Impromptu answer"));
		// Would be null (and minutes 7) if these went through expandRunSheet's
		// speaker arm, which reads the SLOT's speech window instead.
		expect(impromptu?.marks).toEqual({ green: 1, yellow: 1.5, red: 2 });
		expect(impromptu?.minutes).toBe(2);
	});

	it("prints all five section bands", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		expect(rows.filter((r) => r.section)).toHaveLength(5);
	});

	it("books a clock close to the template's default length", () => {
		const rows = buildTemplateRows(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const total = rows.reduce((n, r) => n + r.minutes, 0);
		expect(total).toBeGreaterThan(120);
		expect(total).toBeLessThanOrEqual(CONTEST_TEMPLATE.defaultLengthMinutes);
	});
});
