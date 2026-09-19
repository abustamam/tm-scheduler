/**
 * `record_guest_book` — transcribe a page of the paper guest book (#773, D7).
 *
 * The one WRITE tool in PR1, and the one that proves the preview→apply loop on
 * real data. The shape every later write tool inherits:
 *
 *   - **No `planHash`** → plan against the database and return
 *     `{plan, planHash, blocking}`. Nothing is written.
 *   - **With `planHash`** → one transaction: take the club lock, re-plan against
 *     `tx`, refuse as `PLAN_STALE` if the hash moved, refuse as `BLOCKED` if
 *     anything is still blocking, then execute **the plan** (not the input) and
 *     log inside the same transaction.
 *
 * A call applies entirely or not at all. Problems with individual entries are
 * `blocking` items in the preview, and apply refuses while any remain — a
 * half-transcribed page is worse than a refused one, because the half that
 * landed is invisible next to the half that did not.
 *
 * **One meeting per call.** The paper book records no dates; the maintainer says
 * which meeting a page belongs to, and the plan header names the meeting back
 * (number, club-local date, theme) so a wrong date is visible before anything is
 * written rather than after it reaches the minutes email.
 *
 * **Candidates are loaded ONCE per call**, not queried per entry: a 100-entry
 * page would otherwise be ~200 round trips in the preview and again inside the
 * locked transaction, and the locked section must stay short.
 *
 * ## Two plans, one of them internal
 *
 * The plan is built in FULL — carrying the exact values an apply would write —
 * and the hash is taken over that. What leaves the server is a MASKED
 * projection of it (D9). The two exist for opposite reasons and both are load
 * bearing:
 *
 *   - Hashing the full plan is what makes the hash mean "the state you were
 *     shown, and the values you asked for". Hashing the masked projection would
 *     not: `jane@x.com` and `julia@x.com` both mask to `j•••@x.com`, so a
 *     preview of one could be applied as the other with a matching hash.
 *   - Returning the masked projection is what keeps a visitor's real email and
 *     phone out of an LLM provider's transcript.
 *
 * The caller never needs the full plan: it echoes the hash back verbatim, and
 * the apply rebuilds the full plan server-side from the same input.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { guests, meetingAttendance, meetings } from "#/db/schema";
import { localDate, nextLocalDate } from "#/lib/club-local-date";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { MAX_GUEST_BOOK_ENTRIES } from "#/lib/mcp-limits";
import { planHash as computePlanHash } from "#/lib/mcp-plan";
import {
	ATTENDANCE_BEFORE_MEETING_MESSAGE,
	meetingDateReached,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNumber } from "#/lib/meeting-number";
import { toStoredPhone } from "#/lib/phone";
import { logActivity } from "#/server/activity";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import {
	type GuestMatchCandidate,
	loadGuestMatchCandidates,
	matchGuest,
	normalizePhone,
} from "#/server/guest-pipeline-logic";
import { authorizeToken, type TokenClub } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import { lockClub } from "../lock";
import { maskEmail, maskPhone } from "../serialize";
import type { McpToolDefinition } from "../tool";

const entrySchema = z.object({
	name: z.string().trim().min(1).max(200),
	preferredName: z.string().trim().max(200).optional(),
	email: z.string().trim().max(320).optional(),
	phone: z.string().trim().max(50).optional(),
});

const inputSchema = {
	clubId: z.string().uuid(),
	meetingDate: localDate.describe("The club-local date of the meeting."),
	entries: z.array(entrySchema).min(1).max(MAX_GUEST_BOOK_ENTRIES),
	resolve: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			'Answers to ambiguous entries: {"<entryIndex>": "<guestId>" | "new"}.',
		),
	planHash: z
		.string()
		.optional()
		.describe("Omit to preview. Pass the hash from a preview to apply it."),
};

type Entry = z.infer<typeof entrySchema>;

export type GuestBookOutcome =
	| "matched"
	| "new"
	| "ambiguous"
	| "already_present";

/**
 * What the plan says will happen to one line of the page — the FULL form,
 * carrying the values an apply writes. Never returned to a caller; see the
 * module header.
 */
