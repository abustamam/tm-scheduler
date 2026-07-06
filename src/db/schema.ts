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

// user is re-exported above for Better-Auth; imported here for clubMemberships and members foreign keys
import { user } from "./auth-schema";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const clubRoleEnum = pgEnum("club_role", ["admin", "vpe", "member"]);
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

export const clubMemberships = pgTable(
	"club_memberships",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		clubRole: clubRoleEnum("club_role").notNull().default("member"),
		status: membershipStatusEnum("status").notNull().default("active"),
		joinedAt: timestamp("joined_at").defaultNow().notNull(),
	},
	(t) => [
		index("club_memberships_user_idx").on(t.userId),
		index("club_memberships_club_idx").on(t.clubId),
	],
);

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
	// Optional link to a Better-Auth sign-in account (one login spans all their
	// clubs). Phase A only carries it up; the auth path still resolves role via
	// club_memberships (Phase B, #99).
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
		office: text("office"),
		// Roster membership status. "inactive" = didn't renew this season: hidden
		// from sign-up / roster / season / picker views, but their past role
		// history is preserved (never deleted). Reactivating restores them.
		status: membershipStatusEnum("status").notNull().default("active"),
		// Real join date from the Toastmasters membership export (seeded by
		// scripts/import-members.ts). joinedAt = "Member of *this* Club Since"
		// (per-club). First-ever TM join lives on people.originalJoinDate.
		joinedAt: timestamp("joined_at"),
		// Links a roster member to the Better-Auth account of the one signed-in
		// admin/VPE. NULL for ordinary members (who never sign in).
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("members_club_idx").on(t.clubId),
		index("members_person_idx").on(t.personId),
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
		claimedAt: timestamp("claimed_at"),
	},
	(t) => [
		index("role_slots_meeting_idx").on(t.meetingId),
		index("role_slots_assigned_member_idx").on(t.assignedMemberId),
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
// Speaker details (1:1 with a claimed speaker slot)
// ---------------------------------------------------------------------------

export const speakerDetails = pgTable("speaker_details", {
	slotId: uuid("slot_id")
		.primaryKey()
		.references(() => roleSlots.id, { onDelete: "cascade" }),
	speechTitle: text("speech_title"),
	pathwayPath: text("pathway_path"),
	projectName: text("project_name"),
	projectLevel: text("project_level"),
	minMinutes: integer("min_minutes"),
	maxMinutes: integer("max_minutes"),
});

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
}));

export const membersRelations = relations(members, ({ one }) => ({
	club: one(clubs, { fields: [members.clubId], references: [clubs.id] }),
	person: one(people, {
		fields: [members.personId],
		references: [people.id],
	}),
	user: one(user, { fields: [members.userId], references: [user.id] }),
}));

export const clubsRelations = relations(clubs, ({ many }) => ({
	memberships: many(clubMemberships),
	meetings: many(meetings),
	roleDefinitions: many(roleDefinitions),
	members: many(members),
}));

export const clubMembershipsRelations = relations(
	clubMemberships,
	({ one }) => ({
		user: one(user, {
			fields: [clubMemberships.userId],
			references: [user.id],
		}),
		club: one(clubs, {
			fields: [clubMemberships.clubId],
			references: [clubs.id],
		}),
	}),
);

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
	speakerDetails: one(speakerDetails, {
		fields: [roleSlots.id],
		references: [speakerDetails.slotId],
	}),
}));

export const speakerDetailsRelations = relations(speakerDetails, ({ one }) => ({
	slot: one(roleSlots, {
		fields: [speakerDetails.slotId],
		references: [roleSlots.id],
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
