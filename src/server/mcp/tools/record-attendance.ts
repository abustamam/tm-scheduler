/**
 * `record_attendance` — an officer records who WAS at a meeting: the roll
 * (`meeting_attendance`), not the plan (the planned-attendance store, which
 * `set_attendance` writes) (#1573, child of #1560).
 *
 * It writes through the minutes writers the roll mode of the app uses:
 * `setMemberPresence`, `addGuestPresent` and `removeGuestPresent`, all inside
 * ONE transaction. There is no second insert path here.
 *
 * ## The write class is "record", not the plan's
 *
 * `throwIfLocked` (member-meeting.ts) refuses a COMPLETED meeting, and the roll
 * is usually taken after completion, so it is not used. The rule is the app's
 * own (`assertMinutesMeetingRecordable` + `assertAttendanceRecordable`): a
 * cancelled meeting is refused (a blocking item, then `BLOCKED`), a completed
 * one is accepted, and a meeting whose club-local day has not arrived is
 * a blocking item too (`ATTENDANCE_BEFORE_MEETING`), so a preview still shows
 * the plan.
 *
 * ## Authorization
 *
 * `audience: "officer"` through `authorizeTokenForMeeting` is exactly the set
 * `gateAdmin` admits in the app (a club admin or an open-term officer). The
 * meeting's Toastmaster and Ballot Counter cannot take the roll in the app, and
 * the token layer has no arm that admits them here.
 *
 * ## Preview, then apply
 *
 * Without `planHash`: nothing is written; one plan covers every entry. With it:
 * the apply re-plans INSIDE a transaction under the club write lock and is
 * `PLAN_STALE` when the plan moved, `BLOCKED` while a blocking item remains.
 * Any blocking item stops the whole apply, so nothing is half-recorded. The one
 * exception is an AMBIGUOUS `newGuest` the call did not confirm: it is skipped
 * and reported and the rest applies.
 *
 * A new guest never silently duplicates a person: a `newGuest` whose name is
 * close to a club guest or member (the `find_people` matcher, plus a shared
 * whole word, as `add_members` does) is ambiguous until its index in `guests`
 * is listed in `confirmNew`. A contact match (email, or a phone with a
 * agreeing name) is not ambiguous: it is the guest the roll writer would
 * resolve to anyway, so the plan says so and uses that guest.
 *
 * The tool never releases roles: it does not pass `releaseHeldRoles`.
 * GavelUp tells NO ONE.
 *
 * Blocking codes here are local to this tool (strings, as the member attendance
 * tools' are) rather than members of the officer tools' `McpBlockingCode` union.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetingAttendance, members } from "#/db/schema";
import { ATTENDANCE_MODES } from "#/lib/attendance-mode";
import { planHash } from "#/lib/mcp-plan";
import {
	ATTENDANCE_BEFORE_MEETING_MESSAGE,
	meetingDateReached,
	meetingRefusal,
} from "#/lib/meeting-lifecycle";
import { matchTier } from "#/lib/person-search";
import { toStoredPhone } from "#/lib/phone";
import { lockClubForWrite } from "#/server/club-write-lock";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import {
	findGuestForContact,
	loadGuestMatchCandidates,
} from "#/server/guest-pipeline-logic";
import { lockMembershipsAgainstMerge } from "#/server/membership-merge-lock";
import {
	addGuestPresent,
	removeGuestPresent,
	setMemberPresence,
} from "#/server/minutes-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	loadMeetingFacts,
	type MeetingFacts,
	meetingPlanHeader,
	PLAN_STALE_MESSAGE,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { recordRefusalItem } from "./set-awards";

const TOOL = "record_attendance";
const MAX_MEMBERS = 150;
const MAX_GUESTS = 50;
const MAX_MATCHES = 3;

const statusSchema = z.enum(["present", "absent", "excused"]);
const modeSchema = z.enum(ATTENDANCE_MODES);

const memberEntry = z
	.object({
		memberId: z.string().uuid(),
		status: statusSchema,
		mode: modeSchema.optional(),
	})
	// A mode on an absent/excused write is a contradiction: refused, never dropped
	// (the app's own rule, `setPresenceSchema`).
	.refine((d) => d.mode === undefined || d.status === "present", {
		message: "Only a present member has an attendance mode.",
		path: ["mode"],
	});

const guestEntry = z.union([
	z
		.object({ guestId: z.string().uuid(), mode: modeSchema.optional() })
		.strict(),
	z
		.object({
			newGuest: z
				.object({
					name: z.string().trim().min(1).max(200),
					email: z.string().trim().email().max(200).optional(),
					phone: z.string().trim().max(40).optional(),
				})
				.strict(),
			mode: modeSchema.optional(),
		})
		.strict(),
]);

const inputSchema = {
	meetingId: z.string().uuid().describe("From list_meetings."),
	members: z
		.array(memberEntry)
		.max(MAX_MEMBERS)
		.optional()
		.describe(
			"Members to mark: {memberId, status: present|absent|excused, mode?: " +
				"in_person|online}. mode only with present; omitted keeps a recorded mode.",
		),
	guests: z
		.array(guestEntry)
		.max(MAX_GUESTS)
		.optional()
		.describe(
			"Guests who attended: {guestId, mode?} for a guest find_people lists, or " +
				"{newGuest: {name, email?, phone?}, mode?} for someone new.",
		),
	removeGuests: z
		.array(z.string().uuid())
		.max(MAX_GUESTS)
		.optional()
		.describe(
			"guestIds to take OFF this meeting's roll. The club guest is kept.",
		),
	confirmNew: z
		.array(z.number().int().min(0))
		.max(MAX_GUESTS)
		.optional()
		.describe(
			"Positions in `guests` of newGuest entries the USER confirmed are new " +
				"people, not someone already known. Never fill this on your own.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

type Args = z.infer<z.ZodObject<typeof inputSchema>>;
type Status = z.infer<typeof statusSchema>;
type Mode = z.infer<typeof modeSchema>;

interface RollBlockingItem {
	code: string;
	entryIndex?: number;
	list?: "members" | "guests" | "removeGuests";
	message: string;
}

interface Roll {
	status: Status | null;
	mode: Mode | null;
}

interface MemberLine {
	index: number;
	memberId: string;
	name: string | null;
	verdict: "change" | "already_recorded" | "blocked";
	before: Roll;
	after: Roll;
}

interface GuestLine {
	index: number;
	/** The existing guest this line writes to; null for a guest that would be created. */
	guestId: string | null;
	name: string | null;
	email: string | null;
	phone: string | null;
	verdict:
		| "add"
		| "change_mode"
		| "already_recorded"
		| "would_create"
		| "ambiguous"
		| "blocked";
	/** A new guest whose contact matched this existing guest. */
	matchedByContact: boolean;
	before: { present: boolean; mode: Mode | null };
	after: { present: boolean; mode: Mode | null };
	possibleMatches: { kind: "member" | "guest"; id: string; name: string }[];
	confirmed: boolean;
	/** The input mode, which decides whether an existing row's mode is replaced. */
	mode: Mode | null;
}

