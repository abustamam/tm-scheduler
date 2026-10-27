import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import { PLAN_ACCEPTING_CANCELLED } from "./meeting-write-options";

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

/**
 * The handler's refusal of a completed meeting, in the exact forms it may take:
 * the old per-status helper, or the write policy's `plan` class (#1135), which
 * refuses `completed`, with at most the one named options constant that hands
 * `cancelled` on to the seam. Pinned whole rather than by prefix, so none of
 * these passes: `"record"` (the class that ACCEPTS a completed meeting), an
 * inline `accept` that also lists `completed`, or an options variable whose
 * contents this file cannot see. The constant's own value is pinned below.
 */
const LOCK_CHECK =
	/assertMeetingNotLocked\(meeting\.status\)|assertMeetingAccepts\(meeting\.status, "plan"(?:, PLAN_ACCEPTING_CANCELLED)?\)/;

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

/** One `export async function <name>(` seam, up to the next top-level export, so
 *  an assertion about one seam cannot be satisfied by its neighbour's code. */
function seamBody(source: string, name: string): string {
	const start = source.indexOf(`export async function ${name}(`);
	if (start === -1) {
		throw new Error(
			`${name} not found in availability-logic.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

describe("the lock check's options constant (#1135)", () => {
	it("hands `cancelled` on and nothing else", () => {
		// The three handlers pass this constant and this guard reads only their
		// source, so the constant's value is what decides whether a completed
		// meeting is still refused: add `completed` to it and every handler would
		// accept one.
		expect(PLAN_ACCEPTING_CANCELLED).toEqual({ accept: ["cancelled"] });
	});

	it.each([
		"setAvailability",
		"clearAvailability",
		"markUnavailableReleasing",
	])("%s spells the lock check in a form LOCK_CHECK allows", (name) => {
		expect(handlerBody(HANDLER, name).search(LOCK_CHECK)).toBeGreaterThan(-1);
	});
});

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
		// The lock check, in either spelling. A bare `assertMeetingAccepts(` prefix
		// would also match `"record"`, the write class that ACCEPTS a completed
		// meeting, so the class is part of the pattern.
		const lock = body.search(LOCK_CHECK);
		expect(
			lock,
			'the handler must refuse a completed meeting: `assertMeetingNotLocked(` or `assertMeetingAccepts(…, "plan", …)`',
		).toBeGreaterThan(-1);
		expect(
			lock,
			"the lock check must not run before the archive gate",
		).toBeGreaterThan(archive);
		for (const later of [
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

describe("setAvailability: whose row a decline may be written on", () => {
	// The behaviour is executed in `availability.integration.test.ts` through
	// `setAvailabilityCore`; this pins what that file cannot see, the handler's own
	// argument list, and that the seam asks the owner-or-officer question rather
	// than the actor ladder's alone (which admits any signed-in member on another
	// member's row).
	const body = handlerBody(HANDLER, "setAvailability");
	const bodyRaw = handlerBody(HANDLER_RAW, "setAvailability");
	const seam = seamBody(SEAM, "setAvailabilityCore");
	const seamRaw = seamBody(SEAM_RAW, "setAvailabilityCore");

	it("hands the seam the SUBJECT as memberId and the client's raw claim", () => {
		expect(
			body,
			"the owner-or-officer rule compares the actor with the SUBJECT; a subject bound to the claim is always the caller's own row",
		).toMatch(
			/setAvailabilityCore\(db, \{\s*memberId: data\.memberId,[^}]*\bclaimedActorMemberId: data\.actorMemberId,/s,
		);
	});

	it("never defaults that claim to the subject", () => {
		// An asserted claim naming the subject resolves to the subject, so a
		// `?? data.memberId` here makes the owner-or-officer comparison true for
		// every request.
		expect(
			bodyRaw,
			"`?? data.memberId` would make actor === subject for every request",
		).not.toContain("?? data.memberId");
	});

	it("leaves the actor resolution to the seam", () => {
		expect(bodyRaw).not.toContain("requestWriteActor(");
		expect(bodyRaw).not.toContain("resolveOwnerOrOfficer(");
		expect(bodyRaw).not.toContain("resolveActor(");
	});

	it("resolves owner-or-officer in the seam with the subject and the raw claim", () => {
		expect(
			seam,
			"the subject check lives in resolveOwnerOrOfficer; resolveActor alone lets any signed-in member write another member's row",
		).toMatch(
			/await resolveOwnerOrOfficer\(\{[^}]*\bmemberId: args\.memberId,[^}]*\bclaimedActorMemberId: args\.claimedActorMemberId,/s,
		);
		expect(
			seamRaw,
			"the bare ladder admits any signed-in caller on another member's row",
		).not.toMatch(/\bresolveActor\(/);
	});
});

describe("clearAvailability: whose answer a clear may remove", () => {
	// The behaviour is executed in `availability.integration.test.ts`
	// ("clearAvailability: whose answer a clear may remove"), through
	// `clearAvailabilityCore`, which the handler calls after its own gates. What
	// that file cannot see is the handler's own wiring, which is what the first
	// block pins; the second pins the seam's order, which a behavioural test only
	// sees one deletion at a time.
	const body = handlerBody(HANDLER, "clearAvailability");
	const bodyRaw = handlerBody(HANDLER_RAW, "clearAvailability");
	const seam = seamBody(SEAM, "clearAvailabilityCore");

	it("hands the seam the SUBJECT as memberId and the client's raw claim", () => {
		expect(
			body,
			"the ladder compares the actor with the SUBJECT; a subject bound to the claim clears the caller's own row",
		).toContain("memberId: data.memberId,");
		expect(body, "the seam needs the CLAIM, not a finished actor id").toContain(
			"claimedActorMemberId: data.actorMemberId,",
		);
		expect(body).toContain("clearAvailabilityCore(db, {");
	});

	it("returns the seam's `cleared`, which the grid's Undo is gated on", () => {
		expect(
			body,
			"the grid offers Undo only for a clear that removed something; a constant here would offer it after a clear that deleted nothing",
		).toMatch(
			/const \{ cleared \} = await clearAvailabilityCore\(db, \{[\s\S]*return \{ ok: true as const, cleared \};/,
		);
	});

	it("never defaults that claim to the subject", () => {
		// Behind the session gate a default changes no outcome, so this is defence
		// in depth: were the gate ever lost, `?? data.memberId` would make the
		// self-only comparison true for every request.
		expect(
			bodyRaw,
			"`?? data.memberId` would make actor === subject if the session gate were ever lost",
		).not.toContain("?? data.memberId");
	});

	it("leaves the actor resolution to the seam", () => {
		// `requestWriteActor` answers "who do I credit", never "may this caller do
		// this"; a resolution here, beside the seam's own, would be a second answer
		// to who is calling, and the next reader would pass ITS result on.
		expect(bodyRaw).not.toContain("requestWriteActor(");
		expect(bodyRaw).not.toContain("resolveClearActor");
		expect(bodyRaw).not.toContain("resolveOwnerOrOfficer(");
		expect(bodyRaw).not.toContain("resolveActor(");
	});

	it("opens with the session gate, before the seam", () => {
		const gate = body.indexOf("await requireSessionActor(");
		expect(gate).toBeGreaterThan(-1);
		expect(
			body.indexOf("clearAvailabilityCore(db, {"),
			"a write surface that deletes an answer names its session gate in its own handler, before it reaches the database",
		).toBeGreaterThan(gate);
	});

	it("resolves owner-or-officer in the seam with the subject and the raw claim", () => {
		expect(
			seam,
			"the subject check lives in resolveOwnerOrOfficer; without this call any signed-in member may clear any row",
		).toMatch(
			/await resolveOwnerOrOfficer\(\{[^}]*\bmemberId: args\.memberId,[^}]*\bclaimedActorMemberId: args\.claimedActorMemberId,/s,
		);
	});

	it("refuses an unproven session between the ladder and the delete", () => {
		const ladder = seam.indexOf("await resolveOwnerOrOfficer(");
		const proof = seam.indexOf("assertSessionProof(resolved);");
		const del = seam.indexOf("clearPlanStatus(");
		expect(ladder).toBeGreaterThan(-1);
		expect(
			proof,
			"an asserted caller is admitted by the ladder, so the proof check is what keeps an anonymous caller from deleting",
		).toBeGreaterThan(ladder);
		expect(del, "the proof check must precede the delete").toBeGreaterThan(
			proof,
		);
	});

	it("floors a member's own clear at their rungs and an officer's clear of another's row at a decline", () => {
		// Pinned whole: SELF_SERVICE_RUNGS on the other-row arm would let a stale
		// grid delete a `coming` the member gave since, and CLEARABLE_ASK on the own
		// arm would stop an officer taking back their own answer.
		expect(seam).toMatch(
			/onlyFrom:\s*resolved\.actorMemberId === args\.memberId\s*\?\s*SELF_SERVICE_RUNGS\s*:\s*CLEARABLE_DECLINE/,
		);
	});

	it("refuses another member's row unless the OFFICER arm admitted the caller", () => {
		// Anchored inside `resolveOwnerOrOfficer`, and both halves of the condition
		// plus the throw: the arm test alone refuses the Toastmaster's own row, the id
		// test alone admits nobody but the subject, and a condition with no throw is
		// not a gate.
		const ladder = readSource(resolve(__dirname, "attendance-actor-logic.ts"));
		const at = ladder.indexOf("export async function resolveOwnerOrOfficer");
		expect(at, "resolveOwnerOrOfficer not found").toBeGreaterThan(-1);
		const fn = ladder.slice(at);
		expect(fn).toMatch(
			/if \(\s*resolved\.via !== "officer" &&\s*resolved\.actorMemberId !== args\.memberId\s*\) \{\s*throw new Error\(SELF_ONLY_MESSAGE\);\s*\}/,
		);
		expect(fn, "it must run the shared ladder, not a second copy").toContain(
			"await resolveActor(args)",
		);
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
