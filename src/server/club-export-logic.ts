/**
 * Self-serve club data export (#915): a club admin downloads the club's data as
 * one `.zip` of CSVs, generated on demand by
 * `src/routes/api/clubs.$clubId.export.zip.ts`.
 *
 * Plain db-touching functions, deliberately NOT in a `createServerFn` module:
 * the route is the only caller and it runs on the server, so `pg` never gets a
 * path into the client bundle.
 *
 * ## The tenant boundary
 *
 * This is an authenticated read of every member's and guest's contact details,
 * so every query is scoped to the ONE club, and the scope is stated in the query
 * rather than trusted to a foreign key:
 *
 * - club-owned rows by `club_id = $clubId`;
 * - meeting-owned rows (slots, attendance, awards, Table Topics, speeches) by an
 *   INNER join to `meetings` with `meetings.club_id = $clubId`;
 * - the member or guest a meeting row names by a LEFT join that ALSO requires
 *   `members.club_id` / `guests.club_id = $clubId`. The foreign keys do not
 *   carry the club, so without that clause a row pointing at another club's
 *   member (a bug elsewhere, a bad import) would export that member's name here.
 *   With it, the worst such a row can do is export an empty cell.
 *
 * Person-scoped data (`speeches`, `path_enrollments`) is reached only through
 * this club: speeches by the slots of this club's meetings, enrollments by this
 * club's memberships. A member who is also in another club has their whole
 * Pathways enrollment exported — it is their record, and this club's admins
 * already see it on the member profile — but no other club's meetings, roles or
 * attendance appear anywhere.
 *
 * ## Serialisation (the issue's rules, in one place)
 *
 * null → empty cell; dates `YYYY-MM-DD` and times `HH:MM` in the CLUB's zone;
 * timestamps ISO 8601 with the club's offset; money a decimal with no symbol;
 * rows by date, then name; a file with no rows still has its header. Every file
 * that refers to a meeting carries `meeting_id` beside `meeting_date`, because
 * two meetings can share a date.
 *
 * Contact columns come from `members.email` / `members.phone`, the club's own
 * contact record and the copy the roster shows (#906 / #907 move them to
 * `people`; when that lands, this file moves with them).
 */
