/**
 * Source guard: every DCP and Club Officer Training server fn is admin-gated
 * (#207 / #531, ADR-0019 §4).
 *
 * ## Why a source grep rather than a behavioural test
 *
 * A `createServerFn` handler cannot be invoked from vitest — no session, no RPC
 * layer — so the two lines that decide who may read or write a club's DCP
 * scoreboard are unreachable from the suites that cover everything around them.
 * `dcp.integration.test.ts` and `officer-training.integration.test.ts` drive the
 * `-logic` SEAMS, and those seams deliberately carry no authz of their own
 * (`officer-training-logic.ts`'s header says so). So the seam tests prove the
 * right rows are written and cannot prove that a stranger is turned away before
 * reaching them. This file is the only gate on that.
 *
 * Three of the five training seams do no ownership check at all — `clubId` goes
 * from the request payload straight into the query (`setTrainingWindow`,
 * `resetTrainingWindow`, `getOfficerTrainingView`). `requireClubRole` is
 * therefore the ONLY thing between any signed-in user and rewriting another
 * club's training windows or reading its full active roster.
 *
 * ## What the gate buys beyond permissions, and the substitution to watch for
 *
 * `requireClubRole` → `requireMembership` → `assertNotArchived` (`guards.ts`),
 * so the admin check is also what refuses an ARCHIVED club — the ADR-0024
 * takedown lever. Neither module calls `assertClubNotArchived` itself, by
 * design and consistently with its siblings. The consequence is the thing this
 * guard really watches: **dropping `requireClubRole` for a bare `requireUser()`
 * would silently take the archive gate with it**, and nothing else in the repo
 * would fail. `public-readers-archive-gate.guard.test.ts` treats a body
 * containing `requireUser(` as session-guarded, so its enrollment sweep would
 * not catch the downgrade either. Same wording, same reason, as
 * `club-settings-authz.guard.test.ts`.
 *
 * ## Why derived rather than listed
 *
 * The fns are found by walking each file for `createServerFn`, not from a
 * roster. A roster is an allowlist somebody has to remember, and CLAUDE.md
 * records two archive holes (#544, #560) that existed precisely because the next
 * endpoint was not on one. The next DCP or training endpoint is enrolled here
 * the moment it is written.
 *
 * Read comment-blind (`readSource`): every assertion is of the "the pattern must
 * BE present" shape, which a doc comment can satisfy by accident — this header
 * names `requireClubRole` and `requireUser()` repeatedly, which is exactly why.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Both modules, guarded identically. `dcp.ts` is enrolled alongside the new
 * module rather than left alone: #531 adds a sixth fn to it
 * (`applyTrainingSuggestion`, the goal-9 assist), and the five that were already
 * there had no guard of this kind. One sweep covers both.
 */
const MODULES = [
	"src/server/dcp.ts",
	"src/server/officer-training.ts",
] as const;

/**
 * The start of a top-level declaration, or of the doc comment introducing one.
 * Lifted from `public-readers-archive-gate.guard.test.ts`, whose header records
 * why the two obvious alternatives are both wrong: slicing to the next `export`
 * over-captures the following declaration's JSDoc, and slicing to a literal
 * `\n});` never matches a `createServerFn`'s own terminator (it closes at one
 * tab, because `.handler(` is chained a level in) and so runs on to some later
 * column-0 `});`. That second bug (#565) let one endpoint borrow a neighbour's
 * `require*` call and be classified as gated while it was open.
 */
const TOP_LEVEL_BOUNDARY =
	/^(?:\/\*\*|\/\/|export |const |let |var |function |async function |class |type |interface |enum |declare )/;

interface ServerFn {
	file: string;
	name: string;
	method: string;
	body: string;
}

/** Every `export const <name> = createServerFn({ method: "…" })` in a file,
 *  each sliced to its own declaration. */
function serverFns(file: string): ServerFn[] {
	const source = readSource(resolve(process.cwd(), file));
	// Match the DECLARATION, then read the method out of the sliced body. The
	// regex used to pin `method` as the first key
	// (`createServerFn\(\{\s*method:\s*"(\w+)"`), which meant
	// `createServerFn({ response: "raw", method: "GET" })` and a bare
	// `createServerFn()` both vanished from the sweep — silently unenrolled, with
	// the per-file floor still satisfied by the others. The one substitution this
	// guard exists to catch was escapable by changing declaration style.
	const decls = [...source.matchAll(/export const (\w+) = createServerFn\(/g)];
	return decls.map((m) => {
		const start = m.index ?? 0;
		const lines = source.slice(start).split("\n");
		let offset = 0;
		let body = source.slice(start);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			// i > 0 skips the declaration's own opening line.
			if (i > 0 && TOP_LEVEL_BOUNDARY.test(line)) {
				body = source.slice(start, start + offset);
				break;
			}
			offset += line.length + 1;
		}
		const method = /method:\s*"(\w+)"/.exec(body)?.[1] ?? "UNKNOWN";
		return { file, name: m[1] as string, method, body };
	});
}

