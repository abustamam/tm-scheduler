/**
 * Source guard: every club-settings WRITE in `clubs.ts` is admin-gated (#547).
 *
 * ## Why a source grep rather than a behavioural test
 *
 * A `createServerFn` handler cannot be invoked from vitest — no session, no RPC
 * layer — so the three lines that decide who may write a club setting are
 * unreachable from the integration suite that covers everything around them.
 * `club-timezone.integration.test.ts` proves the SEAM writes the right value; it
 * cannot prove that a non-admin member, or nobody at all, is turned away before
 * reaching it. This is the only gate on that.
 *
 * ## Why derived rather than listed
 *
 * The writers are found by walking the file for `createServerFn({ method:
 * "POST" })`, not from a roster. A roster is an allowlist that has to be
 * remembered, and CLAUDE.md records two archive holes (#544, #560) that existed
 * precisely because the next endpoint was not on one. The next club setting an
 * admin can change is enrolled here the moment it is written.
 *
 * ## What the gate buys, beyond permissions
 *
 * `requireClubRole` → `requireMembership` → `assertNotArchived`, so the admin
 * check is also what refuses an archived club with `CLUB_ARCHIVED_MESSAGE`
 * (`archive-club.integration.test.ts` pins that rejection at the funnel). These
 * writers therefore carry no `assertClubNotArchived` of their own — the same
 * arrangement as their two older siblings — and dropping `requireClubRole` for a
 * bare `requireUser` would silently take the archive gate with it. That is the
 * substitution this guard is really watching for.
 *
 * Read comment-blind (`readSource`): these are "the pattern must BE present"
 * assertions, which is exactly the shape a doc comment can satisfy by accident —
 * this file's own header names `requireClubRole` several times.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource(resolve(process.cwd(), "src/server/clubs.ts"));

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

type ServerFn = { name: string; method: string; body: string };

/** Every `export const <name> = createServerFn({ method: "…" })` in the file,
 *  each sliced to its own declaration. */
function serverFns(): ServerFn[] {
	const decls = [
		...SOURCE.matchAll(
			/export const (\w+) = createServerFn\(\{\s*method:\s*"(\w+)"/g,
		),
	];
	return decls.map((m) => {
		const start = m.index ?? 0;
		const lines = SOURCE.slice(start).split("\n");
		let offset = 0;
		let body = SOURCE.slice(start);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			// i > 0 skips the declaration's own opening line.
			if (i > 0 && TOP_LEVEL_BOUNDARY.test(line)) {
				body = SOURCE.slice(start, start + offset);
				break;
			}
			offset += line.length + 1;
		}
		return { name: m[1] as string, method: m[2] as string, body };
	});
}

describe("club settings writers are admin-gated (#547)", () => {
	const fns = serverFns();
	const writers = fns.filter((f) => f.method === "POST");

	it("finds the server fns, and finds writers among them", () => {
		// Vacuity guard: every assertion below iterates `writers`, so an empty
		// list would make this whole file pass while enforcing nothing. That is
		// the failure shape a renamed export or a changed `createServerFn` call
		// style would produce, and it looks identical to success.
		expect(fns.length).toBeGreaterThanOrEqual(6);
		expect(writers.map((w) => w.name)).toContain("updateClubTimezone");
		expect(writers.length).toBeGreaterThanOrEqual(3);
	});

	it("slices each declaration to its own body, never into the next", () => {
		// The #565 over-capture check, kept local: a slice that swallowed a
		// neighbour would lend it that neighbour's `require*` call and turn an
		// ungated writer into a passing one.
		for (const fn of fns) {
			const others = fns.filter((o) => o.name !== fn.name);
			for (const other of others) {
				expect(
					fn.body.includes(`export const ${other.name} = createServerFn`),
					`${fn.name}'s slice ran into ${other.name}`,
				).toBe(false);
			}
		}
	});

	for (const writer of writers) {
		it(`${writer.name} resolves a user and requires the admin club role`, () => {
			expect(writer.body).toMatch(/requireUser\(\)/);
			// The role list is asserted too, not just the call: `requireClubRole`
			// with a wider list would pass a bare "is it called?" check while
			// letting any member write a club-wide setting.
			expect(writer.body).toMatch(
				/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\["admin"\],?\s*\)/,
			);
		});

		it(`${writer.name} validates its input with a schema`, () => {
			// An unvalidated writer is how an unresolvable timezone would reach the
			// column, and from there every meeting link and every meeting write —
			// `zonedWallTimeToUtc` throws a RangeError on a zone Intl cannot
			// resolve. See `isSupportedClubTimezone`.
			expect(writer.body).toMatch(/\.validator\(/);
			expect(writer.body).toMatch(/Schema\.parse\(/);
		});
	}

	// The READ side. Enrolled here for the same reason as the writers: a handler
	// body is unreachable from vitest, so dropping `requireClubViewAccess` and
	// leaving a bare `requireUser()` would make every club's settings readable by
	// any signed-in user of any club, with the whole suite green.
	//
	// Two of this file's GETs are deliberately PUBLIC (`getClubByIdentifier`,
	// `getPublicClubProfileFn`) and are covered by the archive-gate sweep in
	// `public-readers-archive-gate.guard.test.ts` instead.
	//
	// They are waived BY NAME, which is the weak point: a name buys an exemption
	// whose claim nobody re-checks, and CLAUDE.md records that exact shape costing
	// 11 ungated endpoints when a sweep exempted three guards by name whose
	// property did not hold. So each waiver must EARN it — the body has to route
	// through a `Public`-named seam, this repo's only in-source signal that a
	// reader is archive-gated. Note the signal is on the SEAM, not the endpoint:
	// `getClubByIdentifier` is public but says so only by calling
	// `resolvePublicClubIdentifier`.
	const PUBLIC_GETS = new Set([
		"getClubByIdentifier",
		"getPublicClubProfileFn",
	]);
	const readers = fns.filter(
		(f) => f.method === "GET" && !PUBLIC_GETS.has(f.name),
	);

	it("finds the authed readers, and every waived GET earns its waiver", () => {
		expect(readers.map((r) => r.name)).toContain("loadClubTimezoneSettings");
		for (const name of PUBLIC_GETS) {
			const fn = fns.find((f) => f.name === name && f.method === "GET");
			expect(
				fn,
				`${name} is waived as public but is no longer a GET server fn here`,
			).toBeDefined();
			// Routes through a Public (archive-gated) seam...
			expect(fn?.body).toMatch(/Public/);
			// ...and resolves no session, which is what makes it public at all. A
			// waived GET that started requiring one would be an authed reader
			// hiding in the exemption list.
			expect(fn?.body).not.toMatch(/requireUser\(\)/);
		}
	});

	for (const reader of readers) {
		it(`${reader.name} gates the read on club view access`, () => {
			expect(reader.body).toMatch(/requireUser\(\)/);
			expect(reader.body).toMatch(
				/require(ClubViewAccess|ClubAdminView)\(\s*currentUser\.id,\s*clubId,?\s*\)/,
			);
		});
	}
});
