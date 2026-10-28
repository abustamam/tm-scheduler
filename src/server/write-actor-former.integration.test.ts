/**
 * `resolveSessionActor` refuses a FORMER member with the lapsed-member message
 * (#1343). `write-actor.integration.test.ts` reaches that message from an
 * `inactive` row; `membership_status` has a third value, and `getActiveMembership`
 * treats both non-active values as "no membership", so both need to land on the
 * same refusal rather than "not on the roster".
 *
 * protects=a session whose only membership in the club is `former` is refused
 *   with MEMBERSHIP_INACTIVE_MESSAGE, and a user with no row at all with
 *   NOT_ON_ROSTER_MESSAGE;
 * fails_when=`hasNonActiveMembership` stops matching a `former` row;
 * no_claim=the `inactive` case (write-actor.integration.test.ts).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import {
	MEMBERSHIP_INACTIVE_MESSAGE,
	NOT_ON_ROSTER_MESSAGE,
} from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => {
		throw new Error("No request context");
	},
}));

const { resolveSessionActor } = await import("./write-actor-logic");

const exactly = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

describe.skipIf(!hasTestDb)(
	"resolveSessionActor, former member (#1343)",
	() => {
		let club: SeededClub;
		let other: SeededClub;
		beforeEach(async () => {
			club = await seedClub();
			other = await seedClub();
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		});

		it("tells a FORMER member their membership lapsed", async () => {
			await testDb
				.update(members)
				.set({ status: "former" })
				.where(eq(members.id, club.memberId));
			await expect(
				resolveSessionActor({
					clubId: club.clubId,
					sessionUserId: club.memberUserId,
				}),
			).rejects.toThrow(exactly(MEMBERSHIP_INACTIVE_MESSAGE));
		});

		it("still says not-on-roster for a user with no row in the club", async () => {
			await expect(
				resolveSessionActor({
					clubId: club.clubId,
					sessionUserId: other.memberUserId,
				}),
			).rejects.toThrow(exactly(NOT_ON_ROSTER_MESSAGE));
		});
	},
);
