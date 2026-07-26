import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
 *     `write-actor-logic`, which club-scopes it and lets a real session win.
 */
const serverDir = dirname(fileURLToPath(import.meta.url));

/**
 * Modules whose server fns are genuinely PUBLIC (no session to derive from), so
 * their payload may assert an actor. Adding to this list means adding a
 * no-auth write endpoint — think hard before you do.
 */
const PUBLIC_ACTOR_MODULES = new Set(["slots.ts", "availability.ts"]);

/** Not an actor at all — a READ filter on the activity feed ("show me rows by
 *  this member"), already ANDed with the feed's own club. */
const ACTOR_FILTER_MODULES = new Set(["activity-feed-logic.ts"]);

/** The one sanctioned way to read a client-asserted actor. */
const SANCTIONED_READ = /claimedActorMemberId:\s*data\.actorMemberId/g;

const files = readdirSync(serverDir).filter(
	(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

describe("activity_log actors are derived, not client-supplied (#396)", () => {
	for (const file of files) {
		const src = readFileSync(join(serverDir, file), "utf8");

		it(`${file} does not accept an actor in a validated payload`, () => {
			if (PUBLIC_ACTOR_MODULES.has(file) || ACTOR_FILTER_MODULES.has(file)) {
				return;
			}
			const offenders = src
				.split("\n")
				.filter((line) => /^\s*actorMemberId:\s*(z\.|uuid\b)/.test(line));
			expect(
				offenders,
				`${file} declares 'actorMemberId' in a zod schema, so the client picks who the ` +
					`activity_log credits (#396). Derive the actor server-side instead: take it from ` +
					`the membership requireClubRole/requireMeetingAgendaEditor already resolved ` +
					`(see outreach.ts), and keep it off the wire:\n  ${offenders.join("\n  ")}`,
			).toEqual([]);
		});

		it(`${file} only reads a client-asserted actor through write-actor-logic`, () => {
			const unsanctioned = src
				.replace(SANCTIONED_READ, "")
				.split("\n")
				.filter((line) => line.includes("data.actorMemberId"));
			expect(
				unsanctioned,
				`${file} uses the client's 'data.actorMemberId' directly (#396). It is an ` +
					`assertion, not proof: pass it as 'claimedActorMemberId' to ` +
					`requireRequestWriteActor/requestWriteActor, which club-scopes it and lets a ` +
					`real session override it:\n  ${unsanctioned.join("\n  ")}`,
			).toEqual([]);
		});
	}

	it("the public no-auth write paths route their actor through the resolver", () => {
		// The inverse assertion: the modules allowed to accept an asserted actor
		// must actually be resolving it, so relaxing the resolver back into a bare
		// pass-through can't slip past rule 2 by simply deleting the read.
		for (const file of PUBLIC_ACTOR_MODULES) {
			const src = readFileSync(join(serverDir, file), "utf8");
			expect(
				src,
				`${file} accepts an asserted actor but never resolves it`,
			).toMatch(/from "\.\/write-actor-logic"/);
			const asserted = (src.match(/^\s*actorMemberId:\s*z\./gm) ?? []).length;
			const resolved = (src.match(SANCTIONED_READ) ?? []).length;
			expect(
				resolved,
				`${file} declares ${asserted} asserted actor field(s) but resolves ${resolved} — ` +
					`every server fn that accepts one must hand it to write-actor-logic`,
			).toBeGreaterThanOrEqual(asserted);
		}
	});
});
