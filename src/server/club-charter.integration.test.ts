/**
 * Club charter status (#944), DB-backed: onboarding a chartering club with or
 * without a number, the chartered-needs-a-number invariant on every write that
 * sets the status, "Mark as chartered", the charter-date edit, the superadmin
 * revert, the column default the migration backfilled existing clubs with, and
 * the two gates the server fns wrap these in.
 *
 * The server fns themselves cannot be invoked from vitest, so the gates are
 * tested two ways: the guard functions against real rows here, and their
 * wiring into each fn by `club-charter-authz.guard.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessRequestAlerts, accessRequests, clubs, user } from "#/db/schema";
import {
	CHARTER_DATE_FUTURE_MESSAGE,
	CHARTER_DATE_REQUIRED_MESSAGE,
	CLUB_NUMBER_FORMAT_MESSAGE,
	CLUB_NUMBER_REQUIRED_MESSAGE,
} from "#/lib/club-charter";
import { DEFAULT_CLUB_TIMEZONE } from "#/lib/club-timezone";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { createClubSchema, createClubWithAdmin, getClubConsoleDetail } =
	await import("./onboarding-logic");
const {
	ALREADY_CHARTERED_MESSAGE,
	NOT_CHARTERED_MESSAGE,
	getClubCharter,
	markClubChartered,
	markClubCharteredSchema,
	revertClubToChartering,
	updateCharterDateSchema,
	updateClubCharterDate,
} = await import("./club-charter-logic");
const { requireClubRole, requireSuperadmin, NO_PERMISSION_MESSAGE } =
	await import("./guards");

const createdClubs: string[] = [];
const createdUsers: string[] = [];

afterEach(async () => {
	for (const clubId of createdClubs) await cleanup(clubId, createdUsers);
	createdClubs.length = 0;
	createdUsers.length = 0;
});

/** An 8-digit club number (the shape `CLUB_NUMBER_PATTERN` allows). */
function uniqueNumber() {
	return String(Math.floor(10_000_000 + Math.random() * 89_999_999));
}

/** The server fn's composition: validator, then logic. */
async function provision(input: unknown) {
	const res = await createClubWithAdmin(createClubSchema.parse(input));
	createdClubs.push(res.clubId);
	return res;
}

/** A valid provisioning payload. A chartered club (the default status) gets a
 *  charter date, which it must state; a chartering one gets none. */
function base(over: Record<string, unknown> = {}) {
	return {
		...(over.charterStatus === "chartering"
			? {}
			: { charteredAt: "2020-01-01" }),
		clubName: `Charter Club ${randomUUID()}`,
		adminName: "Casey Admin",
		adminEmail: `casey-${randomUUID()}@example.com`,
		timezone: DEFAULT_CLUB_TIMEZONE,
		...over,
	};
}

async function clubRow(clubId: string) {
	const [row] = await testDb.select().from(clubs).where(eq(clubs.id, clubId));
	return row;
}

/** Seed a club and put it in the given charter state directly. */
async function seedCharterClub(state: {
	charterStatus: "chartering" | "chartered";
	clubNumber?: string | null;
	charteredAt?: string | null;
}) {
	const seed = await seedClub();
	createdClubs.push(seed.clubId);
	createdUsers.push(seed.adminUserId, seed.memberUserId);
	await testDb
		.update(clubs)
		.set({
			charterStatus: state.charterStatus,
			clubNumber: state.clubNumber ?? null,
			charteredAt: state.charteredAt ?? null,
		})
		.where(eq(clubs.id, seed.clubId));
	return seed;
}

describe.skipIf(!hasTestDb)("the charter columns (#944 migration)", () => {
	it("a club inserted without them comes out chartered with no date — the backfill every existing club got", async () => {
		const seed = await seedClub();
		createdClubs.push(seed.clubId);
		createdUsers.push(seed.adminUserId, seed.memberUserId);
		const row = await clubRow(seed.clubId);
		expect(row.charterStatus).toBe("chartered");
		expect(row.charteredAt).toBeNull();
	});
});

