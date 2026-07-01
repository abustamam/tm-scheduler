/**
 * Test-only Drizzle client + seed/cleanup helpers.
 *
 * NEVER import the production `db` from `#/db` here — this module reads
 * `TEST_DATABASE_URL` so tests never accidentally touch dev/prod data.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "#/db/schema";
import {
	clubMemberships,
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";

/**
 * True only when a test database URL is configured. Integration suites gate on
 * this (`describe.skipIf(!hasTestDb)`) so a plain `vitest run` with no DB skips
 * them instead of failing. NEVER fall back to the production `DATABASE_URL`.
 */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

// Build the client without throwing at module load so importing this file never
// fails when TEST_DATABASE_URL is unset. The placeholder URL is never connected
// to: gated suites run no queries when `hasTestDb` is false.
export const testDb = drizzle(
	process.env.TEST_DATABASE_URL ?? "postgresql://invalid",
	{ schema },
);

export interface SeededClub {
	clubId: string;
	adminUserId: string;
	memberUserId: string;
	memberId: string; // roster member linked to memberUserId
	roleDefinitionId: string;
	meetingId: string;
	slotId: string;
}

/** Internal registry — populated by seedClub(), drained by zero-arg cleanup(). */
const _seededClubs: SeededClub[] = [];

/** Insert a minimal club fixture and return the ids. */
export async function seedClub(): Promise<SeededClub> {
	const clubId = randomUUID();
	const adminUserId = randomUUID();
	const memberUserId = randomUUID();

	// club
	await testDb.insert(clubs).values({
		id: clubId,
		name: "Test Club",
	});

	// users
	await testDb.insert(user).values([
		{
			id: adminUserId,
			name: "Admin User",
			email: `admin-${adminUserId}@test.example`,
			emailVerified: true,
		},
		{
			id: memberUserId,
			name: "Member User",
			email: `member-${memberUserId}@test.example`,
			emailVerified: true,
		},
	]);

	// memberships
	await testDb.insert(clubMemberships).values([
		{
			userId: adminUserId,
			clubId,
			clubRole: "admin",
			status: "active",
		},
		{
			userId: memberUserId,
			clubId,
			clubRole: "member",
			status: "active",
		},
	]);

	// roster member linked to memberUserId
	const [memberRow] = await testDb
		.insert(members)
		.values({
			clubId,
			name: "Member User",
			email: `member-${memberUserId}@test.example`,
			userId: memberUserId,
		})
		.returning({ id: members.id });

	if (!memberRow) {
		throw new Error("Failed to insert member");
	}

	// role definition (non-speaker, e.g. Timer)
	const [roleDef] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Timer",
			category: "functionary",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });

	if (!roleDef) {
		throw new Error("Failed to insert role definition");
	}

	// meeting
	const [meeting] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date("2026-07-01T19:00:00Z"),
			status: "scheduled",
		})
		.returning({ id: meetings.id });

	if (!meeting) {
		throw new Error("Failed to insert meeting");
	}

	// one open role slot
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: meeting.id,
			roleDefinitionId: roleDef.id,
			status: "open",
		})
		.returning({ id: roleSlots.id });

	if (!slot) {
		throw new Error("Failed to insert role slot");
	}

	const result: SeededClub = {
		clubId,
		adminUserId,
		memberUserId,
		memberId: memberRow.id,
		roleDefinitionId: roleDef.id,
		meetingId: meeting.id,
		slotId: slot.id,
	};
	_seededClubs.push(result);
	return result;
}

/**
 * Delete all rows created by `seedClub` for the given club.
 * The club cascade handles meetings, slots, role defs, memberships, and members.
 * Users must be deleted separately because they are referenced across clubs.
 *
 * Call with no arguments (afterEach(cleanup)) to clean up all clubs seeded via
 * seedClub() in the current test. Call with explicit ids to target a specific club.
 */
export async function cleanup(): Promise<void>;
export async function cleanup(clubId: string, userIds: string[]): Promise<void>;
// Use default values so the compiled fn has .length === 0 — Vitest injects
// a done-callback into afterEach callbacks whose .length > 0 (legacy compat).
export async function cleanup(
	clubId = "",
	userIds: string[] = [],
): Promise<void> {
	if (typeof clubId !== "string" || !clubId) {
		// Zero-arg form: drain the internal registry
		const toClean = _seededClubs.splice(0);
		for (const c of toClean) {
			await testDb.delete(clubs).where(eq(clubs.id, c.clubId));
		}
		const allUserIds = toClean.flatMap((c) => [c.adminUserId, c.memberUserId]);
		if (allUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, allUserIds));
		}
		return;
	}
	// Explicit form: clean up a specific club
	await testDb.delete(clubs).where(eq(clubs.id, clubId));
	if (userIds.length > 0) {
		await testDb.delete(user).where(inArray(user.id, userIds));
	}
}
