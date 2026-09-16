/**
 * Source guard: **one writer of `people.email`, and it writes only an address a
 * magic link just proved.**
 *
 * This replaces the enumeration `person-email-guard.guard.test.ts` held (#755).
 * That test existed because four different club-reachable paths wrote the
 * identity key and each needed the same blast-radius predicate; the predicate
 * was never the thing that was wrong, the LIST was, three review rounds running.
 * #756 removed the writers instead of guarding them, so the list is one entry
 * long and the claim is correspondingly stronger: a club-scoped actor cannot
 * write the column at all.
 *
 * **The matcher is the part that has been wrong every time, so it is tested
 * too.** A first cut of THIS file keyed on the literal token `email` appearing
 * between `.update(people)` and its `.where(`, and review found three ways past
 * it — a SET passed as a variable, an update with no WHERE, and a raw
 * `db.execute(sql\`update people …\`)`. The importer's own line was
 * `.set(pdRest)` at the time, so restoring the exact cross-club write #756
 * removed would have left this test green. The rule now is SHAPE, not text: a
 * `people` update whose SET is anything other than an inline object literal is
 * unreviewable by scanning and is refused outright.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** Everything the scan covers: all of `src/` and `scripts/`, recursively. */
const ROOTS = [
	join(import.meta.dirname, ".."),
	join(import.meta.dirname, "..", "..", "scripts"),
];
const SERVER_DIR = import.meta.dirname;

/** The single sanctioned writer, and the export that does it. */
const BINDER_FILE = "server/account-link-logic.ts";
const BINDER_FN = "bindVerifiedPerson";

/**
 * Writers that set `people.email` outside the bind, each keyed by the FUNCTION
 * that does it and carrying the number of write sites its file is allowed. Both
 * are SUPERADMIN-ONLY and unreachable by a club officer.
 *
 * Keyed per function and per COUNT on purpose: the test this one replaces waived
 * whole files, so a second `update(people).set({ email })` added anywhere inside
 * a waived file was silently exempt — the same over-capture shape, one level up.
 */
const WAIVERS: Record<string, { fn: string; sites: number; reason: string }> = {
	// The console repair for a club's FIRST admin, before anyone has signed in —
	// the bootstrap case, where no verified address exists yet. It writes the
	// membership row alongside, and carries `isNull(people.userId)` in the same
	// statement so a sign-in mid-edit cannot leave a linked Person holding a
	// typed address.
	"server/onboarding-logic.ts": {
		fn: "updateUnclaimedAdminEmail",
		sites: 1,
		reason: "superadmin console, first-admin bootstrap repair",
	},
	// Merges two Person rows; only ever FILLS a null keeper address
	// (`keeper.email ?? absorbed.email`), never moves a set one.
	"server/people-merge-logic.ts": {
		fn: "mergePeople",
		sites: 1,
		reason: "superadmin merge, fill-only on the keeper",
	},
	// The 0076 rollback. Not reachable from the app at all — an operator runs it
	// by hand, after reverting the code, to put back exactly what the migration
	// captured. Its own predicates (`user_id IS NULL AND email IS NULL`) keep it
	// from touching an address either the bind or a superadmin repair has set.
	"../scripts/rollback-0076.ts": {
		fn: "main",
		sites: 1,
		reason: "operator-run 0076 rollback, restores the captured snapshot",
	},
};

/** Every `.ts` source under `ROOTS`, recursively, excluding tests. */
function sources(): Array<{ key: string; text: string }> {
	const out: Array<{ key: string; text: string }> = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return; // `scripts/` may not exist in every checkout shape
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
			if (entry.includes(".test.") || entry.endsWith(".d.ts")) continue;
			out.push({
				key: relative(join(SERVER_DIR, ".."), full),
				text: readFileSync(full, "utf8"),
			});
		}
	};
	for (const root of ROOTS) walk(root);
	return out;
}

