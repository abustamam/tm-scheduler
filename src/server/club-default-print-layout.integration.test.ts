/**
 * DB-backed tests for the club's default print layout (#1069): the public
 * resolver carries it, the Agenda card's save writes it, a save that omits it
 * leaves it, and the same gate as the rest of the card decides who may change
 * it.
 *
 * `updateClubAgendaSettings` is a `createServerFn`, which vitest cannot invoke,
 * so `saveLikeTheServerFn` runs its three steps in its order: parse with the
 * schema, `requireClubRole(…, ["admin"])`, then `applyClubAgendaSettingsUpdate`.
 * That the handler really is those steps is held by
 * `club-agendas-wiring.guard.test.ts`.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyClubAgendaSettingsUpdate,
	clubAgendaSettingsSchema,
	getClubAgendaSettings,
	resolveClubByIdentifier,
} = await import("./clubs-logic");
const { requireClubRole, NO_PERMISSION_MESSAGE } = await import("./guards");

async function saveLikeTheServerFn(userId: string, input: unknown) {
	const data = clubAgendaSettingsSchema.parse(input);
	await requireClubRole(userId, data.clubId, ["admin"]);
	return applyClubAgendaSettingsUpdate(data);
}

/** What the Agenda card posts, minus whatever a test leaves out. */
function cardInput(clubId: string, extra: Record<string, unknown> = {}) {
	return {
		clubId,
		geIntroducesFunctionaries: false,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
		digitalVotingEnabled: true,
		...extra,
	};
}

async function storedLayout(clubId: string) {
	const [row] = await testDb
		.select({ layout: clubs.defaultPrintLayout })
		.from(clubs)
		.where(eq(clubs.id, clubId));
	return row?.layout;
}

describe.skipIf(!hasTestDb)("club default print layout (#1069)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("a club starts on grid, and the resolver and the settings reader both say so", async () => {
		expect(await storedLayout(seed.clubId)).toBe("grid");
		expect((await getClubAgendaSettings(seed.clubId)).defaultPrintLayout).toBe(
			"grid",
		);
		const resolved = await resolveClubByIdentifier(seed.clubId);
		expect(resolved?.defaultPrintLayout).toBe("grid");
	});

	it("the public resolver carries a changed default, which is what the print loader redirects to", async () => {
		await testDb
			.update(clubs)
			.set({ defaultPrintLayout: "timing" })
			.where(eq(clubs.id, seed.clubId));
		const resolved = await resolveClubByIdentifier(seed.clubId);
		expect(resolved?.defaultPrintLayout).toBe("timing");
	});

	it("an admin's save writes the default", async () => {
		await saveLikeTheServerFn(
			seed.adminUserId,
			cardInput(seed.clubId, { defaultPrintLayout: "spacious" }),
		);
		expect(await storedLayout(seed.clubId)).toBe("spacious");
		expect((await getClubAgendaSettings(seed.clubId)).defaultPrintLayout).toBe(
			"spacious",
		);
	});

	it("a member holding an open office may save it too", async () => {
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(),
			termEnd: null,
		});
		await saveLikeTheServerFn(
			seed.memberUserId,
			cardInput(seed.clubId, { defaultPrintLayout: "editorial" }),
		);
		expect(await storedLayout(seed.clubId)).toBe("editorial");
	});

	it("a save that omits it leaves it alone (a tab loaded before #1069)", async () => {
		await saveLikeTheServerFn(
			seed.adminUserId,
			cardInput(seed.clubId, { defaultPrintLayout: "timing" }),
		);
		await saveLikeTheServerFn(
			seed.adminUserId,
			cardInput(seed.clubId, { geIntroducesFunctionaries: true }),
		);
		expect(await storedLayout(seed.clubId)).toBe("timing");
	});

	it("a plain member is refused and nothing is written", async () => {
		await expect(
			saveLikeTheServerFn(
				seed.memberUserId,
				cardInput(seed.clubId, { defaultPrintLayout: "timing" }),
			),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(await storedLayout(seed.clubId)).toBe("grid");
	});

	it("an admin of an archived club is refused and nothing is written", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expect(
			saveLikeTheServerFn(
				seed.adminUserId,
				cardInput(seed.clubId, { defaultPrintLayout: "timing" }),
			),
		).rejects.toThrow(/archived/i);
		expect(await storedLayout(seed.clubId)).toBe("grid");
	});

	it("the schema refuses a layout that is not one of the four", () => {
		expect(
			clubAgendaSettingsSchema.safeParse(
				cardInput(seed.clubId, { defaultPrintLayout: "landscape" }),
			).success,
		).toBe(false);
	});
});
