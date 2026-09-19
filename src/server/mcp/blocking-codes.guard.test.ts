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
	const files = mcpSources();

	// Vacuity floor. A parse that returned [] would make every case below pass
	// by having nothing to check, which is the failure shape this guard exists
	// to prevent one level down.
	it("parses the union out of errors.ts", () => {
		expect(codes.length).toBeGreaterThanOrEqual(4);
		expect(codes).toContain("NO_MEETING_ON_DATE");
		// The two dropped in #776 stay dropped until something raises them.
		expect(codes).not.toContain("MEETING_LOCKED");
		expect(codes).not.toContain("FIELD_TOO_LONG");
		// The slice stops at its own declaration: `McpErrorCode`'s members are a
		// different vocabulary and must not leak in.
		expect(codes).not.toContain("FORBIDDEN");
		expect(codes).not.toContain("PLAN_STALE");
	});

	it("finds the tool modules to search", () => {
		expect(files).toContain("tools/record-guest-book.ts");
		expect(files.length).toBeGreaterThanOrEqual(5);
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