interface PlannedEntry {
	index: number;
	outcome: GuestBookOutcome;
	/** The guest this line resolves to; null for `new` and `ambiguous`. */
	guestId: string | null;
	/** How the match was made, for a human deciding whether to trust it. */
	via: "email" | "phone" | "resolved" | null;
	/** The existing guest's name, when it differs from what is written down. */
	matchedName: string | null;
	/** This line will be a default recipient of the minutes email. */
	minutesRecipient: boolean;
	/** Exactly what an apply would insert for a `new` line. */
	write: {
		name: string;
		preferredName: string | null;
		email: string | null;
		phone: string | null;
	} | null;
	/** What was written on the page, for the masked projection. */
	source: { name: string; email: string | null; phone: string | null };
}

/**
 * The hashed plan.
 *
 * `meetingNumber` is deliberately NOT here. It is DERIVED by counting held
 * meetings forward from the club's most recent numbered one
 * (`deriveMeetingNumber`), so it depends on rows this plan does not touch —
 * backfilling a number onto any earlier meeting changes it. Hashing it violated
 * D5 ("a plan contains only the rows it would touch, so a write elsewhere in
 * the club does not make it stale") and made an ordinary backfill fail every
 * outstanding apply as `PLAN_STALE`, which is indistinguishable from a database
 * race and is the exact failure the design's own table warns about.
 *
 * MEASURED: with the number in the hash, inserting one numbered earlier meeting
 * moved the header from `null` to `41` and changed the hash, with no row the
 * plan touches altered. The number is still SHOWN — it rides alongside in
 * `toPublicPlan`, where a human reads it and nothing compares it.
 */
interface GuestBookPlan {
	meeting: {
		meetingId: string;
		date: string;
		theme: string | null;
	};
	entries: PlannedEntry[];
}

type Conn =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Build the full plan. Shared by the preview and by the re-plan inside the
 * apply transaction, so the two cannot drift — which is the whole basis of the
 * hash comparison.
 */
