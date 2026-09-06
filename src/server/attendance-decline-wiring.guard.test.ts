import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The half of #663 a behavioural test cannot reach: that `setPlannedAttendance`
 * actually ROUTES a `not_coming` through `declinePlannedAttendance`, and routes
 * nothing else through it.
 *
 * `attendance-decline.integration.test.ts` executes the seam — every arm, the
 * released slots, the preserved speech, the archive gate. None of that proves
 * the handler calls it. A `createServerFn` handler body cannot be invoked in
 * vitest (CODING_STANDARDS.md, "WRITES are closed too"), so deleting the branch
 * below would leave that whole suite green while the rail went straight back to
 * writing a rung and leaving the member on the programme — the exact defect, and
 * with a passing test file named after it.
 *
 * The mirror mutation matters as much and is cheaper to make by accident:
 * widening the condition, or dropping it, sends `coming` and `reached_out`
 * through the decline seam too. That is silent — the seam hard-codes
 * `status: "not_coming"`, so a member the officer marked COMING would be
 * recorded as declining and have their roles freed, with no error anywhere.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`): "must BE
 * present" is comment-blind, because this module discusses its own wiring in
 * prose and a raw read would keep passing after the real call was deleted;
 * "must be ABSENT" is verbatim, because stripping only deletes text and a `//`
 * inside a string could erase a real offending call.
 */
const FILE = resolve(__dirname, "attendance-plan.ts");
/** Comment-blind — for "must BE present" only. */
const SRC = readSource(FILE);
/** Verbatim — for "must be ABSENT" only. */
const RAW = readFileSync(FILE, "utf8");

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

