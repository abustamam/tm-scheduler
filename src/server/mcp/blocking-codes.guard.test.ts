/**
 * Every declared blocking code is raised by a tool (#776 item 6).
 *
 * `McpBlockingCode` shipped with two members nothing ever pushed —
 * `MEETING_LOCKED` and `FIELD_TOO_LONG`. Nothing could see it: a union member
 * is erased at compile time, so TypeScript is content, and the behavioural
 * tests assert on the codes that DO arrive rather than on the set that could.
 * A code nobody emits is not inert either — it tells the next reader the case
 * is handled, and it tells an MCP client to branch on something it will never
 * receive.
 *
 * So this is a source grep, and per `src/test/guard-source.ts` it is the
 * "must BE present" class: read COMMENT-BLIND, because this file's own sibling
 * modules explain most of these codes in prose, and a code named only in a
 * comment would satisfy a raw read exactly as well as a real `blocking.push`.
 *
 * The union is parsed out of `errors.ts` rather than restated here. A copy of
 * the list is the one thing that cannot catch the bug: adding a dead member to
 * the union and to the copy leaves the guard green.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource, stripComments } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const MCP_DIR = resolve(SELF, "..");
const ERRORS = resolve(MCP_DIR, "errors.ts");
const SERVER_DIR = resolve(MCP_DIR, "..");

/**
 * Files OUTSIDE `src/server/mcp/` that raise blocking codes, enrolled by hand.
 *
 * #806 moved `plan()` to `src/server/guest-book-plan.ts` so the session-authorized
 * confirm page could share it — `mcp-authz.guard.test.ts` fails any file under
 * `src/server/mcp/` that imports a session guard, so the apply could not stay in
 * that tree and the planner moved with it. All five codes are raised inside
 * `plan()`, so without this the sweep below would report every one of them as
 * declared-but-never-emitted and five cases would turn red on a move that
 * changed no behaviour.
 *
 * The right fix was to re-point the sweep, not to relax it: a declared code
 * nothing emits is exactly the drift #776 item 6 removed. Add a path here when a
 * blocking code is genuinely raised outside the MCP tree, and nowhere else — the
 * existence assertion below fails if a path in this list stops existing, so a
 * later rename cannot leave a silently-empty enrolment behind.
 */
const ENROLLED_OUTSIDE_MCP = [
	"../guest-book-plan.ts",
	// #808 for the same reason: `upsert_agendas` previews and the confirm page
	// re-plans through the same `plan()`, so the planner is session-reachable and
	// cannot sit under `src/server/mcp/`. `AMBIGUOUS_DATE`, `MEETING_LOCKED` and
	// `MISSING_TIME` are all raised there.
	"../agenda-plan.ts",
] as const;

/**
 * The string members of `export type McpBlockingCode = …`, read out of source.
 *
 * Sliced to the declaration's own statement — from the `export type` to the
 * terminating `;` — rather than scanning the whole file, which would sweep in
 * `McpErrorCode`'s members and report a union twice its real size.
 */
function declaredBlockingCodes(): string[] {
	const src = readSource(ERRORS);
	const start = src.indexOf("export type McpBlockingCode =");
	if (start === -1) {
		throw new Error(
			"McpBlockingCode not found in errors.ts — it was renamed or removed. Re-point this guard rather than deleting it.",
		);
	}
	const end = src.indexOf(";", start);
	const body = src.slice(start, end);
	return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

/** Every `.ts` under `src/server/mcp/` that is neither a test nor `errors.ts`. */
function mcpSources(dir = MCP_DIR, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...mcpSources(resolve(dir, entry.name), rel));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.includes(".test.") &&
			rel !== "errors.ts"
		) {
			out.push(rel);
		}
	}
	return out;
}

