import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Guard against re-introducing the forgeable audit trail of #396.
 *
 * Several officer-only server fns used to take `actorMemberId` off the client
 * payload and validate it only as a uuid. `requireClubRole` gated *who may act
 * on which club*; nothing gated *who the resulting `activity_log` row credits* —
 * so an admin of club A could post a row into club A's feed attributed to a
 * member of club B, and the (then-unscoped) feed rendered that person's name.
 *
 * The pattern kept propagating by copy: the guest work in #390 inherited it from
 * `convertGuestToMember`, which inherited it from `assignGuestSlot`. A source
 * guard is the right shape here for the same reason as
 * `outreach-authz.guard.test.ts`: a `createServerFn` handler can't be invoked
 * outside a request context in vitest, so no behavioural test can see the
 * wrapper, which is exactly where the mistake lives.
 *
 * Two rules, both cheap to satisfy:
 *
 *  1. A server fn's validated payload may not carry an actor. Derive it from the
 *     session — `requireClubRole` already returns the membership (see
 *     `outreach.ts`), and `requireMeetingAgendaEditor` returns `actorMemberId`
 *     for the ADR-0010 self-assert path.
 *  2. Where the payload legitimately does carry one — the PUBLIC, no-auth
 *     sign-up surfaces, where an anonymous visitor's name-pick is the whole
 *     design — it may only be read as an *assertion* handed to
 *     `write-actor-logic`, which club-scopes it and lets a real membership win.
 *
 * ## What this guard catches, and what it does not
 *
 * It is a source-text guard, and its job is narrow and real: **stop the known
 * shape from propagating by copy-paste**, which is exactly how the bug spread.
 * Both rules key on the field being *named* `actorMemberId`, so they see the
 * copied schema field whatever validator it uses, the spread that carried it
 * onward (`applyMemberEdit({ ...data })` — literally how `members.ts` propagated
 * it), and the destructured read.
 *
 * They do NOT see a renamed or restructured actor: `actorId: z.string().uuid()`
 * later assigned to `actorMemberId`, or `actor: z.object({ memberId: … })`.
 * Catching those needs type-aware analysis of what actually reaches
 * `logActivity`, which a regex cannot win — and a guard that pretends otherwise
 * is worse than one with a stated limit. The real control on a genuinely new
 * no-auth write endpoint is human review of `PUBLIC_ACTOR_MODULES` below; the
 * size assertion at the bottom of this file makes widening that allowlist show
 * up in the diff instead of landing as a silently-green one-line edit.
 *
 * ## Comment-blind source
 *
 * Every read goes through `#/test/guard-source`, which blanks comments. The
 * driving reason is the "public no-auth write paths" test at the bottom: it is a
 * "must BE present" assertion (`from "./write-actor-logic"`), the shape a
 * comment satisfies for free, and these modules discuss their own actor
 * resolution in prose. It also makes the two offender sweeps more accurate in
 * both directions — a commented-out `actorMemberId:` is not a declaration, a
 * commented-out `claimedActorMemberId: data.actorMemberId` is not a resolution
 * to be counted, and a `}` inside a comment can no longer end a `z.object({ … })`
 * span early and hide the fields after it.
 */
const serverDir = dirname(fileURLToPath(import.meta.url));

/**
 * Modules whose server fns are genuinely PUBLIC (no session to derive from), so
 * their payload may assert an actor. Adding to this list means adding a no-auth
 * write endpoint — think hard before you do, and see the size assertion at the
 * bottom of this file.
 */
const PUBLIC_ACTOR_MODULES = new Set(["slots.ts", "availability.ts"]);

/** Not an actor at all — a READ filter on the activity feed ("show me rows by
 *  this member"), already ANDed with the feed's own club. */
const ACTOR_FILTER_MODULES = new Set(["activity-feed-logic.ts"]);

/** The one sanctioned way to read a client-asserted actor. */
const SANCTIONED_READ = /claimedActorMemberId:\s*data\.actorMemberId/g;

/** `const { …, actorMemberId, … } = data` — the destructured read of the same
 *  client assertion, which searching for `data.actorMemberId` alone would miss. */
const DESTRUCTURED_READ =
	/(?:const|let|var)\s*\{[^{}]*\bactorMemberId\b[^{}]*\}\s*=\s*data\b/g;

/**
 * Every `*.ts` under `src/server/`, recursively — a future
 * `src/server/<subdir>/x.ts` must be scanned too, and the old non-recursive
 * `readdirSync` would never have seen it. Paths come back relative to
 * `serverDir` with `/` separators, so the allowlists above stay readable.
 */
