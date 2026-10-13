// Speech-request queue server fns (#1052). Thin `createServerFn` wrappers only;
// every db-touching function lives in `speech-requests-logic.ts` so the compiler
// strips it from the client bundle (server-modules guard).
//
// Authorization splits by whose words these are:
//   MEMBER fns (submit, edit, withdraw, "mine") resolve the CALLER's own
//     membership in the request's club and hand its id to the logic, which
//     refuses a request that membership does not own. There is no member id on
//     the wire for an attacker to name.
//   VPE fns (queue, open slots, schedule) gate on club admin, like the rest of
//     the VPE dashboard: the VP Education resolves to admin (ADR-0008), and an
//     elected officer is an effective admin (#202).
// Every fn requires a session first; none is reachable anonymously.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "#/db";
import { speechRequestFieldsSchema } from "#/lib/speech-requests";
import {
	requireClubAdminView,
	requireClubRole,
	requireMembership,
	requireUser,
} from "./guards";
import {
	createSpeechRequest,
	getSpeechRequestClubId,
	listMySpeechRequests,
	listSchedulableSlots,
	listSpeechRequestQueue,
	REQUEST_NOT_FOUND_MESSAGE,
	scheduleSpeechRequest,
	updateSpeechRequest,
	withdrawSpeechRequest,
} from "./speech-requests-logic";

export type {
	MySpeechRequest,
	SpeechQueueRow,
} from "./speech-requests-logic";

const uuid = z.string().uuid();
const clubScoped = z.object({ clubId: uuid });

/** Parse, but fail with a sentence a member can read instead of a zod dump. */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	throw new Error(
		result.error.issues[0]?.message ?? "That request could not be saved.",
	);
}

const MEMBERLESS_MESSAGE =
	"Speech requests belong to a club member. Your account is not a member of this club.";

/** The caller's own membership id in `clubId`; a memberless impersonation session has none. */
async function ownMembershipId(
	userId: string,
	clubId: string,
): Promise<string> {
	const membership = await requireMembership(userId, clubId);
	if (membership.id === null) throw new Error(MEMBERLESS_MESSAGE);
	return membership.id;
}

/** The club a request lives in, or the not-found sentence. */
async function clubOfRequest(requestId: string): Promise<string> {
	const clubId = await getSpeechRequestClubId(requestId);
	if (!clubId) throw new Error(REQUEST_NOT_FOUND_MESSAGE);
	return clubId;
}

/** The caller's open and scheduled requests in `clubId`. */
export const getMySpeechRequests = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(clubScoped, input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireMembership(user.id, data.clubId);
		// A memberless impersonation session asked for nothing, so lists nothing.
		if (membership.id === null) return [];
		return listMySpeechRequests(db, {
			clubId: data.clubId,
			membershipId: membership.id,
		});
	});

/** Queue a speech request as the caller. */
export const submitSpeechRequest = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(speechRequestFieldsSchema.extend({ clubId: uuid }), input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membershipId = await ownMembershipId(user.id, data.clubId);
		const { clubId, ...fields } = data;
		return createSpeechRequest(db, { clubId, membershipId, fields });
	});

/** Edit the caller's own open request. */
export const editSpeechRequest = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(speechRequestFieldsSchema.extend({ requestId: uuid }), input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		const clubId = await clubOfRequest(data.requestId);
		const actorMembershipId = await ownMembershipId(user.id, clubId);
		const { requestId, ...fields } = data;
		return updateSpeechRequest(db, { requestId, actorMembershipId, fields });
	});

/** Withdraw the caller's own open request. */
export const withdrawMySpeechRequest = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(z.object({ requestId: uuid }), input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const clubId = await clubOfRequest(data.requestId);
		const actorMembershipId = await ownMembershipId(user.id, clubId);
		await withdrawSpeechRequest(db, {
			requestId: data.requestId,
			actorMembershipId,
		});
		return { ok: true as const };
	});

/** The VPE's queue: open requests, longest-waiting speaker first, then oldest request. */
export const getSpeechRequestQueue = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(clubScoped, input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return listSpeechRequestQueue(db, data.clubId);
	});

/** Open speaker slots on upcoming meetings, for the VPE's Schedule picker. */
export const getSchedulableSpeakerSlots = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(clubScoped, input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return listSchedulableSlots(data.clubId);
	});

/** Schedule any member's request into an open speaker slot. Club admin only. */
export const scheduleRequestedSpeech = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(z.object({ requestId: uuid, slotId: uuid }), input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		const clubId = await clubOfRequest(data.requestId);
		const admin = await requireClubRole(user.id, clubId, ["admin"]);
		return scheduleSpeechRequest({
			requestId: data.requestId,
			slotId: data.slotId,
			clubId,
			actorMemberId: admin.id,
		});
	});
