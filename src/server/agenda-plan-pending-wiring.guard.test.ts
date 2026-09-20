/**
 * The agenda confirm server fns delegate, and decide nothing (#808).
 *
 * A `createServerFn` handler body cannot be executed from vitest — it needs the
 * Start runtime — so any decision written inside one is a decision no test in
 * this repo can reach. `club-logo-method.guard.test.ts` is the standing
 * precedent for the shape: a property of the wrappers the whole behavioural
 * suite is blind to, held by a source assertion instead.
 *
 * Here the stakes are creator-only access to a page whose button creates up to
 * 52 meetings, an archive gate, an expiry, and a double-apply guard. Every one
 * of those lives in `agenda-plan-pending-logic.ts` or in the shared lifecycle,
 * where the integration suites execute them. This guard is what keeps them
 * there: a wrapper that grew its own `if` would be a rule with no test under
 * it, and it would look completely ordinary in review.
 *
 * ## The wrapper is thin but NOT empty
 *
 * Each one must still call `requireUser()`.
 * `public-readers-archive-gate.guard.test.ts` derives its sweep by matching
 * `^export const (\w+) = createServerFn` and classifying any body that names no
 * `require*` guard as ANONYMOUS — reachable without a session — which then has
 * to be enrolled or waived. A wrapper that delegated the session resolution too
 * would land in that set. So both halves are asserted: the guard call is
 * present, and nothing else is.
 *
 * The sweep is DERIVED from the file rather than listed, so a third server fn
 * added tomorrow is covered on the day it is written.
 *
 * Read comment-blind for the "must call" half (a comment naming `requireUser`
 * is not a call) and RAW for the "must not contain" half (stripping only
 * deletes text, and could erase a real offender from view).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readSource } from "#/test/guard-source";

// The module reaches `#/db` transitively on import. Nothing here runs a query.
vi.mock("#/db", () => ({ db: {} }));

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPERS = resolve(HERE, "agenda-plan-pending.ts");
const LOGIC = resolve(HERE, "agenda-plan-pending-logic.ts");
/** The SHARED lifecycle the four ordered checks live in (#812). */
const LIFECYCLE = resolve(HERE, "mcp-pending-logic.ts");

/** Comment-blind — for "the call must BE present" assertions only. */
const stripped = readSource(WRAPPERS);
/** Verbatim — for "the construct must be ABSENT" assertions only. */
const raw = readFileSync(WRAPPERS, "utf8");

/**
 * Each wrapper and the logic function it must delegate to.
 *
 * The KEYS are derived from the file below, so this map cannot silently miss a
 * wrapper; it supplies only the expected callee, which no regex can infer.
 */
const DELEGATES: Record<string, string> = {
	getAgendaPendingPlan: "loadPendingPlan",
	applyAgendaPendingPlan: "applyPendingPlan",
};

/**
 * Constructs that mean a wrapper is deciding something rather than delegating.
 */