/**
 * Write sites in `src` that touch `people.email`, by SHAPE.
 *
 * Three rules, each earned:
 *   - the span runs to the statement's end (`;`), not to a `.where(`, so an
 *     UNFILTERED `update(people).set({...})` cannot slip through by having no
 *     WHERE at all;
 *   - a SET whose argument is not an inline object literal (a variable, a
 *     spread, a ternary) is flagged regardless of its text, because scanning
 *     cannot tell what it contains;
 *   - a raw `db.execute(sql\`update people set …\`)` is flagged too.
 *
 * It deliberately does NOT flag an INSERT. Person CREATION still carries the
 * address — a fresh row is nobody's identity yet, and `people.email` is
 * ADR-0008's fallback dedupe key. The rule is about RE-KEYING a Person who
 * already exists.
 */
function emailWriteSites(src: string): string[] {
	const hits: string[] = [];

	for (const m of src.matchAll(/\.update\(\s*people\s*\)([\s\S]*?);/g)) {
		const body = m[1] ?? "";
		const set = /\.set\(\s*(\{[\s\S]*?\})\s*\)/.exec(body);
		if (!set) {
			// `.set(` with a non-literal argument, or no `.set(` we can read.
			if (/\.set\(/.test(body))
				hits.push("update(people) with a non-literal SET");
			continue;
		}
		const literal = set[1] ?? "";
		// A spread inside the literal is just as opaque as a bare identifier —
		// `{ ...pd.set }` can carry anything.
		if (literal.includes("...")) {
			hits.push("update(people) with a spread in its SET");
			continue;
		}
		if (/\bemail\b/.test(literal)) hits.push("update(people) setting email");
	}

	for (const m of src.matchAll(/\.execute\(\s*sql`([\s\S]*?)`/g)) {
		const text = m[1] ?? "";
		if (/update\s+"?people"?[\s\S]*\bset\b[\s\S]*\bemail\b/i.test(text)) {
			hits.push("raw SQL update of people.email");
		}
	}

	return hits;
}

/**
 * The matcher, against source it has never seen. A guard test that cannot be
 * shown to fail is a guard test nobody can trust, and this family has been wrong
 * in BOTH directions already: a file-level ancestor passed while a writer sat
 * unguarded beside a guarded sibling (#755), and its first run flagged the one
 * module that merely READ the column. The production files are all supposed to
 * pass, so they can never demonstrate either.
 */
describe("the matcher itself", () => {
	const flags = (src: string) => emailWriteSites(src).length;

	it("flags a write of the column", () => {
		expect(
			flags(`
				await db.update(people)
					.set({ email: typed })
					.where(eq(people.id, personId));
			`),
		).toBe(1);
	});

	it("flags a write that hides the column among other fields", () => {
		expect(
			flags(`
				await tx.update(people)
					.set({ name: row.name, email: row.email, phone: row.phone })
					.where(eq(people.id, personId));
			`),
		).toBe(1);
	});

	it("flags a SET whose argument is a VARIABLE", () => {
		// The shape that mattered: `import-members-logic` once read `.set(pdRest)`,
		// so putting the email back into that object would have restored the
		// removed cross-club writer with this test green.
		expect(
			flags(`
				const patch = { email: typed };
				await db.update(people).set(patch).where(eq(people.id, personId));
			`),
		).toBe(1);
	});

	it("flags a SET spread from another object", () => {
		expect(
			flags(`
				await db.update(people).set({ ...pd.set }).where(eq(people.id, id));
			`),
		).toBe(1);
	});

	it("flags an update with NO where clause at all", () => {
		expect(flags(`await db.update(people).set({ email: typed });`)).toBe(1);
	});

	it("flags a raw SQL update", () => {
		expect(
			flags("await db.execute(sql`update people set email = null`);"),
		).toBe(1);
	});

	it("does NOT flag a module that only MATCHES on the column", () => {
		expect(
			flags(`
				await db.update(people)
					.set({ userId })
					.where(sql\`lower(\${people.email}) = lower(\${account.email})\`);
			`),
		).toBe(0);
	});

	it("does NOT flag an INSERT that carries the column", () => {
		expect(
			flags("await tx.insert(people).values({ name, email, phone });"),
		).toBe(0);
	});

	it("does NOT flag an update of a DIFFERENT table", () => {
		expect(
			flags(
				`await db.update(members).set({ email }).where(eq(members.id, id));`,
			),
		).toBe(0);
	});
});

describe("people.email writers (verified identity address)", () => {
	it("scans a non-trivial number of files", () => {
		// A scan that silently matched nothing would make every assertion below
		// vacuous — the exact way an enumeration stops being one.
		expect(sources().length).toBeGreaterThan(50);
	});

	it("is written in exactly one place outside the superadmin waivers", () => {
		const offenders: string[] = [];
		for (const { key, text } of sources()) {
			if (WAIVERS[key] || key === BINDER_FILE) continue;
			for (const hit of emailWriteSites(text)) offenders.push(`${key}: ${hit}`);
		}
		expect(
			offenders,
			`These files write people.email. Since #756 the column is the VERIFIED ` +
				`identity address: the only thing that may write it is the bind in ` +
				`${BINDER_FILE}, using an address a magic link just proved. A CSV, a ` +
				`roster form, an invite button and a guest book all carry values ` +
				`somebody TYPED — route the change to members.email (the club's ` +
				`contact record) instead, or add a superadmin-only waiver with a reason.`,
		).toEqual([]);
	});

	it("the one writer sets user_id in the SAME statement", () => {
		// The invariant that makes the column trustworthy, and the one a future
		// edit is most likely to break by "just updating the email here too":
		// `people.email` cannot move without the account link moving with it.
		const src = readFileSync(join(SERVER_DIR, "account-link-logic.ts"), "utf8");
		expect(emailWriteSites(src), "the binder should carry exactly one").toEqual(
			["update(people) setting email"],
		);
		const stmt = /\.update\(\s*people\s*\)([\s\S]*?);/.exec(src)?.[1] ?? "";
		expect(stmt, "the bind no longer sets user_id alongside email").toMatch(
			/userId:/,
		);
		expect(
			stmt,
			"the bind no longer refuses a Person that already holds an account",
		).toMatch(/isNull\(\s*people\.userId\s*\)/);
		expect(src, `${BINDER_FN} is gone or renamed`).toMatch(
			new RegExp(`function ${BINDER_FN}\\b`),
		);
	});

	it("the bind reads the verified address itself, never from a parameter", () => {
		// The name is the guarantee. If the address can arrive as an argument, a
		// third call site can label a typed string "verified" and every gate here
		// stays green — which is the whole defect, reintroduced by signature.
		const src = readFileSync(join(SERVER_DIR, "account-link-logic.ts"), "utf8");
		const signature =
			/export async function bindVerifiedPerson\(([\s\S]*?)\)\s*:/.exec(
				src,
			)?.[1] ?? "";
		expect(signature, "the bind takes an address from its caller").not.toMatch(
			/email/i,
		);
		expect(src).toMatch(/verifiedEmailFor\(input\.userId\)/);
	});

	it("names every waiver, so a silent exemption cannot accrete", () => {
		const byKey = new Map(sources().map((s) => [s.key, s.text]));
		for (const [key, waiver] of Object.entries(WAIVERS)) {
			const text = byKey.get(key);
			expect(
				text,
				`${key} is waived but no longer exists — drop the waiver`,
			).toBeDefined();
			expect(
				waiver.reason.length,
				`${key} has an empty waiver reason`,
			).toBeGreaterThan(10);
			expect(
				text,
				`${key}'s waiver names ${waiver.fn}, which is not in the file`,
			).toMatch(new RegExp(`function ${waiver.fn}\\b`));
			// Per-COUNT, not per-file: a second write site added to a waived file
			// would otherwise ride in on the first one's exemption.
			expect(
				emailWriteSites(text ?? ""),
				`${key} now has more people.email write sites than its waiver allows`,
			).toHaveLength(waiver.sites);
		}
	});
});
