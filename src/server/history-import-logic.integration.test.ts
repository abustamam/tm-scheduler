/**
 * The Easy-Speak history import, end to end against the test database (#1051).
 *
 * The bundle is the extension's "B fixture" with an injected clock, so the
 * numbers are the fixture's: at 2026-10-12 one meeting is past, at 2026-10-20
 * two are. Each test is one acceptance criterion of the issue.
 *
 * Run with:
 *   bunx vitest run src/server/history-import-logic.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, count, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubImports,
	clubs,
	guests,
	importRefs,
	meetingAttendance,
	meetingAttendancePlan,
	meetingAwards,
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	members,
	officerTerms,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	speechRequests,
	tableTopicsSpeakers,
	user,
} from "#/db/schema";
import type {
	EasySpeakBundleV1,
	EasySpeakBundleV3,
} from "#/lib/easy-speak-bundle";
import {
	isBindingRefusal,
	isJsonbSafeText,
	MEETING_LEFT_ALONE,
	type PersonResolution,
	UPCOMING_INACTIVE_MEMBER,
	UPCOMING_KEPT_HOLDER,
	UPCOMING_NOT_COMING,
	UPCOMING_RELEASED,
	UPCOMING_ROLES_SKIPPED,
} from "#/lib/easy-speak-import-plan";
import { ROLE_TEMPLATE } from "#/lib/role-template";
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

// One seam to make a meeting's transaction fail AFTER it has written: the hook
// runs where the real lock is taken, at the top of each meeting's transaction.
const lockHook = vi.hoisted(() => ({
	run: null as null | ((tx: unknown, call: number) => Promise<void>),
	calls: 0,
}));
vi.mock("./club-write-lock", async (importOriginal) => {
	const real = await importOriginal<typeof import("./club-write-lock")>();
	return {
		...real,
		lockClubForWrite: async (
			tx: Parameters<typeof real.lockClubForWrite>[0],
			clubId: string,
			timeout?: string,
		) => {
			await real.lockClubForWrite(tx, clubId, timeout);
			lockHook.calls += 1;
			await lockHook.run?.(tx, lockHook.calls);
		},
	};
});

const realLogic = await import("./history-import-logic");
const { setClubDefaultTemplate } = await import("./club-agendas-logic");
/**
 * #1495 ticks "Import upcoming meetings" by default on a club's first import. The
 * tests below are about PAST meetings and predate the box, so their preview and
 * apply say "unticked" unless a test names `upcoming` itself; the #1495 tests
 * at the end of the file call `realLogic` or pass `upcoming`.
 */
const NO_UPCOMING = { include: false, skipRoles: [] as string[] };
const logic = {
	...realLogic,
	previewEasySpeakImport: (
		input: Parameters<typeof realLogic.previewEasySpeakImport>[0],
	) => realLogic.previewEasySpeakImport({ upcoming: NO_UPCOMING, ...input }),
	applyEasySpeakImport: (
		input: Parameters<typeof realLogic.applyEasySpeakImport>[0],
	) => realLogic.applyEasySpeakImport({ upcoming: NO_UPCOMING, ...input }),
};
const { NO_PERMISSION_MESSAGE } = await import("./guards");

const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");
const NOW_TWO_PAST = new Date("2026-10-20T12:00:00Z");
/** All three of the fixture's meetings are past: 644360 has plan answers, 644363 Table Topics. */
const NOW_ALL_PAST = new Date("2026-11-01T12:00:00Z");
/** The fixture's first meeting, as an instant. */
const FIRST_AT = new Date("2026-09-23T02:00:00.000Z");

/** Roster names the fixture's people are matched to; Avery Alderfinch is left off. */
const ROSTER_NAMES = [
	"Elliot Tansley",
	"Zéphyr Ashlowe",
	"Elliot Dovecott",
	"Elliot Dovecott",
	"Parker Vexford",
	"Zephyr Ironvale",
	"Jules Valewood",
	"Kai Larkspur",
	"Wren Mistlewood",
	"Umber Yarrowby",
	"Dana Vexford",
	"Casey Foxglade",
	"Blair Yarrowby",
	"Morgan Ravenscar",
	"Lane Stonebrook",
];

/** The fixture, its 2nd Speaker a guest speaker so a guest owns a speech. */
function bundleText(): string {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
	const yael = { esUserId: "900025", name: "Yael Saltmarsh" };
	const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
	const slot = past?.roles.find((r) => r.role === "2nd Speaker");
	if (!past || !slot) throw new Error("fixture changed");
	slot.holder = yael;
	past.guests.push({ who: yael, category: "guest_speaker" });
	return JSON.stringify(bundle);
}

