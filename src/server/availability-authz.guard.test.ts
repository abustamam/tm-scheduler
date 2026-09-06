import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The one half of #675 a behavioural test cannot reach: that
 * `markUnavailableReleasing` hands its seam the client's RAW assertion.
 *
 * The gate itself lives in `releaseSlotsAndMarkUnavailable` and
 * `availability.integration.test.ts` CALLS it, which is the whole reason it went
 * into the seam — a `createServerFn` handler body cannot be invoked in vitest,
 * so a handler-gated write is covered by a source grep and nothing else
 * (CODING_STANDARDS.md, "WRITES are closed too"). What no integration test can
 * see is the ARGUMENT the unreachable handler passes, and exactly one token
 * there makes the gate vacuous while every assertion in that suite still passes:
 *
 *     claimedActorMemberId: data.actorMemberId ?? data.memberId
 *
 * That default is correct for the two delegates beside it — they resolve who to
 * CREDIT, and crediting an anonymous caller's write to the subject is the
 * product's honour system. Here it would make `actor === subject` hold for every
 * request, so the ladder's `if (actor !== args.memberId) throw` could never
 * fire and any caller could again empty a member's agenda. It is also the exact
 * expression this handler used before the fix, so a revert is one copy-paste
 * from the line above.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`): "must BE
 * present" is comment-blind, because these modules discuss their own wiring in
 * prose (this file's own explanation of the bad default is in one of them);
 * "must be ABSENT" is verbatim, because stripping only deletes text and a `//`
 * inside a string could erase a real offending call.
 */
const HANDLER_FILE = resolve(__dirname, "availability.ts");
const SEAM_FILE = resolve(__dirname, "availability-logic.ts");
/** Comment-blind — for "must BE present" only. */
const HANDLER = readSource(HANDLER_FILE);
const SEAM = readSource(SEAM_FILE);
/** Verbatim — for "must be ABSENT" only. */
const HANDLER_RAW = readFileSync(HANDLER_FILE, "utf8");
const SEAM_RAW = readFileSync(SEAM_FILE, "utf8");

/** One `export const <name> = createServerFn…` declaration, so a per-handler
 *  assertion cannot be satisfied by its neighbour's correct code — and the two
 *  neighbours here are precisely the ones that legitimately DO carry the
 *  subject default. */
function handlerBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in availability.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport const", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

describe("markUnavailableReleasing subject check (#675)", () => {
	it("hands the seam the client's raw assertion", () => {
		expect(
			handlerBody(HANDLER, "markUnavailableReleasing"),
			"the seam runs the actor ladder, so it needs the CLAIM — a resolved actor id would satisfy the subject check by construction",
		).toContain("claimedActorMemberId: data.actorMemberId,");
	});

	it("never defaults that assertion to the subject", () => {
		const body = handlerBody(HANDLER_RAW, "markUnavailableReleasing");
		expect(
			body,
			"`?? data.memberId` makes actor === subject for every request, so the ladder's self-only throw can never fire — the #675 hole, restored in one token",
		).not.toContain("data.actorMemberId ?? data.memberId");
		expect(body).not.toContain("?? data.memberId");
	});

	it("leaves the actor resolution to the seam", () => {
		// `requestWriteActor` answers "who do I credit", never "may this caller do
		// this". Calling it here again would put a second, weaker answer in front
		// of the ladder and invite the next reader to pass ITS result on.
		expect(
			handlerBody(HANDLER_RAW, "markUnavailableReleasing"),
			"the seam resolves the actor now; a second resolution here is the shape the bug wore",
		).not.toContain("requestWriteActor(");
	});

	it("still reaches the database through the guarded seam", () => {
		expect(handlerBody(HANDLER, "markUnavailableReleasing")).toContain(
			"releaseSlotsAndMarkUnavailable(db, {",
		);
	});

	it("keeps its own archive gate first, before the lock and membership checks", () => {
		// Unchanged by #675 and asserted here beside the rest of the wiring: run
		// fourth, the membership and meeting-lock checks answer first and their
		// differing errors make an archived club probeable (the existence oracle
		// #544 closed). `delegate-rungs.guard.test.ts` also pins its presence.
		const body = handlerBody(HANDLER, "markUnavailableReleasing");
		const archive = body.indexOf("assertClubNotArchived(meeting.clubId)");
		expect(archive).toBeGreaterThan(-1);
		for (const later of [
			"assertMeetingNotLocked(",
			"requireMemberInClub(",
			"releaseSlotsAndMarkUnavailable(",
		]) {
			expect(
				body.indexOf(later),
				`${later} must not run before the archive gate`,
			).toBeGreaterThan(archive);
		}
	});
});

describe("releaseSlotsAndMarkUnavailable gates in the seam (#675)", () => {
	it("reuses the shared D6 ladder rather than a second copy of it", () => {
		// A copied three-arm ladder is how the two drift, and the arms are ordered
		// for reasons a copy would not preserve (officer, then TMOD, then self).
		expect(SEAM).toMatch(/from "\.\/attendance-actor-logic"/);
		expect(SEAM).toContain("resolveActor({");
	});

	it("asserts the club is not archived, before the ladder", () => {
		// This arm takes a self-asserted member id with no session, so
		// `requireMembership`'s archive check (#186) — the choke point every authed
		// write inherits — never runs for it. Position: takedown outranks every
		// other reason to refuse, so an archived club must not answer differently
		// for an authorized caller than for an unauthorized one.
		const archive = SEAM.indexOf("assertClubNotArchived(args.clubId)");
		expect(archive).toBeGreaterThan(-1);
		expect(
			SEAM.indexOf("resolveActor({"),
			"the archive gate must not run after the ladder",
		).toBeGreaterThan(archive);
	});

	it("never accepts a pre-resolved actor again", () => {
		// The defect, pinned as a NEGATIVE. The seam used to take `actorMemberId`
		// and trust it; a caller could pass the SUBJECT's id and satisfy any
		// subject check by construction. Only the raw claim may cross this
		// boundary. (Verbatim: `claimedActorMemberId?:` carries a capital A and so
		// is not matched by this lowercase string.)
		expect(
			SEAM_RAW,
			"the seam must take `claimedActorMemberId`, never a finished `actorMemberId`",
		).not.toContain("actorMemberId?:");
	});

	it("records which arm admitted the write", () => {
		// `grantedVia` is optional on `setPlanStatus`, so a caller with a ladder
		// that forgets it drops the distinction silently — and a grant defended as
		// "auditable afterwards" is not auditable while an honour-system TMOD
		// release and a session-authenticated officer's look identical in the feed.
		expect(SEAM).toContain("grantedVia: via,");
	});
});
