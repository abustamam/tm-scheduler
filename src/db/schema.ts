import { relations, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	customType,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// Re-export Better-Auth's generated tables so the single `schema` namespace
// imported by the db client (and the Drizzle adapter) sees user/session/etc.
// The OAuth tables (#842 / ADR-0027) ride the same re-export: the Drizzle
// adapter looks a model up by name in THIS namespace, so a table missing here
// fails at runtime on the first token request, not at build time.
export {
	account,
	accountRelations,
	jwks,
	oauthAccessToken,
	oauthClient,
	oauthClientAssertion,
	oauthClientResource,
	oauthConsent,
	oauthRefreshToken,
	oauthResource,
	session,
	sessionRelations,
	user,
	userRelations,
	verification,
} from "./auth-schema";

// The `tool` discriminator's vocabulary (#812). Type-only, so it contributes
// nothing at runtime and drizzle-kit's schema read is unaffected — same
// standing as the import above, and relative for the same reason.
import type { McpPendingTool } from "../lib/pending-plan";
// One number, one declaration. `clubs`'s Table Topics CHECK interpolates the
// ceiling rather than writing 600 into the SQL, so the constraint and every
// application layer cannot state different limits. `table-topics-limits.ts`
// imports nothing at runtime (its one import is `import type`), so this pulls
// no module graph into the two standalone bundles that gate a container start
// (`.output/seed-catalog.mjs` and `.output/seed-templates.mjs`) or into
// drizzle-kit's own schema read — `table-topics-limits-wiring.guard.test.ts`
// holds that.
//
// RELATIVE, against CLAUDE.md's `#/*` preference, and deliberately: this file is
// read by drizzle-kit outside the app's module resolution, where the
// `package.json` `imports` alias is not guaranteed to resolve. Every other
// import in this file is relative for the same reason.
import { MAX_TABLE_TOPICS_SECONDS } from "../lib/table-topics-limits";
// user is re-exported above for Better-Auth; imported here for people.userId and
// notifications foreign keys (the person-level auth link — ADR-0008 Phase B).
import { user } from "./auth-schema";

// drizzle-orm 0.45.1 has no built-in `bytea` type and the repo has no prior
// precedent for one — define it once (#495, `club_logos.bytes`). Buffer in,
// Buffer out; no text/base64 encoding at the db layer.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType() {
		return "bytea";
	},
});

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
// What one row of a meeting template's run-of-show is (#agenda-templates).
// `section` is a full-width band ("PREPARED SPEECH CONTEST"), `role` names a
// template role that presents it, `event` is a beat nobody owns (a minute of
// silence, a break).
export const templateBeatKindEnum = pgEnum("template_beat_kind", [
	"section",
	"role",
	"event",
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
	// LEGACY (2026-08-11): superseded by `plan_set` below, which covers the whole
	// reached_out/coming/not_coming ladder. Kept — never remove — so historical
	// activity_log rows written before the cutover keep rendering in the feed.
	"availability_set",
	"availability_clear",
	"member_add",
	"member_edit",
	"member_merge",
	"member_remove",
	"meeting_create",
	"meeting_edit",
	// A platform superadmin started a read-only impersonation session viewing this
	// club (ADR-0020 / #185). actor is null (no member row); the real superadmin
	// identity is carried in `detail`.
	"superadmin_viewed",
	// A platform superadmin started a read-WRITE ("act as admin") session on this
	// club (ADR-0020 / #246). Like `superadmin_viewed`, actor is null and the real
	// superadmin identity + the required access reason are carried in `detail`.
	"superadmin_acted",
	// A meeting's shape was switched to (or away from) a meeting template
	// (#agenda-templates). `detail` carries `{ templateId }`, null when the
	// meeting was converted back to the club's standard shape.
	"meeting_template_set",
	// Club logo set/replaced and removed (#495). Both are logged because the
	// row-level `attested_by`/`attested_at` on `club_logos` dies with the row
	// on removal — which is exactly the moment a trail matters, since ADR-0024's
	// posture rests on showing who represented authorization and acting on a
	// complaint. `detail` carries the mime and byte length, never the bytes.
	"club_logo_set",
	"club_logo_removed",
	// Officer outreach tracking (#340): a member was marked "contacted" for a
	// meeting (or the mark was cleared). `detail = { memberId, via }`.
	// LEGACY (2026-08-11): superseded by `plan_set` below — kept for historical
	// activity_log rows only.
	"outreach_set",
	"outreach_clear",
	// Digital voting (#510): a vote window opened or closed. Deliberately NOT
	// `vote_cast` — logging every ballot would put voter identity into a feed the
	// club can read, exposing the electorate for no benefit. The tally is the
	// record. `detail = { category }`.
	"vote_open",
	"vote_close",
	// Digital voting (#723): the Vote Counter ruled a candidate out of one award,
	// or undid that. Unlike `vote_cast` these ARE logged — a disqualification is
	// one person deciding another cannot win, which is exactly the kind of write
	// a club should be able to see afterwards. `detail = { category, reason }` on
	// the set; `{ category }` on the undo, since the reason is gone by then.
	"vote_disqualify",
	"vote_disqualify_undo",
	// Planned attendance changed (spec 2026-08-11, D1). One action for every
	// rung of the ladder; the rung is in the detail, not the action name.
	// `detail = { memberId, status: "reached_out" | "coming" | "not_coming" | null, via }`
	// where `status: null` means the row was cleared back to "no answer".
	"plan_set",
	// A role was removed from a meeting's own agenda editor (Task 8,
	// #agenda-templates). No corresponding `_added` action: adding a role
	// creates no risk to audit — nothing is destroyed — while removal can
	// release a member or guest from a slot they held, which is exactly the
	// kind of change `member_remove` and `outreach_clear` are logged for
	// elsewhere in this enum. `detail = { roleKey, released }`.
	"meeting_agenda_role_removed",
	// The DCP scoreboard (#690). TWO values, not one and not five: the club's
	// official Distinguished Club Program record has five admin-gated writers,
	// and to a reader of the feed they are two different events — "the President
	// typed a number" (`dcp_scoreboard_edit`: starting the scoreboard, setting a
	// goal, correcting the membership base) against "the President accepted a
	// batch of suggestions that moved several goals at once"
	// (`dcp_suggestion_applied`: the Pathways assist for goals 1–6, and the
	// officer-training assist for goal 9).
	//
	// It stops at two deliberately. Values here are one-way — `availability_set`
	// above is annotated "Kept — never remove" for exactly that reason — so a
	// vocabulary that proves too coarse can be widened later, while one that is
	// too fine can never be narrowed.
	//
	// Both carry `targetType: "scoreboard"` with the `dcp_scoreboards` row id, and
	// a `detail.change` discriminator the feed already reads
	// (`activity-feed-logic.ts` maps `detail.change` → `ActivityEntry.change`, the
	// same seam `meeting_edit` uses). An apply writes ONE row naming the goals it
	// moved, never one per goal.
	// `detail = { change, programYear, before?, after?, goalKey?, goals? }`
	"dcp_scoreboard_edit",
	"dcp_suggestion_applied",
	// The Timer recorded (or corrected) a measured time for one agenda slot
	// (#730). ONE value, not a create/update pair: the write is an upsert keyed
	// on the slot, so "recorded" and "corrected" are the same operation reaching
	// the same row, and the feed's reader would have to re-derive which it was
	// from the row's history anyway. `detail = { slotId, roleName,
	// elapsedSeconds, grantedVia }` — `grantedVia` because the write has an
	// honour-system arm, and a grant defended as auditable is not auditable
	// while a self-asserted Timer's write and a session-authenticated officer's
	// look identical in the feed (the rule `plan_set` already follows).
	"timing_record",
	// A page of the paper guest book was transcribed through the MCP endpoint
	// (#773). ONE row per apply, not one per guest: the maintainer transcribes a
	// PAGE, the apply is all-or-nothing, and a feed that lists twelve separate
	// rows for one sitting buries the club's other activity. Recording guest
	// attendance from the browser still logs nothing — that asymmetry is
	// deliberate and narrow: this path is a bearer token acting outside a
	// session, so "who wrote these rows, and through what" is the question the
	// feed has to be able to answer. `detail = { meetingId, newGuestIds,
	// matchedGuestIds, via }`, and it carries NO names or contact details —
	// every member of the club can read the activity feed, and a guest's email
	// is not theirs to read.
	"guest_visits_record",
	// A meeting's agenda was saved as a club-owned template (#909), new or
	// replacing one of the club's own. ONE value for both modes: the mode is in
	// `detail`, and to a reader of the feed both are "the club's template now
	// looks like this meeting". `targetType: "meeting"` names the SOURCE meeting.
	// `detail = { templateId, mode: "new" | "replace", sourceMeetingId }`
	"club_template_saved",
]);

// Impersonation session mode (ADR-0020 / #185, #246). `read_only` = "View as this
// club" (writes reject by construction). `read_write` = "Act as admin" — the
// mutating guards honor the session as an effective admin (memberless), under a
// shorter TTL + required reason + per-write audit.
export const impersonationModeEnum = pgEnum("impersonation_mode", [
	"read_only",
	"read_write",
]);

// Presence state on a `meeting_attendance` row (ADR-0014 / #152). The COLUMN
// defaults to `absent`, but no row at all is the real fourth state, "unmarked" —
// and a member holding a role slot is NOT pre-filled `present`. That rule was
// removed in #218: a meeting nobody took the roll at would otherwise report the
// whole club absent. Guests are always stored `present` (a guest who didn't come
// isn't listed). Written by the attendance panel's ROLL mode (v1.20.0.0) — see
// ADR-0014's amendment.
export const attendanceStatusEnum = pgEnum("attendance_status", [
	"present",
	"absent",
	"excused",
]);

// Planned attendance for an UPCOMING meeting (D1 of the 2026-08-11 spec).
// Replaces the two disconnected boolean tables dropped in this same PR — one
// meaning "I asked them", one meaning "not available". Row ABSENT = "no
// answer" — silence and a positive answer used to be indistinguishable, which
// is why `coming` exists at all. Deliberately NOT `attendance_status`: that
// one is the RECORD (present/absent/excused) written after the meeting, and a
// plan must never be storable as a record. See `meeting_attendance` below.
export const attendancePlanStatusEnum = pgEnum("attendance_plan_status", [
	"reached_out",
	"coming",
	"not_coming",
]);

