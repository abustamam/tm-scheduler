import { relations, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// Re-export Better-Auth's generated tables so the single `schema` namespace
// imported by the db client (and the Drizzle adapter) sees user/session/etc.
export {
	account,
	accountRelations,
	session,
	sessionRelations,
	user,
	userRelations,
	verification,
} from "./auth-schema";

// user is re-exported above for Better-Auth; imported here for people.userId and
// notifications foreign keys (the person-level auth link — ADR-0008 Phase B).
import { user } from "./auth-schema";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// Authorization role for a Person's membership in a club (ADR-0008 Phase B / #99).
// Collapsed from the legacy {admin, vpe, member} — `admin` and `vpe` behaved
// identically at every call site, so `vpe` folded into `admin`. Lives on the
// `members` row (the membership); resolved on the auth path via `people.user_id`.
export const clubRoleEnum = pgEnum("club_role", ["admin", "member"]);
// Standard Toastmasters club officers (#63). The vocabulary for an officer term
// (#100): each `officer_terms` row carries one of these. Keep in lockstep with
// OFFICER_POSITIONS in src/lib/officers.ts.
export const officerPositionEnum = pgEnum("officer_position", [
	"president",
	"vp_education",
	"vp_membership",
	"vp_public_relations",
	"secretary",
	"treasurer",
	"sergeant_at_arms",
	"immediate_past_president",
]);
export const membershipStatusEnum = pgEnum("membership_status", [
	"active",
	"inactive",
]);
export const meetingStatusEnum = pgEnum("meeting_status", [
	"scheduled",
	"cancelled",
	"completed",
]);
export const roleCategoryEnum = pgEnum("role_category", [
	"leadership",
	"speaker",
	"evaluator",
	"functionary",
]);
export const slotStatusEnum = pgEnum("slot_status", [
	"open",
	"claimed",
	"confirmed",
]);
export const pathwayStatusEnum = pgEnum("pathway_status", [
	"current",
	"legacy",
]);

export const activityActionEnum = pgEnum("activity_action", [
	"claim",
	"release",
	"reassign",
	"availability_set",
	"availability_clear",
	"member_add",
	"member_edit",
	"member_merge",
	"member_remove",
	"meeting_create",
	"meeting_edit",
]);

// Presence state on a `meeting_attendance` row (ADR-0014 / #152). Members
// default to `absent`; a member holding a role slot is pre-filled `present`.
// Guests are always stored `present` (a guest who didn't come isn't listed).
export const attendanceStatusEnum = pgEnum("attendance_status", [
	"present",
	"absent",
	"excused",
]);

// The three award/ribbon categories captured in the minutes (ADR-0014 / #152).
// One winner (a member XOR a guest) per category per meeting; all optional.
export const awardCategoryEnum = pgEnum("award_category", [
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);

// Membership-dues payment state (#206 / ADR-0017). A `member_dues` row exists
// ONLY when a member has PAID or been WAIVED for a period; "unpaid" is the
// ABSENCE of a row (keeps the table sparse and the overdue query simple).
// Deliberately decoupled from `membership_status` — dues track money, not the
// roster/season renewal state, and no dues action ever mutates it.
export const duesStatusEnum = pgEnum("dues_status", ["paid", "waived"]);

// ---------------------------------------------------------------------------
// Clubs & memberships
// ---------------------------------------------------------------------------

export const clubs = pgTable("clubs", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	clubNumber: text("club_number").unique(),
	timezone: text("timezone").notNull().default("America/Chicago"),
	// Free-text club profile fields shown on the printable agenda. All nullable —
	// empty/unset is valid and the agenda falls back gracefully (no empty labels).
	// district: display label only (e.g. "District 39"); mission: free text, may be
	// multi-line; meetingSchedule: human-readable (e.g. "2nd & 4th Thursday, 6:45–7:45 PM").
	district: text("district"),
	mission: text("mission"),
	meetingSchedule: text("meeting_schedule"),
	// Default meeting length in minutes. New meetings inherit this at insert
	// (copied onto the meeting row) so a later change here never silently moves
	// the end time of meetings already scheduled. Non-null with a sensible
	// default (90) — most clubs run 60- or 90-minute meetings.
	defaultMeetingMinutes: integer("default_meeting_minutes")
		.notNull()
		.default(90),
	// Soft-archive (ADR-0016 / #186). NULL = active; a set timestamp = archived.
	// Reversible: unarchive clears it. Archiving retains all club data untouched
	// and blocks every access path except the superadmin console — `requireMembership`
	// rejects authed access and the public no-auth club loaders return not-found.
	archivedAt: timestamp("archived_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// People — one row per human, above per-club membership (ADR-0008 / #64).
// Holds the facts identical across every club a person belongs to. Keyed by
// Toastmasters Customer ID (PN-…) when known, unique-when-present (nullable);
// email is the fallback dedupe key. Pathways paths are Person-level too but are
// NOT modeled here (out of scope).
// ---------------------------------------------------------------------------

export const people = pgTable("people", {
	id: uuid("id").defaultRandom().primaryKey(),
	// Toastmasters Customer ID (PN-…). Nullable; Postgres treats NULLs as
	// distinct, so the unique constraint is "unique-when-present".
	customerId: text("customer_id").unique(),
	// Durable Base Camp/edX user id (from /api/bcm/progress `user.id`), captured on
	// first email match and used as the join key for Pathways sync thereafter.
	// Nullable + unique-when-present (Postgres treats NULLs as distinct).
	basecampUserId: text("basecamp_user_id").unique(),
	name: text("name").notNull(),
	email: text("email"),
	phone: text("phone"),
	// First-ever Toastmasters join date — a person-level fact (identical across
	// every club), moved off the per-club members row (ADR-0008).
	originalJoinDate: timestamp("original_join_date"),
	// The canonical link to a Better-Auth sign-in account (one login spans all
	// their clubs). The auth path resolves a signed-in user to this Person, then
	// to their per-club memberships and roles (ADR-0008 Phase B / #99).
	userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Roster members (self-serve MVP — auth-decoupled identities).
// The Membership: a Person's participation in one Club (one row per person per
// club). Person-level facts live on `people`; this row holds the per-club facts.
// ---------------------------------------------------------------------------

export const members = pgTable(
	"members",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// The Person this membership belongs to (ADR-0008 / #64). Every roster row
		// belongs to exactly one person; person-level facts (original join date,
		// canonical name/contact) live on `people`.
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		email: text("email"),
		phone: text("phone"),
		// Authorization role for this membership (ADR-0008 Phase B / #99). The auth
		// path (guards.ts / auth-context.ts) resolves a signed-in user → Person
		// (people.user_id) → their memberships, and reads this role per club. An
		// explicit stored field (not derived from office) so security is enforceable
		// and unaffected by roster edits — but defaulted from office (President /
		// VP Education ⇒ admin) at create/link time. Default `member`.
		clubRole: clubRoleEnum("club_role").notNull().default("member"),
		// Current elected office(s) are NOT stored here (#100). They are derived
		// from open `officer_terms` rows (term_end IS NULL) — a membership may hold
		// several concurrently (e.g. Secretary + Treasurer) and past terms are kept.
		// Roster membership status. "inactive" = didn't renew this season: hidden
		// from sign-up / roster / season / picker views, but their past role
		// history is preserved (never deleted). Reactivating restores them.
		status: membershipStatusEnum("status").notNull().default("active"),
		// Real join date from the Toastmasters membership export (seeded by
		// scripts/import-members.ts). joinedAt = "Member of *this* Club Since"
		// (per-club). First-ever TM join lives on people.originalJoinDate.
		joinedAt: timestamp("joined_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("members_club_idx").on(t.clubId),
		index("members_person_idx").on(t.personId),
	],
);

// ---------------------------------------------------------------------------
// Officer terms — a membership holding an office over a span of time (#100).
// The SOURCE OF TRUTH for who holds which office: current office(s) are DERIVED
// as the open terms (termEnd IS NULL), never stored back on the membership. A
// membership may hold several offices concurrently (e.g. Secretary + Treasurer)
// — one open row each. Closing a term (setting termEnd) retains it as history
// (officer recognition / term reporting). `termStart` is nullable (unknown for
// migrated legacy offices). The office vocabulary is the shared enum (#63).
// ---------------------------------------------------------------------------

export const officerTerms = pgTable(
	"officer_terms",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		membershipId: uuid("membership_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		position: officerPositionEnum("position").notNull(),
		// When the office began. Nullable: legacy offices migrated from the old
		// members.officer_position column have no recorded start.
		termStart: timestamp("term_start"),
		// When the office ended. NULL = still held (current). A non-null value is
		// retained history — the row is never deleted on removal.
		termEnd: timestamp("term_end"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("officer_terms_membership_idx").on(t.membershipId),
		// Fast lookup of the current officers (open terms) for a membership.
		index("officer_terms_open_idx").on(t.membershipId, t.termEnd),
	],
);

// ---------------------------------------------------------------------------
// Membership dues (#206 / ADR-0017) — the Treasurer's dues tracker.
//
// `dues_periods` is the club-defined billing period a dues record keys off:
// clubs bill differently (annual, semi-annual, custom amounts), so periods are
// DATA, not hardcoded. `member_dues` is the sparse paid/waived record keyed on
// (membership, period): a member OWES a period when they have NO row for it.
// Amounts are stored as integer CENTS so totals sum exactly (nullable — a club
// may track status without recording a dollar figure). This is status tracking
// ONLY: no payment processing, and `memberships.status` is NEVER touched by a
// dues action (dues and roster renewal stay fully decoupled).
// ---------------------------------------------------------------------------

export const duesPeriods = pgTable(
	"dues_periods",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// Human label the Treasurer sees (e.g. "2026 Apr 1 renewal").
		label: text("label").notNull(),
		// When dues for this period are due. A member with no paid/waived row for a
		// period whose due_date has passed is "overdue".
		dueDate: timestamp("due_date").notNull(),
		// Optional club default charge for the period, in integer cents. Nullable —
		// a club may track status without recording amounts.
		defaultAmountCents: integer("default_amount_cents"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("dues_periods_club_idx").on(t.clubId, t.dueDate)],
);

export const memberDues = pgTable(
	"member_dues",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		membershipId: uuid("membership_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		duesPeriodId: uuid("dues_period_id")
			.notNull()
			.references(() => duesPeriods.id, { onDelete: "cascade" }),
		status: duesStatusEnum("status").notNull(),
		// Collected amount for THIS row, in integer cents. Nullable (optional per
		// row — a full-year payment may split the total or leave a row blank).
		amountCents: integer("amount_cents"),
		// When the payment was recorded. A full-year pre-payment writes two `paid`
		// rows sharing one paid_at; null for a waiver.
		paidAt: timestamp("paid_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// One record per member per period; "unpaid" is the absence of this row. A
		// plain unique index so ON CONFLICT can infer it (record/waive → upsert).
		uniqueIndex("member_dues_membership_period_unique").on(
			t.membershipId,
			t.duesPeriodId,
		),
		index("member_dues_period_idx").on(t.duesPeriodId),
	],
);

// ---------------------------------------------------------------------------
// Guests — club-scoped visitors who can be assigned to a role slot (#151) and
// tracked through the VP-Membership pipeline (#208, ADR-0018).
//
// A guest is NOT a member: no Person, no login, no Pathways, no roster/officer
// presence, and no `members` status (guests would otherwise leak into some
// roster/season/picker views and vanish from others). It is a lightweight,
// durable identity (name + optional contact) scoped to one club, so it reappears
// as an assignable option in later meetings. A role slot references a guest via
// `role_slots.assigned_guest_id`, mutually exclusive with `assigned_member_id`.
//
// Adjacent to Person/Membership (ADR-0008). Promotion-to-member (ADR-0018): a
// guest carries a lifecycle `stage`; converting one creates a Membership,
// re-points its slot assignments, and stamps `converted_membership_id` while
// keeping the guest row (at stage=joined) as durable history.
// ---------------------------------------------------------------------------

// The VP-Membership funnel a guest travels (#208 / ADR-0018). New guests default
// to `prospect`; `following_up`/`lost` are manual transitions; `joined` is set
// only by convert-to-member (never a manual transition), alongside
// `converted_membership_id`.
export const guestStageEnum = pgEnum("guest_stage", [
	"prospect",
	"following_up",
	"joined",
	"lost",
]);

export const guests = pgTable(
	"guests",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		// Optional contact — a guest may be assigned with just a name.
		email: text("email"),
		phone: text("phone"),
		// Pipeline lifecycle stage (#208 / ADR-0018). Defaults to `prospect`.
		stage: guestStageEnum("stage").notNull().default("prospect"),
		// Set once, on convert-to-member: the Membership this guest became. The
		// guest row persists (stage=joined) so its past slot/attendance history is
		// never lost; on member delete → set null (history stays, pointer clears).
		convertedMembershipId: uuid("converted_membership_id").references(
			() => members.id,
			{ onDelete: "set null" },
		),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [index("guests_club_idx").on(t.clubId)],
);

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export const meetings = pgTable(
	"meetings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
		// Meeting length in minutes. Copied from the club's defaultMeetingMinutes
		// at insert (copy-at-insert) so historical end times stay stable when the
		// club default changes; editable per-meeting via the edit dialog. Non-null
		// default (90) backfills meetings created before this column existed.
		lengthMinutes: integer("length_minutes").notNull().default(90),
		location: text("location"),
		theme: text("theme"),
		wordOfTheDay: text("word_of_the_day"),
		// Word-of-the-Day supporting copy for the projected present-mode deck.
		wodDefinition: text("wod_definition"),
		wodExample: text("wod_example"),
		status: meetingStatusEnum("status").notNull().default("scheduled"),
		notes: text("notes"),
		// Free-text club announcements projected on the present-mode Reminders
		// slide. Distinct from `notes` (private organizer scratch).
		reminders: text("reminders"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("meetings_club_scheduled_idx").on(t.clubId, t.scheduledAt)],
);

// ---------------------------------------------------------------------------
// Role definitions (the club's role template)
// ---------------------------------------------------------------------------

export const roleDefinitions = pgTable(
	"role_definitions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		category: roleCategoryEnum("category").notNull(),
		defaultCount: integer("default_count").notNull().default(1),
		sortOrder: integer("sort_order").notNull().default(0),
		isSpeakerRole: boolean("is_speaker_role").notNull().default(false),
		// Human-readable responsibilities, shown before claiming + on the shared link.
		description: text("description"),
	},
	(t) => [index("role_definitions_club_idx").on(t.clubId)],
);

// ---------------------------------------------------------------------------
// Role slots — the live, claimable agenda rows. This table IS the history:
// "who has done what" is a query over slots of past meetings.
// ---------------------------------------------------------------------------

export const roleSlots = pgTable(
	"role_slots",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		roleDefinitionId: uuid("role_definition_id")
			.notNull()
			.references(() => roleDefinitions.id, { onDelete: "restrict" }),
		slotIndex: integer("slot_index").notNull().default(0),
		assignedMemberId: uuid("assigned_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		// A non-member guest holding this slot (#151), as an alternative to a
		// member. MUTUALLY EXCLUSIVE with assignedMemberId — a slot has at most one
		// assignee, either a member or a guest, never both (enforced in the assign
		// logic AND the check constraint below). On guest delete → set null.
		assignedGuestId: uuid("assigned_guest_id").references(() => guests.id, {
			onDelete: "set null",
		}),
		status: slotStatusEnum("status").notNull().default("open"),
		// For evaluator slots: which speaker slot this slot evaluates.
		evaluatesSlotId: uuid("evaluates_slot_id").references(
			(): AnyPgColumn => roleSlots.id,
			{ onDelete: "set null" },
		),
		// The Person-owned Speech delivered in this speaker slot (ADR-0009 / #79).
		// Null = TBA (assigned member, no speech attached yet). Replaces the old
		// slot-bound `speaker_details`. The pointer moves on reschedule and clears
		// on reassign-to-a-different-person; the speech itself is never destroyed by
		// slot changes (speech deleted → set null). A speech is referenced by at
		// most one slot at a time — enforced by the unique index below (Postgres
		// treats NULLs as distinct, so many TBA slots coexist).
		speechId: uuid("speech_id").references(() => speeches.id, {
			onDelete: "set null",
		}),
		claimedAt: timestamp("claimed_at"),
	},
	(t) => [
		index("role_slots_meeting_idx").on(t.meetingId),
		index("role_slots_assigned_member_idx").on(t.assignedMemberId),
		index("role_slots_assigned_guest_idx").on(t.assignedGuestId),
		uniqueIndex("role_slots_speech_unique").on(t.speechId),
		// A slot has at most one assignee: a member OR a guest, never both (#151).
		check(
			"role_slots_single_assignee",
			sql`${t.assignedMemberId} is null or ${t.assignedGuestId} is null`,
		),
	],
);

// ---------------------------------------------------------------------------
// Member availability (presence = "Not Available" for that meeting)
// ---------------------------------------------------------------------------

export const memberAvailability = pgTable(
	"member_availability",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// Presence of a row = "Not Available" for that meeting. One per pair.
		uniqueIndex("member_availability_unique").on(t.memberId, t.meetingId),
		index("member_availability_meeting_idx").on(t.meetingId),
	],
);

// ---------------------------------------------------------------------------
// Meeting minutes — a record OVER the `meetings` row (ADR-0014 / #152). Three
// child tables (attendance, Table Topics speakers, awards); the `meetings` row
// is the header (date, theme, Word of the Day) — there is no minutes-header
// table. Each assignee mirrors `role_slots`: a member XOR a guest, enforced by
// a DB check constraint (at most one of the two is non-null). All cascade on
// meeting delete.
// ---------------------------------------------------------------------------

export const meetingAttendance = pgTable(
	"meeting_attendance",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		// Member XOR guest. A member row snapshots roster presence and persists
		// even if the member's roster status later changes (on member delete →
		// set null keeps the historical count, though such rows carry no name).
		memberId: uuid("member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		// A non-member guest present at the meeting (ADR-0013). Guests are stored
		// with status `present` (a guest who didn't come isn't listed).
		guestId: uuid("guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		status: attendanceStatusEnum("status").notNull().default("absent"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_attendance_meeting_idx").on(t.meetingId),
		// One attendance row per member per meeting, and one per guest per meeting.
		// Plain (non-partial) unique indexes so ON CONFLICT can infer them as
		// arbiters; Postgres treats NULLs as distinct, so the many member rows
		// (guest_id NULL) and many guest rows (member_id NULL) never collide.
		uniqueIndex("meeting_attendance_member_unique").on(t.meetingId, t.memberId),
		uniqueIndex("meeting_attendance_guest_unique").on(t.meetingId, t.guestId),
		// At most one assignee: a member OR a guest, never both (mirrors role_slots).
		check(
			"meeting_attendance_single_assignee",
			sql`${t.memberId} is null or ${t.guestId} is null`,
		),
	],
);

export const tableTopicsSpeakers = pgTable(
	"table_topics_speakers",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		memberId: uuid("member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		guestId: uuid("guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		// The impromptu prompt/topic the speaker answered. Optional.
		topic: text("topic"),
		// Display order within a meeting (0-based). Reordered by the admin.
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("table_topics_speakers_meeting_idx").on(t.meetingId),
		check(
			"table_topics_speakers_single_assignee",
			sql`${t.memberId} is null or ${t.guestId} is null`,
		),
	],
);

export const meetingAwards = pgTable(
	"meeting_awards",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		category: awardCategoryEnum("category").notNull(),
		memberId: uuid("member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		guestId: uuid("guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_awards_meeting_idx").on(t.meetingId),
		// One winner per category per meeting (single-valued award).
		uniqueIndex("meeting_awards_meeting_category_unique").on(
			t.meetingId,
			t.category,
		),
		check(
			"meeting_awards_single_assignee",
			sql`${t.memberId} is null or ${t.guestId} is null`,
		),
	],
);

// ---------------------------------------------------------------------------
// Speeches — first-class, Person-owned content (ADR-0009 / #79).
//
// A speech is durable and independent of the schedule: it belongs to a Person
// (not a club, not a slot), so reassigning or rescheduling a speaker slot never
// destroys it. A speaker slot *references* a speech via `role_slots.speech_id`.
// No `club_id` (a delivery's club comes from the slot → meeting), no stored
// `status` (scheduling state is derived from slot linkage + meeting date).
// pathway/project/level stay free text (spike #101). Replaces `speaker_details`.
// ---------------------------------------------------------------------------

export const speeches = pgTable(
	"speeches",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		introduction: text("introduction"),
		pathwayPath: text("pathway_path"),
		projectName: text("project_name"),
		projectLevel: text("project_level"),
		// Phase 2 (#101): link a speech to a real catalog project. Nullable — the
		// free-text pathway_path/project_name/project_level stay as the fallback
		// display until project_id coverage is high.
		projectId: uuid("project_id").references(() => pathwaysProjects.id, {
			onDelete: "set null",
		}),
		minMinutes: integer("min_minutes"),
		maxMinutes: integer("max_minutes"),
		// Optional link to the speaker's own slides/deck (#175). Rendered as a
		// "Link: Presentation" bullet on the projected speech slide + .pptx export.
		presentationUrl: text("presentation_url"),
		// The one non-derivable speech state (ADR-0009): hide an abandoned draft
		// from the "unscheduled speeches" surface without deleting it. Scheduling
		// state (unscheduled / scheduled / delivered) stays DERIVED from slot
		// linkage; `archived` is orthogonal — an archived speech is simply hidden
		// from the reschedule pool by default. Default false.
		archived: boolean("archived").notNull().default(false),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [index("speeches_person_idx").on(t.personId)],
);

// ---------------------------------------------------------------------------
// Pathways progress (count-based mirror of Base Camp — spec 2026-07-06).
// Paths are upserted from sync data (course_code + name); per-person per-level
// counts + `approved` mirror Base Camp's /api/bcm/progress. Base Camp is the
// system of record; this is a mirror. Project NAMES are a Phase 2 concern.
// ---------------------------------------------------------------------------

export const pathwaysPaths = pgTable("pathways_paths", {
	id: uuid("id").defaultRandom().primaryKey(),
	// Stable path code parsed from course_id (e.g. "8701" = Presentation Mastery).
	// The durable catalog key — not the display name.
	courseCode: text("course_code").notNull().unique(),
	name: text("name").notNull(),
	status: pathwayStatusEnum("status").notNull().default("current"),
	sortOrder: integer("sort_order").notNull().default(0),
});

export const pathEnrollments = pgTable(
	"path_enrollments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		pathId: uuid("path_id")
			.notNull()
			.references(() => pathwaysPaths.id, { onDelete: "cascade" }),
		lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
		archivedAt: timestamp("archived_at"),
	},
	(t) => [
		uniqueIndex("path_enrollments_person_path_idx").on(t.personId, t.pathId),
	],
);

export const pathLevelProgress = pgTable(
	"path_level_progress",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		enrollmentId: uuid("enrollment_id")
			.notNull()
			.references(() => pathEnrollments.id, { onDelete: "cascade" }),
		level: integer("level").notNull(),
		// Raw Base Camp counts — `completed` MAY exceed `total` (extra/repeated
		// electives); store as-is. `approved` is the authoritative "level done".
		completed: integer("completed").notNull(),
		total: integer("total").notNull(),
		approved: boolean("approved").notNull(),
	},
	(t) => [
		uniqueIndex("path_level_progress_enrollment_level_idx").on(
			t.enrollmentId,
			t.level,
		),
	],
);

export const pathwaysProjects = pgTable(
	"pathways_projects",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		pathId: uuid("path_id")
			.notNull()
			.references(() => pathwaysPaths.id, { onDelete: "cascade" }),
		level: integer("level").notNull(),
		name: text("name").notNull(),
		// Required vs elective is display emphasis only — Base Camp counts/`approved`
		// still drive level completion (Phase 1 decision).
		isRequired: boolean("is_required").notNull().default(false),
		// Base Camp block id (from /detail blocks). Stamped onto a catalog row when a
		// member's /detail reveals it; null for pool rows no member has chosen yet.
		// The durable join key for bcm_project_progress. Unique-when-present.
		bcmBlockId: text("bcm_block_id"),
		sortOrder: integer("sort_order").notNull().default(0),
	},
	(t) => [
		uniqueIndex("pathways_projects_path_level_name_idx").on(
			t.pathId,
			t.level,
			t.name,
		),
		uniqueIndex("pathways_projects_bcm_block_id_idx")
			.on(t.bcmBlockId)
			.where(sql`${t.bcmBlockId} is not null`),
	],
);

// Per-(path, level) chapter facts from /detail (spec 2026-07-07). Currently just
// `min_req_electives` — how many electives a level requires — which drives the
// precise "up next" elective count. One row per (path, level).
export const pathwaysPathLevels = pgTable(
	"pathways_path_levels",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		pathId: uuid("path_id")
			.notNull()
			.references(() => pathwaysPaths.id, { onDelete: "cascade" }),
		level: integer("level").notNull(),
		minReqElectives: integer("min_req_electives").notNull().default(0),
	},
	(t) => [
		uniqueIndex("pathways_path_levels_path_level_idx").on(t.pathId, t.level),
	],
);

// Read-only mirror of Base Camp /detail per-project completion + speech (spec
// 2026-07-07). One row per (enrollment, project). Re-derived every sync via
// replace-per-enrollment; enrollments absent from a sync keep last-known-good.
export const bcmProjectProgress = pgTable(
	"bcm_project_progress",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		enrollmentId: uuid("enrollment_id")
			.notNull()
			.references(() => pathEnrollments.id, { onDelete: "cascade" }),
		projectId: uuid("project_id")
			.notNull()
			.references(() => pathwaysProjects.id, { onDelete: "cascade" }),
		complete: boolean("complete").notNull(),
		speechTitle: text("speech_title"),
		speechDate: timestamp("speech_date", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("bcm_project_progress_enrollment_project_idx").on(
			t.enrollmentId,
			t.projectId,
		),
	],
);

// ---------------------------------------------------------------------------
// Sync tokens — per-club Bearer credentials for the Pathways auto-sync browser
// extension (#107). The token IS the club identity: the ingest endpoint derives
// clubId from the token, so no session is involved. Raw token is shown once at
// creation and stored only as a SHA-256 hash. Revoked explicitly (revokedAt).
// `basecampClubGuid` is captured on first sync and drives a soft wrong-club warning.
// ---------------------------------------------------------------------------
export const syncTokens = pgTable(
	"sync_tokens",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		name: text("name"),
		basecampClubGuid: text("basecamp_club_guid"),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		lastUsedAt: timestamp("last_used_at"),
		revokedAt: timestamp("revoked_at"),
	},
	(t) => [index("sync_tokens_club_idx").on(t.clubId)],
);

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export const activityLog = pgTable(
	"activity_log",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// The self-asserted member who acted (NULL = system/unknown).
		actorMemberId: uuid("actor_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		action: activityActionEnum("action").notNull(),
		targetType: text("target_type").notNull(), // 'slot' | 'meeting' | 'member'
		targetId: text("target_id"),
		detail: jsonb("detail"), // { before?, after?, ... }
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("activity_log_club_created_idx").on(t.clubId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Notifications — table only; sending logic is out of scope for the MVP.
// ---------------------------------------------------------------------------

export const notifications = pgTable("notifications", {
	id: uuid("id").defaultRandom().primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	slotId: uuid("slot_id")
		.notNull()
		.references(() => roleSlots.id, { onDelete: "cascade" }),
	type: text("type").notNull(),
	channel: text("channel").notNull(),
	sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const peopleRelations = relations(people, ({ one, many }) => ({
	user: one(user, { fields: [people.userId], references: [user.id] }),
	memberships: many(members),
	speeches: many(speeches),
}));

export const membersRelations = relations(members, ({ one, many }) => ({
	club: one(clubs, { fields: [members.clubId], references: [clubs.id] }),
	person: one(people, {
		fields: [members.personId],
		references: [people.id],
	}),
	officerTerms: many(officerTerms),
}));

export const officerTermsRelations = relations(officerTerms, ({ one }) => ({
	membership: one(members, {
		fields: [officerTerms.membershipId],
		references: [members.id],
	}),
}));

export const duesPeriodsRelations = relations(duesPeriods, ({ one, many }) => ({
	club: one(clubs, {
		fields: [duesPeriods.clubId],
		references: [clubs.id],
	}),
	dues: many(memberDues),
}));

export const memberDuesRelations = relations(memberDues, ({ one }) => ({
	period: one(duesPeriods, {
		fields: [memberDues.duesPeriodId],
		references: [duesPeriods.id],
	}),
	membership: one(members, {
		fields: [memberDues.membershipId],
		references: [members.id],
	}),
}));

export const clubsRelations = relations(clubs, ({ many }) => ({
	meetings: many(meetings),
	roleDefinitions: many(roleDefinitions),
	members: many(members),
	guests: many(guests),
}));

export const guestsRelations = relations(guests, ({ one, many }) => ({
	club: one(clubs, { fields: [guests.clubId], references: [clubs.id] }),
	slots: many(roleSlots),
}));

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
	club: one(clubs, {
		fields: [meetings.clubId],
		references: [clubs.id],
	}),
	slots: many(roleSlots),
	attendance: many(meetingAttendance),
	tableTopicsSpeakers: many(tableTopicsSpeakers),
	awards: many(meetingAwards),
}));

export const meetingAttendanceRelations = relations(
	meetingAttendance,
	({ one }) => ({
		meeting: one(meetings, {
			fields: [meetingAttendance.meetingId],
			references: [meetings.id],
		}),
		member: one(members, {
			fields: [meetingAttendance.memberId],
			references: [members.id],
		}),
		guest: one(guests, {
			fields: [meetingAttendance.guestId],
			references: [guests.id],
		}),
	}),
);

export const tableTopicsSpeakersRelations = relations(
	tableTopicsSpeakers,
	({ one }) => ({
		meeting: one(meetings, {
			fields: [tableTopicsSpeakers.meetingId],
			references: [meetings.id],
		}),
		member: one(members, {
			fields: [tableTopicsSpeakers.memberId],
			references: [members.id],
		}),
		guest: one(guests, {
			fields: [tableTopicsSpeakers.guestId],
			references: [guests.id],
		}),
	}),
);

export const meetingAwardsRelations = relations(meetingAwards, ({ one }) => ({
	meeting: one(meetings, {
		fields: [meetingAwards.meetingId],
		references: [meetings.id],
	}),
	member: one(members, {
		fields: [meetingAwards.memberId],
		references: [members.id],
	}),
	guest: one(guests, {
		fields: [meetingAwards.guestId],
		references: [guests.id],
	}),
}));

export const roleDefinitionsRelations = relations(
	roleDefinitions,
	({ one, many }) => ({
		club: one(clubs, {
			fields: [roleDefinitions.clubId],
			references: [clubs.id],
		}),
		slots: many(roleSlots),
	}),
);

export const roleSlotsRelations = relations(roleSlots, ({ one }) => ({
	meeting: one(meetings, {
		fields: [roleSlots.meetingId],
		references: [meetings.id],
	}),
	roleDefinition: one(roleDefinitions, {
		fields: [roleSlots.roleDefinitionId],
		references: [roleDefinitions.id],
	}),
	assignedMember: one(members, {
		fields: [roleSlots.assignedMemberId],
		references: [members.id],
	}),
	assignedGuest: one(guests, {
		fields: [roleSlots.assignedGuestId],
		references: [guests.id],
	}),
	evaluatesSlot: one(roleSlots, {
		fields: [roleSlots.evaluatesSlotId],
		references: [roleSlots.id],
		relationName: "evaluatesSlot",
	}),
	speech: one(speeches, {
		fields: [roleSlots.speechId],
		references: [speeches.id],
	}),
}));

export const speechesRelations = relations(speeches, ({ one, many }) => ({
	person: one(people, {
		fields: [speeches.personId],
		references: [people.id],
	}),
	slots: many(roleSlots),
	project: one(pathwaysProjects, {
		fields: [speeches.projectId],
		references: [pathwaysProjects.id],
	}),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
	user: one(user, {
		fields: [notifications.userId],
		references: [user.id],
	}),
	slot: one(roleSlots, {
		fields: [notifications.slotId],
		references: [roleSlots.id],
	}),
}));

export const pathwaysPathsRelations = relations(pathwaysPaths, ({ many }) => ({
	enrollments: many(pathEnrollments),
	projects: many(pathwaysProjects),
}));

export const pathEnrollmentsRelations = relations(
	pathEnrollments,
	({ one, many }) => ({
		person: one(people, {
			fields: [pathEnrollments.personId],
			references: [people.id],
		}),
		path: one(pathwaysPaths, {
			fields: [pathEnrollments.pathId],
			references: [pathwaysPaths.id],
		}),
		levels: many(pathLevelProgress),
	}),
);

export const pathLevelProgressRelations = relations(
	pathLevelProgress,
	({ one }) => ({
		enrollment: one(pathEnrollments, {
			fields: [pathLevelProgress.enrollmentId],
			references: [pathEnrollments.id],
		}),
	}),
);

export const pathwaysProjectsRelations = relations(
	pathwaysProjects,
	({ one, many }) => ({
		path: one(pathwaysPaths, {
			fields: [pathwaysProjects.pathId],
			references: [pathwaysPaths.id],
		}),
		speeches: many(speeches),
	}),
);

export const bcmProjectProgressRelations = relations(
	bcmProjectProgress,
	({ one }) => ({
		enrollment: one(pathEnrollments, {
			fields: [bcmProjectProgress.enrollmentId],
			references: [pathEnrollments.id],
		}),
		project: one(pathwaysProjects, {
			fields: [bcmProjectProgress.projectId],
			references: [pathwaysProjects.id],
		}),
	}),
);

export const pathwaysPathLevelsRelations = relations(
	pathwaysPathLevels,
	({ one }) => ({
		path: one(pathwaysPaths, {
			fields: [pathwaysPathLevels.pathId],
			references: [pathwaysPaths.id],
		}),
	}),
);
