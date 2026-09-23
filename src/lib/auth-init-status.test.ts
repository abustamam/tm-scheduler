/**
 * The init-failure flag and the healthcheck that reads it (#842 review).
 *
 * The decision lives in `#/lib/auth-init-status` rather than in the route so
 * BOTH branches are executable here. A ternary inside the `createFileRoute`
 * handler would be reachable only by source grep, and every grep anyone would
 * write is satisfied by inverting it — which would make a healthy container
 * answer 503 on the path `railway.json` names as `healthcheckPath`, so no
 * deploy would ever go live.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHealthResponse,
	authInitFailed,
	authInitFailure,
	recordAuthInitFailure,
	resetAuthInitStatusForTest,
} from "#/lib/auth-init-status";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEALTH_ROUTE = resolve(HERE, "..", "routes", "api", "health.ts");

describe("auth init status", () => {
	beforeEach(() => {
		resetAuthInitStatusForTest();
	});

	it("reports no failure while init is pending or after it succeeded", () => {
		// Deliberately indistinguishable: both mean "no reason to recycle this
		// container", and distinguishing them would flap on every deploy.
		expect(authInitFailed()).toBe(false);
	});

	it("records a failure whose reason is falsy", () => {
		// The bug this closes: testing the VALUE for truthiness. `$context` can
		// reject with `undefined` — anything that throws a non-Error — and a flag
		// that is just the value then reports healthy on a dead process, which is
		// the silent 200 this whole module exists to remove.
		recordAuthInitFailure(undefined);
		expect(authInitFailed()).toBe(true);
		expect(authHealthResponse().status).toBe(503);
	});

	it("keeps the reason for logging without deciding on it", () => {
		const err = new Error('relation "oauth_resource" does not exist');
		recordAuthInitFailure(err);
		expect(authInitFailure()).toBe(err);
	});

	it("never clears on its own — the library memoizes the init promise", () => {
		// Creating the missing table does not recover the process, so a flag that
		// could clear would let the probe go green on something still dead.
		recordAuthInitFailure(new Error("boom"));
		expect(authInitFailed()).toBe(true);
		expect(authInitFailed()).toBe(true);
	});
});

describe("authHealthResponse", () => {
	beforeEach(() => {
		resetAuthInitStatusForTest();
	});

	it("is 200 with a healthy init", async () => {
		const response = authHealthResponse();
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});

	it("is 503 once init has failed", async () => {
		recordAuthInitFailure(new Error("boom"));
		const response = authHealthResponse();
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("auth init failed");
	});
});

describe("the healthcheck route delegates, and stays free of auth and the DB", () => {
	const source = readSource(HEALTH_ROUTE);

	it("returns authHealthResponse()", () => {
		expect(source).toContain("authHealthResponse()");
	});

	it("does not import auth or the database", () => {
		// The whole reason the flag exists rather than `await auth.$context`.
		// Importing `#/lib/auth` here would drag `pg` into the one route that
		// must answer while the database is unreachable.
		const raw = readFileSync(HEALTH_ROUTE, "utf8");
		expect(raw).not.toMatch(/from "#\/lib\/auth"/);
		expect(raw).not.toMatch(/from "#\/db"/);
	});

	it("reads synchronously — no await, no hang", () => {
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