describe.skipIf(!hasTestDb)("onboarding a club with a charter status", () => {
	it("provisions a chartering club with no club number", async () => {
		const res = await provision(
			base({ charterStatus: "chartering", clubNumber: "" }),
		);
		const row = await clubRow(res.clubId);
		expect(row.charterStatus).toBe("chartering");
		expect(row.clubNumber).toBeNull();
		expect(row.charteredAt).toBeNull();

		const detail = await getClubConsoleDetail(res.clubId);
		expect(detail.charterStatus).toBe("chartering");
		expect(detail.clubNumber).toBeNull();
	});

	it("provisions two chartering clubs with no number — null never collides with null", async () => {
		const a = await provision(base({ charterStatus: "chartering" }));
		const b = await provision(base({ charterStatus: "chartering" }));
		expect((await clubRow(a.clubId)).clubNumber).toBeNull();
		expect((await clubRow(b.clubId)).clubNumber).toBeNull();
	});

	it("provisions a chartering club that already has a number", async () => {
		const number = uniqueNumber();
		const res = await provision(
			base({ charterStatus: "chartering", clubNumber: number }),
		);
		const row = await clubRow(res.clubId);
		expect(row.charterStatus).toBe("chartering");
		expect(row.clubNumber).toBe(number);
	});

	it("still checks uniqueness for a chartering club that gives a number", async () => {
		const number = uniqueNumber();
		await provision(base({ clubNumber: number }));
		const name = `Dupe Charter ${randomUUID()}`;
		await expect(
			provision(
				base({
					clubName: name,
					charterStatus: "chartering",
					clubNumber: number,
				}),
			),
		).rejects.toThrow(`A club with number ${number} already exists.`);
		const rows = await testDb.select().from(clubs).where(eq(clubs.name, name));
		expect(rows).toHaveLength(0);
	});

	it("rejects a chartered club with no number, at the schema and at the write", async () => {
		const parsed = createClubSchema.safeParse(
			base({ charterStatus: "chartered", clubNumber: "  " }),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((i) => i.message)).toContain(
			CLUB_NUMBER_REQUIRED_MESSAGE,
		);

		// A caller that skips the validator still cannot write one.
		const name = `No Number ${randomUUID()}`;
		await expect(
			createClubWithAdmin({ ...base({ clubName: name }), clubNumber: null }),
		).rejects.toThrow(CLUB_NUMBER_REQUIRED_MESSAGE);
		const rows = await testDb.select().from(clubs).where(eq(clubs.name, name));
		expect(rows).toHaveLength(0);
	});

	it("defaults an omitted status to chartered, with the date it was given", async () => {
		const number = uniqueNumber();
		const res = await provision(base({ clubNumber: number }));
		const row = await clubRow(res.clubId);
		expect(row.charterStatus).toBe("chartered");
		expect(row.clubNumber).toBe(number);
		expect(row.charteredAt).toBe("2020-01-01");
	});

	it("refuses a chartered club with no charter date, at the schema and at the write, telling a stale console to reload", async () => {
		// What a console tab from before #944 sends: no status, no date.
		const stale = {
			clubName: `Stale Tab ${randomUUID()}`,
			clubNumber: uniqueNumber(),
			adminName: "Casey Admin",
			adminEmail: `casey-${randomUUID()}@example.com`,
			timezone: DEFAULT_CLUB_TIMEZONE,
		};
		const parsed = createClubSchema.safeParse(stale);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((i) => i.message)).toContain(
			CHARTER_DATE_REQUIRED_MESSAGE,
		);
		expect(CHARTER_DATE_REQUIRED_MESSAGE).toMatch(/reload/i);

		// A caller that skips the validator still cannot write one.
		await expect(createClubWithAdmin(stale)).rejects.toThrow(
			CHARTER_DATE_REQUIRED_MESSAGE,
		);
		await expect(
			createClubWithAdmin({ ...stale, charterStatus: "chartered" }),
		).rejects.toThrow(CHARTER_DATE_REQUIRED_MESSAGE);
		const rows = await testDb
			.select()
			.from(clubs)
			.where(eq(clubs.name, stale.clubName));
		expect(rows).toHaveLength(0);
	});

	it("records a chartered club's charter date, and refuses one for a chartering club", async () => {
		const res = await provision(
			base({ clubNumber: uniqueNumber(), charteredAt: "2019-04-01" }),
		);
		expect((await clubRow(res.clubId)).charteredAt).toBe("2019-04-01");

		const parsed = createClubSchema.safeParse(
			base({ charterStatus: "chartering", charteredAt: "2019-04-01" }),
		);
		expect(parsed.success).toBe(false);
	});

	it("refuses a club number that is not 1-8 digits, whatever the status", () => {
		for (const charterStatus of ["chartered", "chartering"]) {
			for (const clubNumber of [randomUUID(), "TM-1234", "123456789"]) {
				const parsed = createClubSchema.safeParse(
					base({ charterStatus, clubNumber }),
				);
				expect(parsed.success, `${charterStatus} ${clubNumber}`).toBe(false);
				expect(parsed.error?.issues.map((i) => i.message)).toContain(
					CLUB_NUMBER_FORMAT_MESSAGE,
				);
			}
		}
	});
});

