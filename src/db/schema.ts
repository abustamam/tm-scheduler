import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
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
		status: meetingStatusEnum("status").notNull().default("scheduled"),
		notes: text("notes"),
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
		uniqueIndex("role_slots_speech_unique").on(t.speechId),
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
		minMinutes: integer("min_minutes"),
		maxMinutes: integer("max_minutes"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [index("speeches_person_idx").on(t.personId)],
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

export const clubsRelations = relations(clubs, ({ many }) => ({
	meetings: many(meetings),
	roleDefinitions: many(roleDefinitions),
	members: many(members),
}));

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
	club: one(clubs, {
		fields: [meetings.clubId],
		references: [clubs.id],
	}),
	slots: many(roleSlots),
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
