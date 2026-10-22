/**
 * #1281 AC1, the `/me` half: a plain member can mint a `tmk_` token.
 *
 * Runs the REAL `generateApiToken` handler through a minimal `createServerFn`
 * adapter, with only `requireUser` stubbed.
 *
 * Card: protects=an active member of an open club with no admin role and no
 * officer term can create a token, and a user whose only club is archived
 * cannot; fails_when=minting is gated on admin or officer standing again, or an
 * archived-only member is handed a credential; no_claim=what the token may then
 * do is the audience suite's job (`mcp-member-audience.integration.test.ts`),
 * and the `/me` UI is not rendered here.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiTokens, clubs } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("@tanstack/react-start", () => {
	const wrap = (handle: (input: { data: unknown }) => unknown) =>
		((input?: { data: unknown }) => handle({ data: input?.data })) as never;
	return {
		createServerFn: () => ({
			handler: wrap,
			validator: (parse: (input: unknown) => unknown) => ({
				handler:
					(handle: (input: { data: unknown }) => unknown) =>
					({ data }: { data: unknown }) =>
						handle({ data: parse(data) }),
			}),
		}),
	};
});

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { currentUser } = vi.hoisted(() => ({ currentUser: { id: "" } }));
vi.mock("./guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("./guards")>()),
	requireUser: vi.fn(async () => ({ id: currentUser.id })),
}));

const { generateApiToken } = await import("./api-tokens");

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await testDb.delete(apiTokens).where(eq(apiTokens.userId, s.memberUserId));
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

describe.skipIf(!hasTestDb)(
	"generateApiToken for a plain member (#1281)",
	() => {
		it("mints a tmk_ token for a member with no admin role and no officer term", async () => {
			const s = await seedClub();
			seeded.push(s);
			currentUser.id = s.memberUserId;
			const created = await (
				generateApiToken as unknown as (a: {
					data: { name?: string };
				}) => Promise<{ token: string }>
			)({ data: { name: "plain member" } });
			expect(created.token.startsWith("tmk_")).toBe(true);
			const rows = await testDb
				.select({ id: apiTokens.id })
				.from(apiTokens)
				.where(eq(apiTokens.userId, s.memberUserId));
			expect(rows).toHaveLength(1);
		});

		it("refuses a member whose only club is archived, and stores nothing", async () => {
			const s = await seedClub();
			seeded.push(s);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));
			currentUser.id = s.memberUserId;
			await expect(
				(
					generateApiToken as unknown as (a: {
						data: { name?: string };
					}) => Promise<unknown>
				)({ data: {} }),
			).rejects.toThrow(
				"Only active members of a club can create an access token.",
			);
			const rows = await testDb
				.select({ id: apiTokens.id })
				.from(apiTokens)
				.where(eq(apiTokens.userId, s.memberUserId));
			expect(rows).toHaveLength(0);
		});
	},
);
