/**
 * Wiring guard for the public archive gate (#544).
 *
 * `public-readers-archive-gate.integration.test.ts` proves each gated SEAM
 * refuses an archived club. It cannot prove the `createServerFn` handlers
 * actually CALL those seams — a handler body needs the Start runtime, so no
 * test in this repo can execute one. That is the same blind spot #319 shipped
 * through: `VisitCta` and `AboutClub` were both well covered and the bug was in
 * neither, because the defect was the expression at the CALL SITE.
 *
 * Here the gap is unusually easy to fall into, because the safe and the unsafe
 * function are INTERCHANGEABLE:
 *
 *     resolveMeetingKey(clubId, key)        // no archive check
 *     resolvePublicMeetingKey(clubId, key)  // archive-gated
 *
 * Identical signatures, identical return type. Swapping one for the other
 * typechecks, passes lint, and leaves all 14 integration cases green — they
 * exercise the seam directly and never touch the handler. The same holds for
 * `listRoleDefinitions` vs `loadPublicClubRoles` and for the two extractions
 * this change made (`loadPublicClubRoster`, `loadPublicUpcomingMeetings`), whose
 * whole point was to move a query somewhere a test can reach.
 *
 * So this guard pins the wiring: every PUBLIC server fn below must call its
 * gated seam, and must not call the ungated sibling.
 *
 * READ MODE — TWO readers, one per assertion class. This file holds both, and
 * `src/test/guard-source.ts` says each class needs the opposite reader:
 *
 *   · "must CALL x" (positive) → `readStripped`. A comment naming the function
 *     satisfies a raw `toContain`, so a handler could be rewired to the ungated
 *     call while a comment above it still said `loadPublicClubRoster` and a raw
 *     read would report clean. Comment-blind closes that false PASS.
 *   · "must NOT call y" (negative) → `readRaw`. Stripping only DELETES text, and
 *     the stripper is a lexer, not a parser: it does not track string/template
 *     literals, so a `//` inside one blanks the rest of that line and could
 *     erase a real offending call from the text being searched. That is a false
 *     PASS on the half that exists to catch the regression.
 *
 * Blanket-applying either reader is the bypass #502 shipped twice in one branch,
 * in both directions.
 *
 * Mutation record, corrected. The first version of this note claimed a rewire to
 * `resolveMeetingKey` verified the NEGATIVE class. It does not: that rewire also
 * removes the gated call, so it trips the POSITIVE assertion first, and when both
 * lived in one `it` the negative never ran. The note was demonstrating the
 * positive class twice and calling it two. The classes now live in separate `it`
 * cases so neither can mask the other, and the mutation that actually reaches
 * the negative is a FALLBACK — a body that calls the gated seam and then falls
 * back to the ungated sibling (`gated ?? await resolveMeetingKey(...)`), which
 * satisfies the positive and must still fail.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");

/** Comment-blind — for "the call must BE present" assertions only. */
const readStripped = (abs: string) => readSource(abs);
/** Verbatim — for "the offending call must be ABSENT" assertions only. */
const readRaw = (abs: string) => readFileSync(abs, "utf8");

/**
 * The body of one `export const <name> = createServerFn…` declaration, sliced
 * from its call site to the next top-level `export` (or EOF).
 *
 * Statement-scoped rather than whole-file on purpose: `meetings.ts` holds both
 * the public key readers AND authed fns that legitimately call the ungated
 * `resolveMeetingKey`, so a whole-file "must not contain" assertion would be
 * unsatisfiable and a whole-file "must contain" one would be satisfied by a
 * DIFFERENT function's correct call.
 */
const TOP_LEVEL_BOUNDARY =
	/^(?:\/\*\*|\/\/|export |const |let |var |function |async function |class |type |interface |enum |declare )/;

function serverFnBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	// End at the next TOP-LEVEL declaration (or the doc comment introducing it),
	// which is the only boundary that is both tight and reliable here.
	//
	// Two earlier attempts were each wrong in one direction. Slicing to the next
	// `export` over-captured every non-exported declaration in between plus the
	// following export's JSDoc — `listUpcomingMeetings` absorbed
	// `const pastMeetingsInput = …`, `getMeetingByKey` absorbed
	// `getPublicMeetingByKey`'s doc comment. Slicing to a literal `\n});` then
	// over-captured in a way nobody could see (#565): every `createServerFn` here
	// closes at ONE TAB (`\t});`) because `.handler(` is chained one level in, so
	// that pattern never matched a declaration's own terminator. It matched the
	// next column-0 `});` — usually a later `z.object({…})` — and the slice ran
	// straight through whatever sat between.
	//
	// That is not a tidiness problem. `SESSION_GUARDS` is tested against this
	// slice, so a swallowed neighbour LENDS its `require*` call to the fn being
	// classified: `getMinutes` absorbed `gateAdmin`, matched THAT function's
	// `requireUser`, and was filed as session-guarded and skipped by the sweep
	// below — which is how the #560 minutes leak reached production behind 54/54
	// green. Measured across `src/server` at the time of the fix: 40 of 162 slices
	// over-captured, one of them by 11,000 characters. `bodyStopsAtItsOwnDeclaration`
	// now fails on any recurrence rather than leaving it invisible.
	const lines = source.slice(start).split("\n");
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		// i > 0 skips the declaration's own opening line.
		if (i > 0 && TOP_LEVEL_BOUNDARY.test(line)) {
			return source.slice(start, start + offset);
		}
		offset += line.length + 1;
	}
	return source.slice(start);
}

interface Wiring {
	/** Server-fn module, relative to `src/`. */
	file: string;
	/** The PUBLIC (no-session) server fn. */
	fn: string;
	/** The archive-gated seam it must route through. */
	mustCall: string;
	/** The ungated sibling it must NOT call. Omitted where none exists. */
	mustNotCall?: string;
	/** Why this endpoint is worth gating — shown when the case fails. */
	leaks: string;
}

