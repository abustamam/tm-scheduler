// The one definition of "on the roster" (#1326). A membership is `active`,
// `inactive` or `former`; the roster holds the first two. Every filter that
// wants "not former" imports this instead of spelling the set, or negating a
// status: a status added later is then off every roster until it is listed here.
import type { membershipStatusEnum } from "#/db/schema";

export type MembershipStatus = (typeof membershipStatusEnum.enumValues)[number];

/** The statuses that put a member on the roster. */
export const ROSTER_STATUSES = [
	"active",
	"inactive",
] as const satisfies readonly MembershipStatus[];

/** Is a membership with this status on the roster? */
export function isOnRoster(status: MembershipStatus): boolean {
	return (ROSTER_STATUSES as readonly MembershipStatus[]).includes(status);
}
