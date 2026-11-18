// Speeches given outside any meeting here (#1656, ADR-0009 addendum): record,
// edit and delete one, with its optional loose date. Server-fn wiring is in
// `speeches.ts`; every decision is here so an integration test reaches it
// without a request.
//
// WHO MAY WRITE. The speech's own Person (any membership status: a former
// member still owns their history), or an admin / officer of the club the
// speech was RECORDED at (`recorded_club_id`). An officer of another club the
// Person also belongs to has no claim on it, and once the recording club is
// deleted (SET NULL) only the Person can touch it. An archived recording club
// refuses EVERY actor, the Person included. Edit and delete lock the speech row
// and ask the gate again against `tx`.
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people, speeches } from "#/db/schema";
import {
	PAST_SPEECH_NOT_PAST_MESSAGE,
	requirePastSpeechTitle,
	validatePastSpeechDate,
} from "#/lib/past-speech";
import { logActivity } from "./activity";
import {
	assertClubNotArchived,
	assertStillClubAdmin,
	getActiveMembership,
	NO_PERMISSION_MESSAGE,
	requireClubRole,
} from "./guards";
import {
	applyProjectDisplay,
	normalizeSpeech,
	type SpeechInput,
} from "./slots-logic";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
/** The pooled client or a transaction: the one handle a step is passed. */
type Conn = typeof db | Tx;

export type PastSpeechInput = {
	speakerDetails: SpeechInput;
	deliveredYear?: number | null;
	deliveredMonth?: number | null;
};

async function clubTimezone(
	conn: Conn,
	clubId: string | null,
): Promise<string | null> {
	if (!clubId) return null;
	const [c] = await conn
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return c?.timezone ?? null;
}

/** Validation shared by add and edit; returns the columns to write. */
async function prepareWrite(
	conn: Conn,
	input: PastSpeechInput,
	recordedClubId: string | null,
	now: Date,
) {
	requirePastSpeechTitle(input.speakerDetails.speechTitle);
	const date = validatePastSpeechDate({
		year: input.deliveredYear,
		month: input.deliveredMonth,
		now,
		timezone: await clubTimezone(conn, recordedClubId),
	});
	const { content } = normalizeSpeech(input.speakerDetails);
	const values = await applyProjectDisplay(conn, content);
	return {
		...values,
		deliveredYear: date.year,
		deliveredMonth: date.month,
	};
}

async function isPersonsUser(
	conn: Conn,
	actorUserId: string,
	personId: string,
): Promise<boolean> {
	const [p] = await conn
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	return p?.userId != null && p.userId === actorUserId;
}

export async function addPastSpeech(args: {
	memberId: string;
	actorUserId: string;
	input: PastSpeechInput;
	now?: Date;
}): Promise<{ speechId: string }> {
	const [member] = await db
		.select({
			id: members.id,
			clubId: members.clubId,
			personId: members.personId,
		})
		.from(members)
		.where(eq(members.id, args.memberId))
		.limit(1);
	if (!member) throw new Error("Member not found.");
	if (!member.personId) {
		throw new Error("That member has no person record to attach a speech to.");
	}
	const { clubId, personId } = member;
	await assertClubNotArchived(clubId);
	const own = await isPersonsUser(db, args.actorUserId, personId);
	if (!own) await requireClubRole(args.actorUserId, clubId, ["admin"]);

	return db.transaction(async (tx) => {
		await assertClubNotArchived(clubId, tx);
		if (!(await isPersonsUser(tx, args.actorUserId, personId))) {
			await assertStillClubAdmin(tx, args.actorUserId, clubId);
		}
		const actorMemberId =
			(await getActiveMembership(args.actorUserId, clubId, tx))?.id ?? null;
		const values = await prepareWrite(
			tx,
			args.input,
			clubId,
			args.now ?? new Date(),
		);
		const [row] = await tx
			.insert(speeches)
			.values({
				...values,
				personId,
				guestId: null,
				deliveredOffSchedule: true,
				recordedClubId: clubId,
			})
			.returning({ id: speeches.id });
		if (!row) throw new Error("Could not record the speech.");
		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: member.id,
			detail: {
				change: "past_speech_add",
				speechId: row.id,
				deliveredYear: values.deliveredYear,
				deliveredMonth: values.deliveredMonth,
			},
		});
		return { speechId: row.id };
	});
}

