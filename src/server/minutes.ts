import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	getMembership,
	getSessionUser,
	requireClubRole,
	requireUser,
} from "./guards";
import {
	addGuestPresent,
	addTableTopicsSpeaker,
	clearAward,
	getMeetingClubId,
	getMeetingStatus,
	loadMinutes,
	loadMinutesProgram,
	moveTableTopicsSpeaker,
	removeGuestPresent,
	removeTableTopicsSpeaker,
	setAward,
	setMemberPresence,
} from "./minutes-logic";

const uuid = z.string().uuid();

const newGuestSchema = z.object({
	name: z.string().trim().min(1),
	email: z.string().trim().optional(),
	phone: z.string().trim().optional(),
});

const attendanceStatus = z.enum(["present", "absent", "excused"]);
const awardCategory = z.enum([
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);

/** The minutes payload returned to the meeting view, with visibility flags. */
export type MinutesResult = {
	visible: boolean;
	canEdit: boolean;
	data: Awaited<ReturnType<typeof loadMinutes>> | null;
	program: Awaited<ReturnType<typeof loadMinutesProgram>>;
};

/**
 * Load a meeting's minutes for the meeting view. AUTHED — club admins always
 * see it (to fill it in); members see it read-only, and ONLY once the meeting is
 * `completed` (ADR-0012 / ADR-0014). Non-members and members of an unfinished
 * meeting get `{ visible: false, data: null }` so the loader degrades instead of
 * throwing.
 */
export const getMinutes = createServerFn({ method: "GET" })
	.validator((meetingId: unknown) => uuid.parse(meetingId))
	.handler(async ({ data: meetingId }): Promise<MinutesResult> => {
		const sessionUser = await getSessionUser();
		const empty: MinutesResult = {
			visible: false,
			canEdit: false,
			data: null,
			program: [],
		};
		if (!sessionUser) return empty;
		const clubId = await getMeetingClubId(meetingId);
		const membership = await getMembership(sessionUser.id, clubId);
		if (!membership) return empty;
		const canEdit = membership.clubRole === "admin";
		const status = await getMeetingStatus(meetingId);
		const visible = canEdit || status === "completed";
		if (!visible) return empty;
		const [data, program] = await Promise.all([
			loadMinutes(meetingId),
			loadMinutesProgram(meetingId),
		]);
		return { visible: true, canEdit, data, program };
	});

/** Resolve the meeting's club and gate the caller to the club admin role. */
async function gateAdmin(meetingId: string): Promise<void> {
	const currentUser = await requireUser();
	const clubId = await getMeetingClubId(meetingId);
	await requireClubRole(currentUser.id, clubId, ["admin"]);
}

const setPresenceSchema = z.object({
	meetingId: uuid,
	memberId: uuid,
	status: attendanceStatus,
});

/** Set a member's presence status. ADMIN-ONLY. */
export const setAttendance = createServerFn({ method: "POST" })
	.validator((input: unknown) => setPresenceSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await setMemberPresence(data);
		return { ok: true as const };
	});

const addGuestSchema = z
	.object({
		meetingId: uuid,
		guestId: uuid.optional(),
		newGuest: newGuestSchema.optional(),
	})
	.refine((d) => Boolean(d.guestId) || Boolean(d.newGuest), {
		message: "Provide an existing guest or a new guest.",
	});

/** Add a present guest (existing or new). ADMIN-ONLY. */
export const addMinutesGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => addGuestSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		return addGuestPresent(data);
	});

const removeGuestSchema = z.object({ meetingId: uuid, guestId: uuid });

/** Remove a present guest. ADMIN-ONLY. */
export const removeMinutesGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeGuestSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await removeGuestPresent(data);
		return { ok: true as const };
	});

const addSpeakerSchema = z
	.object({
		meetingId: uuid,
		memberId: uuid.optional(),
		guestId: uuid.optional(),
		newGuest: newGuestSchema.optional(),
		topic: z.string().trim().optional(),
	})
	.refine(
		(d) => Boolean(d.memberId) || Boolean(d.guestId) || Boolean(d.newGuest),
		{ message: "Provide a member or guest speaker." },
	)
	.refine((d) => !(d.memberId && (d.guestId || d.newGuest)), {
		message: "A speaker is a member OR a guest, not both.",
	});

/** Add a Table Topics speaker. ADMIN-ONLY. */
export const addTableTopics = createServerFn({ method: "POST" })
	.validator((input: unknown) => addSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		return addTableTopicsSpeaker(data);
	});

const removeSpeakerSchema = z.object({ meetingId: uuid, id: uuid });

/** Remove a Table Topics speaker. ADMIN-ONLY. */
export const removeTableTopics = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await removeTableTopicsSpeaker(data);
		return { ok: true as const };
	});

const moveSpeakerSchema = z.object({
	meetingId: uuid,
	id: uuid,
	direction: z.enum(["up", "down"]),
});

/** Reorder a Table Topics speaker. ADMIN-ONLY. */
export const moveTableTopics = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await moveTableTopicsSpeaker(data);
		return { ok: true as const };
	});

const setAwardSchema = z
	.object({
		meetingId: uuid,
		category: awardCategory,
		memberId: uuid.optional(),
		guestId: uuid.optional(),
		newGuest: newGuestSchema.optional(),
	})
	.refine(
		(d) => Boolean(d.memberId) || Boolean(d.guestId) || Boolean(d.newGuest),
		{ message: "Provide a member or guest for the award." },
	)
	.refine((d) => !(d.memberId && (d.guestId || d.newGuest)), {
		message: "An award winner is a member OR a guest, not both.",
	});

/** Set an award winner. ADMIN-ONLY. */
export const setMinutesAward = createServerFn({ method: "POST" })
	.validator((input: unknown) => setAwardSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await setAward(data);
		return { ok: true as const };
	});

const clearAwardSchema = z.object({ meetingId: uuid, category: awardCategory });

/** Clear an award. ADMIN-ONLY. */
export const clearMinutesAward = createServerFn({ method: "POST" })
	.validator((input: unknown) => clearAwardSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await clearAward(data);
		return { ok: true as const };
	});
