import { describe, expect, it } from "vitest";
import {
	type AgendaSlot,
	buildRunOfShow,
	expandRunSheet,
	resolveAgendaRows,
} from "./agenda-runsheet";
import {
	buildTemplateRows,
	type TemplateBeatRow,
	type TemplateRoleRow,
} from "./agenda-template-rows";

const ROLES: TemplateRoleRow[] = [
	{ key: "contest_chair", name: "Contest Chair", isSpeakerRole: false },
	{ key: "ballot_counter", name: "Ballot Counter", isSpeakerRole: false },
	{ key: "contestant", name: "Contestant", isSpeakerRole: true },
];

function beat(
	over: Partial<TemplateBeatRow> & { sortOrder: number },
): TemplateBeatRow {
	return {
		kind: "event",
		label: "Beat",
		detail: null,
		minutes: 1,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		...over,
	};
}

function slot(
	roleKey: string,
	roleName: string,
	slotIndex: number,
	assignee: string | null = null,
): AgendaSlot {
	return {
		id: `${roleKey}-${slotIndex}`,
		roleName,
		roleKey,
		category: roleKey === "contestant" ? "speaker" : "leadership",
		isSpeakerRole: roleKey === "contestant",
		slotIndex,
		assigneeName: assignee,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
	};
}

