import { listRoles } from "#/lib/list-roles";

/**
 * The toast a member sees when answering Coming also confirmed roles they hold
 * (#1612). One sentence for the RSVP page and the meeting page's strip, so the
 * two cannot drift.
 */
export function confirmedRolesToast(roleNames: readonly string[]): string {
	return `Great, you're confirmed as ${listRoles([...roleNames])}. See you there.`;
}