async function plan(
	conn: Conn,
	club: TokenClub,
	args: {
		meetingDate: string;
		entries: Entry[];
		resolve?: Record<string, string>;
	},
	countryCode: string,
): Promise<{
	plan: GuestBookPlan | null;
	blocking: McpBlockingItem[];
	/** Shown to the caller, never hashed — see `GuestBookPlan`. */
	meetingNumber: number | null;
}> {
	const blocking: McpBlockingItem[] = [];

	// The club-local DAY the caller named, as an instant range. Both bounds are
	// converted from club-local midnights rather than derived by adding 24h to
	// the first: across a DST boundary the local day is 23 or 25 hours long.
	const dayStart = zonedWallTimeToUtc(
		`${args.meetingDate}T00:00`,
		club.timezone,
	);
	const dayEnd = zonedWallTimeToUtc(
		`${nextLocalDate(args.meetingDate)}T00:00`,
		club.timezone,
	);

	// A date is not a meeting: it can name none, or two.
	const onDate = await conn
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
		})
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, club.clubId),
				gte(meetings.scheduledAt, dayStart),
				lt(meetings.scheduledAt, dayEnd),
			),
		);

	// Neither of these THROWS. A date that names no meeting, or two, is a
	// blocking item rather than an error: the preview succeeded, and what it has
	// to say is "I cannot tell which meeting this page belongs to". A caller gets
	// a structured item it can show and act on, and apply refuses while it
	// stands — the same handling every other blocking item gets, rather than a
	// second failure shape for the same kind of problem. There is no plan to
	// return alongside it, because the plan's header IS the meeting.
	if (onDate.length === 0) {
		return {
			plan: null,
			meetingNumber: null,
			blocking: [
				{
					code: "NO_MEETING_ON_DATE",
					message: `No meeting on ${args.meetingDate} for this club. Check list_meetings for the right date.`,
					detail: { meetingDate: args.meetingDate },
				},
			],
		};
	}
	if (onDate.length > 1) {
		// The unique index covers the exact instant, not the date, so two meetings
		// can share a day. Which one a page belongs to is not ours to guess.
		return {
			plan: null,
			meetingNumber: null,
			blocking: [
				{
					code: "AMBIGUOUS_DATE",
					message: `${onDate.length} meetings on ${args.meetingDate}. Check list_meetings and say which one this page belongs to.`,
					detail: { meetingIds: onDate.map((m) => m.id) },
				},
			],
		};
	}
	// biome-ignore lint/style/noNonNullAssertion: length checked immediately above
	const meeting = onDate[0]!;

	// Attendance is the RECORD of who was in the room (ADR-0014): nothing about a
	// meeting that has not happened can produce one, and the row is not inert —
	// it feeds the minutes PDF and the minutes email.
	if (!meetingDateReached(meeting.scheduledAt, club.timezone)) {
		throw new McpError("NOT_RECORDABLE", ATTENDANCE_BEFORE_MEETING_MESSAGE);
	}

	const spine = await conn
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.clubId, club.clubId));
	spine.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

	// ONE query for the club's guests, not one per entry.
	const candidates = await loadGuestMatchCandidates(conn, club.clubId);
	const byId = new Map(candidates.map((c) => [c.id, c]));

	// Who already has attendance at this meeting — what turns `matched` into
	// `already_present`, and what makes re-transcribing a page a no-op.
	const present = new Set(
		(
			await conn
				.select({ guestId: meetingAttendance.guestId })
				.from(meetingAttendance)
				.where(eq(meetingAttendance.meetingId, meeting.id))
		).flatMap((r) => (r.guestId ? [r.guestId] : [])),
	);

	// Guests planned as NEW earlier on this page become candidates for later
	// lines, so a page naming the same visitor twice produces one guest and one
	// attendance row rather than two of each. Their synthetic ids never reach the
	// database — an entry matching one is itself planned as a duplicate line.
	const plannedNew: GuestMatchCandidate[] = [];

	const entries: PlannedEntry[] = args.entries.map((raw, index) => {
		const email = raw.email?.trim() || null;
		const typedPhone = raw.phone?.trim() || null;
		const phone = toStoredPhone(typedPhone, countryCode);
		// `toStoredPhone` never returns null for non-empty input — it DELIBERATELY
		// keeps what it cannot normalize, so a number the app could not parse is
		// still visible and editable to the member it belongs to (#295). So the
		// test for "unusable" is digits, not null: a value with no digits at all
		// cannot match anyone and cannot be dialled, and on a TRANSCRIPTION path
		// that is a misread line worth asking about rather than a contact detail
		// worth storing. Anything with digits stores exactly as the browser paths
		// store it, odd formatting included.
		if (typedPhone && !normalizePhone(phone)) {
			blocking.push({
				code: "INVALID_PHONE",
				entryIndex: index,
				message: `Entry ${index}: "${typedPhone}" has no digits in it — check that line of the page.`,
			});
		}

		// A guest marked present becomes a DEFAULT RECIPIENT of this meeting's
		// minutes email (`minutes-email-port-logic.ts:54`), and
		// `resolveMinutesRecipients` only checks the string is non-empty before
		// handing it to the mailer. Both other paths that write `guests.email`
		// validate the format — the public guest book
		// (`guest-pipeline-schemas.ts:33`) and the admin edit
		// (`guest-pipeline.ts:85`) both use `z.string().trim().email()`. This one
		// is fed by an LLM reading HANDWRITING, so it is the path most likely to
		// produce a malformed address and was the only one not checking.
		//
		// Blocking rather than a zod rejection on the schema: a hard failure would
		// throw out a whole page because one line was misread, and the blocking
		// mechanism exists to say which line to look at.
		if (email && !z.string().email().safeParse(email).success) {
			blocking.push({
				code: "INVALID_EMAIL",
				entryIndex: index,
				message: `Entry ${index}: that email address is not valid — check that line of the page.`,
			});
		}

		const source = { name: raw.name, email, phone };
		const write = {
			name: raw.name,
			preferredName: raw.preferredName?.trim() || null,
			email,
			phone,
		};
		const base = {
			index,
			source,
			matchedName: null as string | null,
			via: null as PlannedEntry["via"],
		};

		const asNew = (): PlannedEntry => {
			plannedNew.push({
				id: `new:${index}`,
				name: raw.name,
				email,
				phone,
				createdAt: new Date(0),
			});
			return {
				...base,
				outcome: "new",
				guestId: null,
				minutesRecipient: Boolean(email),
				write,
			};
		};

		// An explicit answer from the caller settles an earlier `ambiguous`.
		const answer = args.resolve?.[String(index)];
		if (answer === "new") return asNew();
		if (answer) {
			const chosen = byId.get(answer);
			if (!chosen) {
				blocking.push({
					code: "AMBIGUOUS_GUEST",
					entryIndex: index,
					message: `Entry ${index}: the guest named to resolve this line is not a guest of this club.`,
				});
				return {
					...base,
					outcome: "ambiguous",
					guestId: null,
					minutesRecipient: false,
					write: null,
				};
			}
			const already = present.has(chosen.id);
			return {
				...base,
				outcome: already ? "already_present" : "matched",
				guestId: chosen.id,
				via: "resolved",
				matchedName: chosen.name === raw.name ? null : chosen.name,
				minutesRecipient: !already && Boolean(chosen.email ?? email),
				write: null,
			};
		}

		const m = matchGuest(
			[...candidates, ...plannedNew],
			{ name: raw.name, email, phone },
			// MCP planning asks about a name-only line whose name matches someone
			// already on file; the public guest book keeps creating a new guest
			// there, because a name is not a dedup key.
			{ nameOnlyAmbiguity: true },
		);

		if (m.outcome === "ambiguous") {
			blocking.push({
				code: "AMBIGUOUS_GUEST",
				entryIndex: index,
				message:
					m.reason === "phone_name_disagree"
						? `Entry ${index}: that phone number is on file under a different name. Say which guest this is, or that it is someone new.`
						: `Entry ${index}: a guest with that name is already on file and this line has no email or phone. Say which guest this is, or that it is someone new.`,
				detail: {
					reason: m.reason,
					candidates: m.candidates.map((c) => ({
						guestId: c.id,
						name: c.name,
						emailMasked: maskEmail(c.email),
						phoneMasked: maskPhone(c.phone),
					})),
				},
			});
			return {
				...base,
				outcome: "ambiguous",
				guestId: null,
				minutesRecipient: false,
				write: null,
			};
		}

		if (m.outcome === "new") return asNew();

		// Matched a guest this same page already plans to create: one guest, one
		// attendance row, and the earlier line is the one that creates them.
		if (m.guest.id.startsWith("new:")) {
			return {
				...base,
				outcome: "already_present",
				guestId: null,
				via: m.via,
				matchedName: m.guest.name === raw.name ? null : m.guest.name,
				minutesRecipient: false,
				write: null,
			};
		}

		const already = present.has(m.guest.id);
		return {
			...base,
			outcome: already ? "already_present" : "matched",
			guestId: m.guest.id,
			via: m.via,
			matchedName: m.guest.name === raw.name ? null : m.guest.name,
			minutesRecipient: !already && Boolean(m.guest.email ?? email),
			write: null,
		};
	});

	return {
		plan: {
			meeting: {
				meetingId: meeting.id,
				date: utcToZonedWallTime(meeting.scheduledAt, club.timezone).slice(
					0,
					10,
				),
				theme: meeting.theme,
			},
			entries,
		},
		blocking,
		// Alongside the plan, never inside it — see `GuestBookPlan`.
		meetingNumber: deriveMeetingNumber(spine, meeting.id),
	};
}

