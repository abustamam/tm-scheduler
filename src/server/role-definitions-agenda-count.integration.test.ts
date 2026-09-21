/**
 * `listRoleDefinitions`' opt-in declaration count (#802).
 *
 * The number `/admin/roles` needs to tell a role that is off the club's
 * standard shape and UNUSED from one that is off it and carrying three nights'
 * agendas. Three things are being held here, and each has a way of failing that
 * a green page would not show:
 *
 * 1. WHAT IT COUNTS. `meeting_template_roles` has no `club_id`, and the seeded
 *    contest template is inserted with `clubId: null`, so ONE declaration row on
 *    a global or shared template is a row every club on earth shares. Counting
 *    it would report the same number to all of them regardless of what any of
 *    them has actually scheduled. Only this club's own PRIVATE per-meeting
 *    agendas count.
 * 2. THAT IT STAYS OFF. These same rows are served with no session
 *    (`getPublicClubRoles`) and to a route the router preloads on HOVER, which
 *    is why `slotCount` is opt-in in the first place. A second aggregate that
 *    was always on would quietly undo that guard.
 * 3. THAT IT DOES NOT CORRUPT `slotCount`. Both counts on one query, joined,
 *    would make each role's rows the cross product of its slots and its
 *    declarations — so a plain `count()` on either side reports the other
 *    side's cardinality back multiplied. The declaration count is a correlated
 *    subquery for exactly that reason, and the fan-out case is the assertion
 *    that would catch a later "simplification" into a third join.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/role-definitions-agenda-count.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { listRoleDefinitions } = await import("./role-definitions-logic");

const RUN = Math.random().toString(36).slice(2, 8);
const KEY = `chief_judge_${RUN}`;

let club: SeededClub;
const madeTemplates: string[] = [];

beforeEach(async () => {
	club = await seedClub();
});

afterEach(async () => {
	await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	// CLUB-LESS templates do not cascade from the club, so they leak into the
	// next run unless this loop takes them — and a global template is exactly
	// what half this suite seeds.
	for (const id of madeTemplates.splice(0)) {
		await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
	}
});

/** A non-standing bank role, the kind the count exists to describe. */
async function giveJudge(): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			key: KEY,
			name: `Chief Judge ${RUN}`,
			category: "functionary",
			defaultCount: 1,
			sortOrder: 90,
			standing: false,
		})
		.returning({ id: roleDefinitions.id });
	if (!row) throw new Error("role insert failed");
	return row.id;
}

/**
 * A template declaring `KEY`.
 *
 * `meetingId` non-null is a PRIVATE per-meeting agenda — the only kind that
 * counts. `clubId: null` is a GLOBAL template, shared by every club.
 */
async function declareOn(scope: {
	clubId: string | null;
	meetingId: string | null;
}): Promise<string> {
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: scope.clubId,
			meetingId: scope.meetingId,
			key: `tpl_${RUN}_${madeTemplates.length}`,
			name: `Tpl ${RUN} ${madeTemplates.length}`,
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	await testDb.insert(meetingTemplateRoles).values({
		templateId: t.id,
		key: KEY,
		name: `Chief Judge ${RUN}`,
		category: "functionary",
		defaultCount: 1,
		sortOrder: 0,
		isSpeakerRole: false,
	});
	return t.id;
}

/** A second meeting of this club, so a second private agenda has a host. */
async function giveMeeting(): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: new Date("2026-11-11T00:00:00.000Z"),
			lengthMinutes: 90,
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("meeting insert failed");
	return m.id;
}

async function judgeRow(opts?: Parameters<typeof listRoleDefinitions>[1]) {
	const rows = await listRoleDefinitions(club.clubId, opts);
	const row = rows.find((r) => r.name === `Chief Judge ${RUN}`);
	if (!row) throw new Error("the seeded role was not listed");
	return row;
}