// The three award/ribbon categories captured in the minutes (ADR-0014 / #152).
// One winner (a member XOR a guest) per category per meeting; all optional.
export const awardCategoryEnum = pgEnum("award_category", [
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);

// WHICH arm of the timing actor ladder admitted a write (#730) — a club
// officer, this meeting's Toastmaster, or the member holding this meeting's
// Timer slot asserting themselves.
//
// A pgEnum rather than bare `text`, and the reason is the same one that makes
// the column worth having at all. Two of the three arms are honour-system
// claims resolved against a member id the public agenda payload already
// publishes, so the grant is defensible only because it is auditable
// afterwards — and an audit trail carrying a typo'd arm name that type-checked
// clean is not one. The union it mirrors is `ResolvedActor["via"]` in
// `attendance-actor-logic.ts`, which is where the shape came from.
//
// `self` is the Timer's own arm here, NOT "the subject of the write" as it is
// on the attendance ladder: a timing has no subject member, so the self arm
// means "the caller holds this meeting's Timer slot".
export const timingGrantedViaEnum = pgEnum("timing_granted_via", [
	"officer",
	"tmod",
	"self",
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

export const clubs = pgTable(
	"clubs",
	{
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
		// Default international dialing code (e.g. "+1") applied to member/guest phone
		// numbers that lack one, so the tap-to-nudge WhatsApp link (#37) is a valid
		// full E.164 number. Nullable — unset means numbers without a country code
		// simply don't get a WhatsApp link (#295).
		defaultCountryCode: text("default_country_code"),
		// Default meeting length in minutes. New meetings inherit this at insert
		// (copied onto the meeting row) so a later change here never silently moves
		// the end time of meetings already scheduled. Non-null with a sensible
		// default (90) — most clubs run 60- or 90-minute meetings.
		defaultMeetingMinutes: integer("default_meeting_minutes")
			.notNull()
			.default(90),
		// The club's own Table Topics speaking limits (#443), in SECONDS, nullable
		// because most clubs run the standard 1–2 minute window and should not have
		// to state it. Null on either column means "not stated" and every surface
		// falls back to `TABLE_TOPICS_MARKS` — see `#/lib/table-topics-limits`, which
		// owns the fallback and every derivation from these two numbers.
		//
		// SECONDS, not the float minutes `TimingMarks` uses, because the rule this
		// exists to express is 2:30 and a club admin should type minutes-and-seconds
		// rather than "2.5". MCF's printed agenda writes that cap as "2.3 min", which
		// rounded into float minutes would silently store 2:18.
		//
		// There is deliberately no third column for the disqualification threshold:
		// it is one second past the cap, derived at render time, so an admin editing
		// the cap can never leave a stale DQ number behind it.
		tableTopicsMinSeconds: integer("table_topics_min_seconds"),
		tableTopicsMaxSeconds: integer("table_topics_max_seconds"),
		// Club-level reminder settings (#274 — the reminders control layer). Two
		// scalar knobs the admin/VP-Education sets on /admin/club-settings; the role-
		// reminder producer (#272) reads them. `reminder_enabled` gates whether the
		// club sends role reminders at all; `reminder_lead_time_days` is how many days
		// before a meeting to remind slot holders. Both non-null. `reminder_enabled`
		// defaults FALSE — role reminders are opt-in per club (soft launch): a club
		// turns them on from /admin/club-settings once ready, and the 0036 migration
		// flips every existing club off. `reminder_lead_time_days` defaults 3. Modeled
		// as columns on `clubs` (like `default_meeting_minutes`), not a 1:1 table: they
		// are two scalars with universal defaults, unlike the multi-field,
		// check-constrained `club_meeting_recurrence`.
		reminderEnabled: boolean("reminder_enabled").notNull().default(false),
		reminderLeadTimeDays: integer("reminder_lead_time_days")
			.notNull()
			.default(3),
		// The one axis of per-club variance in the generated run-of-show (#367).
		// FALSE (the default, and the standard Toastmasters flow) means the
		// Toastmaster of the Day introduces the functionaries at the top of the
		// meeting, each explaining their own role. TRUE is MCF's variant, where the
		// General Evaluator introduces them instead. Nothing else about the agenda
		// depends on it — the GE's closing sequence (evaluate the evaluators → call
		// for the functionary reports → overall evaluation) is the same either way.
		// Read by `buildRunOfShow` (printed agenda) and `buildSlideDeck` (deck).
		geIntroducesFunctionaries: boolean("ge_introduces_functionaries")
			.notNull()
			.default(false),
		// Whether the club runs its award votes on phones (#770). FALSE turns
		// digital voting off for EVERY meeting of the club: no ballot QR on any
		// agenda or slide, no Ballot Counter console, and `voting-logic.ts`
		// refuses to open a vote, take a ballot or add a guest to one. Paper
		// voting and recording the winners are untouched. Read LIVE, never
		// copied onto meetings — a meeting can only switch it further OFF
		// (`meetings.digital_voting_disabled`); `isDigitalVotingOn`
		// (`src/lib/digital-voting.ts`) is the one statement of the rule.
		digitalVotingEnabled: boolean("digital_voting_enabled")
			.notNull()
			.default(true),
		// Soft-archive (ADR-0016 / #186). NULL = active; a set timestamp = archived.
		// Reversible: unarchive clears it. Archiving retains all club data untouched
		// and blocks every access path except the superadmin console. This comment used
		// to enumerate the enforcement points and was wrong twice (#544, #560) — see
		// `isClubArchived` (`src/lib/club-archive.ts`) for the one canonical list.
		archivedAt: timestamp("archived_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// The Table Topics window's invariants, in the database (#679).
		//
		// They already hold in zod on the write path and are re-checked by
		// `hasTableTopicsLimits` before anything renders, so a bad row degrades to
		// the standard window rather than to a wrong one. What neither layer
		// reaches is a writer that never sees them: a seed script, a support data
		// fix, a bulk import. `(60, NULL)`, `(150, 60)` and `(0, 99999)` were all
		// storable, and a stored-but-ignored row is its own failure — an admin who
		// asked for 2:30, sees 2:30 in the form on reload, and gets 1:00–2:00 on
		// every printed sheet with nothing anywhere saying why.
		//
		// **Why this is safe to add VALIDATING, stated correctly.** An earlier
		// version of this comment said "every existing row has both columns NULL",
		// which is FALSE and contradicted the paragraph above it: v1.31.0.0 shipped
		// the columns AND the admin form in the same release, so a club can already
		// have stored a window. The real argument is that the shipped zod accept
		// set (`.int().min(0).max(600).nullable()` plus both-or-neither and
		// max > min) is EXACTLY this predicate, so no row the application wrote can
		// violate it. That matters because `ADD CONSTRAINT` without `NOT VALID`
		// scans the table, and the runner is the container's start command
		// (`node .output/migrate.mjs && node .output/server/index.mjs`) — a
		// violating row does not degrade the deploy, it stops the server booting.
		// Measured at 9.8ms over 100,000 rows, so the scan itself is free.
		//
		// The generalisation worth keeping: this reasoning holds ONLY while the
		// constraint is no narrower than the validation already shipped. Adding one
		// that is narrower needs the offending rows found first —
		//   select count(*) from clubs where not (<predicate>);
		// — because the failure mode is a deploy that fails closed, not a stale page.
		// LOWERING `MAX_TABLE_TOPICS_SECONDS` is exactly that case; see the note on
		// the constant.
		//
		// A CHECK fails only on FALSE — NULL passes — so the shape matters.
		// `(a IS NULL) = (b IS NULL)` is a comparison of two booleans and is never
		// NULL, and the second conjunct short-circuits on `max IS NULL`; a
		// half-stated row makes the first conjunct FALSE, and `FALSE AND NULL` is
		// FALSE, so no arm can evaluate to NULL and slip through.
		//
		// `>= 0` and the ceiling are here as well as the ordering because
		// `hasTableTopicsLimits` refuses both and the whole point is that this
		// stops a row it would have had to refuse from existing at all. The
		// ceiling is INTERPOLATED from `MAX_TABLE_TOPICS_SECONDS` rather than
		// typed as 600 — the sibling `club_meeting_recurrence` checks write their
		// bounds as literals with the constant named only in a comment, which is
		// exactly the drift this repo keeps finding.
		check(
			"clubs_table_topics_window_check",
			sql`(
				(${t.tableTopicsMinSeconds} IS NULL) = (${t.tableTopicsMaxSeconds} IS NULL)
				AND (
					${t.tableTopicsMaxSeconds} IS NULL
					OR (
						${t.tableTopicsMinSeconds} >= 0
						AND ${t.tableTopicsMaxSeconds} > ${t.tableTopicsMinSeconds}
						AND ${t.tableTopicsMaxSeconds} <= ${sql.raw(String(MAX_TABLE_TOPICS_SECONDS))}
					)
				)
			)`,
		),
	],
);

// ---------------------------------------------------------------------------
// Standing meeting-recurrence rule (#190). A per-club, OPEN-ENDED schedule rule
// that keeps the calendar topped up to `keep_ahead` future meetings. Reuses
// #184's `RecurrenceInput` pattern fields (src/lib/meeting-recurrence.ts) MINUS
// the one-off `bound`; generation is lazy/read-triggered (no poller — ADR: see
// docs/adr). Row-present ⇒ has-a-rule (1:1 with clubs). Supplements — does not
// replace — the free-text `clubs.meetingSchedule`.
// ---------------------------------------------------------------------------

export const recurrenceModeEnum = pgEnum("recurrence_mode", [
	"interval",
	"monthly",
]);

export const clubMeetingRecurrence = pgTable(
	"club_meeting_recurrence",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// 1:1 with clubs — unique so a club has at most one standing rule.
		clubId: uuid("club_id")
			.notNull()
			.unique()
			.references(() => clubs.id, { onDelete: "cascade" }),
		mode: recurrenceModeEnum("mode").notNull(),
		// 0 = Sunday … 6 = Saturday (matches RecurrenceInput.Weekday / getUTCDay()).
		weekday: integer("weekday").notNull(),
		// interval mode: N in "every N weeks" (>= 1). NULL for monthly.
		intervalWeeks: integer("interval_weeks"),
		// interval mode: phase anchor (YYYY-MM-DD, club-local) so "every N weeks"
		// knows which weeks are "on". NULL for monthly (ordinals are calendar-
		// anchored). Also the seed for the first generation / deleted-everything
		// recovery.
		anchorDate: text("anchor_date"),
		// monthly mode: which ordinals each month — a subset of {1,2,3,4,5,"last"}
		// stored as text[] to match RecurrenceInput.Ordinal. NULL for interval.
		ordinals: text("ordinals").array(),
		// Wall-clock time-of-day (HH:mm) in the club timezone, applied to every
		// generated meeting; converted to a UTC instant at insert (DST-correct).
		timeOfDay: text("time_of_day").notNull(),
		// Default location copied onto auto-created meetings. Nullable.
		location: text("location"),
		// Keep this many FUTURE `scheduled` meetings on the calendar. Bounded
		// 1..52 (MAX_BATCH); the config form uses a tighter 1..12.
		keepAhead: integer("keep_ahead").notNull().default(4),
		// When false, top-up is paused (rule retained, no generation).
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		// Exactly the fields valid for the chosen mode are set (true XOR): interval
		// needs interval_weeks + anchor_date and NO ordinals; monthly needs a
		// non-empty ordinals and NO interval_weeks/anchor_date. `cardinality`
		// (not `array_length`) so an empty array reads as 0, not NULL — a CHECK
		// only fails on FALSE, so a NULL result would let an empty array slip past.
		check(
			"club_meeting_recurrence_mode_fields_check",
			sql`(
				(${t.mode} = 'interval' AND ${t.intervalWeeks} IS NOT NULL AND ${t.intervalWeeks} >= 1 AND ${t.anchorDate} IS NOT NULL AND ${t.ordinals} IS NULL)
				OR
				(${t.mode} = 'monthly' AND ${t.ordinals} IS NOT NULL AND cardinality(${t.ordinals}) >= 1 AND ${t.intervalWeeks} IS NULL AND ${t.anchorDate} IS NULL)
			)`,
		),
		// weekday in [0,6] and keep_ahead in [1,52] (MAX_BATCH).
		check(
			"club_meeting_recurrence_bounds_check",
			sql`${t.weekday} >= 0 AND ${t.weekday} <= 6 AND ${t.keepAhead} >= 1 AND ${t.keepAhead} <= 52`,
		),
	],
);

// ---------------------------------------------------------------------------
// Club logo (#495) — the club-uploaded image shown on the printed agenda.
// Deliberately a SEPARATE 1:1 table, NOT columns on `clubs`: ~35 call sites
// read a club row with `SELECT *`/no column list (including the authorization
// path in `guards.ts`), and a 256 KB `bytea` on `clubs` would be dragged
// through every one of them for a feature that renders on a single page.
// `club_meeting_recurrence` above is the repo's existing precedent for 1:1
// club data that is not a simple scalar.
//
// PK is `club_id` itself (not a synthetic id) — a club has at most one logo,
// and the PK enforces that without a separate unique index; it also makes
// `onConflictDoUpdate` on the PK a natural upsert for "replace or insert".
//
// Every column is NOT NULL, deliberately: a partial write (bytes with no
// `updated_at`) would produce a URL with no version, and the serving route
// caches on that version, so the image would be pinned in every client's
// cache with no way to bust it. (That route answered `Cache-Control: immutable`
// until #517, which is what made the hazard a year long; it is now a bounded
// `max-age` plus an ETag, so the shape survives but the blast radius does not.)
// `onDelete: "cascade"` — deleting a club takes its logo with it.
//
// `attested_by` / `attested_at` record who confirmed the club is authorized
// to use the uploaded image (ADR-0024 trademark posture) — persisted, not
// merely shown at upload time.
//
// `attested_by` has NO `onDelete` clause, so Postgres defaults to `NO ACTION`
// and deleting a user who ever attested a logo fails outright with
// `club_logos_attested_by_user_id_fk`. That is INERT today and deliberately
// left alone (#504 item 3, explicitly out of scope): `db.delete(user)` appears
// nowhere in this repo, and `sync_tokens.created_by` has the identical shape,
// so this matches precedent rather than introducing a pattern.
//
// It becomes real the day account deletion ships — Better-Auth's `deleteUser`
// plugin, a GDPR self-serve delete, or an admin remove-user action — as an
// unhandled FK violation with no code path to resolve it. Whoever ships that
// decides between nulling the attestation, reassigning it, and blocking the
// delete, and the decision is ADR-0024's to make: the attestation is an audit
// record of who accepted trademark responsibility, so nulling it silently is
// not obviously the kind option. Recorded HERE rather than left in #504,
// because that issue closes with the PR that consolidated the limits and this
// note would have gone with it.
//
// The header-build read path (agenda print SSR) must select only `club_id`
// and `updated_at` — never `bytes` — see `loadClubLogoMeta` in
// `src/server/club-logo-logic.ts`.
// ---------------------------------------------------------------------------

export const clubLogos = pgTable("club_logos", {
	clubId: uuid("club_id")
		.primaryKey()
		.references(() => clubs.id, { onDelete: "cascade" }),
	bytes: bytea("bytes").notNull(),
	mime: text("mime").notNull(), // "image/png" | "image/jpeg" only
	updatedAt: timestamp("updated_at").notNull(), // cache-buster source for ?v=
	attestedBy: text("attested_by")
		.notNull()
		.references(() => user.id),
	attestedAt: timestamp("attested_at").notNull(),
});

// ---------------------------------------------------------------------------
// People — one row per human, above per-club membership (ADR-0008 / #64).
// Holds the facts identical across every club a person belongs to. Keyed by
// Toastmasters Customer ID (PN-…) when known, unique-when-present (nullable);
// email is the fallback dedupe key. Pathways paths are Person-level too but are
// NOT modeled here (out of scope).
// ---------------------------------------------------------------------------

export const people = pgTable(
	"people",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// Toastmasters Customer ID (PN-…). Nullable; Postgres treats NULLs as
		// distinct, so the unique constraint is "unique-when-present".
		customerId: text("customer_id").unique(),
		// Durable Base Camp/edX user id (from /api/bcm/progress `user.id`), captured on
		// first email match and used as the join key for Pathways sync thereafter.
		// Nullable + unique-when-present (Postgres treats NULLs as distinct).
		basecampUserId: text("basecamp_user_id").unique(),
		name: text("name").notNull(),
		// What this person is actually CALLED, when it isn't the first token of
		// `name` (#486). The Toastmasters export carries one full-name string, so
		// a member stored as "Abdul-Rasheed Bustamam" who goes by Rasheed — or as
		// Robert but called Bob — cannot be greeted correctly by splitting. Null
		// means nobody has told us; `greetingName` (#/lib/person-name) then falls
		// back to the first token.
		//
		// The FALLBACK, not the source of truth: a membership's own value wins
		// (see `members.preferred_name`). This row is what a second club reads
		// when its membership has none, which is how the name follows the human
		// across clubs (ADR-0008). Written only by seeding UP from a membership
		// edit (guarded on NULL, so one club can't overwrite another's) and by
		// merge/convert; read via COALESCE in `meeting-contacts-logic.ts`.
		preferredName: text("preferred_name"),
		// The VERIFIED identity address, plus the person-level dedupe key (#756).
		// Two things it is NOT, both of which it used to be:
		//  - it is NOT what binds an account. `linkPersonToUser` and
		//    `claimPersonForUser` match `members.email` — the club's own contact
		//    record — under a UNANIMITY rule across the clubs that hold the Person.
		//    A club-scoped actor typing an address can therefore no longer decide
		//    who a Person becomes, which is what made a typo a lockout and every
		//    writer of this column a cross-club takeover.
		//  - it is NOT club-editable. One thing a CLUB can reach UPDATEs it: the
		//    bind, which reads the address off the `user` row ITSELF (a caller
		//    cannot hand it one) and sets `user_id` in the same statement
		//    (`account-link-logic.ts`). Three superadmin/operator waivers are named
		//    in `person-email-writers.guard.test.ts` — "exactly one" would be the
		//    kind of false-completeness claim this comment warns about below.
		// It IS still written at INSERT, by the CSV importer, the guest-book
		// conversion, the bulk paste and the create-club form, because a brand-new
		// Person row is nobody's identity yet and this is the fallback dedupe key
		// ADR-0008 leans on for "one human, one Person".
		//
		// So the invariant is NARROWER than "every value here is verified", and
		// stating it the loose way would be the false-completeness claim this repo
		// has already been burned by: non-null on a LINKED Person means verified;
		// on an unlinked one it is a typed hint. Nothing binds from it either way,
		// which is the property that actually matters.
		email: text("email"),
		phone: text("phone"),
		// First-ever Toastmasters join date — a person-level fact (identical across
		// every club), moved off the per-club members row (ADR-0008).
		originalJoinDate: timestamp("original_join_date"),
		// The canonical link to a Better-Auth sign-in account (one login spans all
		// their clubs). The auth path resolves a signed-in user to this Person, then
		// to their per-club memberships and roles (ADR-0008 Phase B / #99).
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
		// Account-invite tracking (#266). Stamped when an admin sends this person a
		// magic-link account invite (or a self-claim link is initiated) that will link
		// them on acceptance. Person-level (one human, all clubs) like `user_id`.
		// Drives the roster's per-row invite state: `invited_at` set + `user_id` NULL =
		// "invited, not joined"; `user_id` set = "joined" (supersedes the invite).
		// Never cleared — a linked account (`user_id`) makes it moot.
		invitedAt: timestamp("invited_at"),
		// Reminder-email opt-out (#274 — the reminders control layer, member level).
		// Keyed per Person, so it governs this human's inbox GLOBALLY across every club
		// they belong to (a reminder is a self-regarding nudge about a role they
		// claimed — one preference per person, not per membership). Default false =
		// opted IN: members receive reminders unless they turn them off (the product
		// decision, matching #272). Flipped from /me (member settings) or the no-auth
		// one-click /unsubscribe link every reminder email carries.
		reminderOptOut: boolean("reminder_opt_out").notNull().default(false),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// Postgres does NOT auto-index a foreign-key referencing column, and
		// EVERY signed-in-user resolution starts from `where(eq(people.userId, …))`
		// — resolveUserPersonId, userPersonIds, userMemberIds (#437) and
		// getReminderOptOutForUser, the last two on the /dashboard and /me SSR
		// loaders. Without this each was a sequential scan of a table that grows
		// with total app adoption rather than with one club's size. #437 also
		// (correctly) dropped a `.limit(1)` that had been letting the executor
		// abort that scan early, which made the index load-bearing rather than
		// merely nice. #474.
		index("people_user_idx").on(t.userId),
	],
);

// ---------------------------------------------------------------------------
// What migration 0076 cleared out of `people.email` (#756).
//
// TEMPORARY, and meant to be dropped. Inverting the ownership of that column
// made every value written before the change un-trustworthy as an identity —
// nobody had proved they owned any of them — so the migration nulls the ones on
// un-claimed Persons. This table is the undo: the rollback plan is `revert the
// PR` plus one UPDATE joining back through it, and it exists because a data
// migration you cannot reverse is one you cannot deploy on a Friday.
//
// Drop it (schema + a migration) once a release has passed without incident.
// Deliberately NOT a general audit trail: it holds one snapshot, from one
// migration, and nothing writes to it at runtime.
// ---------------------------------------------------------------------------

export const peopleEmailBackup = pgTable("people_email_backup", {
	// **Deliberately NOT a foreign key.** An `ON DELETE cascade` reference to
	// `people` would let ordinary app activity destroy the undo: `mergePeople`
	// DELETEs the absorbed Person, so a superadmin merging any of the cleared
	// rows between the migration and a rollback would silently remove that
	// human's only surviving copy of their pre-migration address, and nothing
	// would report it. A snapshot does not need referential integrity to the row
	// it is a snapshot of — a dangling id here is exactly as useful as a live
	// one, and outliving the row is the point.
	personId: uuid("person_id").primaryKey(),
	email: text("email").notNull(),
	capturedAt: timestamp("captured_at").defaultNow().notNull(),
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
		// AUTHORITATIVE for this club (#486), denormalized like `name`/`email`/
		// `phone`. Null does NOT mean "no name recorded" — the read falls back to
		// `people.preferred_name` (COALESCE in `meeting-contacts-logic.ts`), which
		// is what lets a member who set it in another club be greeted correctly
		// here. Replication is one-way and one-shot: a membership edit seeds the
		// Person when the Person has none. Nothing ever copies Person → membership.
		preferredName: text("preferred_name"),
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
		// One membership per person per club (#489). Several paths assert this in
		// a doc comment and enforce it with a bare SELECT-then-INSERT under READ
		// COMMITTED — two concurrent converts (or two overlapping CSV imports, which
		// don't even share a transaction) both read "no membership", both insert,
		// and the club gets two roster rows for one human. That is the duplicate
		// class #329 built `mergePeople`/`collapseMemberships` to unpick by hand.
		//
		// Also load-bearing for `mergePeople`: its `keeperByClub` map is built once
		// before the re-point loop, so an absorbed Person holding two memberships in
		// one club would re-point BOTH onto the keeper. This constraint makes that
		// precondition unreachable rather than merely unlikely.
		//
		// NOT created CONCURRENTLY: drizzle wraps the whole migration run in one
		// transaction (`pg-core/dialect.ts`) and Postgres rejects CONCURRENTLY
		// inside a transaction block — and `scripts/migrate.ts` exits non-zero from
		// the Dockerfile CMD, so that would fail the deploy closed.
		//
		// What makes that acceptable is the table SIZE, so state it: a plain build
		// holds a SHARE lock that blocks every write to `members` for its duration,
		// and on Railway the old container still serves traffic while the new one
		// runs the migration. At the current few-dozen rows that is sub-millisecond.
		// At six figures it would be a visible roster write-stall, and the index
		// would have to be built CONCURRENTLY outside the drizzle migrator instead.
		uniqueIndex("members_club_person_unique").on(t.clubId, t.personId),
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
// Distinguished Club Program (DCP) — the President's goal scoreboard
// (#207 / ADR-0019). A per-club, per-program-year MANUAL scoreboard of the 10
// standardized DCP goals. The goal *catalog* (labels + targets) is static code
// (src/lib/dcp.ts); only per-club PROGRESS is stored. `dcp_scoreboards` is the
// parent per (club, program_year); `dcp_goal_progress` holds one hand-entered
// `achieved` value per catalog goal (met = achieved ≥ target). Recognition tier
// and the membership base are DERIVED, never stored. Education-goal
// auto-derivation from Pathways is deferred (#245).
// ---------------------------------------------------------------------------

export const dcpScoreboards = pgTable(
	"dcp_scoreboards",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// Program year identified by its STARTING calendar year (Jul 1 – Jun 30):
		// e.g. 2026 = Jul 1 2026 – Jun 30 2027. See src/lib/dcp.ts.
		programYear: integer("program_year").notNull(),
		// Active-member count snapshotted when the scoreboard is first started, for
		// the DCP "net +5" membership-base test. Nullable (base can also be met by
		// ≥20 active); President-editable to correct a mid-year adoption.
		baseMemberCount: integer("base_member_count"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("dcp_scoreboards_club_year_unique").on(t.clubId, t.programYear),
	],
);

export const dcpGoalProgress = pgTable(
	"dcp_goal_progress",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		scoreboardId: uuid("scoreboard_id")
			.notNull()
			.references(() => dcpScoreboards.id, { onDelete: "cascade" }),
		// Matches a DCP_GOALS[].key in src/lib/dcp.ts (e.g. "g1".."g10"). Plain text,
		// not an enum, so the static catalog stays the single source of truth.
		goalKey: text("goal_key").notNull(),
		// Hand-entered count (0/1 for composite goals 9 & 10). met = achieved ≥ the
		// catalog target.
		achieved: integer("achieved").notNull().default(0),
		// Audit: the signed-in user who last edited this value (ADR-0019). Nullable —
		// seeded rows and roster-derived pre-fills have no editor until touched.
		updatedBy: text("updated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("dcp_goal_progress_scoreboard_goal_unique").on(
			t.scoreboardId,
			t.goalKey,
		),
	],
);

// ---------------------------------------------------------------------------
// Club Officer Training (COT) — the record behind DCP goal 9 (#531).
//
// ADR-0019 §3 stores goal 9 as a composite 0/1 in `dcp_goal_progress` with
// nothing behind it, which is why the scoreboard could never warn a club that a
// training window was about to shut: the toggle holds no information until
// someone already knows the answer. These two tables are that information. They
// do NOT change how goal 9 is stored or scored — they feed an editable
// SUGGESTION the President applies, the third assist beside the roster assist
// (goals 7/8) and the Pathways assist (goals 1–6, #245). Nothing here writes
// `dcp_goal_progress`; TI, not GavelUp, is the system of record for who was
// trained.
//
// `officer_training_periods` is the SPARSE window override. TI's own dates
// (Jun 1 – Aug 31, and Nov 1 – Feb 28/29) are the defaults and live in code
// (`src/lib/officer-training.ts`), so **row absent = TI's window** and a club
// gets a correct countdown with zero configuration. A row exists only where an
// admin edited the dates because their district deviated. Scoped to
// (club, program_year) rather than to `dcp_scoreboards.id` deliberately: the
// windows must be readable before a club has started a scoreboard, which is
// exactly when the "you have two of four and three weeks left" reading is worth
// having.
//
// `officer_training_records` is one row per (membership, office, program_year,
// period) — the club's claim that this person was trained for this office in
// this window. Keyed on the MEMBERSHIP and the office rather than on an
// `officer_terms.id`, because a term row closes and reopens on re-election while
// the training credit does not: a record must survive its officer's term ending
// mid-window (the club was credited; the person left the office afterward).
//
// Two constraints from TI's manual that are deliberately NOT modelled, recorded
// here so a future change does not have to rediscover them. (1) Credit requires
// a LIVE session with an authorized District representative — "club officers who
// only view a video that describes their responsibilities are not considered
// trained" — so if a `how` column is ever added, video-only is not a valid
// value. (2) Newly chartered clubs have a different requirements table keyed on
// charter date; out of scope for v1, and nothing above forecloses it.
// ---------------------------------------------------------------------------

export const officerTrainingPeriods = pgTable(
	"officer_training_periods",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// Program year identified by its STARTING calendar year, matching
		// `dcp_scoreboards.program_year`. See src/lib/dcp.ts.
		programYear: integer("program_year").notNull(),
		// 1 or 2 — TI runs exactly two periods per program year. A plain integer,
		// not an enum, so the natural ordering IS the chronological one. The CHECK
		// is the only thing that can stop a third period being written by a raw
		// `sql` template, which typecheck cannot see.
		period: integer("period").notNull(),
		// Inclusive calendar bounds. `mode: "string"` (`YYYY-MM-DD`) rather than a
		// Date: a window bound is a calendar day with no instant attached, and a
		// Date at local midnight becomes a UTC instant that shifts the day for half
		// the world on the way to the client.
		startsOn: date("starts_on", { mode: "string" }).notNull(),
		endsOn: date("ends_on", { mode: "string" }).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("officer_training_periods_club_year_period_unique").on(
			t.clubId,
			t.programYear,
			t.period,
		),
		check("officer_training_periods_period_check", sql`${t.period} in (1, 2)`),
		// A window that ends before it starts would make every countdown negative
		// and `windowPhase` report "closed" forever. The seam validates it too; this
		// is the copy a raw SQL write cannot bypass.
		check(
			"officer_training_periods_order_check",
			sql`${t.endsOn} >= ${t.startsOn}`,
		),
	],
);

export const officerTrainingRecords = pgTable(
	"officer_training_records",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// The club is reached through `members.club_id` (as `officer_terms` does),
		// not duplicated here — a second copy is a second thing that can disagree.
		// The cascade from `clubs` → `members` → here is what makes a takedown and
		// the test cleanup reach these rows.
		membershipId: uuid("membership_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		// The office the club claims this person was trained FOR. TI: "Officers
		// must be trained for the position to which they were elected."
		// `immediate_past_president` is storable but counts for nothing — it is not
		// one of TI's seven (see TRAINABLE_OFFICER_POSITIONS); the seam rejects it
		// on the way in.
		position: officerPositionEnum("position").notNull(),
		programYear: integer("program_year").notNull(),
		period: integer("period").notNull(),
		// The day they were trained, when the club knows it. NULLABLE on purpose:
		// a club frequently knows an officer attended without knowing the date, and
		// a NOT NULL column here would need a sentinel — which is the shape that
		// silently defeated an is-it-filled predicate on `speeches.title`. The
		// score never reads this column; the view compares it against the period's
		// window and flags a mismatch (`isOutsideWindow`) rather than voiding the
		// claim.
		trainedOn: date("trained_on", { mode: "string" }),
		// Audit: who recorded it. Nullable — an import or a later backfill has no
		// editor. Mirrors `dcp_goal_progress.updated_by`.
		recordedBy: text("recorded_by").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		// One claim per person, office, year and period — a double-entry must not
		// be able to inflate the count. (It could not inflate the DISTINCT-PEOPLE
		// count anyway, which is the point: the constraint is here so the RECORD
		// list the club reads has no duplicate rows either.)
		uniqueIndex("officer_training_records_unique").on(
			t.membershipId,
			t.position,
			t.programYear,
			t.period,
		),
		// NO separate (membership_id, program_year) index. The unique index above
		// already leads on `membership_id`, which is how both readers reach these
		// rows (a nested loop from `members` on `club_id`), and Postgres applies
		// `program_year` as a non-contiguous qual on the SAME index — verified by
		// EXPLAIN with the extra index dropped inside a transaction: identical
		// plan, identical two-column `Index Cond`, cost 8.17 vs 8.19. A membership
		// holds at most 7 offices x 2 periods = 14 rows per year, so there is no
		// cardinality at which the two diverge, and the second index would cost a
		// write on every upsert to filter a 14-row scan.
		check("officer_training_records_period_check", sql`${t.period} in (1, 2)`),
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
		// A guest has no Person, so their "goes by" name lives here (#486). Guests
		// hold role slots and get nudged like anyone else.
		preferredName: text("preferred_name"),
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
		// This one meeting runs no digital vote (#770), whatever the club does.
		// Off-ONLY by design: a club with `digital_voting_enabled = false` stays
		// off here even when this is false. See `isDigitalVotingOn`.
		digitalVotingDisabled: boolean("digital_voting_disabled")
			.notNull()
			.default(false),
		location: text("location"),
		// The video-call join link for an online or hybrid club (#731). Named
		// `join_url` rather than `zoom_url`: the value is a join link and the
		// vendor is not the app's business, and `speeches.presentation_url` beside
		// it sets the naming shape. Every write normalizes through
		// `normalizePresentationUrl`, so a stored value is always an http(s) URL
		// with a dotted host — never "tbd", never `javascript:`.
		//
		// Deliberately WITHHELD from /print, /present, /word and the .pptx export.
		// A join URL is not private data, it is a key to the door: anyone holding
		// it can walk into the meeting and there is no revocation short of a new
		// room. Those four are in-room artifacts that get projected, printed and
		// shared onward, and nobody types a URL off a projector anyway.
		//
		// The withholding is a PAYLOAD rule, not a render-side one (#754): the
		// shared `loadMeetingDetail` carries every column of this row to every
		// consumer, and a route loader that returns `{ ...data }` dehydrates it
		// into the served document whether or not a component draws it. So the
		// three artifact route loaders narrow the row through
		// `IN_ROOM_MEETING_FIELDS` (`#/lib/in-room-meeting-payload`), which is an
		// ALLOWLIST — **a column added below reaches no in-room artifact until
		// someone adds it there on purpose**, which is the property #731's
		// render-side rule and its source grep did not have.
		// `src/routes/join-url-not-on-print-surfaces.guard.test.ts` holds both
		// halves: the built payload, and the modules that draw these surfaces.
		joinUrl: text("join_url"),
		theme: text("theme"),
		wordOfTheDay: text("word_of_the_day"),
		// Word-of-the-Day supporting copy for the projected present-mode deck.
		wodDefinition: text("wod_definition"),
		wodExample: text("wod_example"),
		status: meetingStatusEnum("status").notNull().default("scheduled"),
		// The club's own meeting number ("Meeting #56"), #358. NULL = provisional:
		// the number is DERIVED for display by counting held meetings forward from
		// the most recent numbered one (see src/lib/meeting-number.ts) and only
		// FROZEN into this column when the meeting is completed, or when a human
		// types one. Deliberately not stamped at insert — the #190 top-up creates
		// meetings in batches, so a later cancellation would invalidate every
		// stored number after it.
		meetingNumber: integer("meeting_number"),
		// The meeting template this meeting's shape comes from (#agenda-templates).
		// NULL — the overwhelming majority — is the standard meeting and reads the
		// code-derived RUN_OF_SHOW exactly as before templates existed. A templated
		// meeting draws its slots from the template's materialized role definitions
		// and its agenda rows from `meeting_template_beats`.
		//
		// ON DELETE RESTRICT so a template a past meeting was run from can never be
		// deleted; disable it instead (`meeting_templates.enabled`).
		templateId: uuid("template_id").references(
			(): AnyPgColumn => meetingTemplates.id,
			{ onDelete: "restrict" },
		),
		notes: text("notes"),
		// Free-text club announcements (one per line), shown on the meeting
		// agenda, the printable agenda, and the present-mode Announcements slide.
		// Edited via the "Edit meeting" dialog. Distinct from `notes` (private
		// organizer scratch). Column stays named `reminders` for history.
		reminders: text("reminders"),
		// Free-text Table Topics notes (#880): the Table Topics Master's topic
		// categories or prompts, one per line, shown on the projected Table Topics
		// slide and in the .pptx export. Edited in the "Edit meeting" dialog and by
		// the meeting's own Table Topics Master through their personal editor.
		// NULL / blank = the slide renders exactly as it did before this column.
		tableTopicsNotes: text("table_topics_notes"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// Unique per (club, instant): two meetings at the same instant in one club
		// is never legitimate, and this doubles as the concurrency backstop for the
		// #190 read-triggered top-up (deterministic occurrences ⇒ ON CONFLICT DO
		// NOTHING). Also serves the club+scheduled lookups the plain index did.
		uniqueIndex("meetings_club_scheduled_unique").on(t.clubId, t.scheduledAt),
		// One meeting number per club (#358). PARTIAL — the vast majority of rows
		// carry NULL (provisional/derived) and NULLs must not collide. Catches a
		// double-assignment (two meetings frozen as #57) at the database.
		uniqueIndex("meetings_club_number_unique")
			.on(t.clubId, t.meetingNumber)
			.where(sql`${t.meetingNumber} is not null`),
	],
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
		// The role's slots have no meaningful order (#624). A contest's speaking
		// order is drawn by lot at the briefing, so a contestant's `slot_index` is
		// sign-up order wearing a rank: `slotLabel` (src/lib/agenda.ts) prints the
		// bare role name and the printed roster collapses the role into ONE entry
		// naming every holder. Copied from `meeting_template_roles` at
		// materialization, like every other column here; false for every standard
		// role, where "Speaker 2" is a real position on the agenda.
		slotsUnordered: boolean("slots_unordered").notNull().default(false),
		// Human-readable responsibilities, shown before claiming + on the shared link.
		description: text("description"),
		// Whether new meetings generate slots for this role (#368). A "skeleton
		// crew" club can turn OFF roles it doesn't run (e.g. Ah-Counter, Vote
		// Counter) without deleting the definition — delete is unavailable once any
		// meeting has used the role (`role_slots.role_definition_id` is ON DELETE
		// RESTRICT), so disabling is the only way to retire a role going forward
		// while keeping its slot history intact. Read by `generateSlotRows`
		// (src/lib/agenda.ts); existing meetings' already-generated slots are
		// untouched. Default true — every seeded/custom role starts active.
		enabled: boolean("enabled").notNull().default(true),
		// Is this role part of the club's STANDARD meeting shape? (#801)
		//
		// The third column of a three-way split, and the reason it is not folded
		// onto `enabled`. `meeting_template_roles` is the DECLARATION (which roles
		// a shape uses, how many places, in what order); this table is IDENTITY
		// plus the club's standing defaults; and `standing` is the question
		// `template_id` used to answer as a side effect of tagging identity — "keep
		// this off ordinary meetings".
		//
		// `enabled` keeps its exact #368 meaning (the skeleton-crew switch) and is
		// NOT a substitute: a contest role promoted at `enabled = false` would
		// generate zero Contestant slots on the contest itself, and would list in
		// /admin/roles as merely switched off, where enabling it routes through
		// `syncSlotsForRoleEnabledChange` and puts an open Chief Judge on every
		// upcoming meeting — the exact leak `template-role-leak.integration.test.ts`
		// exists to prevent.
		//
		// GATES SLOT AUTO-GENERATION AND NOTHING ELSE. `generateSlotRows`
		// (src/lib/agenda.ts) filters `standing AND enabled`; so do the two
		// backfills in `slots-logic.ts`. No LISTING filters on it — /admin/roles,
		// the public role sheet and the meeting page's "+ Add role" picker all show
		// the whole bank, because a role an officer added from an agenda has to be
		// manageable and attachable the moment it exists.
		standing: boolean("standing").notNull().default(true),
		// Stable, immutable identity for one of the 9 standard roles (ROLE_TEMPLATE,
		// src/lib/role-template.ts), independent of the human-editable `name` a club
		// can rename via updateClubRole. Agenda beats BIND by this key (#368,
		// `matchesRole`) so a rename never breaks the binding, and every surface
		// LABELS with the club's `name` — including every row of the printed run
		// sheet since #445. NULL for a club-invented custom role, which has no
		// canonical identity to key on; those bind by name instead.
		key: text("key"),
		// DEAD as of #801, and kept only so a code-only revert fails loudly.
		//
		// It used to tag a role definition with the meeting template that owned
		// it, which made "the same conceptual role" a DIFFERENT row per template:
		// every conversion minted a second Timer, and `role_slots
		// .role_definition_id` — what every history query joins on — pointed at
		// whichever fork happened to exist, so a hand-added functionary carried no
		// history and the season grid printed "Timer 1" / "Timer 2". Identity now
		// lives once per (club, key) in this table; a shape's role LIST lives in
		// `meeting_template_roles`; and "keep this off ordinary meetings" lives in
		// `standing` above.
		//
		// The CHECK below pins it NULL for every row. Dropping the column is a
		// follow-up once the constraint has held across a few deploys; until then
		// a revert that tries to fork again fails at the database instead of
		// silently re-forking.
		templateId: uuid("template_id").references(
			(): AnyPgColumn => meetingTemplates.id,
			{ onDelete: "restrict" },
		),
	},
	(t) => [
		index("role_definitions_club_idx").on(t.clubId),
		// `role_definitions_club_template_idx` (on (club_id, template_id)) is
		// dropped alongside it, by the same argument: with `template_id` pinned
		// NULL its second column is constant, so it indexes exactly what
		// `role_definitions_club_idx` above already indexes and costs a write on
		// every role change to do it.
		//
		// ONE partial index now, not two. `role_definitions_club_template_key_unique`
		// (on (club_id, template_id, key) where template_id is not null) is dropped
		// by 0083: with every row's `template_id` NULL its predicate matches
		// nothing, and leaving a dead index beside a live one invites the next
		// reader to believe per-template identity still exists.
		//
		// This one's predicate is deliberately UNCHANGED. It already reads
		// `key is not null and template_id is null`, which under the new invariant
		// is exactly one row per (club_id, key) — the constraint #801 binds on.
		// CLAUDE.md records that `db:push` silently ignores a changed predicate on
		// an existing partial index; not touching it avoids that trap entirely.
		uniqueIndex("role_definitions_club_key_unique")
			.on(t.clubId, t.key)
			.where(sql`${t.key} is not null and ${t.templateId} is null`),
		// The invariant #801 establishes, stated at the database. A code-only
		// revert then fails on its first attempted fork rather than quietly
		// re-splitting a club's role identities.
		check("role_definitions_template_id_null", sql`${t.templateId} is null`),
	],
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
// Meeting templates — a named bundle of a role set plus a run-of-show, for a
// meeting whose SHAPE differs from the club's standard night (a speech
// contest). `meetings.template_id` NULL is the standard meeting and runs the
// code-derived `RUN_OF_SHOW` (src/lib/agenda-runsheet.ts) exactly as before;
// only a templated meeting reads these tables.
// See docs/superpowers/specs/2026-08-19-agenda-templates-design.md.
// ---------------------------------------------------------------------------

export const meetingTemplates = pgTable(
	"meeting_templates",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// NULL = a GLOBAL template available to every club. Non-null = owned by
		// that club (Phase 2 — nothing writes club-scoped rows yet, but the reads
		// already admit them so Phase 2 needs no migration).
		clubId: uuid("club_id").references(() => clubs.id, {
			onDelete: "cascade",
		}),
		// Non-null = this row is ONE MEETING's private copy, not a template
		// anyone picks. Conversion deep-copies the chosen template into a row
		// like this so editing one night's agenda never touches another's.
		//
		// The CASCADE here does NOT, on its own, make a private copy disposable,
		// and reading it as if it does is wrong. Every conversion materializes
		// `role_definitions` against the copy, and THAT foreign key is ON DELETE
		// RESTRICT — so deleting a meeting whose private copy has any
		// materialized role aborts the whole delete with
		// `violates foreign key constraint
		// "role_definitions_template_id_meeting_templates_id_fk"`. The cascade
		// can only fire for a copy that has no roles at all, which no real
		// conversion produces.
		//
		// What actually protects meeting deletion today is the DELETER, not this
		// column: the one production path that removes meetings
		// (`recurrence-rule-logic.ts`, pruning pristine recurrence rows) skips
		// any meeting with `m.templateId !== null`, so it never reaches a
		// templated meeting in the first place. Nothing else deletes meetings.
		// A new deleter must retire the copy's `role_definitions` first —
		// `applyTemplateConversion`'s own retire step is the worked example.
		// Whether the FK should be CASCADE instead is an open question, tracked
		// in TODOS.md under "Agenda templates"; it is not a late change to make
		// on a shipping branch.
		meetingId: uuid("meeting_id").references(() => meetings.id, {
			onDelete: "cascade",
		}),
		// Stable identity, e.g. "speech_contest" — what the seed is idempotent on.
		key: text("key").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		// Applied to `meetings.length_minutes` on conversion when set; NULL leaves
		// the meeting's existing length alone.
		defaultLengthMinutes: integer("default_length_minutes"),
		sortOrder: integer("sort_order").notNull().default(0),
		// Disable, never delete — a past meeting references its template and
		// `meetings.template_id` is ON DELETE RESTRICT. Mirrors the same
		// disable-not-delete rule `role_definitions.enabled` exists for.
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// TWO partial indexes rather than one on (club_id, key): Postgres treats
		// NULLs as distinct, so a single index would let two GLOBAL templates share
		// a key. Same reasoning as the role_definitions pair above.
		uniqueIndex("meeting_templates_global_key_unique")
			.on(t.key)
			.where(sql`${t.clubId} is null`),
		// Predicate excludes private copies: two contest meetings in one club
		// both copy `speech_contest`, and without `meeting_id is null` the second
		// conversion would fail on this index.
		uniqueIndex("meeting_templates_club_key_unique")
			.on(t.clubId, t.key)
			.where(sql`${t.clubId} is not null and ${t.meetingId} is null`),
		// One private template per meeting, enforced at the database rather than
		// by the one code path that currently creates them.
		uniqueIndex("meeting_templates_meeting_unique")
			.on(t.meetingId)
			.where(sql`${t.meetingId} is not null`),
	],
);

// The template's own role set. Deliberately the same shape as `RoleSeed`
// (src/lib/role-template.ts) so materializing into `role_definitions` is a
// field-for-field copy.
export const meetingTemplateRoles = pgTable(
	"meeting_template_roles",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		templateId: uuid("template_id")
			.notNull()
			.references(() => meetingTemplates.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		category: roleCategoryEnum("category").notNull(),
		defaultCount: integer("default_count").notNull().default(1),
		sortOrder: integer("sort_order").notNull().default(0),
		isSpeakerRole: boolean("is_speaker_role").notNull().default(false),
		// See `role_definitions.slots_unordered` (#624); this is the template's
		// declaration, copied onto the club's definition when the role is
		// materialized. The seeded contest sets it on `contestant_prepared` only.
		slotsUnordered: boolean("slots_unordered").notNull().default(false),
		description: text("description"),
	},
	(t) => [
		uniqueIndex("meeting_template_roles_key_unique").on(t.templateId, t.key),
	],
);

// The template's FLAT run-of-show. No `requiresAnyOf` / `requiresGroup` /
// `fallbacks` — a contest's shape is fixed by the contest rules and does not
// adapt to which roles a club runs, which is the whole reason the standard
// run-of-show needs those gates and this does not (spec D1).
export const meetingTemplateBeats = pgTable(
	"meeting_template_beats",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		templateId: uuid("template_id")
			.notNull()
			.references(() => meetingTemplates.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull(),
		kind: templateBeatKindEnum("kind").notNull(),
		// The activity ("Contest Briefing") or, for kind='section', the band title.
		label: text("label").notNull(),
		detail: text("detail"),
		minutes: integer("minutes").notNull().default(0),
		// Binds to `meeting_template_roles.key` — whose holder presents this beat.
		// NULL for an event or section beat nobody owns.
		roleKey: text("role_key"),
		// Consecutive beats sharing a non-null value form ONE block emitted once
		// per slot of that role, each iteration bound to exactly one slot — so a
		// contest agenda is right for however many contestants actually signed up
		// rather than for the number someone typed when the template was authored
		// (spec D4).
		repeatsRoleKey: text("repeats_role_key"),
		// The single squishy beat, if the template has one. At most one per
		// template — validated on write, not enforced by the database.
		flex: boolean("flex").notNull().default(false),
		/** Renders as the indented "X introduces Y" elbow and gets its own slide in
		 *  the projected deck. Carried so an adopted standard agenda keeps the 4
		 *  hand-offs the code path emits (5 on the GE variant) — without this,
		 *  adoption silently drops them from both surfaces. Spec D8. */
		handoff: boolean("handoff").notNull().default(false),
		// Timer-card marks in minutes, all three or none. `real`, not `numeric`:
		// drizzle's `numeric` returns a STRING unless a mode flag converts it, and
		// this schema uses `numeric` nowhere. Marks need fractions (the evaluation
		// window is 2 / 2.5 / 3), so `integer` will not do, and float imprecision
		// is irrelevant against a card a human holds up.
		markGreen: real("mark_green"),
		markYellow: real("mark_yellow"),
		markRed: real("mark_red"),
		/**
		 * Whether the CLUB owns this row's three marks (#683).
		 *
		 * Exactly one thing today: the club's Table Topics window
		 * (`clubs.table_topics_*_seconds`) governs this row, so
		 * `refreshTableTopicsMarks` re-derives its marks at every render and the
		 * agenda editor offers the officer a read-only window instead of three
		 * inputs whose value the next render would discard.
		 *
		 * STORED rather than inferred, and that is the whole point of the column.
		 * #679 decided the question by predicate — role key plus all three marks
		 * present — over the row's CURRENT contents, which are exactly what the
		 * officer edits. The run of show gives THREE beats `table_topics_master`
		 * (the segment, the Best Table Topics vote, the GE hand-off), so setting
		 * timer marks on the vote row made it start matching: the refresh pass
		 * overwrote its marks with the club's speaking window and the editor
		 * locked its fields, on a row the officer was not editing, with
		 * delete-and-re-add the only way back. Every inferred property has that
		 * shape — #682 had already removed `flex` from the predicate for the
		 * mirror of it — because the inputs themselves are what the officer
		 * controls. A stored marker is the only kind of answer an edit cannot
		 * accidentally change.
		 *
		 * Written by `materialiseRunOfShow` on the one beat that declares the
		 * club's window, and by the agenda editor's own un-govern / re-govern
		 * control. NOT NULL with a `false` default, so every other writer —
		 * `addAgendaRow`'s placeholder, a contest seed, a template copy — mints an
		 * ungoverned row without naming the column. The one-time backfill in the
		 * migration marks the pre-existing materialised rows, one per template.
		 */
		clubGoverned: boolean("club_governed").notNull().default(false),
	},
	(t) => [
		uniqueIndex("meeting_template_beats_order_unique").on(
			t.templateId,
			t.sortOrder,
		),
		// AT MOST ONE governed row per template, and a template is private to one
		// meeting — so per-meeting (#683).
		//
		// In the database because three separate writers have to hold it and two of
		// them held it only by construction: `materialiseRunOfShow` picks one beat
		// with `findIndex`, the migration's backfill picks one with `DISTINCT ON`,
		// and the agenda editor's re-govern button can be clicked on any of the
		// THREE beats the run of show gives `table_topics_master`. Two governed rows
		// is not a cosmetic duplicate: `refreshTableTopicsMarks` is a `.map`, so
		// both rows have their marks overwritten with the club's speaking window at
		// every render, permanently, and the second one is a row the officer set
		// deliberately.
		//
		// PARTIAL, on `club_governed` alone: the ungoverned rows are the overwhelming
		// majority and must not collide with each other. `assertGovernable` refuses
		// the same write with a sentence first — this is the floor under it, not the
		// message.
		uniqueIndex("meeting_template_beats_club_governed_unique")
			.on(t.templateId)
			.where(sql`${t.clubGoverned}`),
	],
);

// ---------------------------------------------------------------------------
// Planned attendance — one row per (member, meeting) carrying where the outreach
// got to. It SUPERSEDED, and this PR dropped, two single-boolean tables: one
// whose row meant "not available" and one whose row meant "contacted". They
// answered overlapping questions and could disagree, and neither could express
// "she replied, she's coming". `not_coming` is now the ONLY encoding of
// "unavailable", and the row's absence is the only encoding of "no answer" —
// the distinction the pair could not draw. Reach this table through
// `src/server/attendance-plan-logic.ts` and nowhere else, and
// `attendance-plan-store.guard.test.ts` fails on an inline query anywhere but
// the membership merge.
//
// What that seam owns is the actor attribution and the two status predicates
// (`demoteFrom` / `onlyFrom`) that stop one rung silently overwriting another.
// It does NOT own the archive gate or the officer-only `reached_out` rung —
// those need a session, so they live in the callers. Routing a new write through
// the seam therefore does not grant them; look at `attendance-plan.ts` for the
// shape a gated caller has.
// ---------------------------------------------------------------------------

export const meetingAttendancePlan = pgTable(
	"meeting_attendance_plan",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		status: attendancePlanStatusEnum("status").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		// Plain unique index (not a composite PK) so ON CONFLICT can infer it as
		// an arbiter for the upsert in `setPlanStatus`.
		uniqueIndex("meeting_attendance_plan_unique").on(t.memberId, t.meetingId),
		index("meeting_attendance_plan_meeting_idx").on(t.meetingId),
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
		/**
		 * The winner's name when they were a write-in (#582) — no member row, no
		 * guest row, just what a voter typed.
		 *
		 * The award table needs this and not only `meeting_votes`, because THIS is
		 * what the minutes, the emailed minutes, the minutes PDF and the printed
		 * awards beat all read. Without it a write-in could win a vote and have
		 * nowhere to be recorded, which is the objection that made option (b) a real
		 * decision rather than a formality.
		 */
		writeInName: text("write_in_name"),
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
			// Same widening and the same reason for `<= 1` rather than `= 1`:
			// `member_id` is `on delete set null` here too (#582).
			sql`num_nonnulls(${t.memberId}, ${t.guestId}, ${t.writeInName}) <= 1`,
		),
	],
);

