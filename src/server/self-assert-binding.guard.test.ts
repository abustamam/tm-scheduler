// A self-assert is decided in ONE place, and `meeting-authz-logic.ts` reads
// `selfMemberId` nowhere else (#747, ADR-0026).
//
// ## Why the guard is the durable half of the fix
//
// The bug was never one arm. Four identically-shaped grants — agenda meta
// (TMOD), Word of the Day (TMOD), Word of the Day (Grammarian), the Ballot
// Counter gate — each compared `input.selfMemberId` against a slot assignee and
// never consulted `sessionUserId`, so an ordinary signed-in member fell past the
// admin arm and could assert anyone's id. Fixing them in place would have left
// the SHAPE intact, and the fifth arm would have inherited it: that is how the
// count got to four. So the fix is a seam, and this is what keeps it the only
// one.
//
// ## Why a source guard rather than a test that calls the function
//
// The seam's own truth table IS directly testable and is tested
// (`self-assert-grant.test.ts`), and the grants are tested end to end against a
// real database (`meeting-authz.integration.test.ts`). Neither can see a FIFTH
// arm that someone writes inline tomorrow — a new comparison in a new resolver
// is new correct-looking code, green against every existing case. Only the
// source can see that, so that is what this reads.
//
// ## Reading mode
//
// Reads RAW, not comment-blind (`readFileSync`, not `#/test/guard-source`'s
// `readSource`), and this is the deliberate choice `member-write-authz.guard.test.ts:30`
// states for itself: this asserts an OFFENDER LIST IS EMPTY, so a comment
// mentioning the pattern can only ever ADD a false offender, and blanking
// comments would LOOSEN the guard. The consequence is real and worth knowing:
// prose elsewhere in that module may not write the literal `selfMemberId`
// either. Put such prose in the seam's own doc comment, which is inside the
// region this skips. (Note this is the opposite choice from an EXTRACTION test,
// which must strip comments — see `role-identity-fold.integration.test.ts`.)
//
// ## Mutation record — MEASURED, not assumed
//
// Each was injected against this branch, observed red, and reverted. No
// `file:line` citations: this repo has already been burnt by a comment claiming
// a test verified citations that had gone stale (`write-proof.guard.test.ts`
// says so at its own `SESSION_GATES`), and what is recorded here is the SHAPE,
// which is what the assertions actually read.
//
//  (a) Putting one arm's comparison back — restoring
//      `if (input.selfMemberId && tmodMemberId && input.selfMemberId === tmodMemberId)`
//      in `resolveMeetingAgendaAuthz` — failed `no arm reads selfMemberId
//      outside the seam`, naming both lines of it.
//  (b) The BINDING evasion — `const claimed = input.selfMemberId;` followed by a
//      comparison on `claimed` — failed the same case, which a comparison-only
//      matcher would have missed.
//  (c) Deleting an arm's `resolveSelfAssertGrant` call failed the census below,
//      so "no offenders" cannot be satisfied by the arms simply going away.
//  (d) Narrowing to the CLAIM instead of the slot (`const verified =
//      args.selfMemberId`) failed `the seam credits the SLOT-derived id`; so did
//      crediting `args.selfMemberId` at the return site. **Both left every
//      behavioural test green**, including the unit case that reads like it
//      covers this — the two values are equal by then, so only the source can
//      tell them apart. That pair is the reason the case exists.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOP_LEVEL_BOUNDARY } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const SERVER_DIR = dirname(SELF);
const TARGET = resolve(SERVER_DIR, "meeting-authz-logic.ts");

/** The one function allowed to decide a self-assert. */
const SEAM = "resolveSelfAssertGrant";

/**
 * The `selfMemberId` occurrences that are NOT a read of the claimed identity,
 * and so are not offenders wherever they appear:
 *
 *  - `selfMemberId?: string | null` — the input interface's field DECLARATION.
 *    A type annotation reads nothing.
 *
 * Deliberately short. Every other form — a comparison, a local binding, an
 * argument to some other function — is a second place that decides, or could
 * become one, which is the whole finding behind #747.
 */