describe.skipIf(!hasTestDb)("Mark as chartered", () => {
	it("requires both a date and a number", () => {
		const clubId = randomUUID();
		const noDate = markClubCharteredSchema.safeParse({
			clubId,
			clubNumber: "123",
		});
		expect(noDate.success).toBe(false);
		const noNumber = markClubCharteredSchema.safeParse({
			clubId,
			charteredAt: "2026-09-01",
			clubNumber: "",
		});
		expect(noNumber.success).toBe(false);
		expect(noNumber.error?.issues.map((i) => i.message)).toContain(
			CLUB_NUMBER_REQUIRED_MESSAGE,
		);
		const future = markClubCharteredSchema.safeParse({
			clubId,
			charteredAt: "2999-01-01",
			clubNumber: "123",
		});
		expect(future.error?.issues.map((i) => i.message)).toContain(
			CHARTER_DATE_FUTURE_MESSAGE,
		);
		for (const clubNumber of [randomUUID(), "12a4", "123456789"]) {
			const bad = markClubCharteredSchema.safeParse({
				clubId,
				charteredAt: "2026-09-01",
				clubNumber,
			});
			expect(bad.success, clubNumber).toBe(false);
			expect(bad.error?.issues.map((i) => i.message)).toContain(
				CLUB_NUMBER_FORMAT_MESSAGE,
			);
		}
		const ok = markClubCharteredSchema.safeParse({
			clubId,
			charteredAt: "2026-09-01",
			clubNumber: " 123 ",
		});
		expect(ok.data?.clubNumber).toBe("123");
	});

	it("moves a chartering club to chartered with the date and the number it was given", async () => {
		const seed = await seedCharterClub({ charterStatus: "chartering" });
		const number = uniqueNumber();
		await markClubChartered({
			clubId: seed.clubId,
			charteredAt: "2026-09-01",
			clubNumber: number,
		});
		const row = await clubRow(seed.clubId);
		expect(row.charterStatus).toBe("chartered");
		expect(row.charteredAt).toBe("2026-09-01");
		expect(row.clubNumber).toBe(number);
	});

	it("keeps the number a chartering club already held when it is sent back", async () => {
		const number = uniqueNumber();
		const seed = await seedCharterClub({
			charterStatus: "chartering",
			clubNumber: number,
		});
		await markClubChartered({
			clubId: seed.clubId,
			charteredAt: "2026-09-01",
			clubNumber: number,
		});
		const row = await clubRow(seed.clubId);
		expect(row.charterStatus).toBe("chartered");
		expect(row.clubNumber).toBe(number);
	});

	it("refuses a number another club holds, and leaves the club chartering", async () => {
		const number = uniqueNumber();
		await seedCharterClub({ charterStatus: "chartered", clubNumber: number });
		const seed = await seedCharterClub({ charterStatus: "chartering" });
		await expect(
			markClubChartered({
				clubId: seed.clubId,
				charteredAt: "2026-09-01",
				clubNumber: number,
			}),
		).rejects.toThrow(`A club with number ${number} already exists.`);
		const row = await clubRow(seed.clubId);
		expect(row.charterStatus).toBe("chartering");
		expect(row.clubNumber).toBeNull();
	});

	it("refuses a club that is already chartered, without touching its date", async () => {
		const seed = await seedCharterClub({
			charterStatus: "chartered",
			clubNumber: uniqueNumber(),
			charteredAt: "2010-01-01",
		});
		await expect(
			markClubChartered({
				clubId: seed.clubId,
				charteredAt: "2026-09-01",
				clubNumber: uniqueNumber(),
			}),
		).rejects.toThrow(ALREADY_CHARTERED_MESSAGE);
		expect((await clubRow(seed.clubId)).charteredAt).toBe("2010-01-01");
	});

	it("refuses a missing number at the write even without the validator", async () => {
		const seed = await seedCharterClub({ charterStatus: "chartering" });
		await expect(
			markClubChartered({
				clubId: seed.clubId,
				charteredAt: "2026-09-01",
				clubNumber: null,
			}),
		).rejects.toThrow(CLUB_NUMBER_REQUIRED_MESSAGE);
		expect((await clubRow(seed.clubId)).charterStatus).toBe("chartering");
	});
});

describe.skipIf(!hasTestDb)("editing the charter date", () => {
	it("sets the date on a chartered club, including a backfilled one with none", async () => {
		const seed = await seedCharterClub({
			charterStatus: "chartered",
			clubNumber: uniqueNumber(),
		});
		await updateClubCharterDate({
			clubId: seed.clubId,
			charteredAt: "2001-05-05",
		});
		expect((await getClubCharter(seed.clubId)).charteredAt).toBe("2001-05-05");
	});

	it("refuses a chartering club, which has no charter yet", async () => {
		const seed = await seedCharterClub({ charterStatus: "chartering" });
		await expect(
			updateClubCharterDate({ clubId: seed.clubId, charteredAt: "2026-09-01" }),
		).rejects.toThrow(NOT_CHARTERED_MESSAGE);
		expect((await clubRow(seed.clubId)).charteredAt).toBeNull();
	});

	it("says not found for a club that does not exist", async () => {
		await expect(
			updateClubCharterDate({
				clubId: randomUUID(),
				charteredAt: "2026-09-01",
			}),
		).rejects.toThrow(/not found/i);
	});

	it("rejects a date that is not a calendar day", () => {
		expect(
			updateCharterDateSchema.safeParse({
				clubId: randomUUID(),
				charteredAt: "2026-02-30",
			}).success,
		).toBe(false);
	});
});