/**
 * The times the Timer measured (#730) — the fourth child of the minutes record,
 * and the first one keyed on an agenda SLOT rather than on a person.
 *
 * One row per timed slot per meeting. #729 measures and throws away; this is
 * where the measurement lands, so the club can answer "did that speech qualify"
 * and "do our speakers habitually run over" from something other than a paper
 * slip that goes in the bin.
 *
 * Five decisions in this shape, each with a reason:
 *
 * - **SECONDS, integer.** `clubs.table_topics_min_seconds` already made this
 *   call and the comment on it records why. The MARKS are float minutes because
 *   2.5 is exactly representable and an admin types 2.5; a MEASUREMENT in float
 *   minutes invites `6.999999` and a report that reads 6:59 on one surface and
 *   7:00 on another.
 * - **The marks are COPIED onto the row.** A timing is a historical fact. An
 *   officer editing the agenda's min/max next month must not silently re-decide
 *   whether a past speech qualified, which is exactly what a row reading its
 *   marks live through `role_slots` would do. Same instinct as
 *   `officer_training_periods` being a sparse override rather than a live read.
 *   Nullable, because a beat can carry a partial or absent trio and the honest
 *   record of "measured against no window" is null.
 * - **`slot_id` NOT NULL and plainly unique.** No XOR, no nullable subject, no
 *   partial index: one timing per slot, enforced by the simplest constraint
 *   that says so. A timing with no subject is not a record of anything, and the
 *   plain (non-partial) unique index is also what `ON CONFLICT` can infer as an
 *   arbiter for the upsert — the same reason `meeting_attendance`'s two unique
 *   indexes are plain.
 * - **`granted_via` NOT NULL, and a pgEnum** — see that enum's own comment.
 * - **`recorded_by_member_id` is `set null` on member delete**, which has a
 *   consequence the overwrite floor has to STATE rather than discover: after a
 *   member is deleted a row can no longer prove whose it was. The floor treats
 *   NULL as "not the caller's own" and fails closed — a self-arm Timer may not
 *   overwrite a row whose recorder is unknown; an officer still can.
 *
 * Both FKs cascade: deleting a meeting takes its timings, and so does deleting
 * the slot they are about. A timing outliving its slot would name a subject
 * nothing can resolve.
 */
