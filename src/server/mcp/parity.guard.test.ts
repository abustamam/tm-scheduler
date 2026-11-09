import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	PARITY_ROWS,
	type ParityRow,
	toolAudienceFor,
} from "#/server/mcp/parity";
import { serverFnDeclarations } from "#/test/guard-source";

/**
 * #1564. protects=every exported POST `createServerFn` under `src/server/` has a
 * row in the connector parity table, so a write the connector cannot do is
 * recorded rather than discovered by a user's agent;
 * fails_when=a write has no row, a row names a function that is gone, a `tool`
 * row names an unregistered tool, a `tool` row's audience disagrees with the
 * tool's, or a row names zero or several outcomes;
 * no_claim=that a `tool` row's tool does everything the function does (a tool
 * may cover one field of it), nor that a `gap`/`notOnConnector` call is right:
 * the maintainer decides those in review.
 *
 * Reads RAW, not comment-blind: the discovery anchors on `^export const`, which
 * a comment cannot start, and this asserts a SET MATCHES, not that a pattern is
 * present.
 */
vi.mock("#/db", () => ({ db: {} }));

const { MCP_TOOLS } = await import("#/server/mcp/tools");

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `module.name` of every exported POST server fn, recursing into subdirectories. */
function discoverPostFns(): string[] {
	const out: string[] = [];
	for (const rel of readdirSync(SERVER_DIR, { recursive: true }) as string[]) {
		if (!rel.endsWith(".ts") || /\.(test|spec)\./.test(rel)) continue;
		const src = readFileSync(join(SERVER_DIR, rel), "utf8");
		for (const d of serverFnDeclarations(src)) {
			if (d.method === "POST") {
				out.push(`${rel.replace(/\.ts$/, "")}.${d.name}`);
			}
		}
	}
	return out.sort();
}

const key = (r: { module: string; name: string }) => `${r.module}.${r.name}`;

/** The four failure modes (plus row shape), as problems to report. */
function parityProblems(
	rows: ParityRow[],
	discovered: string[],
	tools: { name: string; audience: string }[],
): string[] {
	const problems: string[] = [];
	const known = new Set(rows.map(key));
	const found = new Set(discovered);
	for (const fn of discovered) {
		if (!known.has(fn)) {
			problems.push(
				`${fn} is a POST server function with no parity row: add a row to src/server/mcp/parity.ts as a \`tool\`, \`gap\` or \`notOnConnector\`.`,
			);
		}
	}
	for (const r of rows) {
		if (!found.has(key(r))) {
			problems.push(
				`${key(r)} has a parity row but no such POST server function exists any more: delete the row.`,
			);
		}
		const kinds = ["tool", "gap", "notOnConnector"].filter(
			(k) => k in r.outcome,
		);
		if (kinds.length !== 1) {
			problems.push(
				`${key(r)} must name exactly one outcome, found ${kinds.length}.`,
			);
		}
		if ("tool" in r.outcome) {
			const t = tools.find(
				(x) => x.name === (r.outcome as { tool: string }).tool,
			);
			if (!t) {
				problems.push(
					`${key(r)} names tool "${(r.outcome as { tool: string }).tool}", which is not registered.`,
				);
			} else if (t.audience !== toolAudienceFor(r.audience)) {
				problems.push(
					`${key(r)} is audience "${r.audience}" but tool ${t.name} is "${t.audience}".`,
				);
			}
		}
		if (
			"notOnConnector" in r.outcome &&
			!r.outcome.notOnConnector.includes(":")
		) {
			problems.push(`${key(r)} notOnConnector needs "<category>: <sentence>".`);
		}
	}
	const dupes = rows.map(key).filter((k, i, a) => a.indexOf(k) !== i);
	for (const d of new Set(dupes)) problems.push(`${d} has more than one row.`);
	return problems;
}

describe("connector parity table (#1564)", () => {
	it("matches every exported POST server function, and every tool row is real", () => {
		expect(parityProblems(PARITY_ROWS, discoverPostFns(), MCP_TOOLS)).toEqual(
			[],
		);
	});

	it("discovery sees the real tree (not an empty sweep)", () => {
		const found = discoverPostFns();
		expect(found.length).toBeGreaterThan(150);
		expect(found).toContain("members.editMember");
	});

	describe("the checker itself", () => {
		const tools = [
			{ name: "edit_member", audience: "officer" },
			{ name: "whoami", audience: "member" },
		];
		const ok: ParityRow = {
			module: "m",
			name: "a",
			audience: "admin",
			outcome: { tool: "edit_member" },
		};

		it("accepts a consistent table", () => {
			expect(parityProblems([ok], ["m.a"], tools)).toEqual([]);
		});

		it("1. names a function with no row", () => {
			const p = parityProblems([ok], ["m.a", "m.b"], tools);
			expect(p).toHaveLength(1);
			expect(p[0]).toContain("m.b");
			expect(p[0]).toContain("`tool`, `gap` or `notOnConnector`");
		});

		it("2. flags a stale row", () => {
			expect(parityProblems([ok], [], tools)[0]).toContain("delete the row");
		});

		it("3. flags an unregistered tool", () => {
			const r = { ...ok, outcome: { tool: "nope" } };
			expect(parityProblems([r], ["m.a"], tools)[0]).toContain(
				"not registered",
			);
		});

		it("4. flags an audience disagreement", () => {
			const r: ParityRow = { ...ok, audience: "member" };
			expect(parityProblems([r], ["m.a"], tools)[0]).toContain(
				'audience "member" but tool edit_member is "officer"',
			);
		});

		it("flags a row with two outcomes", () => {
			const r = { ...ok, outcome: { tool: "edit_member", gap: true } };
			expect(parityProblems([r as ParityRow], ["m.a"], tools)[0]).toContain(
				"exactly one outcome",
			);
		});
	});
});
