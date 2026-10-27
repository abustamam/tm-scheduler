import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Structural authz guard for the planned-attendance writers (D6, 2026-08-11).
 *
 * `setPlannedAttendance` / `clearPlannedAttendance` are `createServerFn`
 * handlers, and a handler body cannot be invoked outside a request context in
 * vitest — `attendance-plan-logic.integration.test.ts` exercises the db seam
 * directly and therefore bypasses `requireClubRole`, the meeting lock
 * (`assertMeetingNotLocked`, or since #1137 `assertMeetingAccepts(…, "plan",
 * { accept: ["cancelled"] })`), `assertClubNotArchived` and the self-only rule
 * entirely. Nothing else in the suite can see this wiring, so it is asserted
 * against the real source, the same way `outreach-authz.guard.test.ts` guards
 * the writers this pair replaces.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`):
 *
 *  · "the gate must BE present" → comment-blind. This module documents its own
 *    gating in prose, so a raw read would keep passing after the real call was
 *    deleted — a false PASS, the bypass `public-disclaimer.guard.test.ts`
 *    actually shipped.
 *  · "the payload's club must be ABSENT" → verbatim. Stripping only deletes
 *    text, and the stripper is a lexer: a `//` inside a string blanks the rest
 *    of the line and could erase a real offending call.
 */
const FILE = resolve(__dirname, "attendance-plan.ts");
/** Comment-blind — for "must BE present" only. */
const SRC = readSource(FILE);
/** Verbatim — for "must be ABSENT" only. */
const RAW = readFileSync(FILE, "utf8");

/**
 * The ladder itself moved to `attendance-actor-logic.ts` in #675, so the
 * assertions about ITS shape read from there.
 *
 * It moved because privacy cost two things at once. `resolveActor` was private
 * to this `createServerFn` module, which made it unreachable from vitest — this
 * whole file exists because of that — AND unreachable from the other
 * session-less writer that needed the same decision, so
 * `markUnavailableReleasing` shipped with no subject check at all. The move is
 * why `availability.integration.test.ts` can now EXECUTE the self-only rule
 * instead of only reading it; these assertions stay because they still pin the
 * things execution cannot see cheaply — the arm ORDER, and the two capability
 * splits the handlers below key off.
 */
const LADDER = readSource(resolve(__dirname, "attendance-actor-logic.ts"));

/** One `export const <name> = createServerFn…` declaration, so a per-handler
 *  assertion cannot be satisfied by its neighbour's correct code. */
function handlerBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in attendance-plan.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport const", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

const HANDLERS = ["setPlannedAttendance", "clearPlannedAttendance"];

/**
 * `clearPlannedAttendance`'s ladder, session-proof check and floor live in
 * `clearPlannedAttendanceCore` (`availability-logic.ts`), a seam the handler
 * calls after its own gates, so that `attendance-plan-logic.integration.test.ts`
 * can EXECUTE them. The handler's assertions below pin the gates it keeps and
 * the arguments it hands the seam; the seam's body is pinned where the logic is.
 */
function clearSeamBody(logic: string): string {
	const start = logic.indexOf(
		"export async function clearPlannedAttendanceCore(",
	);
	if (start === -1) {
		throw new Error(
			"clearPlannedAttendanceCore not found in availability-logic.ts — it was renamed or removed. Re-point this guard rather than deleting the case.",
		);
	}
	const next = logic.indexOf("\nexport ", start + 1);
	return logic.slice(start, next === -1 ? logic.length : next);
}
const LOGIC_FILE = resolve(__dirname, "availability-logic.ts");
/** Comment-blind — for "must BE present" only. */
const CLEAR_SEAM = clearSeamBody(readSource(LOGIC_FILE));
/** Verbatim — for "must be ABSENT" only. Scoped to this one seam, not the whole
 *  module: `setAvailabilityCore` legitimately maps `actorMemberId === null` to
 *  `"asserted"`, so the negatives below cannot read `availability-logic.ts`
 *  whole. */
const CLEAR_SEAM_RAW = clearSeamBody(readFileSync(LOGIC_FILE, "utf8"));

/** What each handler calls to learn who the caller is: the ladder itself for the
 *  set, the seam that runs it for the clear. */
