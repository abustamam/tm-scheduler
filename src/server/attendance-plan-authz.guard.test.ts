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
 * directly and therefore bypasses `requireClubRole`, `assertMeetingNotLocked`,
 * `assertClubNotArchived` and the self-only rule entirely. Nothing else in the
 * suite can see this wiring, so it is asserted against the real source, the
 * same way `outreach-authz.guard.test.ts` guards the writers this pair
 * replaces.
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

describe("attendance-plan authz (D6)", () => {
	it("gates the officer path on requireClubRole(admin)", () => {
		// Whitespace-tolerant: the formatter wraps this call across lines.
		expect(SRC).toMatch(
			/requireClubRole\(\s*user\.id,\s*args\.clubId,\s*\[\s*["']admin["'],?\s*\]/,
		);
	});

	it("never gates a write on the member role", () => {
		expect(SRC).not.toMatch(/requireClubRole\([^)]*\[\s*["']member["'],?\s*\]/);
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
			expect(handlerBody(SRC, fn)).toContain(
				"assertMeetingNotLocked(meeting.status)",
			);
		});

		it(`${fn} resolves the actor through the shared self-only gate`, () => {
			expect(handlerBody(SRC, fn)).toContain("await resolveActor(");
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
			for (const later of [
				"assertMeetingNotLocked(",
				"requireMemberInClub(",
				"resolveActor(",
			]) {
				expect(
					body.indexOf(later),
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
		const body = SRC.slice(SRC.indexOf("async function resolveActor"));
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
		expect(body).toContain('if (!viaOfficer && data.status === "reached_out")');
		expect(
			body,
			"the officer-only rung must THROW; an empty block passes a condition-only assertion",
		).toContain("throw new Error(OFFICER_ONLY_REACHED_OUT_MESSAGE)");
	});

	it("never lets a session-less caller delete an officer's reached_out", () => {
		// The clear path has no rung check of its own — it restricts the SEAM
		// instead, which is the half that actually reaches the database. Deleting
		// the officer's outreach record used to require `requireUser()` +
		// `requireClubRole(admin)`; after the consolidation it is one row with the
		// member's own answer, and this endpoint takes no session at all.
		const body = handlerBody(SRC, "clearPlannedAttendance");
		expect(
			body,
			"clearPlannedAttendance must resolve the officer branch — otherwise it " +
				"cannot tell who is allowed to remove a `reached_out` row",
		).toContain("viaOfficer");
		expect(
			body,
			"the non-officer arm must be restricted to the self-service rungs",
		).toContain("onlyFrom: viaOfficer ? undefined : SELF_SERVICE_RUNGS");
	});

	it("reports the officer branch rather than inferring it from a null actor", () => {
		// A null actor means "impersonating superadmin" only because a read-only
		// session falls through and is rejected below — an accident of ordering,
		// not an invariant. So the branch is RETURNED by resolveActor, and the
		// negative is scoped to the handler bodies, which is where a consumer
		// would be tempted to re-derive it. (Module scope would false-FAIL on the
		// prose above, which names the pattern to warn against it — the reason
		// guard-source keeps negatives verbatim and positives comment-blind.)
		expect(SRC).toContain("viaOfficer: true");
		expect(SRC).toContain("viaOfficer: false");
		for (const fn of HANDLERS) {
			expect(
				handlerBody(RAW, fn),
				`${fn} must use the reported branch, not re-derive it from the actor id`,
			).not.toContain("actorMemberId === null");
		}
	});

	it("never reads the club from the request payload", () => {
		expect(
			RAW,
			"the club must come from the meeting row (#396) — a payload clubId is not evidence of anything",
		).not.toContain("data.clubId");
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
			/demoteFrom:\s*\n?\s*data\.via === "nudge" && data\.status === "reached_out"\s*\n?\s*\?\s*\["reached_out"\]\s*\n?\s*:\s*undefined/,
		);
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
