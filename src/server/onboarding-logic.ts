// Superadmin onboarding-console DB logic (#182), split out from the
// createServerFn wrappers in `onboarding.ts`. These are plain, directly
// integration-testable functions — the wrappers need the Start runtime for the
// session/superadmin gate. They MUST live here, away from the server-fn module,
// because `onboarding.ts` is imported by the client route files: the Start
// compiler strips the createServerFn handler bodies (and their `db` imports)
// from the client bundle, but a plain db-touching export sitting in that same
// module is NOT stripped and drags `pg` → `Buffer` into the browser
// (ReferenceError: Buffer is not defined). See `members-logic.ts` and
// `server-modules.guard.test.ts`.
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, members, people, roleDefinitions } from "#/db/schema";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { slugify } from "#/lib/slug";

// A transaction handle (or the base db) — both expose the query builder we use.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// List view — every club with member count + first-admin claim status.
// ---------------------------------------------------------------------------

export interface ConsoleAdmin {
	name: string;
	email: string | null;
	/** Whether the admin's Person is linked to a sign-in account (user_id set). */
	linked: boolean;
}

export interface ConsoleClubRow {
	clubId: string;
	name: string;
	clubNumber: string | null;
	memberCount: number;
	createdAt: Date;
	/** Soft-archive timestamp (ADR-0016 / #186); null = active. Archived clubs
	 *  stay listed in the console, marked archived, with an Unarchive action. */
	archivedAt: Date | null;
	firstAdmin: ConsoleAdmin | null;
}

/**
 * All clubs for the superadmin console: name, club number, member count, first
 * admin (name/email + whether their account is linked yet), and created date.
 * "First admin" is the earliest-created admin membership in the club (the one
 * provisioned at onboarding). The caller enforces the superadmin gate.
 */
export async function listClubsForConsole(): Promise<ConsoleClubRow[]> {
	const clubRows = await db
		.select({
			id: clubs.id,
			name: clubs.name,
			clubNumber: clubs.clubNumber,
			createdAt: clubs.createdAt,
			archivedAt: clubs.archivedAt,
		})
		.from(clubs)
		.orderBy(asc(clubs.createdAt));

	const counts = await db
		.select({
			clubId: members.clubId,
			count: sql<number>`count(*)::int`,
		})
		.from(members)
		.groupBy(members.clubId);
	const countByClub = new Map(counts.map((c) => [c.clubId, c.count]));

	// Earliest admin membership per club → its Person (the provisioned first admin).
	const adminRows = await db
		.select({
			clubId: members.clubId,
			name: people.name,
			email: people.email,
			userId: people.userId,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.clubRole, "admin"))
		.orderBy(asc(members.clubId), asc(members.createdAt), asc(members.id));
	const firstAdminByClub = new Map<string, ConsoleAdmin>();
	for (const row of adminRows) {
		if (firstAdminByClub.has(row.clubId)) continue; // keep the earliest
		firstAdminByClub.set(row.clubId, {
			name: row.name,
			email: row.email,
			linked: row.userId != null,
		});
	}

	return clubRows.map((c) => ({
		clubId: c.id,
		name: c.name,
		clubNumber: c.clubNumber,
		memberCount: countByClub.get(c.id) ?? 0,
		createdAt: c.createdAt,
		archivedAt: c.archivedAt,
		firstAdmin: firstAdminByClub.get(c.id) ?? null,
	}));
}

// ---------------------------------------------------------------------------
// Detail view — one club plus its first admin (with the Person id, so the email
// edit can target it).
// ---------------------------------------------------------------------------

export interface ConsoleClubDetail {
	clubId: string;
	name: string;
	clubNumber: string | null;
	slug: string;
	createdAt: Date;
	/** Soft-archive timestamp (ADR-0016 / #186); null = active. Drives the
	 *  console's Archive/Unarchive control. */
	archivedAt: Date | null;
	memberCount: number;
	firstAdmin: {
		personId: string;
		name: string;
		email: string | null;
		linked: boolean;
	} | null;
}