const WIRINGS: Wiring[] = [
	{
		file: "server/meetings.ts",
		fn: "getTmodPanelData",
		mustCall: "loadTmodPanelData",
		// The officer-gated loaders it must NOT reach for directly: those answer
		// on the payload's server-derived `canManage`, and this fn's caller is a
		// self-asserted TMOD. Routing round the seam would skip both the archive
		// gate and the slot check in one edit.
		mustNotCall: "loadRosterWithContact(",
		leaks:
			"the officer-only reached_out rung plus every active member's phone and email",
	},
	{
		file: "server/role-definitions.ts",
		fn: "getPublicClubRoles",
		mustCall: "loadPublicClubRoles",
		mustNotCall: "listRoleDefinitions",
		leaks: "the club's role template",
	},
	{
		file: "server/clubs.ts",
		fn: "getPublicClubProfileFn",
		mustCall: "getPublicClubProfile",
		mustNotCall: "getClubProfile(",
		leaks: "club-authored mission text (the ADR-0024 takedown field)",
	},
	{
		file: "server/season-grid.ts",
		fn: "getPublicSeasonGrid",
		mustCall: "loadPublicSeasonGrid",
		mustNotCall: "loadSeasonGrid(",
		leaks: "roster names on the member axis",
	},
	{
		file: "server/members.ts",
		fn: "listMembers",
		mustCall: "loadPublicClubRoster",
		leaks: "the full active roster",
	},
	{
		file: "server/meetings.ts",
		fn: "listUpcomingMeetings",
		mustCall: "loadPublicUpcomingMeetings",
		leaks: "the club's forward schedule",
	},
	{
		file: "server/meetings.ts",
		fn: "listPastMeetings",
		mustCall: "loadPastMeetings",
		leaks: "the club's meeting history",
	},
	{
		file: "server/meetings.ts",
		fn: "getPublicMeetingByKey",
		mustCall: "resolvePublicMeetingKey",
		mustNotCall: "resolveMeetingKey(",
		leaks: "a full agenda: assignee names, speech titles, Word of the Day",
	},
	{
		// Takes a session but does not REQUIRE one, so it is just as reachable
		// anonymously as the fn above and needs the same resolver.
		file: "server/meetings.ts",
		fn: "getMeetingByKey",
		mustCall: "resolvePublicMeetingKey",
		mustNotCall: "resolveMeetingKey(",
		leaks: "a full agenda: assignee names, speech titles, Word of the Day",
	},
	{
		file: "server/voting.ts",
		fn: "getBallot",
		mustCall: "loadBallot",
		leaks: "ballot candidate names (members and guests)",
	},
	{
		// The bypass three reviewers found independently. Keyed by a bare meeting
		// UUID, so the `resolvePublicMeetingKey` seam that gates the two key-based
		// readers never applies — and it calls the SAME `loadMeetingDetail` they
		// do. The legacy `/meetings/:id` URL means every pre-takedown bookmark is
		// a working key straight past the gate on its siblings.
		file: "server/meetings.ts",
		fn: "getMeeting",
		mustCall: "isReadableClubForMeeting",
		leaks:
			"the same full agenda getPublicMeetingByKey withholds — assignee names, speech titles, Word of the Day",
	},
	{
		file: "server/meetings.ts",
		fn: "listMemberCommitments",
		mustCall: "isReadableClubForMember",
		leaks:
			"the club's NAME plus the date, theme, location and speech title of every meeting the member holds a slot in",
	},
	{
		file: "server/voting.ts",
		fn: "getVoteParticipation",
		mustCall: "loadParticipation",
		leaks:
			"per-category ballot counts and the attendance headcount — thin, but a live existence oracle for a taken-down club",
	},
	{
		file: "server/pathways-read.ts",
		fn: "getMemberPathways",
		mustCall: "pathwaysForMember",
		leaks: "a member's Pathways progress",
	},
	{
		// First link in the attack chain: slug → archived club's UUID + NAME +
		// Toastmasters club number. The logic fn keeps returning archived rows on
		// purpose (resolveClubOrRedirect needs them); the PUBLIC wrapper must not.
		file: "server/clubs.ts",
		fn: "getClubByIdentifier",
		mustCall: "resolvePublicClubIdentifier",
		mustNotCall: "resolveClubByIdentifier(",
		leaks:
			"an archived club's name and Toastmasters club number — the brand identity ADR-0024's takedown exists to remove",
	},
	{
		// The fn this guard was supposed to enrol and could not (#565). It resolves
		// membership with a bare `getMembership`, so it trips no `require*` and the
		// sweep below rightly calls it session-less — but the broken slicer lent it
		// `gateAdmin`'s `requireUser` and skipped it, and an archived club served its
		// full minutes to its own members until #560 found that by hand.
		//
		// Gated on `isReadableClub` rather than a `*-logic` seam of its own: the
		// query stayed inline in the handler, so `minutes-authz.guard.test.ts` holds
		// the ordering and polarity of the call and this row holds its presence.
		file: "server/minutes.ts",
		fn: "getMinutes",
		mustCall: "isReadableClub",
		leaks:
			"the full minutes — the roster by attendance status, guest names, awards and action items",
	},
];

describe("public server fns are wired to their archive-gated seam (#544)", () => {
	for (const w of WIRINGS) {
		// SEPARATE cases per assertion class, not two expects in one `it`. Sharing
		// an `it` makes the second assertion unreachable whenever the first fails,
		// so a mutation aimed at the negative silently demonstrates the positive
		// twice — which is exactly what the first version of this file's own
		// "verified by mutation" note claimed, wrongly.
		it(`${w.fn} calls ${w.mustCall}`, () => {
			expect(
				serverFnBody(readStripped(resolve(ROOT, "src", w.file)), w.fn),
				`${w.fn} must call ${w.mustCall} — without it an ARCHIVED club still serves ${w.leaks}. Archiving is the takedown lever (ADR-0016 / ADR-0024).`,
			).toContain(w.mustCall);
		});

		if (w.mustNotCall) {
			const mustNotCall = w.mustNotCall;
			it(`${w.fn} does not call ${mustNotCall}`, () => {
				expect(
					serverFnBody(readRaw(resolve(ROOT, "src", w.file)), w.fn),
					`${w.fn} must not call ${mustNotCall} — it carries no archive check. Use ${w.mustCall}. The two have the same signature, so nothing else in the suite can tell them apart.`,
				).not.toContain(mustNotCall);
			});
		}
	}
});

