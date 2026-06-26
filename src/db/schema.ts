import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
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

// ---------------------------------------------------------------------------
// Clubs & memberships
// ---------------------------------------------------------------------------

export const clubs = pgTable("clubs", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	timezone: text("timezone").notNull().default("America/Chicago"),
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
		assignedUserId: text("assigned_user_id").references(() => user.id, {
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
		index("role_slots_assigned_user_idx").on(t.assignedUserId),
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

export const clubsRelations = relations(clubs, ({ many }) => ({
	memberships: many(clubMemberships),
	meetings: many(meetings),
	roleDefinitions: many(roleDefinitions),
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
	assignedUser: one(user, {
		fields: [roleSlots.assignedUserId],
		references: [user.id],
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