interface RemoveLine {
	index: number;
	guestId: string;
	name: string | null;
	verdict: "remove" | "already_recorded" | "blocked";
}

interface Plan {
	meeting: ReturnType<typeof meetingPlanHeader>;
	members: MemberLine[];
	guests: GuestLine[];
	removeGuests: RemoveLine[];
	summary: {
		memberChanges: number;
		guestsToAdd: number;
		guestsToCreate: number;
		guestModeChanges: number;
		guestsToRemove: number;
		alreadyRecorded: number;
		ambiguousSkipped: number;
	};
}

interface Computed {
	plan: Plan;
	planHash: string;
	blocking: RollBlockingItem[];
	facts: MeetingFacts;
}

const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

const wordsOf = (s: string | null | undefined) =>
	fold(s)
		.split(/\s+/)
		.filter((w) => w.length >= 2);

/** The name is close to a known person, in either direction or by a shared whole word. */
function closeTo(
	name: string,
	p: { name: string; preferredName?: string | null },
): boolean {
	if (matchTier(name, p) !== null || matchTier(p.name, { name }) !== null) {
		return true;
	}
	const mine = new Set(wordsOf(name));
	return [...wordsOf(p.name), ...wordsOf(p.preferredName)].some((w) =>
		mine.has(w),
	);
}