describe("buildTemplateRows", () => {
	/**
	 * THE regression test. The design this replaced emitted one Beat per slot and
	 * let `expandRunSheet` render them — but `expandRunSheet` ALREADY fans one
	 * beat across every matching slot, so four contestants produced sixteen rows.
	 * Every test in the original plan asserted the intermediate Beat list rather
	 * than the final rows, so none of them could observe it.
	 */
	it("emits exactly one row per contestant per repeat block", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Contestant",
				minutes: 7,
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
			beat({
				sortOrder: 1,
				kind: "event",
				label: "One minute of silence",
				minutes: 1,
				repeatsRoleKey: "contestant",
			}),
		];
		const slots = [0, 1, 2, 3].map((i) => slot("contestant", "Contestant", i));
		const rows = buildTemplateRows(beats, ROLES, slots);

		expect(rows).toHaveLength(8);
		expect(rows.filter((r) => r.who.startsWith("Contestant"))).toHaveLength(4);
		expect(rows.filter((r) => r.who === "One minute of silence")).toHaveLength(
			4,
		);
		expect(rows.reduce((n, r) => n + r.minutes, 0)).toBe(32);
	});

	it("numbers repeated rows and names each slot's own assignee", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Contestant",
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
		];
		const slots = [
			slot("contestant", "Contestant", 0, "Ada"),
			slot("contestant", "Contestant", 1, "Grace"),
		];
		const rows = buildTemplateRows(beats, ROLES, slots);
		expect(rows[0]?.who).toBe("Contestant 1 · Ada");
		expect(rows[1]?.who).toBe("Contestant 2 · Grace");
	});

	/**
	 * The beat's LABEL is the activity, and it must survive. A contest runs seven
	 * different beats owned by the Contest Chair; labelling rows by the ROLE
	 * would collapse "Contest briefing", "Results and certificates" and "Closing
	 * remarks" into one repeated string, and make the evaluation contest's rows
	 * byte-identical to the prepared-speech contest's.
	 */
	it("uses the beat's label, not the role name", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Results and certificates",
					roleKey: "contest_chair",
				}),
			],
			ROLES,
			[slot("contest_chair", "Contest Chair", 0, "Ada")],
		);
		expect(rows[0]?.who).toBe("Results and certificates · Ada");
		expect(rows[0]?.roleKey).toBe("contest_chair");
	});

	it("keeps two same-role beats distinguishable by their labels", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Contest briefing",
					roleKey: "contest_chair",
				}),
				beat({
					sortOrder: 1,
					kind: "role",
					label: "Closing remarks",
					roleKey: "contest_chair",
				}),
			],
			ROLES,
			[slot("contest_chair", "Contest Chair", 0, "Ada")],
		);
		expect(rows.map((r) => r.who)).toEqual([
			"Contest briefing · Ada",
			"Closing remarks · Ada",
		]);
	});

	/**
	 * A non-repeating role beat must emit one row per slot, matching
	 * `expandRunSheet`'s plain arm. Binding only the first slot silently drops
	 * the second Ballot Counter and the second Timer, both of which the seeded
	 * contest declares with `defaultCount: 2`.
	 */
	it("emits one row per slot for a non-repeating role with several slots", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Tallying",
					roleKey: "ballot_counter",
				}),
			],
			ROLES,
			[
				slot("ballot_counter", "Ballot Counter", 0, "Ada"),
				slot("ballot_counter", "Ballot Counter", 1, "Grace"),
			],
		);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.who)).toEqual([
			"Tallying 1 · Ada",
			"Tallying 2 · Grace",
		]);
	});

	it("does NOT number a role that has a single slot", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Opening remarks",
					roleKey: "contest_chair",
				}),
			],
			ROLES,
			[slot("contest_chair", "Contest Chair", 0, "Ada")],
		);
		expect(rows[0]?.who).toBe("Opening remarks · Ada");
	});

	/**
	 * `expandRunSheet`'s speaker arm overrides both of these from the SLOT
	 * (`speechWindow` / `speechBookedMinutes`), which is why a contestant's
	 * 1/1.5/2 window vanished and every contestant rendered at 7 minutes.
	 */
	it("keeps the BEAT's marks and minutes on a speaker-category role", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Impromptu answer",
					minutes: 2,
					roleKey: "contestant",
					markGreen: 1,
					markYellow: 1.5,
					markRed: 2,
				}),
			],
			ROLES,
			[slot("contestant", "Contestant", 0)],
		);
		expect(rows[0]?.minutes).toBe(2);
		expect(rows[0]?.marks).toEqual({ green: 1, yellow: 1.5, red: 2 });
	});

	it("drops marks unless all three are present", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Speech",
					roleKey: "contestant",
					markGreen: 5,
					markYellow: null,
					markRed: 7,
				}),
			],
			ROLES,
			[slot("contestant", "Contestant", 0)],
		);
		expect(rows[0]?.marks).toBeNull();
	});

	it("emits a section as a section row, never a handoff", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "section",
					label: "PREPARED SPEECH CONTEST",
					minutes: 0,
				}),
			],
			ROLES,
			[],
		);
		expect(rows[0]).toMatchObject({
			who: "PREPARED SPEECH CONTEST",
			minutes: 0,
			section: true,
			roleKey: null,
		});
		expect(rows[0]?.handoff).toBeUndefined();
		expect(rows[0]?.marks).toBeNull();
	});

	it("renders an unfilled role as the bare label, not a dropped row", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Judges' briefing",
					roleKey: "contest_chair",
				}),
			],
			ROLES,
			[],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.who).toBe("Judges' briefing");
	});

	it("emits nothing for a repeat block whose role has no slots", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Contestant",
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
			beat({
				sortOrder: 1,
				kind: "event",
				label: "Silence",
				repeatsRoleKey: "contestant",
			}),
			beat({ sortOrder: 2, kind: "event", label: "Results" }),
		];
		const rows = buildTemplateRows(beats, ROLES, []);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.who).toBe("Results");
	});

	it("splits two adjacent repeat blocks that name different roles", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Speech",
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
			beat({
				sortOrder: 1,
				kind: "role",
				label: "Tally",
				roleKey: "ballot_counter",
				repeatsRoleKey: "ballot_counter",
			}),
		];
		const slots = [
			slot("contestant", "Contestant", 0),
			slot("contestant", "Contestant", 1),
			slot("ballot_counter", "Ballot Counter", 0),
		];
		expect(buildTemplateRows(beats, ROLES, slots)).toHaveLength(3);
	});

	it("caps the repeat expansion at MAX_ROLE_REPEAT_SLOTS", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Contestant",
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
		];
		const slots = Array.from({ length: 50 }, (_, i) =>
			slot("contestant", "Contestant", i),
		);
		expect(buildTemplateRows(beats, ROLES, slots)).toHaveLength(20);
	});

	it("drops a role beat whose roleKey names no template role", () => {
		expect(
			buildTemplateRows(
				[beat({ sortOrder: 0, kind: "role", label: "Ghost", roleKey: "nope" })],
				ROLES,
				[],
			),
		).toHaveLength(0);
	});

	it("carries flex through, and omits it otherwise", () => {
		const s = [slot("contest_chair", "Contest Chair", 0)];
		const withFlex = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "X",
					roleKey: "contest_chair",
					flex: true,
				}),
			],
			ROLES,
			s,
		);
		expect(withFlex[0]).toMatchObject({ flex: true });
		const without = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "X",
					roleKey: "contest_chair",
				}),
			],
			ROLES,
			s,
		);
		expect(without[0]?.flex).toBeUndefined();
	});

	it("orders by sortOrder regardless of input order", () => {
		const rows = buildTemplateRows(
			[
				beat({ sortOrder: 2, label: "third" }),
				beat({ sortOrder: 0, label: "first" }),
				beat({ sortOrder: 1, label: "second" }),
			],
			ROLES,
			[],
		);
		expect(rows.map((r) => r.who)).toEqual(["first", "second", "third"]);
	});

	it("truncates an oversized label and detail by code point", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "event",
					label: "x".repeat(500),
					detail: "y".repeat(2000),
				}),
			],
			ROLES,
			[],
		);
		expect([...(rows[0]?.who ?? "")]).toHaveLength(120);
		expect([...(rows[0]?.detail ?? "")]).toHaveLength(400);
	});

	it("does not split a surrogate pair when truncating", () => {
		const rows = buildTemplateRows(
			[beat({ sortOrder: 0, kind: "event", label: "🎤".repeat(200) })],
			ROLES,
			[],
		);
		const who = rows[0]?.who ?? "";
		expect([...who]).toHaveLength(120);
		expect(() => encodeURIComponent(who)).not.toThrow();
	});
});

