/**
 * Which slots may carry a recorded time (#730).
 *
 * The ENROLLMENT SWEEP at the bottom is the assertion that matters, and it is
 * copied in shape from `role-duties.test.ts`'s: a roster of the three roles
 * that qualify only proves those three, while a partition over both shipped
 * templates also proves the fifteen that do not — and catches the next marked
 * speaker-ish seed with a red test rather than with somebody's memory.
 */
import { describe, expect, it } from "vitest";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import {
	isTimeableRole,
	TimingNotRecordableError,
	timingNotRecordableMessage,
} from "./timeable-roles";

/** Look a template seed up by key, so a test names a ROLE rather than an index. */
const seed = (key: string) => {
	const found = [...ROLE_TEMPLATE, ...CONTEST_TEMPLATE.roles].find(
		(r) => r.key === key,
	);
	if (!found) throw new Error(`no template seed keyed ${key}`);
	return found;
};

describe("both arms of the rule", () => {
	it("admits an isSpeakerRole slot", () => {
		expect(isTimeableRole({ isSpeakerRole: true, category: "speaker" })).toBe(
			true,
		);
	});

	it("admits an evaluator-category slot even though it is NOT isSpeakerRole", () => {
		// The second arm is not decoration: `ROLE_TEMPLATE`'s Evaluator is
		// `isSpeakerRole: false`, so the flag alone would refuse to record every
		// evaluation in the club — the half of the timed agenda #507 added marks
		// to.
		expect(seed("evaluator").isSpeakerRole).toBe(false);
		expect(
			isTimeableRole({ isSpeakerRole: false, category: "evaluator" }),
		).toBe(true);
	});

	it("refuses a slot that is neither", () => {
		expect(
			isTimeableRole({ isSpeakerRole: false, category: "functionary" }),
		).toBe(false);
	});
});

describe("the roles this admits and refuses, by key", () => {
	for (const key of ["speaker", "contestant_prepared", "evaluator"]) {
		it(`${key} is timeable`, () => {
			expect(isTimeableRole(seed(key))).toBe(true);
		});
	}

	it("the General Evaluator is NOT timeable", () => {
		// Settled in `role-template.ts`, not decided here: the GE runs the
		// evaluation team rather than evaluating a speech, so it is `leadership`
		// and is not a Best Evaluator candidate either.
		expect(seed("general_evaluator").category).toBe("leadership");
		expect(isTimeableRole(seed("general_evaluator"))).toBe(false);
	});

	it("the Table Topics Master is NOT timeable — the trap this exists for", () => {
		// The Table Topics segment is ONE `AgendaRow` binding the TTM's slot, and
		// it carries marks. Without this refusal, a Timer stopping that clock
		// stores one number for a segment with four to eight speakers, attributed
		// to the person who asked the questions — no constraint violated, nothing
		// logged, simply wrong.
		expect(isTimeableRole(seed("table_topics_master"))).toBe(false);
	});

	for (const key of ["timer", "ah_counter", "grammarian", "vote_counter"]) {
		it(`the ${key} is NOT timeable`, () => {
			expect(isTimeableRole(seed(key))).toBe(false);
		});
	}

	it("no functionary in either template is timeable", () => {
		// A partition rather than the four named above, so a functionary that
		// silently gains the flag fails here.
		for (const r of [...ROLE_TEMPLATE, ...CONTEST_TEMPLATE.roles]) {
			if (r.category !== "functionary") continue;
			expect(isTimeableRole(r), `${r.name} (${r.key})`).toBe(false);
		}
	});

	it("a club-invented role is refused by default", () => {
		// Every club-invented role is `functionary`/`leadership` with no speaker
		// flag unless an admin says otherwise, and the columns are the answer —
		// there is deliberately no name fallback to reach for.
		expect(
			isTimeableRole({ isSpeakerRole: false, category: "leadership" }),
		).toBe(false);
	});
});

describe("the enrollment sweep over BOTH templates", () => {
	it("EVERY isSpeakerRole seed in EVERY template is timeable", () => {
		// `ROLE_TEMPLATE` is not the whole universe of `role_definitions.key`, and
		// reading it as if it were is exactly how the contest Contestant was
		// missed by the duty registry's first cut. Everywhere else in the app
		// "is this slot a speech?" is read off the `isSpeakerRole` COLUMN, so any
		// seed carrying that flag must be recordable.
		const speakerSeeds = [...ROLE_TEMPLATE, ...CONTEST_TEMPLATE.roles].filter(
			(r) => r.isSpeakerRole,
		);
		expect(speakerSeeds.length).toBeGreaterThan(1); // not vacuous
		for (const s of speakerSeeds) {
			expect(isTimeableRole(s), `${s.name} (${s.key})`).toBe(true);
		}
	});

	it("the contest Contestant is one of them, and it is the costly one to miss", () => {
		// `contest-template.ts` is the ONLY beat in either shipped template
		// authored with hardcoded marks AND a stated qualifying window, and it
		// sets `repeatsRoleKey`, so `oneSlot` is set and `slotId` IS populated. A
		// hand-written `["speaker", "evaluator"]` list would render that clock and
		// then refuse to store it, on the one meeting shape where the window is
		// the disqualification rule rather than a courtesy.
		const contestant = CONTEST_TEMPLATE.roles.find(
			(r) => r.key === "contestant_prepared",
		);
		expect(contestant?.isSpeakerRole).toBe(true);
		expect(
			isTimeableRole(
				contestant as { isSpeakerRole: boolean; category: string },
			),
		).toBe(true);
	});

	it("every evaluator-category seed in EVERY template is timeable", () => {
		const evaluatorSeeds = [...ROLE_TEMPLATE, ...CONTEST_TEMPLATE.roles].filter(
			(r) => r.category === "evaluator",
		);
		expect(evaluatorSeeds.length).toBeGreaterThan(0); // not vacuous
		for (const s of evaluatorSeeds) {
			expect(isTimeableRole(s), `${s.name} (${s.key})`).toBe(true);
		}
	});
});

describe("the refusal", () => {
	it("names the role, so a Timer knows which card refused", () => {
		const err = new TimingNotRecordableError("Table Topics Master");
		expect(err.roleName).toBe("Table Topics Master");
		expect(err.message).toContain("Table Topics Master");
	});

	it("is a distinct name, so a caller can tell it from an authorization failure", () => {
		// "You're not allowed" and "there is nothing to record this against" send
		// the Timer to two completely different places.
		expect(new TimingNotRecordableError("Timer").name).toBe(
			"TimingNotRecordableError",
		);
		expect(new TimingNotRecordableError("Timer").message).not.toMatch(
			/permission|allowed|authoriz/i,
		);
	});

	it("exposes the message on its own, for a surface with no error to catch", () => {
		expect(timingNotRecordableMessage("Ah-Counter")).toBe(
			new TimingNotRecordableError("Ah-Counter").message,
		);
	});
});

describe("the module stays client-safe", () => {
	it("imports nothing at all", async () => {
		// A db import here would make the module unimportable from the
		// session-less client route that reads it (`pg` drags in `Buffer` and
		// white-screens the page) AND unreachable from this test. Asserted over
		// the SOURCE, because a passing import in vitest proves only that node
		// could load it.
		const { readFileSync } = await import("node:fs");
		const { resolve, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const src = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), "timeable-roles.ts"),
			"utf8",
		);
		const specifiers = [...src.matchAll(/^import .*from\s+"([^"]+)"/gm)].map(
			(m) => m[1],
		);
		expect(specifiers).toEqual([]);
	});
});