export const meetingTimings = pgTable(
	"meeting_timings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		/** The agenda row timed. NOT NULL — see the docblock. */
		slotId: uuid("slot_id")
			.notNull()
			.references(() => roleSlots.id, { onDelete: "cascade" }),
		/** Measured duration. SECONDS, integer. */
		elapsedSeconds: integer("elapsed_seconds").notNull(),
		/** The marks in force WHEN MEASURED, in minutes — byte-identical columns
		 *  to `meeting_template_beats`' own trio. */
		markGreen: real("mark_green"),
		markYellow: real("mark_yellow"),
		markRed: real("mark_red"),
		recordedByMemberId: uuid("recorded_by_member_id").references(
			() => members.id,
			{ onDelete: "set null" },
		),
		grantedVia: timingGrantedViaEnum("granted_via").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_timings_meeting_idx").on(t.meetingId),
		uniqueIndex("meeting_timings_slot_unique").on(t.slotId),
		// A negative duration is not a slow speech, it is a corrupt row — and the
		// write path takes a number off a public request, so the floor belongs in
		// the database as well as in the validator.
		check("meeting_timings_elapsed_nonneg", sql`${t.elapsedSeconds} >= 0`),
	],
);

// ---------------------------------------------------------------------------
// Digital voting (#510). A vote SESSION is the window for one award category on
// one meeting; a VOTE is one ballot cast into it. The winner does not live here
// — it lives in `meeting_awards`, which is already what the minutes, the minutes
// PDF and the printed awards beat read. The Ballot Counter confirms it there.
// ---------------------------------------------------------------------------