const DECLARATION = /selfMemberId\??\s*:\s*string\b/;

/**
 * Everything the guard is allowed to skip: the seam's own declaration (with its
 * doc comment) and the text inside each `resolveSelfAssertGrant(…)` CALL.
 *
 * Blanked rather than deleted, preserving length and newlines, so the line
 * numbers this reports stay true — the same reason `stripComments` blanks.
 */
function blankSeamRegions(src: string): string {
	let out = blankSeamDeclaration(src);
	out = blankSeamCalls(out);
	return out;
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * Where the seam's declaration starts and ends — from the start of its leading
 * doc comment to the next top-level boundary.
 *
 * The doc comment is INCLUDED on purpose: the seam explains itself in prose that
 * names `selfMemberId`, and a raw read would otherwise report its own
 * documentation. The walk back is guarded — only whitespace may sit between the
 * comment's `*​/` and the declaration — because without that check a seam whose
 * doc comment was deleted would swallow the PRECEDING function instead, which is
 * a silent loosening in exactly the region that matters.
 */
function seamRange(src: string): { start: number; body: number; end: number } {
	const at = src.search(new RegExp(`^export function ${SEAM}\\(`, "m"));
	if (at === -1) {
		throw new Error(
			`${SEAM} is no longer declared in meeting-authz-logic.ts. It is the single decision point #747 created; re-point this guard rather than deleting it.`,
		);
	}
	let start = at;
	const docEnd = src.lastIndexOf("*/", at);
	if (docEnd !== -1 && src.slice(docEnd + 2, at).trim() === "") {
		const docStart = src.lastIndexOf("/**", docEnd);
		if (docStart !== -1) start = docStart;
	}
	const lines = src.slice(at).split("\n");
	let end = src.length;
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && TOP_LEVEL_BOUNDARY.test(lines[i] as string)) {
			end = at + offset;
			break;
		}
		offset += (lines[i] as string).length + 1;
	}
	return { start, body: at, end };
}

/** The seam's CODE, doc comment excluded — what the provenance case reads. */
function seamDeclaration(src: string): string {
	const { body, end } = seamRange(src);
	return src.slice(body, end);
}

function blankSeamDeclaration(src: string): string {
	const { start, end } = seamRange(src);
	return src.slice(0, start) + blank(src.slice(start, end)) + src.slice(end);
}

/**
 * The argument text of every `resolveSelfAssertGrant(…)` call, by balanced-paren
 * scan rather than a line or a fixed window.
 *
 * `selfMemberId: input.selfMemberId,` inside such a call is the seam being
 * HANDED the claim, which is the shape this guard exists to require. A
 * line-based skip would also excuse whatever else shared that line.
 */
function blankSeamCalls(src: string): string {
	const call = new RegExp(`\\b${SEAM}\\(`, "g");
	let out = src;
	for (const m of [...src.matchAll(call)]) {
		const open = (m.index ?? 0) + m[0].length - 1;
		let depth = 0;
		for (let j = open; j < src.length; j++) {
			const c = src[j];
			if (c === "(") depth++;
			else if (c === ")") {
				depth--;
				if (depth === 0) {
					out =
						out.slice(0, open + 1) +
						blank(out.slice(open + 1, j)) +
						out.slice(j);
					break;
				}
			}
		}
	}
	return out;
}

/** `line:text` for every remaining read of `selfMemberId`. */
function offenders(src: string): string[] {
	return blankSeamRegions(src)
		.split("\n")
		.map((text, i) => ({ text, line: i + 1 }))
		.filter(({ text }) => text.includes("selfMemberId"))
		.filter(({ text }) => !DECLARATION.test(text))
		.map(({ text, line }) => `${line}: ${text.trim()}`);
}