const DECISIONS: { pattern: RegExp; why: string }[] = [
	{ pattern: /\bdb\s*\./, why: "reads the database directly" },
	{ pattern: /\bif\s*\(/, why: "branches" },
	{ pattern: /\bthrow\b/, why: "chooses a failure" },
	{ pattern: /\bnotFound\s*\(/, why: "chooses a route outcome" },
	{ pattern: /\bredirect\s*\(/, why: "chooses a route outcome" },
];

/** The body of one `export const <name> = createServerFn…`, to the next export. */
function wrapperBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in agenda-plan-pending.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const rest = source.slice(start);
	const next = rest.slice(1).search(/\n(?:\/\*\*|export )/);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

const declared = [
	...raw.matchAll(/^export const (\w+) = createServerFn/gm),
].map((m) => m[1] as string);

describe("the agenda confirm wrappers load at all (#808)", () => {
	/**
	 * A load-time smoke check: anything that throws while this module evaluates
	 * — a circular import, a top-level call — fails here rather than on the
	 * first request after deploy.
	 *
	 * It is NOT the gate on the input schemas, and #806 measured the difference:
	 * zod builds a discriminated union's map lazily, so a broken one throws on
	 * the first PARSE and a guard that merely imported the module stayed green.
	 * The schemas therefore live in `agenda-plan-pending-schemas.ts`, where
	 * `agenda-plan-pending-schemas.test.ts` feeds them real inputs.
	 */
	it("imports without throwing, and exports both server fns", async () => {
		const mod = await import("./agenda-plan-pending");
		for (const name of Object.keys(DELEGATES)) {
			expect(mod, `${name} is missing from the module`).toHaveProperty(name);
		}
	});
});

describe("the agenda confirm wrappers delegate (#808)", () => {
	it("finds every server fn in the module", () => {
		// Vacuity floor: a sweep that found none would pass every case below.
		expect(declared.length).toBeGreaterThanOrEqual(2);
		expect(declared.sort()).toEqual(Object.keys(DELEGATES).sort());
	});

	for (const fn of declared) {
		it(`${fn} resolves the session and delegates`, () => {
			const body = wrapperBody(stripped, fn);
			expect(
				/\brequireUser\s*\(/.test(body),
				`${fn} does not call requireUser(). The archive-gate sweep classifies a createServerFn with no require* call as reachable without a session, so this would have to be enrolled in WIRINGS or waived — and it is not anonymous, it just failed to say so.`,
			).toBe(true);

			const callee = DELEGATES[fn] as string;
			expect(
				new RegExp(`\\b${callee}\\s*\\(`).test(body),
				`${fn} does not call ${callee}. Every decision this endpoint makes belongs in agenda-plan-pending-logic.ts, where an integration test can execute it.`,
			).toBe(true);
		});

		it(`${fn} decides nothing of its own`, () => {
			const body = wrapperBody(raw, fn);
			const offenders = DECISIONS.filter((d) => d.pattern.test(body)).map(
				(d) => d.why,
			);
			expect(
				offenders,
				`${fn} ${offenders.join(" and ")}. A handler body cannot be executed from vitest, so a rule written there is a rule with no test under it. Move it into agenda-plan-pending-logic.ts.`,
			).toEqual([]);
		});
	}

	it("the logic module really owns the decisions these wrappers skip", () => {
		// The other half of the claim. Asserting the wrappers are empty says
		// nothing about where the rules went; this says they went somewhere a
		// test can reach.
		const logic = readSource(LOGIC);
		for (const call of ["resolvePending(", "isPendingPlanExpired("]) {
			expect(
				logic.includes(call),
				`agenda-plan-pending-logic.ts no longer calls ${call} — the confirm page's ${call.slice(0, -1)} gate is gone.`,
			).toBe(true);
		}
		const lifecycle = readSource(LIFECYCLE);
		for (const call of ["assertClubNotArchived(", "requireClubRole("]) {
			expect(
				lifecycle.includes(call),
				`mcp-pending-logic.ts no longer calls ${call} — every confirm page's ${call.slice(0, -1)} gate is gone, not just this one's.`,
			).toBe(true);
		}
		// And this page must not have grown its own copy. A second spelling of
		// the archive gate here would pass the assertion above while the shared
		// one rotted unnoticed.
		//
		// RAW, not `logic` — the "must be ABSENT" class.
		const logicRaw = readFileSync(LOGIC, "utf8");
		for (const call of ["assertClubNotArchived(", "requireClubRole("]) {
			expect(
				logicRaw.includes(call),
				`agenda-plan-pending-logic.ts calls ${call} again — the lifecycle owns that check since #812, and a second copy is what the extraction removed.`,
			).toBe(false);
		}
	});

	it("names this tool's discriminator on every read", () => {
		// One table serves every MCP write tool since #812, so an id alone no
		// longer says what shape its payload has. A `resolvePending` call that
		// forgot the tool would hand a guest-book payload to a renderer built for
		// agendas — and it would NOT throw, it would draw an empty plan.
		const logic = readSource(LOGIC);
		const resolves = [...logic.matchAll(/resolvePending\(([^)]*)\)/gs)];
		expect(resolves.length).toBeGreaterThanOrEqual(2);
		for (const call of resolves) {
			expect(
				call[1],
				"a resolvePending call in agenda-plan-pending-logic.ts does not pass AGENDA_PLAN_TOOL",
			).toContain("AGENDA_PLAN_TOOL");
		}
	});

	it("the predicates flag a wrapper that guards nothing or decides something", () => {
		// Mutation verification: prove the predicates can FAIL for a NEW
		// non-compliant wrapper, rather than by breaking a real one.
		const compliant = `
			export const okFn = createServerFn({ method: "GET" })
				.validator((i) => s.parse(i))
				.handler(async ({ data }) => {
					const sessionUser = await requireUser();
					return loadPendingPlan({ pendingId: data.pendingId, userId: sessionUser.id });
				});
		`;
		const unguarded = `
			export const badFn = createServerFn({ method: "GET" })
				.handler(async ({ data }) => loadPendingPlan(data));
		`;
		const deciding = `
			export const badFn2 = createServerFn({ method: "GET" })
				.handler(async ({ data }) => {
					const sessionUser = await requireUser();
					const row = await db.select().from(t);
					if (row.createdByUserId !== sessionUser.id) return null;
					return loadPendingPlan(data);
				});
		`;
		const hasGuard = (s: string) => /\brequireUser\s*\(/.test(s);
		const decides = (s: string) => DECISIONS.some((d) => d.pattern.test(s));

		expect(hasGuard(compliant)).toBe(true);
		expect(decides(compliant)).toBe(false);
		expect(hasGuard(unguarded)).toBe(false);
		expect(decides(deciding)).toBe(true);
	});

	it("slices a wrapper without running into the next one", () => {
		// An over-capturing slice fails SILENTLY and in the dangerous direction:
		// it lends a neighbour's `requireUser` to the fn being checked.
		for (const fn of declared) {
			const body = wrapperBody(raw, fn);
			for (const other of declared.filter((o) => o !== fn)) {
				expect(
					body.includes(`export const ${other} =`),
					`the slice for ${fn} swallowed ${other}`,
				).toBe(false);
			}
		}
	});
});