describe("resolveAgendaRows", () => {
	it("returns the standard expansion when there is no template", () => {
		expect(
			resolveAgendaRows({
				geIntroducesFunctionaries: false,
				template: null,
				slots: [],
			}),
		).toEqual(
			expandRunSheet([], buildRunOfShow({ geIntroducesFunctionaries: false })),
		);
	});

	it("honours the club's GE variant when there is no template", () => {
		expect(
			resolveAgendaRows({
				geIntroducesFunctionaries: true,
				template: null,
				slots: [],
			}),
		).toEqual(
			expandRunSheet([], buildRunOfShow({ geIntroducesFunctionaries: true })),
		);
	});

	/**
	 * An empty template must NOT fall back to the standard flow. Doing so would
	 * render standard beats against template slots — and since no contest slot
	 * matches `toastmaster_of_the_day` or `speaker`, nearly every beat gates out
	 * and the officer gets a near-empty sheet with no error at all.
	 */
	it("does NOT fall back to the standard flow for an empty template", () => {
		const out = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			template: { beats: [], roles: [] },
			slots: [],
		});
		expect(out).toEqual([]);
		expect(out).not.toEqual(
			expandRunSheet([], buildRunOfShow({ geIntroducesFunctionaries: false })),
		);
	});

	it("ignores the GE variant on the template branch", () => {
		const template = {
			roles: ROLES,
			beats: [
				beat({ sortOrder: 0, kind: "event" as const, label: "Call to order" }),
			],
		};
		const a = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			template,
			slots: [],
		});
		const b = resolveAgendaRows({
			geIntroducesFunctionaries: true,
			template,
			slots: [],
		});
		expect(a).toEqual(b);
	});
});
