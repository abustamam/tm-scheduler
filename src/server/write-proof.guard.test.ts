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
 * that was green. So the candidate set here is DERIVED — every
 * `export const <Name> = createServerFn({ method: "POST" })` under
 * `src/server/`, keyed `<file>#<Name>` — and **a POST fn that is not in the
 * exceptions map below is `session` by default.** A new write with no session
 * gate fails on the day it is written, not on the day somebody sweeps again.
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
import { readSource, serverFnDeclarations } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");
const SERVER = resolve(ROOT, "src/server");

/**
 * Why a POST fn is allowed to succeed without a session.
 *
 * - `fill-blank` — accepts an asserted identity only to fill an EMPTY value.
 *   ADR-0026's line: an unverified picker may fill a blank, and nothing else.
 * - `console-asserted` — Phase 2 debt. A role console (TMOD, Grammarian, Timer,
 *   Vote Counter) granting on an asserted role holder; #747 / #752 move these
 *   to sessions.
 * - `public-intake` — no identity at all, bounded intake from a public link.
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
 * Exactly the 29 the #761 inventory found (11 `pending-proof`,
 * 16 `console-asserted`, 2 `public-intake`). Adding a row is a decision about a
 * write's trust model, not a way to get green — a genuinely session-less write
 * that turns up unclassified is a finding to report, not an entry to make.
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

	// --- Phase 1: the attendance child --------------------------------------
	// A first answer fills a blank and frees nothing; changing or clearing one,
	// and the release arms, are what need a proven actor.
	"attendance-plan.ts#setPlannedAttendance": {
		class: "pending-proof",
		reason: "attendance child",
	},
	"attendance-plan.ts#clearPlannedAttendance": {
		class: "pending-proof",
		reason: "attendance child",
	},
	"availability.ts#setAvailability": {
		class: "pending-proof",
		reason: "attendance child",
	},
	"availability.ts#clearAvailability": {
		class: "pending-proof",
		reason: "attendance child",
	},
	"availability.ts#markUnavailableReleasing": {
		class: "pending-proof",
		reason: "attendance child",
	},

	// --- Phase 1: the ballots child -----------------------------------------
	// A first vote fills a blank; changing one is bound to the casting device.
	"voting.ts#submitVote": { class: "pending-proof", reason: "ballots child" },

	// --- Phase 2: the role consoles (#747 / #752) ---------------------------
	// Each grants on a SELF-ASSERTED role holder — the meeting's TMOD,
	// Grammarian, Timer or Vote Counter. ADR-0010 called that interim; ADR-0026
	// puts a date on it.
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
	"voting.ts#disqualifyCandidateFn": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"voting.ts#undoDisqualificationFn": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},
	"timings.ts#recordTiming": {
		class: "console-asserted",
		reason: "Phase 2 (#747 / #752)",
	},

	// --- Public intake ------------------------------------------------------
	// No identity is claimed at all. Both mint a row from a public link and are
	// bounded by their own club lock and archive gate.
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
 * mutates no row, and grants nothing that is not re-derived on read**. One fn
 * clears it today, and `public-readers-archive-gate.guard.test.ts`'s
 * `REVIEWED_UNGATED` already carries the same conclusion for the same fn with
 * the same reason, which is the review this leans on rather than a fresh one.
 * Reported in #761's PR body rather than quietly filed: the issue's inventory
 * counted 29 session-less POST fns and this is the thirtieth it did not count.
 */
const NON_WRITE_POSTS: Record<string, string> = {
	"auth-context.ts#setActiveClub":
		"writes a session-preference COOKIE and no row; `getAuthContext` re-validates it against live memberships on every read, so a session-less caller setting it gains nothing (same conclusion as REVIEWED_UNGATED in public-readers-archive-gate.guard.test.ts)",
};

/**
 * Calls that PROVE a session: each reads the session itself and throws without
 * one, so a body containing one cannot be reached by an anonymous caller.
 *
 * **`requireClubRole`, `requireMembership`, `requireClubAdminView` and
 * `requireSuperadmin` are deliberately absent.** Each takes a `userId`
 * ARGUMENT (`guards.ts:254`, `:272`, `:406`, `:432`), so it proves a session
 * only when that id came from one — which is a property of the call site, not
 * of the name. **`requireMemberInClub` must never be added**: it reads no
 * session at all (`guards.ts:562-571`) and takes a member id straight off the
 * wire, which is precisely the asserted identity this guard exists to tell
 * apart.
 *
 * Every identifier here cites the `file:line` where it reads the session and
 * throws without one, and `each session gate really reads the session` below
 * checks those citations still hold rather than trusting the comment.
 */
const SESSION_GATES: { call: string; readsSessionAt: string }[] = [
	// `const user = await getSessionUser(); if (!user) throw …`
	{ call: "requireUser", readsSessionAt: "src/server/guards.ts:62-68" },
	// #761's own gate. `requireSessionActor` → `getSessionUser()` →
	// `resolveSessionActor`, which throws SIGN_IN_REQUIRED_MESSAGE on a null
	// session and NOT_ON_ROSTER_MESSAGE on a session with no membership here.
	{
		call: "requireSessionActor",
		readsSessionAt: "src/server/write-actor-logic.ts",
	},
	// Module-private to `minutes.ts`, and the only `gateAdmin` in the tree.
	// `const currentUser = await requireUser();` on its first line.
	{ call: "gateAdmin", readsSessionAt: "src/server/minutes.ts:106-110" },
	// `const user = await requireUser();` before it resolves the meeting's club.
	{
		call: "requireMeetingTemplateEditor",
		readsSessionAt: "src/server/meeting-templates-logic.ts:73-84",
	},
];

