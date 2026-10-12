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
import {
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	assertClubNotArchived,
	assertStillClubAdmin,
	getMembership,
	requireClubRole,
} from "./guards";
import { lockMeetingForSlotEdit } from "./meeting-slot-lock";
import {
	normalizeSpeech,
	type SpeechInput,
	updateOrAttachSlotSpeech,
	writeSpeakerDetails,
} from "./slots-logic";

type Conn = Pick<typeof db, "select">;

/** What the checks and the write need to know about the slot and its speech. */
async function readSlot(conn: Conn, slotId: string, lock: boolean) {
	const query = conn
		.select({
			meetingId: roleSlots.meetingId,
			// A meeting's club never changes, so the unlocked read can authorize on it.
			clubId: meetings.clubId,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			speechId: roleSlots.speechId,
			assignedMemberId: roleSlots.assignedMemberId,
			personId: members.personId,
			// Who OWNS the speech the slot points at (ADR-0009): it need not be the
			// slot's holder, because a speech stays on a slot its holder left.
			speechOwnerId: speeches.personId,
			// The fields the sheet may not have sent (see `keepUnsent`).
			introduction: speeches.introduction,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.id, slotId))
		.limit(1);
	// Only the slot row is locked; the speech and member rows are read.
	const [slot] = lock
		? await query.for("update", { of: roleSlots })
		: await query;
	return slot ?? null;
}

type Slot = NonNullable<Awaited<ReturnType<typeof readSlot>>>;

/**
 * The speaker arm: the actor is the Person holding the slot, at ANY membership
 * status (a former member still owns their speech), AND the speech the slot
 * points at is theirs, or there is none yet. The second half matters because a
 * speech outlives its holder on the slot: a guest linked to Alice, then
 * re-linked to Bob, leaves Alice's speech on a slot Bob now holds, and being
 * the holder is not a claim on it. That actor falls through to the admin arm.
 *
 * Reads through `conn`, so inside the transaction it is the same snapshot as
 * the locked slot and takes no second pooled connection.
 */
async function isSpeakerOfSpeech(
	conn: Conn,
	actorUserId: string,
	slot: Slot,
): Promise<boolean> {
	if (!slot.personId || !slot.assignedMemberId) return false;
	if (slot.speechId && slot.speechOwnerId !== slot.personId) return false;
	const mine = await conn
		.select({ id: people.id })
		.from(people)
		.where(eq(people.userId, actorUserId));
	return mine.some((p) => p.id === slot.personId);
}

/**
 * A field the form did not SEND keeps its stored value. The sheet hides the
 * free-text path, project and level inputs behind the project picker, and has
 * no introduction input at all, so a title-only edit would otherwise read them
 * as blank and wipe history. A field the form sent as "" is a deliberate clear
 * and is not touched here (an absent key and `undefined` are the same on the
 * wire, which is why the sheet sends "" for a shown-but-empty input).
 */
function keepUnsent(input: SpeechInput, slot: Slot): SpeechInput {
	return {
		...input,
		introduction: input.introduction ?? slot.introduction ?? undefined,
		pathwayPath: input.pathwayPath ?? slot.pathwayPath ?? undefined,
		projectName: input.projectName ?? slot.projectName ?? undefined,
		projectLevel: input.projectLevel ?? slot.projectLevel ?? undefined,
	};
}

export async function applySpeechLogEdit(args: {
	slotId: string;
	actorUserId: string;
	speakerDetails: SpeechInput;
}): Promise<void> {
	// Authorize BEFORE the transaction, through the pooled client, so a refusal
	// costs no lock. The transaction below asks again, against `tx`: it holds
	// the meeting lock, and a read through the pool from inside it would take a
	// second connection while holding one (#806, #809).
	const first = await readSlot(db, args.slotId, false);
	if (!first) throw new Error("Role not found.");
	const meetingId = first.meetingId;
	await assertClubNotArchived(first.clubId);
	if (!(await isSpeakerOfSpeech(db, args.actorUserId, first))) {
		await requireClubRole(args.actorUserId, first.clubId, ["admin"]);
	}

	await db.transaction(async (tx) => {
		// The meeting lock FIRST, as every other slot-shape writer takes it
		// (`meeting-slot-lock.ts`), then the slot FOR UPDATE: a concurrent
		// cancel, reassign or release serializes against this edit.
		const meeting = await lockMeetingForSlotEdit(tx, meetingId);
		const slot = await readSlot(tx, args.slotId, true);
		if (!slot) throw new Error("Role not found.");
		const { clubId } = meeting;

		await assertClubNotArchived(clubId, tx);
		// The speaker owns their speech (ADR-0009). Otherwise an admin or an
		// officer of the club the speech was given at; `assertStillClubAdmin` is
		// `requireClubRole` asked again against `tx` (impersonation was settled
		// up front).
		let actorMemberId: string | null;
		if (await isSpeakerOfSpeech(tx, args.actorUserId, slot)) {
			actorMemberId = slot.assignedMemberId;
		} else {
			await assertStillClubAdmin(tx, args.actorUserId, clubId);
			actorMemberId =
				(await getMembership(args.actorUserId, clubId, tx))?.id ?? null;
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
		const input = keepUnsent(args.speakerDetails, slot);
		// This path never unlinks, so an all-blank form is refused rather than
		// reaching a writer that would drop the speech.
		if (!normalizeSpeech(input).hasContent) {
			throw new Error(
				"Nothing to save. To remove a speech, use the meeting's agenda.",
			);
		}

		await writeSpeakerDetails(tx, {
			clubId,
			actorMemberId,
			meetingId,
			slotId: args.slotId,
			currentSpeechId: slot.speechId,
			write: () =>
				updateOrAttachSlotSpeech(tx, {
					slotId: args.slotId,
					personId: slot.personId as string,
					currentSpeechId: slot.speechId,
					input,
				}),
		});
	});
}
