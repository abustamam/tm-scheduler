/**
 * #1512: a standard role the history import has to mint for a club that lacks
 * it takes the guide variant for the club's `geIntroducesFunctionaries` setting.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, roleDefinitions, user } from "#/db/schema";
import type { PersonResolution } from "#/lib/easy-speak-import-plan";
import { duringNotesFor, ROLE_TEMPLATE } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/lib/email", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/email")>()),
	sendEmail: vi.fn(async () => {}),
}));
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./history-import-logic");

const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");
const NO_UPCOMING = { include: false, skipRoles: [] as string[] };
const KEYS = ["toastmaster_of_the_day", "general_evaluator"];

describe.skipIf(!hasTestDb)("history import mints the GE guide (#1512)", () => {
	let seed: SeededClub;
	let superadminId: string;

	beforeEach(async () => {
		seed = await seedClub();
		superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		// The club lacks the standard rows the import will need.
		await testDb
			.delete(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, seed.clubId),
					inArray(roleDefinitions.key, KEYS),
				),
			);
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await testDb.delete(user).where(eq(user.id, superadminId));
	});

	async function importWith(geIntroduces: boolean) {
		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: geIntroduces })
			.where(eq(clubs.id, seed.clubId));
		const text = readFileSync(FIXTURE, "utf8");
		const stored = await logic.storeEasySpeakBundle({
			clubId: seed.clubId,
			uploadedByUserId: superadminId,
			text,
		});
		const preview = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			now: NOW,
			upcoming: NO_UPCOMING,
		});
		const resolutions: Record<string, PersonResolution> = {};
		for (const p of preview.people) {
			if (p.status === "unmatched") {
				resolutions[p.key] = { action: "guest", kind: "visitor" };
			}
		}
		await logic.applyEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			runner: { kind: "superadmin", userId: superadminId },
			resolutions,
			now: NOW,
			upcoming: NO_UPCOMING,
		});
		const rows = await testDb
			.select({
				key: roleDefinitions.key,
				duringNotes: roleDefinitions.duringNotes,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, seed.clubId));
		return new Map(rows.map((r) => [r.key, r.duringNotes]));
	}

	for (const on of [true, false]) {
		it(`setting ${on ? "ON" : "OFF"}: the minted Toastmaster row takes the matching variant`, async () => {
			const rows = await importWith(on);
			const tm = ROLE_TEMPLATE.find((r) => r.key === "toastmaster_of_the_day");
			if (!tm) throw new Error("no TM seed");
			expect(rows.has("toastmaster_of_the_day")).toBe(true);
			expect(rows.get("toastmaster_of_the_day")).toBe(duringNotesFor(tm, on));
			// Every other minted standard role keeps its standard text.
			for (const [key, notes] of rows) {
				const s = ROLE_TEMPLATE.find((r) => r.key === key);
				if (key === null) continue;
				if (s && !KEYS.includes(key)) expect(notes).toBe(s.duringNotes);
			}
		});
	}
});