async function compute(
	conn: DbOrTx,
	args: Args,
	who: { clubId: string; userId: string },
	meetingId: string,
	confirmNew: ReadonlySet<number>,
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, meetingId);
	const blocking: RollBlockingItem[] = [];
	// The write class's own policy: cancelled is refused, completed accepted.
	const refused = meetingRefusal(facts.status, "record");
	if (refused !== null) {
		const item = recordRefusalItem(refused);
		blocking.push({ code: item.code, message: item.message });
	} else if (!meetingDateReached(facts.scheduledAt, facts.timezone)) {
		blocking.push({
			code: "ATTENDANCE_BEFORE_MEETING",
			message: ATTENDANCE_BEFORE_MEETING_MESSAGE,
		});
	}

	const memberArgs = args.members ?? [];
	const guestArgs = args.guests ?? [];
	const removeArgs = args.removeGuests ?? [];

	// The roll as it stands, read once.
	const rollRows = await conn
		.select({
			memberId: meetingAttendance.memberId,
			guestId: meetingAttendance.guestId,
			status: meetingAttendance.status,
			mode: meetingAttendance.mode,
		})
		.from(meetingAttendance)
		.where(eq(meetingAttendance.meetingId, facts.meetingId));
	const memberRoll = new Map<string, Roll>();
	const guestRoll = new Map<string, Mode | null>();
	for (const r of rollRows) {
		if (r.memberId) {
			memberRoll.set(r.memberId, {
				status: r.status as Status,
				mode: (r.mode as Mode | null) ?? null,
			});
		} else if (r.guestId)
			guestRoll.set(r.guestId, (r.mode as Mode | null) ?? null);
	}

	// The meeting's club only, any membership status: the writer's own rule
	// (`requireMemberInMeetingClub`).
	const memberRows = await conn
		.select({
			id: members.id,
			name: members.name,
			preferredName: members.preferredName,
		})
		.from(members)
		.where(eq(members.clubId, facts.clubId));
	const memberById = new Map(memberRows.map((m) => [m.id.toLowerCase(), m]));
	const guestCandidates = await loadGuestMatchCandidates(conn, facts.clubId);
	const guestById = new Map(
		guestCandidates.map((g) => [g.id.toLowerCase(), g]),
	);

	// One person, one line. Keys are canonical ids (or a folded new name).
	const seen = new Map<string, string>();
	const claim = (
		key: string,
		list: RollBlockingItem["list"],
		index: number,
		label: string,
	): boolean => {
		if (seen.has(key)) {
			blocking.push({
				code: "DUPLICATE_PERSON",
				list,
				entryIndex: index,
				message: `${label} is listed more than once in this call. Send one line per person.`,
			});
			return false;
		}
		seen.set(key, `${list}:${index}`);
		return true;
	};

	const memberLines: MemberLine[] = memberArgs.map((m, index) => {
		const row = memberById.get(m.memberId.toLowerCase());
		const memberId = row?.id ?? m.memberId;
		const before = (row && memberRoll.get(row.id)) || {
			status: null,
			mode: null,
		};
		const mode: Mode | null =
			m.status === "present" ? (m.mode ?? before.mode) : null;
		const after: Roll = { status: m.status, mode };
		if (!row) {
			blocking.push({
				code: "NOT_A_MEMBER",
				list: "members",
				entryIndex: index,
				message:
					"That is not a member of this meeting's club. find_people lists who is.",
			});
			return {
				index,
				memberId,
				name: null,
				verdict: "blocked" as const,
				before,
				after,
			};
		}
		claim(`member:${row.id}`, "members", index, row.name);
		const same = before.status === after.status && before.mode === after.mode;
		return {
			index,
			memberId,
			name: row.name,
			verdict: same ? ("already_recorded" as const) : ("change" as const),
			before,
			after,
		};
	});

	const cc = await loadClubDefaultCountryCode(facts.clubId);
	const guestLines: GuestLine[] = [];
	for (const [index, g] of guestArgs.entries()) {
		const mode = g.mode ?? null;
		if ("guestId" in g) {
			const row = guestById.get(g.guestId.toLowerCase());
			if (!row) {
				blocking.push({
					code: "NOT_A_GUEST",
					list: "guests",
					entryIndex: index,
					message:
						"That is not a guest of this meeting's club. find_people lists them; a guest staged by record_guest_book exists only once its confirm page is applied.",
				});
				guestLines.push(blankGuestLine(index, g.guestId, mode));
				continue;
			}
			claim(`guest:${row.id}`, "guests", index, row.name);
			guestLines.push(
				existingGuestLine(index, row, guestRoll, mode, {
					matchedByContact: false,
				}),
			);
			continue;
		}

		const name = g.newGuest.name.trim();
		const email = g.newGuest.email?.trim() || null;
		const phone = g.newGuest.phone?.trim()
			? toStoredPhone(g.newGuest.phone.trim(), cc)
			: null;
		// What the roll writer would resolve to by contact: the same call.
		const byContact = await findGuestForContact(conn, facts.clubId, {
			name,
			email,
			phone,
		});
		if (byContact) {
			const row = guestById.get(byContact.id.toLowerCase());
			if (row) {
				claim(`guest:${row.id}`, "guests", index, row.name);
				guestLines.push({
					...existingGuestLine(index, row, guestRoll, mode, {
						matchedByContact: true,
					}),
					email,
					phone,
				});
				continue;
			}
		}
		const close = [
			...guestCandidates
				.filter((c) => closeTo(name, c))
				.map((c) => ({ kind: "guest" as const, id: c.id, name: c.name })),
			...memberRows
				.filter((m) => closeTo(name, m))
				.map((m) => ({ kind: "member" as const, id: m.id, name: m.name })),
		].slice(0, MAX_MATCHES);
		claim(`new:${fold(name)}`, "guests", index, name);
		const ambiguous = close.length > 0;
		guestLines.push({
			index,
			guestId: null,
			name,
			email,
			phone,
			verdict: ambiguous ? "ambiguous" : "would_create",
			matchedByContact: false,
			before: { present: false, mode: null },
			after: { present: true, mode },
			possibleMatches: close,
			confirmed: ambiguous && confirmNew.has(index),
			mode,
		});
	}

	const removeLines: RemoveLine[] = removeArgs.map((id, index) => {
		const row = guestById.get(id.toLowerCase());
		if (!row) {
			blocking.push({
				code: "NOT_A_GUEST",
				list: "removeGuests",
				entryIndex: index,
				message: "That is not a guest of this meeting's club.",
			});
			return { index, guestId: id, name: null, verdict: "blocked" as const };
		}
		const added = seen.get(`guest:${row.id}`);
		if (added?.startsWith("guests:")) {
			blocking.push({
				code: "CONFLICTING_GUEST_ENTRIES",
				list: "removeGuests",
				entryIndex: index,
				message: `${row.name} is both added and removed in this call. Send one of the two.`,
			});
		} else claim(`guest:${row.id}`, "removeGuests", index, row.name);
		return {
			index,
			guestId: row.id,
			name: row.name,
			verdict: guestRoll.has(row.id)
				? ("remove" as const)
				: ("already_recorded" as const),
		};
	});

	const plan: Plan = {
		meeting: meetingPlanHeader(facts),
		members: memberLines,
		guests: guestLines,
		removeGuests: removeLines,
		summary: {
			memberChanges: memberLines.filter((l) => l.verdict === "change").length,
			guestsToAdd: guestLines.filter((l) => l.verdict === "add").length,
			guestsToCreate: guestLines.filter(
				(l) =>
					l.verdict === "would_create" ||
					(l.verdict === "ambiguous" && l.confirmed),
			).length,
			guestModeChanges: guestLines.filter((l) => l.verdict === "change_mode")
				.length,
			guestsToRemove: removeLines.filter((l) => l.verdict === "remove").length,
			alreadyRecorded:
				memberLines.filter((l) => l.verdict === "already_recorded").length +
				guestLines.filter((l) => l.verdict === "already_recorded").length +
				removeLines.filter((l) => l.verdict === "already_recorded").length,
			ambiguousSkipped: guestLines.filter(
				(l) => l.verdict === "ambiguous" && !l.confirmed,
			).length,
		},
	};
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan,
		}),
		blocking,
		facts,
	};
}

