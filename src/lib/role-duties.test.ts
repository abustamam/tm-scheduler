/**
 * The role duty registry (#660).
 *
 * Two things here are deliberately built as PARTITIONS over `ROLE_TEMPLATE`
 * rather than as a roster of the three roles that own something. A roster only
 * proves the three it names; a partition also proves the six it does not, so a
 * standard role that silently gains or loses a duty fails — which is the whole
 * failure mode this registry has, given that its consumers ask it what a role
 * still owes and stay quiet when the answer is nothing.
 *
 * `ROLE_TEMPLATE` is NOT the whole universe of `role_definitions.key`, and
 * reading that partition as if it were is how the contest contestant was missed:
 * `CONTEST_TEMPLATE` seeds its own roles, one of them `isSpeakerRole`, and a
 * sweep over the standard template alone cannot see it. So the speech duty has
 * its own enrollment gate below, over EVERY role seed in BOTH templates, keyed
 * on the `isSpeakerRole` flag rather than on a list of names anyone has to
 * remember to extend.
 *
 * The `done` matrix asserts the negative direction too: each predicate must
 * read ITS OWN context field and no other. Three predicates over one flat
 * context object is exactly the shape a copy-paste gets wrong, and a
 * cross-wired one passes every "is it done when set?" assertion while nudging
 * a Grammarian about a theme somebody else already set.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { readSource } from "#/test/guard-source";
import {
	type DutyContext,
	type DutyId,
	dutiesForRole,
	ROLE_CONFIRM_PROMPT,
	type RoleDuty,
} from "./role-duties";

const TARGET = { clubId: "harbor-city", meetingId: "2026-09-15" };

/** Every duty the registry can hand out, reached the way a consumer reaches it. */
const ALL_DUTIES: RoleDuty[] = ROLE_TEMPLATE.flatMap((r) => [
	...dutiesForRole({ roleName: r.name, roleKey: r.key }),
]);

/** Which context field each duty is supposed to read — and, by omission, which
 *  ones it must ignore. */
const FIELD_BY_DUTY: Record<DutyId, keyof DutyContext> = {
	meeting_theme: "theme",
	word_of_the_day: "wordOfTheDay",
	speech_details: "speechTitle",
};

const dutyIds = (role: { roleName: string; roleKey?: string | null }) =>
	dutiesForRole(role).map((d) => d.id);