/** Live `resolveSelfAssertGrant(` CALLS — the declaration is not one. */
function seamCallCount(src: string): number {
	return (src.match(new RegExp(`(?<!function )\\b${SEAM}\\(`, "g")) ?? [])
		.length;
}

describe("a self-assert is decided in one place (#747)", () => {
	const src = readFileSync(TARGET, "utf8");

	it("no arm reads selfMemberId outside the seam", () => {
		const found = offenders(src);
		expect(
			found,
			`meeting-authz-logic.ts reads the caller's claimed \`selfMemberId\` outside \`${SEAM}\`:\n${found.join("\n")}\n\n` +
				`That is the shape #747 removed: four arms each comparing a claimed id to a slot, none of them consulting the session, and the fifth inheriting it. ` +
				`Route the arm through \`${SEAM}\` instead — it takes the session's own membership and refuses a signed-in caller asserting somebody else. ` +
				`If this is PROSE rather than code, this guard reads raw on purpose (see the header); move the mention into the seam's own doc comment.`,
		).toEqual([]);
	});

	it("all four arms still route through the seam", () => {
		// The vacuity floor, and the thing that makes the offender list mean
		// something: with the arms deleted or re-inlined under another name,
		// "no offenders" is satisfied by there being nothing left to offend. Four
		// is what the module carries — agenda meta (TMOD), Word of the Day (TMOD),
		// Word of the Day (Grammarian), the Ballot Counter gate. #752 adds the
		// disqualify console and will raise this; a DROP is the regression.
		expect(
			seamCallCount(src),
			`Fewer than four \`${SEAM}\` call sites. Either an arm stopped routing through the seam, or one was deleted — the first is the #747 regression and the offender list above cannot see it.`,
		).toBeGreaterThanOrEqual(4);
	});

	it("the seam credits the SLOT-derived id, not the claim off the wire", () => {
		// The one property here that NO behavioural test can reach. Past the
		// seam's equality check the claim and the slot are the same VALUE, so
		// `actorMemberId: <either>` behaves identically — `self-assert-grant.test.ts`
		// says so at the case that would otherwise appear to cover it. The
		// difference is not behaviour, it is PROVENANCE: `actorMemberId` is what
		// `logActivity` stamps (#396), and it must come from the row the server
		// read rather than from the payload, or the audit trail's source is the
		// thing the audit trail exists to doubt.
		//
		// Enforced structurally rather than by matching one spelling: the seam
		// narrows to a single `verified` binding taken from `slotMemberId`, so
		// there is no second name in scope to credit by mistake. This pins both
		// halves — the binding's source, and that nothing downstream re-reads the
		// claim.
		const seam = seamDeclaration(src);
		expect(
			seam,
			"The seam no longer narrows to a single `const verified = args.slotMemberId`. That binding is what makes crediting the payload impossible to write by accident; restoring two names in scope re-opens it silently, because both spellings behave identically.",
		).toContain("const verified = args.slotMemberId;");
		expect(
			seam,
			"The seam credits something other than `verified`. `actorMemberId` is what `logActivity` stamps (#396) and must come from the row the SERVER read.",
		).toContain("actorMemberId: verified");
		const afterNarrowing = seam.slice(
			seam.indexOf("const verified = args.slotMemberId;"),
		);
		expect(
			afterNarrowing.includes("selfMemberId"),
			"The seam reads the claimed id again AFTER narrowing to `verified`. Everything past that point must use the slot-derived value.",
		).toBe(false);
	});

	it("the real module names all four grant arms it gates", () => {
		// Anchors the count to the arms by NAME, so a fourth call appearing while a
		// different arm quietly loses its own still fails. `via` strings are the
		// resolvers' own public vocabulary, asserted elsewhere.
		for (const via of [
			"tmod-self-assert",
			"grammarian-self-assert",
			"vote-counter-self-assert",
		]) {
			expect(src, `${via} is no longer a grant arm here`).toContain(via);
		}
	});

	// ── The matcher's own tests ───────────────────────────────────────────────
	// The production file PASSES, so it can never demonstrate that this sweep
	// fails on anything. Synthetic offenders are the only thing that proves the
	// slicer works at all — without these the guard rots into decoration that is
	// green because it matches nothing.
	describe("the sweep can actually fail", () => {
		const seam = `
/**
 * Doc prose that names selfMemberId, inside the region that is skipped.
 */
export function resolveSelfAssertGrant(args: {
	selfMemberId: string | null | undefined;
	slotMemberId: string | null;
}): { granted: boolean } {
	return { granted: args.selfMemberId === args.slotMemberId };
}
`;
		const header = `
export interface MeetingAgendaAuthzInput {
	selfMemberId?: string | null;
}
`;

		it("passes a module that only hands the claim to the seam", () => {
			const clean = `${header}${seam}
export async function resolveThing(input: MeetingAgendaAuthzInput) {
	return resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: null,
	});
}
`;
			expect(offenders(clean)).toEqual([]);
			expect(seamCallCount(clean)).toBe(1);
		});

		it("flags an inline comparison — the #747 shape itself", () => {
			const bad = `${header}${seam}
export async function resolveThing(input: MeetingAgendaAuthzInput) {
	if (input.selfMemberId && input.selfMemberId === "slot") return true;
	return false;
}
`;
			expect(offenders(bad)).toHaveLength(1);
			expect(offenders(bad)[0]).toContain("input.selfMemberId ===");
		});

		it("flags the BINDING evasion a comparison-only matcher would miss", () => {
			// `const claimed = input.selfMemberId` moves the claim into a local and
			// compares THAT, so nothing matches `selfMemberId ===` anywhere. Reading
			// the mention rather than the operator is what closes it.
			const bad = `${header}${seam}
export async function resolveThing(input: MeetingAgendaAuthzInput) {
	const claimed = input.selfMemberId;
	return claimed === "slot";
}
`;
			expect(offenders(bad)).toHaveLength(1);
			expect(offenders(bad)[0]).toContain("const claimed");
		});

		it("flags a read smuggled through another helper", () => {
			// No comparison and no binding: the claim is simply handed to a function
			// that is not the seam. A shape matcher keyed on operators sees nothing.
			const bad = `${header}${seam}
export async function resolveThing(input: MeetingAgendaAuthzInput) {
	return someOtherDecision(input.selfMemberId, "slot");
}
`;
			expect(offenders(bad)).toHaveLength(1);
			expect(offenders(bad)[0]).toContain("someOtherDecision");
		});

		it("does not let one arm's seam call excuse the arm below it", () => {
			// The #565 over-capture shape, pointed at this slicer: the balanced-paren
			// blank must end at the call's own `)`, not run on into what follows.
			const bad = `${header}${seam}
export async function resolveThing(input: MeetingAgendaAuthzInput) {
	const a = resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: null,
	});
	if (a.granted) return true;
	return input.selfMemberId === "slot";
}
`;
			const found = offenders(bad);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain('input.selfMemberId === "slot"');
		});

		it("does not swallow the preceding function when the seam loses its doc comment", () => {
			// The walk-back is guarded on "only whitespace between `*/` and the
			// declaration". Without that guard, `lastIndexOf("/**")` reaches the
			// PREVIOUS function's comment and blanks it along with its body — which
			// would silently exempt a real offender sitting immediately above.
			const undocumented = `${header}
/**
 * The neighbour above, which must stay visible.
 */
export function resolveAdminGrant(input: MeetingAgendaAuthzInput) {
	return input.selfMemberId === "sneaky";
}

export function resolveSelfAssertGrant(args: { slotMemberId: string | null }) {
	return { granted: args.slotMemberId !== null };
}
`;
			const found = offenders(undocumented);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain('input.selfMemberId === "sneaky"');
		});

		it("refuses to pass silently when the seam is gone", () => {
			expect(() => offenders(header)).toThrow(/no longer declared/);
		});
	});
});