describe("DCP + officer training server fns are admin-gated (#207 / #531)", () => {
	const fns = MODULES.flatMap(serverFns);

	it("finds the server fns in both modules", () => {
		// Vacuity floor: every assertion below iterates `fns`, so an empty list
		// would make this whole file pass while enforcing nothing — the failure a
		// rename or a changed `createServerFn` call style would produce, and it
		// looks identical to success. Named exports rather than a bare count, so
		// the floor cannot be satisfied by the wrong file's fns.
		const names = fns.map((f) => f.name);
		expect(names).toContain("getScoreboard");
		expect(names).toContain("applyTrainingSuggestion");
		expect(names).toContain("getOfficerTraining");
		expect(names).toContain("addTrainingRecord");
		expect(names).toContain("removeTrainingRecord");
		expect(names).toContain("setTrainingWindow");
		expect(names).toContain("resetTrainingWindow");
		// SEVEN in dcp.ts (getScoreboard, getScoreboardYears, startScoreboard,
		// updateGoal, applyEducationSuggestions, applyTrainingSuggestion,
		// updateBaseMemberCount) and five in officer-training.ts = 12. The floor
		// was `>= 11` under a comment saying six, so one dcp.ts fn could drop out
		// of enrollment with this file green — CLAUDE.md's "vacuity floor erodes
		// silently" trap, in the guard written to prevent it. Exact counts, so
		// ADDING an endpoint also fails here and forces it to be gated.
		expect(fns.filter((f) => f.file === "src/server/dcp.ts")).toHaveLength(7);
		expect(
			fns.filter((f) => f.file === "src/server/officer-training.ts"),
		).toHaveLength(5);
		expect(fns).toHaveLength(12);
	});

	it("slices each declaration to its own body, never into the next", () => {
		// The #565 over-capture check, kept local: a slice that swallowed a
		// neighbour would lend it that neighbour's `require*` call and turn an
		// ungated endpoint into a passing one. That is how the minutes leak
		// reached production behind 54/54 green.
		for (const fn of fns) {
			for (const other of fns) {
				if (other.name === fn.name) continue;
				expect(
					fn.body.includes(`export const ${other.name} = createServerFn`),
					`${fn.name}'s slice ran into ${other.name}`,
				).toBe(false);
			}
		}
	});

	for (const fn of fns) {
		it(`${fn.name} resolves a user and requires the admin club role`, () => {
			expect(fn.body).toMatch(/await\s+requireUser\(\)/);
			// The ROLE LIST is asserted, not just the call. `requireClubRole` with a
			// wider list would satisfy a bare "is it called?" check while letting
			// any member of the club rewrite the scoreboard.
			//
			// AWAITED, too. Without `await\s+` a floating `requireClubRole(...)`
			// satisfied this regex while the handler ran straight on to the data:
			// the rejection surfaces as an unhandled promise nobody observes and
			// the caller gets a 200. Nothing else in the repo catches that —
			// biome runs `recommended` only and `noFloatingPromises` is a nursery
			// rule (verified: biome reports nothing on a floating call), and
			// `tsc --noEmit` does not model it either.
			expect(
				fn.body,
				`${fn.name} must AWAIT requireClubRole(..., ["admin"]). Without it any signed-in user could reach this club's scoreboard — and because requireClubRole is what reaches assertNotArchived, an ARCHIVED club would be writable too (ADR-0024 takedown).`,
			).toMatch(
				/await\s+requireClubRole\(\s*user\.id,\s*data\.clubId,\s*\["admin"\],?\s*\)/,
			);
		});

		it(`${fn.name} gates BEFORE it touches the data`, () => {
			// Order, not just presence. A handler that reads first and gates after
			// satisfies every assertion above while having already run the query —
			// the check becomes a post-hoc audit of data it has fetched, and for a
			// read fn the rejection is the only thing standing between the caller
			// and a payload that has already been assembled.
			const gate = fn.body.search(/await\s+requireClubRole\(/);
			const firstDbCall = fn.body.search(/\w+Db\(/);
			expect(
				gate,
				`${fn.name}: no awaited requireClubRole found`,
			).toBeGreaterThan(-1);
			expect(
				firstDbCall,
				`${fn.name}: no *Db( seam call found — this guard's ordering check is vacuous for it`,
			).toBeGreaterThan(-1);
			expect(
				gate,
				`${fn.name} calls its data seam before requireClubRole — the gate must run first, not audit a payload it already built.`,
			).toBeLessThan(firstDbCall);
		});

		it(`${fn.name} validates its input with a schema`, () => {
			expect(fn.body).toMatch(/\.validator\(/);
			// A `.parse(` call, not a name ending in `Schema`: `getScoreboardYears`
			// validates with a local `clubScoped` object, which is the property this
			// case is about. Asserting the NAME would have failed a correctly
			// validated endpoint, which is a guard testing a convention rather than
			// the thing the convention is for.
			expect(fn.body).toMatch(/\w+\.parse\(/);
		});
	}

	it("no fn in either module is left session-less", () => {
		// The complement of the per-fn cases: states the invariant over the whole
		// set rather than per member, so a fn the matcher failed to slice cannot
		// slip through by simply not generating a case.
		const ungated = fns.filter((f) => !/requireClubRole\(/.test(f.body));
		expect(
			ungated.map((f) => `${f.file}:${f.name}`),
			"every DCP/training endpoint is admin-gated; there are no public readers in these modules",
		).toEqual([]);
	});
});