export const meetingVoteSessions = pgTable(
	"meeting_vote_sessions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		category: awardCategoryEnum("category").notNull(),
		openedAt: timestamp("opened_at").defaultNow().notNull(),
		// NULL means OPEN. Re-opening a closed vote sets this back to null on the
		// same row rather than inserting a second one; the open/close history lives
		// in `activity_log`.
		closedAt: timestamp("closed_at"),
		openedByMemberId: uuid("opened_by_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_vote_sessions_meeting_idx").on(t.meetingId),
		// Mirrors `meeting_awards_meeting_category_unique` so sessions, awards and
		// categories line up 1:1:1, and doubles as the ON CONFLICT arbiter for the
		// open/re-open upsert.
		uniqueIndex("meeting_vote_sessions_meeting_category_unique").on(
			t.meetingId,
			t.category,
		),
	],
);

export const meetingVotes = pgTable(
	"meeting_votes",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => meetingVoteSessions.id, { onDelete: "cascade" }),
		voterMemberId: uuid("voter_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		voterGuestId: uuid("voter_guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		candidateMemberId: uuid("candidate_member_id").references(
			() => members.id,
			{
				onDelete: "set null",
			},
		),
		candidateGuestId: uuid("candidate_guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		/**
		 * A candidate who is neither a member nor a guest row — typed on the public
		 * ballot (#582).
		 *
		 * Exists because the ballot could previously only offer people who ALREADY
		 * had a row, and Table Topics respondents are not keyed in while the segment
		 * runs: nobody is operating the app during a meeting, they are watching it.
		 * So the vote opened on an empty or short candidate list for the one
		 * category that most needs it.
		 *
		 * TEXT rather than a minted `guests` row, which was the alternative. A guest
		 * row per write-in makes a misspelling into a duplicate HUMAN on a surface
		 * anyone with the link can write to, and #510's per-meeting guest cap exists
		 * precisely to stop unbounded guest creation from there.
		 *
		 * Capped by `writeInNameSchema` (`#/lib/write-in-limits`) on the way in.
		 * Deduped by VISIBILITY, not by matching — see `writeInKey`.
		 */
		candidateWriteIn: text("candidate_write_in"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_votes_session_idx").on(t.sessionId),
		// One vote per person per category, enforced HERE rather than in
		// application code. Plain (non-partial) unique indexes so ON CONFLICT can
		// infer them as arbiters; Postgres treats NULLs as distinct, so the member
		// rows (guest null) never collide with the guest rows (member null). Same
		// construction as `meeting_attendance`.
		uniqueIndex("meeting_votes_voter_member_unique").on(
			t.sessionId,
			t.voterMemberId,
		),
		uniqueIndex("meeting_votes_voter_guest_unique").on(
			t.sessionId,
			t.voterGuestId,
		),
		check(
			"meeting_votes_single_voter",
			sql`${t.voterMemberId} is null or ${t.voterGuestId} is null`,
		),
		// AT MOST ONE of the three candidate columns (#582 widens this from two).
		//
		// Deliberately NOT `= 1`, which is the obvious tightening and would be a
		// production bug: `candidate_member_id` is `on delete set null`, so
		// deleting a member NULLS it and leaves a vote row pointing at nobody. That
		// is a reachable, legitimate state — a member leaving the club must not be
		// blocked by a year-old ballot — and an exactly-one check would make the
		// DELETE fail at runtime instead. `loadTally` drops candidate-less rows on
		// the read side, which is where that case belongs.
		check(
			"meeting_votes_single_candidate",
			sql`num_nonnulls(${t.candidateMemberId}, ${t.candidateGuestId}, ${t.candidateWriteIn}) <= 1`,
		),
	],
);

// Which guests are LINKED to THIS meeting's public ballot (#510) — i.e. have
// actually joined it via `joinBallotAsGuest`, whether that minted a fresh
// `guests` row or reused an existing club guest. Exists so the per-meeting cap
// has something to count that means "ballot identity", not "row insert":
// counting `guests` itself would throttle a club with years of visitors rather
// than a script hammering one meeting, and counting only NEW row inserts (the
// original version of this cap) counted nothing on the reuse path, so guests
// already sitting in `guests` from the public guest book could all link here
// uncapped (#510 follow-up review finding 1). `castVote` also REQUIRES this
// link before accepting a guest voter — a guest row reachable from any other
// surface is not, by itself, a ballot identity.
export const meetingBallotGuests = pgTable(
	"meeting_ballot_guests",
	{
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		guestId: uuid("guest_id")
			.notNull()
			.references(() => guests.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.meetingId, t.guestId] }),
		index("meeting_ballot_guests_meeting_idx").on(t.meetingId),
	],
);