/**
 * The plan as a caller sees it: every contact field masked, and the internal
 * `write` block dropped. The `summary` is what a human actually reads before
 * saying yes.
 */
function toPublicPlan(p: GuestBookPlan, meetingNumber: number | null) {
	const counts = {
		matched: 0,
		new: 0,
		ambiguous: 0,
		already_present: 0,
	} satisfies Record<GuestBookOutcome, number>;
	for (const e of p.entries) counts[e.outcome]++;

	return {
		// The derived number rejoins the header HERE, outside the hash, because
		// this is where a human reads it (see `GuestBookPlan`).
		meeting: { ...p.meeting, meetingNumber },
		summary: {
			...counts,
			// "How many people will this page add to the minutes email" is the
			// question a transcriber most wants answered before saying yes.
			minutesRecipients: p.entries.filter((e) => e.minutesRecipient).length,
			// When EVERY line is already present, the likeliest explanation is that
			// this page was transcribed before — worth saying, because the apply
			// would otherwise succeed while writing nothing and look like it worked.
			probablyAlreadyTranscribed:
				p.entries.length > 0 && counts.already_present === p.entries.length,
		},
		entries: p.entries.map((e) => ({
			index: e.index,
			name: e.source.name,
			emailMasked: maskEmail(e.source.email),
			phoneMasked: maskPhone(e.source.phone),
			outcome: e.outcome,
			guestId: e.guestId,
			via: e.via,
			matchedName: e.matchedName,
			minutesRecipient: e.minutesRecipient,
		})),
	};
}