function blankGuestLine(
	index: number,
	guestId: string,
	mode: Mode | null,
): GuestLine {
	return {
		index,
		guestId,
		name: null,
		email: null,
		phone: null,
		verdict: "blocked",
		matchedByContact: false,
		before: { present: false, mode: null },
		after: { present: true, mode },
		possibleMatches: [],
		confirmed: false,
		mode,
	};
}

/** A line for a guest that already exists in the club. */
function existingGuestLine(
	index: number,
	row: { id: string; name: string },
	guestRoll: ReadonlyMap<string, Mode | null>,
	mode: Mode | null,
	extra: { matchedByContact: boolean },
): GuestLine {
	const present = guestRoll.has(row.id);
	const beforeMode = guestRoll.get(row.id) ?? null;
	// A mode on an already-present guest replaces theirs (replaceMode); with no
	// mode a recorded one stays.
	const afterMode = present ? (mode ?? beforeMode) : mode;
	const verdict: GuestLine["verdict"] = !present
		? "add"
		: afterMode === beforeMode
			? "already_recorded"
			: "change_mode";
	return {
		index,
		guestId: row.id,
		name: row.name,
		email: null,
		phone: null,
		verdict,
		matchedByContact: extra.matchedByContact,
		before: { present, mode: beforeMode },
		after: { present: true, mode: afterMode },
		possibleMatches: [],
		confirmed: false,
		mode,
	};
}

