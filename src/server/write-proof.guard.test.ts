/**
 * Every POST server fn either needs a session, or says in writing why it does
 * not (#761, ADR-0026).
 *
 * ## Why a derived sweep and not a list
 *
 * `actor-provenance.guard.test.ts` hand-lists four modules. A hand-list cannot
 * catch the write nobody remembered to add, which is how the two failures this
 * repo has already shipped both arrived: #341 and #318 each added an ungated
 * public reader and nothing failed, and #560's minutes leak sat behind a guard
 * that was green. So the candidate set here is DERIVED: every
 * `export const <Name> = createServerFn(…)` whose method is not `GET`, in the
 * non-test, non-`*-logic.ts` modules directly under `src/server/`, keyed
 * `<file>#<Name>`. **A POST fn that is not in the exceptions map below is
 * `session` by default**, so a new write with no session gate fails on the day
 * it is written rather than on the day somebody sweeps again.
 *
 * Both narrowings in that sentence — non-recursive, and `-logic.ts` excluded —
 * are argued at `postServerFns`, and the second is CHECKED rather than
 * trusted, because a candidate silently leaving the set is the exact shape this
 * guard exists to catch. The method filter fails closed for the same reason: a
 * declaration whose method cannot be read is swept, not skipped.
 *
 * The map is the debt register, not the rule. Each class says what kind of debt
 * it is and which issue retires it; the Phase 1 children (slots, attendance,
 * ballots) each flip their own rows.
 *
 * ## Mutation record — MEASURED, not assumed
 *
 * A guard nobody has seen fail is a guard nobody knows works. All three
 * required failure modes were injected against this branch and observed red,
 * then reverted:
 *
 *  (a) **A NEW POST fn with no session gate and no map entry fails.** Appended
 *      `export const brandNewWriteFn = createServerFn({ method: "POST" }).handler(
 *      async () => ({ ok: true as const }));` to `src/server/outreach.ts`
 *      → `every POST server fn proves a session or is classified` failed naming
 *      `outreach.ts#brandNewWriteFn`. A NEW declaration deliberately, not a
 *      broken existing one: this repo's guard-vacuity learning is that mutating
 *      an existing case can pass for reasons unrelated to enrolment.
 *  (b) **An existing default-`session` fn with its gate removed fails.**
 *      Replaced `const user = await requireUser();` with `const user = { id: "x" };`
 *      in `src/server/outreach.ts#setContacted` → the same test failed naming
 *      `outreach.ts#setContacted`.
 *  (c) **A map key naming no fn fails.** Added
 *      `"slots.ts#claimSlotTypo": { class: "pending-proof", reason: "x" }`
 *      → `every exception names a server fn that exists` failed naming that key.
 *
 * And the fourth, which the issue asks for separately: an entry with
 * `reason: ""` fails `every exception carries a reason`.
 *
 * #824 added a fifth and a sixth, measured the same way and reverted:
 *
 *  (e) **Deleting `setActiveClub`'s new gate fails.** Removing
 *      `await requireUser();` from `src/server/auth-context.ts#setActiveClub`
 *      → `every POST server fn proves a session or is classified` failed naming
 *      `auth-context.ts#setActiveClub`. That is the default sweep doing its job
 *      now that the fn is no longer waived.
 *  (f) **Putting the waiver BACK fails.** Restoring the
 *      `auth-context.ts#setActiveClub` row in `NON_WRITE_POSTS` → `setActiveClub
 *      is swept by default, not waived (#824)` failed; the same row in
 *      `WRITE_PROOF_EXCEPTIONS` failed it and the count case together. (f) is
 *      the one that matters: a waiver silences (e), so without it the gate is
 *      two edits from gone with every suite green.
 *
 * ## Reading mode
 *
 * Comment-blind (`readSource`, see `src/test/guard-source.ts`). The gate
 * assertion is the "must BE present" class, where a comment naming `requireUser`
 * would satisfy a raw `toContain` after the real call was deleted — a false
 * PASS, and the exact bypass that file exists to close. The candidate
 * derivation rides the same read, which means a commented-out `createServerFn`
 * is not a candidate: correct, it is not live code.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	readSource,
	serverFnDeclarations,
	TOP_LEVEL_BOUNDARY,
} from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");
const SERVER = resolve(ROOT, "src/server");

/**
 * One `export async function <name>(…)` declaration, sliced to the next
 * top-level one.
 *
 * The same slicing `serverFnDeclarations` does, for the plain functions the
 * gates are: a fixed-width window past the name crosses into whatever follows,
 * and then a NEIGHBOUR's `requireUser` satisfies an assertion about this
 * function. That is #565, and having it inside the check that validates the
 * gates would be the worst place for it.
 */
