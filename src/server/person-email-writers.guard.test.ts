/**
 * Source guard: **one writer of `people.email`, and it writes only an address a
 * magic link just proved.**
 *
 * This replaces the enumeration `person-email-guard.guard.test.ts` held (#755).
 * That test existed because four different club-reachable paths wrote the
 * identity key and each needed the same blast-radius predicate; the predicate
 * was never the thing that was wrong, the LIST was, three review rounds running.
 * #756 removed the writers instead of guarding them, so the list is one entry
 * long. The claim is precisely: **a club-scoped actor cannot RE-KEY an existing
 * Person's address.** Creation still carries one — the matcher exempts a plain
 * INSERT on purpose, because `people.email` is also ADR-0008's dedupe hint — and
 * saying "cannot write the column at all" would be false in the same sentence
 * this file exists to make true.
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
const WAIVERS: Record<
	string,
	{
		fn: string;
		sites: number;
		reason: string;
		/** Its UPDATE must carry `isNull(people.userId)` in the statement itself. */
		requiresUnlinkedGuard?: boolean;
	}
> = {
	// The console repair for a club's FIRST admin, before anyone has signed in —
	// the bootstrap case, where no verified address exists yet. It writes the
	// membership row alongside, and carries `isNull(people.userId)` in the same
	// statement so a sign-in mid-edit cannot leave a linked Person holding a
	// typed address.
	"server/onboarding-logic.ts": {
		fn: "updateUnclaimedAdminEmail",
		sites: 1,
		reason: "superadmin console, first-admin bootstrap repair",
		// Its `admin.userId` check runs OUTSIDE the write's transaction, so under
		// READ COMMITTED a sign-in landing in that window would leave a LINKED
		// Person carrying a superadmin-typed address — from the one writer whose
		// waiver claims it is safe. The predicate has to be in the STATEMENT.
		//
		// Asserted on the SOURCE because the behaviour is unreachable from a test:
		// the pre-write check fires first for every state a test can construct, so
		// deleting `isNull(people.userId)` from the UPDATE left the whole suite
		// green. That was found by mutation, and this is the gate that replaces the
		// test which could not fail.
		requiresUnlinkedGuard: true,
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
 * Strip line and block comments, so a `;` or the word `email` inside prose
 * cannot steer the scan. This repo writes very long comments — several of them
 * about this very column — so an un-stripped source is the likeliest way the
 * matcher lies, in either direction.
 */
function withoutComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * The local binding for `#/db/schema`'s `people` export in this file, so an
 * aliased import (`import { people as p }`) cannot rename its way past the scan.
 * Defaults to `people` when there is no import to read.
 */
function peopleBinding(src: string): string {
	const alias = /import\s*\{[^}]*\bpeople\s+as\s+(\w+)/.exec(src);
	return alias?.[1] ?? "people";
}

/**
 * Write sites in `src` that RE-KEY `people.email`, matched by SHAPE.
 *
 * The rules, each earned by an evasion found in review:
 *   - **comments are stripped first.** The span used to end at the first `;`
 *     CHARACTER, so a semicolon in a trailing comment truncated the body before
 *     `.set(` was seen and the site vanished.
 *   - **the table is resolved through its local binding**, including a
 *     namespace qualifier or an `as` cast, so `schema.people`, `people as any`
 *     and an aliased import are all still the same table.
 *   - **a SET that is not an inline object literal is flagged outright** — a
 *     variable, a spread, a ternary. Scanning cannot read what it contains, and
 *     the production call site that mattered was exactly `.set(pdRest)`.
 *   - **an update with NO `.set(` we can read is flagged**, so a chain split
 *     across statements (`const q = db.update(people); q.set(...)`) is caught by
 *     the half that is visible.
 *   - **raw SQL is matched by its TEXT wherever it appears** — any template or
 *     string literal — rather than by the call that runs it, because
 *     `sql.raw(...)`, a hoisted fragment and `$client.query(...)` all evaded a
 *     scan anchored on `.execute(sql\`…\`)`.
 *   - **an UPSERT counts as a re-key.** `insert(people).onConflictDoUpdate({ set })`
 *     writes an EXISTING row, and `people.customer_id` is globally unique, so
 *     the importer upserting on it is the single most likely future writer.
 *
 * It deliberately does NOT flag a plain INSERT. Person CREATION still carries
 * the address — a fresh row is nobody's identity yet, and `people.email` is
 * ADR-0008's fallback dedupe key. The rule is about RE-KEYING a Person who
 * already exists.
 */
function emailWriteSites(source: string): string[] {
	const hits: string[] = [];
	const src = withoutComments(source);
	const table = peopleBinding(source);
	// `people`, `schema.people`, `people as any` — any of them, inside the call.
	const target = `(?:\\w+\\.)?${table}(?:\\s+as\\s+\\w+)?`;

	/**
	 * Judge one SET clause. `opener` differs by shape: a query builder writes
	 * `.set({…})`, drizzle's upsert writes `set: {…}` inside the conflict object.
	 * An opener that is present but whose argument is not a readable literal is
	 * flagged; an opener that is absent entirely is flagged too, because a chain
	 * split across statements leaves the write in the half we cannot see.
	 */
	const classifySet = (body: string, kind: string, opener: RegExp) => {
		const literalRe = new RegExp(`${opener.source}\\s*(\\{[\\s\\S]*?\\})`);
		const set = literalRe.exec(body);
		if (!set) {
			hits.push(
				opener.test(body)
					? `${kind} with a non-literal SET`
					: `${kind} whose SET could not be read`,
			);
			return;
		}
		const literal = set[1] ?? "";
		if (literal.includes("...")) {
			hits.push(`${kind} with a spread in its SET`);
			return;
		}
		if (/\bemail\b/.test(literal)) hits.push(`${kind} setting email`);
	};

	for (const m of src.matchAll(
		new RegExp(`\\.update\\(\\s*${target}\\s*\\)([\\s\\S]*?);`, "g"),
	)) {
		classifySet(m[1] ?? "", "update(people)", /\.set\(/);
	}

	// An upsert re-keys an existing row. Only the conflict branch matters, and it
	// spells its SET `set: {…}` rather than `.set(…)`.
	for (const m of src.matchAll(
		new RegExp(`\\.insert\\(\\s*${target}\\s*\\)([\\s\\S]*?);`, "g"),
	)) {
		const body = m[1] ?? "";
		if (/\.onConflictDoUpdate\(/.test(body)) {
			classifySet(body, "insert(people).onConflictDoUpdate", /\bset:/);
		}
	}

	// Raw SQL, by its text, wherever it is written. Schema-qualified too.
	for (const m of src.matchAll(
		/`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g,
	)) {
		const text = m[1] ?? m[2] ?? m[3] ?? "";
		if (
			/update\s+(?:"?public"?\.)?"?people"?[\s\S]*\bset\b[\s\S]*\bemail\b/i.test(
				text,
			)
		) {
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

	// ---------------------------------------------------------------------
	// Derived from the matcher's OWN assumptions, not from the bug reports.
	// Each of these evaded the previous cut, whose self-tests covered only the
	// evasions review had already named — so the block confirmed yesterday's
	// fixes and probed nothing about today's matcher.
	// ---------------------------------------------------------------------

	it("flags an UPSERT that re-keys on conflict", () => {
		// `people.customer_id` is globally UNIQUE, so the CSV importer upserting on
		// it is the most likely way this column ever gets written again.
		expect(
			flags(
				`await db.insert(people).values({ name, email }).onConflictDoUpdate({ target: people.customerId, set: { email: typed } });`,
			),
		).toBe(1);
	});

	it("does NOT flag an upsert whose conflict branch leaves email alone", () => {
		expect(
			flags(
				`await db.insert(people).values({ name, email }).onConflictDoUpdate({ target: people.customerId, set: { name: row.name } });`,
			),
		).toBe(0);
	});

	it("is not fooled by a semicolon inside a comment", () => {
		expect(
			flags(
				"await db\n\t.update(people) // re-key; see #756\n\t.set({ email: typed })\n\t.where(eq(people.id, id));",
			),
		).toBe(1);
	});

	it("flags an update whose chain is split across statements", () => {
		expect(
			flags(
				"const q = db.update(people);\nawait q.set({ email: typed }).where(eq(people.id, id));",
			),
		).toBe(1);
	});

	it("flags a write through an ALIASED import", () => {
		expect(
			flags(
				`import { people as p } from "#/db/schema";\nawait db.update(p).set({ email: typed }).where(eq(p.id, id));`,
			),
		).toBe(1);
	});

	it("flags a write through a namespaced or cast table reference", () => {
		expect(
			flags(`await db.update(schema.people).set({ email: t }).where(x);`),
		).toBe(1);
		expect(
			flags(`await db.update(people as any).set({ email: t }).where(x);`),
		).toBe(1);
	});

	it("flags raw SQL however it is written or executed", () => {
		expect(
			flags("await db.execute(sql.raw(`update people set email = null`));"),
		).toBe(1);
		expect(
			flags(
				"const s = sql`update people set email = null`;\nawait db.execute(s);",
			),
		).toBe(1);
		expect(
			flags('await db.$client.query("update public.people set email = null");'),
		).toBe(1);
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

	it("the sign-in resolver refuses on ambiguity, not just on no-match", () => {
		// A SOURCE assertion because no behavioural test can hold this one, and that
		// was established by mutation rather than assumed: changing
		// `candidates.length !== 1` to `=== 0` leaves the whole suite green, because
		// arm 3 of the bind's WHERE independently refuses when two Persons carry the
		// address. Applying BOTH mutations together turns the two household tests
		// red, which is what proves the redundancy is real and symmetric.
		//
		// It is still worth gating: with the candidate count weakened, arm 3 becomes
		// the ONLY thing standing between a shared household address and one spouse
		// binding the other's Person — and a single point of failure on a takeover
		// is exactly what this file exists to prevent.
		const src = readFileSync(join(SERVER_DIR, "account-link-logic.ts"), "utf8");
		const fn =
			/export async function linkPersonToUser\(([\s\S]*?)\n}/.exec(src)?.[1] ??
			"";
		expect(fn, "linkPersonToUser is gone or renamed").not.toBe("");
		expect(
			fn,
			"the candidate count no longer refuses 2+ candidates — arm 3 of the bind " +
				"is then the only thing refusing a household takeover",
		).toMatch(/candidates\.length\s*!==\s*1/);
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

			if (waiver.requiresUnlinkedGuard) {
				// The span between `.update(people)` and the end of the statement.
				const stmt =
					/\.update\(\s*people\s*\)([\s\S]*?);/.exec(
						withoutComments(text ?? ""),
					)?.[1] ?? "";
				expect(
					stmt,
					`${key}'s people.email write must carry isNull(people.userId) in the STATEMENT — ` +
						`a check outside the transaction is a TOCTOU, and no behavioural test can reach it`,
				).toMatch(/isNull\(\s*people\.userId\s*\)/);
			}
		}
	});
});