describe("which role owns which duty", () => {
	it("the Toastmaster of the Day owns the meeting theme", () => {
		expect(
			dutyIds({
				roleName: "Toastmaster of the Day",
				roleKey: "toastmaster_of_the_day",
			}),
		).toEqual(["meeting_theme"]);
	});

	it("the Grammarian owns the Word of the Day", () => {
		expect(dutyIds({ roleName: "Grammarian", roleKey: "grammarian" })).toEqual([
			"word_of_the_day",
		]);
	});

	it("a Speaker owns their own speech details", () => {
		expect(dutyIds({ roleName: "Speaker", roleKey: "speaker" })).toEqual([
			"speech_details",
		]);
	});

	it("exactly three standard roles own a duty, and it is these three", () => {
		const owners = ROLE_TEMPLATE.filter(
			(r) => dutiesForRole({ roleName: r.name, roleKey: r.key }).length > 0,
		)
			.map((r) => r.key)
			.sort();
		expect(owners).toEqual(["grammarian", "speaker", "toastmaster_of_the_day"]);
	});

	it("every other standard role owns nothing — prep with nowhere to record it is not a duty", () => {
		const owners = new Set(["grammarian", "speaker", "toastmaster_of_the_day"]);
		for (const r of ROLE_TEMPLATE) {
			if (owners.has(r.key)) continue;
			expect(
				dutiesForRole({ roleName: r.name, roleKey: r.key }),
				`${r.name} must own no duty`,
			).toEqual([]);
		}
	});

	it("a contest Contestant owns their speech details too", () => {
		// `contest-template.ts` marks `contestant_prepared` its only
		// `isSpeakerRole` def and says a contest speech is still a speech. Keying
		// the duty on `speaker` alone left the one person in the room who
		// demonstrably owes a speech owning nothing.
		expect(
			dutyIds({ roleName: "Contestant", roleKey: "contestant_prepared" }),
		).toEqual(["speech_details"]);
	});

	it("EVERY isSpeakerRole seed in EVERY template owns the speech duty", () => {
		// The enrollment gate. Everywhere else in the app "is this a speech slot?"
		// is read off the `isSpeakerRole` COLUMN, so any seed carrying that flag
		// gets a `speeches` row and owes a title. This sweeps both templates so
		// the next one is caught by a failing test rather than by memory.
		const speakerSeeds = [...ROLE_TEMPLATE, ...CONTEST_TEMPLATE.roles].filter(
			(r) => r.isSpeakerRole,
		);
		expect(speakerSeeds.length).toBeGreaterThan(1); // not vacuous
		for (const seed of speakerSeeds) {
			expect(
				dutyIds({ roleName: seed.name, roleKey: seed.key }),
				`${seed.name} (${seed.key}) is isSpeakerRole and must owe a speech`,
			).toContain("speech_details");
		}
	});

	it("resolves every key both templates define, without throwing", () => {
		for (const r of [...ROLE_TEMPLATE, ...CONTEST_TEMPLATE.roles]) {
			expect(() =>
				dutiesForRole({ roleName: r.name, roleKey: r.key }),
			).not.toThrow();
		}
	});

	it("resolves every key the standard template defines, without throwing", () => {
		for (const r of ROLE_TEMPLATE) {
			expect(() =>
				dutiesForRole({ roleName: r.name, roleKey: r.key }),
			).not.toThrow();
		}
	});
});

describe("resolution is by key, with an exact-name fallback (#368/#464)", () => {
	it("an unknown key owns nothing rather than throwing", () => {
		expect(
			dutiesForRole({
				roleName: "Sergeant at Arms",
				roleKey: "sergeant_at_arms",
			}),
		).toEqual([]);
	});

	it("a club-invented role (key NULL) owns nothing", () => {
		expect(dutiesForRole({ roleName: "Meeting Buddy", roleKey: null })).toEqual(
			[],
		);
	});

	it("an absent key is the same as a null one", () => {
		expect(dutiesForRole({ roleName: "Meeting Buddy" })).toEqual([]);
	});

	it("an empty-string key is a key, not an absent one — no name fallback", () => {
		// `"" != null`, so this takes the KEY arm and fails closed. Pinning it
		// because the choice is deliberate and reversible by accident: a refactor
		// from `!= null` to a truthy check would send this row to the name pass,
		// where the canonical name below WOULD match and grant the duty. That is
		// the #464 shape reached from the other direction.
		expect(
			dutyIds({ roleName: "Toastmaster of the Day", roleKey: "" }),
		).toEqual([]);
	});

	it("a key of __proto__ or constructor owns nothing", () => {
		// The registry is a `Map` for exactly this reason, and the reason was
		// asserted nowhere: an object literal answers `constructor` with
		// `Object`, so `dutiesForRole` would hand a consumer a FUNCTION typed as
		// a duty array and its `.map()` would throw. Swapping the Map for an
		// object now fails here instead of in a club's browser.
		for (const hazard of ["__proto__", "constructor", "toString", "valueOf"]) {
			expect(
				dutiesForRole({ roleName: "Meeting Buddy", roleKey: hazard }),
				`roleKey ${hazard} must own no duty`,
			).toEqual([]);
		}
	});

	it("a KEYED role never falls through to the name fallback", () => {
		// #464 in the exact shape that caused it: a role NAMED like the
		// Toastmaster but keyed as something else must not inherit the duty. The
		// key is the identity; the name only looks like one.
		expect(
			dutyIds({
				roleName: "Toastmaster of the Day",
				roleKey: "table_topics_master",
			}),
		).toEqual([]);
	});

	it("the name fallback matches the canonical name exactly, never a prefix", () => {
		for (const lookalike of [
			"Toastmaster Assistant",
			"Toastmaster Evaluator",
			"Toastmaster's Helper",
			"Grammarian Assistant",
			"Grammarians",
			"Speaker Coach",
		]) {
			expect(
				dutiesForRole({ roleName: lookalike, roleKey: null }),
				`"${lookalike}" must own no duty`,
			).toEqual([]);
		}
	});

	it("a numbered slot label is NOT a role name (#319 shape)", () => {
		// `slotLabel` appends an ordinal when a role's count exceeds one, and
		// Speaker's default count is 3 — so "Speaker 2" is the NORMAL value of the
		// string the meeting route already holds under a `roleName`-ish name.
		// `roleName` must be `role_definitions.name`, never a slot label. Do NOT
		// "fix" this by loosening the match to a prefix: that is the #464 hole.
		expect(dutiesForRole({ roleName: "Speaker 2", roleKey: null })).toEqual([]);
	});

	it("the name fallback ignores case and surrounding whitespace", () => {
		expect(
			dutyIds({ roleName: "  toastmaster OF the Day  ", roleKey: null }),
		).toEqual(["meeting_theme"]);
		expect(dutyIds({ roleName: "GRAMMARIAN", roleKey: null })).toEqual([
			"word_of_the_day",
		]);
		expect(dutyIds({ roleName: " speaker ", roleKey: null })).toEqual([
			"speech_details",
		]);
	});

	it('the bare "Toastmaster" the standard template answers to also resolves', () => {
		expect(dutyIds({ roleName: "Toastmaster", roleKey: null })).toEqual([
			"meeting_theme",
		]);
	});
});