function namedFunctionBody(source: string, name: string): string {
	const at = source.search(
		new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"),
	);
	if (at === -1) {
		throw new Error(
			`${name} is no longer declared as a function where this guard expects it. Re-point the entry rather than deleting it.`,
		);
	}
	const lines = source.slice(at).split("\n");
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && TOP_LEVEL_BOUNDARY.test(lines[i] as string)) {
			return source.slice(at, at + offset);
		}
		offset += (lines[i] as string).length + 1;
	}
	return source.slice(at);
}

/**
 * Why a POST fn is allowed to succeed without a session.
 *
 * - `fill-blank` — accepts an asserted identity only to fill an EMPTY value.
 *   ADR-0026's line: an unverified picker may fill a blank, and nothing else.
 * - `console-asserted` — Phase 2 debt. A role console (TMOD, Grammarian, Timer,
 *   Vote Counter) granting on an asserted role holder.
 *
 *   **#747 did NOT retire any of these, and that is the decision rather than an
 *   omission.** It bound the self-assert to the session where one EXISTS — a
 *   signed-in caller must now assert their own membership, and a session with no
 *   membership in this club is refused outright — but it deliberately left the
 *   session-LESS path alone, because the Toastmaster running the agenda from
 *   their phone with no account is the workflow ADR-0010 built and #747's
 *   grilling kept. What #747 removed is narrower and is not visible here: an
 *   asserted identity can no longer OVERRIDE a proven one.
 *
 *   **#752 retired exactly two, and the cut is inside one console rather than
 *   across the class.** `disqualifyCandidateFn` / `undoDisqualificationFn` now
 *   call `requireSignedInVoteCounter` and are swept by default; every other row
 *   still succeeds with no session, which is what this class asserts. The
 *   Ballot Counter console itself is NOT retired — its other five capabilities
 *   (open, close, tally, Table Topics capture, award set/clear) stay here, so a
 *   future sweep must not read "#752 shipped" as "the Vote Counter rows can
 *   go". Ruling on a named third party is the property that moved, not the
 *   console.
 *
 *   The class stays for the rest until a console genuinely requires a session,
 *   which is a product decision about the account-less role holder and not a
 *   refactor.
 * - `public-intake` — no SESSION and no asserted member id; a bounded write
 *   from a public link. Not "no identity at all", which was this line's first
 *   wording and is false for `joinBallot`: it takes a typed name and looks it
 *   up club-scoped, returning the existing guest row when there is one (#765).
 *   The class is about where the identity comes from — a person typing their
 *   own name into an intake form — not about there being none.
 * - `pending-proof` — Phase 1 debt, flipped by its own child issue.
 */
type WriteProofClass =
	| "fill-blank"
	| "console-asserted"
	| "public-intake"
	| "pending-proof";

/**
 * The POST fns that are NOT `session`, each with the reason it is not.
 *
 * The 29 the #761 inventory found, less the five #762 retired and the two #752
 * retired: 24 today (6 `pending-proof`, 14 `console-asserted`, 2
 * `public-intake`, 2 `fill-blank`). Adding a row is a decision about a write's
 * trust model, not a way to get green — a genuinely session-less write that
 * turns up unclassified is a finding to report, not an entry to make.
 *
 * NOT exported, though #761 specified it as `export`: Biome's
 * `lint/suspicious/noExportsInTest` is an ERROR in this repo's gate, and CI's
 * `check` job runs it. Nothing needs the export — the Phase 1 children edit
 * these rows in place, and a `.test.ts` is not an import target.
 */
const WRITE_PROOF_EXCEPTIONS: Record<
	string,
	{ class: WriteProofClass; reason: string }