/** Where each non-primitive gate is defined, and the primitive it delegates to.
 *  Checked below so a gate cannot keep its exemption after losing its session
 *  read — the failure mode that let `SELF_ASSERT_GUARDS` hide 14 endpoints in
 *  the archive sweep next door. */
const DERIVED_GATES: { call: string; file: string; mustCall: string }[] = [
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
];

const GATE_CALL = new RegExp(
	`(?:${SESSION_GATES.map((g) => g.call).join("|")})\\s*\\(`,
);

/** `<file>#<Name>` → its comment-blind body, for every POST server fn. */
function postServerFns(): Map<string, string> {
	const out = new Map<string, string>();
	const files = readdirSync(SERVER)
		.filter(
			(f) =>
				f.endsWith(".ts") && !f.includes(".test.") && !f.endsWith("-logic.ts"),
		)
		.sort();
	for (const file of files) {
		for (const decl of serverFnDeclarations(
			readSource(resolve(SERVER, file)),
		)) {
			if (decl.method !== "POST") continue;
			out.set(`${file}#${decl.name}`, decl.body);
		}
	}
	return out;
}

const POST_FNS = postServerFns();

describe("write-proof classification of every POST server fn (#761)", () => {
	// Vacuity: a walk that finds nothing passes every assertion below, and a
	// derivation that silently stops matching is indistinguishable from a clean
	// sweep. Both floors are well under today's counts and well over zero.
	it("finds the POST server fns at all", () => {
		expect(POST_FNS.size).toBeGreaterThan(100);
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
				`Add a session gate (${SESSION_GATES.map((g) => g.call).join(" / ")}), or classify it in WRITE_PROOF_EXCEPTIONS with a reason.\n` +
				`A gate that takes a userId ARGUMENT (requireClubRole, requireMembership, requireClubAdminView, requireSuperadmin) does not count, and requireMemberInClub reads no session at all.`,
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

	it("holds exactly the 29 exceptions the #761 inventory found", () => {
		// The count is pinned, not just the shape. A thirtieth arriving silently
		// is the thing to notice — either a new session-less write, or a child
		// issue's row landing without its sibling being retired.
		const byClass = (c: WriteProofClass) =>
			Object.values(WRITE_PROOF_EXCEPTIONS).filter((v) => v.class === c).length;
		expect({
			total: Object.keys(WRITE_PROOF_EXCEPTIONS).length,
			pendingProof: byClass("pending-proof"),
			consoleAsserted: byClass("console-asserted"),
			publicIntake: byClass("public-intake"),
		}).toEqual({
			total: 29,
			pendingProof: 11,
			consoleAsserted: 16,
			publicIntake: 2,
		});
	});
});

describe("the session gates themselves (#761)", () => {
	it("never admits a gate that takes a userId argument", () => {
		// These four are the plausible-looking additions. Each proves a session
		// only if the id it was handed came from one, which is a property of the
		// CALL SITE — so admitting them by name is how 14 endpoints hid behind
		// `SELF_ASSERT_GUARDS` in the archive sweep next door.
		const names = SESSION_GATES.map((g) => g.call);
		for (const forbidden of [
			"requireClubRole",
			"requireMembership",
			"requireClubAdminView",
			"requireSuperadmin",
			"requireMemberInClub",
		]) {
			expect(
				names,
				`${forbidden} does not read the session itself — it takes a userId (or a member id, for requireMemberInClub) as an argument. Admitting it here exempts every caller by name rather than by proof.`,
			).not.toContain(forbidden);
		}
	});

	it("each session gate really reads the session", () => {
		// The citation beside each entry in SESSION_GATES is a claim. This checks
		// it, so a gate cannot keep its exemption after its `requireUser` is
		// refactored away — comment-blind, because this is a "must BE present"
		// assertion and a comment naming `requireUser` would satisfy it.
		for (const g of DERIVED_GATES) {
			const src = readSource(resolve(SERVER, g.file));
			const at = src.indexOf(`${g.call}(`);
			expect(at, `${g.call} is no longer defined in ${g.file}`).toBeGreaterThan(
				-1,
			);
			// The definition plus enough of its body to hold the delegation. Its
			// own call site would also match `${g.call}(`, so search from the first
			// occurrence forward and require the delegation within the same region.
			expect(
				src.slice(at, at + 900),
				`${g.call} (${g.file}) no longer calls ${g.mustCall} — it is in SESSION_GATES claiming to read the session and throw without one, and every POST fn behind it is exempt on that claim.`,
			).toContain(g.mustCall);
		}
	});

	it("requireUser still throws the message the client matches", () => {
		// `SIGN_IN_REQUIRED_MESSAGE` IS the wire format (see `#/lib/write-proof`):
		// an Error subclass does not survive a createServerFn round trip, so the
		// "Sign in" toast action recognises the refusal by its text. If
		// `requireUser` stops raising exactly this, every refusal it produces
		// degrades to a plain toast with nothing failing.
		expect(readSource(resolve(SERVER, "guards.ts"))).toContain(
			'throw new Error("You need to be signed in to do that.")',
		);
	});
});
