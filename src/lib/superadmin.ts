/**
 * Platform-level superadmin provisioning (ADR-0016 / #183).
 *
 * Superadmin is a capability layered ON TOP OF club membership — orthogonal to a
 * Membership's `club_role`. It is NOT self-serve: the set of superadmins is
 * declared out-of-band via the `SUPERADMIN_EMAILS` env allowlist (comma-
 * separated, case-insensitive) and reconciled onto `user.is_superadmin` on every
 * sign-in (see the Better-Auth `session.create` hook in `src/lib/auth.ts`).
 *
 * This module touches `#/db` and is therefore server-only — never import it from
 * a client component. It is imported by `auth.ts` and `guards.ts`, both of which
 * are already server-only.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { user } from "#/db/schema";

// Accepts the shared `db` client or a drizzle transaction handle so callers (and
// integration tests) can pass their own connection.
type DbClient =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Parse the `SUPERADMIN_EMAILS` allowlist into a lowercased, trimmed set.
 * Unset / empty ⇒ empty set, so nobody is a superadmin (fail closed). Read at
 * call time so a changed env is picked up on the next sign-in.
 */
export function parseSuperadminEmails(
	raw: string | undefined = process.env.SUPERADMIN_EMAILS,
): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0),
	);
}

/** True when `email` is in the `SUPERADMIN_EMAILS` allowlist (case-insensitive). */
export function isSuperadminEmail(
	email: string,
	raw: string | undefined = process.env.SUPERADMIN_EMAILS,
): boolean {
	return parseSuperadminEmails(raw).has(email.trim().toLowerCase());
}

/**
 * Idempotent, two-way reconcile of one user's `is_superadmin` flag against the
 * `SUPERADMIN_EMAILS` allowlist: grant when the email is (now) listed, revoke
 * when it is not. Only writes when the flag actually changes. Returns the
 * resolved flag (false for an unknown user). Called from the sign-in hook so
 * adding an email grants on the user's next sign-in and removing it revokes.
 */
export async function reconcileSuperadminFlag(
	userId: string,
	client: DbClient = db,
): Promise<boolean> {
	const [row] = await client
		.select({ email: user.email, isSuperadmin: user.isSuperadmin })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!row) return false;
	const shouldBe = isSuperadminEmail(row.email);
	if (row.isSuperadmin !== shouldBe) {
		await client
			.update(user)
			.set({ isSuperadmin: shouldBe })
			.where(eq(user.id, userId));
	}
	return shouldBe;
}
