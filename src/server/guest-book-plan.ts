/**
 * Planning a transcribed page of the guest book — the one implementation, for
 * both callers (#773 D7, extracted by #806).
 *
 * Two surfaces now plan the same page: `record_guest_book` previews it, and the
 * confirm page re-plans it on every render, on every edit, and once more inside
 * the apply transaction. The hash comparison that makes the whole mechanism
 * safe is only meaningful while those four plans are the same function of the
 * same inputs, so there is exactly one `plan()` and it lives here.
 *
 * ## Why here and not under `src/server/mcp/`
 *
 * The forcing constraint is the APPLY, not this function.
 * `mcp-authz.guard.test.ts` sweeps every `.ts` under `src/server/mcp/` and fails
 * any that imports `requireClubRole` / `requireMembership` / `requireUser` /
 * `getSessionUser` / `requestWriteActor` — `/api/mcp` is bearer-only, and that
 * is the entire CSRF posture. The confirm page's apply is a SESSION action, so
 * it cannot live in that tree. `plan()` moves with it so one module owns
 * planning for both callers, rather than the session path importing back into
 * the token path.
 *
 * `blocking-codes.guard.test.ts` follows the move: every `McpBlockingCode` is
 * raised inside this file and nowhere else, so that guard sweeps this path
 * explicitly. Do not relax it — a declared code nothing emits tells the next
 * reader the case is handled.
 *
 * ## Two projections, and why the plan itself carries full values
 *
 * `plan()` returns FULL contact values throughout — in the plan AND in the
 * blocking list's ambiguity candidates. Masking happens on the way OUT, in two
 * projections, because the two lists leave by different doors:
 *
 *   - `toPublicPlan()` masks the plan for an MCP caller.
 *   - `toPublicBlocking()` masks the blocking list for the same caller. It is a
 *     SIBLING of the plan in the return, not a field inside it, so the first
 *     projection cannot reach it — and the candidate list is exactly where an
 *     email is the only thing distinguishing two guests with the same name.
 *
 * The confirm page applies NEITHER. It is an authenticated club admin looking
 * at their own club's visitors, on the surface whose entire purpose is checking
 * those values against the paper in front of them; masking there would defeat
 * the feature. Masking exists for the LLM transcript, not for the admin.
 *
 * Hashing runs over the FULL plan for a third reason again: `jane@x.com` and
 * `julia@x.com` both mask to `j•••@x.com`, so a hash over the masked form would
 * let a preview of one be applied as the other.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import type { db } from "#/db";
import { meetingAttendance, meetings } from "#/db/schema";
import { nextLocalDate } from "#/lib/club-local-date";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { planHash as computePlanHash } from "#/lib/mcp-plan";
import {
	ATTENDANCE_BEFORE_MEETING_MESSAGE,
	meetingDateReached,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNumber } from "#/lib/meeting-number";
import { toStoredPhone } from "#/lib/phone";
import {
	type GuestMatchCandidate,
	loadGuestMatchCandidates,
	matchGuest,
	normalizePhone,
} from "#/server/guest-pipeline-logic";
import { type McpBlockingItem, McpError } from "#/server/mcp/errors";
import { maskEmail, maskPhone } from "#/server/mcp/serialize";

export type Conn =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * The club facts a plan is built from.
 *
 * Narrowed from `TokenClub` (#806): the session path holds a
 * `ResolvedMembership` and never has one of those, and these two fields are all
 * `plan()` reads. `membershipId` is deliberately NOT here — nothing in planning
 * credits a writer, and it travels with the apply, which is the only thing that
 * does.
 */
export interface PlanClub {
	clubId: string;
	timezone: string;
}

/** One transcribed line, as the planner takes it. Positional — see `entryIndex`. */
export interface PlanEntryInput {
	name: string;
	preferredName?: string;
	email?: string;
	phone?: string;
}

export interface PlanArgs {
	meetingDate: string;
	entries: PlanEntryInput[];
	/** Answers to ambiguous lines: `{"<entryIndex>": "<guestId>" | "new"}`. */
	resolve?: Record<string, string>;
}

export type GuestBookOutcome =
	| "matched"
	| "new"
	| "ambiguous"
	| "already_present";