> = {
	// --- Phase 1: the slots child ------------------------------------------
	// The honour-system sign-up sheet (ADR-0010). Claiming an open role is a
	// blank being filled; releasing, reassigning and editing someone's speech
	// details are not, and that split is the child's job.
	"slots.ts#claimSlot": { class: "pending-proof", reason: "slots child" },
	"slots.ts#releaseSlot": { class: "pending-proof", reason: "slots child" },
	"slots.ts#reassignSlot": { class: "pending-proof", reason: "slots child" },
	"slots.ts#updateSpeakerDetails": {
		class: "pending-proof",
		reason: "slots child",
	},
	"slots.ts#confirmSlot": { class: "pending-proof", reason: "slots child" },

	// --- Phase 1: the attendance child, RETIRED by #762 ---------------------
	// A first answer fills a blank and frees nothing; changing or clearing one,
	// and the release arms, are what need a proven actor. Both survivors write a
	// rung an asserted roster pick is allowed to SET and not to CHANGE — the
	// seam refuses the overwrite with `SIGN_IN_REQUIRED_MESSAGE`.
	//
	// Their three siblings are gone from this map rather than reclassified, and
	// that is the retirement working: `clearPlannedAttendance`,
	// `clearAvailability` and `markUnavailableReleasing` each call
	// `requireSessionActor` in their own handler now, so the default-`session`
	// sweep covers them and a row here would only hide a gate being deleted.
	"attendance-plan.ts#setPlannedAttendance": {
		class: "fill-blank",
		reason: "ADR-0026",
	},
	"availability.ts#setAvailability": {
		class: "fill-blank",
		reason: "ADR-0026",
	},

	// --- Phase 1: the ballots child -----------------------------------------
	// A first vote fills a blank; changing one is bound to the casting device.
	"voting.ts#submitVote": { class: "pending-proof", reason: "ballots child" },

	// --- Phase 2: the role consoles (#747 / #752) ---------------------------
	// Each grants on a SELF-ASSERTED role holder — the meeting's TMOD,
	// Grammarian, Timer or Vote Counter. ADR-0010 called that interim; ADR-0026
	// puts a date on it.
	//
	// #747 landed and moved NONE of them, on purpose: it bound the self-assert to
	// the session where there is one (`resolveSelfAssertGrant`,
	// `meeting-authz-logic.ts`) and left the anonymous path untouched, so all
	// fifteen behind those three resolvers still succeed with no session. The
	// sixteenth, `timings.ts#recordTiming`, is not behind them at all — it
	// attributes through `resolveWriteActor` — so #747 could not have reached it
	// either way. See the class note above.
	"meetings.ts#updateMeeting": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"meetings.ts#updateWordOfTheDay": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"slots.ts#addSpeakerSlot": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"slots.ts#removeSpeakerSlot": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"slots.ts#moveSpeakerSlot": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"slots.ts#moveEvaluatorSlot": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"minutes.ts#addTableTopics": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"minutes.ts#removeTableTopics": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"minutes.ts#moveTableTopics": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"minutes.ts#setMinutesAward": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"minutes.ts#clearMinutesAward": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"voting.ts#openVoteFn": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"voting.ts#closeVoteFn": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	// `voting.ts#disqualifyCandidateFn` and `voting.ts#undoDisqualificationFn`
	// were here until #752 and are now swept by DEFAULT — they call
	// `requireSignedInVoteCounter`, which is in SESSION_GATES below. Recorded as
	// a comment rather than silently absent because "the row is gone" and "the
	// row was never written" look identical, and re-adding either one would
	// waive the first console capability in this repo that genuinely requires a
	// session. They are the ONLY two rows the `console-asserted` class has ever
	// retired.
	"timings.ts#recordTiming": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},

	// --- Public intake ------------------------------------------------------
	// Neither carries a session or an asserted member id. Both mint a row from a
	// public link, from a name the person types themselves, and both are bounded
	// — `joinBallot` on name length and rows per meeting, and it resolves an
	// existing guest rather than duplicating one (#765).
	"guest-pipeline.ts#submitGuestBook": {
		class: "public-intake",
		reason: "bounded guest intake",
	},
	"voting.ts#joinBallot": {
		class: "public-intake",
		reason: "bounded guest intake",
	},
};

/**
 * POST fns that write nothing an actor could be credited for, and so are
 * outside the write-proof taxonomy entirely.
 *
 * Held APART from `WRITE_PROOF_EXCEPTIONS` on purpose. That map classifies the
 * trust model of a WRITE; a fn with no write has no trust model to classify,
 * and filing one there would put a fifth meaning into a four-class vocabulary
 * and inflate the count the issue pins.
 *
 * The bar for an entry is high and it is not "harmless": it is **mints no row,
 * mutates no row, and grants nothing that is not re-derived on read**.
 *
 * **Every entry is keyed to an OPEN issue**, the shape
 * `membership-pick-ordering.guard.test.ts`'s `FILED` uses: a waiver pointing at
 * a number somebody can close is a debt that has been FILED, which is the only
 * honest form. A waiver whose reason is only prose is a decision nobody
 * revisits.
 *
 * **EMPTY since #824, and that is the shape working.** It held exactly one fn,
 * `auth-context.ts#setActiveClub`, keyed to the issue that would decide it. #824
 * decided: the handler calls `await requireUser()` now, so the default-`session`
 * sweep covers it and a row here would only hide that gate being deleted — the
 * same reason #762's three retired rows left `WRITE_PROOF_EXCEPTIONS` outright
 * rather than being reclassified.
 *
 * Kept rather than deleted, with its bar and its issue-key rule intact. The next
 * session-less non-write POST wants this vocabulary to already exist, so that
 * the choice in front of its author is "which bucket" and not "invent one" —
 * inventing one is how a write ends up filed under a class that does not fit.
 * The two cases below are vacuous while it is empty; they are the shape an entry
 * must satisfy on the day one arrives, not a claim about today.
 */
const NON_WRITE_POSTS: Record<string, string> = {};