describe("setPlannedAttendance declines through the release seam (#663)", () => {
	it("reaches declinePlannedAttendance", () => {
		expect(
			handlerBody(SRC, "setPlannedAttendance"),
			"a decline must free the roles the member holds — a bare setPlanStatus leaves the agenda listing someone who is not coming",
		).toContain("declinePlannedAttendance(db, {");
	});

	it("routes ONLY not_coming through it", () => {
		const body = handlerBody(SRC, "setPlannedAttendance");
		expect(
			body,
			"the branch condition IS the rule; without it every rung is recorded as a decline",
		).toContain('if (data.status === "not_coming")');
		// Exactly one call, and it sits inside that branch. A second call site — or
		// one hoisted above the condition — is how `coming` starts freeing roles.
		expect(body.split("declinePlannedAttendance(").length - 1).toBe(1);
		expect(body.indexOf("declinePlannedAttendance(")).toBeGreaterThan(
			body.indexOf('if (data.status === "not_coming")'),
		);
	});

	it("hands the seam the client's RAW assertion", () => {
		// The seam runs the actor ladder, so it needs the CLAIM. A resolved actor
		// id would satisfy the subject check by construction — the #675 hole, and
		// the reason `releaseSlotsAndMarkUnavailable` refuses to take one.
		const decline = handlerBody(SRC, "setPlannedAttendance").slice(
			handlerBody(SRC, "setPlannedAttendance").indexOf(
				"declinePlannedAttendance(db, {",
			),
		);
		expect(decline).toContain("claimedActorMemberId: data.actorMemberId,");
	});

	it("never defaults that assertion to the subject", () => {
		// `?? data.memberId` makes actor === subject for every request, so the
		// ladder's self-only throw can never fire and any caller could empty any
		// member's agenda. Verbatim, and scoped to the handler: the module's prose
		// elsewhere legitimately names the expression to warn against it.
		const body = handlerBody(RAW, "setPlannedAttendance");
		expect(body).not.toContain("data.actorMemberId ?? data.memberId");
		expect(body).not.toContain("?? data.memberId");
	});

	it("keeps the archive gate, the lock and the subject check BEFORE the branch", () => {
		// The decline branch returns early, so anything it jumps over is skipped for
		// that rung. Run after it, the archive gate would let an archived club be
		// written to and the meeting lock would let a completed meeting lose its
		// programme — neither reachable through the seam, which owns the CALLER's
		// authorization and nothing else.
		const body = handlerBody(SRC, "setPlannedAttendance");
		const branch = body.indexOf('if (data.status === "not_coming")');
		expect(branch).toBeGreaterThan(-1);
		for (const earlier of [
			"assertClubNotArchived(meeting.clubId)",
			"assertMeetingNotLocked(meeting.status)",
			"requireMemberInClub(data.memberId, meeting.clubId)",
		]) {
			const at = body.indexOf(earlier);
			expect(
				at,
				`${earlier} must run before the decline branch`,
			).toBeGreaterThan(-1);
			expect(at).toBeLessThan(branch);
		}
	});

	it("defaults releaseHeldRoles to FALSE on the wire", () => {
		// THE stale-tab gate, and the default is the whole gate. This endpoint's
		// URL, method and payload shape are unchanged by #663 — only the side
		// effect moved — and `public/sw.js` calls `skipWaiting()` + `clients.claim()`
		// while the only `controllerchange` listener just sets a flag, so an open
		// tab never reloads. Push-to-main auto-deploys. With `.default(true)`, or
		// with the field removed and the release inferred from the status, every
		// deploy means an officer with the rail open sends the request they have
		// always sent and gets a destructive release with no dialog in their bundle
		// and no toast — and it does not undo, because re-claiming a freed slot
		// INSERTs a new speech row and orphans the original.
		//
		// The same hazard class as flipping a `method` (CLAUDE.md), minus the part
		// that makes a flip survivable: a wrong verb 405s loudly, this succeeds
		// silently.
		expect(
			SRC,
			"releaseHeldRoles must default to false — a client that predates #663 cannot send it",
		).toContain("releaseHeldRoles: z.boolean().default(false)");
		expect(RAW).not.toContain("z.boolean().default(true)");
	});

	it("forwards the flag rather than hard-coding the release", () => {
		const body = handlerBody(SRC, "setPlannedAttendance");
		expect(body).toContain("releaseHeldRoles: data.releaseHeldRoles,");
		expect(
			handlerBody(RAW, "setPlannedAttendance"),
			"hard-coding true reopens the deploy window that the schema default closes",
		).not.toContain("releaseHeldRoles: true");
	});

	it("keeps the flag off the CLEAR endpoint", () => {
		// Clearing a row back to "no answer" has no release to consent to. Left
		// accepted there, the field would sit on an endpoint that ignores it, which
		// is how the next reader concludes the clear releases something. (`true` in
		// an `omit` list means "drop this key", not "release".)
		expect(handlerBody(SRC, "clearPlannedAttendance")).toMatch(
			/\.omit\(\{[\s\S]{0,120}releaseHeldRoles: true/,
		);
	});

	it("reports what was freed on BOTH branches", () => {
		// `released` is what the route's toast reads. Present on one branch only, it
		// is a union the caller has to narrow — and the narrowing that gets written
		// is `?? 0`, which silently reports "nothing freed" for the branch that
		// freed everything.
		const body = handlerBody(SRC, "setPlannedAttendance");
		expect(body).toContain("released: 0");
	});
});

describe("the decline seam gates on the ARM, not on a capability flag (#663)", () => {
	const SEAM_PATH = resolve(__dirname, "attendance-decline-logic.ts");
	/** Comment-blind — for "must BE present" only. */
	const SEAM = readSource(SEAM_PATH);
	/** Verbatim — for "must be ABSENT" only. */
	const SEAM_RAW = readFileSync(SEAM_PATH, "utf8");

	it("branches on the resolved arm through the exported list", () => {
		// `viaManager` would be the tempting shorthand and it is wrong: it is true
		// for the TMOD arm too, and that arm's own-row and other-row cases differ.
		// The list is exported so this assertion and the seam cannot hold different
		// ideas of which arms release.
		expect(SEAM).toContain("DECLINE_RELEASING_ARMS.includes(actor.via)");
		expect(
			SEAM,
			"a capability flag cannot tell an officer from a self-asserted Toastmaster",
		).not.toContain("viaManager");
	});

	it("takes the opt-in flag AND the arm, flag first", () => {
		// Both, in that order: a caller that did not ask for a release must never
		// reach the arm question, so the gate cannot be satisfied by an arm alone.
		expect(SEAM).toContain(
			"args.releaseHeldRoles && mayRelease(actor, args.memberId)",
		);
	});

	it("admits the Toastmaster's OWN row off the resolved actor, not the raw claim", () => {
		// The own-row case is the one the arm ORDER makes non-obvious (officer →
		// TMOD → self), and comparing the CLAIM instead of the resolved actor would
		// let anyone satisfy it by asserting the subject's id.
		expect(SEAM).toContain(
			'actor.via === "tmod" && actor.actorMemberId === subjectMemberId',
		);
		expect(SEAM_RAW).not.toContain("claimedActorMemberId === subjectMemberId");
	});

	it("refuses a release once the meeting is over, and only then", () => {
		// `assertMeetingNotLocked` is `status === "completed"` only, and clubs
		// routinely never press Complete, so a months-old meeting is still
		// "scheduled" and a release there erases who actually did what.
		// `isMeetingOver` is the repo's one definition of a closed window (#393).
		//
		// Gated on the FLAG: a plain rung write on a past meeting is harmless and
		// is what a pre-#663 client does, so newly rejecting it would break the
		// stale tab in the other direction.
		expect(SEAM).toContain("isMeetingOver(");
		expect(SEAM).toMatch(
			/if \(args\.releaseHeldRoles\) \{\s*await assertReleasableWindow\(/,
		);
	});

	it("forwards `via` to the release it composes", () => {
		// Dropped, the DESTRUCTIVE branch records less provenance than the harmless
		// rung write beside it — on the one branch whose audit trail is the only
		// record that survives it.
		const release = SEAM.slice(
			SEAM.indexOf("releaseSlotsAndMarkUnavailable(database, {"),
		);
		expect(release).toContain("via: args.via,");
	});

	it("reuses the shared ladder and the existing release rather than copying either", () => {
		expect(SEAM).toMatch(/from "\.\/attendance-actor-logic"/);
		expect(SEAM).toContain("resolveActor({");
		expect(SEAM).toMatch(/from "\.\/availability-logic"/);
		expect(SEAM).toContain("releaseSlotsAndMarkUnavailable(database, {");
	});

	it("asserts the club is not archived, before the ladder", () => {
		const archive = SEAM.indexOf("assertClubNotArchived(args.clubId)");
		expect(archive).toBeGreaterThan(-1);
		expect(
			SEAM.indexOf("resolveActor({"),
			"the archive gate must not run after the ladder",
		).toBeGreaterThan(archive);
	});

	it("records which arm admitted the non-releasing write", () => {
		// `grantedVia` is optional on `setPlanStatus`, so a caller that forgets it
		// drops the distinction silently — and an honour-system TMOD decline and an
		// officer's would then look identical in the feed.
		expect(SEAM).toContain("grantedVia: actor.via,");
	});
});