/**
 * Session-less server fns that are NOT archive-gated club readers, each with the
 * reason. Anything session-less and absent from both this map and `WIRINGS`
 * fails the enrollment test below.
 */
const REVIEWED_UNGATED: Record<string, string> = {
	// Auth/session plumbing. NOT "returns no club-owned data" — that was this
	// waiver's reason until #560, and it was false: the payload carries
	// `clubs[].name` and `clubs[].clubNumber`, the brand identity ADR-0024 leans on
	// archiving to remove. The club list is archive-filtered at its own seam now.
	getAuthContext:
		"session plumbing; the club list it returns is archive-filtered in loadUserClubMemberships (#560)",
	setActiveClub: "writes a session preference",
	// Gated, but through a different helper than a WIRINGS row can express.
	getClubLogoMeta: "gated inside loadClubLogoMeta via isReadableClub (#495)",
	// Both resolve the meeting's club and then run requireUser +
	// assertClubNotArchived + requireClubRole inside
	// `requireMeetingTemplateEditor` (meeting-templates.ts). The sweep looks for
	// a `require*` call in the fn body itself and cannot see through a local
	// helper, so these read as session-less when they are officer-gated and
	// archive-gated. Not public readers at all — reshaping a meeting is an
	// officer action, alongside reschedule and cancel.
	previewTemplateForMeeting:
		"officer-gated + archive-gated inside requireMeetingTemplateEditor (#agenda-templates)",
	applyTemplateToMeeting:
		"officer-gated + archive-gated inside requireMeetingTemplateEditor (#agenda-templates)",
	getPacketContext:
		"gated inside loadPacketContext via isReadableClubForMeeting (#589); returns an empty packet context for an archived club, so the picker offers nothing",
	getVoteTally: "gated by requireVoteCounterCapability, not by archive",
	getProjectOptions:
		"keyed by memberId; resolveMemberSubject returns null for an unknown member and the payload is the shared Pathways catalog, not club-owned data",
	// Deliberately ungated — see resolveClubByIdentifier.
	// WRITES gated by something other than the archive check.
	setAttendance: "write — gated by gateAdmin",
	addMinutesGuest: "write — gated by gateAdmin",
	removeMinutesGuest: "write — gated by gateAdmin",
	unsubscribeFromReminders: "write — gated by a signed unsubscribe token",
	// The eight session-less writes are no longer waived — they are ENFORCED by
	// `WRITE_GATES` below (#555). They sat here reading `"write — #544
	// follow-up"` for one release, which is what a waiver is for: it named the
	// hole instead of hiding it, and the sweep kept the list accurate while the
	// fix was pending.
};

/**
 * The session-less WRITES and where each one's archive gate lives (#555).
 *
 * #544 gated the public reads and scoped writes out, which created an asymmetry
 * rather than a partial fix: three of these MINT rows carrying names, so a
 * taken-down club kept accreting PII while every read of it returned empty —
 * invisible, because the writer got a silent success and no admin could reach
 * the club to look (`requireMembership` throws for an archived one).
 *
 * Why this is a separate table from `WIRINGS` rather than more rows in it.
 * `WIRINGS` pins a READ handler to a gated SEAM and forbids the ungated sibling,
 * because for reads the two are interchangeable and swapping them typechecks.
 * Writes have no such sibling pair: the gate is one call, and what varies is
 * WHERE it lives. Six of these gate in a `-logic` seam — which is strictly
 * better, because a seam is reachable from vitest and
 * `public-writers-archive-gate.integration.test.ts` executes all six — and two
 * gate in the handler because their logic is inline there and lifting it out is
 * a refactor #555 was not.
 *
 * So each row names the file the gate is IN. That is weaker than checking the
 * handler itself, and the weakness is stated rather than papered over: this
 * asserts the gate exists in the module that owns the write, not that this
 * particular write reaches it. The integration suite is what proves the six
 * seam-gated ones actually refuse; for the two handler-gated ones this guard is
 * the only gate there is, which is exactly why moving them into seams is
 * recorded in TODOS.md rather than left implied.
 */
