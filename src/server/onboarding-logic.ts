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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	clubs,
	members,
	oauthClient,
	pathEnrollments,
	pathLevelProgress,
	people,
	peopleEmailBackup,
	roleDefinitions,
	user,
	verification,
} from "#/db/schema";
import {
	CLUB_TIMEZONES,
	DEFAULT_CLUB_TIMEZONE,
	INVALID_TIMEZONE_MESSAGE,
	isSupportedClubTimezone,
} from "#/lib/club-timezone";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { slugify } from "#/lib/slug";
import { type RosterObstacle, rosterConflictFor } from "./account-link-logic";
import { findBestPersonByEmail } from "./people-logic";

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
	/** The club's IANA zone. Listed beside the number so a wrong pick at
	 *  provisioning is visible before the club has its first meeting (#716) —
	 *  after that, correcting it re-labels meetings that already exist. */
	timezone: string;
	memberCount: number;
	createdAt: Date;
	/** Soft-archive timestamp (ADR-0016 / #186); null = active. Archived clubs
	 *  stay listed in the console, marked archived, with an Unarchive action. */
	archivedAt: Date | null;
	firstAdmin: ConsoleAdmin | null;
}

export interface ConsoleClubList {
	clubs: ConsoleClubRow[];
	/**
	 * The zones the provisioning form may offer, shipped down with the payload
	 * rather than imported by the route (#716).
	 *
	 * This must be the SERVER's list, for the first failure `CLUB_TIMEZONES`'
	 * docblock names: two ICU builds disagree about which spelling of an alias
	 * pair is canonical — this Node lists `Asia/Calcutta` where a newer browser
	 * lists `Asia/Kolkata` — so a picker built from the BROWSER's list offers
	 * options this server rejects. The rejection is not even legible: the server
	 * fn's `.validator` throws a ZodError, whose `message` is a JSON issues
	 * array, so the console's toast prints that instead of
	 * `INVALID_TIMEZONE_MESSAGE`, and a retry re-picks the same unusable zone.
	 * Shipping the list from the side that VALIDATES removes the disagreement by
	 * construction, and keeps the `<option>` set identical across SSR and
	 * hydration as a second effect.
	 */
	zones: readonly string[];
	/**
	 * What the form starts on before the browser's own zone is known — the value
	 * the column default would have given. The route swaps in the browser zone
	 * after mount, but only if it appears in {@link zones}.
	 */
	defaultZone: string;
}

/**
 * All clubs for the superadmin console: name, club number, time zone, member
 * count, first admin (name/email + whether their account is linked yet), and
 * created date — plus the zone list the create form's picker renders.
 * "First admin" is the earliest-created admin membership in the club (the one
 * provisioned at onboarding). The caller enforces the superadmin gate.
 */