describe("done predicates", () => {
	it("the registry hands out a duty for every field this matrix covers", () => {
		// Guards the matrix below against vacuity: if `ALL_DUTIES` were empty
		// every `for` loop in this describe would pass having asserted nothing.
		expect(ALL_DUTIES.map((d) => d.id).sort()).toEqual(
			Object.keys(FIELD_BY_DUTY).sort(),
		);
	});

	for (const state of [
		{ label: "an absent field", value: undefined },
		{ label: "an explicit null", value: null },
		{ label: "an empty string", value: "" },
		{ label: "whitespace only", value: "   " },
	]) {
		it(`treats ${state.label} as NOT done`, () => {
			for (const duty of ALL_DUTIES) {
				const ctx = { [FIELD_BY_DUTY[duty.id]]: state.value } as DutyContext;
				expect(duty.done(ctx), `${duty.id} with ${state.label}`).toBe(false);
			}
		});
	}

	it("treats a filled field as done", () => {
		for (const duty of ALL_DUTIES) {
			const ctx = { [FIELD_BY_DUTY[duty.id]]: "Perseverance" } as DutyContext;
			expect(duty.done(ctx), `${duty.id} with a value`).toBe(true);
		}
	});

	it("treats a value padded with whitespace as done", () => {
		for (const duty of ALL_DUTIES) {
			const ctx = {
				[FIELD_BY_DUTY[duty.id]]: "  Perseverance  ",
			} as DutyContext;
			expect(duty.done(ctx), `${duty.id} with a padded value`).toBe(true);
		}
	});

	it("does NOT treat the TBA sentinel as a finished speech", () => {
		// `speeches.title` is NOT NULL, so a speaker who leaves the title blank
		// while picking a project has "TBA" STORED — `normalizeSpeech`'s own
		// `hasRealTitle` says that is not a real title. A plain non-blank check
		// read it as done and silently suppressed the nudge.
		const speech = ALL_DUTIES.find((d) => d.id === "speech_details");
		expect(
			speech,
			"the speech duty must exist for this to mean anything",
		).toBeDefined();
		for (const placeholder of ["TBA", "  TBA  "]) {
			expect(
				speech?.done({ speechTitle: placeholder }),
				`a stored title of ${JSON.stringify(placeholder)} is not a speech`,
			).toBe(false);
		}
		// A real title that merely contains the sentinel still counts.
		expect(speech?.done({ speechTitle: "How TBA Ruined My Talk" })).toBe(true);
	});

	it("is not done on an empty context", () => {
		for (const duty of ALL_DUTIES) {
			expect(duty.done({}), `${duty.id} on {}`).toBe(false);
		}
	});

	it("reads its OWN field and no other", () => {
		for (const duty of ALL_DUTIES) {
			const mine = FIELD_BY_DUTY[duty.id];
			const others = Object.values(FIELD_BY_DUTY).filter((f) => f !== mine);
			const ctx = Object.fromEntries(
				others.map((f) => [f, "somebody else's answer"]),
			) as DutyContext;
			expect(
				duty.done(ctx),
				`${duty.id} must not read ${others.join(" or ")}`,
			).toBe(false);
		}
	});
});