const WRITE_GATES: { fn: string; file: string; gate: string }[] = [
	// `applySelfAdd` reads `archived_at` inside its own `FOR UPDATE` lock rather
	// than calling the assert, because a pre-check is check-then-act and this is
	// the path that mints a `people` row plus a `members` row — so it names the
	// shared message constant instead.
	{
		fn: "addMember",
		file: "src/server/members-logic.ts",
		gate: "CLUB_ARCHIVED_MESSAGE",
	},
	{
		fn: "submitGuestBook",
		file: "src/server/guest-pipeline-logic.ts",
		gate: "assertClubNotArchived",
	},
	{
		fn: "submitVote",
		file: "src/server/voting-logic.ts",
		gate: "assertClubNotArchived",
	},
	{
		fn: "joinBallot",
		file: "src/server/voting-logic.ts",
		gate: "assertClubNotArchived",
	},
	{
		fn: "openVoteFn",
		file: "src/server/voting-logic.ts",
		gate: "assertClubNotArchived",
	},
	{
		fn: "closeVoteFn",
		file: "src/server/voting-logic.ts",
		gate: "assertClubNotArchived",
	},
	// Handler-gated: the logic is inline in `slots.ts`, so the gate is in the
	// handler body and this guard is its only cover.
	{
		fn: "releaseSlot",
		file: "src/server/slots.ts",
		gate: "assertClubNotArchived",
	},
	{
		fn: "updateSpeakerDetails",
		file: "src/server/slots.ts",
		gate: "assertClubNotArchived",
	},
];