/**
 * Calls that PROVE a session: each reads the session itself and throws without
 * one, so a body containing one cannot be reached by an anonymous caller.
 *
 * NO `file:line` citations, and that is a correction. The first version of this
 * carried them, copied from #761's inventory at `78cba28`, under a comment
 * saying the test below "checks those citations still hold rather than trusting
 * the comment". It did not — nothing read them — and five of six were already
 * stale when the branch opened: `requireMembership :272` and
 * `requireSuperadmin :432` landed on comment lines, `requireClubRole :254` on a
 * `markImpersonatedWrite` call, and `requireMemberInClub :562-571` was really
 * at `:657-666`. A MEASURED claim that is actually ASSUMED is worse than no
 * claim, so what is recorded here now is the DELEGATION, which
 * {@link DERIVED_GATES} checks, and the disqualifying property, which
 * {@link FORBIDDEN_GATES} checks.
 */
const SESSION_GATES: string[] = [
	"requireUser",
	"requireSessionActor",
	// Module-private to `minutes.ts`, and the only `gateAdmin` in the tree.
	"gateAdmin",
	"requireMeetingTemplateEditor",
	// #752. Admitted because it reads the session ITSELF and throws without one
	// before delegating — `DERIVED_GATES` checks the READ and
	// `DERIVED_GATE_REFUSALS` checks the THROW, which together are the whole
	// reason a name can be added here at all. Both halves are needed: this is
	// the only admitted gate that DELEGATES to one admitting anonymous callers,
	// so the read alone proves nothing. Its sibling
	// `requireVoteCounterCapability` is deliberately NOT admitted and must never
	// be: that one grants the anonymous Ballot Counter, which is the exemption
	// this guard exists to tell apart from a proven one.
	"requireSignedInVoteCounter",
];

/**
 * Gates that must NEVER be admitted, and the property that disqualifies each.
 *
 * The first four take a `userId` ARGUMENT, so each proves a session only when
 * that id came from one — a property of the call site, not of the name.
 * `requireMemberInClub` is worse: it takes a MEMBER id straight off the wire and
 * reads no session at all, which is precisely the asserted identity this guard
 * exists to tell apart. Both claims are checked below against `guards.ts`.
 *
 * A written conflict worth knowing about, because both claims are in the tree:
 * `public-readers-archive-gate.guard.test.ts`'s `SESSION_GUARDS` DOES list
 * `MemberInClub`, and calls a match there "the strongest exemption the sweep
 * grants". It is wrong there for the same reason it would be wrong here, and
 * #761's review measured the cost — five POST writes exempted from that archive
 * sweep on that basis alone, two of which (`claimSlot`, `reassignSlot`) have no
 * archive check anywhere in their chain. Filed as **#825**. Not fixed here:
 * re-enrolling them changes which endpoints that guard sweeps, which is its own
 * change. This list does not follow it.
 */
const FORBIDDEN_GATES: { call: string; why: string }[] = [
	{ call: "requireClubRole", why: "takes a userId argument" },
	{ call: "requireMembership", why: "takes a userId argument" },
	{ call: "requireClubAdminView", why: "takes a userId argument" },
	{ call: "requireSuperadmin", why: "takes a userId argument" },
	{
		call: "requireMemberInClub",
		why: "takes a MEMBER id off the wire and reads no session at all",
	},
];

/**
 * Where each admitted gate is defined, and the session read it must still
 * reach.
 *
 * Every entry in {@link SESSION_GATES} appears here — `requireUser` included,
 * whose own delegation to `getSessionUser` is the root the other three stand
 * on. A gate that keeps its exemption after losing its session read is the
 * failure mode that let `SELF_ASSERT_GUARDS` hide 14 endpoints in the archive
 * sweep next door, and checking is the only thing that stops it.
 */
const DERIVED_GATES: { call: string; file: string; mustCall: string }[] = [
	{ call: "requireUser", file: "guards.ts", mustCall: "getSessionUser(" },
	{ call: "gateAdmin", file: "minutes.ts", mustCall: "requireUser(" },
	{
		call: "requireMeetingTemplateEditor",
		file: "meeting-templates-logic.ts",
		mustCall: "requireUser(",
	},
	{
		call: "requireSessionActor",
		file: "write-actor-logic.ts",
		mustCall: "getSessionUser(",
	},
	{
		call: "requireSignedInVoteCounter",
		file: "guards.ts",
		mustCall: "getSessionUser(",
	},
];