describe("every duty is safe to interpolate", () => {
	it("has a unique, stable id", () => {
		const ids = ALL_DUTIES.map((d) => d.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("has a non-blank label and nudge clause", () => {
		for (const duty of ALL_DUTIES) {
			expect(duty.label.trim(), `${duty.id} label`).not.toBe("");
			expect(duty.clause.trim(), `${duty.id} clause`).not.toBe("");
		}
	});

	it("has an app-relative href carrying both route params", () => {
		for (const duty of ALL_DUTIES) {
			const href = duty.href(TARGET);
			expect(href.startsWith("/"), `${duty.id} href must be app-relative`).toBe(
				true,
			);
			expect(href, `${duty.id} href`).toContain(TARGET.clubId);
			expect(href, `${duty.id} href`).toContain(TARGET.meetingId);
		}
	});
});

describe("the registry is a frozen singleton", () => {
	// `readonly` is compile-time only. These assert the RUNTIME half, because
	// every caller shares one array and one set of duty objects: a consumer that
	// mutated either would change the answer for every later caller in the
	// process, and on the server that process answers for every club.
	it("hands every caller the same array instance", () => {
		expect(
			dutiesForRole({ roleName: "Grammarian", roleKey: "grammarian" }),
		).toBe(dutiesForRole({ roleName: "Grammarian", roleKey: "grammarian" }));
	});

	it("refuses a push onto a returned duty list", () => {
		const duties = dutiesForRole({ roleName: "Speaker", roleKey: "speaker" });
		expect(Object.isFrozen(duties)).toBe(true);
		expect(() => (duties as RoleDuty[]).push(duties[0])).toThrow();
		expect(
			dutiesForRole({ roleName: "Speaker", roleKey: "speaker" }),
		).toHaveLength(1);
	});

	it("refuses a rewrite of a duty's done predicate", () => {
		// The worst version of this bug: a `done` that always returns true
		// suppresses the nudge for that duty everywhere, silently.
		const [duty] = dutiesForRole({
			roleName: "Toastmaster of the Day",
			roleKey: "toastmaster_of_the_day",
		});
		expect(Object.isFrozen(duty)).toBe(true);
		expect(() => {
			// The cast keeps `done`'s real signature — narrowing it to `() =>
			// boolean` does not overlap and fails typecheck, which vitest alone
			// would have shipped green.
			(duty as { done: (ctx: DutyContext) => boolean }).done = () => true;
		}).toThrow();
		expect(duty.done({})).toBe(false);
	});

	it("freezes the shared empty result too", () => {
		const none = dutiesForRole({ roleName: "Timer", roleKey: "timer" });
		expect(Object.isFrozen(none)).toBe(true);
	});
});

describe("the confirm-only prompt, for a role that owns nothing", () => {
	it("has a non-blank label and clause", () => {
		expect(ROLE_CONFIRM_PROMPT.label.trim()).not.toBe("");
		expect(ROLE_CONFIRM_PROMPT.clause.trim()).not.toBe("");
	});

	it("links to the club's own roles guide", () => {
		expect(ROLE_CONFIRM_PROMPT.href(TARGET)).toBe(
			`/club/${TARGET.clubId}/roles-guide`,
		);
	});

	it("carries NO done predicate — an unverifiable tick must never suppress a nudge", () => {
		// The reason every other role owns zero duties. If this ever grows a
		// `done`, a self-report becomes indistinguishable from a recorded answer
		// to every consumer that filters on it.
		expect("done" in ROLE_CONFIRM_PROMPT).toBe(false);
	});
});

describe("the registry stays pure", () => {
	// TWO reads of the same file, because this block makes BOTH kinds of source
	// assertion and `src/test/guard-source.ts` gives them opposite rules.
	//
	// RAW is for "the offender list must be empty": a comment there can only
	// produce a false FAILURE, which a human sees immediately, whereas stripping
	// comments would LOOSEN the check. Consequence worth knowing:
	// `role-duties.ts` must discuss the database in PROSE, because a comment
	// quoting a forbidden import specifier fails the sweep below.
	//
	// COMMENT-BLIND is for "this pattern must BE present": read raw, a file that
	// merely MENTIONS the import in a comment satisfies the assertion exactly as
	// well as the real import does, so the thing being protected becomes
	// deletable with the guard still green. That is the bypass `readSource`
	// exists to close, and it is the same split `club-index-wiring.guard.test.ts`
	// makes. Bundling both halves onto one raw read was this file's own bug.
	const SOURCE_PATH = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"role-duties.ts",
	);
	const SOURCE = readFileSync(SOURCE_PATH, "utf8");
	const SOURCE_CODE_ONLY = readSource(SOURCE_PATH);

	it("imports nothing from the database layer", () => {
		// Both spellings of the alias, plus the driver itself. A db import here
		// is not a style violation: it makes the module unimportable from a
		// client route (`pg` drags in `Buffer`) AND unreachable from a unit test
		// (`DATABASE_URL is not set` at load), which is what puts the numbers and
		// predicates in `src/lib` in the first place.
		for (const forbidden of [
			"#/db",
			"@/db",
			"drizzle-orm",
			"node-postgres",
			'"pg"',
		]) {
			expect(SOURCE, `must not import ${forbidden}`).not.toContain(forbidden);
		}
		// A RELATIVE import evades every specifier above — `../db` reaches the
		// same module, and `./club-logic` reaches it transitively. Whitelisting
		// the imports instead of blacklisting the spellings is what makes this
		// closed rather than a list of the three ways anyone thought of.
		const specifiers = [...SOURCE_CODE_ONLY.matchAll(/from\s+"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(specifiers.length, "the import scan found nothing").toBeGreaterThan(
			0,
		);
		const ALLOWED = ["#/lib/meeting-roles", "#/lib/speech-title"];
		expect(specifiers.filter((s) => !ALLOWED.includes(s))).toEqual([]);
	});

	it("shares the capability role keys instead of redeclaring them", () => {
		// A second copy of `toastmaster_of_the_day` or `grammarian` is the drift
		// that #464 and #445 were both caused by. The keys are exported from
		// `meeting-roles.ts`; this module must import them, not spell them again.
		//
		// The import must be REAL, so it is checked comment-blind; the two keys
		// must be ABSENT, so that half stays raw. The absence check matches the
		// quoted form, which is what a redeclaration looks like under Biome's
		// double-quote rule — prose may still name a key.
		expect(SOURCE_CODE_ONLY).toContain('from "#/lib/meeting-roles"');
		for (const key of ["toastmaster_of_the_day", "grammarian"]) {
			expect(SOURCE, `${key} must not be spelled here`).not.toContain(
				`"${key}"`,
			);
		}
	});
});