import {
	type AnyColumn,
	and,
	count,
	eq,
	isNotNull,
	max,
	min,
	or,
	sql,
} from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db } from "#/db";
import {
	clubActionItems,
	clubs,
	duesPeriods,
	guests,
	meetingAttendance,
	meetingAwards,
	meetings,
	memberDues,
	members,
	officerTerms,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import { cap } from "#/lib/cap";
import { type CsvColumn, toCsv } from "#/lib/csv";
import { utcToZonedWallTime } from "#/lib/datetime";
import { centsToInput } from "#/lib/dues";

/** A cell value before serialisation. */
export type ExportCell = string | number | null;

/** One of {@link CLUB_EXPORT_FILENAMES}; a misspelt name is a type error. */
export type ClubExportFilename = (typeof CLUB_EXPORT_FILENAMES)[number];

/** One CSV file in the export: its name, its header order, and its rows. */
export interface ExportFile {
	filename: ClubExportFilename;
	columns: readonly string[];
	rows: Record<string, ExportCell>[];
}

export interface ClubExport {
	club: { id: string; name: string; slug: string; timezone: string };
	files: ExportFile[];
}

/**
 * Every file the export contains, in the order the zip lists them. The route
 * test and the integration test both assert against this, so a file added to
 * {@link loadClubExport} without being named here fails them.
 */
export const CLUB_EXPORT_FILENAMES = [
	"members.csv",
	"officer-terms.csv",
	"meetings.csv",
	"roles.csv",
	"attendance.csv",
	"speeches.csv",
	"pathways.csv",
	"guests.csv",
	"awards.csv",
	"dues.csv",
	"action-items.csv",
	"table-topics.csv",
] as const;

// ---------------------------------------------------------------------------
// Club-local formatting
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` of an instant, in the club's zone. */
export function localDate(d: Date | null, timeZone: string): string | null {
	return d ? utcToZonedWallTime(d, timeZone).slice(0, 10) : null;
}

/** `HH:MM` of an instant, in the club's zone. */
export function localTime(d: Date | null, timeZone: string): string | null {
	return d ? utcToZonedWallTime(d, timeZone).slice(11, 16) : null;
}

/**
 * ISO 8601 with the club's offset at that instant: `2026-03-10T19:30:00-05:00`.
 * The offset is derived from the zone's wall clock AT the instant, so a
 * timestamp either side of a DST change carries the offset that applied then.
 */
export function isoWithOffset(d: Date | null, timeZone: string): string | null {
	if (!d) return null;
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(d)
			.map((p) => [p.type, p.value]),
	);
	const hour = parts.hour === "24" ? "00" : parts.hour;
	const wallMs = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(hour),
		Number(parts.minute),
		Number(parts.second),
	);
	const instantMs = Math.floor(d.getTime() / 1000) * 1000;
	const offsetMin = Math.round((wallMs - instantMs) / 60000);
	const sign = offsetMin < 0 ? "-" : "+";
	const abs = Math.abs(offsetMin);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

/**
 * Integer cents → `12.50`, via the dues page's own `centsToInput`. GavelUp
 * stores no currency, so no symbol either. Null stays null (an empty cell).
 */
export function centsToDecimal(cents: number | null): string | null {
	return cents === null ? null : centsToInput(cents);
}

/**
 * `YYYY-MM-DD` of a CALENDAR-DATE column. `members.joined_at` and
 * `dues_periods.due_date` hold a date, stored as UTC midnight; reading one
 * through the club's zone would move every date a day EARLIER for a club west
 * of UTC (midnight UTC on the 15th is the evening of the 14th in Chicago).
 */
export function utcDate(d: Date | null): string | null {
	return d ? d.toISOString().slice(0, 10) : null;
}

/** Names, locale-aware, with a missing name (an open slot) last. */
function compareNames(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a.localeCompare(b);
}

/** Sort by a date-ish key (nulls last), then by a name, locale-aware. */
function byDateThenName<T>(
	date: (r: T) => string | null,
	name: (r: T) => string | null,
): (a: T, b: T) => number {
	return (a, b) => {
		const da = date(a);
		const db_ = date(b);
		if (da !== db_) {
			if (da === null) return 1;
			if (db_ === null) return -1;
			return da < db_ ? -1 : 1;
		}
		return compareNames(name(a), name(b));
	};
}

function file(
	filename: ClubExportFilename,
	columns: readonly string[],
	rows: Record<string, ExportCell>[],
): ExportFile {
	return { filename, columns, rows };
}

// ---------------------------------------------------------------------------
// One export per club at a time
// ---------------------------------------------------------------------------

/** Clubs with an export being built right now, in THIS process. */
const exportsInFlight = new Set<string>();

/**
 * Claim the club's export slot. Returns the release function, or null when an
 * export of this club is already running — the route answers that with 429.
 *
 * An export reads every table the club has and holds a connection for the
 * whole time; a double-click, or a script hammering the URL, would otherwise
 * stack those up until the pool is gone. In-process on purpose: this app is one
 * Node server (ADR-0007), so a module-level set is the whole deployment. Always
 * release in a `finally`.
 */
export function beginClubExport(clubId: string): (() => void) | null {
	if (exportsInFlight.has(clubId)) return null;
	exportsInFlight.add(clubId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		exportsInFlight.delete(clubId);
	};
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/**
 * Load every file of the club's export. Returns null for an unknown club; the
 * route has already refused an archived one and checked the caller is an admin.
 */
export async function loadClubExport(
	clubId: string,
): Promise<ClubExport | null> {
	/** A member of THIS club (see the tenant boundary above). */
	const memberOfClub = (col: AnyColumn) =>
		and(eq(members.id, col), eq(members.clubId, clubId));
	const guestOfClub = (col: AnyColumn) =>
		and(eq(guests.id, col), eq(guests.clubId, clubId));

	// ONE connection, ONE snapshot. Thirteen reads in a `Promise.all` would
	// check out up to thirteen connections from a pool of ten for a single
	// request, starving every other request while an export ran; sequential
	// awaits inside one transaction hold exactly one. REPEATABLE READ makes the
	// files agree with each other (a slot never names a member the members file
	// lacks because a write landed between two reads), and READ ONLY states
	// that nothing here writes.
	const loaded = await db.transaction(
		async (tx) => {
			const [club] = await tx
				.select({
					id: clubs.id,
					name: clubs.name,
					slug: clubs.slug,
					timezone: clubs.timezone,
				})
				.from(clubs)
				.where(eq(clubs.id, clubId))
				.limit(1);
			if (!club) return null;
			const memberRows = await tx
				.select({
					id: members.id,
					name: members.name,
					preferredName: members.preferredName,
					email: members.email,
					phone: members.phone,
					status: members.status,
					clubRole: members.clubRole,
					joinedAt: members.joinedAt,
					customerId: people.customerId,
				})
				.from(members)
				.innerJoin(people, eq(people.id, members.personId))
				.where(eq(members.clubId, clubId));
			const termRows = await tx
				.select({
					memberId: members.id,
					name: members.name,
					position: officerTerms.position,
					termStart: officerTerms.termStart,
					termEnd: officerTerms.termEnd,
				})
				.from(officerTerms)
				.innerJoin(members, eq(members.id, officerTerms.membershipId))
				.where(eq(members.clubId, clubId));
			const meetingRows = await tx
				.select({
					id: meetings.id,
					scheduledAt: meetings.scheduledAt,
					status: meetings.status,
					theme: meetings.theme,
					wordOfTheDay: meetings.wordOfTheDay,
					location: meetings.location,
				})
				.from(meetings)
				.where(eq(meetings.clubId, clubId));
			const slotRows = await tx
				.select({
					meetingId: meetings.id,
					scheduledAt: meetings.scheduledAt,
					role: roleDefinitions.name,
					slotIndex: roleSlots.slotIndex,
					status: roleSlots.status,
					memberId: members.id,
					memberName: members.name,
					guestId: guests.id,
					guestName: guests.name,
				})
				.from(roleSlots)
				.innerJoin(
					meetings,
					and(
						eq(meetings.id, roleSlots.meetingId),
						eq(meetings.clubId, clubId),
					),
				)
				// The role definition must be THIS club's too: the FK does not carry
				// the club, so a slot pointing at another club's definition would
				// otherwise export that club's role name.
				.innerJoin(
					roleDefinitions,
					and(
						eq(roleDefinitions.id, roleSlots.roleDefinitionId),
						eq(roleDefinitions.clubId, clubId),
					),
				)
				.leftJoin(members, memberOfClub(roleSlots.assignedMemberId))
				.leftJoin(guests, guestOfClub(roleSlots.assignedGuestId));
			const attendanceRows = await tx
				.select({
					meetingId: meetings.id,
					scheduledAt: meetings.scheduledAt,
					status: meetingAttendance.status,
					memberId: members.id,
					memberName: members.name,
					guestId: guests.id,
					guestName: guests.name,
				})
				.from(meetingAttendance)
				.innerJoin(
					meetings,
					and(
						eq(meetings.id, meetingAttendance.meetingId),
						eq(meetings.clubId, clubId),
					),
				)
				.leftJoin(members, memberOfClub(meetingAttendance.memberId))
				.leftJoin(guests, guestOfClub(meetingAttendance.guestId));
			const speechRows = await tx
				.select({
					meetingId: meetings.id,
					scheduledAt: meetings.scheduledAt,
					speaker: members.name,
					title: speeches.title,
					pathwayPath: speeches.pathwayPath,
					projectName: speeches.projectName,
					projectLevel: speeches.projectLevel,
				})
				.from(roleSlots)
				.innerJoin(
					meetings,
					and(
						eq(meetings.id, roleSlots.meetingId),
						eq(meetings.clubId, clubId),
					),
				)
				.innerJoin(speeches, eq(speeches.id, roleSlots.speechId))
				// A speech is PERSON-owned (ADR-0009), so a slot in this club's
				// meeting can point at a speech whose owner has no membership here.
				// The owner must be this club's member, and the speaker is named
				// from that membership, like every other file, never from `people`.
				.innerJoin(
					members,
					and(
						eq(members.personId, speeches.personId),
						eq(members.clubId, clubId),
					),
				);
			const enrollmentRows = await tx
				.select({
					memberId: members.id,
					name: members.name,
					path: pathwaysPaths.name,
					archivedAt: pathEnrollments.archivedAt,
					// The highest level TI has approved as complete. A per-enrollment
					// aggregate, grouped below; not a correlated subquery.
					currentLevel: max(
						sql<number>`case when ${pathLevelProgress.approved} then ${pathLevelProgress.level} end`,
					),
				})
				.from(pathEnrollments)
				.innerJoin(
					members,
					and(
						eq(members.personId, pathEnrollments.personId),
						eq(members.clubId, clubId),
					),
				)
				.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathEnrollments.pathId))
				.leftJoin(
					pathLevelProgress,
					eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
				)
				.groupBy(
					pathEnrollments.id,
					members.id,
					members.name,
					pathwaysPaths.name,
					pathEnrollments.archivedAt,
				);
			const guestRows = await tx
				.select({
					id: guests.id,
					name: guests.name,
					email: guests.email,
					phone: guests.phone,
					stage: guests.stage,
				})
				.from(guests)
				.where(eq(guests.clubId, clubId));
			// Visits: a guest's `meeting_attendance` rows at this club's meetings.
			// There is no visits table (#915's Current State).
			const visitRows = await tx
				.select({
					guestId: meetingAttendance.guestId,
					visits: count(),
					firstVisit: min(meetings.scheduledAt),
				})
				.from(meetingAttendance)
				.innerJoin(
					meetings,
					and(
						eq(meetings.id, meetingAttendance.meetingId),
						eq(meetings.clubId, clubId),
					),
				)
				// A visit is a PRESENT record. An absent or excused row is a guest
				// who was expected and did not come.
				.where(
					and(
						isNotNull(meetingAttendance.guestId),
						eq(meetingAttendance.status, "present"),
					),
				)
				.groupBy(meetingAttendance.guestId);
			const awardRows = await tx
				.select({
					meetingId: meetings.id,
					scheduledAt: meetings.scheduledAt,
					category: meetingAwards.category,
					memberName: members.name,
					guestName: guests.name,
					writeInName: meetingAwards.writeInName,
				})
				.from(meetingAwards)
				.innerJoin(
					meetings,
					and(
						eq(meetings.id, meetingAwards.meetingId),
						eq(meetings.clubId, clubId),
					),
				)
				.leftJoin(members, memberOfClub(meetingAwards.memberId))
				.leftJoin(guests, guestOfClub(meetingAwards.guestId));
			// Member × period, the grid the Treasurer's dues page shows: every ACTIVE
			// member for every period (no row = unpaid, `dues-logic.ts`), plus any
			// inactive member who does have a recorded payment or waiver.
			const duesRows = await tx
				.select({
					period: duesPeriods.label,
					dueDate: duesPeriods.dueDate,
					memberId: members.id,
					name: members.name,
					status: memberDues.status,
					amountCents: memberDues.amountCents,
				})
				.from(duesPeriods)
				.innerJoin(members, eq(members.clubId, duesPeriods.clubId))
				.leftJoin(
					memberDues,
					and(
						eq(memberDues.membershipId, members.id),
						eq(memberDues.duesPeriodId, duesPeriods.id),
					),
				)
				.where(
					and(
						eq(duesPeriods.clubId, clubId),
						or(eq(members.status, "active"), isNotNull(memberDues.id)),
					),
				);
			const actionRows = await tx
				.select({
					createdAt: clubActionItems.createdAt,
					text: clubActionItems.text,
					owner: members.name,
					resolution: clubActionItems.resolution,
					dueDate: clubActionItems.dueDate,
				})
				.from(clubActionItems)
				.leftJoin(members, memberOfClub(clubActionItems.ownerMemberId))
				.where(eq(clubActionItems.clubId, clubId));
			const topicRows = await tx
				.select({
					meetingId: meetings.id,
					scheduledAt: meetings.scheduledAt,
					memberName: members.name,
					guestName: guests.name,
					topic: tableTopicsSpeakers.topic,
				})
				.from(tableTopicsSpeakers)
				.innerJoin(
					meetings,
					and(
						eq(meetings.id, tableTopicsSpeakers.meetingId),
						eq(meetings.clubId, clubId),
					),
				)
				.leftJoin(members, memberOfClub(tableTopicsSpeakers.memberId))
				.leftJoin(guests, guestOfClub(tableTopicsSpeakers.guestId));
			return {
				club,
				memberRows,
				termRows,
				meetingRows,
				slotRows,
				attendanceRows,
				speechRows,
				enrollmentRows,
				guestRows,
				visitRows,
				awardRows,
				duesRows,
				actionRows,
				topicRows,
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
	if (!loaded) return null;
	const {
		club,
		memberRows,
		termRows,
		meetingRows,
		slotRows,
		attendanceRows,
		speechRows,
		enrollmentRows,
		guestRows,
		visitRows,
		awardRows,
		duesRows,
		actionRows,
		topicRows,
	} = loaded;
	const tz = club.timezone;

	const visitsByGuest = new Map(visitRows.map((v) => [v.guestId, v] as const));

	const files: ExportFile[] = [
		file(
			"members.csv",
			[
				"member_id",
				"name",
				"preferred_name",
				"email",
				"phone",
				"status",
				"club_role",
				"joined_at",
				"customer_id",
			],
			memberRows
				.map((m) => ({
					member_id: m.id,
					name: m.name,
					preferred_name: m.preferredName,
					email: m.email,
					phone: m.phone,
					status: m.status,
					club_role: m.clubRole,
					joined_at: utcDate(m.joinedAt),
					customer_id: m.customerId,
				}))
				.sort(
					byDateThenName(
						(r) => r.joined_at,
						(r) => r.name,
					),
				),
		),
		file(
			"officer-terms.csv",
			["member_id", "name", "position", "started_at", "ended_at"],
			termRows
				.map((t) => ({
					member_id: t.memberId,
					name: t.name,
					position: t.position,
					started_at: localDate(t.termStart, tz),
					ended_at: localDate(t.termEnd, tz),
				}))
				.sort(
					byDateThenName(
						(r) => r.started_at,
						(r) => r.name,
					),
				),
		),
		file(
			"meetings.csv",
			[
				"meeting_id",
				"meeting_date",
				"start_time",
				"status",
				"theme",
				"word_of_the_day",
				"location",
			],
			[...meetingRows]
				.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
				.map((m) => ({
					meeting_id: m.id,
					meeting_date: localDate(m.scheduledAt, tz),
					start_time: localTime(m.scheduledAt, tz),
					status: m.status,
					theme: m.theme,
					word_of_the_day: m.wordOfTheDay,
					location: m.location,
				})),
		),
		file(
			"roles.csv",
			[
				"meeting_id",
				"meeting_date",
				"role",
				"slot",
				"holder_name",
				"holder_type",
				"member_or_guest_id",
				"status",
			],
			// Date, then the holder's name (the spec's order); role and slot only
			// break ties, e.g. between two open slots.
			[...slotRows]
				.sort(
					(a, b) =>
						a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
						compareNames(
							a.memberName ?? a.guestName,
							b.memberName ?? b.guestName,
						) ||
						a.role.localeCompare(b.role) ||
						a.slotIndex - b.slotIndex,
				)
				.map((s) => ({
					meeting_id: s.meetingId,
					meeting_date: localDate(s.scheduledAt, tz),
					role: s.role,
					slot: s.slotIndex + 1,
					holder_name: s.memberName ?? s.guestName,
					holder_type: s.memberId ? "member" : s.guestId ? "guest" : null,
					member_or_guest_id: s.memberId ?? s.guestId,
					status: s.status,
				})),
		),
		file(
			"attendance.csv",
			[
				"meeting_id",
				"meeting_date",
				"name",
				"member_or_guest_id",
				"type",
				"attended",
				"status",
			],
			sortedByMeeting(attendanceRows, (a) => a.memberName ?? a.guestName).map(
				(a) => ({
					meeting_id: a.meetingId,
					meeting_date: localDate(a.scheduledAt, tz),
					name: a.memberName ?? a.guestName,
					member_or_guest_id: a.memberId ?? a.guestId,
					type: a.memberId ? "member" : a.guestId ? "guest" : null,
					attended: a.status === "present" ? "yes" : "no",
					status: a.status,
				}),
			),
		),
		file(
			"speeches.csv",
			[
				"meeting_id",
				"meeting_date",
				"speaker",
				"title",
				"pathways_path",
				"project",
				"project_level",
			],
			sortedByMeeting(speechRows, (s) => s.speaker).map((s) => ({
				meeting_id: s.meetingId,
				meeting_date: localDate(s.scheduledAt, tz),
				speaker: s.speaker,
				title: s.title,
				pathways_path: s.pathwayPath,
				project: s.projectName,
				project_level: s.projectLevel,
			})),
		),
		file(
			"pathways.csv",
			["member_id", "name", "path", "current_level", "status"],
			enrollmentRows
				.map((e) => ({
					member_id: e.memberId,
					name: e.name,
					path: e.path,
					// pg returns `max()` over an expression as text; the column is an int.
					current_level:
						e.currentLevel === null ? null : Number(e.currentLevel),
					status: e.archivedAt ? "archived" : "active",
				}))
				.sort(
					(a, b) =>
						a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
				),
		),
		file(
			"guests.csv",
			["guest_id", "name", "email", "phone", "stage", "first_visit", "visits"],
			guestRows
				.map((g) => {
					const v = visitsByGuest.get(g.id);
					return {
						guest_id: g.id,
						name: g.name,
						email: g.email,
						phone: g.phone,
						stage: g.stage,
						first_visit: localDate(v?.firstVisit ?? null, tz),
						visits: v?.visits ?? 0,
					};
				})
				.sort(
					byDateThenName(
						(r) => r.first_visit,
						(r) => r.name,
					),
				),
		),
		file(
			"awards.csv",
			["meeting_id", "meeting_date", "award", "winner"],
			sortedByMeeting(
				awardRows,
				(a) => a.memberName ?? a.guestName ?? a.writeInName,
			).map((a) => ({
				meeting_id: a.meetingId,
				meeting_date: localDate(a.scheduledAt, tz),
				award: a.category,
				winner: a.memberName ?? a.guestName ?? a.writeInName,
			})),
		),
		file(
			"dues.csv",
			["period", "due_date", "member_id", "name", "status", "amount"],
			[...duesRows]
				.sort(
					(a, b) =>
						a.dueDate.getTime() - b.dueDate.getTime() ||
						a.period.localeCompare(b.period) ||
						a.name.localeCompare(b.name),
				)
				.map((d) => ({
					period: d.period,
					due_date: utcDate(d.dueDate),
					member_id: d.memberId,
					name: d.name,
					status: d.status ?? "unpaid",
					amount: centsToDecimal(d.amountCents),
				})),
		),
		file(
			"action-items.csv",
			["created_at", "title", "owner", "status", "due"],
			[...actionRows]
				.sort(
					(a, b) =>
						a.createdAt.getTime() - b.createdAt.getTime() ||
						a.text.localeCompare(b.text),
				)
				.map((a) => ({
					created_at: isoWithOffset(a.createdAt, tz),
					title: a.text,
					owner: a.owner,
					status: a.resolution ?? "open",
					due: a.dueDate,
				})),
		),
		file(
			"table-topics.csv",
			["meeting_id", "meeting_date", "speaker", "topic"],
			sortedByMeeting(topicRows, (t) => t.memberName ?? t.guestName).map(
				(t) => ({
					meeting_id: t.meetingId,
					meeting_date: localDate(t.scheduledAt, tz),
					speaker: t.memberName ?? t.guestName,
					topic: t.topic,
				}),
			),
		),
	];

	return { club, files };
}

/** Meeting rows by instant (not by formatted date: two share a date), then name. */
function sortedByMeeting<T extends { scheduledAt: Date }>(
	rows: readonly T[],
	name: (r: T) => string | null,
): T[] {
	return [...rows].sort(
		(a, b) =>
			a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
			compareNames(name(a), name(b)),
	);
}

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

/** What each file holds, for the README. Keyed by {@link CLUB_EXPORT_FILENAMES}. */
const FILE_DESCRIPTIONS: Record<
	(typeof CLUB_EXPORT_FILENAMES)[number],
	string
> = {
	"members.csv":
		"One row per membership, current and past, with contact details.",
	"officer-terms.csv": "One row per officer term.",
	"meetings.csv": "One row per meeting.",
	"roles.csv": "One row per role slot on each meeting's agenda.",
	"attendance.csv": "One row per recorded attendance, members and guests.",
	"speeches.csv": "One row per speech given at this club's meetings.",
	"pathways.csv":
		"One row per Pathways enrollment of this club's current and past members. current_level is the highest level Toastmasters has approved as complete (empty if none).",
	"guests.csv":
		"One row per guest, with contact details. visits counts the meetings of this club the guest was recorded present at; first_visit is the earliest of them.",
	"awards.csv": "One row per meeting award.",
	"dues.csv":
		"One row per member per dues period: every active member, plus any past member with a recorded payment or waiver. status is paid, waived or unpaid.",
	"action-items.csv": "One row per club action item.",
	"table-topics.csv": "One row per Table Topics speaker.",
};

function readme(
	exportedAt: string,
	clubName: string,
	timezone: string,
): string {
	const lines = [
		`GavelUp data export for ${clubName}`,
		`Exported at ${exportedAt}.`,
		"",
		"Files:",
		...CLUB_EXPORT_FILENAMES.map((f) => `  ${f}  ${FILE_DESCRIPTIONS[f]}`),
		"",
		"How to read these files:",
		`  Dates (YYYY-MM-DD) and times (HH:MM) are in the club's time zone, ${timezone}.`,
		"  Timestamps are ISO 8601 with the club's UTC offset.",
		"  Money is a decimal amount in whatever currency the club records dues in, with no symbol.",
		"  An empty cell means no value was recorded.",
		"  member_id, guest_id and meeting_id link rows across files. Every file about a meeting carries meeting_id, because two meetings can share a date.",
		"  customer_id is the Toastmasters International Customer ID.",
		"  A cell that begins with =, +, - or @ (a phone number such as +1..., for example) is written with a leading ' so a spreadsheet shows it as text instead of running it as a formula.",
		"",
		"Not included: the club's agenda templates, its logo, and digital vote tallies.",
		"",
	];
	return lines.join("\r\n");
}