/**
 * What the plan says will happen to one line of the page — the FULL form,
 * carrying the values an apply writes. Never returned to an MCP caller; see the
 * module header.
 */
export interface PlannedEntry {
	index: number;
	outcome: GuestBookOutcome;
	/** The guest this line resolves to; null for `new` and `ambiguous`. */
	guestId: string | null;
	/** How the match was made, for a human deciding whether to trust it. */
	via: "email" | "phone" | "resolved" | null;
	/** The existing guest's name, when it differs from what is written down. */
	matchedName: string | null;
	/**
	 * This line ADDS someone to the minutes email's default recipients — it is a
	 * delta, not a membership test (#776 item 2, decided on #787).
	 *
	 * False for an `already_present` guest who has an email: they will receive
	 * the minutes, and this call is not what put them on the list. The docstring
	 * used to read "this line will be a default recipient of the minutes email",
	 * which is the OTHER reading and is false for exactly that guest.
	 *
	 * The delta is the right reading and stays, for two reasons. The question a
	 * transcriber is asking before approving is "how many people does this page
	 * ADD", and every other counter in the same summary is a delta count
	 * (`matched`, `new`, `ambiguous`, `already_present` are all outcomes of THIS
	 * call). A total would be a property of the meeting's guest list, which is
	 * not what a preview of one page is reporting on.
	 *
	 * The failure mode of the delta reading is an officer re-previewing a page
	 * that was already transcribed, seeing 0, and concluding the minutes will
	 * reach nobody. `probablyAlreadyTranscribed` in the same summary is what
	 * answers that, and it is true in exactly that case.
	 */
	minutesRecipient: boolean;
	/** Exactly what an apply would insert for a `new` line. */
	write: {
		name: string;
		preferredName: string | null;
		email: string | null;
		phone: string | null;
	} | null;
	/** What was written on the page, for the projections and for the page. */
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
export interface GuestBookPlan {
	meeting: {
		meetingId: string;
		date: string;
		theme: string | null;
	};
	entries: PlannedEntry[];
}

/** One guest an ambiguous line might be, with contact UNMASKED. See the header. */
export interface GuestBookCandidate {
	guestId: string;
	name: string;
	email: string | null;
	phone: string | null;
}

/** The `detail` an `AMBIGUOUS_GUEST` item carries. */
export interface AmbiguousGuestDetail {
	reason: string;
	candidates: GuestBookCandidate[];
}

export interface GuestBookPlanResult {
	plan: GuestBookPlan | null;
	blocking: McpBlockingItem[];
	/** Shown to the caller, never hashed — see `GuestBookPlan`. */
	meetingNumber: number | null;
}

/**
 * Build the full plan. Shared by the MCP preview, by every render and edit of
 * the confirm page, and by the re-plan inside the apply transaction, so none of
 * them can drift — which is the whole basis of the hash comparison.
 */
export async function plan(
	conn: Conn,
	club: PlanClub,
	args: PlanArgs,
	countryCode: string,
): Promise<GuestBookPlanResult> {
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
				// UNMASKED, and masked by `toPublicBlocking` on the way to an MCP
				// caller only. The confirm page needs these values: an email is
				// routinely the only thing distinguishing two guests with one name,
				// which is the question this item is asking.
				detail: {
					reason: m.reason,
					candidates: m.candidates.map(
						(c): GuestBookCandidate => ({
							guestId: c.id,
							name: c.name,
							email: c.email ?? null,
							phone: c.phone ?? null,
						}),
					),
				} satisfies AmbiguousGuestDetail,
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
 * The plan hash, for the MCP preview, for every render of the confirm page, and
 * for the comparison inside the apply transaction.
 *
 * It lives HERE, beside `plan()`, and not beside the apply, for a reason the
 * import graph makes concrete: `record_guest_book` needs it, and
 * `guest-book-apply.ts` imports `guards.ts` for its in-transaction re-check.
 * `mcp-authz.guard.test.ts`'s header says in as many words that its import grep
 * is blind to a cookie reader arriving through a helper — so the session guards
 * are kept out of the MCP module graph by construction rather than by a grep
 * that cannot see them.
 *
 * `tool` stays `"record_guest_book"` and `userId` stays the plan's CREATOR — the
 * only user who can open the confirm link — so the preview and every later
 * render hash the same function of the same inputs. Changing either would fail
 * every outstanding link as stale on deploy.
 */
export function guestBookPlanHash(input: {
	clubId: string;
	userId: string;
	plan: GuestBookPlan;
}): string {
	return computePlanHash({
		tool: "record_guest_book",
		clubId: input.clubId,
		userId: input.userId,
		plan: input.plan,
	});
}

/** The per-outcome tallies a human reads before saying yes. */
export function planSummary(p: GuestBookPlan) {
	const counts = {
		matched: 0,
		new: 0,
		ambiguous: 0,
		already_present: 0,
	} satisfies Record<GuestBookOutcome, number>;
	for (const e of p.entries) counts[e.outcome]++;

	return {
		...counts,
		// "How many people will this page ADD to the minutes email" is the
		// question a transcriber most wants answered before saying yes, and
		// the DELTA is the answer to it (#776 item 2, decided on #787). A
		// second run of the same page therefore reports 0 here and `true`
		// below, which together say "this changes nothing" rather than "the
		// minutes will reach nobody". See `PlannedEntry.minutesRecipient`.
		minutesRecipients: p.entries.filter((e) => e.minutesRecipient).length,
		// When EVERY line is already present, the likeliest explanation is that
		// this page was transcribed before — worth saying, because the apply
		// would otherwise succeed while writing nothing and look like it worked.
		probablyAlreadyTranscribed:
			p.entries.length > 0 && counts.already_present === p.entries.length,
	};
}

/**
 * The plan as an MCP CALLER sees it: every contact field masked, and the
 * internal `write` block dropped.
 *
 * One of the two projections — `toPublicBlocking` is the other, and it is not
 * optional. See the module header.
 */
export function toPublicPlan(p: GuestBookPlan, meetingNumber: number | null) {
	return {
		// The derived number rejoins the header HERE, outside the hash, because
		// this is where a human reads it (see `GuestBookPlan`).
		meeting: { ...p.meeting, meetingNumber },
		summary: planSummary(p),
		entries: p.entries.map((e) => ({
			index: e.index,
			// The name the CALLER sent, which it already has. Contrast
			// `matchedName` below.
			name: e.source.name,
			emailMasked: maskEmail(e.source.email),
			phoneMasked: maskPhone(e.source.phone),
			outcome: e.outcome,
			guestId: e.guestId,
			via: e.via,
			// A BOOLEAN, not the name. `matchedName` is set precisely when the
			// stored guest's name DIFFERS from what was transcribed — so it is,
			// by construction, a name the model has not seen, and returning it
			// put a club guest's real name into the transcript. What the caller
			// can act on is that the two disagree; WHICH name is on file is a
			// question for the confirm page, which shows it unmasked.
			matchedNameDiffers: e.matchedName !== null,
			minutesRecipient: e.minutesRecipient,
		})),
	};
}

/**
 * The blocking list as an MCP caller sees it.
 *
 * The SECOND projection, and the one that is easy to forget: `blocking` is a
 * sibling of `plan` in `plan()`'s return, so `toPublicPlan` cannot reach it.
 *
 * An `AMBIGUOUS_GUEST` item's candidates are dropped entirely rather than
 * masked. Masking the email and phone and passing the NAME through was the
 * shape this shipped with, and it leaked the one thing the list is made of:
 * candidates are guests already on file, so their names are values the model
 * has not seen — and for `phone_name_disagree` the name is, by construction,
 * different from what the model transcribed.
 *
 * Dropping rather than masking is what the new flow makes correct. The caller
 * no longer resolves an ambiguity — the confirm page does, with everything
 * unmasked — so an identity it must not act on is cost with no benefit. The
 * COUNT is what it can still use: "2 lines need your attention" is the whole
 * message it has to carry.
 *
 * Every other code's `detail` holds no contact and passes through unchanged.
 */
export function toPublicBlocking(
	blocking: McpBlockingItem[],
): McpBlockingItem[] {
	return blocking.map((item) => {
		if (item.code !== "AMBIGUOUS_GUEST") return item;
		const detail = item.detail as AmbiguousGuestDetail | undefined;
		if (!detail?.candidates) return item;
		return {
			...item,
			detail: {
				reason: detail.reason,
				candidateCount: detail.candidates.length,
			},
		};
	});
}
