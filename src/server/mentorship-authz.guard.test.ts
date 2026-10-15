/**
 * Who may read and write mentorships (#939), pinned at the server fns. Same
 * construction as `orientation-authz.guard.test.ts` (#940).
 *
 * The rules:
 *  - `getMyMentorships`: member-level READ gate (`requireClubViewAccess`),
 *    answering from the gate's own membership (a read-only impersonator has
 *    none and gets null). Only pairings the caller is a party to.
 *  - `getMemberMentorships` / `listClubMentorships`: ADMIN view gate
 *    (`requireClubAdminView`).
 *  - `setMyWillingToMentor`: the member's OWN row. The handler passes the
 *    SESSION's user id to the logic, which resolves the caller's membership
 *    (`ownMembershipId` → `requireMembership`); the input schema is
 *    `.strict()` and names no member, so no request can point the write at
 *    another row. `mentorship.integration.test.ts` exercises that resolution.
 *  - `createMentorship` / `endMentorship` / `setMentorshipFocus`: admin writes
 *    about other people, `requireClubRole(…, ["admin"])` BEFORE the logic.
 *  - Mentor requests (#1209): `requestMentor` / `withdrawMentorRequest` are the
 *    caller's own (SESSION user id to the logic, which resolves the mentee;
 *    the schemas are `.strict()` and name no mentee). `decideMentorRequest`
 *    calls `authorizeMentorRequestDecision(user.id, data.requestId)` BEFORE the
 *    logic, and that reads the club and the mentor off the REQUEST row: the
 *    input names neither. `getMyMentorRequests` is a member read gate,
 *    `listClubPendingMentorRequests` the admin view gate.
 *  - Reads write nothing: no read fn reaches a write in the logic module.
 *
 * A `createServerFn` handler body is unreachable from vitest, so this reads
 * the source COMMENT-BLIND (`readSource`): every "must be present" assertion
 * here would otherwise be satisfiable by a comment naming the pattern. Also
 * holds that the module declares no fn this file does not cover.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const MENTORSHIP = readSource("src/server/mentorship.ts");
const LOGIC = readSource("src/server/mentorship-logic.ts");

/**
 * One top-level function's body in the logic module, from its declaration to
 * the first column-0 closing brace after it. Both ends are asserted FOUND:
 * an unfound end (-1) would slice to EOF and let another function's text
 * satisfy the assertion.
 */
function logicFnBody(fn: string): string {
	const at = LOGIC.search(new RegExp(`\\n(?:export )?async function ${fn}\\(`));
	expect(at, `${fn} missing`).toBeGreaterThanOrEqual(0);
	const end = LOGIC.indexOf("\n}\n", at);
	expect(end, `${fn}: end of body not found`).toBeGreaterThan(at);
	return LOGIC.slice(at, end);
}

const ADMIN_WRITE =
	/requireClubRole\(\s*user\.id,\s*data\.clubId,\s*\["admin"\]\s*\)/;
const ADMIN_READ = /requireClubAdminView\(\s*user\.id,\s*data\.clubId\s*\)/;
const MEMBER_READ = /requireClubViewAccess\(\s*user\.id,\s*data\.clubId\s*\)/;
/** The session's user id, spread AFTER the input so input cannot override it. */
const SELF = /\{\s*\.\.\.data,\s*userId:\s*user\.id\s*\}/;
/** The admin's own membership as the actor, spread after the input. */
const ACTOR = /\{\s*\.\.\.data,\s*actorMemberId:\s*membership\.id\s*\}/;
/** Answering a request: the logic-level check, keyed on the REQUEST id (#1209). */
const DECIDE_GATE =
	/authorizeMentorRequestDecision\(\s*user\.id,\s*data\.requestId,?\s*\)/;
/** The actor the check resolved, spread after the input. */
const DECIDE_ACTOR =
	/\{\s*\.\.\.data,\s*userId:\s*user\.id,\s*actingAs,\s*actorMemberId,?\s*\}/;

