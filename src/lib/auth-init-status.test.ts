/**
 * The init-failure flag and the healthcheck that reads it (#842 review).
 *
 * Both halves are here because the seam between them is the whole point: the
 * route must report unhealthy from a SYNCHRONOUS read, with no `#/db` import
 * and no await, or it loses the properties that make it a liveness probe.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { authInitFailure, recordAuthInitFailure } from "#/lib/auth-init-status";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEALTH_ROUTE = resolve(HERE, "..", "routes", "api", "health.ts");

describe("auth init status", () => {
	beforeEach(() => {
		recordAuthInitFailure(undefined);
	});

	it("reports no failure while init is pending or after it succeeded", () => {
		// Deliberately indistinguishable: both mean "no reason to recycle this
		// container", and distinguishing them would flap on every deploy.
		expect(authInitFailure()).toBeUndefined();
	});

	it("holds the error once init has rejected", () => {
		const err = new Error('relation "oauth_resource" does not exist');
		recordAuthInitFailure(err);
		expect(authInitFailure()).toBe(err);
	});

	it("keeps holding it — the failure never clears on its own", () => {
		// The library memoizes the init promise, so creating the missing table
		// does not recover the process. A flag that could clear would let the
		// healthcheck go green on a process that is still dead.
		recordAuthInitFailure(new Error("boom"));
		expect(authInitFailure()).toBeInstanceOf(Error);
		expect(authInitFailure()).toBeInstanceOf(Error);
	});
});

describe("the healthcheck reads the flag", () => {
	const source = readSource(HEALTH_ROUTE);

	it("returns 503 when init failed and 200 otherwise", () => {
		expect(source).toContain("authInitFailure()");
		expect(source).toMatch(/status:\s*503/);
		expect(source).toMatch(/status:\s*200/);
	});

	it("does not import auth or the database", () => {
		// The whole reason the flag exists rather than `await auth.$context`.
		// Importing `#/lib/auth` here would drag `pg` into the one route that
		// must answer while the database is unreachable.
		const raw = readFileSync(HEALTH_ROUTE, "utf8");
		expect(raw).not.toMatch(/from "#\/lib\/auth"/);
		expect(raw).not.toMatch(/from "#\/db"/);
	});

	it("reads the flag synchronously — no await, no hang", () => {
		// A probe that awaited a stuck init would time out rather than answer,
		// which reads to the platform as a different failure than it is.
		expect(source).not.toMatch(/await/);
	});
});

describe("src/lib/auth.ts records the failure", () => {
	const source = readSource(join(HERE, "auth.ts"));

	it("calls recordAuthInitFailure from the $context catch", () => {
		// Comment-blind: this is a "must be present" guard, so a file that only
		// mentioned the call in a comment would otherwise satisfy it.
		const catchBlock = source.slice(source.indexOf("auth.$context"));
		expect(catchBlock).not.toBe("");
		expect(catchBlock).toContain("recordAuthInitFailure(err)");
	});
});
