import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { user } from "#/db/auth-schema";
import {
	clubs,
	impersonationSessions,
	members,
	officerTerms,
	people,
} from "#/db/schema";
import type { ImportConnection, ImportWrite } from "./import-members-logic";

const personFields = {
	id: people.id,
	userId: people.userId,
	name: people.name,
	email: people.email,
	customerId: people.customerId,
	phone: people.phone,
	version: sql<string>`${people}.xmin::text`,
};
const memberFields = {
	id: members.id,
	personId: members.personId,
	name: members.name,
	email: members.email,
	phone: members.phone,
	status: members.status,
	clubRole: members.clubRole,
	version: sql<string>`${members}.xmin::text`,
};
const termFields = {
	id: officerTerms.id,
	membershipId: officerTerms.membershipId,
	position: officerTerms.position,
	termEnd: officerTerms.termEnd,
	version: sql<string>`${officerTerms}.xmin::text`,
};

export class AccessRefreshRequired extends Error {}
export function isAccessContention(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	return (
		("code" in error && ["55P03", "40P01"].includes(String(error.code))) ||
		("cause" in error && isAccessContention(error.cause))
	);
}
const bounded = <T>(rows: T[], cap: number): T[] => {
	if (rows.length > cap)
		throw new AccessRefreshRequired(
			"Access history exceeds the grant lock limit",
		);
	return rows;
};

/** Locks are optional for preview; commit reads only the affected identity graph.
 * User/Person/membership FOR UPDATE locks also block FK checks for new linked
 * Persons, memberships and terms. Existing rows are locked separately because
 * updates that leave their FK unchanged do not lock the parent. NOWAIT avoids
 * deadlocks with member-edit/merge writers that acquire these rows in reverse.
 */
export async function readAccessState(
	conn: ImportConnection,
	clubId: string,
	actorId: string,
	target?: { personId: string; userId: string | null },
) {
	const users = [
		...new Set([actorId, ...(target?.userId ? [target.userId] : [])]),
	].sort();
	const userQuery = conn
		.select({
			id: user.id,
			isSuperadmin: user.isSuperadmin,
			version: sql<string>`${user}.xmin::text`,
		})
		.from(user)
		.where(inArray(user.id, users))
		.orderBy(user.id);
	const userRows = target
		? await userQuery.for("update", { noWait: true })
		: await userQuery;
	const clubQuery = conn
		.select({
			id: clubs.id,
			archivedAt: clubs.archivedAt,
			version: sql<string>`${clubs}.xmin::text`,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId));
	const clubRows = target
		? await clubQuery.for("share", { noWait: true })
		: await clubQuery;
	const identityQuery = conn
		.select(personFields)
		.from(people)
		.where(
			target
				? or(eq(people.id, target.personId), inArray(people.userId, users))
				: undefined,
		)
		.orderBy(people.id);
	const identities = target
		? bounded(await identityQuery.limit(65).for("update", { noWait: true }), 64)
		: await identityQuery;
	const ids = identities.map((p) => p.id);
	const memberQuery = conn
		.select(memberFields)
		.from(members)
		.where(
			and(
				eq(members.clubId, clubId),
				target ? inArray(members.personId, ids) : undefined,
			),
		)
		.orderBy(members.id);
	const roster = target
		? bounded(await memberQuery.limit(129).for("update", { noWait: true }), 128)
		: await memberQuery;
	const termQuery = conn
		.select(termFields)
		.from(officerTerms)
		.where(
			inArray(
				officerTerms.membershipId,
				roster.map((m) => m.id),
			),
		)
		.orderBy(officerTerms.id);
	const terms = target
		? bounded(await termQuery.limit(513).for("update", { noWait: true }), 512)
		: await termQuery;
	const sessionQuery = conn
		.select({
			id: impersonationSessions.id,
			clubId: impersonationSessions.clubId,
			mode: impersonationSessions.mode,
			expiresAt: impersonationSessions.expiresAt,
			version: sql<string>`${impersonationSessions}.xmin::text`,
		})
		.from(impersonationSessions)
		.where(
			and(
				eq(impersonationSessions.superadminUserId, actorId),
				isNull(impersonationSessions.endedAt),
			),
		)
		.orderBy(impersonationSessions.id);
	const sessions = target
		? bounded(await sessionQuery.limit(65).for("update", { noWait: true }), 64)
		: await sessionQuery;
	return {
		identities,
		roster,
		terms,
		auth: {
			users: userRows.filter((u) => u.id === actorId),
			clubs: clubRows,
			sessions,
		},
	};
}
export type AccessState = Awaited<ReturnType<typeof readAccessState>>;

export function relevantAccess(
	state: AccessState,
	personId: string,
	actorId: string,
) {
	const person = state.identities.find((p) => p.id === personId);
	const identities = state.identities.filter(
		(p) =>
			p.id === personId ||
			p.userId === actorId ||
			(person?.userId && p.userId === person.userId),
	);
	const ids = new Set(identities.map((p) => p.id));
	const roster = state.roster.filter((m) => ids.has(m.personId));
	const memberIds = new Set(roster.map((m) => m.id));
	return {
		identities,
		roster,
		terms: state.terms.filter((t) => memberIds.has(t.membershipId)),
		auth: state.auth,
	};
}
export const sameAccess = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/** Advance the expected snapshot only for writes proven to be this import's.
 * Read-before/write/read-after share a row lock. A different xmin before our
 * write (including a revoke/reinstate) poisons that entity's approvals instead
 * of being hidden by the roster's own update.
 */
export function trackRosterWrites(
	conn: ImportConnection,
	expected: AccessState,
) {
	const dirty = new Set<string>();
	const createdPeople = new Map<number, string>();
	const write: ImportWrite = async (kind, rowIndex, id, work) => {
		try {
			const receipt = await conn.transaction(async (tx) => {
				const read = async (key: string) =>
					kind === "person"
						? (
								await tx
									.select(personFields)
									.from(people)
									.where(eq(people.id, key))
									.for("update", { noWait: true })
							)[0]
						: (
								await tx
									.select(memberFields)
									.from(members)
									.where(eq(members.id, key))
									.for("update", { noWait: true })
							)[0];
				const before = id ? await read(id) : undefined;
				const result = await work(tx);
				const after = result[0] ? await read(result[0].id) : undefined;
				return { result, before, after };
			});
			if (receipt.after) {
				const rows = kind === "person" ? expected.identities : expected.roster;
				const previous = rows.find((r) => r.id === receipt.after?.id);
				if (!sameAccess(previous, receipt.before)) dirty.add(receipt.after.id);
				if (kind === "person") {
					expected.identities = expected.identities.filter(
						(r) => r.id !== receipt.after?.id,
					);
					expected.identities.push(
						receipt.after as AccessState["identities"][number],
					);
					expected.identities.sort((a, b) => a.id.localeCompare(b.id));
					if (!id) createdPeople.set(rowIndex, receipt.after.id);
				} else {
					expected.roster = expected.roster.filter(
						(r) => r.id !== receipt.after?.id,
					);
					expected.roster.push(receipt.after as AccessState["roster"][number]);
					expected.roster.sort((a, b) => a.id.localeCompare(b.id));
				}
			}
			return receipt.result;
		} catch (error) {
			if (!isAccessContention(error)) throw error;
			if (id) dirty.add(id);
			// Roster writes keep their ordinary waiting behavior; only approval fails closed.
			return work(conn);
		}
	};
	return { write, dirty, createdPeople };
}
