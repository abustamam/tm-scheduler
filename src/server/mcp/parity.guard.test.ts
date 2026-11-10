import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	PARITY_ROWS,
	type ParityRow,
	toolAudienceFor,
	toolNames,
} from "#/server/mcp/parity";
import { serverFnDeclarations } from "#/test/guard-source";

/**
 * #1564. protects=every exported non-GET `createServerFn` under `src/server/`
 * has a row in the connector parity table, so a write the connector cannot do is
 * recorded rather than discovered by a user's agent, and every registered tool is
 * accounted for;
 * fails_when=a non-GET declaration has no row or a method the parser cannot
 * read, a row names a function that is gone or appears twice, a row names zero or
 * several outcomes or an empty notOnConnector reason, a `tool` row names an
 * unregistered tool, has an audience with no connector counterpart
 * (superadmin / public / areaDirector) or one that disagrees with every tool it
 * names, or a registered tool is neither named by a row nor on the allowlist
 * below (and an allowlist entry names a tool that is not registered);
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

/**
 * Registered tools that no row names, each with the reason. A NEW tool must be
 * named by a row or added here with a reason: that is the point of the check.
 */
const UNROWED_TOOLS: Record<string, string> = {
	whoami: "read-only",
	list_meetings: "read-only",
	get_agenda: "read-only",
	get_lineup_blast: "read-only",
	get_import_report: "read-only",
	get_my_feedback: "read-only",
	get_my_schedule: "read-only",
	find_people: "read-only",
	reschedule_meeting:
		"its app function (meetings.updateMeeting) is a gap row: the gate differs from the tool's",
	set_contact_preference:
		"its app function (setMyPreferredContact) is a gap row: self-gated, the tool is officer-gated",
	upsert_agendas:
		"stages a plan only; the write is applyAgendaPendingPlan, a notOnConnector confirm-link row",
	record_guest_book:
		"stages a plan only; the write is applyGuestBookPendingPlan, a notOnConnector confirm-link row",
};

/** Every non-GET declaration in one file's source; UNKNOWN included. */
function declaredWrites(rel: string, src: string): Declared[] {
	const out: Declared[] = [];
	for (const d of serverFnDeclarations(src)) {
		// Anything that is not GET is a candidate, UNKNOWN included.
		if (d.method !== "GET") {
			out.push({
				key: `${rel.replace(/\.ts$/, "")}.${d.name}`,
				method: d.method,
			});
		}
	}
	return out;
}

interface Declared {
	key: string;
	method: string;
}

/** `module.name` and method of every exported non-GET server fn, recursing into subdirectories. */
function discoverWriteFns(): Declared[] {
	const out: Declared[] = [];
	for (const rel of readdirSync(SERVER_DIR, { recursive: true }) as string[]) {
		if (!rel.endsWith(".ts") || /\.(test|spec)\./.test(rel)) continue;
		out.push(
			...declaredWrites(rel, readFileSync(join(SERVER_DIR, rel), "utf8")),
		);
	}
	return out.sort((x, y) => x.key.localeCompare(y.key));
}

const key = (r: { module: string; name: string }) => `${r.module}.${r.name}`;

