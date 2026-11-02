import type { getMeetingByKey } from "#/server/meetings";

/** The loader's meeting payload, declared once for the five `use-meeting-*`
 *  hooks (#1476). */
export type MeetingDetail = Awaited<ReturnType<typeof getMeetingByKey>>;

/** Roles each member holds this meeting, keyed by member id. */
export type HeldRolesByMember = Record<
	string,
	{ name: string | null; labels: string[] }
>;
