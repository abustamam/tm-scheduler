// Superadmin impersonation DB logic (#185 / ADR-0020), split out from the
// `createServerFn` wrappers in `impersonation.ts` so the Start compiler strips it
// from the client bundle (enforced by `server-modules.guard.test.ts`).
//
// A session is a superadmin's time-bounded grant to a club they aren't a real
// member of. `read_only` = "View as this club" (the read-access guards in
// `guards.ts` honor it; the mutating guards never look at it, so read-only holds
// by construction). `read_write` = "Act as admin" (#246) — the mutating guards
// ALSO honor it as an effective admin, under a shorter TTL + required reason +
// per-write audit.
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	clubs,
	impersonationSessions,
	user as userTable,
} from "#/db/schema";

export type ImpersonationMode = "read_only" | "read_write";

/** Read-only session lifetime — 60 minutes. Re-enter for a fresh window (no extend). */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;
/** Read-write session lifetime — 15 minutes (#246): a tighter window for the
 *  dangerous "act as admin" mode. Re-enter (with a fresh reason) to continue. */
export const IMPERSONATION_RW_TTL_MS = 15 * 60 * 1000;

/** TTL for a given mode. */
export function ttlForMode(mode: ImpersonationMode): number {
	return mode === "read_write" ? IMPERSONATION_RW_TTL_MS : IMPERSONATION_TTL_MS;
}

export interface ActiveImpersonation {
	id: string;
	clubId: string;
	mode: ImpersonationMode;
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

export const startImpersonationSchema = z
	.object({
		clubId: z.string().uuid(),
		mode: z.enum(["read_only", "read_write"]).default("read_only"),
		// Required (non-empty) for read_write; ignored for read_only.
		reason: z.string().trim().min(1).max(500).optional(),
	})
	.refine((v) => v.mode !== "read_write" || Boolean(v.reason), {
		message: "A reason is required to act as this club's admin.",
		path: ["reason"],
	});
// Pre-parse (input) shape: `mode`/`reason` are optional here (mode defaults to
// read_only), so callers may pass just `{ clubId }` for a read-only session.
export type StartImpersonationInput = z.input<typeof startImpersonationSchema>;

/**
 * Start a session for a club: end any existing active session for this
 * superadmin, insert a fresh one (TTL by mode — 60 min read-only, 15 min
 * read-write), and write the club-feed audit entry with the real superadmin
 * identity. Read-only logs `superadmin_viewed`; read-write logs `superadmin_acted`
 * with the access `reason` (and stamps `impersonated_by`). Returns the new session.
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

	const mode: ImpersonationMode = input.mode ?? "read_only";
	const reason = mode === "read_write" ? (input.reason ?? null) : null;
	if (mode === "read_write" && !reason) {
		throw new Error("A reason is required to act as this club's admin.");
	}

	const [me] = await db
		.select({ email: userTable.email })
		.from(userTable)
		.where(eq(userTable.id, superadminUserId))
		.limit(1);

	const now = new Date();
	const expiresAt = new Date(now.getTime() + ttlForMode(mode));

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
				mode,
				reason,
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

		// Transparency: the club's own admins can see when platform support viewed
		// (read-only) or acted on (read-write) their club, and why.
		await tx.insert(activityLog).values({
			clubId: input.clubId,
			actorMemberId: null,
			impersonatedBy: mode === "read_write" ? superadminUserId : null,
			action: mode === "read_write" ? "superadmin_acted" : "superadmin_viewed",
			targetType: "club",
			targetId: input.clubId,
			detail: {
				superadminUserId,
				superadminEmail: me?.email ?? null,
				mode,
				...(reason ? { reason } : {}),
			},
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