/** One club's detail for the console, including its first admin's Person id and
 *  claim status (so the UI can offer the unclaimed-email edit). The caller
 *  enforces the superadmin gate. Throws when the club does not exist. */
export async function getClubConsoleDetail(
	clubId: string,
): Promise<ConsoleClubDetail> {
	const [club] = await db
		.select({
			id: clubs.id,
			name: clubs.name,
			clubNumber: clubs.clubNumber,
			slug: clubs.slug,
			createdAt: clubs.createdAt,
			archivedAt: clubs.archivedAt,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");

	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(members)
		.where(eq(members.clubId, clubId));

	const admin = await firstAdminOf(clubId);

	return {
		clubId: club.id,
		name: club.name,
		clubNumber: club.clubNumber,
		slug: club.slug,
		createdAt: club.createdAt,
		archivedAt: club.archivedAt,
		memberCount: count,
		firstAdmin: admin
			? {
					personId: admin.personId,
					name: admin.name,
					email: admin.email,
					linked: admin.userId != null,
				}
			: null,
	};
}

/** The earliest-created admin membership in a club, joined to its Person. */
async function firstAdminOf(clubId: string) {
	const [row] = await db
		.select({
			personId: people.id,
			name: people.name,
			email: people.email,
			userId: people.userId,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(members.clubId, clubId), eq(members.clubRole, "admin")))
		.orderBy(asc(members.createdAt), asc(members.id))
		.limit(1);
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Create a club (atomic): club + standard role template + first admin.
// ---------------------------------------------------------------------------

export const createClubSchema = z.object({
	clubName: z.string().trim().min(1, "Club name is required."),
	clubNumber: z.string().trim().min(1, "Club number is required."),
	adminName: z.string().trim().min(1, "Admin name is required."),
	adminEmail: z
		.string()
		.trim()
		.toLowerCase()
		.email("A valid email is required."),
});
export type CreateClubInput = z.infer<typeof createClubSchema>;

export interface CreateClubResult {
	clubId: string;
	slug: string;
	personId: string;
	memberId: string;
}

/**
 * Provision a new club in ONE atomic transaction (#182):
 *   1. the `clubs` row (name + unique club number + a derived unique slug),
 *   2. the 8 standard `role_definitions` (ROLE_TEMPLATE) — a club is
 *      non-functional without them,
 *   3. the first admin: a `people` row (user_id LEFT NULL — #188 links it on
 *      first sign-in) + a `members` row with club_role=admin, status=active.
 *
 * Club number is REQUIRED and UNIQUE: a duplicate is rejected with a clear
 * error and NO partial writes (the whole transaction rolls back). The caller
 * enforces the superadmin gate.
 */
export async function createClubWithAdmin(
	input: CreateClubInput,
): Promise<CreateClubResult> {
	return db.transaction(async (tx) => {
		// Fail fast + clean on a duplicate number (the DB unique constraint is the
		// backstop for a concurrent race; this gives the friendly message).
		const [dupe] = await tx
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.clubNumber, input.clubNumber))
			.limit(1);
		if (dupe) {
			throw new Error(`A club with number ${input.clubNumber} already exists.`);
		}

		const slug = await uniqueSlug(tx, input.clubName);

		const [club] = await tx
			.insert(clubs)
			.values({
				name: input.clubName,
				slug,
				clubNumber: input.clubNumber,
			})
			.returning({ id: clubs.id, slug: clubs.slug });
		if (!club) throw new Error("Failed to create the club.");

		await tx
			.insert(roleDefinitions)
			.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.id })));

		const [person] = await tx
			.insert(people)
			.values({
				name: input.adminName,
				email: input.adminEmail,
				// user_id LEFT NULL on purpose — #188 links on first sign-in.
			})
			.returning({ id: people.id });
		if (!person) throw new Error("Failed to create the admin person.");

		const [member] = await tx
			.insert(members)
			.values({
				clubId: club.id,
				personId: person.id,
				name: input.adminName,
				email: input.adminEmail,
				clubRole: "admin",
				status: "active",
			})
			.returning({ id: members.id });
		if (!member) throw new Error("Failed to create the admin membership.");

		return {
			clubId: club.id,
			slug: club.slug,
			personId: person.id,
			memberId: member.id,
		};
	});
}

