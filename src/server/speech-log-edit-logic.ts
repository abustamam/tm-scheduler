// The speech log's editor (#1159): fix a DELIVERED speech's details after the
// fact, including on a completed meeting. Server-fn wiring is `editSpeechFromLog`
// in `speeches.ts`; every decision is here so an integration test reaches it
// without a request.
//
// Why a second writer beside `updateSpeakerDetails`: the agenda sheet refuses a
// completed meeting, and a member cannot reopen one. Most Ice Breakers are given
// before the member enrolled in a path, so the project can only be backfilled
// afterwards. This writer never unlinks a speech: a blank save is refused,
// because "remove my speech" belongs to the agenda, where the meeting is open.
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { members, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { logActivity } from "./activity";
import { assertClubNotArchived, requireClubRole } from "./guards";
import { lockMeetingForSlotEdit } from "./meeting-slot-lock";
import { userPersonIds } from "./person-identity-logic";
import {
	normalizeSpeech,
	type SpeechInput,
	updateOrAttachSlotSpeech,
} from "./slots-logic";

type Conn = Pick<typeof db, "select">;

/** The two speech fields `updateSpeakerDetails` and the speech-log edit log
 *  before and after (#763). A slot with no speech reads as both null. */
export async function speechDetails(
	conn: Conn,
	speechId: string | null,
): Promise<{ title: string | null; projectId: string | null }> {
	if (!speechId) return { title: null, projectId: null };
	const [row] = await conn
		.select({ title: speeches.title, projectId: speeches.projectId })
		.from(speeches)
		.where(eq(speeches.id, speechId))
		.limit(1);
	return { title: row?.title ?? null, projectId: row?.projectId ?? null };
}

export async function applySpeechLogEdit(args: {
	slotId: string;
	actorUserId: string;
	speakerDetails: SpeechInput;
}): Promise<void> {
	await db.transaction(async (tx) => {
		// The meeting lock comes FIRST, as it does for every other slot-shape
		// writer (`meeting-slot-lock.ts`: "take this before slot locks"), so the
		// slot is read once without a lock to learn its meeting, then re-read
		// FOR UPDATE under the meeting lock. Everything below is decided off the
		// locked rows, so a concurrent cancel, reassign or release serializes
		// against this edit instead of racing the checks.
		const [found] = await tx
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(eq(roleSlots.id, args.slotId))
			.limit(1);
		if (!found) throw new Error("Role not found.");
		const meeting = await lockMeetingForSlotEdit(tx, found.meetingId);

		const [slot] = await tx
			.select({
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				speechId: roleSlots.speechId,
				assignedMemberId: roleSlots.assignedMemberId,
				personId: members.personId,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
			.where(eq(roleSlots.id, args.slotId))
			.limit(1)
			.for("update", { of: roleSlots });
		if (!slot) throw new Error("Role not found.");

		const { clubId } = meeting;
		// A taken-down club refuses for that reason, before anything about who
		// is asking or what the meeting says.
		await assertClubNotArchived(clubId, tx);

		// Authorize. The speaker owns their speech (ADR-0009) at ANY membership
		// status: a former member still owns what they gave. Otherwise an admin or
		// an officer of the club the speech was given at. A plain member, and an
		// admin of another club, reach `requireClubRole`'s own refusal.
		let actorMemberId: string | null;
		const isSpeaker =
			slot.personId !== null &&
			slot.assignedMemberId !== null &&
			(await userPersonIds(args.actorUserId)).includes(slot.personId);
		if (isSpeaker) {
			actorMemberId = slot.assignedMemberId;
		} else {
			const admin = await requireClubRole(args.actorUserId, clubId, ["admin"]);
			actorMemberId = admin.id;
		}

		// A completed meeting is accepted (the whole point), a cancelled one is
		// not: it keeps every assignment until restored.
		assertMeetingAccepts(meeting.status, "plan", { accept: ["completed"] });

		if (!slot.isSpeakerRole) {
			throw new Error("Only speaker roles have speech details.");
		}
		if (!slot.assignedMemberId || !slot.personId) {
			throw new Error("Only a member's speech can be edited here.");
		}
		// This path never unlinks, so an all-blank form is refused rather than
		// reaching a writer that would drop the speech.
		if (!normalizeSpeech(args.speakerDetails).hasContent) {
			throw new Error(
				"Nothing to save. To remove a speech, use the meeting's agenda.",
			);
		}

		const before = await speechDetails(tx, slot.speechId);
		await updateOrAttachSlotSpeech(tx, {
			slotId: args.slotId,
			personId: slot.personId,
			currentSpeechId: slot.speechId,
			input: args.speakerDetails,
		});
		// Re-read through the SLOT: the edit may have created the speech.
		const [after] = await tx
			.select({ speechId: roleSlots.speechId })
			.from(roleSlots)
			.where(eq(roleSlots.id, args.slotId))
			.limit(1);
		const afterSpeechId = after?.speechId ?? null;
		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: found.meetingId,
			detail: {
				change: "speaker_details",
				slotId: args.slotId,
				speechId: afterSpeechId ?? slot.speechId,
				before,
				after: await speechDetails(tx, afterSpeechId),
				proof: "session",
			},
		});
	});
}