describe.skipIf(!hasTestDb)("moving back to chartering (superadmin)", () => {
	it("clears the date and keeps the number", async () => {
		const number = uniqueNumber();
		const seed = await seedCharterClub({
			charterStatus: "chartered",
			clubNumber: number,
			charteredAt: "2026-09-01",
		});
		await revertClubToChartering(seed.clubId);
		const row = await clubRow(seed.clubId);
		expect(row.charterStatus).toBe("chartering");
		expect(row.charteredAt).toBeNull();
		expect(row.clubNumber).toBe(number);
	});

	it("says not found for a club that does not exist", async () => {
		await expect(revertClubToChartering(randomUUID())).rejects.toThrow(
			/not found/i,
		);
	});
});

describe.skipIf(!hasTestDb)("the gates the charter server fns use", () => {
	async function seedUser(isSuperadmin: boolean): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Gate Test",
			email: `gate-${id}@test.example`,
			emailVerified: true,
			isSuperadmin,
		});
		createdUsers.push(id);
		return id;
	}

	it("the admin gate rejects a plain member and admits the club's admin", async () => {
		const seed = await seedCharterClub({ charterStatus: "chartering" });
		await expect(
			requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		await expect(
			requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
		).resolves.toBeTruthy();
	});

	it("the revert gate rejects the club's own admin and admits a superadmin", async () => {
		const seed = await seedCharterClub({
			charterStatus: "chartered",
			clubNumber: uniqueNumber(),
		});
		// The club's admin — who CAN mark the club chartered — cannot undo it.
		await expect(requireSuperadmin(seed.adminUserId)).rejects.toThrow(
			/permission/i,
		);
		await expect(
			requireSuperadmin(await seedUser(true)),
		).resolves.toBeUndefined();
	});
});

describe.skipIf(!hasTestDb)("an access request's charter status", () => {
	const RUN_DOMAIN = `charter-${randomUUID()}.test`;
	const SCOPE = {
		emailLike: `%@${RUN_DOMAIN}`,
		alertKey: `charter-${RUN_DOMAIN}`,
	};
	const LIMITS = { minFillMs: 0, perEmail24h: 5, global24h: 50, notify24h: 50 };

	afterEach(async () => {
		await testDb
			.delete(accessRequests)
			.where(like(accessRequests.email, SCOPE.emailLike));
		await testDb
			.delete(accessRequestAlerts)
			.where(like(accessRequestAlerts.windowKey, `${SCOPE.alertKey}:%`));
	});

	async function submit(fields: Record<string, unknown>) {
		const { accessRequestSchema } = await import("./access-requests-schemas");
		const { submitAccessRequestLogic } = await import(
			"./access-requests-logic"
		);
		const email = `founder-${randomUUID()}@${RUN_DOMAIN}`;
		const res = await submitAccessRequestLogic(
			accessRequestSchema.parse({
				name: "Forming Founder",
				email,
				fillMs: 10_000,
				trap: "",
				...fields,
			}),
			{ limits: LIMITS, scope: SCOPE },
		);
		expect(res.ok).toBe(true);
		const [row] = await testDb
			.select()
			.from(accessRequests)
			.where(eq(accessRequests.email, email));
		return row;
	}

	it("stores a chartering club's request with no number, and says so in the maintainer's email", async () => {
		const { buildAccessRequestEmail } = await import("./access-requests-logic");
		const row = await submit({
			kind: "club",
			clubName: "New Club",
			charterStatus: "chartering",
		});
		expect(row.charterStatus).toBe("chartering");
		expect(row.clubNumber).toBeNull();

		const email = buildAccessRequestEmail(row);
		expect(email.text).toContain("Charter status: Chartering");
		expect(email.text).toContain("Club number: (none)");
	});

	it("stores nothing for a request that did not say, or said something outside the vocabulary", async () => {
		const silent = await submit({ kind: "club", clubName: "C" });
		expect(silent.charterStatus).toBeNull();
		const junk = await submit({
			kind: "club",
			clubName: "C",
			charterStatus: "forming-ish",
		});
		expect(junk.charterStatus).toBeNull();
	});

	it("drops it from a district request, like every other club-only field", async () => {
		const row = await submit({
			kind: "district",
			districtNumber: "39",
			charterStatus: "chartering",
		});
		expect(row.charterStatus).toBeNull();
	});
});