/**
 * Gates whose exemption also rests on what they do with the session they read,
 * not only on reading one.
 *
 * {@link DERIVED_GATES} above checks the READ. For most entries that is the
 * whole claim, because the read IS the gate — `requireUser` has nothing else in
 * it. `requireSignedInVoteCounter` is different: it reads, and then DELEGATES to
 * a gate that admits an anonymous caller, so the refusal in between is the only
 * thing separating the two. Deleting that one line leaves `getSessionUser(`
 * sitting in the body, so `DERIVED_GATES` passes, `GATE_CALL` still matches the
 * name in both handlers so the sweep passes, and `voting-authz.guard.test.ts`
 * reads only `voting.ts` so it passes too — re-admitting every anonymous caller
 * to a gate three guard files trust as session-proving. MEASURED: that deletion
 * left this whole file green before this block existed, and the only red was the
 * DB-backed integration suite, which `describe.skipIf(!hasTestDb)` removes
 * entirely from a `bun run test` with no `TEST_DATABASE_URL`.
 *
 * The throw is asserted by its MESSAGE constant rather than a bare `throw`,
 * because the message is the wire format the console renders too — a gate that
 * throws something else has broken the other half of the same policy.
 */
const DERIVED_GATE_REFUSALS: {
	call: string;
	file: string;
	mustContain: string;
}[] = [
	{
		call: "requireSignedInVoteCounter",
		file: "guards.ts",
		mustContain: "throw new Error(RULING_NEEDS_SESSION_MESSAGE)",
	},
];

/**
 * A gate call that is actually AWAITED.
 *
 * The `await` is not decoration, and the first version of this regex did not
 * require it. MEASURED during #762's review: replacing
 * `await requireSessionActor({ clubId: meeting.clubId });` with
 * `void requireSessionActor({ clubId: meeting.clubId }).catch(() => {});` in
 * `clearPlannedAttendance` left 198 files and 3255 server tests green, plus
 * typecheck and biome — the refusal became an unhandled rejection and the
 * write went ahead. Deleting the call outright WAS caught, so the guard was
 * catching the careless edit and missing the plausible one.
 *
 * Every real gate call in `src/server` is `await <gate>(` today (68 + 60 + 11
 * `requireUser`, 8 `requireMeetingTemplateEditor`, 3 each of
 * `requireSessionActor` and `gateAdmin`), so requiring it costs nothing and
 * closes the shape. Comment-blind, so the prose that names these functions is
 * not a gate.
 */
const GATE_CALL = new RegExp(`await\\s+(?:${SESSION_GATES.join("|")})\\s*\\(`);

/** A seam invoked with the shared db client — `setPlanStatus(db, {`,
 *  `clearPlanStatus(db, {`, `releaseSlotsAndMarkUnavailable(db, {`. It is the
 *  shape every write in these modules takes, and `loadMeeting`-style reads use
 *  `db.select(` instead, so it marks the point a gate must already have run. */
const DB_WRITE_CALL = "(db, ";

/**
 * `<file>#<Name>` → its comment-blind body, for every POST server fn.
 *
 * Two narrowings, both deliberate and both worth stating because the header
 * above describes the candidate set as "every `createServerFn` under
 * `src/server/`" and this is what that actually means:
 *
 *  - **`readdirSync` is NOT recursive**, so `src/server/mcp/` is out of scope.
 *    That surface authenticates on a bearer token rather than a session
 *    (`mcp/authz-logic.ts`) and `mcp-pending-lifecycle.guard.test.ts` is its
 *    sweep; classifying it by session gates would be the wrong question.
 *  - **`*-logic.ts` is excluded.** Those modules are the db-touching seams that
 *    `server-modules.guard.test.ts` forbids from exporting `createServerFn`s at
 *    all, so the set is empty by construction. `POST fns live only in the files
 *    this sweep reads` below checks that rather than trusting it — otherwise a
 *    POST fn landing in a `-logic.ts` would drop out silently, which is exactly
 *    the shape this guard exists to catch.
 *
 * Fails CLOSED on the method: anything that is not a readable `"GET"` is a
 * candidate. A declaration naming no method reports `"UNKNOWN"`
 * (`serverFnDeclarations`), and skipping what cannot be read is how a sweep
 * loses an endpoint to a declaration STYLE.
 */
function postServerFns(): Map<string, string> {
	const out = new Map<string, string>();
	for (const file of serverFiles()) {
		for (const decl of serverFnDeclarations(
			readSource(resolve(SERVER, file)),
		)) {
			if (decl.method === "GET") continue;
			out.set(`${file}#${decl.name}`, decl.body);
		}
	}
	return out;
}

/** The non-test, non-`-logic` modules directly under `src/server`. */
function serverFiles(): string[] {
	return readdirSync(SERVER)
		.filter(
			(f) =>
				f.endsWith(".ts") && !f.includes(".test.") && !f.endsWith("-logic.ts"),
		)
		.sort();
}

const POST_FNS = postServerFns();