/** Derive a unique club slug from the name, suffixing `-2`, `-3`, … on
 *  collision. Runs inside the create transaction; the slug unique constraint is
 *  the backstop for a concurrent race. */
async function uniqueSlug(tx: Tx, name: string): Promise<string> {
	const root = slugify(name) || "club";
	let candidate = root;
	let n = 1;
	while (true) {
		const [existing] = await tx
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.slug, candidate))
			.limit(1);
		if (!existing) return candidate;
		n += 1;
		candidate = `${root}-${n}`;
	}
}

// ---------------------------------------------------------------------------
// Edit an UNCLAIMED admin's email (before their account is linked).
// ---------------------------------------------------------------------------

export const updateAdminEmailSchema = z.object({
	clubId: z.string().uuid(),
	email: z.string().trim().toLowerCase().email("A valid email is required."),
});
export type UpdateAdminEmailInput = z.infer<typeof updateAdminEmailSchema>;

/**
 * Correct the first admin's email while their Person is still UNLINKED
 * (`user_id IS NULL`) — on their next sign-in, #188's linking claims the Person
 * by this email. REFUSED once the Person is linked: re-pointing a claimed
 * account is the broader capability in #187 (out of scope). The caller enforces
 * the superadmin gate. Throws when the club or its admin can't be found, or the
 * admin is already linked.
 */
export async function updateUnclaimedAdminEmail(
	input: UpdateAdminEmailInput,
): Promise<{ ok: true; personId: string }> {
	const admin = await firstAdminOf(input.clubId);
	if (!admin) throw new Error("This club has no admin to edit.");
	if (admin.userId != null) {
		throw new Error(
			"This admin has already claimed their account — their email can't be edited here.",
		);
	}

	await db
		.update(people)
		.set({ email: input.email })
		.where(eq(people.id, admin.personId));

	return { ok: true, personId: admin.personId };
}

// ---------------------------------------------------------------------------
// Soft-archive / unarchive a club (ADR-0016 / #186).
// ---------------------------------------------------------------------------

/**
 * Soft-archive a club: set `archived_at` so the club becomes inaccessible
 * everywhere except the superadmin console (`requireMembership` rejects authed
 * access; the public no-auth loaders return not-found). SOFT and REVERSIBLE — no
 * data is deleted and the slug/club number stay reserved. Re-archiving an
 * already-archived club is a no-op that preserves the original timestamp. The
 * caller enforces the superadmin gate. Throws when the club does not exist.
 */
export async function archiveClub(
	clubId: string,
): Promise<{ ok: true; archivedAt: Date }> {
	const [club] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");
	if (club.archivedAt) return { ok: true, archivedAt: club.archivedAt };

	const [updated] = await db
		.update(clubs)
		.set({ archivedAt: new Date() })
		.where(eq(clubs.id, clubId))
		.returning({ archivedAt: clubs.archivedAt });
	if (!updated?.archivedAt) throw new Error("Failed to archive the club.");
	return { ok: true, archivedAt: updated.archivedAt };
}

/**
 * Unarchive a club: clear `archived_at`, fully restoring authed + public access
 * with all prior data intact. The caller enforces the superadmin gate. Throws
 * when the club does not exist.
 */
export async function unarchiveClub(clubId: string): Promise<{ ok: true }> {
	const [updated] = await db
		.update(clubs)
		.set({ archivedAt: null })
		.where(eq(clubs.id, clubId))
		.returning({ id: clubs.id });
	if (!updated) throw new Error("Club not found.");
	return { ok: true };
}
