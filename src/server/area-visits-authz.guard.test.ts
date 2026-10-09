/**
 * Who may record, clear and read a club visit (#1120), pinned at the source.
 *
 * `area-visits.integration.test.ts` runs the handlers and sees the refusals. It
 * cannot see the ORDER the gates run in, or that the lock re-ask sits before the
 * write: a handler body is unreachable from a source-free call, and a gate after
 * the write it protects is decoration. Each assertion below is MUTATION-CHECKED:
 * the test named in its comment goes red when the line it pins is dropped.
 *
 * Read COMMENT-BLIND (`readSource`): every "must be present" assertion would
 * otherwise be satisfiable by a comment naming the call.
 */
import { describe, expect, it } from "vitest";
import {
	readSource,
	serverFnBody,
	serverFnDeclarations,
} from "#/test/guard-source";

const HANDLERS = readSource("src/server/area-visits.ts");
const LOGIC = readSource("src/server/area-visits-logic.ts");
const GUARDS = readSource("src/server/area-guards.ts");

/** An `export async function` body, from its signature to the closing brace. */
function fnBody(source: string, name: string): string {
	const start = source.indexOf(`export async function ${name}(`);
	if (start === -1) {
		throw new Error(
			`${name} not found. Re-point this guard, do not delete it.`,
		);
	}
	const end = source.indexOf("\n}\n", start);
	return source.slice(start, end === -1 ? undefined : end);
}

/** The handler half of a server fn declaration. */
function handlerOf(name: string): string {
	const body = serverFnBody(HANDLERS, name);
	return body.slice(body.indexOf(".handler("));
}

