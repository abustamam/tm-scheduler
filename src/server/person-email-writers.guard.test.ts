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
 * Why still a SOURCE test. The failure mode is a NEW writer added later by
 * someone who never reads this file — a behavioural test proves one writer
 * behaves, only an enumeration proves none was missed. It is the same argument
 * as before; only the number changed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_DIR = join(import.meta.dirname);

/** The single sanctioned writer, and the export that does it. */
const BINDER_FILE = "account-link-logic.ts";
const BINDER_FN = "bindVerifiedPerson";

/**
 * Writers that set `people.email` outside the bind, each with the reason it is
 * allowed to. Both are SUPERADMIN-ONLY and unreachable by a club officer. Every
 * entry is a liability: adding a third needs an argument for why a typed address
 * may become a Person's identity, which is the argument #756 exists to reject.
 */
const WAIVERS: Record<string, string> = {
	// The console repair for a club's FIRST admin, before anyone has signed in —
	// the bootstrap case, where there is no verified address in existence yet.
	// It writes the membership row alongside, so the new value is what the
	// auto-link will actually match on.
	"onboarding-logic.ts": "superadmin console, first-admin bootstrap repair",
	// Merges two Person rows; only ever FILLS a null keeper address
	// (`keeper.email ?? absorbed.email`), never moves a set one, and is
	// superadmin-gated.
	"people-merge-logic.ts": "superadmin merge, fill-only on the keeper",
};

function serverSources(): string[] {
	return readdirSync(SERVER_DIR)
		.filter((f) => f.endsWith(".ts"))
		.filter((f) => !f.includes(".test.") && !f.endsWith(".d.ts"));
}

/** Every `update(people)` write site in `src`, as [setClause, whereClause]. */
function writeSites(src: string): Array<[string, string]> {
	// Scoped to the span between `.update(people)` and its `.where(` on purpose:
	// a write of the column is `email` in the SET clause. A looser span flags a
	// module that merely MATCHES on `people.email`, and reading it is not the
	// hazard — an earlier cut of this test's ancestor did exactly that.
	return [
		...src.matchAll(/\.update\(people\)([\s\S]*?)\.where\(([\s\S]{0,300})/g),
	].map(([, setClause = "", whereClause = ""]) => [setClause, whereClause]);
}

/** Write sites in `src` that set the email column. */
function emailWriteSites(src: string): Array<[string, string]> {
	return writeSites(src).filter(([setClause]) => /\bemail\b/.test(setClause));
}

/**
 * The matcher, against source it has never seen. A guard test that cannot be
 * shown to fail is a guard test nobody can trust, and this family has been
 * wrong in BOTH directions already: a file-level ancestor passed while a writer
 * sat unguarded beside a guarded sibling (#755, the #565 over-capture shape),
 * and its first run flagged the one module that merely READ the column. The
 * production files are all supposed to pass, so they cannot demonstrate either.
 */
describe("the matcher itself", () => {
	it("flags a write of the column", () => {
		const offending = `
			await db.update(people)
				.set({ email: typed })
				.where(eq(people.id, personId));
		`;
		expect(emailWriteSites(offending)).toHaveLength(1);
	});

	it("flags a write that hides the column among other fields", () => {
		const offending = `
			await tx.update(people)
				.set({ name: row.name, email: row.email, phone: row.phone })
				.where(eq(people.id, personId));
		`;
		expect(emailWriteSites(offending)).toHaveLength(1);
	});

	it("does NOT flag a module that only MATCHES on the column", () => {
		const reading = `
			await db.update(people)
				.set({ userId })
				.where(sql\`lower(\${people.email}) = lower(\${account.email})\`);
		`;
		expect(emailWriteSites(reading)).toEqual([]);
	});

	it("does NOT flag an INSERT that carries the column", () => {
		// Person CREATION still writes it — a fresh row is nobody's identity yet,
		// and `people.email` is the dedupe key ADR-0008 leans on. The rule is about
		// RE-KEYING a Person that already exists.
		const creating = `
			await tx.insert(people).values({ name, email, phone }).returning();
		`;
		expect(emailWriteSites(creating)).toEqual([]);
	});
});

describe("people.email writers (verified identity address)", () => {
	it("is written in exactly one place outside the superadmin waivers", () => {
		const offenders: string[] = [];
		for (const file of serverSources()) {
			if (WAIVERS[file] || file === BINDER_FILE) continue;
			const src = readFileSync(join(SERVER_DIR, file), "utf8");
			for (const _site of emailWriteSites(src)) {
				offenders.push(`${file} (a people.email write)`);
			}
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
		// `people.email` cannot move without the account link moving with it, so
		// every non-null value belongs to an account that proved it.
		const src = readFileSync(join(SERVER_DIR, BINDER_FILE), "utf8");
		const emailWrites = emailWriteSites(src);
		expect(emailWrites, `${BINDER_FILE} should carry exactly one`).toHaveLength(
			1,
		);
		const [[setClause = "", whereClause = ""]] = emailWrites;
		expect(
			setClause,
			"the bind no longer sets user_id alongside email",
		).toMatch(/userId:/);
		expect(
			whereClause,
			"the bind no longer refuses a Person that already holds an account",
		).toMatch(/isNull\(\s*people\.userId\s*\)/);
		expect(src, `${BINDER_FN} is gone or renamed`).toMatch(
			new RegExp(`function ${BINDER_FN}\\b`),
		);
	});

	it("names every waiver, so a silent exemption cannot accrete", () => {
		for (const [file, reason] of Object.entries(WAIVERS)) {
			expect(
				reason.length,
				`${file} has an empty waiver reason`,
			).toBeGreaterThan(10);
			expect(
				serverSources().includes(file),
				`${file} is waived but no longer exists — drop the waiver`,
			).toBe(true);
		}
	});
});
