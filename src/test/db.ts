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
	people,
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
	personId: string; // person the seeded roster member belongs to
	memberId: string; // roster member linked to memberUserId
	roleDefinitionId: string;
	meetingId: string;
	slotId: string;
}

/**
 * Insert a Person and return its id. Every roster member belongs to a person
 * (ADR-0008 / #64); tests that insert extra members need a person first.
 */
export async function seedPerson(overrides?: {
	name?: string;
	email?: string | null;
	customerId?: string | null;
	userId?: string | null;
}): Promise<string> {
	const [row] = await testDb
		.insert(people)
		.values({
			name: overrides?.name ?? "Test Person",
			email: overrides?.email ?? null,
			customerId: overrides?.customerId ?? null,
			userId: overrides?.userId ?? null,
		})
		.returning({ id: people.id });
	if (!row) throw new Error("Failed to insert person");
	return row.id;
}

/** Insert a minimal club fixture and return the ids. */
export async function seedClub(): Promise<SeededClub> {
	const clubId = randomUUID();
	const adminUserId = randomUUID();
	const memberUserId = randomUUID();

	// club
	await testDb.insert(clubs).values({
		id: clubId,
		name: "Test Club",
		slug: `test-club-${clubId}`,
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

	// person for the roster member (ADR-0008: every membership has a person)
	const [personRow] = await testDb
		.insert(people)
		.values({
			name: "Member User",
			email: `member-${memberUserId}@test.example`,
			userId: memberUserId,
		})
		.returning({ id: people.id });

	if (!personRow) {
		throw new Error("Failed to insert person");
	}

	// roster member linked to memberUserId
	const [memberRow] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: personRow.id,
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
			// Always in the future so "upcoming meeting" queries include it
			// regardless of when the suite runs (avoids a wall-clock time bomb).
			scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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

	return {
		clubId,
		adminUserId,
		memberUserId,
		personId: personRow.id,
		memberId: memberRow.id,
		roleDefinitionId: roleDef.id,
		meetingId: meeting.id,
		slotId: slot.id,
	};
}

/**
 * Delete all rows created by `seedClub` for the given club.
 * The club cascade handles meetings, slots, role defs, memberships, and members.
 * People are club-less (ADR-0008), so the club cascade does NOT remove them —
 * collect the person ids from this club's members first, then delete them after
 * the cascade. Users must be deleted separately (referenced across clubs).
 */
export async function cleanup(
	clubId: string,
	userIds: string[],
): Promise<void> {
	// person ids to remove — captured before the cascade deletes the members.
	const memberPeople = await testDb
		.select({ personId: members.personId })
		.from(members)
		.where(eq(members.clubId, clubId));
	const personIds = [...new Set(memberPeople.map((m) => m.personId))];

	// club cascade removes meetings, role_slots, role_definitions, club_memberships, members
	await testDb.delete(clubs).where(eq(clubs.id, clubId));
	// people are club-less; delete the ones this club's members belonged to
	if (personIds.length > 0) {
		await testDb.delete(people).where(inArray(people.id, personIds));
	}
	// delete test users
	if (userIds.length > 0) {
		await testDb.delete(user).where(inArray(user.id, userIds));
	}
}
