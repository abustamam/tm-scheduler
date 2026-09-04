import { describe, expect, it } from "vitest";
import {
	type AgendaSlot,
	buildRunOfShow,
	expandRunSheet,
	OPEN_LABEL,
	resolveAgendaRows,
} from "./agenda-runsheet";
import {
	buildTemplateRows,
	buildTemplateRowsWithSource,
	refreshTableTopicsMarks,
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
		// Derived from sortOrder so the ~30 pre-existing calls need no edit; an
		// explicit `id` in `over` still wins, which is what the provenance tests
		// below rely on.
		id: `b${over.sortOrder}`,
		kind: "event",
		label: "Beat",
		detail: null,
		minutes: 1,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
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
	 * A non-repeating role beat used to emit one row PER SLOT, so "Tallying" on a
	 * two-slot `ballot_counter` printed twice at ten minutes each — twenty
	 * minutes for one joint activity, on the clock the chair runs the night
	 * from. Repeating is what `repeatsRoleKey` is for; a plain role beat is one
	 * activity however many people hold the role.
	 */
	it("emits ONE row for a non-repeating role beat, naming every holder", () => {
		const beats: TemplateBeatRow[] = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Tallying",
				roleKey: "counter",
				minutes: 10,
			}),
		];
		const counterRoles: TemplateRoleRow[] = [
			{ key: "counter", name: "Ballot Counter", isSpeakerRole: false },
		];
		const rows = buildTemplateRows(beats, counterRoles, [
			slot("counter", "Ballot Counter", 0, "Ada"),
			slot("counter", "Ballot Counter", 1, "Grace"),
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.who).toBe("Tallying · Ada and Grace");
		expect(rows[0]?.holder).toBe("Ada and Grace");
		expect(rows[0]?.minutes).toBe(10);
	});

	it("still repeats a beat that declares repeatsRoleKey", () => {
		const beats: TemplateBeatRow[] = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Speech",
				roleKey: "speaker",
				repeatsRoleKey: "speaker",
				minutes: 7,
			}),
		];
		const speakerRoles: TemplateRoleRow[] = [
			{ key: "speaker", name: "Contestant", isSpeakerRole: true },
		];
		const rows = buildTemplateRows(beats, speakerRoles, [
			slot("speaker", "Contestant", 0, "Ada"),
			slot("speaker", "Contestant", 1, "Grace"),
		]);
		expect(rows.map((r) => r.who)).toEqual([
			"Speech 1 · Ada",
			"Speech 2 · Grace",
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

	/**
	 * Ship review C3. This is EXACTLY what "Add row: Role" produces:
	 * `addAgendaRow` inserts `templateId, sortOrder, kind, label, minutes` and
	 * nothing else, so `role_key` is null. It used to be dropped here, which
	 * meant the officer saw the card in the editor and it appeared on none of
	 * the four surfaces that read this function — the meeting page, the print
	 * sheet, the projected deck and the `.pptx`. The same state is one select
	 * away on an existing row, via the Role picker's "Nobody".
	 */
	it("renders a role row bound to NOBODY as a plain labelled beat", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "New item",
					minutes: 0,
					roleKey: null,
				}),
			],
			ROLES,
			[],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.who).toBe("New item");
		expect(rows[0]?.minutes).toBe(0);
		// No owner, so no role identity to colour by and no holder line.
		expect(rows[0]?.roleKey).toBeUndefined();
		expect(rows[0]?.holder).toBeUndefined();
		expect(rows[0]?.section).toBeUndefined();
	});

	/**
	 * The OTHER null-role case, which stays dropped: a beat naming a role the
	 * template does not declare. That is corruption, not authoring — there is
	 * no name to render it against — and the two must not collapse into one
	 * rule.
	 */
	it("still drops a role row naming a role the template does not declare", () => {
		const rows = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Ghost",
					roleKey: "no_such_role",
				}),
			],
			ROLES,
			[],
		);
		expect(rows).toEqual([]);
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

	// #task-10 review: the non-repeating branch had no analogue of the cap
	// above. It was never live while `defaultCount` was seed-fixed at small
	// numbers, but the per-meeting agenda editor (Task 8) makes a role's slot
	// count officer-editable, and a writer-side cap on `defaultCount` is not
	// the only way this number can grow past it (a pre-cap row, a direct
	// insert, or a copied template's un-revalidated count — see
	// `buildTemplateRows`'s docblock). Same fixture shape as the repeat-cap
	// test above, on the non-repeating path instead.
	it("caps a non-repeating role beat's holder list at MAX_ROLE_REPEAT_SLOTS too", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Tallying",
				roleKey: "ballot_counter",
			}),
		];
		const slots = Array.from({ length: 50 }, (_, i) =>
			slot("ballot_counter", "Ballot Counter", i, `Person${i}`),
		);
		const rows = buildTemplateRows(beats, ROLES, slots);
		// Still ONE row — capping the holder count must not turn it into one row
		// per slot, which is the exact defect this whole non-repeating branch
		// exists to avoid (see this function's docblock).
		expect(rows).toHaveLength(1);
		const holder = rows[0]?.holder ?? "";
		// The first 20 slots (indices 0..19) are named...
		expect(holder).toContain("Person0");
		expect(holder).toContain("Person19");
		// ...and nothing past the cap is, so the join cost — and the printed
		// line — cannot grow with an uncapped `defaultCount`.
		expect(holder).not.toContain("Person20");
		expect(holder).not.toContain("Person49");
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
					handoff: false,
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
				tableTopicsLimits: null,
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
				tableTopicsLimits: null,
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
			tableTopicsLimits: null,
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
			tableTopicsLimits: null,
			template,
			slots: [],
		});
		const b = resolveAgendaRows({
			geIntroducesFunctionaries: true,
			tableTopicsLimits: null,
			template,
			slots: [],
		});
		expect(a).toEqual(b);
	});
});