/** Calls that mean "this fn resolves a session", i.e. not an anonymous reader. */
const SESSION_GUARDS =
	/require(User|Membership|ClubRole|ClubViewAccess|ClubAdminView|Superadmin|MemberInClub|MeetingAgendaEditor|WordOfTheDayEditor|VoteCounterCapability)\w*\(/;

describe("every session-less server fn is enrolled in the gate (#544)", () => {
	/**
	 * THE fix for the failure mode #544 itself is, one level up.
	 *
	 * `WIRINGS` is an allowlist. An allowlist cannot catch a reader nobody
	 * remembered to add — and that is precisely how this bug arrived: #341 added
	 * `getPublicClubRoles` ungated, #318 added `getPublicClubProfile` ungated, and
	 * nothing failed either time. The first version of this very file listed nine
	 * readers and called the surface closed while `getMeeting` sat ungated in a
	 * file holding three enrolled entries; three independent reviewers found it.
	 *
	 * So the candidate set is DERIVED, not listed: walk `src/server/*.ts`, slice
	 * every `createServerFn`, and treat a body with no `require*` call as
	 * anonymous. Each one must be gated (`WIRINGS`) or consciously waived
	 * (`REVIEWED_UNGATED`, with a reason). A new public reader then fails on the
	 * day it is written rather than on the day someone sweeps again.
	 *
	 * Same shape as `print-page-reset.guard.test.ts`, which CLAUDE.md describes as
	 * enrolling the next print route "automatically rather than remembered".
	 *
	 * Reads RAW: this is an offender-list assertion, and stripping could only hide
	 * a real `createServerFn` from the sweep.
	 */
	const gated = new Set(WIRINGS.map((w) => w.fn));
	const dir = resolve(ROOT, "src/server");
	const files = readdirSync(dir).filter(
		(f) => f.endsWith(".ts") && !f.includes(".test."),
	);

	// Vacuity check: a walk that finds nothing passes every assertion below.
	it("finds the server-fn modules at all", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	// The check that would have caught #565 on the day it was written. Every
	// classification below is only as good as the slice it reads, and an
	// over-capturing slice fails SILENTLY and in the dangerous direction: it lends
	// a neighbour's `require*` to the fn being classified, so the fn drops out of
	// the sweep entirely. Assert the shape of the slices, not just the verdicts.
	it("slices a server fn's body without running past its own declaration", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const src = readRaw(resolve(dir, file));
			for (const m of src.matchAll(/^export const (\w+) = createServerFn/gm)) {
				const fn = m[1];
				if (!fn) continue;
				const body = serverFnBody(src, fn);
				// A column-0 declaration inside the slice means it swallowed a sibling.
				// Skipping the first line, which is the declaration's own.
				const rest = body.slice(body.indexOf("\n") + 1);
				const bled = rest
					.split("\n")
					.find((line) => TOP_LEVEL_BOUNDARY.test(line));
				if (bled !== undefined) {
					offenders.push(`${file}:${fn} → swallowed "${bled.slice(0, 60)}"`);
				}
			}
		}
		expect(
			offenders,
			`serverFnBody ran past a declaration's own end. Whatever it swallowed is now read as part of that fn, so a neighbour's require* call can classify it as session-guarded and drop it from the sweep below — that is #565, and it is how #560's minutes leak survived this guard.\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	const anonymous: { file: string; fn: string }[] = [];
	for (const file of files) {
		const src = readRaw(resolve(dir, file));
		for (const m of src.matchAll(/^export const (\w+) = createServerFn/gm)) {
			const fn = m[1];
			if (!fn) continue;
			if (SESSION_GUARDS.test(serverFnBody(src, fn))) continue;
			anonymous.push({ file, fn });
		}
	}

	it("finds session-less server fns to check", () => {
		expect(anonymous.length).toBeGreaterThan(10);
	});

	const writeGated = new Set(WRITE_GATES.map((w) => w.fn));

	for (const { file, fn } of anonymous) {
		it(`${file}:${fn} is gated or consciously waived`, () => {
			expect(
				gated.has(fn) || writeGated.has(fn) || fn in REVIEWED_UNGATED,
				`${fn} (${file}) takes no session, so an anonymous caller reaches it directly. Either gate it on clubs.archived_at and add a WIRINGS row (read) or a WRITE_GATES row (write), or add it to REVIEWED_UNGATED with the reason it needs no gate. Do not delete this case.`,
			).toBe(true);
		});
	}
});

describe("session-less writes carry the archive gate (#555)", () => {
	/**
	 * Reads STRIPPED: every assertion here is "this gate must BE present", and a
	 * comment naming `assertClubNotArchived` would satisfy a raw `toContain` while
	 * the call itself was gone. That is the false PASS `src/test/guard-source.ts`
	 * warns about for the positive class, and it is not hypothetical here — the
	 * modules in question discuss the gate at length in prose.
	 */
	for (const { fn, file, gate } of WRITE_GATES) {
		it(`${fn} is gated in ${file}`, () => {
			const src = readStripped(resolve(ROOT, file));
			expect(
				src,
				`${fn} is a session-less WRITE, so it never reaches assertClubNotArchived through requireMembership. Its gate belongs in ${file}, naming ${gate}. If you moved it, re-point this row rather than deleting it.`,
			).toContain(gate);
		});
	}

	// Vacuity checks: an empty table would pass every case above.
	it("covers every write that was waived as a #544 follow-up", () => {
		expect(WRITE_GATES).toHaveLength(8);
	});

	it("does not also waive a write it claims to gate", () => {
		// Both-listed would let a deleted gate fall back to "consciously waived"
		// and clear the sweep above.
		for (const { fn } of WRITE_GATES) {
			expect(fn in REVIEWED_UNGATED, `${fn} is both gated and waived`).toBe(
				false,
			);
		}
	});
});

describe("the gate module stays the one home for the check (#544)", () => {
	/**
	 * `isReadableClub` lived in `club-logo-logic.ts` before #544, which is a
	 * large part of why two later public readers were written without it: nobody
	 * adding a club-profile endpoint goes looking inside a LOGO module for the
	 * club-wide archive check. It now lives in `club-readable-logic.ts`. If it drifts
	 * back into a feature module, the next reader will miss it the same way.
	 */
	it("defines isReadableClub in club-readable-logic.ts and nowhere else", () => {
		// Positive → stripped; negative → raw. Same split as above.
		const home = readStripped(
			resolve(ROOT, "src/server/club-readable-logic.ts"),
		);
		expect(home).toContain("export async function isReadableClub(");
		expect(home).toContain("export async function isReadableClubForMeeting(");

		const logo = readRaw(resolve(ROOT, "src/server/club-logo-logic.ts"));
		expect(
			logo,
			"isReadableClub moved to club-readable-logic.ts (#544) so public readers can find it. Import it there rather than redefining it here.",
		).not.toContain("export async function isReadableClub");
	});
});

/**
 * The API-route sweep (#555).
 *
 * Everything above walks `src/server/*.ts` for `createServerFn`, which is the
 * right net for that shape and blind to a whole directory: `src/routes/api/**`
 * serves club content through `createFileRoute` + `server.handlers`, matches
 * none of those patterns, and was enrolled by NOTHING. Four endpoints live
 * there and three were gated by hand; the fourth — the Pathways ingest — was
 * not, and a live per-club Bearer token could keep writing member names, paths
 * and project completions into a taken-down club. That is exactly the class the
 * sweep above exists to make impossible to add by accident, one directory over.
 *
 * Recursive, because `pathways/ingest.ts` is a level down and a flat
 * `readdirSync` would have missed the one endpoint that was actually broken.
 *
 * The waiver list is the mechanism, not a weakness: an endpoint that serves no
 * club-owned data says so here, with its reason, and a NEW one fails on the day
 * it is written rather than on the day someone sweeps again.
 */
describe("API routes are enrolled in the archive gate (#555)", () => {
	/** Endpoints that legitimately need no archive check, and why. */
	const API_NO_GATE: Record<string, string> = {
		"auth/$.ts": "Better-Auth plumbing; owns no club-scoped data",
		"dev-login.ts":
			"dev-only, gated on NODE_ENV !== production AND ENABLE_DEV_LOGIN",
		"health.ts": "liveness probe; reads nothing",
	};

	/** Any of these counts as gating on the archive. */
	const API_GATES =
		/isReadableClub|isReadableClubForMeeting|isReadableClubForMember|assertClubNotArchived/;

	/**
	 * Routes whose gate lives in the `-logic` seam they delegate to, not in the
	 * route body — the normal shape here, since a route that does its own db work
	 * would fail `server-modules.guard.test.ts`.
	 *
	 * Named explicitly rather than followed automatically. Chasing imports would
	 * make this guard a resolver, and the failure mode of a half-working resolver
	 * is the one this whole file exists to prevent: it would report clean because
	 * it could not see, which is #565's shape. A wrong entry here fails loudly
	 * instead.
	 */
	const API_GATED_VIA: Record<string, string> = {
		"club.$clubId.logo.ts": "src/server/club-logo-logic.ts",
		"pathways/ingest.ts": "src/server/pathways-ingest-logic.ts",
	};

	function walk(dir: string, prefix = ""): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				out.push(...walk(resolve(dir, entry.name), rel));
			} else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
				out.push(rel);
			}
		}
		return out;
	}

	const apiDir = resolve(ROOT, "src/routes/api");
	const apiFiles = walk(apiDir);

	// Vacuity check, and the reason the walk is recursive: a flat read finds 7 of
	// the 8 and misses `pathways/ingest.ts`, the only one that was ungated.
	it("finds every API route, including nested ones", () => {
		expect(apiFiles.length).toBeGreaterThanOrEqual(8);
		expect(apiFiles).toContain("pathways/ingest.ts");
	});

	for (const file of apiFiles) {
		it(`${file} gates on the archive or is consciously waived`, () => {
			if (file in API_NO_GATE) return;
			// STRIPPED, because this is the "gate must BE present" class: a comment
			// naming `isReadableClub` would satisfy a raw read while the call was
			// gone. Three of these routes gate in their own body; two delegate, and
			// for those the seam named in `API_GATED_VIA` is what gets read.
			const via = API_GATED_VIA[file];
			const src = readStripped(resolve(via ? ROOT : apiDir, via ?? file));
			expect(
				API_GATES.test(src),
				`${file} is a public HTTP endpoint under src/routes/api, which the createServerFn sweep above does not walk. Gate it on clubs.archived_at (isReadableClub / isReadableClubForMeeting / assertClubNotArchived), or add it to API_NO_GATE with the reason it needs none. The Pathways ingest sat here ungated and let a live token write into a taken-down club (#555).`,
			).toBe(true);
		});
	}
});