export const recordAttendanceTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// A present member can be re-marked absent and a guest taken off the roll;
	// sending the same call again changes nothing more.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Record who attended a meeting",
		description:
			"Record who WAS at a meeting (the roll), as a club admin does in the " +
			"app after or at the meeting: mark members present, absent or excused " +
			"(mode in_person or online only with present), add guests (an existing " +
			"guestId, or a newGuest) and take guests off the roll (removeGuests; the " +
			"club guest is kept). This is the RECORD of who came, not who PLANS to " +
			"come: for a plan use set_attendance or set_my_attendance. A completed " +
			"meeting is accepted; a cancelled one and one before its day are " +
			"refused. Find ids with find_people and list_meetings. Call once " +
			"WITHOUT planHash to preview (nothing is written; each line says what " +
			"changes or that it is already recorded), show the plan to the user in " +
			"full, and only after they agree call again with the same input plus " +
			"the planHash. Any blocking item stops the whole apply. A newGuest " +
			"whose name is close to an existing guest or member is ambiguous and is " +
			"SKIPPED unless its position in `guests` is in confirmNew: ask the user " +
			"whether it is someone new (if it is the existing person, use their " +
			"guestId or memberId instead); confirmNew is part of the plan, so " +
			"preview again after filling it. This never frees a member's roles, and " +
			"GavelUp tells no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		if (
			!args.members?.length &&
			!args.guests?.length &&
			!args.removeGuests?.length
		) {
			throw new McpError(
				"VALIDATION",
				"Send at least one of members, guests or removeGuests.",
			);
		}
		const guestCount = args.guests?.length ?? 0;
		for (const i of args.confirmNew ?? []) {
			const g = args.guests?.[i];
			if (!g || !("newGuest" in g)) {
				throw new McpError(
					"VALIDATION",
					`confirmNew lists position ${i}, which is not a newGuest entry in guests (${guestCount} entries).`,
				);
			}
		}
		const confirmNew = new Set(args.confirmNew ?? []);
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const who = { clubId: club.clubId, userId: user.id };

		if (!args.planHash) {
			const c = await compute(db, args, who, args.meetingId, confirmNew);
			return {
				applied: false,
				plan: c.plan,
				planHash: c.planHash,
				blocking: c.blocking,
			};
		}

		const hash = args.planHash;
		return db.transaction(async (tx) => {
			await lockClubForWrite(tx, who.clubId);
			const c0 = await compute(tx, args, who, args.meetingId, confirmNew);
			// Every member of this club the call names, locked against a merge
			// before any write (#1035), after the club lock as set_attendance does.
			const memberIds = c0.plan.members
				.filter((l) => l.verdict !== "blocked")
				.map((l) => l.memberId);
			if (memberIds.length > 0)
				await lockMembershipsAgainstMerge(tx, memberIds);
			const c = memberIds.length
				? await compute(tx, args, who, args.meetingId, confirmNew)
				: c0;
			if (c.planHash !== hash) {
				throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
					plan: c.plan,
					planHash: c.planHash,
					blocking: c.blocking,
				});
			}
			const first = c.blocking[0];
			if (first) {
				throw new McpError("BLOCKED", first.message, {
					blocking: c.blocking,
				});
			}

			const meetingId = c.facts.meetingId;
			for (const l of c.plan.members) {
				if (l.verdict !== "change") continue;
				await setMemberPresence(
					{
						meetingId,
						memberId: l.memberId,
						status: l.after.status as Status,
						// The writer clears a mode for anything but present.
						...(l.after.status === "present" && l.after.mode
							? { mode: l.after.mode }
							: {}),
					},
					tx,
				);
			}
			const written: { index: number; guestId: string }[] = [];
			for (const l of c.plan.guests) {
				const arg = args.guests?.[l.index];
				if (!arg) continue;
				if (l.verdict === "add" || l.verdict === "change_mode") {
					if (!l.guestId) continue;
					const r = await addGuestPresent(
						{
							meetingId,
							guestId: l.guestId,
							...(l.mode ? { mode: l.mode, replaceMode: true } : {}),
						},
						tx,
					);
					written.push({ index: l.index, guestId: r.guestId });
				} else if (
					l.verdict === "would_create" ||
					(l.verdict === "ambiguous" && l.confirmed)
				) {
					if (!("newGuest" in arg)) continue;
					const r = await addGuestPresent(
						{
							meetingId,
							newGuest: {
								name: arg.newGuest.name,
								email: arg.newGuest.email,
								phone: arg.newGuest.phone,
							},
							...(l.mode ? { mode: l.mode } : {}),
						},
						tx,
					);
					written.push({ index: l.index, guestId: r.guestId });
				}
			}
			for (const l of c.plan.removeGuests) {
				if (l.verdict !== "remove") continue;
				await removeGuestPresent({ meetingId, guestId: l.guestId }, tx);
			}
			return {
				applied: true,
				plan: c.plan,
				written,
				skipped: c.plan.guests
					.filter((l) => l.verdict === "ambiguous" && !l.confirmed)
					.map((l) => ({
						index: l.index,
						name: l.name,
						possibleMatches: l.possibleMatches,
						note: "Not added: possibly someone already known. Ask the user; if new, preview again with its position in confirmNew.",
					})),
				note: "GavelUp tells no one. Roles held by an absent member are not freed.",
			};
		});
	},
};