type PastRow = {
	personId: string | null;
	recordedClubId: string | null;
	deliveredOffSchedule: boolean;
};

async function readPast(conn: Conn, speechId: string, lock: boolean) {
	const query = conn
		.select({
			personId: speeches.personId,
			recordedClubId: speeches.recordedClubId,
			deliveredOffSchedule: speeches.deliveredOffSchedule,
		})
		.from(speeches)
		.where(eq(speeches.id, speechId))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	if (!row) throw new Error("Speech not found.");
	if (!row.deliveredOffSchedule || !row.personId) {
		throw new Error(PAST_SPEECH_NOT_PAST_MESSAGE);
	}
	return row satisfies PastRow;
}

/**
 * The gate for edit and delete, against `conn`: the pool on the first pass
 * (`locked` false, which takes the full guard including impersonation), the
 * transaction under the speech's row lock on the second (`locked` true, the
 * same rules asked again). Returns the actor's active seat at the recording
 * club, for the log.
 */
async function authorize(
	conn: Conn,
	locked: boolean,
	actorUserId: string,
	row: PastRow,
): Promise<string | null> {
	const { recordedClubId } = row;
	if (recordedClubId) await assertClubNotArchived(recordedClubId, conn);
	const personId = row.personId as string;
	if (!(await isPersonsUser(conn, actorUserId, personId))) {
		if (!recordedClubId) throw new Error(NO_PERMISSION_MESSAGE);
		if (locked) await assertStillClubAdmin(conn, actorUserId, recordedClubId);
		else await requireClubRole(actorUserId, recordedClubId, ["admin"]);
	}
	return recordedClubId
		? ((await getActiveMembership(actorUserId, recordedClubId, conn))?.id ??
				null)
		: null;
}

/**
 * One `activity_log` entry for an edit or delete, aimed at the speaker's seat
 * at the recording club (the `member_edit` convention: target `member`). A
 * speaker who has since left that club has no seat, so the entry then targets
 * the club. A speech with NO recording club (it was deleted) cannot be logged:
 * `activity_log.club_id` is NOT NULL and cascades from the club, so there is no
 * club feed for the entry to live in.
 */
async function logPast(
	tx: Tx,
	row: PastRow,
	actorMemberId: string | null,
	speechId: string,
	change: "past_speech_edit" | "past_speech_delete",
) {
	const { recordedClubId, personId } = row;
	if (!recordedClubId || !personId) return;
	const [seat] = await tx
		.select({ id: members.id })
		.from(members)
		.where(
			and(eq(members.clubId, recordedClubId), eq(members.personId, personId)),
		)
		.limit(1);
	await logActivity(tx, {
		clubId: recordedClubId,
		actorMemberId,
		action: "member_edit",
		targetType: seat ? "member" : "club",
		targetId: seat?.id ?? recordedClubId,
		detail: { change, speechId },
	});
}

export async function editPastSpeech(args: {
	speechId: string;
	actorUserId: string;
	input: PastSpeechInput;
	now?: Date;
}): Promise<void> {
	const first = await readPast(db, args.speechId, false);
	await authorize(db, false, args.actorUserId, first);

	await db.transaction(async (tx) => {
		const row = await readPast(tx, args.speechId, true);
		const actorMemberId = await authorize(tx, true, args.actorUserId, row);
		// Full replace: every field is written, an empty optional one clears it.
		const values = await prepareWrite(
			tx,
			args.input,
			row.recordedClubId,
			args.now ?? new Date(),
		);
		await tx
			.update(speeches)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(speeches.id, args.speechId));
		await logPast(tx, row, actorMemberId, args.speechId, "past_speech_edit");
	});
}

export async function deletePastSpeech(args: {
	speechId: string;
	actorUserId: string;
}): Promise<void> {
	const first = await readPast(db, args.speechId, false);
	await authorize(db, false, args.actorUserId, first);

	await db.transaction(async (tx) => {
		const row = await readPast(tx, args.speechId, true);
		const actorMemberId = await authorize(tx, true, args.actorUserId, row);
		await tx.delete(speeches).where(eq(speeches.id, args.speechId));
		await logPast(tx, row, actorMemberId, args.speechId, "past_speech_delete");
	});
}
