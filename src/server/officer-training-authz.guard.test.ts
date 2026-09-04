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
	const decls = [
		...source.matchAll(
			/export const (\w+) = createServerFn\(\{\s*method:\s*"(\w+)"/g,
		),
	];
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
		return { file, name: m[1] as string, method: m[2] as string, body };
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
		// Six in dcp.ts, five in officer-training.ts at the time of writing.
		expect(fns.length).toBeGreaterThanOrEqual(11);
		for (const file of MODULES) {
			expect(
				fns.filter((f) => f.file === file).length,
				`${file} contributed no server fns — the matcher stopped matching`,
			).toBeGreaterThanOrEqual(5);
		}
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
			expect(fn.body).toMatch(/requireUser\(\)/);
			// The ROLE LIST is asserted, not just the call. `requireClubRole` with a
			// wider list would satisfy a bare "is it called?" check while letting
			// any member of the club rewrite the scoreboard.
			expect(
				fn.body,
				`${fn.name} must gate on requireClubRole(..., ["admin"]). Without it any signed-in user could reach this club's scoreboard — and because requireClubRole is what reaches assertNotArchived, an ARCHIVED club would be writable too (ADR-0024 takedown).`,
			).toMatch(
				/requireClubRole\(\s*user\.id,\s*data\.clubId,\s*\["admin"\],?\s*\)/,
			);
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