/**
 * A candidate the Vote Counter has ruled OUT of one category on one meeting
 * (#723), with the reason the room is told.
 *
 * Exists because eligibility is not derivable: a speaker can have spoken and
 * still not be able to win — they ran outside the qualifying window, or never
 * used the Word of the Day. The first of those the room is already told about
 * out loud: the Timer's printed report cue reads "Here are the times. Anyone
 * outside their qualifying window is not eligible for the vote."
 * (`role-sheet-layout.ts`, the `timer` script). The second belongs to the
 * GRAMMARIAN's sheet, which asks the room to use the word and never says
 * failing to is disqualifying. Until this table the app could act on neither:
 * the room voted for someone who could not win and the Vote Counter either
 * ignored the tally quietly or explained the result afterwards.
 *
 * A disqualified candidate STAYS on the ballot, struck through and carrying
 * its reason, and cannot be voted for. Not removed: a name vanishing from a
 * voter's screen mid-meeting reads as a bug. Votes already cast for them stay
 * in `meeting_votes` and drop out of the tally on the READ side, the same way
 * a candidate-less row already does — so undoing a disqualification restores
 * both the ballot entry and its prior votes with no write.
 *
 * Addressed by the SAME three mutually-exclusive candidate columns as
 * `meeting_votes`, so the two line up without a translation layer. Two
 * deliberate asymmetries with that sibling table, both of which will otherwise
 * read as mistakes:
 *
 *  1. `num_nonnulls(...) = 1` here, where `meeting_votes` has `<= 1`. That
 *     table's member column is `on delete set null`, which makes a
 *     candidate-less vote row a REACHABLE state (a member leaving the club
 *     must not be blocked by a year-old ballot) and an exactly-one check would
 *     turn the DELETE into a runtime error. This table uses `on delete
 *     cascade` on both id columns instead — a departing member or guest takes
 *     their disqualification with them, which is what should happen to it —
 *     so a candidate-less row is never reachable and exactly-one is safe.
 *  2. `candidate_write_in` stores the FOLDED `writeInKey`, not the display
 *     spelling `meeting_votes` keeps. A write-in candidate IS its folded key
 *     everywhere downstream (`loadWriteInCandidates` ids one by
 *     `writeInKey(name)`, the tally counts under it), so folding here is what
 *     makes disqualifying "Bob Smith" also block a vote typed as "bob smith"
 *     — and what lets the unique index below enforce "not twice" in the
 *     database rather than in application code. `meeting_votes` keeps the raw
 *     spelling because the FIRST one cast is the display form; this table
 *     displays nothing, so it has no reason to.
 */