describe("write-proof classification of every POST server fn (#761)", () => {
	// Vacuity: a walk that finds nothing passes every assertion below, and a
	// derivation that silently stops matching is indistinguishable from a clean
	// sweep. Both floors are well under today's counts and well over zero.
	it("finds the POST server fns at all", () => {
		expect(POST_FNS.size).toBeGreaterThan(100);
	});

	it("POST fns live only in the files this sweep reads", () => {
		// The exclusion above is safe only while it is EMPTY. A `createServerFn`
		// in a `-logic.ts` would be invisible here and would violate
		// `server-modules.guard.test.ts` at the same time, so this is a
		// belt-and-braces check on a set that should never grow.
		const strays: string[] = [];
		for (const f of readdirSync(SERVER)) {
			if (!f.endsWith("-logic.ts")) continue;
			for (const decl of serverFnDeclarations(readSource(resolve(SERVER, f)))) {
				strays.push(`${f}#${decl.name}`);
			}
		}
		expect(
			strays,
			`A createServerFn in a *-logic.ts module is invisible to this sweep and unclassifiable: ${strays.join(", ")}. Move it to its server-fn module (server-modules.guard.test.ts has the reason).`,
		).toEqual([]);
	});

	it("finds default-`session` fns to check, not only exceptions", () => {
		const defaults = [...POST_FNS.keys()].filter(
			(k) => !(k in WRITE_PROOF_EXCEPTIONS) && !(k in NON_WRITE_POSTS),
		);
		expect(defaults.length).toBeGreaterThan(50);
	});

	it("every POST server fn proves a session or is classified", () => {
		const offenders: string[] = [];
		for (const [key, body] of POST_FNS) {
			if (key in WRITE_PROOF_EXCEPTIONS || key in NON_WRITE_POSTS) continue;
			if (GATE_CALL.test(body)) continue;
			offenders.push(key);
		}
		expect(
			offenders,
			`These POST server fns succeed with NO session and are not classified: ${offenders.join(", ")}.\n` +
				`Add a session gate (${SESSION_GATES.join(" / ")}), or classify it in WRITE_PROOF_EXCEPTIONS with a reason.\n` +
				`A gate that takes a userId ARGUMENT (requireClubRole, requireMembership, requireClubAdminView, requireSuperadmin) does not count, and requireMemberInClub reads no session at all.`,
		).toEqual([]);
	});

	it("a session gate is AWAITED and runs before the write it guards", () => {
		// Two failure shapes the presence check above cannot see, both measured:
		// a gate whose rejection is swallowed (`void …catch()`), and a gate that
		// runs after the write has already landed. The first is handled by
		// GATE_CALL requiring `await` — see its note. This is the second.
		//
		// Behaviourally invisible, like everything else about these handlers: a
		// `createServerFn` body cannot be invoked in vitest, so nothing but the
		// source can see the ORDER. The same reason `attendance-plan-authz` pins
		// the archive gate's position rather than executing it.
		const offenders: string[] = [];
		for (const [key, body] of POST_FNS) {
			if (key in WRITE_PROOF_EXCEPTIONS || key in NON_WRITE_POSTS) continue;
			const gate = body.search(GATE_CALL);
			// No gate at all is the assertion above's finding, not this one's.
			if (gate === -1) continue;
			const write = body.indexOf(DB_WRITE_CALL);
			if (write !== -1 && write < gate) offenders.push(key);
		}
		expect(
			offenders,
			`These POST server fns reach a db seam before their session gate: ${offenders.join(", ")}.\n` +
				`A gate that runs after the write refuses nothing — move it above the first \`${DB_WRITE_CALL}\` call.`,
		).toEqual([]);
	});

	it("every exception names a server fn that exists", () => {
		const stale = Object.keys(WRITE_PROOF_EXCEPTIONS).filter(
			(k) => !POST_FNS.has(k),
		);
		expect(
			stale,
			`These WRITE_PROOF_EXCEPTIONS keys match no POST createServerFn: ${stale.join(", ")}.\n` +
				`A stale key is a waiver with nothing under it — the fn was renamed, moved, or turned into a GET, and whatever replaced it is now unclassified. Re-point the key or delete it.`,
		).toEqual([]);
	});

	it("every exception carries a reason", () => {
		const blank = Object.entries(WRITE_PROOF_EXCEPTIONS)
			.filter(([, v]) => v.reason.trim() === "")
			.map(([k]) => k);
		expect(
			blank,
			`These WRITE_PROOF_EXCEPTIONS entries have an empty reason: ${blank.join(", ")}. The reason is the whole value of the map — without it the entry records that somebody once decided, not what they decided.`,
		).toEqual([]);
	});

	it("every non-write POST carries a reason too", () => {
		const blank = Object.entries(NON_WRITE_POSTS)
			.filter(([, v]) => v.trim() === "")
			.map(([k]) => k);
		expect(blank).toEqual([]);
		const stale = Object.keys(NON_WRITE_POSTS).filter((k) => !POST_FNS.has(k));
		expect(
			stale,
			`NON_WRITE_POSTS names no such fn: ${stale.join(", ")}`,
		).toEqual([]);
	});

	it("every `fill-blank` exception actually writes in fill-blank mode", () => {
		// The class is a CLAIM about the handler, and until #762 nothing checked
		// any of the four. That is not hypothetical: replacing
		// `setPlannedAttendance`'s `if (proof === "asserted" && …)` with
		// `if (false)` was measured against this branch and left every other suite
		// in the repo GREEN — a `createServerFn` body cannot be invoked in vitest,
		// so the fill-blank decision of the two fns that make it is reachable by
		// source text and nothing else (CODING_STANDARDS.md, "WRITES are closed
		// too").
		//
		// BOTH halves, because each is deletable while the other stands. Without
		// the branch, a fn that still names `onlyIfAbsent: true` takes it on no
		// path; without the write mode, a fn that still reads the proof does
		// nothing with the answer. Either one alone re-opens #699 on that
		// endpoint, silently, with this map still calling it `fill-blank`.
		const offenders: string[] = [];
		for (const [key, { class: cls }] of Object.entries(
			WRITE_PROOF_EXCEPTIONS,
		)) {
			if (cls !== "fill-blank") continue;
			const body = POST_FNS.get(key) ?? "";
			if (!body.includes('proof === "asserted"')) {
				offenders.push(`${key} (never branches on the proof)`);
			}
			if (!body.includes("onlyIfAbsent: true")) {
				offenders.push(`${key} (never asks the seam for a fill-blank write)`);
			}
		}
		expect(
			offenders,
			`A \`fill-blank\` row claims the fn admits an asserted caller ONLY to fill an empty value (ADR-0026): ${offenders.join(", ")}.\n` +
				`It must branch on the resolved proof AND pass \`onlyIfAbsent: true\` to setPlanStatus on the asserted path. ` +
				`Re-classify the row rather than deleting this assertion — an unproven write that overwrites is what #699 was.`,
		).toEqual([]);
	});

	it("setActiveClub is swept by default, not waived (#824)", () => {
		// The regression this change can ship is not the gate being deleted — the
		// default sweep above already catches that, and it was measured doing so.
		// It is the WAIVER coming back: re-adding an `auth-context.ts#setActiveClub`
		// row to either map drops the fn from that sweep, and the gate can then be
		// removed with every suite green. That is the state #824 closed, so it is
		// the state worth pinning.
		//
		// Both maps, because either one silences the sweep, and the fn's presence
		// in POST_FNS first: a rename would make the two absence assertions pass
		// by describing nothing.
		//
		// `Object.keys(…)` + `not.toContain`, NOT `not.toHaveProperty`. The key
		// carries dots (`auth-context.ts#…`) and `toHaveProperty` reads a dotted
		// string as a PATH, so its absence half can be satisfied by the traversal
		// failing rather than by the waiver being gone — a false pass in exactly
		// the direction that matters here.
		const key = "auth-context.ts#setActiveClub";
		expect(
			POST_FNS.has(key),
			`${key} is no longer a POST createServerFn. #824 gated it on a session; re-point this case rather than deleting it.`,
		).toBe(true);
		expect(
			Object.keys(WRITE_PROOF_EXCEPTIONS),
			`${key} writes a cookie and no row, so it has no write trust model to classify. #824 gated it on requireUser instead — do not waive it back.`,
		).not.toContain(key);
		expect(
			Object.keys(NON_WRITE_POSTS),
			`${key} was this map's only entry until #824 gated it. A row here exempts it from the default sweep above, so the gate could then be deleted with every suite green — which is the state #824 closed.`,
		).not.toContain(key);
	});

	it("holds exactly the 24 exceptions left after #762 and #752", () => {
		// The count is pinned, not just the shape. A twenty-fifth arriving
		// silently is the thing to notice — either a new session-less write, or a
		// child issue's row landing without its sibling being retired.
		//
		// #762 moved five of the eleven `pending-proof` rows the #761 inventory
		// found: two became `fill-blank` and three left the map entirely for the
		// default `session` sweep. `fill-blank` is counted from here on, because a
		// class that is in the vocabulary and in nobody's total is a class a row
		// can be parked in without moving any number anyone reads.
		//
		// #752 then took two `console-asserted` rows — the disqualify pair, which
		// now require a session — so that class reads 14 rather than 16. It is
		// the first time this class has shrunk, and the pair is the whole of it:
		// the other five Ballot Counter capabilities are still here, so a drop to
		// 9 would mean the console went with them.
		const byClass = (c: WriteProofClass) =>
			Object.values(WRITE_PROOF_EXCEPTIONS).filter((v) => v.class === c).length;
		expect({
			total: Object.keys(WRITE_PROOF_EXCEPTIONS).length,
			pendingProof: byClass("pending-proof"),
			consoleAsserted: byClass("console-asserted"),
			publicIntake: byClass("public-intake"),
			fillBlank: byClass("fill-blank"),
		}).toEqual({
			total: 24,
			pendingProof: 6,
			consoleAsserted: 14,
			publicIntake: 2,
			fillBlank: 2,
		});
	});
});

