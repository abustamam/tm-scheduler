/**
 * Who may change a club's charter status (#944), pinned at the server fns.
 *
 * The rule: a club ADMIN may mark their club chartered and edit its charter
 * date; moving a club BACK to chartering is SUPERADMIN-only. The logic layer
 * (`club-charter-logic.ts`) has no session and trusts its caller, so the gate
 * in each handler is the only thing between any signed-in person and those
 * writes — and a handler body is unreachable from vitest. The gate functions
 * themselves are exercised against real rows in
 * `club-charter.integration.test.ts`; this pins that each fn calls the right
 * one BEFORE the write, and that no admin-gated module can reach the revert.
 *
 * Read COMMENT-BLIND (`readSource`): every "must be present" assertion here
 * would otherwise be satisfiable by a comment naming the pattern.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const CLUBS = readSource("src/server/clubs.ts");
const ONBOARDING = readSource("src/server/onboarding.ts");

/** The body must call `gate` and only then `write`. */
function expectGateBefore(body: string, gate: RegExp, write: string) {
	expect(body.length, "server fn body not found").toBeGreaterThan(0);
	const gateAt = body.search(gate);
	const writeAt = body.indexOf(`${write}(`);
	expect(gateAt, `gate ${gate} missing`).toBeGreaterThanOrEqual(0);
	expect(writeAt, `${write}( missing`).toBeGreaterThan(gateAt);
}

describe("charter status server fns (#944)", () => {
	it("marking chartered is gated to the club's admins", () => {
		expectGateBefore(
			serverFnBody(CLUBS, "markChartered"),
			/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\["admin"\]\s*\)/,
			"markClubChartered",
		);
	});

	it("editing the charter date is gated to the club's admins", () => {
		expectGateBefore(
			serverFnBody(CLUBS, "updateCharterDate"),
			/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\["admin"\]\s*\)/,
			"updateClubCharterDate",
		);
	});

	it("reading the charter status needs view access to the club", () => {
		expectGateBefore(
			serverFnBody(CLUBS, "loadClubCharter"),
			/requireClubViewAccess\(\s*currentUser\.id,\s*clubId\s*\)/,
			"getClubCharter",
		);
	});

	it("moving back to chartering is gated to superadmins", () => {
		expectGateBefore(
			serverFnBody(ONBOARDING, "revertConsoleClubToChartering"),
			/requireSuperadmin\(\s*currentUser\.id\s*\)/,
			"revertClubToChartering",
		);
	});

	it("the admin-gated module has no path to the revert", () => {
		// Vacuity floor: the module was read and holds the fns above.
		expect(CLUBS).toMatch(/markChartered/);
		expect(CLUBS).not.toMatch(/revertClubToChartering/);
		expect(CLUBS).not.toMatch(/charterStatus:\s*"chartering"/);
	});
});