/** Every checked failure mode, as problems to report. */
function parityProblems(
	rows: ParityRow[],
	discovered: Declared[],
	tools: { name: string; audience: string }[],
	unrowed: Record<string, string>,
): string[] {
	const problems: string[] = [];
	const known = new Set(rows.map(key));
	const found = new Set(discovered.map((d) => d.key));
	for (const d of discovered) {
		if (d.method === "UNKNOWN") {
			problems.push(
				`${d.key} declares no method the parser can read (method: 'POST' single-quoted, or computed?): write method: "POST" so the sweep can classify it.`,
			);
		}
		if (!known.has(d.key)) {
			problems.push(
				`${d.key} is a non-GET server function with no parity row: add a row to src/server/mcp/parity.ts as a tool, gap or notOnConnector row.`,
			);
		}
	}
	const named = new Set<string>();
	for (const r of rows) {
		if (!found.has(key(r))) {
			problems.push(
				`${key(r)} has a parity row but no such non-GET server function exists any more: delete the row.`,
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
		if ("tool" in r.outcome && r.outcome.tool !== undefined) {
			const names = toolNames(r.outcome.tool);
			const registered: { name: string; audience: string }[] = [];
			for (const n of names) {
				named.add(n);
				const t = tools.find((x) => x.name === n);
				if (t) registered.push(t);
				else
					problems.push(
						`${key(r)} names tool "${n}", which is not registered.`,
					);
			}
			const want = toolAudienceFor(r.audience);
			if (want === null) {
				problems.push(
					`${key(r)} is audience "${r.audience}", which has no connector audience: it cannot be a tool row (make it a gap or notOnConnector).`,
				);
			} else if (
				registered.length > 0 &&
				!registered.some((t) => t.audience === want)
			) {
				const t = registered[0] as { name: string; audience: string };
				problems.push(
					`${key(r)} is audience "${r.audience}" but tool ${t.name} is "${t.audience}".`,
				);
			}
		}
		if (
			"notOnConnector" in r.outcome &&
			r.outcome.notOnConnector !== undefined &&
			r.outcome.notOnConnector.reason.trim() === ""
		) {
			problems.push(`${key(r)} notOnConnector needs a non-empty reason.`);
		}
	}
	const dupes = rows.map(key).filter((k, i, a) => a.indexOf(k) !== i);
	for (const d of new Set(dupes)) problems.push(`${d} has more than one row.`);
	for (const t of tools) {
		if (!named.has(t.name) && !(t.name in unrowed)) {
			problems.push(
				`tool ${t.name} is registered but no parity row names it: name it in a row's tool outcome, or add it to the allowlist in parity.guard.test.ts with a reason.`,
			);
		}
	}
	for (const n of Object.keys(unrowed)) {
		if (!tools.some((t) => t.name === n)) {
			problems.push(`allowlist names tool "${n}", which is not registered.`);
		}
	}
	return problems;
}

describe("connector parity table (#1564)", () => {
	it("matches every exported non-GET server function, and every tool is accounted for", () => {
		expect(
			parityProblems(PARITY_ROWS, discoverWriteFns(), MCP_TOOLS, UNROWED_TOOLS),
		).toEqual([]);
	});

	it("discovery sees the real tree (not an empty sweep)", () => {
		const found = discoverWriteFns().map((d) => d.key);
		expect(found.length).toBeGreaterThan(150);
		expect(found).toContain("members.editMember");
	});

	describe("discovery", () => {
		it("keeps every non-GET declaration, an unreadable method included", () => {
			const src = [
				'export const a = createServerFn({ method: "POST" })',
				"export const b = createServerFn({ method: 'POST' })",
				"export const c = createServerFn()",
				'export const d = createServerFn({ method: "GET" })',
			].join("\n");
			expect(declaredWrites("sub/m.ts", src)).toEqual([
				{ key: "sub/m.a", method: "POST" },
				{ key: "sub/m.b", method: "UNKNOWN" },
				{ key: "sub/m.c", method: "UNKNOWN" },
			]);
		});
	});

	describe("the checker itself", () => {
		const tools = [
			{ name: "edit_member", audience: "officer" },
			{ name: "whoami", audience: "member" },
			{ name: "set_my_attendance", audience: "member" },
		];
		const unrowed = { whoami: "read-only", edit_member: "unused here" };
		const ok: ParityRow = {
			module: "m",
			name: "a",
			audience: "admin",
			outcome: { tool: "edit_member" },
		};
		const rowFor = (p: Partial<ParityRow>): ParityRow => ({ ...ok, ...p });
		const decl = (k: string, method = "POST"): Declared => ({ key: k, method });
		const check = (
			rows: ParityRow[],
			d: Declared[],
			u: Record<string, string> = unrowed,
			t = tools,
		) => parityProblems(rows, d, t, u);
		// A row that names set_my_attendance, so that tool is accounted for.
		const mine = rowFor({
			name: "z",
			audience: "member",
			outcome: { tool: "set_my_attendance" },
		});
		const base = [ok, mine];
		const baseDecl = [decl("m.a"), decl("m.z")];

		it("accepts a consistent table", () => {
			expect(check(base, baseDecl)).toEqual([]);
		});

		it("1. names a function with no row", () => {
			const p = check(base, [...baseDecl, decl("m.b")]);
			expect(p).toHaveLength(1);
			expect(p[0]).toContain("m.b");
			expect(p[0]).toContain("tool, gap or notOnConnector row");
		});

		it("2. flags a stale row", () => {
			expect(check(base, [decl("m.z")])[0]).toContain("delete the row");
		});

		it("3. flags an unregistered tool", () => {
			const r = rowFor({ outcome: { tool: "nope" } });
			expect(check([r, mine], baseDecl)[0]).toContain("not registered");
		});

		it("4. flags an audience disagreement", () => {
			const r = rowFor({ audience: "member" });
			expect(check([r, mine], baseDecl)[0]).toContain(
				'audience "member" but tool edit_member is "officer"',
			);
		});

		it("flags a row with two outcomes", () => {
			const r = { ...ok, outcome: { tool: "edit_member", gap: true } };
			expect(check([r as unknown as ParityRow, mine], baseDecl)[0]).toContain(
				"exactly one outcome",
			);
		});

		it("flags a declaration whose method cannot be read, and still wants a row", () => {
			const p = check(base, [...baseDecl, decl("m.q", "UNKNOWN")]);
			expect(p).toHaveLength(2);
			expect(p[0]).toContain("m.q declares no method the parser can read");
			expect(p[1]).toContain(
				"m.q is a non-GET server function with no parity row",
			);
		});

		it("accepts an UNKNOWN-method declaration that has a row only after reporting it", () => {
			const g = rowFor({ name: "q", outcome: { gap: true } });
			const p = check([...base, g], [...baseDecl, decl("m.q", "UNKNOWN")]);
			expect(p).toHaveLength(1);
			expect(p[0]).toContain("declares no method");
		});

		it("flags a function with two rows", () => {
			const p = check([...base, ok], baseDecl);
			expect(p).toEqual(["m.a has more than one row."]);
		});

		it("flags a notOnConnector row with an empty reason", () => {
			const r = rowFor({
				outcome: { notOnConnector: { category: "UI-only state", reason: " " } },
			});
			expect(check([r, mine], baseDecl)).toEqual([
				"m.a notOnConnector needs a non-empty reason.",
			]);
		});

		for (const audience of ["superadmin", "public", "areaDirector"] as const) {
			it(`flags a tool row with audience ${audience}`, () => {
				const r = rowFor({ audience, outcome: { tool: "whoami" } });
				const p = check([r, mine], baseDecl);
				expect(p).toHaveLength(1);
				expect(p[0]).toContain(
					`audience "${audience}", which has no connector audience`,
				);
			});
		}

		it("accepts a row naming several tools when one agrees", () => {
			const r = rowFor({
				audience: "member",
				outcome: { tool: ["edit_member", "set_my_attendance"] },
			});
			expect(check([r], [decl("m.a")])).toEqual([]);
		});

		it("flags a multi-tool row when none agrees, and each unregistered name", () => {
			const r = rowFor({
				audience: "admin",
				outcome: { tool: ["set_my_attendance", "nope"] },
			});
			const p = check([r, mine], baseDecl);
			expect(p).toHaveLength(2);
			expect(p.some((x) => x.includes('tool "nope"'))).toBe(true);
			expect(p.some((x) => x.includes('audience "admin" but tool'))).toBe(true);
		});

		it("flags a registered tool that no row names and is not allowlisted", () => {
			const p = check([ok], [decl("m.a")]);
			expect(p).toHaveLength(1);
			expect(p[0]).toContain("tool set_my_attendance is registered");
		});

		it("accepts an allowlisted tool, and flags a stale allowlist entry", () => {
			expect(
				check([ok], [decl("m.a")], { ...unrowed, set_my_attendance: "read" }),
			).toEqual([]);
			const p = check(base, baseDecl, { ...unrowed, gone: "x" });
			expect(p).toEqual([
				'allowlist names tool "gone", which is not registered.',
			]);
		});
	});
});