describe("a multi-holder row carries its names as DATA, not only as prose", () => {
	const NAMES = [
		"Faisal Ali",
		"Rehanna Khan",
		"Jagpal Singh",
		"Riyaz Mohammed",
	];
	const SLOTS = NAMES.map((n, i) => slot("contestant", "Contestant", i, n));
	/** A non-repeating role beat bound to four slots — what an officer gets by
	 *  unticking "one row per person" on a contest speech beat, so the printed
	 *  sheet stops asserting a speaking order that is drawn by lot on the day. */
	const SPEECHES = beat({
		sortOrder: 0,
		kind: "role",
		label: "Contest speeches",
		detail: "Qualifying window 4:30-7:30.",
		minutes: 32,
		roleKey: "contestant",
		markGreen: 5,
		markYellow: 6,
		markRed: 7,
	});

	it("exposes each holder separately as well as joined", () => {
		const [row] = buildTemplateRows([SPEECHES], ROLES, SLOTS);
		// The same reasoning as `AgendaRow.introduces` (#578): a joined string
		// forces every layout to accept one presentation. The editorial layout
		// needs to know there are FOUR to decide whether the list earns its own
		// line, and it cannot recover that from prose without parsing names.
		expect(row?.holders).toEqual(NAMES);
		// The joined form stays — every existing consumer reads it, and the
		// layouts that keep the list inline should not re-join it themselves.
		// Comma-tolerant: the serial comma is ICU's call, not this module's.
		expect(row?.holder).toMatch(
			/^Faisal Ali, Rehanna Khan, Jagpal Singh,? and Riyaz Mohammed$/,
		);
		expect(row?.roleLabel).toBe("Contest speeches");
	});

	it("numbers nothing when the beat does not repeat", () => {
		const [row] = buildTemplateRows([SPEECHES], ROLES, SLOTS);
		// Four contestants, one row, no "1". `numbered()` is passed total 0 on
		// this arm, so the label is the beat's own text — which is what lets a
		// contest agenda print without claiming an order nobody has drawn yet.
		expect(row?.roleLabel).not.toMatch(/\d/);
	});

	it("gives a single-holder row a one-element array, so the layout can tell", () => {
		const [row] = buildTemplateRows(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Tallying",
					roleKey: "ballot_counter",
				}),
			],
			ROLES,
			[slot("ballot_counter", "Ballot Counter", 0, "Muhammad Ali")],
		);
		// Length 1, not absent: "one holder" and "no holder" are different
		// facts, and the line-break rule keys on the count.
		expect(row?.holders).toEqual(["Muhammad Ali"]);
	});

	it("omits holders entirely on a row nobody holds", () => {
		const [row] = buildTemplateRows(
			[beat({ sortOrder: 0, label: "Two minutes of silence", minutes: 2 })],
			ROLES,
			[],
		);
		expect(row?.holders).toBeUndefined();
	});

	it("collapses repeated OPEN placeholders to one", () => {
		const [row] = buildTemplateRows(
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
				slot("ballot_counter", "Ballot Counter", 0),
				slot("ballot_counter", "Ballot Counter", 1),
			],
		);
		// Two unclaimed counters printed `Tallying · — open — and — open —` on
		// a real sheet (MCF, 2026-09-10). One placeholder carries the same
		// meaning; the row still prints, because a job nobody has taken is
		// precisely what the sheet exists to show (v1.24.0.0).
		expect(row?.holder).toBe(OPEN_LABEL);
		expect(row?.holders).toEqual([OPEN_LABEL]);
	});

	it("keeps ONE open placeholder beside the real names on a partly-claimed row", () => {
		const [row] = buildTemplateRows(
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
				slot("ballot_counter", "Ballot Counter", 0, "Muhammad Ali"),
				slot("ballot_counter", "Ballot Counter", 1),
				slot("ballot_counter", "Ballot Counter", 2),
			],
		);
		// Collapsed, not dropped: one counter is signed up and two are not, and
		// "Muhammad Ali and — open —" says so. Dropping the placeholder would
		// print a fully-staffed-looking row for a half-staffed job.
		expect(row?.holders).toEqual(["Muhammad Ali", OPEN_LABEL]);
	});
});