describe("the session gates themselves (#761)", () => {
	it("never admits a gate that does not read the session itself", () => {
		// Each of these is a plausible-looking addition that would exempt every
		// caller BY NAME rather than by proof — which is how 14 endpoints hid
		// behind `SELF_ASSERT_GUARDS` in the archive sweep next door.
		for (const f of FORBIDDEN_GATES) {
			expect(
				SESSION_GATES,
				`${f.call} ${f.why}, so it does not prove a session on its own.`,
			).not.toContain(f.call);
		}
	});

	it("the forbidden gates really are what this says they are", () => {
		// The claims in FORBIDDEN_GATES, CHECKED rather than asserted in prose —
		// the correction #761's review forced, after five of six `file:line`
		// citations here turned out to be stale under a comment claiming a test
		// verified them.
		//
		// Reads the DECLARATION, sliced to its own end: a whole-file grep would be
		// satisfied by a neighbour, which is the #565 shape.
		const guards = readSource(resolve(SERVER, "guards.ts"));
		for (const f of FORBIDDEN_GATES) {
			const decl = namedFunctionBody(guards, f.call);
			if (f.call === "requireMemberInClub") {
				// The strongest claim in this file, and the one that most needs to be
				// a test: "reads no session at all". If this fn ever gains one, the
				// reason it is forbidden evaporates and the sentence above becomes a
				// lie that nothing catches.
				expect(
					decl,
					`requireMemberInClub now reads the session. The whole reason it is forbidden from SESSION_GATES is that it does not — re-decide, do not just delete the row.`,
				).not.toMatch(/getSessionUser\(|requireUser\(/);
			} else {
				// "Takes a userId argument" — the property that makes the name
				// insufficient. Checked on the signature, which is the first line of
				// the slice.
				expect(
					decl.slice(0, decl.indexOf(")") + 1),
					`${f.call} no longer takes a userId argument, so the reason it is forbidden from SESSION_GATES has changed. Re-decide rather than editing the comment.`,
				).toContain("userId: string");
			}
		}
	});

	it("each session gate really reads the session", () => {
		// Every gate's delegation, checked against its own DECLARATION rather than
		// a fixed-width window. The first version read `src.slice(at, at + 900)`,
		// which crosses declaration boundaries — the #565 over-capture shape, in
		// the very check that validates the gates: a neighbour's `requireUser`
		// would have satisfied it for a gate that had lost its own.
		//
		// Comment-blind, because this is a "must BE present" assertion and a
		// comment naming `requireUser` would satisfy a raw read after the call was
		// deleted.
		for (const g of DERIVED_GATES) {
			const decl = namedFunctionBody(
				readSource(resolve(SERVER, g.file)),
				g.call,
			);
			expect(
				decl,
				`${g.call} (${g.file}) no longer calls ${g.mustCall} — it is in SESSION_GATES claiming to read the session and throw without one, and every POST fn behind it is exempt on that claim.`,
			).toContain(g.mustCall);
		}
	});

	// The other half of the claim, for the gates that DELEGATE. See
	// DERIVED_GATE_REFUSALS: reading the session is not a gate unless something
	// is done with the answer, and for `requireSignedInVoteCounter` the thing
	// done with it is one line that every other guard in the tree is blind to.
	it("a delegating gate still REFUSES when there is no session", () => {
		for (const g of DERIVED_GATE_REFUSALS) {
			const decl = namedFunctionBody(
				readSource(resolve(SERVER, g.file)),
				g.call,
			);
			expect(
				decl,
				`${g.call} (${g.file}) reads the session but no longer refuses without one — it delegates to a gate that admits an anonymous caller, so this line is the whole of its exemption. Every POST fn behind it is classified session-proving on this claim.`,
			).toContain(g.mustContain);
		}
	});

	it("requireUser still throws the message the client matches", () => {
		// `SIGN_IN_REQUIRED_MESSAGE` IS the wire format (see `#/lib/write-proof`):
		// an Error subclass does not survive a createServerFn round trip, so the
		// "Sign in" toast action recognises the refusal by its text. If
		// `requireUser` stops raising exactly this, every refusal it produces
		// degrades to a plain toast with nothing failing.
		//
		// INTERPOLATED, not restated. A literal here would false-FAIL on a reword
		// that both sides made together, which is the failure that teaches people
		// to edit the guard instead of reading it.
		expect(
			namedFunctionBody(
				readSource(resolve(SERVER, "guards.ts")),
				"requireUser",
			),
		).toContain(`throw new Error("${SIGN_IN_REQUIRED_MESSAGE}")`);
	});
});