describe.skipIf(!hasTestDb)("Easy-Speak history import (#1051)", () => {
	let seed: SeededClub;
	let superadminId: string;
	const extraUsers: string[] = [];

	beforeEach(async () => {
		lockHook.run = null;
		lockHook.calls = 0;
		seed = await seedClub();
		superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		extraUsers.push(superadminId);
		await testDb
			.update(clubs)
			.set({ timezone: "America/Los_Angeles" })
			.where(eq(clubs.id, seed.clubId));
		for (const name of ROSTER_NAMES) {
			const [person] = await testDb
				.insert(people)
				.values({ name })
				.returning({ id: people.id });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: person?.id as string,
				name,
				clubRole: "member",
				status: "active",
			});
		}
	});

	afterEach(async () => {
		lockHook.run = null;
		// Roster people are club-less: `cleanup` removes the ones the club's members
		// belonged to, after the cascade.
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await testDb.delete(user).where(inArray(user.id, extraUsers.splice(0)));
	});

	async function upload(text = bundleText()) {
		const stored = await logic.storeEasySpeakBundle({
			clubId: seed.clubId,
			uploadedByUserId: superadminId,
			text,
		});
		// The store takes the club write lock too; the hook numbers the APPLY's calls.
		lockHook.calls = 0;
		return stored;
	}

	/** Every person the plan could not place becomes a guest, and the second Dovecott stays a different person. */
	async function resolveAll(importId: string, now = NOW) {
		const preview = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId,
			now,
		});
		const dovecott = preview.roster.find((m) => m.name === "Elliot Dovecott")
			?.memberId as string;
		const resolutions: Record<string, PersonResolution> = {};
		for (const p of preview.people) {
			if (p.status === "ambiguous") {
				resolutions[p.key] = { action: "member", memberId: dovecott };
			} else if (p.status === "unmatched") {
				resolutions[p.key] = { action: "guest", kind: "visitor" };
			}
		}
		return { preview, resolutions };
	}

	async function apply(
		importId: string,
		resolutions: Record<string, PersonResolution>,
		now = NOW,
	) {
		return logic.applyEasySpeakImport({
			clubId: seed.clubId,
			importId,
			runner: { kind: "superadmin", userId: superadminId },
			resolutions,
			now,
		});
	}

	/** Row counts of everything an apply may write, scoped to this club. */
	async function counts() {
		const clubMeetings = await testDb
			.select({ id: meetings.id })
			.from(meetings)
			.where(eq(meetings.clubId, seed.clubId));
		const meetingIds = clubMeetings.map((m) => m.id);
		const inMeetings = async (table: typeof meetingAttendance) => {
			if (meetingIds.length === 0) return 0;
			const [row] = await testDb
				.select({ n: count() })
				.from(table)
				.where(inArray(table.meetingId, meetingIds));
			return Number(row?.n ?? 0);
		};
		const one = async (table: typeof guests, where: SQL | undefined) => {
			const [row] = await testDb
				.select({ n: count() })
				.from(table)
				.where(where);
			return Number(row?.n ?? 0);
		};
		const guestRows = await testDb
			.select({ personId: guests.personId })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		const memberRows = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.clubId, seed.clubId));
		const personIds = [
			...new Set([...guestRows, ...memberRows].map((r) => r.personId)),
		];
		return {
			meetings: meetingIds.length,
			roleSlots: await inMeetings(
				roleSlots as unknown as typeof meetingAttendance,
			),
			meetingAttendance: await inMeetings(meetingAttendance),
			meetingAttendancePlan: await inMeetings(
				meetingAttendancePlan as unknown as typeof meetingAttendance,
			),
			meetingAwards: await inMeetings(
				meetingAwards as unknown as typeof meetingAttendance,
			),
			tableTopicsSpeakers: await inMeetings(
				tableTopicsSpeakers as unknown as typeof meetingAttendance,
			),
			speeches: personIds.length
				? await one(
						speeches as unknown as typeof guests,
						inArray(speeches.personId, personIds),
					)
				: 0,
			guestSpeeches: await one(
				speeches as unknown as typeof guests,
				inArray(
					speeches.guestId,
					guestRows.length
						? (
								await testDb
									.select({ id: guests.id })
									.from(guests)
									.where(eq(guests.clubId, seed.clubId))
							).map((g) => g.id)
						: [randomUUID()],
				),
			),
			guests: guestRows.length,
			people: personIds.length,
			roleDefinitions: await one(
				roleDefinitions as unknown as typeof guests,
				eq(roleDefinitions.clubId, seed.clubId),
			),
			importRefs: await one(
				importRefs as unknown as typeof guests,
				eq(importRefs.clubId, seed.clubId),
			),
		};
	}

	it("refuses an upload that is not JSON, not a bundle, or too big, with a sentence", async () => {
		await expect(upload("not json")).rejects.toThrow(/not valid JSON/);
		await expect(upload("{}")).rejects.toThrow(logic.BundleRefusal);
		await expect(
			// The literal, not the constant: a test relative to the constant cannot fail.
			upload("x".repeat(50 * 1024 * 1024 + 1)),
		).rejects.toThrow(/limit is 50\.0 MB/);
		const [{ n } = { n: 0 }] = await testDb
			.select({ n: count() })
			.from(clubImports)
			.where(eq(clubImports.clubId, seed.clubId));
		expect(Number(n)).toBe(0);
	});

	it("refuses a NUL escape instead of letting the insert abort", async () => {
		const bundle = JSON.parse(bundleText()) as EasySpeakBundleV1;
		bundle.club.name = "Bad\u0000Name";
		await expect(upload(JSON.stringify(bundle))).rejects.toThrow(/NUL/);
	});

	it("stores the same bundle once per club", async () => {
		const first = await upload();
		const again = await upload();
		expect(again).toMatchObject({ importId: first.importId, reused: true });
		expect(await logic.listClubImports(seed.clubId)).toHaveLength(1);
	});

	it("a stored v1 row (no extensionVersion, inserted directly) still loads, previews and applies like the v2 upload", async () => {
		// protects=every club_imports row on prod (all v1) still opening after the v2 bump; fails_when=loadStoredBundle parses stored rows with the upload schema only, or a v1 row previews or reconciles differently; no_claim=a real prod row (the fixture reshaped to v1)
		const v2 = JSON.parse(bundleText()) as Record<string, unknown>;
		const viaUpload = await upload();
		const v1: Record<string, unknown> = { ...v2, version: 1 };
		delete v1.extensionVersion;
		const text = JSON.stringify(v1);
		const [row] = await testDb
			.insert(clubImports)
			.values({
				clubId: seed.clubId,
				source: "easy_speak",
				bundle: v1,
				bundleSha256: createHash("sha256").update(text).digest("hex"),
				uploadedByUserId: superadminId,
			})
			.returning({ id: clubImports.id });
		const v1Id = row?.id as string;
		const shape = (
			p: Awaited<ReturnType<typeof logic.previewEasySpeakImport>>,
		) => ({
			counts: p.counts,
			people: p.people.map((x) => x.key).sort(),
		});
		const fromV2 = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: viaUpload.importId,
			now: NOW,
		});
		const fromV1 = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: v1Id,
			now: NOW,
		});
		expect(shape(fromV1)).toEqual(shape(fromV2));
		const { resolutions } = await resolveAll(v1Id);
		const { report } = await apply(v1Id, resolutions);
		expect(report.reconciled).toBe(true);
	});

	it("refuses to apply while a person is unresolved, and writes nothing", async () => {
		const stored = await upload();
		const before = await counts();
		const preview = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			now: NOW,
		});
		expect(preview.canApply).toBe(false);
		// Only the name two members share: everyone else resolves by rule (#1240).
		expect(preview.unresolvedCount).toBe(1);
		await expect(apply(stored.importId, {})).rejects.toThrow(
			logic.UNRESOLVED_PEOPLE_MESSAGE(1),
		);
		expect(await counts()).toEqual(before);
	});

	it("after an apply every reconciliation count is equal", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const { report } = await apply(stored.importId, resolutions);
		expect(report.counts.length).toBeGreaterThan(0);
		for (const c of report.counts) {
			expect(c.gavelup, c.key).toBe(c.bundle);
			expect(c.missing, c.key).toEqual([]);
		}
		expect(report.meetings.failed).toEqual([]);
		expect(report.reconciled).toBe(true);
		// The numbers are the fixture's, not merely self-consistent.
		const by = Object.fromEntries(report.counts.map((c) => [c.key, c.bundle]));
		expect(by.meetings).toBe(1);
		expect(by.role_assignments).toBe(14);
		expect(by.speeches).toBe(2);
		expect(by.awards).toBe(3);
		// Stored with the row, and listed as reconciled.
		expect((await logic.listClubImports(seed.clubId))[0]?.reconciled).toBe(
			true,
		);
		const stored2 = await logic.loadImportReport({ clubId: seed.clubId });
		expect(stored2?.report.reconciled).toBe(true);
		expect(report.notImported.length).toBeGreaterThan(0);
	});

	/** Rows in the club's activity log, by action. */
	async function activityCount(action?: string) {
		const [row] = await testDb
			.select({ n: count() })
			.from(activityLog)
			.where(
				action
					? and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, action as "history_imported"),
						)
					: eq(activityLog.clubId, seed.clubId),
			);
		return Number(row?.n ?? 0);
	}

	it("applying twice adds zero data rows anywhere, and exactly one activity row per apply", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const activityBefore = await activityCount();
		const first = await apply(stored.importId, resolutions);
		// One history_imported row for the apply and one member_add per member it
		// made (#1240), and not one plan_set (or any other action) per row it wrote.
		const made = first.report.created.members;
		const madeMembers = (made?.active ?? 0) + (made?.former ?? 0);
		expect(madeMembers).toBeGreaterThan(0);
		expect(await activityCount()).toBe(activityBefore + 1 + madeMembers);
		const afterFirst = await counts();
		expect(afterFirst.meetings).toBe(2); // the seeded one and the imported one
		expect(afterFirst.roleSlots).toBeGreaterThan(0);
		const second = await apply(stored.importId, resolutions);
		expect(await counts()).toEqual(afterFirst);
		expect(await activityCount()).toBe(activityBefore + 2 + madeMembers);
		expect(await activityCount("history_imported")).toBe(2);
		expect(second.report.reconciled).toBe(true);
	});

	it("writes the plan answers that have no record, and the Table Topics speakers, of the past meetings", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId, NOW_ALL_PAST);
		const activityBefore = await activityCount();
		const before = await counts();
		const applied = await apply(stored.importId, resolutions, NOW_ALL_PAST);
		const made = applied.report.created.members;
		const madeMembers = (made?.active ?? 0) + (made?.former ?? 0);

		// Derived from the bundle's rows (a plan answer with no record, once per
		// person) and the people who resolve to MEMBERS (a guest has no plan row).
		const bundle = JSON.parse(bundleText()) as EasySpeakBundleV1;
		const decided = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			now: NOW_ALL_PAST,
			resolutions,
		});
		const memberOf = new Map(
			decided.people
				.filter((p) => p.status === "member")
				.map((p) => [p.key, p.memberId as string]),
		);
		const seen = new Set<string>();
		const expected = new Set<string>();
		for (const row of bundle.meetings.find((m) => m.esMeetingId === "644360")
			?.attendance ?? []) {
			const key = `es:${row.who.esUserId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const memberId = memberOf.get(key);
			if (row.record || !memberId) continue;
			if (row.plan === "attending") expected.add(`${memberId}:coming`);
			if (row.plan === "not_attending") expected.add(`${memberId}:not_coming`);
		}
		expect(expected.size).toBeGreaterThan(0);
		const planRows = await testDb
			.select({
				memberId: meetingAttendancePlan.memberId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.innerJoin(meetings, eq(meetings.id, meetingAttendancePlan.meetingId))
			.where(eq(meetings.clubId, seed.clubId));
		expect(new Set(planRows.map((r) => `${r.memberId}:${r.status}`))).toEqual(
			expected,
		);
		expect((await counts()).meetingAttendancePlan).toBe(
			before.meetingAttendancePlan + expected.size,
		);

		// Meeting 644363's two Table Topics speakers.
		const topics = bundle.meetings.find(
			(m) => m.esMeetingId === "644363",
		)?.tableTopics;
		expect(topics).toHaveLength(2);
		expect((await counts()).tableTopicsSpeakers).toBe(
			before.tableTopicsSpeakers + 2,
		);

		// And none of it was logged one row at a time: the apply's own row and a
		// member_add for each member it made (#1240).
		expect(await activityCount()).toBe(activityBefore + 1 + madeMembers);
	});

	it("imports only past meetings, all completed, and never a future one", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const rows = await testDb
			.select({
				at: meetings.scheduledAt,
				status: meetings.status,
				theme: meetings.theme,
			})
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, seed.clubId),
					eq(meetings.theme, "Coming of Age"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("completed");
		const all = await testDb
			.select({ at: meetings.scheduledAt, status: meetings.status })
			.from(meetings)
			.where(eq(meetings.clubId, seed.clubId));
		const imported = all.filter(
			(m) => m.at.toISOString() === "2026-09-23T02:00:00.000Z",
		);
		expect(imported).toHaveLength(1);
		expect(
			all.some((m) => m.at.toISOString() === "2026-10-14T02:00:00.000Z"),
		).toBe(false);
		expect(
			all.some((m) => m.at.toISOString() === "2026-10-28T02:00:00.000Z"),
		).toBe(false);
	});

	it("every imported meeting is completed and in the past, when all of them are", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId, NOW_ALL_PAST);
		const { report } = await apply(stored.importId, resolutions, NOW_ALL_PAST);
		expect(report.meetings.applied).toBe(3);
		const imported = await testDb
			.select({ at: meetings.scheduledAt, status: meetings.status })
			.from(importRefs)
			.innerJoin(meetings, eq(meetings.id, importRefs.targetId))
			.where(
				and(eq(importRefs.clubId, seed.clubId), eq(importRefs.kind, "meeting")),
			);
		expect(imported).toHaveLength(3);
		for (const m of imported) {
			expect(m.status).toBe("completed");
			expect(m.at.getTime()).toBeLessThan(NOW_ALL_PAST.getTime());
		}
	});

	it("links each evaluator slot to the speaker slot it evaluates", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const refs = await testDb
			.select({ sourceId: importRefs.sourceId, targetId: importRefs.targetId })
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, "role_assignment"),
				),
			);
		const slotOf = (sourceId: string) =>
			refs.find((r) => r.sourceId === sourceId)?.targetId as string;
		const evaluator = async (sourceId: string) => {
			const [row] = await testDb
				.select({ evaluates: roleSlots.evaluatesSlotId })
				.from(roleSlots)
				.where(eq(roleSlots.id, slotOf(sourceId)));
			return row?.evaluates;
		};
		expect(await evaluator("644304:13")).toBe(slotOf("644304:3"));
		expect(await evaluator("644304:14")).toBe(slotOf("644304:4"));
	});

	it("gives a guest speaker's speech a guest_id and no person_id, and a member's the reverse", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const rows = await testDb
			.select({
				title: speeches.title,
				personId: speeches.personId,
				guestId: speeches.guestId,
			})
			.from(speeches)
			.where(
				inArray(speeches.title, [
					"Make Your Impact",
					"The Career I Never Expected",
				]),
			);
		const mine = rows.filter((r) => r.guestId !== null || r.personId !== null);
		const guestSpeech = mine.find(
			(r) => r.title === "The Career I Never Expected",
		);
		const memberSpeech = mine.find((r) => r.title === "Make Your Impact");
		expect(guestSpeech?.guestId).not.toBeNull();
		expect(guestSpeech?.personId).toBeNull();
		expect(memberSpeech?.personId).not.toBeNull();
		expect(memberSpeech?.guestId).toBeNull();
		// The guest owns the speech on a slot assigned to that very guest.
		const [slot] = await testDb
			.select({
				guestId: roleSlots.assignedGuestId,
				memberId: roleSlots.assignedMemberId,
			})
			.from(roleSlots)
			.innerJoin(speeches, eq(roleSlots.speechId, speeches.id))
			.where(eq(speeches.guestId, guestSpeech?.guestId as string));
		expect(slot?.guestId).toBe(guestSpeech?.guestId);
		expect(slot?.memberId).toBeNull();
	});

	it("imports guests at stage lost, and no person is left a duplicate of a member", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const rows = await testDb
			.select({ stage: guests.stage })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((g) => g.stage === "lost")).toBe(true);
	});

	it("records who introduced a visitor, as a member of THIS club", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const rows = await testDb
			.select({
				name: guests.name,
				introducer: guests.introducedByMemberId,
			})
			.from(guests)
			.where(
				and(
					eq(guests.clubId, seed.clubId),
					eq(guests.name, "Elliot Lindenhurst"),
				),
			);
		expect(rows).toHaveLength(1);
		const [introducer] = await testDb
			.select({ clubId: members.clubId, name: members.name })
			.from(members)
			.where(eq(members.id, rows[0]?.introducer as string));
		expect(introducer).toEqual({
			clubId: seed.clubId,
			name: "Elliot Dovecott",
		});
	});

	it("logs history_imported against the club, attributed to the superadmin", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const [row] = await testDb
			.select({
				action: activityLog.action,
				impersonatedBy: activityLog.impersonatedBy,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "history_imported"),
				),
			);
		expect(row?.impersonatedBy).toBe(superadminId);
	});

	it("a meeting whose apply throws leaves no rows for it, is in the report, and its neighbour still lands", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId, NOW_TWO_PAST);
		// Call 1 is the setup transaction, 2 the first meeting, 3 the second. Fail
		// the second AFTER it has begun writing: a check no new role slot can pass.
		lockHook.run = async (tx, call) => {
			if (call !== 3) return;
			await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
				(await import("drizzle-orm")).sql.raw(
					"ALTER TABLE role_slots ADD CONSTRAINT zz_import_test_fail CHECK (false) NOT VALID",
				),
			);
		};
		const { report } = await apply(stored.importId, resolutions, NOW_TWO_PAST);
		lockHook.run = null;
		expect(report.meetings.failed.map((f) => f.esMeetingId)).toEqual([
			"644360",
		]);
		expect(report.reconciled).toBe(false);
		const rows = await testDb
			.select({ at: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.clubId, seed.clubId));
		const instants = rows.map((r) => r.at.toISOString());
		expect(instants).toContain("2026-09-23T02:00:00.000Z");
		expect(instants).not.toContain("2026-10-14T02:00:00.000Z");
		const refs = await testDb
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.where(
				and(eq(importRefs.clubId, seed.clubId), eq(importRefs.kind, "meeting")),
			);
		expect(refs.map((r) => r.sourceId)).toEqual(["644304"]);
		// The report says which count lost the failed meeting's records.
		const meetingsCount = report.counts.find((c) => c.key === "meetings");
		expect(meetingsCount?.missing).toEqual(["644360"]);
	});

	it.each([
		["completed", true],
		["cancelled", false],
	] as const)("a %s meeting made at the bundle's instant while the apply was running is not duplicated (%s adopted)", async (status, adopted) => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		// Call 2 is the first meeting's transaction, right after it took the club
		// write lock: a person's meeting lands in the window the plan could not see.
		let raced = "";
		lockHook.run = async (tx, call) => {
			if (call !== 2) return;
			const [row] = await (tx as typeof testDb)
				.insert(meetings)
				.values({ clubId: seed.clubId, scheduledAt: FIRST_AT, status })
				.returning({ id: meetings.id });
			raced = row?.id as string;
		};
		const { report } = await apply(stored.importId, resolutions);
		lockHook.run = null;
		const rows = await testDb
			.select({ id: meetings.id, status: meetings.status })
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, seed.clubId),
					eq(meetings.scheduledAt, FIRST_AT),
				),
			);
		expect(rows).toEqual([{ id: raced, status }]);
		const ref = (await refsOfKind("meeting")).find(
			(r) => r.sourceId === "644304",
		);
		expect(ref?.targetId).toBe(adopted ? raced : undefined);
		if (adopted) {
			expect(report.meetings.applied).toBe(1);
		} else {
			expect(
				report.notImported.some((r) => r.what === MEETING_LEFT_ALONE),
			).toBe(true);
		}
	});

	it("a failure message carries no NUL and no SQL", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		lockHook.run = async (tx, call) => {
			if (call !== 2) return;
			await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
				(await import("drizzle-orm")).sql.raw(
					"ALTER TABLE role_slots ADD CONSTRAINT zz_import_test_fail CHECK (false) NOT VALID",
				),
			);
		};
		const { report } = await apply(stored.importId, resolutions);
		lockHook.run = null;
		const message = report.meetings.failed[0]?.message ?? "";
		expect(message).not.toContain("\u0000");
		expect(message).not.toMatch(/insert into/i);
		expect(await counts()).toMatchObject({ meetings: 1 });
	});

	it("validatedIntroducerId accepts this club's member and refuses another club's", async () => {
		const other = await seedClub();
		try {
			await expect(
				testDb.transaction((tx) =>
					logic.validatedIntroducerId(tx, seed.clubId, seed.memberId),
				),
			).resolves.toBe(seed.memberId);
			await expect(
				testDb.transaction((tx) =>
					logic.validatedIntroducerId(tx, seed.clubId, other.memberId),
				),
			).rejects.toThrow(logic.INTRODUCER_NOT_IN_CLUB_MESSAGE);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("a resolution naming another club's member leaves the person unresolved", async () => {
		const other = await seedClub();
		try {
			const stored = await upload();
			const { resolutions } = await resolveAll(stored.importId);
			const unresolved = Object.entries(resolutions).find(
				([, r]) => r.action === "member",
			)?.[0] as string;
			const preview = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				now: NOW,
				resolutions: {
					...resolutions,
					[unresolved]: { action: "member", memberId: other.memberId },
				},
			});
			const person = preview.people.find((p) => p.key === unresolved);
			expect(person?.status).toBe("ambiguous");
			expect(person?.rejectedChoice).toBe(other.memberId);
			expect(preview.canApply).toBe(false);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("loadImportReport never returns another club's report", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const other = await seedClub();
		try {
			expect(
				await logic.loadImportReport({
					clubId: other.clubId,
					importId: stored.importId,
				}),
			).toBeNull();
			expect(await logic.loadImportReport({ clubId: other.clubId })).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("refuses an archived club", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expect(apply(stored.importId, resolutions)).rejects.toThrow(
			/archived/i,
		);
		expect(
			await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(and(eq(meetings.clubId, seed.clubId), isNull(meetings.theme))),
		).toHaveLength(1);
	});

	it("refuses to store an upload for an archived club", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expect(upload()).rejects.toThrow(/archived/i);
		expect(
			await testDb
				.select({ id: clubImports.id })
				.from(clubImports)
				.where(eq(clubImports.clubId, seed.clubId)),
		).toHaveLength(0);
	});

	/** Archive the club inside the transaction a lock call opens, the way a concurrent superadmin would. */
	const archiveOnLockCall = (target: (call: number) => boolean) => {
		lockHook.run = async (tx, call) => {
			if (!target(call)) return;
			await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
				sql.raw(
					`update clubs set archived_at = now() where id = '${seed.clubId}'`,
				),
			);
		};
	};

	it("a club archived after the up-front check stops the setup transaction, and nothing is written", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const before = await counts();
		archiveOnLockCall((call) => call === 1);
		await expect(apply(stored.importId, resolutions)).rejects.toThrow(
			/archived/i,
		);
		lockHook.run = null;
		expect(await counts()).toEqual(before);
	});

	it("a club archived between two meetings stops every later meeting, which land in the report as failed", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId, NOW_TWO_PAST);
		const before = await counts();
		// Call 1 is the setup transaction; archive from the first meeting's on.
		archiveOnLockCall((call) => call >= 2);
		const { report } = await apply(stored.importId, resolutions, NOW_TWO_PAST);
		lockHook.run = null;
		expect(report.meetings.applied).toBe(0);
		expect(report.meetings.failed).toHaveLength(2);
		for (const f of report.meetings.failed) {
			expect(f.message).toMatch(/archived/i);
		}
		expect((await counts()).meetings).toBe(before.meetings);
		expect((await counts()).roleSlots).toBe(before.roleSlots);
	});

	it("the archive gate holds a share lock: an archive from another connection waits for the open transaction (#1206)", async () => {
		await testDb.transaction(async (tx) => {
			await logic.assertClubNotArchivedTx(tx, seed.clubId);
			// A second connection, outside `tx`: its UPDATE must block on the
			// gate's row lock, not slip in and commit.
			const err = await testDb
				.transaction(async (other) => {
					await other.execute(sql.raw("set local lock_timeout = '300ms'"));
					await other.execute(
						sql.raw(
							`update clubs set archived_at = now() where id = '${seed.clubId}'`,
						),
					);
				})
				.then(
					() => null,
					(e: unknown) => e as { code?: string; cause?: { code?: string } },
				);
			// 55P03 = lock_not_available: it was the row lock, not some other failure.
			expect(err?.cause?.code ?? err?.code).toBe("55P03");
		});
		const [row] = await testDb
			.select({ archivedAt: clubs.archivedAt })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		expect(row?.archivedAt).toBeNull();
	});

	// -- D1: an existing meeting at the same instant (#1196 review) ----------------

	async function seedMeetingAt(
		at: Date,
		status: "scheduled" | "cancelled" | "completed",
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({ clubId: seed.clubId, scheduledAt: at, status })
			.returning({ id: meetings.id });
		return row?.id as string;
	}

	async function meetingRow(id: string) {
		const [row] = await testDb
			.select({
				status: meetings.status,
				at: meetings.scheduledAt,
				theme: meetings.theme,
			})
			.from(meetings)
			.where(eq(meetings.id, id));
		return row;
	}

	async function slotsOf(meetingId: string) {
		const rows = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, meetingId));
		return rows.length;
	}

	async function refsOfKind(kind: string) {
		return testDb
			.select({ sourceId: importRefs.sourceId, targetId: importRefs.targetId })
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, kind as "meeting"),
				),
			);
	}

	it("adopts an existing COMPLETED meeting at the same instant, fills its blanks and keeps its status", async () => {
		const existing = await seedMeetingAt(FIRST_AT, "completed");
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const { report } = await apply(stored.importId, resolutions);
		expect(await meetingRow(existing)).toMatchObject({
			status: "completed",
			theme: "Coming of Age",
		});
		expect((await refsOfKind("meeting")).map((r) => r.targetId)).toEqual([
			existing,
		]);
		expect(await slotsOf(existing)).toBe(14);
		expect(report.reconciled).toBe(true);
		expect(report.meetings.applied).toBe(1);
	});

	it.each([
		"cancelled",
		"scheduled",
	] as const)("leaves a %s meeting at the same instant exactly as it is and lists it as not imported", async (status) => {
		const existing = await seedMeetingAt(FIRST_AT, status);
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const before = await counts();
		const { report } = await apply(stored.importId, resolutions);
		expect(await meetingRow(existing)).toMatchObject({
			status,
			theme: null,
		});
		expect(await slotsOf(existing)).toBe(0);
		expect(await refsOfKind("meeting")).toEqual([]);
		const after = await counts();
		expect(after.meetings).toBe(before.meetings);
		expect(after.meetingAttendance).toBe(before.meetingAttendance);
		expect(after.meetingAwards).toBe(before.meetingAwards);
		expect(after.roleSlots).toBe(before.roleSlots);
		const row = report.notImported.find((r) =>
			r.what.startsWith("Meetings left as they are"),
		);
		expect(row).toMatchObject({ count: 1, sourceIds: ["644304"] });
		expect(row?.reason).toContain(status);
		expect(report.meetings.applied).toBe(0);
		// What was left alone is not counted as a difference.
		expect(report.counts.find((c) => c.key === "meetings")).toMatchObject({
			bundle: 0,
			missing: [],
		});
	});

	it("a meeting that was rescheduled into the future after the import is skipped on a re-run, untouched", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const [{ targetId = "" } = {}] = await refsOfKind("meeting");
		const later = new Date("2026-12-01T02:00:00.000Z");
		await testDb
			.update(meetings)
			.set({ scheduledAt: later, status: "scheduled" })
			.where(eq(meetings.id, targetId));
		const before = await counts();
		const { report } = await apply(stored.importId, resolutions);
		expect(await meetingRow(targetId)).toMatchObject({
			status: "scheduled",
			at: later,
		});
		expect(await counts()).toEqual(before);
		expect(
			report.notImported.find((r) => r.what.startsWith("Meetings left")),
		).toMatchObject({ count: 1, sourceIds: ["644304"] });
	});

	it("a meeting cancelled between the plan and the lock is not completed by the apply", async () => {
		const existing = await seedMeetingAt(FIRST_AT, "completed");
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		// Call 1 is the setup transaction, 2 the meeting's: flip it under the lock's feet.
		lockHook.run = async (tx, call) => {
			if (call !== 2) return;
			await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
				(await import("drizzle-orm")).sql.raw(
					`update meetings set status = 'cancelled' where id = '${existing}'`,
				),
			);
		};
		const { report } = await apply(stored.importId, resolutions);
		lockHook.run = null;
		expect(await meetingRow(existing)).toMatchObject({ status: "cancelled" });
		expect(await slotsOf(existing)).toBe(0);
		expect(await refsOfKind("meeting")).toEqual([]);
		expect(report.meetings.applied).toBe(0);
		expect(
			report.notImported.find((r) => r.what.startsWith("Meetings left")),
		).toMatchObject({ count: 1, sourceIds: ["644304"] });
	});

	// -- Role definitions seeded for history are not standing roles ---------------

	it("every role definition the import creates is not a standing role, standard or club-own", async () => {
		const stored = await upload();
		const { preview, resolutions } = await resolveAll(stored.importId);
		const created = preview.roleDefinitions.filter((d) => d.isNew);
		expect(created.some((d) => d.standardKey)).toBe(true);
		expect(created.some((d) => !d.standardKey)).toBe(true);
		const seeded = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, seed.clubId));
		await apply(stored.importId, resolutions);
		const rows = await testDb
			.select({
				id: roleDefinitions.id,
				name: roleDefinitions.name,
				standing: roleDefinitions.standing,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, seed.clubId));
		const imported = rows.filter((r) => !seeded.some((x) => x.id === r.id));
		expect(imported.length).toBe(created.length);
		expect(imported.filter((r) => r.standing)).toEqual([]);
	});

	it("a standard role minted by someone else between the plan and the lock is reused, not a failed setup", async () => {
		const stored = await upload();
		const { preview, resolutions } = await resolveAll(stored.importId);
		const std = preview.roleDefinitions.find((d) => d.isNew && d.standardKey);
		const key = std?.standardKey as string;
		let rival = "";
		lockHook.run = async (_tx, call) => {
			if (call !== 1) return;
			const [row] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Rival",
					category: "functionary",
					key,
				})
				.returning({ id: roleDefinitions.id });
			rival = row?.id as string;
		};
		const { report } = await apply(stored.importId, resolutions);
		lockHook.run = null;
		expect(report.meetings.failed).toEqual([]);
		const rows = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, seed.clubId),
					eq(roleDefinitions.key, key),
				),
			);
		expect(rows.map((r) => r.id)).toEqual([rival]);
		expect(report.created.roleDefinitions).not.toContain(std?.name);
		expect(report.reconciled).toBe(true);
	});

	it("never overwrites a role slot someone claimed after the importer read it", async () => {
		const existing = await seedMeetingAt(FIRST_AT, "completed");
		const stored = await upload();
		const { preview, resolutions } = await resolveAll(stored.importId);
		const keyOf = (label: string) =>
			preview.roleDefinitions.find((d) => d.labels.includes(label))
				?.standardKey as string;
		const slotIds: Record<string, string> = {};
		for (const label of ["Toastmaster", "1st Speaker"]) {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: label,
					category: "functionary",
					key: keyOf(label),
				})
				.returning({ id: roleDefinitions.id });
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: existing,
					roleDefinitionId: def?.id as string,
					slotIndex: 0,
					status: "open",
				})
				.returning({ id: roleSlots.id });
			slotIds[label] = slot?.id as string;
		}
		// Inside the importer's own transaction, as it writes the Toastmaster's ref,
		// a member claims the 1st Speaker slot it has already read as empty.
		await testDb.execute(
			sql.raw(`CREATE OR REPLACE FUNCTION zz_claim_slot() RETURNS trigger AS $$
BEGIN
  UPDATE role_slots SET assigned_member_id = '${seed.memberId}', status = 'confirmed' WHERE id = '${slotIds["1st Speaker"]}';
  RETURN NEW;
END $$ LANGUAGE plpgsql`),
		);
		await testDb.execute(
			sql.raw(`CREATE TRIGGER zz_claim_slot AFTER INSERT ON import_refs
FOR EACH ROW WHEN (NEW.kind = 'role_slot' AND NEW.source_id = '644304:1' AND NEW.club_id = '${seed.clubId}')
EXECUTE FUNCTION zz_claim_slot()`),
		);
		try {
			await apply(stored.importId, resolutions);
		} finally {
			await testDb.execute(
				sql.raw("DROP TRIGGER zz_claim_slot ON import_refs"),
			);
			await testDb.execute(sql.raw("DROP FUNCTION zz_claim_slot()"));
		}
		const [claimed] = await testDb
			.select({
				member: roleSlots.assignedMemberId,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotIds["1st Speaker"] as string));
		expect(claimed?.member).toBe(seed.memberId);
		expect(claimed?.speechId).toBeNull();
		// The Toastmaster slot the trigger did not touch took its holder.
		const [toastmaster] = await testDb
			.select({ member: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(eq(roleSlots.id, slotIds.Toastmaster as string));
		expect(toastmaster?.member).not.toBeNull();
	});

	it("reports a role slot held by someone else, and an award given to someone else, as differences", async () => {
		const existing = await seedMeetingAt(FIRST_AT, "completed");
		const stored = await upload();
		const { preview, resolutions } = await resolveAll(stored.importId);
		const key = preview.roleDefinitions.find((d) =>
			d.labels.includes("Toastmaster"),
		)?.standardKey as string;
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Toastmaster",
				category: "functionary",
				key,
			})
			.returning({ id: roleDefinitions.id });
		// Bob holds the Toastmaster slot; the bundle says Parker Vexford.
		await testDb.insert(roleSlots).values({
			meetingId: existing,
			roleDefinitionId: def?.id as string,
			slotIndex: 0,
			status: "confirmed",
			assignedMemberId: seed.memberId,
		});
		// The best-speaker award is already someone else's.
		await testDb.insert(meetingAwards).values({
			meetingId: existing,
			category: "best_speaker",
			memberId: seed.memberId,
		});
		const { report } = await apply(stored.importId, resolutions);
		const by = (k: string) => report.counts.find((c) => c.key === k);
		expect(by("role_assignments")?.missing).toEqual(["644304:1"]);
		expect(by("awards")?.missing).toEqual(["644304:best_speaker"]);
		expect(report.reconciled).toBe(false);
		// And the others, held by who the bundle says, still reconcile.
		expect(by("role_assignments")?.gavelup).toBe(13);
		expect(by("awards")?.gavelup).toBe(2);
	});

	it("an award or a role slot someone else holds gets no ref, so clearing it lets the bundle's holder in on the next run", async () => {
		const existing = await seedMeetingAt(FIRST_AT, "completed");
		const stored = await upload();
		const { preview, resolutions } = await resolveAll(stored.importId);
		const key = preview.roleDefinitions.find((d) =>
			d.labels.includes("Toastmaster"),
		)?.standardKey as string;
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Toastmaster",
				category: "functionary",
				key,
			})
			.returning({ id: roleDefinitions.id });
		const [bobsSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: existing,
				roleDefinitionId: def?.id as string,
				slotIndex: 0,
				status: "confirmed",
				assignedMemberId: seed.memberId,
			})
			.returning({ id: roleSlots.id });
		const [bobsAward] = await testDb
			.insert(meetingAwards)
			.values({
				meetingId: existing,
				category: "best_speaker",
				memberId: seed.memberId,
			})
			.returning({ id: meetingAwards.id });
		await apply(stored.importId, resolutions);
		expect((await refsOfKind("award")).map((r) => r.sourceId)).not.toContain(
			"644304:best_speaker",
		);
		expect(
			(await refsOfKind("role_slot")).map((r) => r.sourceId),
		).not.toContain("644304:1");
		// An officer clears Bob's award and seat; the next run is not "deleted since".
		await testDb
			.delete(meetingAwards)
			.where(eq(meetingAwards.id, bobsAward?.id as string));
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: null, status: "open" })
			.where(eq(roleSlots.id, bobsSlot?.id as string));
		const { report } = await apply(stored.importId, resolutions);
		expect(
			report.notImported.find((r) => r.what.startsWith("Deleted in GavelUp")),
		).toBeUndefined();
		const by = (k: string) => report.counts.find((c) => c.key === k);
		expect(by("awards")?.missing).toEqual([]);
		expect(by("role_assignments")?.missing).toEqual([]);
		expect(report.reconciled).toBe(true);
	});

	// -- Client text and jsonb --------------------------------------------------

	it("refuses a bundle with an unpaired surrogate, with a sentence", async () => {
		const bundle = JSON.parse(bundleText()) as EasySpeakBundleV1;
		bundle.club.name = "Bad\ud800Name";
		await expect(upload(JSON.stringify(bundle))).rejects.toThrow(
			/cannot be stored/,
		);
	});

	it.each([
		["a NUL in a key", { "a\u0000b": { action: "skip", reason: "x" } }],
		[
			"a lone surrogate in a key",
			{ "a\ud800b": { action: "skip", reason: "x" } },
		],
		[
			"a lone surrogate in a reason",
			{ "es:1": { action: "skip", reason: "x\ud800" } },
		],
		[
			"an overlong reason",
			{ "es:1": { action: "skip", reason: "x".repeat(501) } },
		],
	] as const)("an apply with %s is refused before it writes anything", async (_label, bad) => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const before = await counts();
		await expect(
			apply(stored.importId, {
				...resolutions,
				...(bad as Record<string, PersonResolution>),
			}),
		).rejects.toThrow();
		expect(await counts()).toEqual(before);
		const [row] = await testDb
			.select({ appliedAt: clubImports.appliedAt })
			.from(clubImports)
			.where(eq(clubImports.id, stored.importId));
		expect(row?.appliedAt).toBeNull();
	});

	it("a failure message cut through an emoji or carrying a lone surrogate is still storable", () => {
		const cut = logic.describeFailure(
			new Error(`${"x".repeat(299)}\u{1F600} tail`),
		);
		expect(isJsonbSafeText(cut)).toBe(true);
		expect(cut.length).toBeLessThanOrEqual(300);
		expect(
			isJsonbSafeText(logic.describeFailure(new Error("a\ud800b\u0000"))),
		).toBe(true);
	});

	// -- Apply is tied to its preview, and serial per club ------------------------

	it("a second apply started while one is running is refused at once, and mints nothing twice", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		let second: unknown = "never ran";
		// The first apply is inside its first meeting's transaction (it holds the
		// import lock and a pooled connection): start the second one from there.
		lockHook.run = async (_tx, call) => {
			if (call !== 1) return;
			second = await apply(stored.importId, resolutions).then(
				() => "applied",
				(err: unknown) => err,
			);
		};
		const first = await apply(stored.importId, resolutions);
		expect(first.report.reconciled).toBe(true);
		expect(second).toBeInstanceOf(Error);
		expect((second as Error).message).toBe(logic.IMPORT_RUNNING_MESSAGE);
		const rows = await testDb
			.select({ id: meetings.id })
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, seed.clubId),
					eq(meetings.scheduledAt, FIRST_AT),
				),
			);
		expect(rows).toHaveLength(1);
		const guestRows = await testDb
			.select({ name: guests.name })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(guestRows.length).toBeGreaterThan(0);
		expect(new Set(guestRows.map((g) => g.name)).size).toBe(guestRows.length);
		expect(guestRows.length).toBe((await refsOfKind("guest")).length);
		// Once the first has finished the lock is free again.
		lockHook.run = null;
		const again = await apply(stored.importId, resolutions);
		expect(again.report.reconciled).toBe(true);
	});

	it("refuses an apply whose plan has moved since the preview, and accepts one that has not", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		// The preview a superadmin confirms is the one made WITH the resolutions
		// (resolveAll's own preview ran before them, so its hash is of a plan that
		// could not apply at all).
		const preview = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			resolutions,
			now: NOW,
		});
		expect(preview.planHash).toMatch(/^[0-9a-f]{64}$/);
		// With nothing changed, a second preview names the same plan: this is the
		// hash an unchanged apply would be held to, so the refusal below is the
		// blocker's doing and nothing else's.
		const again = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			resolutions,
			now: NOW,
		});
		expect(again.planHash).toBe(preview.planHash);
		// Someone creates a cancelled meeting at the bundle's instant after the preview.
		const blocker = await seedMeetingAt(FIRST_AT, "cancelled");
		const before = await counts();
		await expect(
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				planHash: preview.planHash,
				now: NOW,
			}),
		).rejects.toThrow(logic.PLAN_CHANGED_MESSAGE);
		expect(await counts()).toEqual(before);
		// A fresh preview names the new plan, and that one applies.
		const fresh = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			resolutions,
			now: NOW,
		});
		expect(fresh.planHash).not.toBe(preview.planHash);
		const { report } = await logic.applyEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			runner: { kind: "superadmin", userId: superadminId },
			resolutions,
			planHash: fresh.planHash,
			now: NOW,
		});
		expect(report.meetings.applied).toBe(0);
		expect((await meetingRow(blocker))?.status).toBe("cancelled");
	});

	it("refuses an apply when only a created meeting's instant has moved since the preview", async () => {
		// A wall-clock start (no offset) is read in the club's zone.
		const bundle = JSON.parse(bundleText()) as EasySpeakBundleV1;
		const first = bundle.meetings.find((m) => m.esMeetingId === "644304");
		if (!first) throw new Error("fixture changed");
		first.startsAt = "2026-09-22T19:00:00";
		const stored = await upload(JSON.stringify(bundle));
		const { resolutions } = await resolveAll(stored.importId);
		const preview = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			resolutions,
			now: NOW,
		});
		// The club's timezone changes: the same meeting is created, at another instant.
		await testDb
			.update(clubs)
			.set({ timezone: "America/New_York" })
			.where(eq(clubs.id, seed.clubId));
		const before = await counts();
		await expect(
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				planHash: preview.planHash,
				now: NOW,
			}),
		).rejects.toThrow(logic.PLAN_CHANGED_MESSAGE);
		expect(await counts()).toEqual(before);
	});

	it("a plan answer a human cleared since the import does not come back on a re-run", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId, NOW_ALL_PAST);
		await apply(stored.importId, resolutions, NOW_ALL_PAST);
		const rows = () =>
			testDb
				.select({ id: meetingAttendancePlan.id })
				.from(meetingAttendancePlan)
				.innerJoin(meetings, eq(meetings.id, meetingAttendancePlan.meetingId))
				.where(eq(meetings.clubId, seed.clubId));
		const written = await rows();
		expect(written.length).toBeGreaterThan(1);
		const [cleared] = written;
		await testDb
			.delete(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.id, cleared?.id as string));
		await apply(stored.importId, resolutions, NOW_ALL_PAST);
		expect(await rows()).toHaveLength(written.length - 1);
	});

	// -- D2: a row a human deleted is never re-made (#1196 review) ----------------

	it("a guest deleted since the import is not re-created, nor is their Person, attendance or role", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const guestRefs = await refsOfKind("guest");
		expect(guestRefs.length).toBeGreaterThan(0);
		const victim = guestRefs.find((r) => r.sourceId === "es:900025");
		expect(victim).toBeDefined();
		await testDb
			.delete(guests)
			.where(eq(guests.id, victim?.targetId as string));
		const before = await counts();
		const { report } = await apply(stored.importId, resolutions);
		const after = await counts();
		expect(after.guests).toBe(before.guests);
		expect(after.people).toBe(before.people);
		expect(after.meetingAttendance).toBe(before.meetingAttendance);
		expect(after.guestSpeeches).toBe(before.guestSpeeches);
		expect(after.roleSlots).toBe(before.roleSlots);
		const row = report.notImported.find((r) =>
			r.what.startsWith("Deleted in GavelUp"),
		);
		expect(row?.count).toBeGreaterThan(0);
		expect(row?.sourceIds).toContain("644304:4");
		expect(report.created.guests).toBe(0);
	});

	it("an imported meeting deleted since is not re-created", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const [{ targetId = "" } = {}] = await refsOfKind("meeting");
		await testDb.delete(meetings).where(eq(meetings.id, targetId));
		const before = await counts();
		const { report } = await apply(stored.importId, resolutions);
		expect(await counts()).toMatchObject({
			meetings: before.meetings,
			meetingAttendance: before.meetingAttendance,
			roleSlots: before.roleSlots,
		});
		expect(
			report.notImported.find((r) => r.what.startsWith("Deleted in GavelUp")),
		).toMatchObject({ count: 1, sourceIds: ["644304"] });
	});

	it("a role slot deleted since the import is not re-created, and its holder's role is listed as not imported", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const slotRef = (await refsOfKind("role_slot")).find(
			(r) => r.sourceId === "644304:3",
		);
		await testDb
			.delete(roleSlots)
			.where(eq(roleSlots.id, slotRef?.targetId as string));
		const before = await counts();
		const { report } = await apply(stored.importId, resolutions);
		expect((await counts()).roleSlots).toBe(before.roleSlots);
		const row = report.notImported.find((r) =>
			r.what.startsWith("Deleted in GavelUp"),
		);
		expect(row?.sourceIds).toContain("644304:3");
	});

	it("a Table Topics speaker, an attendance row, an award and a speech deleted since the import are not re-inserted", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId, NOW_ALL_PAST);
		await apply(stored.importId, resolutions, NOW_ALL_PAST);
		const target = async (kind: string) =>
			(await refsOfKind(kind))[0]?.targetId as string;
		await testDb
			.delete(tableTopicsSpeakers)
			.where(eq(tableTopicsSpeakers.id, await target("table_topic")));
		await testDb
			.delete(meetingAttendance)
			.where(eq(meetingAttendance.id, await target("attendance")));
		await testDb
			.delete(meetingAwards)
			.where(eq(meetingAwards.id, await target("award")));
		const speechRef = await target("speech");
		await testDb.delete(speeches).where(eq(speeches.id, speechRef));
		const before = await counts();
		const { report } = await apply(stored.importId, resolutions, NOW_ALL_PAST);
		expect(await counts()).toEqual(before);
		const row = report.notImported.find((r) =>
			r.what.startsWith("Deleted in GavelUp"),
		);
		expect(row?.count).toBe(4);
		expect(report.reconciled).toBe(true);
	});

	// ---------------------------------------------------------------------
	// Self-serve import (#1492)
	// ---------------------------------------------------------------------

	const adminRunner = () =>
		({
			kind: "admin",
			userId: seed.adminUserId,
			actorMemberId: seed.adminMemberId,
			impersonatedBy: null,
		}) as const;

	/** The fixture, from another Easy-Speak club, with a name and number of our choosing. */
	function bundleFrom(club: {
		esClubId: string;
		name: string;
		number: string | null;
	}): string {
		const bundle = JSON.parse(bundleText()) as EasySpeakBundleV1;
		bundle.club = { ...bundle.club, ...club };
		return JSON.stringify(bundle);
	}

	async function historyImportedRows() {
		return testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				impersonatedBy: activityLog.impersonatedBy,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "history_imported"),
				),
			);
	}

	// protects=an apply a club admin runs is credited to that admin's membership
	// with no impersonation, one a superadmin runs stays memberless and credited
	// through impersonated_by (every activity_log row of the apply);
	// fails_when=the runner is dropped back to a bare superadmin id, or the admin
	// is credited as an impersonator;
	// no_claim=the member_add rows (no created member in this fixture).
	it("attributes an admin's apply to the admin and a superadmin's to the superadmin", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await logic.applyEasySpeakImport({
			clubId: seed.clubId,
			importId: stored.importId,
			runner: adminRunner(),
			resolutions,
			now: NOW,
		});
		expect(await historyImportedRows()).toEqual([
			expect.objectContaining({
				actorMemberId: seed.adminMemberId,
				impersonatedBy: null,
			}),
		]);
		await testDb.delete(activityLog).where(eq(activityLog.clubId, seed.clubId));
		await apply(stored.importId, resolutions);
		expect(await historyImportedRows()).toEqual([
			expect.objectContaining({
				actorMemberId: null,
				impersonatedBy: superadminId,
			}),
		]);
	});

	// protects=an admin whose officer term closed after the gate passed but before
	// the import lock was taken writes nothing (#806);
	// fails_when=assertStillClubAdmin is not asked after the lock;
	// no_claim=the up-front gate (the authz integration test).
	it("writes nothing for an admin who is no longer one once the lock is taken", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: seed.memberId,
				position: "vp_education",
				termStart: new Date("2026-01-01T00:00:00Z"),
				termEnd: null,
			})
			.returning({ id: officerTerms.id });
		const runner = {
			kind: "admin",
			userId: seed.memberUserId,
			actorMemberId: seed.memberId,
			impersonatedBy: null,
		} as const;
		await testDb
			.update(officerTerms)
			.set({ termEnd: new Date("2026-02-01T00:00:00Z") })
			.where(eq(officerTerms.id, term?.id as string));
		const before = await counts();
		await expect(
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
				resolutions,
				now: NOW,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(await counts()).toEqual(before);
		expect(await historyImportedRows()).toEqual([]);
	});

	/** Closes the admin's open officer term when the `lockCall`-th club lock is taken. */
	async function lapseAtLock(lockCall: number) {
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: seed.memberId,
				position: "vp_education",
				termStart: new Date("2026-01-01T00:00:00Z"),
				termEnd: null,
			})
			.returning({ id: officerTerms.id });
		lockHook.run = async (_tx, call) => {
			if (call !== lockCall) return;
			await testDb
				.update(officerTerms)
				.set({ termEnd: new Date("2026-02-01T00:00:00Z") })
				.where(eq(officerTerms.id, term?.id as string));
		};
		return {
			kind: "admin",
			userId: seed.memberUserId,
			actorMemberId: seed.memberId,
			impersonatedBy: null,
		} as const;
	}
	const appliedAtOf = async (importId: string) => {
		const [row] = await testDb
			.select({ appliedAt: clubImports.appliedAt })
			.from(clubImports)
			.where(eq(clubImports.id, importId));
		return row?.appliedAt ?? null;
	};

	// protects=an admin whose officer term closes BETWEEN the apply's transactions
	// (#806, risk review of #1505): every later writing transaction re-asks under
	// its own club lock, so the first meeting lands, the second is refused, the
	// the apply rejects and the import is not marked applied;
	// fails_when=assertRunnerStillAllowed is dropped from the per-meeting
	// transaction;
	// no_claim=the people transaction and the final one (next two tests).
	it("stops at the second meeting when the admin lapses after the first transaction", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const runner = await lapseAtLock(3);
		const before = (await counts()).meetings;
		await expect(
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
				resolutions,
				now: NOW_ALL_PAST,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect((await counts()).meetings).toBe(before + 1);
		expect(await appliedAtOf(stored.importId)).toBeNull();
		expect(await historyImportedRows()).toEqual([]);
	});

	// protects=the people-and-roles transaction re-asks under its own lock: an admin
	// who lapses after the apply's first check writes no person and no meeting;
	// fails_when=writePeopleAndRoles drops its re-check;
	// no_claim=later transactions (neighbouring tests).
	it("writes no person when the admin lapses before the people transaction", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const runner = await lapseAtLock(1);
		const before = await counts();
		await expect(
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
				resolutions,
				now: NOW,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(await counts()).toEqual(before);
	});

	// protects=the closing club_imports update re-asks under the lock too: an admin
	// who lapses after the last meeting does not get the import marked applied
	// (which would also bind the club);
	// fails_when=the final transaction takes no lock or skips the re-check;
	// no_claim=the meetings, which have already landed by then.
	it("does not mark the import applied when the admin lapses before the final transaction", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		const runner = await lapseAtLock(5);
		const before = (await counts()).meetings;
		await expect(
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
				resolutions,
				now: NOW_ALL_PAST,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect((await counts()).meetings).toBe(before + 3);
		expect(await appliedAtOf(stored.importId)).toBeNull();
		expect(await historyImportedRows()).toEqual([]);
		expect(await logic.boundEasySpeakClub(testDb, seed.clubId)).toBeNull();
	});

	// protects=a step that takes the lock then finds the admin gone writes nothing:
	// the speech-request step re-asks AFTER its lock, not before;
	// fails_when=importSpeechRequests asks only before lockClubForWrite;
	// no_claim=the mentor step (its own test).
	it("re-asks the speech-request step's admin under the lock it takes", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		lockHook.calls = 0;
		const runner = await lapseAtLock(1);
		const [{ n: before } = { n: 0 }] = await testDb
			.select({ n: count() })
			.from(speechRequests)
			.where(eq(speechRequests.clubId, seed.clubId));
		// The up-front check passes (the term is open when it runs); the lock hook then closes it.
		await expect(
			logic.importSpeechRequests({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
				now: NOW,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		const [{ n: after } = { n: 0 }] = await testDb
			.select({ n: count() })
			.from(speechRequests)
			.where(eq(speechRequests.clubId, seed.clubId));
		expect(Number(after)).toBe(Number(before));
	});

	// protects=the mentor step re-asks the admin under its own lock;
	// fails_when=importMentorPairs asks before lockClubForWrite only;
	// no_claim=the speech-request step (previous test).
	it("re-asks the mentor step's admin under the lock it takes", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		lockHook.calls = 0;
		const runner = await lapseAtLock(1);
		const { importMentorPairs } = await import("./mentor-import-logic");
		const before = await historyImportedRows();
		await expect(
			importMentorPairs({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(await historyImportedRows()).toEqual(before);
	});

	// protects=the two follow-up steps re-ask the admin question after THEIR lock
	// too (#806): an admin whose term closed since the apply writes no speech
	// request and no pairing;
	// fails_when=either step takes the lock without re-checking the runner;
	// no_claim=what the steps write for a current admin (their own suites).
	it("refuses the speech-request and mentor steps for an admin who lapsed", async () => {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: seed.memberId,
				position: "vp_education",
				termStart: new Date("2026-01-01T00:00:00Z"),
				termEnd: new Date("2026-02-01T00:00:00Z"),
			})
			.returning({ id: officerTerms.id });
		expect(term).toBeDefined();
		const runner = {
			kind: "admin",
			userId: seed.memberUserId,
			actorMemberId: seed.memberId,
			impersonatedBy: null,
		} as const;
		await expect(
			logic.importSpeechRequests({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
				now: NOW,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		const { importMentorPairs } = await import("./mentor-import-logic");
		await expect(
			importMentorPairs({
				clubId: seed.clubId,
				importId: stored.importId,
				runner,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(
			(await historyImportedRows()).filter(
				(r) => (r.detail as { step?: string }).step !== undefined,
			),
		).toEqual([]);
	});

	describe("contacts parity (#1492)", () => {
		let otherClub: SeededClub;
		beforeEach(async () => {
			otherClub = await seedClub();
		});
		afterEach(async () => {
			await cleanup(otherClub.clubId, [
				otherClub.adminUserId,
				otherClub.memberUserId,
			]);
		});

		const personOf = async (name: string) => {
			const [row] = await testDb
				.select({ id: members.personId })
				.from(members)
				.where(and(eq(members.clubId, seed.clubId), eq(members.name, name)))
				.limit(1);
			return row?.id as string;
		};
		const emailOf = async (name: string) => {
			const [row] = await testDb
				.select({ email: people.email })
				.from(people)
				.where(eq(people.id, await personOf(name)));
			return row?.email ?? null;
		};
		/** Put a Person on another club's roster. */
		const holdInOtherClub = async (personId: string) => {
			await testDb.insert(members).values({
				clubId: otherClub.clubId,
				personId,
				name: "Held Elsewhere",
				clubRole: "member",
				status: "active",
			});
		};

		// protects=the preview's "already on another member" warning is about THIS
		// club's roster: an address held by a Person on another club's roster alone
		// raises none, one held by a member of this club does, and neither names a
		// club or a holder;
		// fails_when=loadContactState reads every Person in the database;
		// no_claim=what the apply does with the address (the next tests).
		it("scopes the preview's holder warning to this club's members", async () => {
			const [outsiderPerson] = await testDb
				.insert(people)
				.values({ name: "Outsider", email: "outsider@example.test" })
				.returning({ id: people.id });
			await holdInOtherClub(outsiderPerson?.id as string);
			await testDb
				.update(people)
				.set({ email: "taken@example.test" })
				.where(eq(people.id, await personOf("Jules Valewood")));
			const stored = await upload();
			const preview = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				contacts: `Elliot Tansley, outsider@example.test, \nParker Vexford, taken@example.test, `,
				now: NOW,
			});
			// #1493: an address held by ANOTHER member of this club than the one the row's
			// name matches is a disagreement the preview asks about, so Parker is
			// ambiguous (between Jules and Parker) and row 2 is placed on no one. The
			// other club's holder of row 1's address still blocks nothing.
			expect(preview.contacts.warnings).toEqual([
				"Contact row 2 matches no one being linked or created; it is applied to no one.",
			]);
			expect(
				preview.people.find((p) => p.name === "Parker Vexford")?.status,
			).toBe("ambiguous");
			expect(preview.contacts.emails).toBe(1);
		});

		// protects=a linked member whose Person belongs to another club (or has
		// signed in) is planned no email fill, the preview says why, and the apply
		// leaves people.email blank; a sole-holder unbound member still gets the fill
		// in preview and in apply;
		// fails_when=the plan promises a fill the apply's UPDATE then skips, or the
		// control stops being filled;
		// no_claim=the member edit itself (#907's own tests).
		it("plans and writes an email fill only where the member-edit rule allows it", async () => {
			await holdInOtherClub(await personOf("Elliot Tansley"));
			const [signedIn] = await testDb
				.insert(user)
				.values({
					id: randomUUID(),
					name: "S",
					email: `signed-${randomUUID()}@test.example`,
					emailVerified: true,
				})
				.returning({ id: user.id });
			extraUsers.push(signedIn?.id as string);
			await testDb
				.update(people)
				.set({ userId: signedIn?.id as string })
				.where(eq(people.id, await personOf("Kai Larkspur")));
			const contacts = [
				"Elliot Tansley, tansley@example.test, ",
				"Kai Larkspur, kai@example.test, ",
				"Parker Vexford, parker@example.test, ",
			].join("\n");
			const stored = await upload();
			const { resolutions } = await resolveAll(stored.importId);
			const preview = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				resolutions,
				contacts,
				now: NOW,
			});
			expect(preview.contacts.emails).toBe(1);
			expect(preview.contacts.warnings).toEqual([
				"The email in row 1 was left blank for Elliot Tansley: the person has a GavelUp account or belongs to another club, so it is theirs to add.",
				"The email in row 2 was left blank for Kai Larkspur: the person has a GavelUp account or belongs to another club, so it is theirs to add.",
			]);
			await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner: adminRunner(),
				resolutions,
				contacts,
				planHash: preview.planHash,
				now: NOW,
			});
			expect(await emailOf("Elliot Tansley")).toBeNull();
			expect(await emailOf("Kai Larkspur")).toBeNull();
			expect(await emailOf("Parker Vexford")).toBe("parker@example.test");
		});

		// protects=an address held by a Person outside the club is left blank at
		// apply with exactly one neutral sentence, and nothing in the stored report
		// names another club, a holder count or whether the holder signed in;
		// fails_when=the note leaks, or the write overwrites the holder's address;
		// no_claim=a created member (the one-upload suite covers that arm).
		it("leaves an address held outside the club blank with one neutral note", async () => {
			const [outsider] = await testDb
				.insert(people)
				.values({ name: "Outsider", email: "outsider@example.test" })
				.returning({ id: people.id });
			await holdInOtherClub(outsider?.id as string);
			const stored = await upload();
			const { resolutions } = await resolveAll(stored.importId);
			const { report } = await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner: adminRunner(),
				resolutions,
				contacts: "Elliot Tansley, outsider@example.test, ",
				now: NOW,
			});
			expect(report.contactNotes).toEqual([
				"The email in row 1 was left blank for Elliot Tansley: that address is already in use in GavelUp.",
			]);
			expect(await emailOf("Elliot Tansley")).toBeNull();
			expect(JSON.stringify(report)).not.toMatch(
				/another club|signed in|account/iu,
			);
		});
	});

	describe("club binding (#1492)", () => {
		const X = { esClubId: "4242", name: "Fixture Speakers", number: "9999" };
		const Y = { esClubId: "7777", name: "Other Speakers", number: "7777" };
		const rowsStored = async () => {
			const [row] = await testDb
				.select({ n: count() })
				.from(clubImports)
				.where(eq(clubImports.clubId, seed.clubId));
			return Number(row?.n);
		};

		// protects=once a club's first import is applied, a bundle from another
		// Easy-Speak club is refused at upload (nothing stored) and a bundle from
		// the same club is accepted; one stored BEFORE the apply is refused at apply
		// and writes nothing;
		// fails_when=the esClubId comparison is gone from either site;
		// no_claim=a superadmin override (next test).
		it("refuses a bundle from another Easy-Speak club at upload and at apply", async () => {
			const early = await upload(bundleFrom(Y));
			const x = await upload(bundleFrom(X));
			const { resolutions } = await resolveAll(x.importId);
			await apply(x.importId, resolutions);
			const stored = await rowsStored();
			await expect(upload(bundleFrom({ ...Y, name: "Third" }))).rejects.toThrow(
				"This export is from Third, not Fixture Speakers, the Easy-Speak club this club was imported from.",
			);
			expect(await rowsStored()).toBe(stored);
			const before = await counts();
			await expect(apply(early.importId, resolutions)).rejects.toThrow(
				"This export is from Other Speakers, not Fixture Speakers, the Easy-Speak club this club was imported from.",
			);
			expect(await counts()).toEqual(before);
			await expect(
				upload(bundleFrom({ ...X, name: "Renamed" })),
			).resolves.toMatchObject({ reused: false });
		});

		// protects=a superadmin's override imports a mismatched bundle and the
		// apply's activity row says so; without the flag the same apply is refused;
		// fails_when=the override is ignored, or is not recorded;
		// no_claim=that a club admin cannot pass the flag (the authz test).
		it("lets a superadmin override the binding and records it", async () => {
			const x = await upload(bundleFrom(X));
			const { resolutions } = await resolveAll(x.importId);
			await apply(x.importId, resolutions);
			await expect(upload(bundleFrom(Y))).rejects.toThrow(
				/This export is from/,
			);
			const y = await logic.storeEasySpeakBundle({
				clubId: seed.clubId,
				uploadedByUserId: superadminId,
				text: bundleFrom(Y),
				overrideClubBinding: true,
			});
			await expect(apply(y.importId, resolutions)).rejects.toThrow(
				/This export is from/,
			);
			await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: y.importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				overrideClubBinding: true,
				now: NOW,
			});
			const rows = await historyImportedRows();
			expect(
				rows.filter(
					(r) =>
						(r.detail as { overrodeClubBinding?: boolean }).overrodeClubBinding,
				),
			).toHaveLength(1);
		});

		// protects=the binding is the FIRST applied import: X applied, Y applied by
		// override, X applied AGAIN: the club is still bound to X (a re-apply
		// refreshes applied_at, which must not move the binding), a Y-like bundle is
		// still refused and X can still be re-applied;
		// fails_when=the binding orders by the latest applied_at, or a re-apply
		// overwrites the first-applied stamp;
		// no_claim=the report a re-apply stores (the latest-report tests).
		it("keeps the first applied import as the binding across a re-apply", async () => {
			const x = await upload(bundleFrom(X));
			const { resolutions } = await resolveAll(x.importId);
			await apply(x.importId, resolutions, NOW);
			const y = await logic.storeEasySpeakBundle({
				clubId: seed.clubId,
				uploadedByUserId: superadminId,
				text: bundleFrom(Y),
				overrideClubBinding: true,
			});
			await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: y.importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				overrideClubBinding: true,
				now: new Date(NOW.getTime() + 3_600_000),
			});
			await apply(x.importId, resolutions, new Date(NOW.getTime() + 7_200_000));
			expect(await logic.boundEasySpeakClub(testDb, seed.clubId)).toEqual({
				esClubId: X.esClubId,
				name: X.name,
				number: X.number,
			});
			await expect(upload(bundleFrom({ ...Y, name: "Third" }))).rejects.toThrow(
				/not Fixture Speakers/,
			);
			// The latest report is still the re-apply's: applied_at moved, the stamp did not.
			expect(
				(await logic.loadImportReport({ clubId: seed.clubId }))?.importId,
			).toBe(x.importId);
		});

		// protects=a row applied before the first-applied stamp existed (no
		// firstAppliedAt in its bundle) keeps the binding it had when re-applied:
		// the stamp is seeded from its own applied_at, not from now;
		// fails_when=the coalesce drops the applied_at fallback;
		// no_claim=the new-row path (previous test).
		it("seeds the stamp from applied_at for a row applied before it existed", async () => {
			const x = await upload(bundleFrom(X));
			const { resolutions } = await resolveAll(x.importId);
			await apply(x.importId, resolutions, NOW);
			await testDb
				.update(clubImports)
				.set({ bundle: sql`${clubImports.bundle} - 'firstAppliedAt'` })
				.where(eq(clubImports.id, x.importId));
			await apply(x.importId, resolutions, new Date(NOW.getTime() + 7_200_000));
			const [row] = await testDb
				.select({
					stamp: sql<string>`${clubImports.bundle}->>'firstAppliedAt'`,
				})
				.from(clubImports)
				.where(eq(clubImports.id, x.importId));
			expect(new Date(row?.stamp as string).toISOString()).toBe(
				NOW.toISOString(),
			);
		});

		// protects=before any import, the number on both sides must agree after
		// trimming and stripping leading zeros, and either side null is accepted;
		// fails_when=the normalization is dropped (0012345 refused) or the check
		// compares raw strings;
		// no_claim=the bound arm (above).
		it("compares club numbers by value on the first import", async () => {
			await testDb
				.update(clubs)
				.set({ clubNumber: "12345" })
				.where(eq(clubs.id, seed.clubId));
			await expect(
				upload(bundleFrom({ ...X, number: "0012345" })),
			).resolves.toMatchObject({ reused: false });
			await expect(
				upload(bundleFrom({ ...X, number: "67890" })),
			).rejects.toThrow(
				"This export is from Easy-Speak club Fixture Speakers (#67890), but this club's number is 12345.",
			);
			await expect(
				upload(bundleFrom({ ...X, number: null })),
			).resolves.toMatchObject({ reused: false });
			await testDb
				.update(clubs)
				.set({ clubNumber: null })
				.where(eq(clubs.id, seed.clubId));
			await expect(
				upload(bundleFrom({ ...X, number: "55555" })),
			).resolves.toMatchObject({ reused: false });
		});

		// protects=the first import's preview leads with the Easy-Speak club -> this
		// club, and a later import's does not;
		// fails_when=the line shows after the club is bound, or never;
		// no_claim=how the panel words it (the component test).
		it("shows the binding in the first preview only", async () => {
			const x = await upload(bundleFrom(X));
			const { preview, resolutions } = await resolveAll(x.importId);
			expect(preview.binding).toEqual({
				esName: "Fixture Speakers",
				esNumber: "9999",
				clubName: "Test Club",
			});
			await apply(x.importId, resolutions);
			const after = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: x.importId,
				now: NOW,
			});
			expect(after.binding).toBeNull();
		});
	});

	// ---- bounded export (#1491)

	/**
	 * The fixture's bundle as a bounded export holds it: its one imported meeting plus one new past
	 * meeting at `newAt` (a Toastmaster-style role with no speech, held by someone the plan matches),
	 * stamped with its own `exportedAt` so each is a distinct upload.
	 */
	function boundedText(
		fromMonth: string | null,
		newAt: string,
		exportedAt: string,
	): string {
		const bundle = JSON.parse(bundleText()) as EasySpeakBundleV3;
		const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
		const plain = past?.roles.find((r) => !r.speech && r.holder);
		if (!past || !plain) throw new Error("fixture changed");
		bundle.version = 3;
		bundle.range = fromMonth ? { fromMonth } : null;
		bundle.exportedAt = exportedAt;
		bundle.meetings.push({
			...past,
			esMeetingId: `new-${newAt}`,
			startsAt: newAt,
			roles: [{ ...plain, slot: 1 }],
			attendance: [],
			guests: [],
			awards: [],
			tableTopics: [],
		});
		return JSON.stringify(bundle);
	}

	async function addImportedMeeting(
		clubId: string,
		at: Date,
		sourceId: string,
	): Promise<void> {
		const [row] = await testDb
			.insert(meetings)
			.values({ clubId, scheduledAt: at, status: "completed" })
			.returning({ id: meetings.id });
		await testDb.insert(importRefs).values({
			clubId,
			source: "easy_speak",
			kind: "meeting",
			sourceId,
			targetId: row?.id as string,
		});
	}

	async function applyFull() {
		const stored = await upload();
		const { resolutions } = await resolveAll(stored.importId);
		await apply(stored.importId, resolutions);
		return stored;
	}

	// protects=the panel's "Next export" month: the newest imported meeting that had started when the newest APPLIED import was exported, in the club's zone;
	// fails_when=an imported meeting after exportedAt, another club's refs or an unapplied import's later exportedAt moves the month, or a club with no applied import gets one;
	// no_claim=the display (the panel test); the fixture's one past meeting stands in for a real history
	it("nextExportMonth is the club-local month of the newest imported meeting held by the last export (AC 9)", async () => {
		expect(await logic.nextExportMonth(seed.clubId)).toBeNull();
		await applyFull();
		// FIRST_AT is 2026-09-23T02:00Z: still the 22nd in Los Angeles.
		expect(await logic.nextExportMonth(seed.clubId)).toBe("2026-09");

		// A meeting at 2026-10-01T02:00Z is still 30 September in Los Angeles: the month is the
		// club's, so a UTC slice (2026-10) is wrong.
		await addImportedMeeting(
			seed.clubId,
			new Date("2026-10-01T02:00:00Z"),
			"boundary",
		);
		expect(await logic.nextExportMonth(seed.clubId)).toBe("2026-09");

		// An imported meeting after the export's exportedAt (2026-10-12T12:00:41Z) is not "held".
		await addImportedMeeting(
			seed.clubId,
			new Date("2026-10-20T02:00:00Z"),
			"later",
		);
		expect(await logic.nextExportMonth(seed.clubId)).toBe("2026-09");

		// An unapplied import, even with a later exportedAt, does not move the cutoff.
		await addImportedMeeting(
			seed.clubId,
			new Date("2026-10-12T12:30:00Z"),
			"between",
		);
		await upload(
			boundedText(null, "2026-10-12T12:20:00.000Z", "2026-10-12T13:00:00.000Z"),
		);
		expect(await logic.nextExportMonth(seed.clubId)).toBe("2026-09");

		// Another club's refs and meetings, newer and before the cutoff, are not this club's.
		const other = await seedClub();
		try {
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date("2026-10-01T20:00:00Z") })
				.where(eq(meetings.id, other.meetingId));
			await testDb.insert(importRefs).values({
				clubId: other.clubId,
				source: "easy_speak",
				kind: "meeting",
				sourceId: "elsewhere",
				targetId: other.meetingId,
			});
			expect(await logic.nextExportMonth(seed.clubId)).toBe("2026-09");
			// ...and it has no applied import of its own.
			expect(await logic.nextExportMonth(other.clubId)).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	// protects=the preview warning an admin that a bounded bundle leaves a hole after the club's imported history, without ever blocking the apply;
	// fails_when=the warning appears for an in-range, full, applied or first-ever import, repeats, names the wrong month, or changes canApply;
	// no_claim=the wording's place in the panel (its own test)
	it("warns once, and only, when an unapplied bounded bundle starts after the imported history ends (AC 11)", async () => {
		const gap = boundedText(
			"2026-11",
			"2026-11-04T02:00:00.000Z",
			"2026-11-05T12:00:00.000Z",
		);
		const message =
			"This bundle starts November 2026; GavelUp's imported history ends September 2026. Meetings in between will not be imported. Export from September 2026 to close the gap.";
		const warningsOf = async (importId: string) =>
			(
				await logic.previewEasySpeakImport({
					clubId: seed.clubId,
					importId,
					now: NOW,
				})
			).warnings;
		const gapOnly = (w: string[]) =>
			w.filter((x) => x.startsWith("This bundle starts"));

		// A club with no applied import: nothing to compare with.
		const first = await upload(gap);
		expect(gapOnly(await warningsOf(first.importId))).toEqual([]);

		await applyFull();

		expect(gapOnly(await warningsOf(first.importId))).toEqual([message]);
		// The same bundle read as a full history, and ranges in or before the imported month, get none.
		const full = await upload(
			boundedText(null, "2026-11-04T02:00:00.000Z", "2026-11-05T12:00:00.000Z"),
		);
		const inside = await upload(
			boundedText(
				"2026-09",
				"2026-11-04T02:00:00.000Z",
				"2026-11-05T12:00:00.000Z",
			),
		);
		const before = await upload(
			boundedText(
				"2026-08",
				"2026-11-04T02:00:00.000Z",
				"2026-11-05T12:00:00.000Z",
			),
		);
		for (const s of [full, inside, before]) {
			expect(gapOnly(await warningsOf(s.importId))).toEqual([]);
		}
		// canApply does not depend on the warning.
		const withWarning = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: first.importId,
			now: NOW,
		});
		const without = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId: full.importId,
			now: NOW,
		});
		expect(withWarning.canApply).toBe(without.canApply);
		expect(withWarning.range).toEqual({ fromMonth: "2026-11" });
		expect(without.range).toBeNull();

		// Once applied, the warning is history.
		const { resolutions } = await resolveAll(first.importId);
		await apply(first.importId, resolutions);
		expect(gapOnly(await warningsOf(first.importId))).toEqual([]);
	});

	// protects=a bounded export adding only the meetings since the last import: no one is created, changed or removed because older meetings are absent, and the report still reconciles;
	// fails_when=the apply touches an existing member row, loses or recreates older meetings, or reports a difference for records outside the bundle;
	// no_claim=a real multi-year club (one past meeting plus one new one)
	it("applying a bounded bundle adds only its new meetings and changes no member (AC 12)", async () => {
		await applyFull();
		const before = await counts();
		const membersOf = () =>
			testDb
				.select()
				.from(members)
				.where(eq(members.clubId, seed.clubId))
				.orderBy(members.id);
		const membersBefore = await membersOf();

		const stored = await upload(
			boundedText(
				"2026-09",
				"2026-10-05T02:00:00.000Z",
				"2026-10-12T13:00:00.000Z",
			),
		);
		const { resolutions } = await resolveAll(stored.importId);
		const { report } = await apply(stored.importId, resolutions);

		expect(report.reconciled).toBe(true);
		const after = await counts();
		expect(after.meetings).toBe(before.meetings + 1);
		expect(JSON.stringify(await membersOf())).toBe(
			JSON.stringify(membersBefore),
		);
		expect(report.counts.find((c) => c.key === "meetings")).toMatchObject({
			bundle: 2,
			gavelup: 2,
		});
	});

	describe("upcoming meetings (#1495)", () => {
		const UP = { include: true, skipRoles: [] as string[] };
		/** 644360 (Tue 13 Oct local) and 644363 (Tue 27 Oct) are ahead of NOW, plus one made on a third date. */
		function upcomingText(): string {
			const bundle = JSON.parse(
				readFileSync(FIXTURE, "utf8"),
			) as EasySpeakBundleV1;
			const src = bundle.meetings.find((m) => m.esMeetingId === "644360");
			if (!src) throw new Error("fixture changed");
			const clone = JSON.parse(JSON.stringify(src)) as typeof src;
			// A speech belongs to one slot, so the copy needs speech ids of its own.
			for (const role of clone.roles) {
				if (role.speech?.esSpeechId)
					role.speech.esSpeechId = `${role.speech.esSpeechId}-copy`;
			}
			bundle.meetings.push({
				...clone,
				esMeetingId: "990001",
				startsAt: "2028-03-15T02:00:00.000Z",
			});
			return JSON.stringify(bundle);
		}
		const MORNING_13 = new Date("2026-10-13T18:00:00.000Z");
		const MORNING_27 = new Date("2026-10-27T18:00:00.000Z");

		async function previewUp(
			importId: string,
			resolutions: Record<string, PersonResolution>,
			upcoming = UP,
		) {
			return realLogic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId,
				resolutions,
				now: NOW,
				upcoming,
			});
		}
		async function applyUp(
			importId: string,
			resolutions: Record<string, PersonResolution>,
			extra: { planHash?: string; upcoming?: typeof UP } = {},
		) {
			return realLogic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				now: NOW,
				upcoming: UP,
				...extra,
			});
		}
		/** The club's Timer, carrying the standard key the plan matches a role on. */
		async function timerDefId() {
			await testDb
				.update(roleDefinitions)
				.set({ key: "timer" })
				.where(
					and(
						eq(roleDefinitions.clubId, seed.clubId),
						eq(roleDefinitions.name, "Timer"),
					),
				);
			const [row] = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, seed.clubId),
						eq(roleDefinitions.name, "Timer"),
					),
				);
			return row?.id as string;
		}
		/** A roster member the bundle's upcoming holders can resolve to. */
		async function addMember(
			name: string,
			status: "active" | "inactive" | "former" = "active",
		) {
			const [person] = await testDb
				.insert(people)
				.values({ name })
				.returning({ id: people.id });
			const [row] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person?.id as string,
					name,
					clubRole: "member",
					status,
				})
				.returning({ id: members.id });
			return row?.id as string;
		}
		async function slotRows(meetingId: string) {
			return testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, meetingId));
		}

		// protects=the first import of a club ticks the box and a later one does not;
		// fails_when=the default ignores applied imports;
		// no_claim=the panel's rendering (the panel test).
		it("defaults the box to ticked until an import has been applied", async () => {
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const first = await realLogic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				resolutions,
				now: NOW,
			});
			expect(first.upcoming.included).toBe(true);
			expect(first.upcoming.defaultIncluded).toBe(true);
			await applyUp(stored.importId, resolutions);
			const later = await realLogic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				resolutions,
				now: NOW,
			});
			expect(later.upcoming.included).toBe(false);
			expect(later.upcoming.defaultIncluded).toBe(false);
		});

		// protects=one apply creates a meeting on a free date, adopts a scheduled one by local date and fills only its blanks and empty slots, and leaves a cancelled one untouched; a re-apply writes nothing; nothing is emailed;
		// fails_when=the date is matched by instant, a cancelled meeting is revived, a held slot is displaced, or a second apply duplicates rows;
		// no_claim=the race between preview and apply (next tests).
		it("creates, adopts and leaves alone, keeps a holder, and a re-apply writes nothing", async () => {
			const { sendEmail } = await import("#/lib/email");
			const sent = vi.mocked(sendEmail);
			sent.mockClear();
			const timer = await timerDefId();
			// 13 Oct: a scheduled meeting at another instant, its Timer slot held by a member.
			const adoptId = await seedMeetingAt(MORNING_13, "scheduled");
			const [holder] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, seed.clubId))
				.limit(1);
			await testDb.insert(roleSlots).values([
				{
					meetingId: adoptId,
					roleDefinitionId: timer,
					slotIndex: 0,
					assignedMemberId: holder?.id as string,
					status: "confirmed",
				},
				{
					meetingId: adoptId,
					roleDefinitionId: timer,
					slotIndex: 1,
					status: "open",
				},
			]);
			await testDb
				.update(meetings)
				.set({ theme: "Mine" })
				.where(eq(meetings.id, adoptId));
			// 27 Oct: a cancelled meeting.
			const cancelledId = await seedMeetingAt(MORNING_27, "cancelled");
			// Easy-Speak's first Timer is a member here; an upcoming role never makes one.
			await addMember("Oakley Oakenshaw");

			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const preview = await previewUp(stored.importId, resolutions);
			expect(preview.upcoming).toMatchObject({
				toAdopt: 1,
				toCreate: 1,
				included: true,
			});
			expect(preview.upcoming.leftAlone).toHaveLength(1);
			const { report } = await applyUp(stored.importId, resolutions, {
				planHash: preview.planHash,
			});
			expect(report.reconciled).toBe(true);

			// Adopted: theme kept, the held slot kept, the empty one filled by Easy-Speak's second Timer.
			const adopted = await meetingRow(adoptId);
			expect(adopted).toMatchObject({ status: "scheduled", theme: "Mine" });
			const slots = await slotRows(adoptId);
			const timers = slots.filter((s) => s.roleDefinitionId === timer);
			expect(timers.find((s) => s.slotIndex === 0)?.assignedMemberId).toBe(
				holder?.id,
			);
			expect(timers.find((s) => s.slotIndex === 1)?.assignedMemberId).not.toBe(
				null,
			);
			// Cancelled: untouched.
			expect(await meetingRow(cancelledId)).toMatchObject({
				status: "cancelled",
				theme: null,
			});
			expect(await slotsOf(cancelledId)).toBe(0);
			// Created: the third date, scheduled, with its holders and RSVPs.
			const created = (await refsOfKind("meeting")).find(
				(r) => r.sourceId === "990001",
			);
			expect(created).toBeTruthy();
			expect(await meetingRow(created?.targetId as string)).toMatchObject({
				status: "scheduled",
			});
			expect(
				(await slotRows(created?.targetId as string)).some(
					(s) => s.assignedMemberId || s.assignedGuestId,
				),
			).toBe(true);
			const rsvps = await testDb
				.select({ n: count() })
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.meetingId, adoptId));
			expect(Number(rsvps[0]?.n)).toBeGreaterThan(0);

			// A second apply writes no row at all.
			const before = await counts();
			await applyUp(stored.importId, resolutions);
			expect(await counts()).toEqual(before);
			// The import writes records; it sends nothing to anyone.
			expect(sent).not.toHaveBeenCalled();
		});

		// protects=a member who claims an empty slot between the preview and the apply keeps it: with the preview's hash the apply is refused, and without one the writer's re-read leaves the slot alone;
		// fails_when=the writer overwrites a slot that was empty in the plan;
		// no_claim=the hash of an unchanged plan (the test above).
		it("does not displace a slot claimed after the preview", async () => {
			const timer = await timerDefId();
			const adoptId = await seedMeetingAt(MORNING_13, "scheduled");
			await testDb.insert(roleSlots).values([
				{
					meetingId: adoptId,
					roleDefinitionId: timer,
					slotIndex: 0,
					status: "open",
				},
				{
					meetingId: adoptId,
					roleDefinitionId: timer,
					slotIndex: 1,
					status: "open",
				},
			]);
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const preview = await previewUp(stored.importId, resolutions);
			// A member claims slot 0 after the preview: the slot the plan put the Timer
			// holder in. (Claiming slot 1 leaves the placement, and so the hash, alone.)
			const [claimer] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, seed.clubId))
				.limit(1);
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: claimer?.id as string, status: "confirmed" })
				.where(
					and(eq(roleSlots.meetingId, adoptId), eq(roleSlots.slotIndex, 0)),
				);
			await expect(
				applyUp(stored.importId, resolutions, { planHash: preview.planHash }),
			).rejects.toThrow(realLogic.PLAN_CHANGED_MESSAGE);
			await applyUp(stored.importId, resolutions);
			const after = (await slotRows(adoptId)).find(
				(s) => s.roleDefinitionId === timer && s.slotIndex === 0,
			);
			expect(after?.assignedMemberId).toBe(claimer?.id);
		});

		// protects=the box and each Skip answer are part of the plan the hash names;
		// fails_when=changing either leaves the hash and the apply goes through;
		// no_claim=how the answers render.
		it("refuses an apply whose box or Skip answer differs from the preview", async () => {
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const preview = await previewUp(stored.importId, resolutions);
			await expect(
				applyUp(stored.importId, resolutions, {
					planHash: preview.planHash,
					upcoming: { include: false, skipRoles: [] },
				}),
			).rejects.toThrow(realLogic.PLAN_CHANGED_MESSAGE);
			const row = preview.upcoming.unslottedRoles[0];
			expect(row).toBeTruthy();
			await expect(
				applyUp(stored.importId, resolutions, {
					planHash: preview.planHash,
					upcoming: { include: true, skipRoles: [row?.planKey as string] },
				}),
			).rejects.toThrow(realLogic.PLAN_CHANGED_MESSAGE);
		});

		async function memberIdOf(name: string) {
			const [row] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(and(eq(members.clubId, seed.clubId), eq(members.name, name)));
			return row?.id as string;
		}
		type Rep = Awaited<ReturnType<typeof applyUp>>["report"];
		/** The stored report's row for one omission cause. */
		const omissionRow = (report: Rep, cause: { what: string }) =>
			report.notImported.find((r) => r.what === cause.what);
		/** The meeting an import ref points the Easy-Speak meeting at. */
		async function createdMeeting(esMeetingId = "644360") {
			const ref = (await refsOfKind("meeting")).find(
				(r) => r.sourceId === esMeetingId,
			);
			return ref?.targetId as string;
		}
		async function planRows(meetingId: string) {
			return testDb
				.select({
					memberId: meetingAttendancePlan.memberId,
					status: meetingAttendancePlan.status,
				})
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.meetingId, meetingId));
		}

		// protects=a slot an earlier import filled and its member then released is not filled again by a re-apply, and the report says so;
		// fails_when=the re-apply fills any empty slot it finds, deleted or merely released;
		// no_claim=a slot deleted since (the existing "Deleted in GavelUp" rows).
		it("does not refill a slot the member released since the first import (R1)", async () => {
			const timer = await timerDefId();
			await addMember("Oakley Oakenshaw");
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			await applyUp(stored.importId, resolutions);
			const meetingId = await createdMeeting();
			const filled = (await slotRows(meetingId)).find(
				(x) => x.roleDefinitionId === timer && x.assignedMemberId,
			);
			expect(filled).toBeTruthy();
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: null, status: "open" })
				.where(eq(roleSlots.id, filled?.id as string));
			const { report } = await applyUp(stored.importId, resolutions);
			const after = (await slotRows(meetingId)).find(
				(x) => x.id === filled?.id,
			);
			expect(after?.assignedMemberId).toBeNull();
			expect(omissionRow(report, UPCOMING_RELEASED)).toBeTruthy();
		});

		// protects=an inactive or former member is given neither an upcoming role nor an RSVP, and the report names each;
		// fails_when=the roster's membership status is ignored by the writer;
		// no_claim=a member who goes inactive between the preview and the apply is read under the lock too.
		it.each([
			"inactive",
			"former",
		] as const)("gives a %s member no role and no RSVP (R2)", async (status) => {
			await testDb
				.update(members)
				.set({ status })
				.where(
					and(
						eq(members.clubId, seed.clubId),
						eq(members.name, "Zéphyr Ashlowe"),
					),
				);
			const zephyr = await memberIdOf("Zéphyr Ashlowe");
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const { report } = await applyUp(stored.importId, resolutions);
			const meetingId = await createdMeeting();
			const held = (await slotRows(meetingId)).filter(
				(x) => x.assignedMemberId === zephyr,
			);
			expect(held).toEqual([]);
			expect(
				(await planRows(meetingId)).filter((r) => r.memberId === zephyr),
			).toEqual([]);
			const row = omissionRow(report, UPCOMING_INACTIVE_MEMBER);
			expect(row).toBeTruthy();
			// The role AND the RSVP are both named.
			expect(row?.count).toBeGreaterThanOrEqual(2);
			// An active member's answer is written.
			const kai = await memberIdOf("Kai Larkspur");
			expect(
				(await planRows(meetingId)).find((r) => r.memberId === kai)?.status,
			).toBe("coming");
		});

		// protects=a member who goes inactive AFTER the plan was read but before the meeting's lock is given neither the role nor the RSVP (the writer re-reads the status);
		// fails_when=the writer trusts the plan's roster instead of the status it reads under the lock;
		// no_claim=a member already inactive at the plan (the test above).
		it("re-reads the member's status under the lock (R2)", async () => {
			const zephyr = await memberIdOf("Zéphyr Ashlowe");
			lockHook.run = async (tx, call) => {
				if (call !== 2) return;
				await (tx as typeof testDb)
					.update(members)
					.set({ status: "inactive" })
					.where(eq(members.id, zephyr));
			};
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const { report } = await applyUp(stored.importId, resolutions);
			lockHook.run = null;
			const meetingId = await createdMeeting();
			expect(
				(await slotRows(meetingId)).filter(
					(x) => x.assignedMemberId === zephyr,
				),
			).toEqual([]);
			expect(
				(await planRows(meetingId)).filter((r) => r.memberId === zephyr),
			).toEqual([]);
			// The role and the RSVP, on each of the two upcoming meetings.
			expect(omissionRow(report, UPCOMING_INACTIVE_MEMBER)?.count).toBe(4);
		});

		// protects=a member who told GavelUp they are not coming is not given a role in their name;
		// fails_when=the member's plan row is not read before a slot is filled;
		// no_claim=the row itself (it is theirs and stays).
		it("does not fill a member who answered Not coming (R3)", async () => {
			const adoptId = await seedMeetingAt(MORNING_13, "scheduled");
			const zephyr = await memberIdOf("Zéphyr Ashlowe");
			await testDb.insert(meetingAttendancePlan).values({
				meetingId: adoptId,
				memberId: zephyr,
				status: "not_coming",
			});
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const { report } = await applyUp(stored.importId, resolutions);
			expect(await createdMeeting()).toBe(adoptId);
			expect(
				(await slotRows(adoptId)).filter((x) => x.assignedMemberId === zephyr),
			).toEqual([]);
			expect(omissionRow(report, UPCOMING_NOT_COMING)).toBeTruthy();
			expect(
				(await planRows(adoptId)).find((r) => r.memberId === zephyr)?.status,
			).toBe("not_coming");
		});

		// protects=RSVPs are written once, on the apply that first brings the meeting over, and never over a member's own row; a re-apply does not revive an answer that was cleared;
		// fails_when=every apply of a meeting writes its RSVPs, or an existing row is overwritten;
		// no_claim=which statuses map where (the plan unit tests).
		it("writes RSVPs on the first apply only and never over a member's own (R4)", async () => {
			const adoptId = await seedMeetingAt(MORNING_13, "scheduled");
			const kai = await memberIdOf("Kai Larkspur");
			const elliot = await memberIdOf("Elliot Tansley");
			await testDb.insert(meetingAttendancePlan).values({
				meetingId: adoptId,
				memberId: kai,
				status: "reached_out",
			});
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			await applyUp(stored.importId, resolutions);
			const first = await planRows(adoptId);
			expect(first.find((r) => r.memberId === kai)?.status).toBe("reached_out");
			expect(first.find((r) => r.memberId === elliot)?.status).toBe(
				"not_coming",
			);
			await testDb
				.delete(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.meetingId, adoptId),
						eq(meetingAttendancePlan.memberId, elliot),
					),
				);
			await applyUp(stored.importId, resolutions);
			expect(
				(await planRows(adoptId)).find((r) => r.memberId === elliot),
			).toBeUndefined();
		});

		// protects=a meeting that appears on the day after the plan said `create` is adopted, and the holders are placed again by the same rules: into ITS empty slots, a Skip answer drops the overflow, no slot is added, and the time difference is noted;
		// fails_when=the writer keeps the plan's `create` and inserts the unfound slots (duplicates), or ignores Skip, or leaves the time note out;
		// no_claim=the plain adopt (the first upcoming test).
		it("places the holders again in a meeting that appeared under the lock (R7, S2)", async () => {
			const timer = await timerDefId();
			const oakley = await addMember("Oakley Oakenshaw");
			const val = await addMember("Val Foxglade");
			let appeared = "";
			lockHook.run = async (tx, call) => {
				if (call !== 2) return;
				const t = tx as typeof testDb;
				const [m] = await t
					.insert(meetings)
					.values({
						clubId: seed.clubId,
						scheduledAt: MORNING_13,
						status: "scheduled",
					})
					.returning({ id: meetings.id });
				appeared = m?.id as string;
				await t.insert(roleSlots).values({
					meetingId: appeared,
					roleDefinitionId: timer,
					slotIndex: 0,
					status: "open",
				});
			};
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			const { report } = await applyUp(stored.importId, resolutions, {
				upcoming: { include: true, skipRoles: ["std:timer"] },
			});
			lockHook.run = null;
			expect(appeared).not.toBe("");
			expect(await createdMeeting()).toBe(appeared);
			const timers = (await slotRows(appeared)).filter(
				(x) => x.roleDefinitionId === timer,
			);
			// One slot, Oakley in it; Val (the overflow) dropped by Skip, no slot added.
			expect(timers).toHaveLength(1);
			expect(timers[0]?.assignedMemberId).toBe(oakley);
			expect(timers.some((x) => x.assignedMemberId === val)).toBe(false);
			expect(omissionRow(report, UPCOMING_ROLES_SKIPPED)).toBeTruthy();
			// No second meeting on that date.
			expect(
				await testDb
					.select({ id: meetings.id })
					.from(meetings)
					.where(
						and(
							eq(meetings.clubId, seed.clubId),
							eq(meetings.scheduledAt, new Date("2026-10-14T02:00:00.000Z")),
						),
					),
			).toEqual([]);
			expect(report.upcomingNotes?.some((n) => n.includes("stands"))).toBe(
				true,
			);
		});

		// protects=a slot claimed between the writer's read under the lock and its UPDATE stays with the claimant, and the report says "Kept GavelUp's holder";
		// fails_when=the UPDATE does not carry the "still empty" predicate;
		// no_claim=a claim made before the plan (the "does not displace" test).
		it("keeps a slot claimed between the locked read and the write (T3)", async () => {
			const timer = await timerDefId();
			await addMember("Oakley Oakenshaw");
			const parker = await memberIdOf("Parker Vexford");
			const adoptId = await seedMeetingAt(MORNING_13, "scheduled");
			await testDb.insert(roleSlots).values({
				meetingId: adoptId,
				roleDefinitionId: timer,
				slotIndex: 0,
				status: "open",
			});
			let claimed = false;
			realLogic.importTestHooks.beforeUpcomingSlotWrite = async (slotId) => {
				const [row] = await testDb
					.select()
					.from(roleSlots)
					.where(eq(roleSlots.id, slotId));
				if (claimed || row?.meetingId !== adoptId) return;
				claimed = true;
				await testDb
					.update(roleSlots)
					.set({ assignedMemberId: parker, status: "confirmed" })
					.where(eq(roleSlots.id, slotId));
			};
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			let report: Rep;
			try {
				({ report } = await applyUp(stored.importId, resolutions));
			} finally {
				realLogic.importTestHooks.beforeUpcomingSlotWrite = undefined;
			}
			expect(claimed).toBe(true);
			const slot = (await slotRows(adoptId)).find(
				(x) => x.roleDefinitionId === timer && x.slotIndex === 0,
			);
			expect(slot?.assignedMemberId).toBe(parker);
			expect(omissionRow(report, UPCOMING_KEPT_HOLDER)).toBeTruthy();
		});

		// protects=a speech ref that points at another person's speech is not trusted: a new speech is made for the holder and the ref is moved to it;
		// fails_when=the ref is only checked to exist;
		// no_claim=a deleted speech (next test).
		it("mints a new speech when the ref points at someone else's (R9)", async () => {
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			await applyUp(stored.importId, resolutions);
			const meetingId = await createdMeeting();
			const ironvale = await memberIdOf("Zephyr Ironvale");
			const slot = (await slotRows(meetingId)).find(
				(x) => x.assignedMemberId === ironvale && x.speechId,
			);
			expect(slot).toBeTruthy();
			const oldSpeech = slot?.speechId as string;
			const refBefore = (await refsOfKind("speech")).find(
				(r) => r.targetId === oldSpeech,
			);
			expect(refBefore).toBeTruthy();
			// The speech is now someone else's, and the slot has none.
			const parkerPerson = (
				await testDb
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, await memberIdOf("Parker Vexford")))
			)[0]?.personId as string;
			await testDb
				.update(speeches)
				.set({ personId: parkerPerson })
				.where(eq(speeches.id, oldSpeech));
			await testDb
				.update(roleSlots)
				.set({ speechId: null })
				.where(eq(roleSlots.id, slot?.id as string));
			await applyUp(stored.importId, resolutions);
			const after = (await slotRows(meetingId)).find((x) => x.id === slot?.id);
			expect(after?.speechId).toBeTruthy();
			expect(after?.speechId).not.toBe(oldSpeech);
			const refAfter = (await refsOfKind("speech")).find(
				(r) => r.sourceId === refBefore?.sourceId,
			);
			expect(refAfter?.targetId).toBe(after?.speechId);
			// Parker keeps the speech that was theirs.
			const [theirs] = await testDb
				.select({ personId: speeches.personId })
				.from(speeches)
				.where(eq(speeches.id, oldSpeech));
			expect(theirs?.personId).toBe(parkerPerson);
		});

		// protects=an upcoming slot gets its speech (a title-less one too), the evaluator link, and the meeting's blank location and join link; a speech deleted since is not made again and is reported;
		// fails_when=the upcoming writer skips the speech or evaluator branch, or fills a field that is not blank;
		// no_claim=a speech whose ref belongs to someone else (the test above).
		it("creates speeches, links evaluators and fills blanks on an upcoming meeting (T1)", async () => {
			const adoptId = await seedMeetingAt(MORNING_13, "scheduled");
			await testDb
				.update(meetings)
				.set({ theme: "Kept theme" })
				.where(eq(meetings.id, adoptId));
			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			await applyUp(stored.importId, resolutions);
			const [row] = await testDb
				.select({
					location: meetings.location,
					joinUrl: meetings.joinUrl,
					theme: meetings.theme,
				})
				.from(meetings)
				.where(eq(meetings.id, adoptId));
			expect(row).toEqual({
				location: "Fixture Hall",
				joinUrl: "https://example.test/join/fixture",
				theme: "Kept theme",
			});
			const ironvale = await memberIdOf("Zephyr Ironvale");
			const slots = await slotRows(adoptId);
			const speaker = slots.find((x) => x.assignedMemberId === ironvale);
			expect(speaker?.speechId).toBeTruthy();
			const blair = await memberIdOf("Blair Yarrowby");
			const evaluator = slots.find((x) => x.assignedMemberId === blair);
			expect(evaluator?.evaluatesSlotId).toBe(speaker?.id);
			// Delete the speech: the slot loses it, and a re-apply does not make it again.
			await testDb
				.delete(speeches)
				.where(eq(speeches.id, speaker?.speechId as string));
			const { report } = await applyUp(stored.importId, resolutions);
			const again = (await slotRows(adoptId)).find((x) => x.id === speaker?.id);
			expect(again?.speechId).toBeNull();
			expect(
				report.notImported.some((r) => r.sourceIds?.includes("1473488")),
			).toBe(true);
		});

		// protects=with a club default agenda a created meeting carries a copy of it (template_id set) and exactly the slots the preview promised, a Joke Master among them, and a change of the default after the preview is a changed plan;
		// fails_when=the created meeting ignores the default, the preview's shape and the written slots differ, or the shape is not in the plan's hash;
		// no_claim=a club with no default (the other upcoming tests).
		it("shapes a created meeting like the club default agenda (S4, R6)", async () => {
			await testDb.delete(meetings).where(eq(meetings.clubId, seed.clubId));
			await testDb
				.delete(roleDefinitions)
				.where(eq(roleDefinitions.clubId, seed.clubId));
			await testDb
				.insert(roleDefinitions)
				.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: seed.clubId })));
			await testDb.insert(roleDefinitions).values({
				clubId: seed.clubId,
				name: "Joke Master",
				key: "joke_master",
				category: "functionary",
				isSpeakerRole: false,
			});
			const [tpl] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: seed.clubId,
					meetingId: null,
					key: `default-${randomUUID().slice(0, 8)}`,
					name: "Club default",
				})
				.returning({ id: meetingTemplates.id });
			const templateId = tpl?.id as string;
			const declared = [
				...ROLE_TEMPLATE.filter((r) =>
					["toastmaster_of_the_day", "timer"].includes(r.key),
				),
				{
					key: "joke_master",
					name: "Joke Master",
					category: "functionary" as const,
					defaultCount: 1,
					isSpeakerRole: false,
				},
			];
			await testDb.insert(meetingTemplateRoles).values(
				declared.map((r, i) => ({
					templateId,
					key: r.key,
					name: r.name,
					category: r.category,
					defaultCount: r.defaultCount,
					isSpeakerRole: r.isSpeakerRole,
					sortOrder: i,
				})),
			);
			await setClubDefaultTemplate({
				clubId: seed.clubId,
				templateId,
				actorMemberId: null,
			});

			const stored = await upload(upcomingText());
			const { resolutions } = await resolveAll(stored.importId);
			// Every role the default has no slot for is Skipped, so the meeting's slots
			// are the shape alone (an Add answer would put the extra ones on top).
			const open = await previewUp(stored.importId, resolutions);
			const skipAll = {
				include: true,
				skipRoles: open.upcoming.unslottedRoles.map((r) => r.planKey),
			};
			const preview = await previewUp(stored.importId, resolutions, skipAll);
			expect(preview.upcoming.shape.length).toBe(3);

			// The default gains a role nobody holds (so no holder moves) after the preview:
			// only the shape differs, and the hash must still be stale.
			await testDb.insert(meetingTemplateRoles).values({
				templateId,
				key: "ah_counter",
				name: "Ah-Counter",
				category: "functionary",
				defaultCount: 1,
				sortOrder: 9,
			});
			const changed = await previewUp(stored.importId, resolutions, skipAll);
			expect(changed.planHash).not.toBe(preview.planHash);
			await expect(
				applyUp(stored.importId, resolutions, {
					planHash: preview.planHash,
					upcoming: skipAll,
				}),
			).rejects.toThrow(realLogic.PLAN_CHANGED_MESSAGE);

			await applyUp(stored.importId, resolutions, {
				planHash: changed.planHash,
				upcoming: skipAll,
			});
			const meetingId = await createdMeeting();
			const [row] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(row?.templateId).not.toBeNull();
			expect(row?.templateId).not.toBe(templateId);
			const perRole = new Map<string, number>();
			for (const x of await slotRows(meetingId)) {
				perRole.set(
					x.roleDefinitionId,
					(perRole.get(x.roleDefinitionId) ?? 0) + 1,
				);
			}
			expect([...perRole].sort((a, b) => a[0].localeCompare(b[0]))).toEqual(
				changed.upcoming.shape,
			);
			// The Joke Master slot is held by Easy-Speak's Joke Master.
			const [joke] = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, seed.clubId),
						eq(roleDefinitions.key, "joke_master"),
					),
				);
			const dana = await memberIdOf("Dana Vexford");
			expect(
				(await slotRows(meetingId)).find((x) => x.roleDefinitionId === joke?.id)
					?.assignedMemberId,
			).toBe(dana);
		});
	});
	describe("email match and close names (#1493)", () => {
		const ROBERT_EMAIL = "robert.nickname@example.test";

		/** The fixture plus Easy-Speak's "Bob Smith" on the member list. */
		const bobBundleText = () => {
			const bundle = JSON.parse(bundleText()) as EasySpeakBundleV1;
			bundle.people.push({
				esUserId: "910001",
				name: "Bob Smith",
				status: "Member",
				joined: "2025-02-03",
			});
			return JSON.stringify(bundle);
		};
		const addRobert = async () => {
			const [person] = await testDb
				.insert(people)
				.values({ name: "Robert Smith", email: ROBERT_EMAIL })
				.returning({ id: people.id });
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person?.id as string,
					name: "Robert Smith",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			return member?.id as string;
		};
		const memberCount = async () =>
			Number(
				(
					await testDb
						.select({ n: count() })
						.from(members)
						.where(eq(members.clubId, seed.clubId))
				)[0]?.n ?? 0,
			);
		const rowOf = async (memberId: string) =>
			(await testDb.select().from(members).where(eq(members.id, memberId)))[0];

		// protects=a possible match blocks the apply; `create` adds exactly one member and leaves Robert's row as it was; `member` adds none;
		// fails_when=the apply goes ahead unanswered, `create` also touches Robert, or `member` still creates;
		// no_claim=the extension's real bundle; the member list row is hand-added to the B fixture.
		it("refuses while a possible match is unanswered, then creates or links", async () => {
			const robert = await addRobert();
			const stored = await upload(bobBundleText());
			const { preview, resolutions } = await resolveAll(stored.importId);
			const bob = preview.people.find((p) => p.key === "es:910001");
			expect(bob?.status).toBe("possible_match");
			expect(bob?.candidates.map((c) => c.memberId)).toEqual([robert]);
			expect(preview.canApply).toBe(false);
			const before = await memberCount();
			const made = (p: typeof preview) =>
				p.counts.newActiveMembers + p.counts.newFormerMembers;
			const ifCreated = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				now: NOW,
				resolutions: { ...resolutions, "es:910001": { action: "create" } },
			});
			const ifLinked = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				now: NOW,
				resolutions: {
					...resolutions,
					"es:910001": { action: "member", memberId: robert },
				},
			});
			expect(made(ifCreated)).toBe(made(ifLinked) + 1);
			const robertBefore = await rowOf(robert);
			await expect(apply(stored.importId, resolutions)).rejects.toThrow(
				logic.UNRESOLVED_PEOPLE_MESSAGE(1),
			);
			expect(await memberCount()).toBe(before);
			await apply(stored.importId, {
				...resolutions,
				"es:910001": { action: "create" },
			});
			expect(await memberCount()).toBe(before + made(ifCreated));
			expect(await rowOf(robert)).toEqual(robertBefore);
		});

		it("links to the member when answered, creating nobody", async () => {
			const robert = await addRobert();
			const stored = await upload(bobBundleText());
			const { resolutions } = await resolveAll(stored.importId);
			const before = await memberCount();
			const answers = {
				...resolutions,
				"es:910001": { action: "member" as const, memberId: robert },
			};
			const planned = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				now: NOW,
				resolutions: answers,
			});
			await apply(stored.importId, answers);
			expect(await memberCount()).toBe(
				before +
					planned.counts.newActiveMembers +
					planned.counts.newFormerMembers,
			);
		});

		// protects=a pasted address links the nickname member with no question, the apply remembers it as a ref, and the next preview matches by ref with no contacts;
		// fails_when=the loaded roster emails are not read, the ref is not written, or the address lands in the stored report;
		// no_claim=more than one club; the roster email comes from a real people row.
		it("links by pasted email, writes the ref, and re-matches by ref afterwards", async () => {
			const robert = await addRobert();
			const stored = await upload(bobBundleText());
			const contacts = `Bob Smith, ${ROBERT_EMAIL}, `;
			const { resolutions } = await resolveAll(stored.importId);
			const preview = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				now: NOW,
				contacts,
				resolutions,
			});
			const bob = preview.people.find((p) => p.key === "es:910001");
			expect(bob).toMatchObject({
				status: "member",
				via: "email",
				memberId: robert,
			});
			const before = await memberCount();
			const others =
				preview.counts.newActiveMembers + preview.counts.newFormerMembers;
			await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				contacts,
				planHash: preview.planHash,
				upcoming: NO_UPCOMING,
				now: NOW,
			});
			expect(await memberCount()).toBe(before + others);
			const refs = await testDb
				.select()
				.from(importRefs)
				.where(
					and(
						eq(importRefs.clubId, seed.clubId),
						eq(importRefs.sourceId, "es:910001"),
					),
				);
			expect(refs.map((r) => r.targetId)).toEqual([robert]);
			const again = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				now: NOW,
			});
			expect(again.people.find((p) => p.key === "es:910001")).toMatchObject({
				status: "member",
				via: "ref",
				memberId: robert,
			});
			const report = await logic.loadImportReport({ clubId: seed.clubId });
			expect(JSON.stringify(report)).not.toContain(ROBERT_EMAIL);
		});
	});
});

// The number rules are pure: they run without a database.
describe("bundleClubMismatch (#1492)", () => {
	const bundleClub = { esClubId: "1", name: "Alpha", number: "0012345" };
	// protects=the first-import club number rule: leading zeros and padding are
	// not a difference, a different number is refused with the sentence;
	// fails_when=normalizeClubNumber is dropped or the refusal wording changes;
	// no_claim=the bound arm (the later tests).
	it("accepts a number that differs only by leading zeros and refuses a different one", () => {
		expect(logic.bundleClubMismatch(bundleClub, "12345", null)).toBeNull();
		expect(logic.bundleClubMismatch(bundleClub, " 12345 ", null)).toBeNull();
		expect(logic.bundleClubMismatch(bundleClub, "67890", null)).toBe(
			"This export is from Easy-Speak club Alpha (#0012345), but this club's number is 67890.",
		);
	});
	// protects=a missing number on either side never refuses a first import;
	// fails_when=a null number is treated as a mismatch;
	// no_claim=the bound arm.
	it("accepts either side without a number", () => {
		expect(
			logic.bundleClubMismatch({ ...bundleClub, number: null }, "1", null),
		).toBeNull();
		expect(logic.bundleClubMismatch(bundleClub, null, null)).toBeNull();
	});
	// protects=once bound, only the Easy-Speak club id decides (the number is
	// ignored) and the refusal names the bundle's club and the bound one;
	// fails_when=the bound arm compares numbers, or names the wrong club;
	// no_claim=how the bound club is found (the integration suite).
	it("once bound, compares only the Easy-Speak club id, never the number", () => {
		const bound = { esClubId: "1", name: "Beta", number: null };
		expect(
			logic.bundleClubMismatch({ ...bundleClub, number: "9" }, "5", bound),
		).toBeNull();
		expect(
			logic.bundleClubMismatch(
				{ ...bundleClub, esClubId: "2" },
				"12345",
				bound,
			),
		).toBe(
			"This export is from Alpha, not Beta, the Easy-Speak club this club was imported from.",
		);
	});
	// protects=the override passes both the number and the bound check and reports
	// whether it overrode anything; without it the refusal is thrown;
	// fails_when=override is ignored, or reports overrode:true on a match;
	// no_claim=who may pass the flag (the authz tests).
	it("the override skips both checks and reports that it did", () => {
		expect(
			logic.assertBundleMatchesClub(bundleClub, "67890", null, true),
		).toEqual({ overrode: true });
		expect(() =>
			logic.assertBundleMatchesClub(bundleClub, "67890", null, false),
		).toThrow(/This export is from/);
		expect(
			logic.assertBundleMatchesClub(bundleClub, "12345", null, true),
		).toEqual({ overrode: false });
	});
});

// protects=the server's binding refusals are recognised by the SHARED marker the
// import panel keys its override checkbox on, both arms, and an unrelated
// refusal is not;
// fails_when=either message is reworded away from BINDING_REFUSAL_PREFIX, or the
// panel's matcher drifts from it;
// no_claim=the checkbox's rendering (the panel test).
describe("binding refusal marker (#1492)", () => {
	const club = { esClubId: "1", name: "Alpha", number: "0012345" };
	it("is the start of both refusal messages", () => {
		const first = logic.bundleClubMismatch(club, "67890", null) as string;
		const bound = logic.bundleClubMismatch({ ...club, esClubId: "2" }, "1", {
			esClubId: "1",
			name: "Beta",
			number: null,
		}) as string;
		expect(isBindingRefusal(first)).toBe(true);
		expect(isBindingRefusal(bound)).toBe(true);
		expect(isBindingRefusal("That file is not valid JSON.")).toBe(false);
	});
});