describe.skipIf(!hasTestDb)("listRoleDefinitions agenda count", () => {
	it("counts this club's own private per-meeting agendas", async () => {
		await giveJudge();
		await declareOn({ clubId: club.clubId, meetingId: club.meetingId });
		await declareOn({ clubId: club.clubId, meetingId: await giveMeeting() });

		expect((await judgeRow({ withAgendaCounts: true })).agendaCount).toBe(2);
	});

	it("reports 0 for a role no agenda declares", async () => {
		await giveJudge();

		expect((await judgeRow({ withAgendaCounts: true })).agendaCount).toBe(0);
	});

	// A global template's declaration row is ONE row for every club that has
	// ever materialized it. Counting it would tell each of them the same number
	// about a night none of them has scheduled.
	it("EXCLUDES a global template's declaration", async () => {
		await giveJudge();
		await declareOn({ clubId: null, meetingId: null });

		expect((await judgeRow({ withAgendaCounts: true })).agendaCount).toBe(0);
	});

	// A club-scoped template with `meeting_id` NULL is a SHAPE the club can
	// pick, not a night it has scheduled — so it is not an agenda declaring the
	// role either.
	it("EXCLUDES a shared club template's declaration", async () => {
		await giveJudge();
		await declareOn({ clubId: club.clubId, meetingId: null });

		expect((await judgeRow({ withAgendaCounts: true })).agendaCount).toBe(0);
	});

	it("does not count ANOTHER club's private agenda declaring the same key", async () => {
		await giveJudge();
		const other = await seedClub();
		try {
			const [t] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: other.clubId,
					meetingId: other.meetingId,
					key: `foreign_${RUN}`,
					name: `Foreign ${RUN}`,
				})
				.returning({ id: meetingTemplates.id });
			if (!t) throw new Error("template insert failed");
			await testDb.insert(meetingTemplateRoles).values({
				templateId: t.id,
				key: KEY,
				name: `Chief Judge ${RUN}`,
				category: "functionary",
				defaultCount: 1,
				sortOrder: 0,
				isSpeakerRole: false,
			});

			expect((await judgeRow({ withAgendaCounts: true })).agendaCount).toBe(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("is ABSENT from the row when the flag is not passed", async () => {
		await giveJudge();
		await declareOn({ clubId: club.clubId, meetingId: club.meetingId });

		// The three no-flag shapes every other caller uses. `getPublicClubRoles`
		// and the meeting page's "+ Add role" picker are reachable without a
		// session and preloaded on hover; `undefined` here is what says the
		// column was never selected, so neither the subquery nor a join ran.
		expect((await judgeRow()).agendaCount).toBeUndefined();
		expect((await judgeRow({ onlyEnabled: true })).agendaCount).toBeUndefined();
		expect(
			(await judgeRow({ withSlotCounts: true })).agendaCount,
		).toBeUndefined();
	});

	it("leaves slotCount absent too when only the agenda count is asked for", async () => {
		await giveJudge();
		await declareOn({ clubId: club.clubId, meetingId: club.meetingId });

		const row = await judgeRow({ withAgendaCounts: true });
		expect(row.agendaCount).toBe(1);
		expect(row.slotCount).toBeUndefined();
	});

	// The fan-out. Three slots and two declarations on one role: joined, the
	// role's rows would be the 3x2 cross product, and BOTH counts would read 6.
	// This is the assertion that fails if the subquery is ever "simplified" into
	// a third leftJoin — and note it fails in the direction that looks
	// plausible, since 6 is a number, not an error.
	it("reports both counts truthfully when a role has several of each", async () => {
		const judgeId = await giveJudge();
		await declareOn({ clubId: club.clubId, meetingId: club.meetingId });
		await declareOn({ clubId: club.clubId, meetingId: await giveMeeting() });
		await testDb.insert(roleSlots).values(
			[0, 1, 2].map((slotIndex) => ({
				meetingId: club.meetingId,
				roleDefinitionId: judgeId,
				slotIndex,
			})),
		);

		const row = await judgeRow({
			withSlotCounts: true,
			withAgendaCounts: true,
		});
		expect(row.slotCount).toBe(3);
		expect(row.agendaCount).toBe(2);
	});

	// `role_definitions.key` is nullable for a row minted before #801 wrote
	// keys, and `meeting_template_roles.key` is NOT NULL — so no agenda can
	// declare such a role, and `= NULL` yielding NULL gives the right answer
	// rather than an error or a count of every declaration in the table.
	it("reports 0 for a keyless bank row instead of matching everything", async () => {
		await giveJudge();
		await declareOn({ clubId: club.clubId, meetingId: club.meetingId });
		await testDb
			.update(roleDefinitions)
			.set({ key: null, name: `Keyless ${RUN}` })
			.where(eq(roleDefinitions.id, club.roleDefinitionId));

		const rows = await listRoleDefinitions(club.clubId, {
			withAgendaCounts: true,
		});
		const keyless = rows.find((r) => r.name === `Keyless ${RUN}`);
		expect(keyless?.agendaCount).toBe(0);
	});
});