/**
 * Build the zip: `README.txt`, then every CSV in {@link CLUB_EXPORT_FILENAMES}
 * order. Synchronous `zipSync` is enough at club size (the integration test
 * holds a 60-member, 300-meeting, 5,000-slot club under 3s).
 */
export function buildClubExportZip(data: ClubExport, now: Date): Uint8Array {
	const entries: Record<string, Uint8Array> = {
		"README.txt": strToU8(
			readme(
				isoWithOffset(now, data.club.timezone) ?? "",
				data.club.name,
				data.club.timezone,
			),
		),
	};
	for (const f of data.files) {
		const columns: CsvColumn<Record<string, ExportCell>>[] = f.columns.map(
			(header) => ({ header, value: (row) => row[header] }),
		);
		entries[f.filename] = strToU8(toCsv(f.rows, columns));
	}
	return zipSync(entries, { level: 6 });
}

/**
 * `<club-slug>-export-<YYYY-MM-DD>.zip`, club-local date. The slug is capped
 * and stripped to `[A-Za-z0-9_.-]` before it reaches the header: `clubs.slug`
 * has no write-side max, and an oversized header is a 502 from the proxy with
 * nothing logged (`meetings.$id.minutes.pdf.ts` says the same about its name).
 */
export function clubExportFilename(
	slug: string,
	timezone: string,
	now: Date,
): string {
	const safe = cap(slug, 80).replace(/[^\w.-]+/g, "") || "club";
	return `${safe}-export-${localDate(now, timezone)}.zip`;
}
