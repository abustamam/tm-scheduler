// Superadmin impersonation DB logic (#185 / ADR-0020), split out from the
// `createServerFn` wrappers in `impersonation.ts` so the Start compiler strips it
// from the client bundle (enforced by `server-modules.guard.test.ts`).
//
// A session is a superadmin's time-bounded, read-only "View as this club" grant.
// It is the ONLY thing that grants a superadmin read access to a club they aren't
// a real member of (consulted by the read-access guards in `guards.ts`); the
// mutating guards never look at it, so read-only holds by construction. Read-write
// is deferred (#246).
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	clubs,
	impersonationSessions,
	user as userTable,
} from "#/db/schema";

/** Fixed session lifetime — 60 minutes. Re-enter for a fresh window (no extend). */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

export interface ActiveImpersonation {
	id: string;
	clubId: string;
	mode: "read_only";
	expiresAt: Date;
}

/** The superadmin's single active session (any club), or null. Active =
 *  not ended AND not expired. */
export async function getActiveImpersonationForUser(
	superadminUserId: string,
	now: Date = new Date(),
): Promise<ActiveImpersonation | null> {
	const [row] = await db
		.select({
			id: impersonationSessions.id,
			clubId: impersonationSessions.clubId,
			mode: impersonationSessions.mode,
			expiresAt: impersonationSessions.expiresAt,
		})
		.from(impersonationSessions)
		.where(
			and(
				eq(impersonationSessions.superadminUserId, superadminUserId),
				isNull(impersonationSessions.endedAt),
				gt(impersonationSessions.expiresAt, now),
			),
		)
		.orderBy(desc(impersonationSessions.startedAt))
		.limit(1);
	return row ?? null;
}

/** The superadmin's active session FOR a specific club, or null. This is what the
 *  read-access guards consult to grant read access. */
export async function getActiveImpersonation(
	superadminUserId: string,
	clubId: string,
	now: Date = new Date(),
): Promise<ActiveImpersonation | null> {
	const active = await getActiveImpersonationForUser(superadminUserId, now);
	return active && active.clubId === clubId ? active : null;
}

export const startImpersonationSchema = z.object({
	clubId: z.string().uuid(),
});
export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;

/**
 * Start a read-only session for a club: end any existing active session for this
 * superadmin, insert a fresh one (60-min expiry), and write the club-feed audit
 * entry (`superadmin_viewed`, real identity in `detail`). Returns the new session.
 */
export async function startImpersonation(
	superadminUserId: string,
	input: StartImpersonationInput,
): Promise<ActiveImpersonation> {
	const [club] = await db
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.id, input.clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");

	const [me] = await db
		.select({ email: userTable.email })
		.from(userTable)
		.where(eq(userTable.id, superadminUserId))
		.limit(1);

	const now = new Date();
	const expiresAt = new Date(now.getTime() + IMPERSONATION_TTL_MS);

	const session = await db.transaction(async (tx) => {
		// One active session per superadmin — end any that are still open.
		await tx
			.update(impersonationSessions)
			.set({ endedAt: now })
			.where(
				and(
					eq(impersonationSessions.superadminUserId, superadminUserId),
					isNull(impersonationSessions.endedAt),
				),
			);

		const [row] = await tx
			.insert(impersonationSessions)
			.values({
				superadminUserId,
				clubId: input.clubId,
				mode: "read_only",
				startedAt: now,
				expiresAt,
			})
			.returning({
				id: impersonationSessions.id,
				clubId: impersonationSessions.clubId,
				mode: impersonationSessions.mode,
				expiresAt: impersonationSessions.expiresAt,
			});
		if (!row) throw new Error("Failed to start impersonation session.");

		// Transparency: the club's own admins can see platform support viewed them.
		await tx.insert(activityLog).values({
			clubId: input.clubId,
			actorMemberId: null,
			action: "superadmin_viewed",
			targetType: "club",
			targetId: input.clubId,
			detail: { superadminUserId, superadminEmail: me?.email ?? null },
		});
		return row;
	});

	return session;
}

/** End the superadmin's active session(s). Idempotent — a no-op when none open. */
export async function endImpersonation(
	superadminUserId: string,
): Promise<{ ok: true }> {
	await db
		.update(impersonationSessions)
		.set({ endedAt: new Date() })
		.where(
			and(
				eq(impersonationSessions.superadminUserId, superadminUserId),
				isNull(impersonationSessions.endedAt),
			),
		);
	return { ok: true };
}