describe("the visit server fns run the Area Director gate (#1120)", () => {
	it("sweeps exactly the three fns the issue names", () => {
		expect(
			serverFnDeclarations(HANDLERS)
				.map((d) => d.name)
				.sort(),
		).toEqual(["clearClubVisit", "getAreaClubSummary", "recordClubVisit"]);
		expect(serverFnBody(HANDLERS, "recordClubVisit")).toContain('"POST"');
		expect(serverFnBody(HANDLERS, "clearClubVisit")).toContain('"POST"');
		expect(serverFnBody(HANDLERS, "getAreaClubSummary")).toContain('"GET"');
	});

	for (const [fn, call] of [
		["recordClubVisit", "recordClubVisitLogic("],
		["clearClubVisit", "clearClubVisitLogic("],
	] as const) {
		it(`${fn} resolves the area FROM THE CLUB, then requireAreaDirector on it, then the write`, () => {
			const handler = handlerOf(fn);
			const session = handler.indexOf("const user = await requireUser();");
			const resolve = handler.indexOf(
				"const areaId = await areaIdOfAreaClub(data.areaClubId);",
			);
			const gate = handler.indexOf(
				"await requireAreaDirector(user.id, areaId);",
			);
			const write = handler.indexOf(call);
			expect(session, "requireUser() is gone").toBeGreaterThan(-1);
			expect(
				resolve,
				"the area is no longer resolved from the club",
			).toBeGreaterThan(-1);
			expect(
				gate,
				"requireAreaDirector(user.id, areaId) is gone",
			).toBeGreaterThan(-1);
			expect(write, `${call} is gone`).toBeGreaterThan(-1);
			expect(session).toBeLessThan(resolve);
			expect(resolve).toBeLessThan(gate);
			expect(gate).toBeLessThan(write);
			// The area is never a client field: nothing to pair with another's club.
			expect(handler).not.toMatch(/data\.areaId/);
		});
	}

	it("getAreaClubSummary runs requireUser, then requireAreaDirector on the caller, then the loader", () => {
		const handler = handlerOf("getAreaClubSummary");
		const session = handler.indexOf("const user = await requireUser();");
		const gate = handler.indexOf(
			"await requireAreaDirector(user.id, data.areaId);",
		);
		const load = handler.indexOf(
			"loadAreaClubSummary(data.areaId, data.areaClubId)",
		);
		expect(session, "requireUser() is gone").toBeGreaterThan(-1);
		expect(gate, "requireAreaDirector(user.id, …) is gone").toBeGreaterThan(-1);
		expect(load, "loadAreaClubSummary( is gone").toBeGreaterThan(-1);
		expect(session).toBeLessThan(gate);
		expect(gate).toBeLessThan(load);
	});

	it("getAreaClubSummary pairs the club with the area in the query, so another area's club is refused", () => {
		const body = fnBody(LOGIC, "loadAreaClubSummary");
		expect(
			body,
			"the area_clubs lookup no longer checks area_id = the authorized area",
		).toMatch(/eq\(areaClubs\.areaId, areaId\)/);
	});

	it("is no superadmin door: nothing here asks for one, and no module reaches the db directly", () => {
		expect(HANDLERS).not.toMatch(/requireSuperadmin|isSuperadmin/);
		expect(HANDLERS).not.toMatch(/from\s+"#\/db/);
	});
});

describe("the view loader and the failure wrapper (#1120)", () => {
	it("loadAreaView reads the health and the visits together, and both area reads go through it", () => {
		const body = fnBody(LOGIC, "loadAreaView");
		expect(body).toContain("Promise.all(");
		expect(body).toContain("loadAreaHealth(areaId)");
		expect(
			body,
			"the visits are no longer read with the health: the page loses them",
		).toContain("loadAreaVisits(areaId)");
		for (const file of ["src/server/area-health.ts", "src/server/areas.ts"]) {
			expect(readSource(file)).toContain("loadAreaView(data.areaId)");
		}
	});

	for (const fn of [
		"recordClubVisit",
		"clearClubVisit",
		"getAreaClubSummary",
	]) {
		it(`${fn} answers an unexpected failure through visitFailure, never a raw error`, () => {
			const handler = handlerOf(fn);
			expect(handler).toMatch(/catch \(err\) \{\s*throw visitFailure\(err,/);
			// The sign-in message must still reach the person: requireUser is OUTSIDE
			// the try.
			expect(handler.indexOf("await requireUser()")).toBeLessThan(
				handler.indexOf("try {"),
			);
		});
	}
});

describe("the two writes re-ask the term under a lock before they write (#1120)", () => {
	for (const [fn, write] of [
		["recordClubVisit", ".insert(clubVisits)"],
		["clearClubVisit", ".delete(clubVisits)"],
	] as const) {
		it(`${fn} calls requireAreaDirectorTx(tx, userId, areaId) inside its transaction, before ${write}`, () => {
			const body = fnBody(LOGIC, fn);
			const transaction = body.indexOf("db.transaction(");
			const reask = body.indexOf(
				"await requireAreaDirectorTx(tx, userId, areaId);",
			);
			const at = body.indexOf(write);
			expect(transaction, "no transaction").toBeGreaterThan(-1);
			expect(reask, "requireAreaDirectorTx( is gone").toBeGreaterThan(-1);
			expect(at, `${write} is gone`).toBeGreaterThan(-1);
			expect(transaction).toBeLessThan(reask);
			expect(reask).toBeLessThan(at);
		});
	}

	it("records who recorded it from the session's user, never from the input", () => {
		expect(fnBody(LOGIC, "recordClubVisit")).toContain("recordedBy: userId");
		expect(LOGIC).not.toMatch(/recordedBy:\s*input\./);
		expect(LOGIC).not.toMatch(/recordedBy:\s*z\./);
	});

	it("the lock check is FOR SHARE on the term row and asks #1116's predicate", () => {
		const body = fnBody(GUARDS, "requireAreaDirectorTx");
		expect(body).toContain("isCurrentTerm()");
		expect(
			body,
			"the term row is no longer locked: a write can commit after the term ends",
		).toMatch(/\.for\(\s*"share",\s*\{\s*of:\s*areaDirectors\s*\}\s*\)/);
		expect(body).toContain("NO_PERMISSION_MESSAGE");
	});

	it("the lock re-ask never restates when a term ended", () => {
		// Raw would be stricter, but `area-access.guard.test.ts` already holds
		// the whole file to it; this keeps the new function in step.
		expect(fnBody(GUARDS, "requireAreaDirectorTx")).not.toMatch(
			/endedAt|ended_at/,
		);
	});
});