export async function listClubsForConsole(): Promise<ConsoleClubList> {
	const clubRows = await db
		.select({
			id: clubs.id,
			name: clubs.name,
			clubNumber: clubs.clubNumber,
			timezone: clubs.timezone,
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
			// The person-level address falling back to this club's roster row
			// (#756). Migration 0076 nulled `people.email` for everyone who has
			// never signed in, which is every admin this console exists to chase —
			// so reading the person column alone showed a blank address for exactly
			// the rows the operator is here to act on, next to a repair button that
			// WRITES the identity column. That invites typing an address back over
			// one the roster already holds correctly.
			email: sql<string | null>`coalesce(${people.email}, ${members.email})`,
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

	return {
		clubs: clubRows.map((c) => ({
			clubId: c.id,
			name: c.name,
			clubNumber: c.clubNumber,
			timezone: c.timezone,
			memberCount: countByClub.get(c.id) ?? 0,
			createdAt: c.createdAt,
			archivedAt: c.archivedAt,
			firstAdmin: firstAdminByClub.get(c.id) ?? null,
		})),
		zones: CLUB_TIMEZONES,
		defaultZone: DEFAULT_CLUB_TIMEZONE,
	};
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
			memberId: members.id,
			name: people.name,
			// Same coalesce as `listClubsForConsole`, for the same reason: this is
			// the value the repair form prefills, so reading the column 0076 clears
			// would have the operator retype an address the roster already holds.
			email: sql<string | null>`coalesce(${people.email}, ${members.email})`,
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
	/**
	 * REQUIRED at provisioning (#716/#670) rather than left to the column default.
	 * `clubs.timezone` is the axis every meeting instant, URL date key and
	 * deadline is measured against, and correcting it later re-labels meetings
	 * that already exist and can break links that were already shared (see
	 * `updateClubTimezone`) — so the cheapest moment to be right is before the
	 * club has any. A missing value is rejected with the same message an
	 * unsupported one gets: both mean "the console must pick a zone", and the
	 * server fn is addressable with no form, so the `<select>` constrains nobody.
	 */
	timezone: z
		.string({ error: INVALID_TIMEZONE_MESSAGE })
		.refine(isSupportedClubTimezone, { message: INVALID_TIMEZONE_MESSAGE }),
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
 *   2. the standard `role_definitions` (ROLE_TEMPLATE) — a club is
 *      non-functional without them,
 *   3. the first admin: reuses an existing Person on an email match (Rule B —
 *      "one human, one Person") via `findBestPersonByEmail`, else creates a
 *      fresh `people` row (user_id LEFT NULL — #188 links it on first
 *      sign-in) + a `members` row with club_role=admin, status=active.
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
				timezone: input.timezone,
			})
			.returning({ id: clubs.id, slug: clubs.slug });
		if (!club) throw new Error("Failed to create the club.");

		await tx
			.insert(roleDefinitions)
			.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.id })));

		// Reuse an existing Person on an email match (Rule B) so one human stays
		// one Person across clubs; otherwise create a fresh Person (#188 links it
		// on first sign-in). In-tx so a concurrent create sees a consistent view.
		let personId = await findBestPersonByEmail(input.adminEmail, tx);
		if (!personId) {
			const [person] = await tx
				.insert(people)
				.values({
					name: input.adminName,
					email: input.adminEmail,
					// user_id LEFT NULL on purpose — #188 links on first sign-in.
				})
				.returning({ id: people.id });
			if (!person) throw new Error("Failed to create the admin person.");
			personId = person.id;
		}

		const [member] = await tx
			.insert(members)
			.values({
				clubId: club.id,
				personId,
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
			personId,
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
 *
 * **Writes BOTH columns, and the membership one is the load-bearing half**
 * (#756). The sign-in auto-link matches `members.email`; `people.email` is the
 * verified identity address, and this is the one waiver to "only a bind writes
 * it" — the bootstrap case, where a club exists, nobody has signed in, and there
 * is therefore no verified address in existence to fall back on. Writing only
 * the Person row would leave this console reporting success while the admin
 * stayed locked out, which is precisely the silent half-failure the roster form
 * shipped and #756 removed. `person-email-writers.guard.test.ts` records the
 * waiver.
 */
export async function updateUnclaimedAdminEmail(
	input: UpdateAdminEmailInput,
): Promise<{
	ok: true;
	personId: string;
	/** The obstacle that would still stop this admin binding, or null. */
	rosterConflict: RosterObstacle | null;
}> {
	const admin = await firstAdminOf(input.clubId);
	if (!admin) throw new Error("This club has no admin to edit.");
	if (admin.userId != null) {
		throw new Error(
			"This admin has already claimed their account — their email can't be edited here.",
		);
	}

	await db.transaction(async (tx) => {
		await tx
			.update(members)
			.set({ email: input.email })
			.where(eq(members.id, admin.memberId));
		// `isNull(people.userId)` in the STATEMENT, not only in the check above.
		// The `admin.userId` read happens outside this transaction, so under READ
		// COMMITTED a sign-in that binds the Person in between would leave a LINKED
		// Person carrying a superadmin-typed address in place of the one a magic
		// link proved — breaking the invariant the whole release rests on, from the
		// one writer whose waiver claims it is safe.
		const moved = await tx
			.update(people)
			.set({ email: input.email })
			.where(and(eq(people.id, admin.personId), isNull(people.userId)))
			.returning({ id: people.id });
		if (moved.length === 0) {
			throw new Error(
				"This admin claimed their account while you were editing — their email can't be edited here.",
			);
		}
	});

	// Did the repair actually repair anything? This console's whole job is to get
	// an un-claimed first admin signed in, and writing both columns is not
	// sufficient on its own: if a second club also holds them, or another member
	// carries the same address, the bind still refuses and the admin stays locked
	// out — while this function returns `{ ok: true }`. That is verbatim the
	// silent half-failure the release exists to remove, on the one surface
	// specifically built to fix it.
	const rosterConflict = await rosterConflictFor(admin.personId, input.email);
	return { ok: true, personId: admin.personId, rosterConflict };
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

// ---------------------------------------------------------------------------
// Permanently delete an archived club (#914).
// ---------------------------------------------------------------------------

/** Validates the `deleteConsoleClub` payload. The name is compared exactly in
 *  `deleteClubPermanently`; the cap only bounds what the wire may carry. */
export const deleteClubSchema = z.object({
	clubId: z.string().uuid(),
	confirmName: z.string().max(500),
});

export interface DeleteClubResult {
	clubName: string;
	/** Persons of this club (current or former members) who held no other
	 *  membership, now deleted. */
	peopleDeleted: number;
	/** Persons of this club who hold a membership elsewhere, kept. */
	peopleKept: number;
	/** Sign-in accounts of deleted Persons, now deleted. */
	usersDeleted: number;
	/** Sign-in accounts of deleted Persons that were kept: another Person still
	 *  links to it, another club's logo or sync token names it, it owns an OAuth
	 *  client, or it is a superadmin. */
	usersKept: number;
}

/** Postgres's foreign-key violation. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Delete one sign-in account, or keep it when another club's row still names it.
 *
 * Two foreign keys to `user` are `NO ACTION` rather than CASCADE:
 * `club_logos.attested_by` and `sync_tokens.created_by`. By this point this
 * club's own rows are gone, so a reference that remains belongs to ANOTHER club,
 * and the account must stay. The delete runs in a SAVEPOINT and a foreign-key
 * violation rolls back just that savepoint: Postgres's own check is the source of
 * truth, so a NO ACTION reference added later is honoured without a list here to
 * keep in step. Any OTHER error is rethrown and rolls back the whole delete.
 *
 * Inside the same savepoint, once the account is gone, its pending sign-in
 * links go too (see `deleteVerificationsFor`) — only for an account actually
 * deleted, so a kept account's links are untouched.
 */
async function deleteUserUnlessReferenced(
	tx: Tx,
	u: { id: string; email: string },
): Promise<boolean> {
	try {
		await tx.transaction(async (sp) => {
			await sp.delete(user).where(eq(user.id, u.id));
			await deleteVerificationsFor(sp, u.email);
		});
		return true;
	} catch (err) {
		if (isForeignKeyViolation(err)) return false;
		throw err;
	}
}

/**
 * Better Auth's `verification` rows carry an email with no FK to `user`. The
 * magic-link plugin (better-auth 1.x, `plugins/magic-link`) stores
 * `identifier` = the (possibly hashed) token and `value` =
 * `JSON.stringify({ email, name })` — so the address and the name the person
 * typed sit there until the row expires.
 *
 * Matched on TEXT, never with a `::json` cast: `value` holds whatever the
 * requester sent, and a `\u0000` escape makes Postgres refuse to read any field
 * of it, which would abort this whole transaction. So: narrow by substring,
 * `JSON.parse` in the app (skipping anything that does not parse), and delete
 * by id. `identifier` is compared too, for any flow that keys a row by address.
 */
async function deleteVerificationsFor(tx: Tx, email: string): Promise<void> {
	const needle = email.toLowerCase();
	const rows = await tx
		.select({
			id: verification.id,
			identifier: verification.identifier,
			value: verification.value,
		})
		.from(verification)
		.where(
			sql`lower(${verification.identifier}) = ${needle} or strpos(lower(${verification.value}), ${needle}) > 0`,
		);
	const ids = rows
		.filter(
			(r) =>
				r.identifier.toLowerCase() === needle ||
				verificationEmail(r.value) === needle,
		)
		.map((r) => r.id);
	if (ids.length > 0) {
		await tx.delete(verification).where(inArray(verification.id, ids));
	}
}

function verificationEmail(value: string): string | null {
	try {
		const parsed: unknown = JSON.parse(value);
		const email = (parsed as { email?: unknown } | null)?.email;
		return typeof email === "string" ? email.toLowerCase() : null;
	} catch {
		return null;
	}
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every Person this club ever held, as far as the database can still tell,
 * read BEFORE the cascade erases the evidence:
 *
 * - current memberships;
 * - former members: `member_remove` entries in this club's activity log name
 *   the removed Person in `detail.personId` (`applyMemberRemove`, the guest
 *   pipeline). The log is the ONLY link left once the membership is gone, and
 *   it cascades with the club. Read as `->>` text (the column is app-written
 *   jsonb, so no cast of untrusted text), and filtered to well-formed uuids in
 *   the app so a malformed row is skipped rather than aborting the delete;
 * - Persons with Pathways progress credited to this club.
 *
 * Whether each one is then deleted is decided after the cascade, under lock,
 * by whether they hold a membership anywhere.
 */
async function personsOfClub(tx: Tx, clubId: string): Promise<string[]> {
	const current = await tx
		.selectDistinct({ personId: members.personId })
		.from(members)
		.where(eq(members.clubId, clubId));
	const removed = await tx
		.selectDistinct({
			personId: sql<string | null>`${activityLog.detail} ->> 'personId'`,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.clubId, clubId),
				sql`${activityLog.action} = 'member_remove'`,
			),
		);
	const credited = await tx
		.selectDistinct({ personId: pathEnrollments.personId })
		.from(pathLevelProgress)
		.innerJoin(
			pathEnrollments,
			eq(pathEnrollments.id, pathLevelProgress.enrollmentId),
		)
		.where(eq(pathLevelProgress.creditedClubId, clubId));
	const ids = new Set<string>();
	for (const r of [...current, ...removed, ...credited]) {
		if (typeof r.personId === "string" && UUID_RE.test(r.personId)) {
			ids.add(r.personId.toLowerCase());
		}
	}
	return [...ids];
}

/** Drizzle wraps the driver's error in `cause`, so look a few levels down. */
function isForeignKeyViolation(err: unknown): boolean {
	for (let e: unknown = err, i = 0; e && i < 3; i++) {
		if ((e as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return true;
		e = (e as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Permanently delete an ARCHIVED club and everything that is only that club's
 * (#914). Irreversible; only a database backup restore brings it back. The
 * caller enforces the superadmin gate.
 *
 * One transaction, so any failure leaves nothing half-deleted:
 *
 * 1. Lock the club row, then refuse unless it is archived and `confirmName`
 *    (trimmed) equals `clubs.name` EXACTLY — a different case is a mismatch.
 * 2. Collect this club's Persons — current AND former members, and anyone
 *    with Pathways progress credited here (`personsOfClub`) — then
 *    `DELETE FROM clubs`. Every club-scoped
 *    table cascades from it (meetings and everything under them, members and
 *    everything under THEM, guests, templates, the logo, sync tokens,
 *    impersonation sessions, the activity log). `path_level_progress
 *    .credited_club_id` is SET NULL: that row is the Person's progress.
 * 3. People are club-less (ADR-0008), so the cascade leaves them. Each collected
 *    Person is locked `FOR UPDATE` and re-checked for a remaining `members` row
 *    AFTER the cascade, inside this transaction: a membership another club adds
 *    concurrently either committed first (and is seen, so the Person is kept) or
 *    blocks on the lock and then fails its FK. A Person with no membership left
 *    is deleted, and their speeches, path enrollments and everything under those
 *    cascade from it. Their snapshot in `people_email_backup` (migration 0076's
 *    rollback table, keyed by person id with no FK) goes too, so their address
 *    does not outlive them there.
 * 4. Each deleted Person's sign-in account is locked `FOR UPDATE` and deleted —
 *    sessions, OAuth grants and API tokens cascade from it — UNLESS another
 *    Person still links to it, it is a superadmin, it owns an OAuth client, or
 *    another club's logo attestation or sync token names it (see
 *    `deleteUserUnlessReferenced`). Those accounts are kept and counted. A
 *    deleted account's pending magic links go with it.
 *
 * A Person who is also in another club keeps their Person, account, Pathways and
 * speech history; only this club's membership goes.
 *
 * Logged to the server log with counts only: `activity_log` goes with the club.
 */
export async function deleteClubPermanently(
	clubId: string,
	confirmName: string,
): Promise<DeleteClubResult> {
	const result = await db.transaction(async (tx) => {
		const [club] = await tx
			.select({ name: clubs.name, archivedAt: clubs.archivedAt })
			.from(clubs)
			.where(eq(clubs.id, clubId))
			.for("update");
		if (!club) throw new Error("Club not found.");
		if (!club.archivedAt) throw new Error("Archive the club first.");
		if (confirmName.trim() !== club.name) {
			throw new Error("The name doesn't match.");
		}

		const personIds = await personsOfClub(tx, clubId);

		await tx.delete(clubs).where(eq(clubs.id, clubId));

		let peopleDeleted = 0;
		let peopleKept = 0;
		const candidateUserIds = new Set<string>();
		if (personIds.length > 0) {
			// Sorted so two concurrent deletes sharing Persons lock in one order.
			const locked = await tx
				.select({ id: people.id, userId: people.userId })
				.from(people)
				.where(inArray(people.id, personIds))
				.orderBy(asc(people.id))
				.for("update");
			const stillMembers = await tx
				.selectDistinct({ personId: members.personId })
				.from(members)
				.where(inArray(members.personId, personIds));
			const keep = new Set(stillMembers.map((r) => r.personId));
			const doomed = locked.filter((p) => !keep.has(p.id));
			peopleKept = locked.length - doomed.length;
			peopleDeleted = doomed.length;
			for (const p of doomed) if (p.userId) candidateUserIds.add(p.userId);
			if (doomed.length > 0) {
				const doomedIds = doomed.map((p) => p.id);
				await tx
					.delete(peopleEmailBackup)
					.where(inArray(peopleEmailBackup.personId, doomedIds));
				await tx.delete(people).where(inArray(people.id, doomedIds));
			}
		}

		let usersDeleted = 0;
		let usersKept = 0;
		const userIds = [...candidateUserIds].sort();
		if (userIds.length > 0) {
			const lockedUsers = await tx
				.select({
					id: user.id,
					email: user.email,
					isSuperadmin: user.isSuperadmin,
				})
				.from(user)
				.where(inArray(user.id, userIds))
				.orderBy(asc(user.id))
				.for("update");
			// A surviving Person still bound to the account keeps it. That link is
			// `people.user_id ON DELETE SET NULL`, so Postgres would not stop the
			// delete; this check is the only thing that does.
			const linked = await tx
				.selectDistinct({ id: people.userId })
				.from(people)
				.where(inArray(people.userId, userIds));
			// An account that registered an OAuth client keeps it: the client row
			// CASCADES from `user`, so deleting the account would silently take a
			// connector down with it. (`is_superadmin` is only reconciled at sign-in,
			// so it is not a reliable stand-in for "operator".)
			const owners = await tx
				.selectDistinct({ id: oauthClient.userId })
				.from(oauthClient)
				.where(inArray(oauthClient.userId, userIds));
			const keepUsers = new Set<string | null>([
				...linked.map((r) => r.id),
				...owners.map((r) => r.id),
			]);
			for (const u of lockedUsers) {
				if (u.isSuperadmin || keepUsers.has(u.id)) {
					usersKept++;
					continue;
				}
				if (await deleteUserUnlessReferenced(tx, u)) usersDeleted++;
				else usersKept++;
			}
		}

		return {
			clubName: club.name,
			peopleDeleted,
			peopleKept,
			usersDeleted,
			usersKept,
		};
	});

	// Counts only, no names: the club's own activity log went with it.
	console.info(
		`[superadmin] club ${clubId} permanently deleted: people deleted=${result.peopleDeleted} kept=${result.peopleKept}; users deleted=${result.usersDeleted} kept=${result.usersKept}`,
	);
	return result;
}