const FNS: { fn: string; gate: RegExp; logic: string; write: boolean }[] = [
	{
		fn: "getMyMentorships",
		gate: MEMBER_READ,
		logic: "loadMyMentorshipsDb",
		write: false,
	},
	{
		fn: "getMemberMentorships",
		gate: ADMIN_READ,
		logic: "loadMemberMentorshipsDb",
		write: false,
	},
	{
		fn: "listClubMentorships",
		gate: ADMIN_READ,
		logic: "loadClubMentorshipsDb",
		write: false,
	},
	{
		fn: "setMyWillingToMentor",
		gate: SELF,
		logic: "setMyWillingToMentorDb",
		write: true,
	},
	{
		fn: "setMyMentorBio",
		gate: SELF,
		logic: "setMyMentorBioDb",
		write: true,
	},
	{
		fn: "listMentors",
		gate: MEMBER_READ,
		logic: "listMentorsDb",
		write: false,
	},
	{
		fn: "getMyMentorRequests",
		gate: MEMBER_READ,
		logic: "loadMyMentorRequestsDb",
		write: false,
	},
	{
		fn: "listClubPendingMentorRequests",
		gate: ADMIN_READ,
		logic: "loadClubPendingMentorRequestsDb",
		write: false,
	},
	{
		fn: "requestMentor",
		gate: SELF,
		logic: "requestMentorDb",
		write: true,
	},
	{
		fn: "withdrawMentorRequest",
		gate: SELF,
		logic: "withdrawMentorRequestDb",
		write: true,
	},
	{
		fn: "decideMentorRequest",
		gate: DECIDE_GATE,
		logic: "decideMentorRequestDb",
		write: true,
	},
	{
		fn: "createMentorship",
		gate: ADMIN_WRITE,
		logic: "createMentorshipDb",
		write: true,
	},
	{
		fn: "endMentorship",
		gate: ADMIN_WRITE,
		logic: "endMentorshipDb",
		write: true,
	},
	{
		fn: "setMentorshipFocus",
		gate: ADMIN_WRITE,
		logic: "setMentorshipFocusDb",
		write: true,
	},
];