describe("buildTemplateRowsWithSource", () => {
	it("tags each row with its beat and iteration, and interleaves a repeat block", () => {
		const beats = [
			beat({
				id: "b-speech",
				sortOrder: 0,
				kind: "role",
				label: "Contest speech",
				minutes: 7,
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
			beat({
				id: "b-silence",
				sortOrder: 1,
				kind: "event",
				label: "One minute of silence",
				minutes: 1,
				repeatsRoleKey: "contestant",
			}),
		];
		const slots = [0, 1, 2].map((i) =>
			slot("contestant", "Contestant", i, `Speaker ${i + 1}`),
		);

		const out = buildTemplateRowsWithSource(beats, ROLES, slots);

		// Two beats × three contestants, INTERLEAVED: the expander emits a whole
		// block per iteration, so the speech beat owns positions 0, 2 and 4.
		// There is no contiguous run of its rows — which is exactly why the
		// editor bands by ITERATION and not by beat.
		expect(out.map((e) => e.beatId)).toEqual([
			"b-speech",
			"b-silence",
			"b-speech",
			"b-silence",
			"b-speech",
			"b-silence",
		]);
		expect(out.map((e) => e.iteration)).toEqual([0, 0, 1, 1, 2, 2]);
		expect(out.every((e) => e.iterationCount === 3)).toBe(true);
	});

	it("reports iteration 0 of 1 for a non-repeating beat", () => {
		const out = buildTemplateRowsWithSource(
			[
				beat({
					id: "b-open",
					sortOrder: 0,
					label: "Call to order",
					minutes: 5,
				}),
			],
			ROLES,
			[],
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.beatId).toBe("b-open");
		expect(out[0]?.iteration).toBe(0);
		expect(out[0]?.iterationCount).toBe(1);
	});

	it("tags a non-repeating ROLE beat, which names every holder on one row", () => {
		const out = buildTemplateRowsWithSource(
			[
				beat({
					id: "b-tally",
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
		// One row, two holders, iterationCount 1 — the editor must NOT band this,
		// because it is one activity rather than a repeat.
		expect(out).toHaveLength(1);
		expect(out[0]?.iterationCount).toBe(1);
		expect(out[0]?.row.holders).toEqual(["Ada", "Grace"]);
	});

	it("buildTemplateRows stays byte-identical to the sourced rows' .row", () => {
		// The wrapper must be faithful. Every pre-existing test in this file
		// asserts `buildTemplateRows`, so if this holds, they all still pin the
		// same behaviour through the new implementation.
		const beats = [
			beat({ id: "b1", sortOrder: 0, kind: "section", label: "OPENING" }),
			beat({
				id: "b2",
				sortOrder: 1,
				kind: "role",
				label: "Contest speech",
				minutes: 7,
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
		];
		const slots = [
			slot("contestant", "Contestant", 0, "Ada"),
			slot("contestant", "Contestant", 1, "Grace"),
		];
		expect(buildTemplateRows(beats, ROLES, slots)).toEqual(
			buildTemplateRowsWithSource(beats, ROLES, slots).map((e) => e.row),
		);
	});

	it("resolves detail tokens instead of printing them", () => {
		// Storing detail as plain text is what would have made an adopted agenda
		// print a literal {role:general_evaluator}. The template path now speaks the
		// same token vocabulary the printed row always has.
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Chair",
				roleKey: "contest_chair",
				detail: "Introduces the {role:general_evaluator}",
				handoff: true,
			}),
		];
		const slots = [
			slot("contest_chair", "Contest Chair", 0),
			slot("general_evaluator", "General Evaluator", 0),
		];
		const rows = buildTemplateRows(beats, ROLES, slots);
		expect(rows[0]?.detail).not.toContain("{");
		expect(rows[0]?.detail).toContain("General Evaluator");
		expect(rows[0]?.handoff).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// #679 — the Table Topics segment's marks follow the CLUB, not the snapshot.
//
// `materialiseRunOfShow` freezes the club's marks into the stored row and
// `resolveMarks` makes that copy authoritative, so a club that edited its
// window afterwards kept the old numbers on every already-materialised meeting
// — while the Timer's printed role sheet re-derived from the live columns. One
// packet, two different Table Topics windows, stapled together.
//
// Every expected value below is ABSOLUTE. Stated as
// `resolveTableTopicsMarks(CLUB).green` they would pass for every derivation,
// including the frozen one this exists to replace.
// ---------------------------------------------------------------------------
describe("refreshTableTopicsMarks (#679)", () => {
	const TTM_ROLES: TemplateRoleRow[] = [
		{
			key: "table_topics_master",
			name: "Table Topics Master",
			isSpeakerRole: false,
		},
	];
	/** MCF's window: 1:00–2:30, midpoint 1:45. */
	const MCF = { minSeconds: 60, maxSeconds: 150 };
	/** What materialisation freezes for a club that had stated nothing. */
	const FROZEN_STANDARD = { markGreen: 1, markYellow: 1.5, markRed: 2 };

	/** The materialised segment: a ROLE beat with the Table Topics key that
	 *  carries marks. `flex` is set because the real one has it, and is
	 *  deliberately NOT part of the predicate — see the `flex: false` case. */
	const segment = (over: Partial<TemplateBeatRow> = {}) =>
		beat({
			sortOrder: 0,
			kind: "role",
			label: "Table Topics Master",
			roleKey: "table_topics_master",
			flex: true,
			...FROZEN_STANDARD,
			...over,
		});

	const marksOf = (b: TemplateBeatRow | undefined) => ({
		green: b?.markGreen,
		yellow: b?.markYellow,
		red: b?.markRed,
	});

	it("replaces the frozen marks with the club's current window", () => {
		const [out] = refreshTableTopicsMarks([segment()], MCF);
		expect(marksOf(out)).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
	});

	it("keeps following the club after an officer PINS the row (flex: false)", () => {
		// The predicate must not read `flex`. The agenda editor's "Pin" button
		// sets `flex: false` in one click — it is about the segment's LENGTH — and
		// a predicate keyed on it would let that one click silently detach the
		// timing from club settings, re-creating the packet whose run sheet and
		// Timer card disagree. The Timer's role sheet has no equivalent opt-out,
		// so there is nothing on the other side to match.
		//
		// This case is also the mutation gate the first cut lacked: re-adding
		// `beat.flex === true` to `isTableTopicsSegment` fails HERE and nowhere
		// else, because every other fixture that excludes a row also excludes it
		// on the marks or roleKey clause.
		const pinned = refreshTableTopicsMarks([segment({ flex: false })], MCF);
		expect(marksOf(pinned[0])).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
	});

	it("restores the standard window when a club CLEARS its own", () => {
		// The direction a "refresh only when the stored marks are the default"
		// trigger cannot handle, and the reason the trigger is identity instead.
		const frozenClub = segment({
			markGreen: 1,
			markYellow: 1.75,
			markRed: 2.5,
		});
		expect(marksOf(refreshTableTopicsMarks([frozenClub], null)[0])).toEqual({
			green: 1,
			yellow: 1.5,
			red: 2,
		});
	});

	it("leaves an over-ceiling or inverted row on the standard window", () => {
		// `resolveTableTopicsMarks` is fail-safe, and this inherits that: a row a
		// script wrote past the cap must not reach the Timer's card through here.
		for (const bad of [
			{ minSeconds: 60, maxSeconds: 99999 },
			{ minSeconds: 150, maxSeconds: 60 },
			{ minSeconds: 60, maxSeconds: null },
		]) {
			expect(marksOf(refreshTableTopicsMarks([segment()], bad)[0])).toEqual({
				green: 1,
				yellow: 1.5,
				red: 2,
			});
		}
	});

	it("touches ONLY the segment — not the vote, the hand-off, or another role", () => {
		// The run of show gives THREE beats `table_topics_master` and `beatSeed`
		// labels all three "Table Topics Master", so neither the key nor the label
		// identifies the row. What separates them is that only the segment CARRIES
		// MARKS — verified against a real materialised template, which holds three
		// rows with that key and one with marks.
		const beats = [
			segment(),
			// The Best Table Topics vote: same key and label, no marks.
			beat({
				sortOrder: 1,
				kind: "role",
				label: "Table Topics Master",
				roleKey: "table_topics_master",
			}),
			// The GE hand-off: same again.
			beat({
				sortOrder: 2,
				kind: "role",
				label: "Table Topics Master",
				roleKey: "table_topics_master",
				handoff: true,
			}),
			// A different role that DOES carry marks — the evaluation window.
			beat({
				sortOrder: 3,
				kind: "role",
				label: "Evaluator",
				roleKey: "evaluator",
				markGreen: 2,
				markYellow: 2.5,
				markRed: 3,
			}),
		];
		const out = refreshTableTopicsMarks(beats, MCF);
		expect(marksOf(out[0])).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
		expect(marksOf(out[1])).toEqual({
			green: null,
			yellow: null,
			red: null,
		});
		expect(marksOf(out[2])).toEqual({
			green: null,
			yellow: null,
			red: null,
		});
		expect(marksOf(out[3])).toEqual({ green: 2, yellow: 2.5, red: 3 });
		// Everything else about the segment survives — this rewrites three fields,
		// not the row.
		expect({ ...out[0], ...FROZEN_STANDARD }).toEqual(segment());
	});

	it("does not INVENT marks on a row that has none", () => {
		// `addAgendaRow` writes null marks, so an officer who adds a row and points
		// it at the Table Topics Master must not watch a timer card appear — and an
		// officer who deliberately cleared all three (legal: `assertMarks` allows 0
		// or 3) must not watch them come back.
		const cleared = segment({
			markGreen: null,
			markYellow: null,
			markRed: null,
		});
		expect(marksOf(refreshTableTopicsMarks([cleared], MCF)[0])).toEqual({
			green: null,
			yellow: null,
			red: null,
		});
	});

	it("ignores a PARTIAL mark set, one clause at a time", () => {
		// The predicate tests all three columns separately, so a fixture that nulls
		// all three leaves any ONE of the clauses deletable with the suite green.
		// Each case below is the only thing excluding its row.
		//
		// Reachable rather than theoretical: `assertMarks` allows 0 or 3 on the
		// write path, but these rows predate it and a script writes what it likes.
		// `resolveMarks` collapses a partial set to null, so refreshing one would
		// mean the editor showing a timer card the printed sheet does not.
		for (const hole of ["markGreen", "markYellow", "markRed"] as const) {
			const partial = segment({ [hole]: null });
			expect(
				marksOf(refreshTableTopicsMarks([partial], MCF)[0]),
				`${hole} alone must exclude the row`,
			).toEqual(marksOf(partial));
		}
	});

	it("ignores a SECTION row that happens to carry the key", () => {
		const band = segment({ kind: "section", label: "TABLE TOPICS" });
		expect(marksOf(refreshTableTopicsMarks([band], MCF)[0])).toEqual({
			green: 1,
			yellow: 1.5,
			red: 2,
		});
	});

	it("reaches the printed rows through resolveAgendaRows", () => {
		// The seam every render surface actually uses. The unit assertions above
		// prove the transform; this proves it is WIRED, which is the half #443
		// shipped wrong twice — a correct derivation nothing called.
		const rows = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: MCF,
			template: { beats: [segment()], roles: TTM_ROLES },
			slots: [slot("table_topics_master", "Table Topics Master", 0, "Ada")],
		});
		expect(rows[0]?.marks).toEqual({ green: 1, yellow: 1.75, red: 2.5 });

		// PRE-FIX CONTROL: the same call with the club's window omitted from the
		// template branch is what shipped, and it printed the frozen 1/1.5/2.
		// Without this the assertion above could pass on a fixture that happened
		// to be frozen at the club's numbers already.
		expect(
			buildTemplateRows([segment()], TTM_ROLES, [
				slot("table_topics_master", "Table Topics Master", 0, "Ada"),
			])[0]?.marks,
		).toEqual({ green: 1, yellow: 1.5, red: 2 });
	});
});