export const recordGuestBookTool: McpToolDefinition = {
	name: "record_guest_book",
	config: {
		title: "Record guest book",
		description:
			"Record a page of the paper guest book against one meeting. Call it " +
			"WITHOUT planHash first: it writes nothing and returns a plan saying " +
			"what each line would do. Show that plan to the user, get an explicit " +
			"yes, then call again with the same input plus the planHash. Never " +
			"resolve an `ambiguous` line yourself — ask the user which guest it is.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx.rawToken, args.clubId);
		const countryCode = await loadClubDefaultCountryCode(club.clubId);
		const hashOf = (p: GuestBookPlan) =>
			computePlanHash({
				tool: "record_guest_book",
				clubId: club.clubId,
				userId: user.id,
				plan: p,
			});

		// ---- Preview: nothing is written ----------------------------------
		if (!args.planHash) {
			const {
				plan: p,
				blocking,
				meetingNumber,
			} = await plan(db, club, args, countryCode);
			// No plan means the meeting could not be identified. There is nothing
			// to hash and nothing to approve — only the blocking item to answer.
			if (!p) return { applied: false, plan: null, blocking, planHash: null };
			return {
				applied: false,
				...toPublicPlan(p, meetingNumber),
				blocking,
				planHash: hashOf(p),
			};
		}

		// ---- Apply --------------------------------------------------------
		return db.transaction(async (tx) => {
			// Serialise MCP applies on this club before reading anything, so the
			// re-plan below sees a state no other apply can move underneath it.
			await lockClub(tx, club.clubId);

			const {
				plan: fresh,
				blocking,
				meetingNumber,
			} = await plan(tx, club, args, countryCode);
			// The meeting stopped being identifiable between preview and apply —
			// it was rescheduled or deleted, or a second one was added to the day.
			// Nothing is written; the transaction rolls back on throw.
			if (!fresh) {
				throw new McpError(
					"BLOCKED",
					"That date no longer names one meeting. Preview again.",
					{ blocking },
				);
			}
			const freshHash = hashOf(fresh);

			if (freshHash !== args.planHash) {
				// Nothing has been written: the transaction rolls back on throw.
				throw new McpError(
					"PLAN_STALE",
					"The club changed since that preview. Here is a fresh plan — show it and ask again.",
					{
						...toPublicPlan(fresh, meetingNumber),
						blocking,
						planHash: freshHash,
					},
				);
			}
			if (blocking.length > 0) {
				throw new McpError(
					"BLOCKED",
					"Some lines still need an answer. Resolve them and preview again.",
					{ blocking },
				);
			}

			// Execute THE PLAN, not the input.
			const newGuestIds: string[] = [];
			const matchedGuestIds: string[] = [];
			const attendanceFor: string[] = [];

			for (const e of fresh.entries) {
				if (e.outcome === "new" && e.write) {
					const [row] = await tx
						.insert(guests)
						.values({
							clubId: club.clubId,
							name: e.write.name,
							preferredName: e.write.preferredName,
							email: e.write.email,
							phone: e.write.phone,
							// This tool never changes a guest's stage, and a brand-new
							// visitor starts where the guest book's own front door starts
							// them (ADR-0018).
							stage: "prospect",
						})
						.returning({ id: guests.id });
					if (!row) throw new McpError("INTERNAL", "Failed to create guest.");
					newGuestIds.push(row.id);
					attendanceFor.push(row.id);
				} else if (e.outcome === "matched" && e.guestId) {
					matchedGuestIds.push(e.guestId);
					attendanceFor.push(e.guestId);
				}
			}

			if (attendanceFor.length > 0) {
				await tx
					.insert(meetingAttendance)
					.values(
						attendanceFor.map((guestId) => ({
							meetingId: fresh.meeting.meetingId,
							guestId,
							status: "present" as const,
						})),
					)
					// Idempotent per (meeting, guest) — the same safety net the public
					// guest book and the minutes editor both rely on.
					.onConflictDoNothing({
						target: [meetingAttendance.meetingId, meetingAttendance.guestId],
					});
			}

			// Same transaction as the writes, so the two commit together (D10).
			// The detail carries IDS ONLY — every member of the club can read the
			// activity feed, and a visitor's name and email are not theirs to read.
			await logActivity(tx, {
				clubId: club.clubId,
				actorMemberId: club.membershipId,
				action: "guest_visits_record",
				targetType: "meeting",
				targetId: fresh.meeting.meetingId,
				detail: {
					meetingId: fresh.meeting.meetingId,
					newGuestIds,
					matchedGuestIds,
					via: "mcp",
				},
			});

			return {
				applied: true,
				meeting: { ...fresh.meeting, meetingNumber },
				summary: toPublicPlan(fresh, meetingNumber).summary,
				newGuestIds,
				matchedGuestIds,
				attendanceRecorded: attendanceFor.length,
			};
		});
	},
};