describe("mentorship server fns (#939)", () => {
	for (const { fn, gate, logic } of FNS) {
		it(`${fn} applies ${gate} before or at ${logic}`, () => {
			const body = serverFnBody(MENTORSHIP, fn);
			expect(body.length, `${fn} body not found`).toBeGreaterThan(0);
			expect(body).toMatch(/requireUser\(\)/);
			const gateAt = body.search(gate);
			const logicAt = body.indexOf(`${logic}(`);
			expect(gateAt, `${fn}: ${gate} missing`).toBeGreaterThanOrEqual(0);
			expect(logicAt, `${fn}: ${logic}( missing`).toBeGreaterThanOrEqual(0);
			// A gate call precedes the logic; the SELF pattern is the logic's own
			// argument, so it sits after the call's opening paren.
			if (gate === SELF) expect(gateAt).toBeGreaterThan(logicAt);
			else expect(logicAt).toBeGreaterThan(gateAt);
		});
	}

	it("the admin writes attribute to the gate's membership, never input", () => {
		for (const { fn, gate } of FNS) {
			if (gate !== ADMIN_WRITE) continue;
			expect(serverFnBody(MENTORSHIP, fn), fn).toMatch(ACTOR);
		}
	});

	it("the dashboard read answers from the gate's membership, never input", () => {
		const body = serverFnBody(MENTORSHIP, "getMyMentorships");
		expect(body).toMatch(/loadMyMentorshipsDb\(\s*access\.membership\.id\s*\)/);
		expect(body).toMatch(/if\s*\(\s*!access\.membership\s*\)\s*return null/);
	});

	it("the requests read answers from the gate's membership, never input", () => {
		const body = serverFnBody(MENTORSHIP, "getMyMentorRequests");
		expect(body).toMatch(
			/loadMyMentorRequestsDb\(\s*access\.membership\.id\s*\)/,
		);
		expect(body).toMatch(/if\s*\(\s*!access\.membership\s*\)\s*return null/);
	});

	it("an answer is attributed to the membership the check resolved, never input", () => {
		const body = serverFnBody(MENTORSHIP, "decideMentorRequest");
		expect(body).toMatch(
			/const\s*\{\s*actorMemberId,\s*actingAs\s*\}\s*=\s*await\s+authorizeMentorRequestDecision\(/,
		);
		expect(body).toMatch(DECIDE_ACTOR);
	});

	it("the check reads the club and mentor off the request row, and admits the mentor or an admin", () => {
		const body = logicFnBody("authorizeMentorRequestDecision");
		expect(body).toMatch(/\.from\(mentorshipRequests\)/);
		expect(body).toMatch(/eq\(mentorshipRequests\.id,\s*requestId\)/);
		expect(body).toMatch(/requireMembership\(\s*userId,\s*req\.clubId\s*\)/);
		expect(body).toMatch(/membership\.id === req\.mentorMemberId/);
		expect(body).toMatch(
			/requireClubRole\(\s*userId,\s*req\.clubId,\s*\["admin"\]\s*\)/,
		);
		// A missing request is refused with the same message as a stranger.
		expect(body).toMatch(
			/if\s*\(!req\)\s*throw new Error\(MENTOR_REQUEST_NOT_ALLOWED_MESSAGE\)/,
		);
	});

	it("the request schemas are strict and name no mentee, and the decision names no club", () => {
		for (const name of [
			"requestMentorSchema",
			"withdrawMentorRequestSchema",
			"decideMentorRequestSchema",
		]) {
			const at = LOGIC.indexOf(`export const ${name}`);
			expect(at, `${name} missing`).toBeGreaterThanOrEqual(0);
			const end = LOGIC.indexOf(";", at);
			expect(end, `${name}: end not found`).toBeGreaterThan(at);
			const decl = LOGIC.slice(at, end);
			expect(decl, name).toMatch(/\.strict\(\)/);
			expect(decl, name).not.toMatch(/menteeMemberId/);
			if (name !== "requestMentorSchema")
				expect(decl, name).not.toMatch(/clubId/);
		}
	});

	it("a request resolves its mentee from the session and asks only for a LISTED mentor, under the club lock", () => {
		const body = logicFnBody("requestMentor");
		expect(body).toMatch(
			/ownMembershipId\(\s*input\.userId,\s*input\.clubId\s*\)/,
		);
		expect(body).toMatch(/listedMentorWhere\(\)/);
		const lockAt = body.search(/lockClubForWrite\(/);
		const insertAt = body.search(/\.insert\(mentorshipRequests\)/);
		expect(lockAt).toBeGreaterThanOrEqual(0);
		expect(insertAt).toBeGreaterThan(lockAt);
	});

	it("withdraw is one conditional UPDATE: the caller's own request, still pending", () => {
		const body = logicFnBody("withdrawMentorRequest");
		expect(body).toMatch(
			/ownMembershipId\(\s*input\.userId,\s*req\.clubId\s*\)/,
		);
		expect(body).toMatch(/eq\(mentorshipRequests\.menteeMemberId,\s*own\)/);
		expect(body).toMatch(/eq\(mentorshipRequests\.status,\s*"pending"\)/);
	});

	it("an answer takes the club lock, then the request row FOR UPDATE, and refuses once not pending", () => {
		const body = logicFnBody("decideMentorRequest");
		const lockAt = body.search(/lockClubForWrite\(/);
		const rowAt = body.search(/\.for\("update"\)/);
		const pendingAt = body.search(/req\.status !== "pending"/);
		expect(lockAt).toBeGreaterThanOrEqual(0);
		expect(rowAt).toBeGreaterThan(lockAt);
		expect(pendingAt).toBeGreaterThan(rowAt);
		expect(body).toMatch(/is no longer an active member/);
		expect(body).toMatch(/insertMentorshipInTx\(\s*tx,/);
	});

	it("an answer re-checks the actor once the lock and the row are held", () => {
		const body = logicFnBody("decideMentorRequest");
		const rowAt = body.search(/\.for\("update"\)/);
		const recheckAt = body.search(
			/assertStillMayAnswer\(\s*tx,\s*input,\s*req\s*\)/,
		);
		const writeAt = body.search(/insertMentorshipInTx\(\s*tx,/);
		expect(recheckAt).toBeGreaterThan(rowAt);
		expect(writeAt).toBeGreaterThan(recheckAt);
		const check = logicFnBody("assertStillMayAnswer");
		expect(check).toMatch(
			/assertStillClubAdmin\(\s*tx,\s*input\.userId,\s*req\.clubId\s*\)/,
		);
		expect(check).toMatch(/membership\.id !== req\.mentorMemberId/);
	});

	it("every server fn the module declares is covered above", () => {
		const declared = [
			...MENTORSHIP.matchAll(/export const (\w+) = createServerFn\(/g),
		].map((m) => m[1]);
		expect(declared.length).toBeGreaterThan(0);
		expect(declared.sort()).toEqual(FNS.map((f) => f.fn).sort());
	});

	it("the reads are GETs and the writes are POSTs", () => {
		for (const { fn, write } of FNS) {
			expect(MENTORSHIP).toMatch(
				new RegExp(
					`export const ${fn} = createServerFn\\(\\{ method: "${write ? "POST" : "GET"}" \\}\\)`,
				),
			);
		}
	});

	it("the reads write nothing: no read reaches an insert, update or delete", () => {
		for (const fn of [
			"loadMyMentorships",
			"loadMemberMentorships",
			"loadClubMentorships",
			"loadMyMentorRequests",
			"loadClubPendingMentorRequests",
			"listMentors",
			"activePairingsFor",
			"memberHasMentorship",
			"memberHasMentorRequest",
		]) {
			const body = logicFnBody(fn);
			expect(body, fn).not.toMatch(/\.(insert|update|delete)\(/);
			expect(body, fn).not.toMatch(/logActivity\(/);
		}
	});

	it("the self-write resolves its row through requireMembership and refuses a memberless actor", () => {
		const own = logicFnBody("ownMembershipId");
		expect(own).toMatch(/requireMembership\(\s*userId,\s*club\s*\)/);
		expect(own).toMatch(/membership\.id === null/);
		expect(logicFnBody("setMyWillingToMentor")).toMatch(
			/ownMembershipId\(\s*input\.userId,\s*input\.clubId\s*\)/,
		);
	});

	it("the self-write schema is strict and names no member", () => {
		const at = LOGIC.indexOf("export const setWillingToMentorSchema");
		expect(at, "setWillingToMentorSchema missing").toBeGreaterThanOrEqual(0);
		const end = LOGIC.indexOf(";", at);
		expect(end, "end of declaration not found").toBeGreaterThan(at);
		const decl = LOGIC.slice(at, end);
		expect(decl).toMatch(/\.strict\(\)/);
		expect(decl).not.toMatch(/member/i);
	});

	it("every admin write logs through logActivity", () => {
		// `createMentorship`'s insert and log live in `insertMentorshipInTx` (#1209),
		// which it must call inside its own transaction.
		for (const fn of [
			"insertMentorshipInTx",
			"endMentorship",
			"setMentorshipFocus",
		]) {
			expect(logicFnBody(fn), fn).toMatch(/logActivity\(\s*tx,/);
		}
		expect(logicFnBody("createMentorship")).toMatch(
			/insertMentorshipInTx\(\s*tx,/,
		);
	});

	it("create checks the club, activity and self-pairing before inserting", () => {
		const create = logicFnBody("createMentorship");
		expect(create).toMatch(/lockClubForWrite\(/);
		expect(create.search(/insertMentorshipInTx\(/)).toBeGreaterThan(
			create.search(/lockClubForWrite\(/),
		);
		const inserter = logicFnBody("insertMentorshipInTx");
		const checkAt = inserter.search(/assertPairable\(/);
		const insertAt = inserter.search(/\.insert\(mentorships\)/);
		expect(checkAt).toBeGreaterThanOrEqual(0);
		expect(insertAt).toBeGreaterThan(checkAt);
		const pairable = logicFnBody("assertPairable");
		expect(pairable).toMatch(/eq\(members\.clubId,\s*clubId\)/);
		expect(pairable).toMatch(/status !== "active"/);
		expect(pairable).toMatch(/mentorMemberId === menteeMemberId/);
	});
});