function serverModules(dir: string = serverDir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...serverModules(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(relative(serverDir, full).split(sep).join("/"));
		}
	}
	return out.sort();
}

/**
 * The `[start, end]` spans of every `z.object({ … })` literal in `src`, found by
 * brace-matching from each `z.object(`. Rule 1 uses these so it can flag a
 * schema-position `actorMemberId` whatever sits on the right-hand side —
 * `z.string().uuid()`, a shared `uuid` alias, any other locally-named validator
 * — instead of only the two spellings we happened to write.
 */
function zodObjectSpans(src: string): [number, number][] {
	const spans: [number, number][] = [];
	const open = /z\.object\(\s*\{/g;
	let m = open.exec(src);
	while (m) {
		let depth = 0;
		let i = m.index + m[0].length - 1; // sitting on the '{'
		for (; i < src.length; i++) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") {
				depth--;
				if (depth === 0) break;
			}
		}
		spans.push([m.index, i]);
		m = open.exec(src);
	}
	return spans;
}

/** Schema-position `actorMemberId:` declarations, as reportable snippets. */
function schemaActorFields(src: string): string[] {
	const found: string[] = [];
	for (const [start, end] of zodObjectSpans(src)) {
		const field = /\bactorMemberId\s*:[^,\n]*/g;
		let m = field.exec(src.slice(start, end));
		while (m) {
			found.push(m[0].trim());
			m = field.exec(src.slice(start, end));
		}
	}
	return found;
}

const files = serverModules();

describe("activity_log actors are derived, not client-supplied (#396)", () => {
	it("sweeps every server module, including any nested directory", () => {
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain("slots.ts");
	});

	for (const file of files) {
		const src = readSource(join(serverDir, file));

		it(`${file} does not accept an actor in a validated payload`, () => {
			if (PUBLIC_ACTOR_MODULES.has(file) || ACTOR_FILTER_MODULES.has(file)) {
				return;
			}
			const offenders = schemaActorFields(src);
			expect(
				offenders,
				`${file} declares 'actorMemberId' in a zod schema, so the client picks who the ` +
					`activity_log credits (#396). Derive the actor server-side instead: take it from ` +
					`the membership requireClubRole/requireMeetingAgendaEditor already resolved ` +
					`(see outreach.ts), and keep it off the wire:\n  ${offenders.join("\n  ")}`,
			).toEqual([]);
		});

		it(`${file} only reads a client-asserted actor through write-actor-logic`, () => {
			const stripped = src.replace(SANCTIONED_READ, "");
			const unsanctioned = [
				...stripped.split("\n").filter((l) => l.includes("data.actorMemberId")),
				...(stripped.match(DESTRUCTURED_READ) ?? []).map((m) =>
					m.replace(/\s+/g, " "),
				),
			];
			expect(
				unsanctioned,
				`${file} reads the client's actor straight off 'data' (#396). It is an ` +
					`assertion, not proof: pass it as 'claimedActorMemberId' to ` +
					`requestWriteActor, which club-scopes it and lets a real membership override ` +
					`it:\n  ${unsanctioned.join("\n  ")}`,
			).toEqual([]);
		});
	}

	it("the public no-auth write paths route their actor through the resolver", () => {
		// The inverse assertion: the modules allowed to accept an asserted actor
		// must actually be resolving it, so relaxing the resolver back into a bare
		// pass-through can't slip past rule 2 by simply deleting the read.
		for (const file of PUBLIC_ACTOR_MODULES) {
			const src = readSource(join(serverDir, file));
			expect(
				src,
				`${file} accepts an asserted actor but never resolves it`,
			).toMatch(/from "\.\/write-actor-logic"/);
			const asserted = schemaActorFields(src).length;
			const resolved = (src.match(SANCTIONED_READ) ?? []).length;
			expect(
				resolved,
				`${file} declares ${asserted} asserted actor field(s) but resolves ${resolved} — ` +
					`every server fn that accepts one must hand it to write-actor-logic`,
			).toBeGreaterThanOrEqual(asserted);
		}
	});

	it("the no-auth allowlist has not grown", () => {
		// Widening PUBLIC_ACTOR_MODULES exempts a whole module from rule 1, so it
		// must never be a silently-green one-line edit: adding an entry breaks this
		// and forces the change to be argued for in review. That review is also the
		// real control on the shapes the regexes above cannot see (see the header)
		// — a new no-auth write endpoint is the only way one of them lands.
		expect(PUBLIC_ACTOR_MODULES.size).toBe(2);
		expect([...PUBLIC_ACTOR_MODULES].sort()).toEqual([
			"availability.ts",
			"slots.ts",
		]);
	});
});