const ACTOR_CALL = {
	setPlannedAttendance: "await resolveActor(",
	clearPlannedAttendance: "clearPlannedAttendanceCore(db, {",
} as const;

/**
 * The meeting-lock call a handler must make: the per-status helper, or EXACTLY
 * the write policy's `plan` class with `accept: ["cancelled"]` (#1137).
 *
 * Exactly, because the options are the whole meaning. The class alone would
 * refuse cancelled too and move that refusal ahead of the subject and actor
 * checks; `accept: ["cancelled", "completed"]` would accept a completed meeting
 * and let a locked one lose its plan. `"record"` is not recognised either: that
 * class accepts completed. So the pattern allows the one option list and
 * nothing else after the class.
 */
const LOCK_CHECK =
	/assertMeetingNotLocked\(meeting\.status\)|assertMeetingAccepts\(\s*meeting\.status,\s*"plan",\s*\{\s*accept:\s*\["cancelled"\],?\s*\}\s*,?\s*\)/;

describe("attendance-plan authz (D6)", () => {
	it("gates the officer path on requireClubRole(admin)", () => {
		// Whitespace-tolerant: the formatter wraps this call across lines.
		expect(LADDER).toMatch(
			/requireClubRole\(\s*user\.id,\s*args\.clubId,\s*\[\s*["']admin["'],?\s*\]/,
		);
	});

	it("never gates a write on the member role", () => {
		// Both files: the ladder is where the call lives, and the handlers are
		// where a second, weaker one would be added.
		// Comment-blind on both, matching how this assertion has always read: the
		// modules discuss their own role gating in prose, and a stripped read can
		// only ever remove a FALSE offender from a negative.
		for (const src of [LADDER, SRC]) {
			expect(src).not.toMatch(
				/requireClubRole\([^)]*\[\s*["']member["'],?\s*\]/,
			);
		}
	});

	for (const fn of HANDLERS) {
		it(`${fn} derives the club from the meeting, never from the payload`, () => {
			// #396: gating on a client-supplied clubId lets an admin of club A act
			// on club B's meeting and file the row under A.
			const body = handlerBody(SRC, fn);
			expect(body).toContain("await loadMeeting(data.meetingId)");
			expect(body).toContain("clubId: meeting.clubId");
		});

		it(`${fn} asserts the meeting is not locked`, () => {
			expect(handlerBody(SRC, fn)).toMatch(LOCK_CHECK);
		});

		it(`${fn} resolves the actor through the shared self-only gate`, () => {
			expect(handlerBody(SRC, fn)).toContain(
				ACTOR_CALL[fn as keyof typeof ACTOR_CALL],
			);
		});

		it(`${fn} gates on the club's archived_at BEFORE any other check`, () => {
			// The anonymous roster-pick identity is the dominant path here, so
			// `requireMembership`'s archive check (#186) never runs for it (#555).
			// Position matters as much as presence: run fourth, the membership and
			// meeting-lock checks answer first and their differing errors make an
			// archived club probeable — the existence oracle #544 exists to close.
			const body = handlerBody(SRC, fn);
			const archive = body.indexOf("assertClubNotArchived(meeting.clubId)");
			expect(archive).toBeGreaterThan(-1);
			const positions: [string, number][] = [
				["the meeting-lock call", body.search(LOCK_CHECK)],
				["requireMemberInClub(", body.indexOf("requireMemberInClub(")],
				[
					ACTOR_CALL[fn as keyof typeof ACTOR_CALL],
					body.indexOf(ACTOR_CALL[fn as keyof typeof ACTOR_CALL]),
				],
			];
			for (const [later, at] of positions) {
				expect(
					at,
					`${later} must not run before the archive gate`,
				).toBeGreaterThan(archive);
			}
		});
	}

	// Each of the next two rules is a CONDITION plus the THROW it reaches. Pin
	// both halves of each, because pinning one leaves the other deletable while
	// the suite stays green — and these two used to cover opposite halves, so
	// between them every half was unguarded. A `toContain` on the throw alone
	// passes with the comparison inverted or gone (the statement survives
	// anywhere in the module, dead code included); a `toContain` on the
	// condition alone passes with the body emptied to `{ /* allow */ }`.
	it("rejects a member setting someone else's row", () => {
		const body = LADDER.slice(
			LADDER.indexOf("export async function resolveActor"),
		);
		expect(
			body,
			"the comparison is the rule; without it any caller may name any subject",
		).toContain("if (actor !== args.memberId)");
		expect(
			body,
			"the comparison must REJECT — a condition with no throw is not a gate",
		).toContain(
			"if (actor !== args.memberId) throw new Error(SELF_ONLY_MESSAGE)",
		);
	});

	it("lets only an officer record reaching out to someone", () => {
		// The self-only arm admits the caller's own subject, and on the anonymous
		// path that is ANY roster member (`claimedActorMemberId` defaults to the
		// subject) — so without this an anonymous caller could mark someone else
		// as already asked and get them skipped on the officer's outreach list.
		const body = handlerBody(SRC, "setPlannedAttendance");
		expect(body).toContain('if (!viaManager && data.status === "reached_out")');
		expect(
			body,
			"the officer-only rung must THROW; an empty block passes a condition-only assertion",
		).toContain("throw new Error(OFFICER_ONLY_REACHED_OUT_MESSAGE)");
	});

	it("never lets a session-less caller delete an officer's reached_out", () => {
		// The clear path has no rung check of its own: it restricts the SEAM
		// instead, which is the half that actually reaches the database. Deleting
		// the officer's outreach record used to require `requireUser()` +
		// `requireClubRole(admin)`; after the consolidation it is one row with the
		// member's own answer. The clear requires a session (#762), and the floor
		// below is what keeps the ask out of reach of every arm but the officer's.
		// True as written since the #576 review, and it was NOT before: the clear
		// briefly rode `viaManager`, which admits the honour-system Toastmaster arm,
		// so a session-less caller asserting a public member id could delete.
		const body = handlerBody(SRC, "clearPlannedAttendance");
		expect(
			body,
			"the SUBJECT the seam compares the actor with is data.memberId, never the claim",
		).toContain("memberId: data.memberId,");
		expect(body).toContain("claimedActorMemberId: data.actorMemberId,");
		expect(
			CLEAR_SEAM,
			"clearPlannedAttendanceCore must resolve WHICH arm admitted the caller — a " +
				"boolean capability cannot tell an officer from a self-asserted TMOD",
		).toContain("const { actorMemberId, via } = resolved;");
		expect(
			CLEAR_SEAM,
			"the floor comes from clearFloor, fed the RESOLVED arm and actor — not a caller-supplied id",
		).toMatch(
			/onlyFrom:\s*clearFloor\(\{\s*via,\s*actorMemberId,\s*memberId: args\.memberId,?\s*\}\)/,
		);
		// The defect this replaced, pinned as a NEGATIVE so a revert cannot pass by
		// keeping the ternary shape while widening one arm. `undefined` there meant
		// "delete whatever is in the row", which let an officer's "No answer" erase
		// an answer that arrived since the panel rendered. Verbatim, handler and
		// seam both: stripping only deletes text.
		const seamRaw = CLEAR_SEAM_RAW;
		for (const [where, src] of [
			["the handler", handlerBody(RAW, "clearPlannedAttendance")],
			["the seam", seamRaw],
		] as const) {
			expect(
				src,
				`${where}: the officer arm must never pass an unfloored clear again (#573)`,
			).not.toContain('via === "officer" ? undefined');
			expect(
				src,
				`${where}: no inline floor: every clear goes through clearFloor`,
			).not.toContain('via === "officer" ?');
		}
	});

	it("floors the Toastmaster's clear of ANOTHER member's row at nothing", () => {
		// A member's ANSWER is cleared by that member, or by an officer on the season
		// grid, and by nobody else. `clearFloor` is where the Toastmaster arm gets
		// its half of that rule, so the arm is pinned INSIDE the function: the
		// `tmod` case, the own-row test it keys on, and the empty constant it
		// returns otherwise. The behavioural twin is the Toastmaster block in
		// `attendance-plan-logic.integration.test.ts`.
		const logic = readSource(resolve(__dirname, "attendance-plan-logic.ts"));
		const start = logic.indexOf("export function clearFloor");
		expect(start, "clearFloor not found").toBeGreaterThan(-1);
		const next = logic.indexOf("\nexport ", start + 1);
		const fn = logic.slice(start, next === -1 ? logic.length : next);
		expect(
			fn,
			"the own-row test compares the RESOLVED actor with the subject",
		).toContain("const ownRow = args.actorMemberId === args.memberId;");
		expect(
			fn,
			"the tmod arm keeps the self-service floor on its own row and gets nothing on another's",
		).toMatch(
			/case "tmod":\s*return ownRow \? SELF_SERVICE_RUNGS : NO_CLEARABLE_RUNGS;/,
		);
		expect(
			logic,
			"the empty floor is a named constant that really is empty",
		).toMatch(
			/export const NO_CLEARABLE_RUNGS: readonly AttendancePlanStatus\[\] = \[\];/,
		);
	});

	it("runs the session gate before the ladder on the clear", () => {
		// `clearFloor` can trust the Toastmaster arm's actor as "the session's own
		// member" only because a session is PROVEN first: with one, the caller is
		// resolved from the session and a claimed id is ignored. Without it the
		// arm's actor would rest on a claim rather than a session, and the own-row
		// test would mean nothing. Two halves, one per place the check can live: the handler's early
		// gate, and the seam's proof check, which is the one vitest executes and the
		// one that holds when the session's membership changes between the two reads.
		const body = handlerBody(SRC, "clearPlannedAttendance");
		const gate = body.indexOf("await requireSessionActor(");
		expect(gate).toBeGreaterThan(-1);
		expect(
			body.indexOf("clearPlannedAttendanceCore(db, {"),
			"the handler must reach the session gate before the seam",
		).toBeGreaterThan(gate);

		const ladder = CLEAR_SEAM.indexOf("await resolveActor(");
		const proof = CLEAR_SEAM.indexOf("assertSessionProof(resolved);");
		const del = CLEAR_SEAM.indexOf("clearPlanStatus(");
		expect(ladder).toBeGreaterThan(-1);
		expect(
			proof,
			"the proof check must follow the ladder: it reads the arm's proof",
		).toBeGreaterThan(ladder);
		expect(del, "the proof check must precede the delete").toBeGreaterThan(
			proof,
		);
	});

	it("reports the officer branch rather than inferring it from a null actor", () => {
		// A null actor means "impersonating superadmin" only because a read-only
		// session falls through and is rejected below — an accident of ordering,
		// not an invariant. So the branch is RETURNED by resolveActor, and the
		// negative is scoped to the handler bodies, which is where a consumer
		// would be tempted to re-derive it. (Module scope would false-FAIL on the
		// prose above, which names the pattern to warn against it — the reason
		// guard-source keeps negatives verbatim and positives comment-blind.)
		// Two arms grant the capability since #576, so the reported flag is
		// asserted through the arm labels rather than a true/false pair.
		expect(LADDER).toContain('viaManager: true, via: "officer"');
		expect(LADDER).toContain('viaManager: true, via: "tmod"');
		expect(LADDER).toContain('viaManager: false, via: "self"');
		for (const fn of HANDLERS) {
			expect(
				handlerBody(RAW, fn),
				`${fn} must use the reported branch, not re-derive it from the actor id`,
			).not.toContain("actorMemberId === null");
		}
		// The clear's ladder moved into its seam, so the handler read above no
		// longer holds the place a consumer would re-derive the branch.
		expect(
			CLEAR_SEAM_RAW,
			"clearPlannedAttendanceCore must use the reported branch, not re-derive it from the actor id",
		).not.toContain("actorMemberId === null");
	});

	it("keeps ONE copy of the ladder, in the shared module", () => {
		// #675 moved it out so `availability.ts` could reuse it. A local copy
		// creeping back would satisfy every assertion above — they read the shared
		// module — while the two ladders drifted, which is the failure the move
		// exists to prevent. Verbatim: the header prose names the function, and a
		// comment-blind read would flag that as an offender.
		expect(
			RAW,
			"resolveActor lives in attendance-actor-logic.ts — import it, do not re-declare it",
		).not.toContain("function resolveActor");
	});

	it("never reads the club from the request payload", () => {
		expect(
			RAW,
			"the club must come from the meeting row (#396) — a payload clubId is not evidence of anything",
		).not.toContain("data.clubId");
	});

	it("admits this meeting's Toastmaster as a third arm, scoped to that meeting", () => {
		// #576. The arm's SHAPE is pinned here; its read-side twin is executed in
		// `tmod-panel-data.integration.test.ts`, and since #675 the WRITE side is
		// executed too, in `availability.integration.test.ts`.
		expect(LADDER).toContain("loadTmodMemberId(args.meetingId)");
		expect(
			LADDER,
			"the TMOD grant must be scoped to the meeting being written, never resolved from the club",
		).not.toMatch(/loadTmodMemberId\(\s*args\.clubId/);
		expect(LADDER).toContain('via: "tmod"');
	});

	it("asks who is CALLING for the TMOD check, not who is being written", () => {
		// The self-only arm below deliberately defaults the claim to the SUBJECT
		// (`?? args.memberId`), which is what makes an anonymous self-write
		// resolve. Reusing that default for the TMOD check would make every
		// anonymous write self-assert as its own target, so writing the TMOD's row
		// would confer TMOD powers over it — useless for the panel and wrong.
		// Asserted by ORDER rather than by slicing between two markers. The #576
		// review collapsed the duplicate actor resolution, which moved both markers
		// the previous slice depended on — a slice-based guard breaks on a refactor
		// that keeps the rule, which trains people to edit the guard instead of
		// reading it.
		//
		// The rule: the FIRST resolution — the one the TMOD comparison consumes —
		// asks who is CALLING (`?? null`). The subject default appears only in the
		// fallback that runs when the caller asserted nothing, strictly AFTER the
		// TMOD comparison.
		const callerResolve = LADDER.indexOf(
			"claimedActorMemberId: args.claimedActorMemberId ?? null,",
		);
		const tmodCompare = LADDER.indexOf("caller === tmodMemberId");
		const subjectDefault = LADDER.indexOf(
			"claimedActorMemberId: args.memberId,",
		);
		expect(callerResolve).toBeGreaterThan(-1);
		expect(
			tmodCompare,
			"the TMOD comparison must consume the caller resolution, not precede it",
		).toBeGreaterThan(callerResolve);
		expect(
			subjectDefault,
			"the subject default must not be reachable before the TMOD comparison — " +
				"it would make every anonymous write self-assert as its own target",
		).toBeGreaterThan(tmodCompare);
	});

	it("orders the arms officer, then TMOD, then self", () => {
		// Load-bearing. Self first would swallow the TMOD arm entirely, since a
		// TMOD writing their OWN row satisfies the self test and would return
		// `viaManager: false` — silently downgrading them on exactly the write
		// they are most likely to make first.
		// Match the FULL return literal, not the bare `via: "officer"`. The bare
		// form also matches the `ResolvedActor` interface's type union
		// (`via: "officer" | "tmod" | "self";`), which always precedes the function
		// body — so `tmod > officer` held regardless of how the arms were actually
		// ordered, and this test passed with the arms physically swapped. Found by
		// the #576 review, which swapped them and watched it stay green.
		const officer = LADDER.indexOf('viaManager: true, via: "officer"');
		const tmod = LADDER.indexOf('viaManager: true, via: "tmod"');
		const self = LADDER.indexOf('viaManager: false, via: "self"');
		expect(officer).toBeGreaterThan(-1);
		expect(tmod).toBeGreaterThan(officer);
		expect(self).toBeGreaterThan(tmod);
	});

	it("splits the two capabilities across the two arms", () => {
		// The WRITE of `reached_out` is the capability the panel exists for, so it
		// takes `viaManager` — both arms. The CLEAR of it is not: it deletes another
		// officer's private record, and the Toastmaster's claim is honour-system
		// with a publicly-known id, so it stays on the officer arm. These were one
		// flag until the #576 review; conflating them handed an unauthenticated
		// caller a delete that used to need requireClubRole(admin).
		//
		// Since #573 the officer arm is FLOORED rather than unrestricted — it may
		// clear the ask, not an answer — so what this pins is the arm SPLIT, which
		// is unchanged, on an expression whose right-hand side moved.
		expect(SRC).toContain('if (!viaManager && data.status === "reached_out")');
		expect(CLEAR_SEAM).toMatch(
			/onlyFrom:\s*clearFloor\(\{\s*via,\s*actorMemberId,\s*memberId: args\.memberId,?\s*\}\)/,
		);
		// `clearFloor` trusts `actorMemberId === memberId` because the seam refuses
		// every caller whose identity a session did not PROVE
		// (`assertSessionProof`, pinned above), which makes the actor on the officer
		// AND Toastmaster arms the session's own member (an impersonating
		// superadmin's is null, and a null equals no id). The officer arm's actor
		// comes from the SESSION's own membership. Pin the arm's
		// WHOLE sequence, declaration through return, inside `resolveActor`'s body.
		// The declaration alone is not the pin: it survives anywhere in the module
		// and survives a return that reads the claimed id instead
		// (`actorMemberId: args.claimedActorMemberId ?? actorMemberId`), which is
		// the edit this exists to fail. Comments are blanked to spaces by
		// `readSource`, so `\s*` spans the prose between the three statements. The
		// behavioural twin is in `attendance-plan-logic.integration.test.ts`.
		const resolveActorBody = LADDER.slice(
			LADDER.indexOf("export async function resolveActor"),
		);
		expect(
			resolveActorBody,
			"the officer arm's actor must be the session's membership, never the claimed id",
		).toMatch(
			/const actorMemberId = membership\.id;\s*const proof = "session";\s*return \{ actorMemberId, viaManager: true, via: "officer", proof \};/,
		);
		for (const src of [RAW, CLEAR_SEAM_RAW]) {
			expect(
				src,
				"the officer clear must NOT be gated on viaManager — that admits the honour-system TMOD arm",
			).not.toContain("onlyFrom: viaManager ?");
		}
		for (const src of [SRC, LADDER]) {
			expect(
				src,
				"viaOfficer was renamed to viaManager when the TMOD arm landed — a surviving use means one gate was missed",
			).not.toContain("viaOfficer");
		}
	});

	it("floors the nudge auto-advance so it cannot demote a real answer", () => {
		// The bug this exists to catch is a DELETION, and it is invisible to every
		// other gate here: `setPlanStatus`'s `demoteFrom` is optional, so dropping
		// it typechecks, and the seam's own integration tests pass their own
		// `demoteFrom` explicitly — they prove the PREDICATE works, never that
		// this caller supplies it.
		//
		// Why it matters: `via: "nudge"` is the auto-advance behind a WhatsApp or
		// email tap, where the rung moves as a side effect and the officer never
		// chose it. Unfloored, an officer tapping a row that rendered a while ago
		// overwrites the `not_coming` that arrived since — the member drops off
		// `unavailableMembers`, loses the warning in the assign picker, and the
		// VPE hands a role to someone who said they cannot come. That is the
		// regression `setContacted` (`server/outreach.ts`) carries
		// `demoteFrom: ["reached_out"]` to prevent — it is still live and still
		// the recruit picker's path, which is why the panel's own route needed
		// its own floor rather than inheriting one. The client guard in
		// `markAsked` is not a substitute: it
		// reads a `plan` snapshot that is stale by construction, while this is a
		// `setWhere` Postgres evaluates against the live row.
		const body = handlerBody(SRC, "setPlannedAttendance");
		expect(
			body,
			'setPlannedAttendance must pass demoteFrom on the via:"nudge" + reached_out path',
		).toMatch(
			/demoteFrom:\s*\n?\s*data\.status === "reached_out" &&\s*\n?\s*\(data\.via === "nudge" \|\| via === "tmod"\)\s*\n?\s*\?\s*\["reached_out"\]\s*\n?\s*:\s*undefined/,
		);
		// The TMOD half of that condition is the #576 review's: an honour-system
		// caller must not overwrite a real answer even on the deliberate path.
		expect(
			body,
			"the TMOD arm must be floored on the manual path too, not only on nudge",
		).toContain('via === "tmod"');
	});

	it("leaves a deliberate manual rung pick unfloored", () => {
		// The other half, and the reason the floor is conditional rather than
		// unconditional: `via: "manual"` is the officer picking a rung from the
		// menu with the current one on screen in front of them. Flooring THAT
		// would make "Asked" silently do nothing on a row that already answered —
		// a control that no-ops is worse than one that overwrites, because the
		// officer gets no signal either way. A future edit that hoists the floor
		// out of the conditional to "simplify" it fails here.
		const body = handlerBody(SRC, "setPlannedAttendance");
		expect(
			body,
			"the floor must stay conditional on via — an unconditional demoteFrom breaks the deliberate menu pick",
		).not.toMatch(/demoteFrom:\s*\["reached_out"\],/);
	});
});