export const meetingCandidateDisqualifications = pgTable(
	"meeting_candidate_disqualifications",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// No inline `.references()` on any FK in this table — all four are named
		// in the extra-config array below. This one's derived name would have fit
		// (62 bytes); keeping it inline while the other three had to move would
		// have left one long derived identifier among three deliberate short ones.
		meetingId: uuid("meeting_id").notNull(),
		category: awardCategoryEnum("category").notNull(),
		// The FKs are named EXPLICITLY, in the extra-config array, and
		// that is not style. Drizzle's derived name is
		// `<table>_<column>_<reftable>_<refcolumn>_fk`, and this table's name is
		// long enough that all three derive past Postgres' 63-BYTE identifier
		// limit (69, 67 and 75). Postgres does not error on that — it emits a
		// NOTICE and TRUNCATES. `db:migrate` survives it (one apply, and CI's
		// drift check compares schema.ts to the snapshot, which holds the
		// untruncated name), but `db:push` INTROSPECTS the live database, sees the
		// truncated name, fails to match the declared one, and reissues
		// DROP + ADD on every single run — so `tm_test`, which is push-synced and
		// which parallel agents re-push mid-run, takes ACCESS EXCLUSIVE on this
		// table and spends a window with no FK enforcement at all, forever. These
		// were the first identifiers over 63 bytes in the whole migration history;
		// `drizzle-identifier-length.guard.test.ts` now fails the next one in CI
		// rather than in a NOTICE nobody reads.
		candidateMemberId: uuid("candidate_member_id"),
		candidateGuestId: uuid("candidate_guest_id"),
		/** The `writeInKey` of the typed name — folded, not the display spelling.
		 *  See asymmetry (2) in the table comment above. */
		candidateWriteIn: text("candidate_write_in"),
		/**
		 * Why. NOT NULL on purpose: the whole complaint this answers is a result
		 * the room cannot account for, and a disqualification with no reason is
		 * another one. Capped on the way in by `disqualificationReasonSchema`
		 * (`#/lib/disqualification`) — it reaches the PUBLIC ballot, so the cap
		 * lives in `lib/` where both sides of the wire and a unit test can see it.
		 */
		reason: text("reason").notNull(),
		/** Who ruled it out. `set null` rather than cascade: the disqualification
		 *  outlives the officer who recorded it, exactly as
		 *  `meeting_vote_sessions.opened_by_member_id` outlives whoever opened the
		 *  vote. The audit trail is in `activity_log` either way. Its FK is named
		 *  explicitly below for the 63-byte reason given above. */
		disqualifiedByMemberId: uuid("disqualified_by_member_id"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		// Named explicitly — see the 63-byte note on the columns above. The
		// `meeting_candidate_dq_` prefix matches what the check and the three
		// unique indexes already use, so every identifier on this table is short
		// and consistent rather than three long derived ones and four short
		// hand-written ones.
		foreignKey({
			name: "meeting_candidate_dq_meeting_fk",
			columns: [t.meetingId],
			foreignColumns: [meetings.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "meeting_candidate_dq_member_fk",
			columns: [t.candidateMemberId],
			foreignColumns: [members.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "meeting_candidate_dq_guest_fk",
			columns: [t.candidateGuestId],
			foreignColumns: [guests.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "meeting_candidate_dq_by_member_fk",
			columns: [t.disqualifiedByMemberId],
			foreignColumns: [members.id],
		}).onDelete("set null"),
		index("meeting_candidate_dq_meeting_idx").on(t.meetingId),
		// One disqualification per candidate per category, enforced HERE rather
		// than in application code. PLAIN (non-partial) unique indexes, the same
		// construction `meeting_votes`' two voter arbiters use: Postgres treats
		// NULLs as distinct, so the member rows (guest and write-in null) never
		// collide with the guest rows or the write-in rows. Partial indexes with a
		// `WHERE ... is not null` predicate would be equivalent here and are what
		// the spec sketched — they are deliberately NOT used, because `db:push`
		// does not update an existing partial index's predicate (see CLAUDE.md),
		// so every later edit to one silently diverges the test database from the
		// schema. Nothing about this table needs the predicate.
		uniqueIndex("meeting_candidate_dq_member_unique").on(
			t.meetingId,
			t.category,
			t.candidateMemberId,
		),
		uniqueIndex("meeting_candidate_dq_guest_unique").on(
			t.meetingId,
			t.category,
			t.candidateGuestId,
		),
		uniqueIndex("meeting_candidate_dq_write_in_unique").on(
			t.meetingId,
			t.category,
			t.candidateWriteIn,
		),
		// EXACTLY one — see asymmetry (1) in the table comment above.
		check(
			"meeting_candidate_dq_single_candidate",
			sql`num_nonnulls(${t.candidateMemberId}, ${t.candidateGuestId}, ${t.candidateWriteIn}) = 1`,
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
		// Completion attribution (ADR-0022, #116). These two are NOT Base Camp
		// mirror fields — Base Camp exposes neither a completion date nor a
		// crediting club, so both are FIRST-OBSERVED facts inferred at sync time:
		// stamped WRITE-ONCE on the sync that witnesses `approved` flip false→true,
		// left null for levels already approved before we first synced the
		// enrollment (never fabricated). `completedAt` = that sync's wall-clock;
		// `creditedClubId` = the syncing club (first-syncer-wins). Consumed by DCP
		// education-goal derivation (#245).
		completedAt: timestamp("completed_at", { withTimezone: true }),
		creditedClubId: uuid("credited_club_id").references(() => clubs.id, {
			onDelete: "set null",
		}),
	},
	(t) => [
		uniqueIndex("path_level_progress_enrollment_level_idx").on(
			t.enrollmentId,
			t.level,
		),
		index("path_level_progress_credited_club_idx").on(t.creditedClubId),
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
// Manually marked project completion (#419) — the source of completion truth for
// clubs with no Base Camp.
//
// A SEPARATE TABLE from `bcm_project_progress`, deliberately. Every /detail sync
// does `delete(bcmProjectProgress).where(enrollmentId = …)` then re-inserts from
// the payload (`pathways-detail-logic.ts`), so a manual mark written there would
// work until that member's next sync and then vanish with no error.
//
// Completion is MARKED, never derived from delivered speeches. Derivation is
// wrong in both directions: "Evaluation and Feedback" takes three assignments
// (speech, evaluation, repeat speech — #409), so one delivery would complete a
// project that is two-thirds outstanding; and a member working ahead has
// delivered Level 2 speeches while Level 1 sits unapproved, which no
// speech-derived rule can express.
//
// The two sources are never merged and neither overwrites the other. Marked but
// not yet complete in Base Camp is a first-class state — "done, awaiting
// processing" — not a conflict; it's the same distinction Base Camp itself draws
// between `path_level_progress.completed` and `approved`.
export const projectCompletionMarks = pgTable(
	"project_completion_marks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		enrollmentId: uuid("enrollment_id")
			.notNull()
			.references(() => pathEnrollments.id, { onDelete: "cascade" }),
		projectId: uuid("project_id")
			.notNull()
			.references(() => pathwaysProjects.id, { onDelete: "cascade" }),
		// Who ticked it — the member themselves or a club admin acting for them.
		// `set null` rather than cascade: losing the attribution must never delete
		// the member's completion record.
		markedByMemberId: uuid("marked_by_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		markedAt: timestamp("marked_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		uniqueIndex("project_completion_marks_enrollment_project_idx").on(
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
// API tokens — per-USER Bearer credentials for the MCP endpoint (#773 / #771).
//
// The deliberate difference from `sync_tokens` above is the owner column, and
// it is the whole point of a second table rather than a nullable `user_id` on
// that one. A sync token IS a club: `/api/pathways/ingest` derives `clubId`
// from it and every row it writes is credited to nobody. An api token is a
// PERSON: `/api/mcp` derives a user from it and then resolves that user's
// membership in whichever club the tool names, so every write it makes lands
// in `activity_log` with a real `actor_member_id` (D10). Folding the two into
// one table would make "which of these two identities does this row carry"
// a runtime question on a credential path, which is the last place it belongs.
//
// Raw token is `tmk_` + 32 random bytes base64url, shown once at creation and
// stored only as a SHA-256 hash. The prefix differs from `gup_` so a pasted
// token says which kind it is before anything tries to resolve it.
//
// There is no scope column and no expiry: revocation (`revoked_at`) is the
// kill switch, which is the right size for one user. Both are additive later.
// ---------------------------------------------------------------------------
export const apiTokens = pgTable(
	"api_tokens",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// Cascade: a deleted user's tokens must not outlive them as credentials
		// that still resolve to a `user.id` nothing else can reach.
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		name: text("name"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		lastUsedAt: timestamp("last_used_at"),
		revokedAt: timestamp("revoked_at"),
	},
	(t) => [index("api_tokens_user_idx").on(t.userId)],
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
		// The self-asserted member who acted (NULL = system/unknown, or an
		// impersonated write — see `impersonatedBy`).
		actorMemberId: uuid("actor_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		// The platform superadmin who performed this write via a read-write
		// impersonation session (ADR-0020 / #246). NULL for ordinary member/admin
		// writes. When set, `actor_member_id` is NULL — the superadmin is memberless
		// in the club — so this column is the sole actor. Makes every impersonated
		// change attributable to the real person behind it.
		impersonatedBy: text("impersonated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		action: activityActionEnum("action").notNull(),
		// 'slot' | 'meeting' | 'member' | 'club' | 'scoreboard'. Free text, not an
		// enum — the union that is actually enforced is `ActivityInput["targetType"]`
		// in `src/server/activity.ts`, and this comment must be kept in step with it
		// (a reader who trusts a stale list learns the wrong vocabulary). 'club' is
		// club-level state tied to no slot/meeting/member (#495); 'scoreboard' is a
		// `dcp_scoreboards` row (#690), whose id is the `target_id`.
		targetType: text("target_type").notNull(),
		targetId: text("target_id"),
		detail: jsonb("detail"), // { before?, after?, ... }
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("activity_log_club_created_idx").on(t.clubId, t.createdAt),
		// The CSV importer's release lookup (#855, `loadPersonCandidates`): the
		// latest `member_remove` naming a Person, keyed on `detail->>'personId'`.
		// Partial and on the expression, so it holds only removals and the
		// lookup stays bounded as the log grows. The query must spell the SAME
		// expression and the SAME literal action predicate, or the planner
		// cannot prove the index applies and scans the log per orphan.
		index("activity_log_member_remove_person_idx")
			.on(sql`(${t.detail} ->> 'personId')`)
			.where(sql`${t.action} = 'member_remove'`),
	],
);

// ---------------------------------------------------------------------------
// Impersonation sessions (ADR-0020 / #185, #246) — a superadmin's time-bounded
// grant to view (`read_only`) or act on (`read_write`) a club they aren't a real
// member of. The durable audit record of cross-club access, and the ONLY thing
// that grants such access. NOT ambient: no active session ⇒ no access. A
// `read_only` session is consulted only by the read-access guards
// (`requireClubViewAccess` / `requireClubAdminView`) and the mutating guards
// reject it by construction; a `read_write` session is ALSO honored by the
// mutating guards as an effective admin (#246).
//
// Active = `ended_at IS NULL AND expires_at > now()`. Invariant: at most one
// active row per superadmin (starting a new one ends any existing).
// ---------------------------------------------------------------------------

export const impersonationSessions = pgTable(
	"impersonation_sessions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		superadminUserId: text("superadmin_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		mode: impersonationModeEnum("mode").notNull().default("read_only"),
		// Why the superadmin needed access. Required (non-empty) for `read_write`
		// sessions (#246), null for `read_only`. Surfaced in the club's activity feed.
		reason: text("reason"),
		startedAt: timestamp("started_at").defaultNow().notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		// Set on explicit Exit; null = not manually ended (may still be expired).
		endedAt: timestamp("ended_at"),
	},
	(t) => [
		index("impersonation_sessions_superadmin_idx").on(t.superadminUserId),
	],
);

// ---------------------------------------------------------------------------
// Notifications — the reminder delivery queue. A row is DUE when
// `send_at <= now()` AND `sent_at IS NULL`; the in-process poller (#271,
// `src/server/reminder-poller.ts`) claims and delivers due rows exactly once.
// Producers (#272 role reminders / #274 preferences) enqueue rows; this table
// carries the retry/error bookkeeping the poller needs.
// ---------------------------------------------------------------------------

export const notifications = pgTable(
	"notifications",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		slotId: uuid("slot_id")
			.notNull()
			.references(() => roleSlots.id, { onDelete: "cascade" }),
		// The membership the role reminder is FOR — the assignee holding the slot at
		// enqueue time (#272). Two jobs: (1) it is the dedup key alongside `slot_id`
		// (one reminder per member per slot — see the partial unique index below),
		// and (2) the send-time staleness re-validation compares it against the
		// slot's CURRENT `assigned_member_id`: if the slot was reassigned/released or
		// the meeting is no longer scheduled, the poller suppresses the row instead
		// of mailing a stale reminder. NULL for non-role-assignment rows (e.g. the
		// #271 delivery-foundation tests), which are never re-validated. On member
		// delete → cascade: a reminder about a removed member is meaningless.
		assignedMemberId: uuid("assigned_member_id").references(() => members.id, {
			onDelete: "cascade",
		}),
		type: text("type").notNull(),
		channel: text("channel").notNull(),
		sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
		sentAt: timestamp("sent_at", { withTimezone: true }),
		// Delivery bookkeeping (#271). `attempts` is the optimistic-lock token the
		// poller bumps to claim a row before sending (at-most-once under concurrent
		// ticks); once it reaches the max the row is abandoned. `last_attempted_at`
		// paces retries (backoff) and `last_error` records the most recent failure.
		attempts: integer("attempts").notNull().default(0),
		lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
		lastError: text("last_error"),
	},
	(t) => [
		// Idempotent enqueue (#272): at most one reminder per (slot, member). The
		// producer inserts with ON CONFLICT DO NOTHING against this arbiter, so a
		// re-run (every poller tick) never creates a duplicate. Partial (WHERE
		// assigned_member_id IS NOT NULL) so the many #271 rows with a NULL member
		// reference are unconstrained and never collide.
		uniqueIndex("notifications_slot_member_unique")
			.on(t.slotId, t.assignedMemberId)
			.where(sql`${t.assignedMemberId} is not null`),
	],
);

// ---------------------------------------------------------------------------
// Club action items (#529) — things the CLUB must do, standing until resolved.
//
// NOT officer-meeting minutes, and deliberately NOT owned by a meeting. An
// action item's real fields are what, who, by when and whether it is done; only
// provenance wants a meeting, and provenance is not worth a foreign key. Having
// no meeting reference is what lets an item raised between meetings land
// correctly on the timeline.
//
// This is the missing half of a concept the app already ships: `meetings.
// reminders` (the Announcements field, #349) carries exactly this content as
// free text — its own test fixture is "Bring a guest / Renew dues" — but with no
// owner, no due date, no resolved state and no carry-forward, so items get
// retyped each meeting or forgotten. An action item is an announcement that
// persists until it is resolved. Announcements stay as they are, for one-off
// notices that have no owner and never complete.
// ---------------------------------------------------------------------------

/**
 * Why a resolved item closed. `done` and `dropped` are materially different in
 * a permanent record: without the distinction, the minutes claim credit for
 * work the club actually abandoned.
 *
 * Deliberately NOT `in_progress` / `blocked` — project-management states a club
 * does not run on, and they make "what is open" ambiguous.
 */
export const actionItemResolutionEnum = pgEnum("action_item_resolution", [
	"done",
	"dropped",
]);

export const clubActionItems = pgTable(
	"club_action_items",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		/** What must be done. Capped on write by `ACTION_ITEM_LIMITS.text`. */
		text: text("text").notNull(),
		/**
		 * Who owns it. OPTIONAL — null means the club collectively ("everyone
		 * bring a guest"), which is a real shape and must not be forced onto one
		 * person. `set null` rather than cascade: a member leaving the club must
		 * not delete the record that the venue got booked. Mirrors how
		 * `meeting_attendance` and `meeting_awards` reference members.
		 */
		ownerMemberId: uuid("owner_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		/**
		 * Optional target date. Follow-up comes from persistence, not deadlines.
		 *
		 * A `date`, NOT a `timestamptz`, and the distinction is user-visible. This
		 * is a CALENDAR DAY picked in an `<input type="date">`, never an instant:
		 * it is only ever displayed, never compared against `meetings.scheduled_at`
		 * the way `created_at`/`resolved_at` are. Stored as a timestamp it would go
		 * in as UTC midnight and render in the viewer's zone, so every club west of
		 * UTC — America/Chicago is this app's default — would read back the day
		 * BEFORE the one the officer typed, and SSR (UTC container) would disagree
		 * with the hydrated client. `mode: "string"` keeps it a "YYYY-MM-DD" string
		 * end to end, with no Date to shift.
		 */
		dueDate: date("due_date", { mode: "string" }),
		/**
		 * When the item was raised, and when it closed (null = still open).
		 *
		 * There is no status column: open vs resolved is DERIVED from
		 * `resolved_at`, the same way speeches store no status (ADR-0009).
		 *
		 * Both are `timestamptz` on purpose. They are compared against
		 * `meetings.scheduled_at`, which is `timestamptz`, to reconstruct what was
		 * open at a past meeting. Storing them naive would make that comparison
		 * depend on the session time zone and silently shift which items appear in
		 * a past meeting's minutes — the exact instability this design exists to
		 * prevent.
		 */
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		resolution: actionItemResolutionEnum("resolution"),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		// The open-list read is per club, ordered by age.
		index("club_action_items_club_idx").on(t.clubId, t.createdAt),
		// The owner FK is written far more often than it is read: every member
		// delete fires the `set null` above, and `collapseMemberships` re-points
		// owners once per absorbed membership — and `mergePeople` calls that in a
		// loop, so an unindexed column costs one sequential scan per absorbed
		// membership. Plain CREATE INDEX only: `CONCURRENTLY` cannot run inside the
		// transaction the startup migrator uses and fails the Railway deploy closed.
		index("club_action_items_owner_idx").on(t.ownerMemberId),
		// Resolution timestamp and reason are set together or not at all. Without
		// this, a half-closed row renders in neither the open list nor the
		// resolved list and simply vanishes from the record.
		check(
			"club_action_items_resolution_paired",
			sql`(${t.resolvedAt} is null) = (${t.resolution} is null)`,
		),
	],
);

// ---------------------------------------------------------------------------
// MCP pending plans (#806, generalised by #812) — a write an LLM has proposed
// and a human has not yet confirmed.
//
// A write tool reachable over `/api/mcp` is preview-only: it writes ONE row
// here and hands back a link. Nothing reaches the domain tables until someone
// opens that link signed in, checks the values against whatever they are
// transcribing from, and applies.
//
// ONE table, discriminated by `tool`, because the LIFECYCLE is the same for
// every such tool — one club, one creator, an expiry, a grace window, a sweep,
// and an apply that happens exactly once under a lock. #806 shipped that
// lifecycle for `record_guest_book` and #808 needed it again for
// `upsert_agendas`; two copies of a retention-and-authorization lifecycle is
// how one copy gets a fix and the other does not, and this one holds visitor
// names, emails and phone numbers.
//
// `payload`, NOT a column per fact, and the meeting DATE is the reason this is
// a new table rather than a rename. `guest_book_pending_plans.meeting_date` was
// `date NOT NULL` because a guest-book page belongs to exactly one meeting;
// `upsert_agendas` carries many dates and has no single value for it. A
// nullable column meaningful for one tool and always-null for the other is two
// tables wearing one name, so the date moved into the guest book's own payload
// — which is also #806's own rule restated: store what was ASKED and re-derive
// everything else on every render, so nothing is trusted across the gap.
//
// `payload` is NULLABLE and each tool tombstones it on apply, in the same
// statement that sets `applied_at`. That leaves "already applied"
// distinguishable from "never existed" — which a re-opened link needs — while
// no personal data sits here at rest after the write it justified has landed.
// The guest book keeps its `meetingDate` and drops its `entries`, because the
// applied page still says which meeting the visitors are on.
// ---------------------------------------------------------------------------

export const mcpPendingPlans = pgTable(
	"mcp_pending_plans",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// WHICH tool proposed this write, and the discriminator every read filters
		// on. Merging the tables means an id no longer says what shape its payload
		// has, so a guest-book id opened at an agenda page would otherwise pass the
		// creator check and reach a renderer built for a different shape. Two
		// tables made that unrepresentable; one table makes it a missing WHERE, so
		// `resolvePending` takes the expected tool and answers not-found on a
		// mismatch. `$type` is a compile-time cast and nothing else — a value this
		// release has never heard of simply matches no reader's WHERE.
		tool: text("tool").notNull().$type<McpPendingTool>(),
		// The tool's own shape, parsed at every read boundary. `jsonb` is typed
		// `unknown` deliberately: the shared lifecycle cannot know what is in here,
		// and each tool's schema module is what turns it into something readable.
		payload: jsonb("payload"),
		// The only user who may open the link. Not a membership: the row must not
		// outlive the standing that made it, so admin is re-proved on every read
		// rather than frozen here.
		createdByUserId: text("created_by_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		// created_at + 24h. Past this the link renders "expired" rather than
		// applying; the sweep removes the row a further 24h later.
		expiresAt: timestamp("expires_at").notNull(),
		appliedAt: timestamp("applied_at"),
	},
	(t) => [
		// The sweep's only predicate. Plain CREATE INDEX, and what makes that
		// acceptable is the table SIZE, so state it: the index is built in the
		// same transaction as the CREATE TABLE, over a relation with zero rows,
		// so the SHARE lock is held for no measurable time. `CONCURRENTLY` is
		// not an option regardless — it cannot run inside the single transaction
		// the startup migrator uses, and `scripts/migrate.ts` exits non-zero from
		// the Dockerfile CMD, so attempting it fails the Railway deploy closed.
		//
		// NOT `(tool, expires_at)`: the sweep is deliberately tool-BLIND — one
		// pass removes every expired row whatever made it — and reports the
		// breakdown from `RETURNING tool` rather than by running a pass per tool.
		index("mcp_pending_plans_sweep_idx").on(t.expiresAt),
		// The cascade side. Deleting a club fires a cascade through this table,
		// and an unindexed FK column costs one sequential scan per delete — the
		// same reasoning `club_action_items_owner_idx` records a few hundred
		// lines up. The sweep bounds this table to ~48h of rows and cannot be
		// turned off, so the scan would be small; the index is here because a
		// cascade scan that is small today is the kind that stops being small
		// quietly, and it costs one btree write per preview.
		//
		// `created_by_user_id` is deliberately NOT indexed to match: nothing in
		// this application deletes a `user` row (schema.ts records that
		// `db.delete(user)` appears nowhere), so that cascade never fires, and an
		// index nothing uses is a write cost on every insert. `tool` is not
		// indexed either: every read of it is already keyed by the primary key.
		index("mcp_pending_plans_club_idx").on(t.clubId),
	],
);

// ---------------------------------------------------------------------------
// Access requests (#866)
//
// What the public `/request-access` form writes: a prospect asking for a club
// (or a district) to be set up. Session-less and anonymous, so it mints PII
// (a name and an email) from a form anyone can POST — the caps that bound it
// live in `src/server/access-requests-logic.ts`. No foreign keys and no
// `club_id`: a request precedes any club, so it is not club-scoped and the
// archive gate does not apply. Nothing in the app reads these rows; the
// maintainer gets an email per request and reads the table by psql.
// ---------------------------------------------------------------------------

export const accessRequestKindEnum = pgEnum("access_request_kind", [
	"club",
	"district",
]);

export const accessRequests = pgTable(
	"access_requests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		kind: accessRequestKindEnum("kind").notNull(),
		name: text("name").notNull(),
		// Stored lowercased + trimmed, so the per-email cap counts one address
		// once however it was typed.
		email: text("email").notNull(),
		clubName: text("club_name"),
		clubNumber: text("club_number"),
		districtNumber: text("district_number"),
		message: text("message"),
		// First-touch marketing attribution (`src/lib/marketing-ref.ts`), or null.
		ref: text("ref"),
		// True when this row CLAIMED one of the day's notification slots, inside
		// the submission's advisory lock (`access-requests-logic.ts`). That claim
		// is what the notification cap counts, so it is set at insert, before any
		// email exists; delivery is the poller's (ADR-0023) and is recorded in
		// the `notify_*` columns below. False = over the cap: saved, never mailed.
		notified: boolean("notified").notNull().default(false),
		// Delivery bookkeeping, same shape as `notifications` (#271): `attempts`
		// is the optimistic-lock token the poller bumps to claim a send, and
		// `last_attempted_at` paces the bounded retry.
		notifySentAt: timestamp("notify_sent_at", { withTimezone: true }),
		notifyAttempts: integer("notify_attempts").notNull().default(0),
		notifyLastAttemptedAt: timestamp("notify_last_attempted_at", {
			withTimezone: true,
		}),
		notifyLastError: text("notify_last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		// The per-email cap: rows for this email in the last 24h.
		index("access_requests_email_created_idx").on(t.email, t.createdAt),
		// The global and notification caps: rows in the last 24h.
		index("access_requests_created_idx").on(t.createdAt),
	],
);

/**
 * One row per alert WINDOW and REASON (#866): the maintainer is told once per
 * UTC day per kind of trip that the request-access form hit a limit, not once
 * per rejected request. Keyed by reason as well as day so a benign trip (one
 * address resubmitting just after midnight) cannot use up the day's only alert
 * and silence a later flood. `window_key` is `<day>:<reason>`; a trip that
 * finds its row only bumps `trips`. Delivered by the poller with the same
 * bookkeeping as `notifications`.
 */
export const accessRequestAlerts = pgTable("access_request_alerts", {
	id: uuid("id").primaryKey().defaultRandom(),
	windowKey: text("window_key").notNull().unique(),
	// per_email | global | notify | undelivered — see `CapReason`.
	reason: text("reason").notNull(),
	trips: integer("trips").notNull().default(1),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	sentAt: timestamp("sent_at", { withTimezone: true }),
	attempts: integer("attempts").notNull().default(0),
	lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
	lastError: text("last_error"),
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

export const officerTrainingPeriodsRelations = relations(
	officerTrainingPeriods,
	({ one }) => ({
		club: one(clubs, {
			fields: [officerTrainingPeriods.clubId],
			references: [clubs.id],
		}),
	}),
);

export const officerTrainingRecordsRelations = relations(
	officerTrainingRecords,
	({ one }) => ({
		membership: one(members, {
			fields: [officerTrainingRecords.membershipId],
			references: [members.id],
		}),
	}),
);

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

export const clubsRelations = relations(clubs, ({ one, many }) => ({
	meetings: many(meetings),
	roleDefinitions: many(roleDefinitions),
	members: many(members),
	guests: many(guests),
	recurrence: one(clubMeetingRecurrence),
	logo: one(clubLogos),
}));

export const clubMeetingRecurrenceRelations = relations(
	clubMeetingRecurrence,
	({ one }) => ({
		club: one(clubs, {
			fields: [clubMeetingRecurrence.clubId],
			references: [clubs.id],
		}),
	}),
);

export const clubLogosRelations = relations(clubLogos, ({ one }) => ({
	club: one(clubs, {
		fields: [clubLogos.clubId],
		references: [clubs.id],
	}),
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
	voteSessions: many(meetingVoteSessions),
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

export const meetingTimingsRelations = relations(meetingTimings, ({ one }) => ({
	meeting: one(meetings, {
		fields: [meetingTimings.meetingId],
		references: [meetings.id],
	}),
	slot: one(roleSlots, {
		fields: [meetingTimings.slotId],
		references: [roleSlots.id],
	}),
	recordedBy: one(members, {
		fields: [meetingTimings.recordedByMemberId],
		references: [members.id],
	}),
}));

export const meetingVoteSessionsRelations = relations(
	meetingVoteSessions,
	({ one, many }) => ({
		meeting: one(meetings, {
			fields: [meetingVoteSessions.meetingId],
			references: [meetings.id],
		}),
		votes: many(meetingVotes),
	}),
);

// Only the parent link. The four member/guest FKs (voter × candidate) carry NO
// declared relation on purpose: two point at `members` and two at `guests`, so
// each would need a `relationName` to disambiguate — and nothing reads them.
// Every voting query joins explicitly (see `voting-logic.ts`), because the
// tally needs aggregates the relational query API would not give us anyway.
// Add them here only if a consumer actually appears.
export const meetingVotesRelations = relations(meetingVotes, ({ one }) => ({
	session: one(meetingVoteSessions, {
		fields: [meetingVotes.sessionId],
		references: [meetingVoteSessions.id],
	}),
}));

// Parent link only, for the same reason `meetingVotesRelations` above carries
// one: the two candidate FKs point at `members` and `guests` and nothing reads
// them relationally — `award-candidates-logic.ts` queries this table by
// (meeting, category) and matches candidates in JS, because a write-in has no
// row to join to at all.
export const meetingCandidateDisqualificationsRelations = relations(
	meetingCandidateDisqualifications,
	({ one }) => ({
		meeting: one(meetings, {
			fields: [meetingCandidateDisqualifications.meetingId],
			references: [meetings.id],
		}),
	}),
);

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

export const projectCompletionMarksRelations = relations(
	projectCompletionMarks,
	({ one }) => ({
		enrollment: one(pathEnrollments, {
			fields: [projectCompletionMarks.enrollmentId],
			references: [pathEnrollments.id],
		}),
		project: one(pathwaysProjects, {
			fields: [projectCompletionMarks.projectId],
			references: [pathwaysProjects.id],
		}),
	}),
);