describe("the blocking-code vocabulary (#776 item 6)", () => {
	const codes = declaredBlockingCodes();
	const files = [...mcpSources(), ...ENROLLED_OUTSIDE_MCP];

	// Vacuity floor. A parse that returned [] would make every case below pass
	// by having nothing to check, which is the failure shape this guard exists
	// to prevent one level down.
	it("parses the union out of errors.ts", () => {
		expect(codes.length).toBeGreaterThanOrEqual(4);
		expect(codes).toContain("NO_MEETING_ON_DATE");
		// `FIELD_TOO_LONG`, dropped in #776, stays dropped until something raises
		// it: an over-long field is a zod `VALIDATION` rejection before any plan
		// is built.
		expect(codes).not.toContain("FIELD_TOO_LONG");
		// `MEETING_LOCKED` came BACK at #809, and the sweep below is what makes
		// that legitimate rather than a re-run of the drift #776 removed:
		// `assign_roles` edits the agenda, which a completed meeting has refused
		// since #150, so a tool now pushes it. Asserted positively here so this
		// case keeps saying something — the negative it replaced would otherwise
		// just be deleted.
		expect(codes).toContain("MEETING_LOCKED");
		// The slice stops at its own declaration: `McpErrorCode`'s members are a
		// different vocabulary and must not leak in.
		expect(codes).not.toContain("FORBIDDEN");
		expect(codes).not.toContain("PLAN_STALE");
	});

	it("finds the tool modules to search", () => {
		expect(files).toContain("tools/record-guest-book.ts");
		expect(files).toContain("tools/assign-roles.ts");
		expect(files.length).toBeGreaterThanOrEqual(5);
	});

	// The enrolment above is the only hand-written part of the sweep, and a path
	// in it that no longer exists would silently contribute nothing — which is
	// the failure shape the whole guard exists to prevent, one level up. Assert
	// the files are real, and that the one enrolled for #806 is really where the
	// codes are raised.
	it("the files enrolled from outside src/server/mcp/ exist and raise codes", () => {
		for (const rel of ENROLLED_OUTSIDE_MCP) {
			const src = readSource(resolve(MCP_DIR, rel));
			expect(
				src.length,
				`${rel} is enrolled but empty or missing`,
			).toBeGreaterThan(0);
			expect(
				/blocking\.push\(/.test(src),
				`${rel} is enrolled in this sweep but pushes no blocking item. Either it moved again — re-point the enrolment — or it should not be listed.`,
			).toBe(true);
		}
		expect(
			ENROLLED_OUTSIDE_MCP.map((rel) => resolve(MCP_DIR, rel)),
		).toStrictEqual([
			resolve(SERVER_DIR, "guest-book-plan.ts"),
			resolve(SERVER_DIR, "agenda-plan.ts"),
		]);
	});

	for (const code of codes) {
		it(`${code} is raised somewhere under src/server/mcp/`, () => {
			// STRIPPED: comment-blind, so prose naming a code does not stand in for
			// a tool that pushes it.
			const raisedIn = files.filter((f) =>
				readSource(resolve(MCP_DIR, f)).includes(`code: "${code}"`),
			);
			expect(
				raisedIn.length,
				`${code} is declared in McpBlockingCode and no tool pushes a blocking item with it. Either raise it where it belongs or drop it from the union — a declared code nothing emits tells the next reader the case is handled (#776 item 6).`,
			).toBeGreaterThan(0);
		});
	}

	it("would not accept a code that exists only in a comment", () => {
		// The control, run through the same reader the cases above use. A raw read
		// matches both fixtures; the stripped read matches only the real push.
		const commented = `// blocking.push({ code: "PHANTOM" });\nconst x = 1;\n`;
		const real = `blocking.push({ code: "PHANTOM", entryIndex: 0 });\n`;

		expect(commented).toContain('code: "PHANTOM"');
		expect(stripComments(commented)).not.toContain('code: "PHANTOM"');
		expect(stripComments(real)).toContain('code: "PHANTOM"');
	});
});
