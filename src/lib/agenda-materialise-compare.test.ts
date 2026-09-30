import { describe, expect, it } from "vitest";
import {
	agendaMatchesStandard,
	type ComparableAgenda,
	materialiseRunOfShow,
} from "./agenda-materialise";

/**
 * The "still on the standard agenda" comparator (#910). A meeting whose agenda
 * editor was merely OPENED holds a materialised private copy; setting a club
 * default must treat that copy as standard, and a copy anyone changed — or one
 * made before the club changed its settings — as edited.
 */

const ROLES = [
	{ key: "speaker", defaultCount: 3 },
	{ key: "evaluator", defaultCount: 3 },
	{ key: "general_evaluator", defaultCount: 1 },
];

/** What the standard would materialise now, and a STORED copy of it — the
 *  seeds minus `sortOrder`, as the loader reads them. */
function standard(
	ge = false,
	limits: {
		minSeconds: number | null;
		maxSeconds: number | null;
	} | null = null,
): ComparableAgenda {
	return { beats: materialiseRunOfShow(ge, limits), roles: ROLES };
}
function storedCopyOf(agenda: ComparableAgenda): ComparableAgenda {
	return {
		beats: agenda.beats.map((b) => {
			const { sortOrder: _s, ...rest } = b as typeof b & { sortOrder?: number };
			return { ...rest };
		}),
		roles: [...agenda.roles].reverse().map((r) => ({ ...r })),
	};
}

describe("agendaMatchesStandard", () => {
	it("reads an opened-but-unedited copy as standard, in either role order", () => {
		const now = standard();
		expect(agendaMatchesStandard(storedCopyOf(now), now)).toBe(true);
	});

	it("reads an edited copy as not standard", () => {
		const now = standard();
		for (const edit of [
			{ label: "Our own opening" },
			{ minutes: 7 },
			{ detail: "changed" },
			{ handoff: true },
			{ flex: true },
			{ markRed: 9 },
		]) {
			const copy = storedCopyOf(now);
			const beats = [...copy.beats];
			beats[1] = { ...(beats[1] as (typeof beats)[number]), ...edit };
			expect(
				agendaMatchesStandard({ ...copy, beats }, now),
				JSON.stringify(edit),
			).toBe(false);
		}
	});

	it("reads a removed, added or reordered row as not standard", () => {
		const now = standard();
		const copy = storedCopyOf(now);
		expect(
			agendaMatchesStandard({ ...copy, beats: copy.beats.slice(1) }, now),
		).toBe(false);
		expect(
			agendaMatchesStandard(
				{ ...copy, beats: [...copy.beats, copy.beats[0] as never] },
				now,
			),
		).toBe(false);
		const swapped = [...copy.beats];
		[swapped[1], swapped[2]] = [swapped[2] as never, swapped[1] as never];
		expect(agendaMatchesStandard({ ...copy, beats: swapped }, now)).toBe(false);
	});

	it("reads a copy made before the club changed a role, or its GE variant, as not standard (the safe direction)", () => {
		const then = storedCopyOf(standard());
		expect(
			agendaMatchesStandard(then, {
				...standard(),
				roles: ROLES.map((r) =>
					r.key === "speaker" ? { ...r, defaultCount: 4 } : r,
				),
			}),
		).toBe(false);
		expect(
			agendaMatchesStandard(then, {
				...standard(),
				roles: [...ROLES, { key: "timer", defaultCount: 1 }],
			}),
		).toBe(false);
		expect(agendaMatchesStandard(then, standard(true))).toBe(false);
	});

	it("compares marks at the FLOAT4 precision the column stores", () => {
		// A 2:20 Table Topics cap is 2.333… minutes when materialised and
		// 2.3333332538604736 read back from a `real` column.
		const now = standard(false, { minSeconds: 60, maxSeconds: 140 });
		const copy = storedCopyOf(now);
		const beats = copy.beats.map((b) => ({
			...b,
			markGreen: b.markGreen === null ? null : Math.fround(b.markGreen),
			markYellow: b.markYellow === null ? null : Math.fround(b.markYellow),
			markRed: b.markRed === null ? null : Math.fround(b.markRed),
		}));
		// Control: the rounding really changed a value, or this proves nothing.
		expect(beats.some((b, i) => b.markRed !== copy.beats[i]?.markRed)).toBe(
			true,
		);
		expect(agendaMatchesStandard({ ...copy, beats }, now)).toBe(true);
	});
});
